import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import {once} from "node:events";
import {mkdtemp,rm,readFile} from "node:fs/promises";
import {setTimeout as delay} from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import {careerRuntimeBinding,ProjectUnderstandingTaskSchema,UnderstandingSessionSchema} from "@better-me/agent-contracts";
import {MemorySaver} from "../../agent-host/tests/fixtures/checkpointer";
import {createAgentServer} from "../../agent-host/src/server";
import {registerTestIdentity} from "../../agent-host/tests/fixtures/identity";
import {createUnderstandingClient} from "../src/services/understanding-client";
import {activatePrincipal} from "../src/lib/identity";

test("production project facade uses authenticated tasks HTTP for both turns, repair, source update and exact human confirmation",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-web-project-http-"));let server:http.Server|undefined,calls=0,adapters=0;const wire:{path:string;method?:string;body?:unknown}[]=[];
  const sourceText="  项目只协调任务回执，不证明个人贡献。\r\n"+"完整项目源材料😀。".repeat(900)+"SOURCE-END  ",answer="  本人纠正：完成是设备动作完成，不是接受任务。  ";
  const runtime={kind:"model" as const,modelSettings:{provider:"ollama" as const,model:"synthetic",baseUrl:"http://127.0.0.1:1/v1",apiKey:"SYNTHETIC_RUNTIME_ONLY_KEY"}},runtimeBinding=careerRuntimeBinding(runtime);
  try{
    server=createAgentServer({host:"127.0.0.1",port:0,authToken:"synthetic-project-token",allowedOrigins:[],runtimeDefinitions:[],identityDirectory:path.join(directory,"identity"),runsDirectory:path.join(directory,"runs"),understandingDirectory:path.join(directory,"understanding"),checkpointer:new MemorySaver() as never,
      careerTaskReasoner:async()=>{adapters++;return async(prompt,_signal,phase)=>{calls++;assert.equal(phase,"project_understanding");const text=prompt.split("\n\n").find(part=>part.startsWith('{"project":'));assert.ok(text);const ctx=JSON.parse(text);assert.equal(ctx.project.sourceText,sourceText);assert.equal(ctx.context.messages[0].text,sourceText);
        if(calls===1)return "COMPLETE_INVALID_PROJECT_OUTPUT";
        if(calls===2)assert.ok(prompt.includes("COMPLETE_INVALID_PROJECT_OUTPUT"));
        if(calls===3){assert.ok(prompt.includes(answer));assert.ok(prompt.includes("动作完成"));assert.equal(ctx.context.messages.filter((message:{role:string})=>message.role==="agent").length,1);}
        const latest=ctx.context.messages.filter((message:{role:string})=>message.role==="user").at(-1);
        return {text:JSON.stringify({kind:"reply",message:"合成项目理解，待本人核对。",understanding:{summary:"项目协调设备任务回执。",terms:[],boundaries:["个人贡献与上线仍未确认"],claims:[{id:"user",kind:"user",text:"本人明确说明业务完成含义。",evidenceIds:[latest.id]}],unknowns:["上线情况未知"]},readyForConfirmation:calls===3,...(calls===3?{}:{question:{id:"complete",text:"什么表示业务完成？",why:"澄清完成语义",options:[{id:"done",label:"动作完成"}],allowMultiple:false}})}),finishReason:"stop"};};}});
    await once(server,"listening");const address=server.address();assert.ok(address&&typeof address!=="string");const base=`http://127.0.0.1:${address.port}`,identity=await registerTestIdentity(base,"synthetic-project-token","web-project-owner");activatePrincipal(identity.principal);
    const client=createUnderstandingClient({baseUrl:base,fetch:async(url,init)=>{wire.push({path:new URL(String(url)).pathname,method:init?.method,...(init?.body?{body:JSON.parse(String(init.body))}:{})});const headers=new Headers(init?.headers);for(const [key,value] of Object.entries(identity.headers))headers.set(key,value);headers.set("Authorization","Bearer synthetic-project-token");return fetch(url,{...init,headers});}});
    const input={workspaceKey:"project:synthetic-note",projectKey:"synthetic-field",label:"合成项目",sourceText,runtimeBinding};let session=await client.createSession(input);const id=session.id;assert.match(id,/^ct_[a-f0-9]{32}$/);assert.equal(calls,0);
    const poll=async()=>{for(let i=0;i<200;i++){const value=await client.getSession(id);if(value.phase!=="running")return value;await delay(5);}throw Error("HTTP project did not settle");};
    const first={expectedRevision:session.revision,idempotencyKey:"project-http-first",answer:"",selectedOptionIds:[],runtime,consentToSend:true as const};await client.startTurn(id,first);session=await poll();assert.equal(session.phase,"awaiting-answer",session.error?.code);assert.equal(calls,2);assert.equal(adapters,1);
    await client.startTurn(id,first);assert.equal(calls,2,"same old receipt accepted without rebuilding or dispatching");
    const second={expectedRevision:session.revision,idempotencyKey:"project-http-second",answer,selectedOptionIds:["done"],runtime,consentToSend:true as const};await client.startTurn(id,second);session=await poll();assert.equal(session.phase,"awaiting-confirmation",session.error?.code);assert.equal(calls,3);assert.equal(session.confirmation,undefined);
    const restored=await createUnderstandingClient({baseUrl:base,fetch:async(url,init)=>{const headers=new Headers(init?.headers);for(const [key,value]of Object.entries(identity.headers))headers.set(key,value);headers.set("Authorization","Bearer synthetic-project-token");return fetch(url,{...init,headers});}}).getSession(id);assert.deepEqual(restored,session);assert.equal(calls,3);
    await assert.rejects(client.confirm(id,{expectedRevision:session.revision,summaryHash:"wrong"}));session=await client.confirm(id,{expectedRevision:session.revision,summaryHash:session.summaryHash!});assert.equal(session.phase,"confirmed");assert.equal(session.confirmation!.revision,session.revision);
    assert.equal((await client.createSession(input)).id,id);assert.equal(calls,3);assert.equal(wire.filter(row=>row.path==="/api/v1/agent/tasks"&&row.method==="POST").length,1);
    session=await client.updateSource(id,{expectedRevision:session.revision,sourceText:"用户明确修订后的原文，旧对话保留。"});assert.equal(session.phase,"idle");assert.equal(session.confirmation,undefined);assert.equal(session.messages[0]!.text,sourceText);UnderstandingSessionSchema.parse(session);
    const raw=JSON.parse(await readFile(path.join(directory,"identity","owners",identity.principal.id,"career-tasks-v1",`${id}.json`),"utf8")),task=ProjectUnderstandingTaskSchema.parse(raw.task);assert.equal(task.usage.modelCalls,3);assert.equal(task.project.revision,task.revision);assert.equal(task.project.sourceText,session.sourceText);assert.ok(!JSON.stringify(raw).includes("SYNTHETIC_RUNTIME_ONLY_KEY"));assert.ok(raw.recent.some((item:{output?:string})=>item.output==="COMPLETE_INVALID_PROJECT_OUTPUT"));
    assert.ok(wire.every(row=>row.path.startsWith("/api/v1/agent/tasks")));activatePrincipal(undefined);await assert.rejects(client.getSession(id),/请先登录/);assert.equal(calls,3);
  }finally{activatePrincipal(undefined);if(server){const current=server;await new Promise<void>(resolve=>current.close(()=>resolve()));}await rm(directory,{recursive:true,force:true});}
});
