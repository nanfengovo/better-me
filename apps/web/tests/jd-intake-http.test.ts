import assert from "node:assert/strict";
import test from "node:test";
import {once} from "node:events";
import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {type JdIntakeTask} from "@better-me/agent-contracts";
import {createAgentServer} from "../../agent-host/src/server";
import {MemorySaver} from "../../agent-host/tests/fixtures/checkpointer";
import {registerTestIdentity} from "../../agent-host/tests/fixtures/identity";
import {completeMetadataText,metadataPromptRequest,metadataResult} from "../../agent-host/tests/fixtures/jd-intake";
import {activatePrincipal} from "../src/lib/identity";
import {createFreeChatTaskClient} from "../src/services/free-chat-task-client";
import {createJdIntakeTaskClient} from "../src/services/jd-intake-task-client";

test("production metadata client uses authenticated tasks, full tail source, the chat root and explicit original-task recovery",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-jd-intake-http-")),token="synthetic-intake-token";let calls=0,builds=0,pauseOnce=true;
  const wire:{path:string;method:string}[]=[],seen:string[]=[];
  const server=createAgentServer({host:"127.0.0.1",port:0,authToken:token,allowedOrigins:[],runtimeDefinitions:[],identityDirectory:path.join(directory,"identity"),runsDirectory:path.join(directory,"runs"),understandingDirectory:path.join(directory,"understanding"),checkpointer:new MemorySaver() as never,
    careerTaskReasoner:async()=>{builds++;return async(prompt,_signal,phase)=>{
      calls++;if(phase==="free_chat")return JSON.stringify({kind:"reply",content:"合成根对话"});assert.equal(phase,"jd_intake");const {text}=metadataPromptRequest(prompt);seen.push(text);const output=JSON.stringify(metadataResult(text));
      if(text.includes("PAUSE-INTAKE")&&pauseOnce){pauseOnce=false;return {text:output,finishReason:"length"};}return output;
    };}});
  try{
    await once(server,"listening");const address=server.address();assert.ok(address&&typeof address!=="string");const baseUrl=`http://127.0.0.1:${address.port}`,identity=await registerTestIdentity(baseUrl,token,"synthetic-intake-http");activatePrincipal(identity.principal);
    const fetcher:typeof fetch=async(url,init)=>{const pathname=new URL(String(url)).pathname;assert.ok(pathname.startsWith("/api/v1/agent/tasks"));wire.push({path:pathname,method:init?.method??"GET"});const headers=new Headers(init?.headers);for(const [key,value]of Object.entries(identity.headers))headers.set(key,value);headers.set("Authorization",`Bearer ${token}`);return fetch(url,{...init,headers});};
    const options={baseUrl,fetch:fetcher,pollMs:5},client=createJdIntakeTaskClient(options),chat=createFreeChatTaskClient(options),runtime={kind:"model" as const,modelSettings:{provider:"ollama" as const,model:"synthetic-intake",baseUrl:"http://127.0.0.1:1/v1"}},rootScopeKey="synthetic-intake-scope";
    const reply=await chat.send({workspaceKey:"companion:intake",rootScopeKey,runtime,messages:[{id:"first",role:"user",content:"合成聊天根"}]});const rootId=reply.meta!.taskId!;
    const params={workspaceKey:"metadata:intake",rootScopeKey,runtime,consent:true as const,request:{mode:"metadata" as const,text:completeMetadataText}};
    const first=await client.generate(params);assert.equal(first.rootTaskId,rootId);assert.equal(first.usage.modelCalls,1);assert.equal(first.rootLedger?.usage.modelCalls,2);assert.equal(seen[0],completeMetadataText);assert.deepEqual(first.result,metadataResult(completeMetadataText));assert.equal(builds,1);
    const posts=wire.filter(row=>row.method==="POST").length;assert.deepEqual(await client.generate(params),first);await client.get(first.id);assert.equal(calls,2);assert.equal(wire.filter(row=>row.method==="POST").length,posts);
    const pausedParams={...params,request:{...params.request,text:"  PAUSE-INTAKE\r\n"+completeMetadataText}};let paused:JdIntakeTask|undefined;
    await assert.rejects(client.generate({...pausedParams,onTask:task=>{paused=task;}}),/输出未完成/);assert.equal(paused?.status,"paused");assert.equal(calls,3);const pausedId=paused!.id,pausePosts=wire.filter(row=>row.method==="POST").length;
    await assert.rejects(client.generate(pausedParams),/输出未完成/);assert.equal(calls,3);assert.equal(wire.filter(row=>row.method==="POST").length,pausePosts);
    await assert.rejects(client.generate({...pausedParams,resumeTaskId:pausedId,request:{...pausedParams.request,text:completeMetadataText}}),/原任务不一致/);assert.equal(calls,3);
    const resumed=await client.generate({...pausedParams,resumeTaskId:pausedId});assert.equal(resumed.id,pausedId);assert.equal(resumed.usage.modelCalls,2);assert.equal(resumed.rootLedger?.usage.modelCalls,4);assert.equal(calls,4);
    await assert.rejects(client.generate({...params,runtime:{...runtime,modelSettings:{...runtime.modelSettings,model:"other"}}}),/底座已变化/);assert.equal(calls,4);
    const other=await registerTestIdentity(baseUrl,token,"synthetic-intake-other");activatePrincipal(other.principal);assert.equal((await fetch(baseUrl+`/api/v1/agent/tasks/${first.id}`,{headers:{...other.headers,Authorization:`Bearer ${token}`}})).status,404);
    activatePrincipal(undefined);await assert.rejects(client.get(first.id),/请先登录/);assert.equal(calls,4);
  }finally{activatePrincipal(undefined);await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
});
