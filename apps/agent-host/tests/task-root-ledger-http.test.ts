import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {once} from "node:events";
import {mkdtemp,rm} from "node:fs/promises";
import {setTimeout as delay} from "node:timers/promises";
import {AgentTaskSchema,careerRuntimeBinding,isCareerTask,type AgentTask} from "@better-me/agent-contracts";
import {MemorySaver} from "./fixtures/checkpointer.js";
import {registerTestIdentity} from "./fixtures/identity.js";
import {createAgentServer} from "../src/server.js";

test("authenticated tasks HTTP attaches children without default-budget expansion, shares one owner runtime and denies a third send",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-root-http-"));let server:http.Server|undefined,calls=0,adapters=0;
  const runtime={kind:"model" as const,modelSettings:{provider:"ollama" as const,model:"synthetic-root-ledger",baseUrl:"http://127.0.0.1:1/v1",apiKey:""}},runtimeBinding=careerRuntimeBinding(runtime),budget={maxModelCalls:2,maxToolCalls:4,maxActiveMs:60000};
  try{
    server=createAgentServer({host:"127.0.0.1",port:0,authToken:"synthetic-root-token",allowedOrigins:[],runtimeDefinitions:[],identityDirectory:path.join(directory,"identity"),runsDirectory:path.join(directory,"runs"),understandingDirectory:path.join(directory,"understanding"),checkpointer:new MemorySaver() as never,
      careerTaskReasoner:async()=>{adapters++;return async(_prompt,_signal,phase)=>{calls++;return {text:phase==="experience_refine"?JSON.stringify({questions:["请补充实际行为"],rationale:"合成追问",evidenceQuotes:[]}):JSON.stringify({kind:"reply",content:"合成回答"}),finishReason:"stop"};};}});
    await once(server,"listening");const address=server.address();assert.ok(address&&typeof address!=="string");const base=`http://127.0.0.1:${address.port}`;
    const a=await registerTestIdentity(base,"synthetic-root-token","root-http-a"),b=await registerTestIdentity(base,"synthetic-root-token","root-http-b");
    const call=(suffix:string,body?:unknown,owner=a.headers)=>fetch(`${base}/api/v1/agent/tasks${suffix}`,{method:body===undefined?"GET":"POST",headers:{...owner,Authorization:"Bearer synthetic-root-token","Content-Type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const parsed=async(response:Response)=>{const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return AgentTaskSchema.parse(value.task);};
    const poll=async(id:string)=>{for(let i=0;i<200;i++){const task=await parsed(await call(`/${id}`));if(task.status!=="running")return task;await delay(5);}throw Error("synthetic HTTP root did not settle");};
    const run=(task:AgentTask)=>({expectedRevision:task.revision,sourceFingerprint:isCareerTask(task)?task.resume.sourceFingerprint:task.sourceFingerprint,runtimeBinding,runtime,consent:true});
    const initial={kind:"free_chat",workspaceKey:"synthetic-http-root",objective:"合成职业对话",runtimeBinding,budget,consent:true,idempotencyKey:"synthetic-http-root-task",conversation:{messages:[{id:"u1",role:"user",content:"只参与测试。"}]}};
    let root=await parsed(await call("",initial));assert.equal(root.rootTaskId,root.id);assert.equal((await call(`/${root.id}/start`,run(root))).status,202);root=await poll(root.id);
    const request={kind:"experience_refine",parentTaskId:root.id,workspaceKey:"synthetic-http-child",objective:"合成字段追问",runtimeBinding,consent:true,supplementConfirmed:true,idempotencyKey:"synthetic-http-root-child",refinement:{source:{targetRef:{kind:"profile_headline",locale:"zh"},text:"参与接口测试。",label:"合成原文"}},conversation:{messages:[{id:"u1",role:"user",content:""}]}};
    assert.equal((await call("",request,b.headers)).status,404);
    assert.equal((await call("",{...request,budget:{...budget,maxModelCalls:500}})).status,409);
    let child=await parsed(await call("",request));assert.deepEqual(child.budget,budget);assert.equal(child.rootLedger!.usage.modelCalls,1);assert.equal(child.rootTaskId,root.id);
    assert.equal((await call(`/${child.id}/start`,run(child))).status,202);child=await poll(child.id);assert.equal(child.status,"awaiting_answer",child.error);
    assert.equal(child.rootLedger!.usage.modelCalls,2);assert.equal(root.usage.modelCalls,1);assert.equal(child.usage.modelCalls,1);assert.equal(adapters,1);assert.equal(calls,2);
    root=await parsed(await call(`/${root.id}`));assert.equal(root.rootLedger!.usage.modelCalls,2);
    assert.equal((await call(`/${root.id}/answer`,{...run(root),message:{id:"u2",role:"user",content:"继续"}})).status,409);assert.equal(calls,2);
    const listed=await (await call("")).json();assert.equal(listed.tasks.length,2);assert.ok(listed.tasks.every((task:AgentTask)=>task.rootLedger?.usage.modelCalls===2));
  }finally{if(server){const current=server;await new Promise<void>(resolve=>current.close(()=>resolve()));}await delay(20);await rm(directory,{recursive:true,force:true});}
});
