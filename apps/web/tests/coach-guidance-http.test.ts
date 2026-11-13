import assert from "node:assert/strict";
import test from "node:test";
import {once} from "node:events";
import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {AgentTaskSchema,type CoachGuidanceTask} from "@better-me/agent-contracts";
import {createAgentServer} from "../../agent-host/src/server";
import {MemorySaver} from "../../agent-host/tests/fixtures/checkpointer";
import {registerTestIdentity} from "../../agent-host/tests/fixtures/identity";
import {coachPayload,coachPromptRequest,coachRequest} from "../../agent-host/tests/fixtures/career-coach";
import {activatePrincipal} from "../src/lib/identity";
import {createFreeChatTaskClient} from "../src/services/free-chat-task-client";
import {createCoachGuidanceTaskClient} from "../src/services/coach-guidance-task-client";

test("production coaching client uses authenticated tasks for six modes, one adapter/root, exact material and explicit recovery",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-coach-http-"));let calls=0,builds=0,pauseOnce=true;
  const token="synthetic-coach-http-token",wire:{path:string;method:string}[]=[],seen:ReturnType<typeof coachRequest>[]=[];
  const server=createAgentServer({host:"127.0.0.1",port:0,authToken:token,allowedOrigins:[],runtimeDefinitions:[],identityDirectory:path.join(directory,"identity"),runsDirectory:path.join(directory,"runs"),understandingDirectory:path.join(directory,"understanding"),checkpointer:new MemorySaver() as never,
    careerTaskReasoner:async()=>{builds++;return async(prompt,_signal,phase)=>{calls++;if(phase==="free_chat")return JSON.stringify({kind:"reply",content:"合成根对话"});assert.equal(phase,"career_coach");const request=coachPromptRequest(prompt);seen.push(request);if(request.input.includes("PAUSE-CASE")&&pauseOnce){pauseOnce=false;return {text:JSON.stringify(coachPayload(request)),finishReason:"length"};}return JSON.stringify(coachPayload(request));};}});
  try{
    await once(server,"listening");const address=server.address();assert.ok(address&&typeof address!=="string");const baseUrl=`http://127.0.0.1:${address.port}`,identity=await registerTestIdentity(baseUrl,token,"synthetic-coach-http-owner");activatePrincipal(identity.principal);
    const fetcher:typeof fetch=async(url,init)=>{const pathname=new URL(String(url)).pathname;assert.ok(pathname.startsWith("/api/v1/agent/tasks"),pathname);wire.push({path:pathname,method:init?.method??"GET"});const headers=new Headers(init?.headers);for(const [key,value]of Object.entries(identity.headers))headers.set(key,value);headers.set("Authorization",`Bearer ${token}`);return fetch(url,{...init,headers});};
    const options={baseUrl,fetch:fetcher,pollMs:5},client=createCoachGuidanceTaskClient(options),chat=createFreeChatTaskClient(options),runtime={kind:"model" as const,modelSettings:{provider:"ollama" as const,model:"synthetic-coach",baseUrl:"http://127.0.0.1:1/v1"}},rootScopeKey="synthetic-coach-http-scope";
    const reply=await chat.send({workspaceKey:"companion:synthetic-coach",rootScopeKey,runtime,messages:[{id:"first",role:"user",content:"合成聊天根"}]});assert.ok(reply.meta?.taskId);let parentTaskId=reply.meta!.taskId;
    const reviewEvidence="  完整代码与检查结果，不摘录。\r\n".repeat(1000)+"EVIDENCE-END  ";
    for(const mode of ["analysis","resume","plan","review","drill","interview"] as const){
      const request=coachRequest(mode);if(mode==="review")request.submission!.evidence=reviewEvidence;
      const params={workspaceKey:"coach:synthetic-http",rootScopeKey,parentTaskId,request,runtime,consent:true as const};
      const result=await client.generate(params);assert.equal(result.payload.kind,mode);assert.ok(result.task.id);const task=await client.get(result.task.id);assert.equal(task.rootTaskId,reply.meta!.taskId);assert.equal(task.usage.modelCalls,1);assert.deepEqual(task.request,request);
      const before=calls,posts=wire.filter(item=>item.method==="POST").length;assert.deepEqual(await client.generate(params),result);await client.get(task.id);assert.equal(calls,before);assert.equal(wire.filter(item=>item.method==="POST").length,posts);parentTaskId=task.id;
    }
    assert.equal(calls,7);assert.equal(builds,1);assert.equal(seen[0]!.input,coachRequest("analysis").input);assert.equal(seen.find(item=>item.mode==="review")!.submission!.evidence,reviewEvidence);
    const request=coachRequest("analysis","  PAUSE-CASE\r\n完整🚧输入  "),params={workspaceKey:"coach:synthetic-http",rootScopeKey,request,runtime,consent:true as const};let paused:CoachGuidanceTask|undefined;
    await assert.rejects(client.generate({...params,onTask:task=>{paused=task;}}),/输出未完成/);assert.equal(paused?.status,"paused");assert.equal(calls,8);const id=paused!.id;
    const posts=wire.filter(item=>item.method==="POST").length;await assert.rejects(client.generate(params),/输出未完成/);assert.equal(calls,8);assert.equal(wire.filter(item=>item.method==="POST").length,posts);
    await assert.rejects(client.generate({...params,request:{...request,input:"changed"},resume:true,resumeTaskId:id}),/原任务与/);assert.equal(calls,8);
    const resumed=await client.generate({...params,resume:true,resumeTaskId:id});assert.equal(resumed.task.id,id);assert.equal(calls,9);assert.equal((await client.get(id)).usage.modelCalls,2);
    const all=(await (await fetcher(baseUrl+"/api/v1/agent/tasks")).json()).tasks.map((item:unknown)=>AgentTaskSchema.parse(item));assert.equal(all.length,8);for(const task of all)assert.equal(task.rootLedger?.usage.modelCalls,9);
    await assert.rejects(client.generate({...params,runtime:{...runtime,modelSettings:{...runtime.modelSettings,model:"other"}}}),/底座已变化/);assert.equal(calls,9);
    const other=await registerTestIdentity(baseUrl,token,"synthetic-coach-other-owner");activatePrincipal(other.principal);const denied=await fetch(baseUrl+`/api/v1/agent/tasks/${id}`,{headers:{...other.headers,Authorization:`Bearer ${token}`}});assert.equal(denied.status,404);activatePrincipal(undefined);await assert.rejects(client.get(id),/请先登录/);assert.equal(calls,9);
  }finally{activatePrincipal(undefined);await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
});
