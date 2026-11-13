import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { mkdtemp,rm } from "node:fs/promises";
import { MemorySaver } from "../../agent-host/tests/fixtures/checkpointer";
import { createAgentServer } from "../../agent-host/src/server";
import { registerTestIdentity } from "../../agent-host/tests/fixtures/identity";
import { AgentTaskSchema,careerRuntimeBinding } from "@better-me/agent-contracts";
import { createFreeChatTaskClient } from "../src/services/free-chat-task-client";
import { createJdMatchTaskClient,jdMatchResumeMaterial } from "../src/services/jd-match-task-client";
import { projectResume } from "@better-me/core";
import { createInitialDocument } from "@better-me/storage";
import { startJdMatch,resumeJdMatch } from "../src/services/agent-client";
import { activatePrincipal } from "../src/lib/identity";
import { AgentTaskClientError } from "../src/services/agent-task-transport";

test("visible resume material preserves unusual IDs and rejects collisions instead of silently replacing text",()=>{
  const document=createInitialDocument(),resume=projectResume(document.factBase,document.resumeViews[0]!);
  const exp=resume.experiences[0]!;assert.ok(exp.claims.length);
  exp.claims[0]!.id="__proto__";exp.claims[0]!.text="完整原句 😀 TAIL";
  const material=jdMatchResumeMaterial(resume);assert.equal(material.sessionClaims.__proto__,"完整原句 😀 TAIL");assert.ok(material.allowedProfileEntryIds.includes("__proto__"));
  resume.experiences.push(structuredClone(exp));assert.throws(()=>jdMatchResumeMaterial(resume),/标识重复/);
});

test("production JD facade uses only tasks, shares the chat root/runtime, restores without inference, and confirms exact proposals",async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-web-jd-http-"));let server:http.Server|undefined,calls=0,adapters=0;
  const originalFetch=globalThis.fetch,wire:{path:string;method:string;body?:Record<string,unknown>}[]=[],token="synthetic-jd-http";
  const runtime={kind:"model" as const,modelSettings:{provider:"ollama" as const,model:"synthetic",baseUrl:"http://127.0.0.1:1/v1",apiKey:"SYNTHETIC-DO-NOT-PERSIST"}};
  const material={rawJd:"岗位职责\n维护 C# 导入工具。\n任职要求\n了解异常重试。",allowedProfileEntryIds:["c1"],sessionClaims:{c1:"维护 C# 导入工具，验证异常重试。"}};
  try{
    server=createAgentServer({host:"127.0.0.1",port:0,authToken:token,allowedOrigins:[],runtimeDefinitions:[],identityDirectory:path.join(directory,"identity"),runsDirectory:path.join(directory,"runs"),understandingDirectory:path.join(directory,"understanding"),checkpointer:new MemorySaver() as never,
      careerTaskReasoner:async()=>{adapters++;return async(prompt,_signal,phase)=>{
        calls++;if(phase==="free_chat")return JSON.stringify({kind:"reply",content:"按本人边界继续。"});
        assert.equal(phase,"jd_match");const state=JSON.parse(prompt.split("\n\n").at(-1)!);
        return JSON.stringify({kind:"match",proposals:state.requiredItems.map((jdItem:string)=>({jdItem,evidenceType:"claimed",profileEntryId:"c1",suggestion:material.sessionClaims.c1,rationale:"只引用本人自述，未独立核验。",evidenceIds:[state.evidence.find((item:{sourceId:string})=>item.sourceId==="claim:c1").id]}))});
      };}});
    await once(server,"listening");const address=server.address();assert.ok(address&&typeof address!=="string");const baseUrl=`http://127.0.0.1:${address.port}`;
    const a=await registerTestIdentity(baseUrl,token,"jd-http-alice"),b=await registerTestIdentity(baseUrl,token,"jd-http-bob");activatePrincipal(a.principal);
    const fetcher:typeof fetch=async(url,init)=>{wire.push({path:new URL(String(url)).pathname,method:init?.method??"GET",...(init?.body?{body:JSON.parse(String(init.body))}:{})});const headers=new Headers(init?.headers);for(const [key,value]of Object.entries(a.headers))headers.set(key,value);headers.set("Authorization",`Bearer ${token}`);return originalFetch(url,{...init,headers});};
    t.mock.method(globalThis,"fetch",fetcher);
    const rootResponse=await fetcher(`${baseUrl}/api/v1/agent/tasks`,{method:"POST",body:JSON.stringify({kind:"free_chat",workspaceKey:"explicit-jd-root",rootScopeKey:"synthetic-jd-scope",objective:"已核对总额度",runtimeBinding:careerRuntimeBinding(runtime),budget:{maxModelCalls:2,maxToolCalls:4,maxActiveMs:60000},conversation:{messages:[{id:"root-u1",role:"user",content:"只讨论已授权范围。"}]},consent:true,idempotencyKey:"synthetic-jd-http-root"})});
    const root=AgentTaskSchema.parse((await rootResponse.json()).task);
    await createFreeChatTaskClient({baseUrl,pollMs:5}).send({workspaceKey:"explicit-jd-root",rootScopeKey:"synthetic-jd-scope",runtime,messages:[{id:"root-u1",role:"user",content:"只讨论已授权范围。"}]});assert.equal(calls,1);
    const params={threadId:"not-an-execution-id",workspaceKey:"same-career-workspace",rootScopeKey:"synthetic-jd-scope",...material,llmConfig:runtime.modelSettings,runtime,consent:true as const,baseUrl};
    const before=wire.length;await assert.rejects(startJdMatch({...params,consent:undefined}),/授权/);assert.equal(wire.length,before);
    const first=await startJdMatch(params);assert.equal(first.backend,"agent-host");assert.match(first.threadId,/^ct_/);assert.equal(calls,2);assert.equal(adapters,1);assert.equal(first.proposals.length,2);
    const client=createJdMatchTaskClient({baseUrl,pollMs:5}),task=await client.get(first.threadId);assert.equal(task.rootTaskId,root.id);assert.equal(task.rootLedger!.usage.modelCalls,2);assert.equal(task.usage.modelCalls,1);
    assert.equal((await startJdMatch({...params,threadId:"different-ui-thread"})).threadId,first.threadId);assert.equal(calls,2,"reconnect returns existing complete result");
    await assert.rejects(startJdMatch({...params,sessionClaims:{c1:"source changed"}}),/共享范围已变化/);assert.equal(calls,2);
    const decisions={[first.proposals[0]!.id]:{status:"accepted" as const}},review=await resumeJdMatch({threadId:first.threadId,decisions,currentProposals:first.proposals,llmConfig:runtime.modelSettings,baseUrl,matching:material});
    assert.equal(review.accepted.length,1);assert.equal(review.edited.length,0);assert.equal((await client.get(task.id)).status,"completed");assert.equal(calls,2);
    await assert.rejects(resumeJdMatch({threadId:first.threadId,decisions,currentProposals:first.proposals,llmConfig:runtime.modelSettings,baseUrl,matching:{...material,rawJd:"changed"}}),/当前岗位或简历已变化/);
    await assert.rejects(startJdMatch({...params,rawJd:material.rawJd+"\n具备 Vue 经验。"}),/额度已用尽/);assert.equal(calls,2);assert.equal(adapters,1);
    assert.ok(wire.every(row=>row.path.startsWith("/api/v1/agent/tasks")),"no legacy graph, browser LLM, or routing.respond request");
    const unauthorized=await originalFetch(`${baseUrl}/api/v1/agent/tasks/${task.id}`,{headers:{...b.headers,Authorization:`Bearer ${token}`}});assert.equal(unauthorized.status,404);
    for(const route of ["start","resume"]){const response=await originalFetch(`${baseUrl}/api/v1/agent/jd-match/${route}`,{method:"POST",headers:{...a.headers,Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:"{}"});assert.equal(response.status,410);assert.equal((await response.json()).error,"jd_match_moved_to_tasks");}
    assert.equal(calls,2);
  }finally{activatePrincipal(undefined);if(server){const current=server;await new Promise<void>(resolve=>current.close(()=>resolve()));}await rm(directory,{recursive:true,force:true});}
});

test("malformed or failed task replies never activate browser direct generation",async t=>{
  const calls:string[]=[];activatePrincipal({id:"11111111-1111-4111-8111-111111111111",username:"jd-failure",displayName:"synthetic"});
  t.after(()=>activatePrincipal(undefined));
  t.mock.method(globalThis,"fetch",async url=>{calls.push(String(url));return Response.json({tasks:null});});
  await assert.rejects(startJdMatch({threadId:"synthetic",rawJd:"任职要求\n掌握 C#。",allowedProfileEntryIds:[],llmConfig:{provider:"ollama",model:"synthetic",baseUrl:"http://127.0.0.1:1/v1"},consent:true}),error=>error instanceof AgentTaskClientError&&error.code==="invalid_response");
  assert.equal(calls.length,1);assert.ok(calls[0]!.endsWith("/api/v1/agent/tasks"));
});
