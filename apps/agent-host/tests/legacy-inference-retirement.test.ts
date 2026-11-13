import assert from "node:assert/strict";
import test from "node:test";
import {once} from "node:events";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {FreeChatTaskSchema,ProjectUnderstandingTaskSchema,careerRuntimeBinding} from "@better-me/agent-contracts";
import {createAgentServer} from "../src/server.js";
import {ChatGptPlanService} from "../src/chatgpt/service.js";
import {AgentRouting} from "../src/routing/service.js";
import {ProjectUnderstandingService} from "../src/understanding/service.js";
import {MemorySaver} from "./fixtures/checkpointer.js";
import {registerTestIdentity} from "./fixtures/identity.js";
import {projectTaskHttp} from "./fixtures/project-task-http.js";
import {BUILTIN_RUNTIME_DEFINITIONS} from "../src/runtime/registry.js";
import {FixtureNativeProcess} from "./fixtures/native-process.js";
import {AgentRunManager} from "../src/runs/run-manager.js";

const runtime={kind:"model" as const,modelSettings:{provider:"ollama" as const,model:"synthetic-fixed",baseUrl:"http://127.0.0.1:1/v1"}},binding=careerRuntimeBinding(runtime);
const retired=[
  ["/chat","free_chat_moved_to_tasks"],
  ["/chatgpt/response","chatgpt_response_moved_to_tasks"],
  ["/routing/respond","routing_response_moved_to_tasks"],
  ["/understanding/sessions/legacy-synthetic/turns","project_understanding_moved_to_tasks"],
  ["/runs","runtime_run_moved_to_tasks"],
  ["/workflows/career/start","career_workflow_moved_to_tasks"],
  ["/workflows/career/resume","career_workflow_moved_to_tasks"],
] as const;

test("all seven retired execution routes reject before dispatch; auth, policy, legacy records and real tasks remain functional",async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-retired-inference-"));let modelCalls=0,external=0,oldCalls=0;
  const old=async():Promise<never>=>{oldCalls++;throw Error("legacy executor must not run");};
  t.mock.method(ChatGptPlanService.prototype,"respond",old);t.mock.method(AgentRouting.prototype,"run",old);t.mock.method(ProjectUnderstandingService.prototype,"turn",old);
  t.mock.method(AgentRunManager.prototype,"start",old);
  const raw="  原始材料😀\r\n"+"合成原文，完整留存。".repeat(1000)+"SOURCE-END  \r\n",answer="  合成结果😀\r\nANSWER-END  ";
  const server=createAgentServer({host:"127.0.0.1",port:0,authToken:"synthetic-retired-token",allowedOrigins:["http://fixture.invalid"],identityDirectory:path.join(directory,"identity"),runtimeDefinitions:BUILTIN_RUNTIME_DEFINITIONS.filter(item=>item.id==="codex").map(item=>({...item,command:process.execPath,fallbackCommands:[]})),nativeProcessRunner:new FixtureNativeProcess(),checkpointer:new MemorySaver() as never,
    careerTaskReasoner:async()=>async(prompt,_signal,phase)=>{modelCalls++;assert.equal(phase,"free_chat");assert.ok(prompt.includes(JSON.stringify(raw).slice(1,-1)),"full escaped source reaches the real task protocol");return JSON.stringify({kind:"reply",content:answer});}});
  await once(server,"listening");const address=server.address();assert.ok(address&&typeof address!=="string");const origin=`http://127.0.0.1:${address.port}`,originalFetch=globalThis.fetch;
  t.mock.method(globalThis,"fetch",async(input,init)=>{if(!String(input).startsWith(origin+"/")){external++;throw Error("outside isolated Host");}return originalFetch(input,init);});
  const identity=await registerTestIdentity(origin,"synthetic-retired-token","synthetic-retirement","http://fixture.invalid");
  const request=(route:string,body?:unknown,method?:string)=>fetch(origin+"/api/v1/agent"+route,{method:method??(body===undefined?"GET":"POST"),headers:{...identity.headers,Authorization:"Bearer synthetic-retired-token",Origin:"http://fixture.invalid","Content-Type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
  try{
    const created=await request("/understanding/sessions",{workspaceKey:"legacy-history",projectKey:"legacy-project",label:"合成旧记录",sourceText:raw});assert.equal(created.status,201);const legacy=await created.json();
    const before=await(await request(`/understanding/sessions/${legacy.id}`)).json();
    for(const [route,code] of retired){
      assert.equal((await originalFetch(origin+"/api/v1/agent"+route,{method:"POST",body:"{}"})).status,401);
      for(const body of [{},{consentToSend:true,runtime,apiKey:"NEVER-FORWARD",messages:[{role:"user",content:raw}]}]){
        const response=await request(route,body);assert.equal(response.status,410);assert.equal(response.headers.get("cache-control"),"no-store");assert.deepEqual(await response.json(),{error:code,next:"/api/v1/agent/tasks"});
      }
      const wrong=await originalFetch(origin+"/api/v1/agent"+route,{method:"POST",headers:{...identity.headers,Authorization:"Bearer synthetic-retired-token",Origin:"https://untrusted.invalid"},body:"not-json"});assert.equal(wrong.status,403);
    }
    assert.deepEqual(await(await request(`/understanding/sessions/${legacy.id}`)).json(),before);assert.equal(modelCalls,0);assert.equal(oldCalls,0);
    assert.equal((await request(`/understanding/sessions/${legacy.id}/turns`,{consentToSend:true,runtime})).status,410);
    assert.deepEqual(await(await request(`/understanding/sessions/${legacy.id}`)).json(),before);
    assert.equal((await request("/chatgpt/state")).status,200);
    assert.equal((await request("/routing",{expectedRevision:0,mode:"manual",preferred:"codex",backups:[],allowApiBackups:false,consent:true},"PUT")).status,200);
    assert.equal((await(await request("/routing")).json()).policy.preferred,"codex");
    let response=await request("/tasks",{kind:"free_chat",workspaceKey:"real-task",rootScopeKey:"same-root",objective:"合成任务回归",conversation:{messages:[{id:"original-message",role:"user",content:raw}]},runtimeBinding:binding,consent:true,idempotencyKey:"retirement-real-task"});assert.equal(response.status,201);let task=FreeChatTaskSchema.parse((await response.json()).task);
    response=await request(`/tasks/${task.id}/start`,{expectedRevision:task.revision,sourceFingerprint:task.sourceFingerprint,runtimeBinding:binding,consent:true,runtime});assert.equal(response.status,202);
    for(let i=0;i<300;i++){task=FreeChatTaskSchema.parse((await(await request(`/tasks/${task.id}`)).json()).task);if(task.status!=="running")break;await new Promise(resolve=>setTimeout(resolve,5));}
    assert.equal(task.status,"awaiting_answer",task.error);assert.equal(task.reply?.content,answer);assert.equal(task.conversation.messages[0]!.content,raw);assert.equal(task.rootLedger!.usage.modelCalls,1);
    assert.equal((await request(`/tasks/${task.id}`)).status,200);assert.equal(modelCalls,1);assert.equal(oldCalls,0);assert.equal(external,0);
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await rm(directory,{recursive:true,force:true});}
});

test("Host close callback drains task writers before storage release; ignored late output and restart never replay",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-task-close-drain-")),entered=Promise.withResolvers<void>(),late=Promise.withResolvers<string>();let calls=0;
  const options={host:"127.0.0.1",port:0,authToken:"synthetic-close-token",allowedOrigins:["http://fixture.invalid"],identityDirectory:path.join(directory,"identity"),runtimeDefinitions:[],checkpointer:new MemorySaver() as never,
    careerTaskReasoner:async()=>async()=>{calls++;entered.resolve();return late.promise;}};
  let server=createAgentServer(options),closed=false;
  try{
    await once(server,"listening");let address=server.address();assert.ok(address&&typeof address!=="string");let origin=`http://127.0.0.1:${address.port}`;
    const identity=await registerTestIdentity(origin,"synthetic-close-token","synthetic-close","http://fixture.invalid");
    const request=(route:string,body?:unknown)=>fetch(origin+"/api/v1/agent"+route,{method:body===undefined?"GET":"POST",headers:{...identity.headers,Authorization:"Bearer synthetic-close-token",Origin:"http://fixture.invalid","Content-Type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const api=projectTaskHttp(request),session=await api.create({workspaceKey:"close",projectKey:"close-project",label:"合成关闭回归",sourceText:"关闭时保留的完整原文。"},runtime);
    assert.equal((await api.start(session.id,{expectedRevision:session.revision,idempotencyKey:"close-first-turn",answer:"  本人完整补充😀  ",consentToSend:true,runtime})).status,202);await entered.promise;
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));closed=true;
    const file=path.join(directory,"identity","owners",identity.principal.id,"career-tasks-v1",`${session.id}.json`),before=await readFile(file,"utf8"),saved=ProjectUnderstandingTaskSchema.parse(JSON.parse(before).task);
    assert.equal(saved.status,"interrupted");assert.equal(saved.usage.modelCalls,1);assert.ok(saved.project.messages.some(message=>message.text==="  本人完整补充😀  "));assert.equal(saved.project.understanding,undefined);
    late.resolve(JSON.stringify({kind:"reply",message:"LATE-MUST-NOT-APPLY",readyForConfirmation:true,understanding:{summary:"late",terms:[],claims:[],boundaries:[],unknowns:[]}}));await new Promise(resolve=>setTimeout(resolve,20));assert.equal(await readFile(file,"utf8"),before);
    server=createAgentServer(options);closed=false;await once(server,"listening");address=server.address();assert.ok(address&&typeof address!=="string");origin=`http://127.0.0.1:${address.port}`;
    const restored=await api.task(session.id);assert.equal(restored.status,"interrupted");assert.equal(restored.usage.modelCalls,1);assert.equal(restored.project.understanding,undefined);assert.equal(calls,1);
  }finally{late.resolve("{}");if(!closed)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await rm(directory,{recursive:true,force:true});}
});
