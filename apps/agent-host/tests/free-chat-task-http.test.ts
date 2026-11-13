import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { MemorySaver } from "@langchain/langgraph";
import { AgentTaskSchema, careerRuntimeBinding, isCareerTask, type FreeChatTask } from "@better-me/agent-contracts";
import { createAgentServer } from "../src/server.js";
import { registerTestIdentity } from "./fixtures/identity.js";

test("the authenticated unified task entry executes free_chat on the owner kernel and one cumulative ledger",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-free-chat-http-"));let server:http.Server|undefined,calls=0;
  const entered=Promise.withResolvers<void>(),finish=Promise.withResolvers<void>();
  const overflow=JSON.stringify({kind:"reply",content:"完整超长输出，不丢尾部。".repeat(16000)+"HTTP-OUTPUT-END"});
  const runtime={kind:"model" as const,modelSettings:{provider:"ollama" as const,model:"synthetic-free-chat",baseUrl:"http://127.0.0.1:11434/v1",apiKey:"SYNTHETIC-DO-NOT-PERSIST-CHAT"}},runtimeBinding=careerRuntimeBinding(runtime);
  try{
    server=createAgentServer({host:"127.0.0.1",port:0,authToken:"synthetic-chat-token",allowedOrigins:[],runtimeDefinitions:[],identityDirectory:path.join(directory,"accounts"),runsDirectory:path.join(directory,"runs"),understandingDirectory:path.join(directory,"understanding"),checkpointer:new MemorySaver() as never,
      careerTaskReasoner:async()=>async(prompt,signal,phase)=>{assert.equal(phase,"free_chat");signal.throwIfAborted();calls++;if(calls===1){entered.resolve();await finish.promise;}const state=JSON.parse(prompt.split("\n\n").at(-1)!);return {text:state.objective==="synthetic-overflow"?overflow:JSON.stringify({kind:"reply",content:`合成回答 ${calls}；没有读取或写入真实资料。`}),finishReason:"stop"};}});
    await once(server,"listening");const address=server.address();assert.ok(address&&typeof address!=="string");const base=`http://127.0.0.1:${address.port}`;
    const a=await registerTestIdentity(base,"synthetic-chat-token","free-chat-alice"),b=await registerTestIdentity(base,"synthetic-chat-token","free-chat-bob");
    const headers=(owner:Record<string,string>)=>({...owner,Authorization:"Bearer synthetic-chat-token","Content-Type":"application/json"});
    const call=(owner:Record<string,string>,suffix:string,body?:unknown)=>fetch(`${base}/api/v1/agent/tasks${suffix}`,{method:body===undefined?"GET":"POST",headers:headers(owner),...(body===undefined?{}:{body:JSON.stringify(body)})});
    const parsed=async(response:Response)=>{const value=await response.json();assert.ok(response.ok,JSON.stringify(value));const task=AgentTaskSchema.parse(value.task);assert.ok(!isCareerTask(task));return task;};
    const run=(task:FreeChatTask)=>({expectedRevision:task.revision,sourceFingerprint:task.sourceFingerprint,runtimeBinding,runtime,consent:true});
    const poll=async(id:string)=>{for(let i=0;i<180;i++){const task=await parsed(await call(a.headers,`/${id}`));if(task.status!=="running")return task;await delay(5);}throw Error("synthetic HTTP chat did not settle");};
    assert.equal((await call({},"")).status,401);
    const create={kind:"free_chat",workspaceKey:"chat-only-synthetic",objective:"讨论职业方向",conversation:{messages:[{id:"u1",role:"user",content:"我只参与测试，不负责上线。"}]},runtimeBinding,consent:true,idempotencyKey:"synthetic-http-free-chat"};
    let task=await parsed(await call(a.headers,"",create));assert.ok(!("job" in task));assert.ok(!("resume" in task));assert.equal(task.usage.modelCalls,0);
    assert.equal((await call(b.headers,`/${task.id}`)).status,404);
    assert.equal((await call(a.headers,`/${task.id}/start`,run(task))).status,202);await entered.promise;
    assert.equal((await call(a.headers,`/${task.id}/start`,run(task))).status,409);assert.equal(calls,1);
    const running=await parsed(await call(a.headers,`/${task.id}`));assert.equal(running.status,"running");assert.equal(running.usage.modelCalls,1);
    const feed=await (await call(a.headers,`/${task.id}/events?after=0`)).json();assert.ok(feed.events.some((event:{kind:string})=>event.kind==="model"));
    finish.resolve();task=await poll(task.id);assert.equal(task.status,"awaiting_answer");assert.equal(task.reply!.content,"合成回答 1；没有读取或写入真实资料。");assert.equal(calls,1);
    const tools=await (await call(a.headers,`/${task.id}/tools`)).json();assert.deepEqual(tools.tools,[]);
    const listed=await (await call(a.headers,"")).json();assert.equal(listed.tasks.length,1);assert.equal(listed.tasks[0].kind,"free_chat");
    const legacy=await fetch(`${base}/api/v1/agent/career-tasks`,{headers:headers(a.headers)});assert.deepEqual((await legacy.json()).tasks,[],"legacy job-only view does not misparse generic tasks");
    assert.equal((await call(a.headers,`/${task.id}/answer`,{...run(task),sourceFingerprint:"changed",message:{id:"u2",role:"user",content:"补充"}})).status,409);assert.equal(calls,1);
    assert.equal((await call(a.headers,`/${task.id}/answer`,{...run(task),message:{id:"u2",role:"user",content:"补充：只在测试环境验证。"}})).status,202);task=await poll(task.id);
    assert.equal(task.turn,2);assert.equal(task.usage.modelCalls,2);assert.equal(task.usage.toolCalls,0);assert.equal(task.conversation.messages.length,4);assert.equal(calls,2);
    assert.equal((await call(a.headers,`/${task.id}/receipt`,{expectedRevision:task.revision,draftHash:"fake",versionId:"fake",approvedPatchIds:["fake"]})).status,422);
    const stored=await readFile(path.join(directory,"accounts","owners",a.principal.id,"career-tasks-v1",`${task.id}.json`),"utf8");assert.ok(!stored.includes(runtime.modelSettings.apiKey));assert.ok(!stored.includes(runtime.modelSettings.baseUrl));
    assert.equal((await parsed(await call(a.headers,`/${task.id}`))).usage.modelCalls,2,"observation and rejected commands never dispatch a second time");
    let big=await parsed(await call(a.headers,"",{...create,objective:"synthetic-overflow",idempotencyKey:"synthetic-http-overflow"}));
    assert.equal((await call(a.headers,`/${big.id}/start`,run(big))).status,202);big=await poll(big.id);assert.equal(big.status,"budget_exhausted");assert.equal(calls,3);
    const outputId=big.outputArtifacts![0]!.id,download=await call(a.headers,`/${big.id}/outputs/${outputId}`);assert.equal(download.status,200);assert.match(download.headers.get("content-disposition")!,/attachment/);assert.equal(await download.text(),overflow);
    assert.equal((await call(b.headers,`/${big.id}/outputs/${outputId}`)).status,404,"another owner cannot download a known task/output pair");assert.equal(calls,3);
  }finally{finish.resolve();if(server){const current=server;await new Promise<void>(resolve=>current.close(()=>resolve()));}await delay(20);await rm(directory,{recursive:true,force:true});}
});
