import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import {once} from "node:events";
import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {MemorySaver} from "../../agent-host/tests/fixtures/checkpointer";
import {createAgentServer} from "../../agent-host/src/server";
import {registerTestIdentity} from "../../agent-host/tests/fixtures/identity";
import {createExperienceRefineTaskClient} from "../src/services/experience-refine-task-client";
import {activatePrincipal} from "../src/lib/identity";

test("real authenticated HTTP refinement uses one task/adapter; reconnects and scope conflicts never clear the ledger",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-web-refine-http-"));let server:http.Server|undefined,calls=0,adapterBuilds=0;const wire:{path:string;method?:string}[]=[];
  const source={targetRef:{kind:"claim_text" as const,experienceId:"exp",claimId:"claim",locale:"zh" as const},text:"参与设备联调。\r\n"+"完整源材料😀。".repeat(2600)+"SOURCE-END",label:"合成经历"};
  const supplement="本人按任务编号关联日志，定位设备回执问题。";
  try{
    server=createAgentServer({host:"127.0.0.1",port:0,authToken:"synthetic-refine-token",allowedOrigins:[],runtimeDefinitions:[],identityDirectory:path.join(directory,"identity"),runsDirectory:path.join(directory,"runs"),understandingDirectory:path.join(directory,"understanding"),checkpointer:new MemorySaver() as never,
      careerTaskReasoner:async()=>{adapterBuilds++;return async(prompt,signal,phase)=>{signal.throwIfAborted();calls++;assert.equal(phase,"experience_refine");assert.ok(prompt.includes("SOURCE-END"));
        return {text:JSON.stringify({questions:calls===1?["你亲手做了哪一步？"]:[],rationale:"只按本人补充。",evidenceQuotes:calls===1?[]:[supplement],...(calls===1?{}:{proposedText:"按任务编号关联日志，定位设备回执问题。"})}),finishReason:"stop"};};}});
    await once(server,"listening");const address=server.address();assert.ok(address&&typeof address!=="string");const base=`http://127.0.0.1:${address.port}`;
    const identity=await registerTestIdentity(base,"synthetic-refine-token","web-refine-owner");activatePrincipal(identity.principal);
    const client=createExperienceRefineTaskClient({baseUrl:base,pollMs:5,fetch:async(url,init)=>{wire.push({path:new URL(String(url)).pathname,method:init?.method});const headers=new Headers(init?.headers);for(const [key,value] of Object.entries(identity.headers))headers.set(key,value);headers.set("Authorization","Bearer synthetic-refine-token");return fetch(url,{...init,headers});}});
    const runtime={kind:"model" as const,modelSettings:{provider:"ollama" as const,model:"synthetic",baseUrl:"http://127.0.0.1:1/v1"}},params={workspaceKey:"writing:synthetic-note",refinement:{source},supplementConfirmed:true as const,runtime};let id="";
    const first=await client.refine({...params,supplement:"",onTask:task=>{id=task.id;}});assert.equal(first.proposedText,undefined);
    const second=await client.refine({...params,supplement});assert.equal(second.proposedText,"按任务编号关联日志，定位设备回执问题。");
    const task=await client.get(id);assert.equal(task.kind,"experience_refine");assert.equal(task.usage.modelCalls,2);assert.equal(task.conversation.messages.length,4);assert.equal(task.refinement.source.text,source.text);assert.equal(adapterBuilds,1);
    assert.deepEqual(await client.refine({...params,supplement}),second);assert.equal(calls,2);
    await assert.rejects(client.refine({...params,supplement,refinement:{source:{...source,text:"已变化"}}}),/原文字段/);
    await assert.rejects(client.refine({...params,supplement,runtime:{...runtime,modelSettings:{...runtime.modelSettings,model:"different"}}}),/底座已变化/);
    assert.equal(calls,2);assert.ok(wire.every(row=>row.path.startsWith("/api/v1/agent/tasks")));assert.equal(wire.filter(row=>row.path==="/api/v1/agent/tasks"&&row.method==="POST").length,1);
    activatePrincipal(undefined);await assert.rejects(client.get(id),/请先登录/);assert.equal(calls,2);
  }finally{activatePrincipal(undefined);if(server){const current=server;await new Promise<void>(resolve=>current.close(()=>resolve()));}await rm(directory,{recursive:true,force:true});}
});
