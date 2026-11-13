import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { mkdtemp,readFile,rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { MemorySaver } from "@langchain/langgraph";
import { AgentTaskSchema,careerRuntimeBinding,isCareerTask,type AgentTask,type MockInterviewTask,type JdMatchTask } from "@better-me/agent-contracts";
import { createAgentServer } from "../src/server.js";
import { registerTestIdentity } from "./fixtures/identity.js";

test("authenticated task HTTP shares one owner runtime/root through chat, JD parent and multi-turn interview; receipt reads never infer",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-interview-http-"));let server:http.Server|undefined,calls=0,builds=0;
  const runtime={kind:"model" as const,modelSettings:{provider:"ollama" as const,model:"synthetic-interview",baseUrl:"http://127.0.0.1:1/v1",apiKey:"SYNTHETIC-INTERVIEW-NOT-A-CREDENTIAL"}},runtimeBinding=careerRuntimeBinding(runtime);
  try{
    server=createAgentServer({host:"127.0.0.1",port:0,authToken:"synthetic-interview-token",allowedOrigins:[],runtimeDefinitions:[],identityDirectory:path.join(directory,"accounts"),runsDirectory:path.join(directory,"runs"),understandingDirectory:path.join(directory,"understanding"),checkpointer:new MemorySaver() as never,
      careerTaskReasoner:async()=>{builds++;return async(prompt,_signal,phase)=>{
        calls++;const state=JSON.parse(prompt.split("\n\n").at(-1)!);
        if(phase==="free_chat")return JSON.stringify({kind:"reply",content:"只验证合成接口测试，不假设上线。"});
        assert.equal(phase,"mock_interview");
        if(state.phase==="interview")return JSON.stringify({kind:"question",content:state.conversation.messages.length?"重复请求的验证结果和未覆盖范围是什么？":"请说明这段接口测试中的本人职责？",evidenceIds:state.evidence.filter((item:{sourceId:string})=>item.sourceId.startsWith("claim:")).map((item:{id:string})=>item.id)});
        return JSON.stringify({kind:"receipt",receipt:{summary:"合成回答的待核实评估。",answers:state.conversation.messages.filter((message:{role:string})=>message.role==="user").map((message:{id:string;content:string})=>({answerId:message.id,quote:message.content,assessment:"partial",gap:"未说明重复请求观察的具体条件。",improvedExpression:message.content,evidenceIds:state.evidence.filter((item:{sourceId:string})=>item.sourceId===`answer:${message.id}`).map((item:{id:string})=>item.id)})),nextSteps:["补充实际测试记录后再练习。"]}});
      };}});
    await once(server,"listening");const address=server.address();assert.ok(address&&typeof address!=="string");const base=`http://127.0.0.1:${address.port}`;
    const a=await registerTestIdentity(base,"synthetic-interview-token","interview-alice"),b=await registerTestIdentity(base,"synthetic-interview-token","interview-bob");
    const call=(owner:Record<string,string>,suffix:string,body?:unknown)=>fetch(`${base}/api/v1/agent/tasks${suffix}`,{method:body===undefined?"GET":"POST",headers:{...owner,Authorization:"Bearer synthetic-interview-token","Content-Type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const parsed=async(response:Response)=>{const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return AgentTaskSchema.parse(value.task);};
    const command=(task:AgentTask)=>{assert.ok(!isCareerTask(task));return {expectedRevision:task.revision,sourceFingerprint:task.sourceFingerprint,runtimeBinding,runtime,consent:true};};
    const poll=async(id:string)=>{for(let i=0;i<200;i++){const task=await parsed(await call(a.headers,`/${id}`));if(task.status!=="running")return task;await delay(5);}throw Error("Interview HTTP task did not settle");};
    let root=await parsed(await call(a.headers,"",{kind:"free_chat",workspaceKey:"advisor",rootScopeKey:"synthetic-workspace",objective:"合成顾问",conversation:{messages:[{id:"root-u",role:"user",content:"只参与测试。"}]},runtimeBinding,consent:true,idempotencyKey:"synthetic-interview-http-root"}));
    await parsed(await call(a.headers,`/${root.id}/start`,command(root)));root=await poll(root.id);
    const parent=await parsed(await call(a.headers,"",{kind:"jd_match",workspaceKey:"synthetic-jd",rootScopeKey:"synthetic-workspace",objective:"核对测试岗位",matching:{rawJd:"岗位要求\nC# 接口测试。",allowedProfileEntryIds:["claim-1"],sessionClaims:{"claim-1":"只参与测试环境中的接口校验，不负责生产上线。"}},runtimeBinding,consent:true,idempotencyKey:"synthetic-interview-http-parent"})) as JdMatchTask;
    let task=await parsed(await call(a.headers,"",{kind:"mock_interview",workspaceKey:"synthetic-workspace",rootScopeKey:"synthetic-workspace",parentTaskId:parent.id,parentSourceFingerprint:parent.sourceFingerprint,objective:"围绕当前攻防点对练",focus:{question:"请说明接口测试职责？",gapItem:"接口测试",corePoints:["本人边界"]},runtimeBinding,consent:true,idempotencyKey:"synthetic-interview-http-child"})) as MockInterviewTask;
    assert.equal(task.parentTaskId,parent.id);assert.equal(task.rootTaskId,root.id);assert.equal(task.rootLedger!.usage.modelCalls,1);assert.equal(builds,1);
    assert.equal((await call(b.headers,`/${task.id}`)).status,404);assert.equal((await call({},`/${task.id}`)).status,401);
    assert.equal((await call(a.headers,`/${task.id}/start`,command(task))).status,202);task=await poll(task.id) as MockInterviewTask;assert.equal(task.status,"awaiting_answer");
    assert.equal((await call(a.headers,`/${task.id}/answer`,{...command(task),interviewAction:"answer",message:{id:"u1",role:"user",content:"我只核对了测试环境中的重复请求。"}})).status,202);task=await poll(task.id) as MockInterviewTask;assert.equal(task.status,"awaiting_answer");assert.match(task.reply!.content,/未覆盖范围/);
    assert.equal((await call(a.headers,`/${task.id}/answer`,{...command(task),interviewAction:"finish"})).status,202);task=await poll(task.id) as MockInterviewTask;assert.equal(task.status,"completed",task.error);assert.equal(task.interview.receipt!.answers.length,1);
    assert.equal(calls,4);assert.equal(builds,1);assert.equal(task.rootLedger!.usage.modelCalls,4);assert.equal(task.rootLedger!.memberCount,3);assert.equal(task.usage.modelCalls,3);
    assert.equal((await call(a.headers,`/${task.id}/facts`,{expectedRevision:task.revision,text:"不能作为新事实",evidenceIds:[task.evidence[0]!.id]})).status,422);
    const reread=await parsed(await call(a.headers,`/${task.id}`));assert.equal(reread.status,"completed");assert.equal(calls,4);assert.equal(builds,1);assert.deepEqual((reread as MockInterviewTask).interview.receipt,task.interview.receipt);
    const stored=await readFile(path.join(directory,"accounts","owners",a.principal.id,"career-tasks-v1",`${task.id}.json`),"utf8");assert.ok(!stored.includes(runtime.modelSettings.apiKey));assert.ok(!stored.includes(runtime.modelSettings.baseUrl));
    assert.deepEqual((await parsed(await call(a.headers,`/${parent.id}`)) as JdMatchTask).matching,parent.matching);assert.equal(calls,4);
  }finally{if(server){server.closeIdleConnections();const current=server;await new Promise<void>(resolve=>current.close(()=>resolve()));}await rm(directory,{recursive:true,force:true});}
});
