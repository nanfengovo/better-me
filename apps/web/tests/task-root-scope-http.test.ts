import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {mkdtemp,rm} from "node:fs/promises";
import {once} from "node:events";
import {setTimeout as delay} from "node:timers/promises";
import {AgentTaskSchema,careerRuntimeBinding,type AgentTask} from "@better-me/agent-contracts";
import {MemorySaver} from "../../agent-host/tests/fixtures/checkpointer";
import {createAgentServer} from "../../agent-host/src/server";
import {registerTestIdentity} from "../../agent-host/tests/fixtures/identity";
import {createFreeChatTaskClient} from "../src/services/free-chat-task-client";
import {createExperienceRefineTaskClient} from "../src/services/experience-refine-task-client";
import {createUnderstandingClient} from "../src/services/understanding-client";
import {activatePrincipal} from "../src/lib/identity";
import {createTaskLedgerClient,assertTaskScope} from "../src/services/agent-task-scope";

test("production facade clients with distinct view keys share one authenticated scope, runtime and hard model ceiling",async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-web-root-scope-"));let calls=0,adapters=0,holdNext=false;const wire:{path:string;body?:Record<string,unknown>}[]=[],entered=Promise.withResolvers<void>(),finish=Promise.withResolvers<string>();
  const runtime={kind:"model" as const,modelSettings:{provider:"ollama" as const,model:"synthetic",baseUrl:"http://127.0.0.1:1/v1"}},runtimeBinding=careerRuntimeBinding(runtime),rootScopeKey="synthetic-resume-document",budget={maxModelCalls:4,maxToolCalls:7,maxActiveMs:60000};
  t.after(async()=>{finish.resolve(JSON.stringify({kind:"reply",content:"迟到的合成输出"}));activatePrincipal(undefined);if(server){const current=server;await new Promise<void>(resolve=>current.close(()=>resolve()));}await rm(directory,{recursive:true,force:true});});
  const server:http.Server=createAgentServer({host:"127.0.0.1",port:0,authToken:"synthetic-scope-token",allowedOrigins:[],runtimeDefinitions:[],identityDirectory:path.join(directory,"identity"),runsDirectory:path.join(directory,"runs"),understandingDirectory:path.join(directory,"understanding"),checkpointer:new MemorySaver() as never,
    careerTaskReasoner:async()=>{adapters++;return async(_prompt,_signal,phase)=>{calls++;if(holdNext){holdNext=false;entered.resolve();return {finishReason:"stop",text:await finish.promise};}return {finishReason:"stop",text:JSON.stringify(phase==="experience_refine"?{questions:["你亲手做了什么？"],rationale:"缺事实先问",evidenceQuotes:[]}:phase==="project_understanding"?{kind:"reply",message:"先确认项目语义。",understanding:{summary:"项目边界待本人确认。",terms:[],boundaries:[],claims:[],unknowns:["本人贡献未知"]},readyForConfirmation:false,question:{id:"scope",text:"回执表示什么？",why:"先确认共同术语",options:[{id:"done",label:"动作完成"}],allowMultiple:false}}:{kind:"reply",content:"只按已授权信息回答。"})};};}});
  await once(server,"listening");const address=server.address();assert.ok(address&&typeof address!=="string");const baseUrl=`http://127.0.0.1:${address.port}`,identity=await registerTestIdentity(baseUrl,"synthetic-scope-token","web-scope-owner");activatePrincipal(identity.principal);
  const fetcher:typeof fetch=async(url,init)=>{wire.push({path:new URL(String(url)).pathname,...(init?.body?{body:JSON.parse(String(init.body))}:{})});const headers=new Headers(init?.headers);for(const [key,value]of Object.entries(identity.headers))headers.set(key,value);headers.set("Authorization","Bearer synthetic-scope-token");return fetch(url,{...init,headers});};
  const call=async(suffix:string,body?:unknown)=>{const response=await fetcher(`${baseUrl}/api/v1/agent/tasks${suffix}`,{method:body===undefined?"GET":"POST",...(body===undefined?{}:{body:JSON.stringify(body)})});const raw=await response.json();assert.ok(response.ok,JSON.stringify(raw));return raw;};
  const root=AgentTaskSchema.parse((await call("",{kind:"free_chat",workspaceKey:"explicit-root",rootScopeKey,objective:"已明确核对的工作区总额度",runtimeBinding,budget,conversation:{messages:[{id:"root-user",role:"user",content:"合成总额度"}]},consent:true,idempotencyKey:"synthetic-scope-root"})).task);
  const options={baseUrl,fetch:fetcher,pollMs:5},chat=createFreeChatTaskClient(options),refine=createExperienceRefineTaskClient(options),project=createUnderstandingClient(options);
  await Promise.all(["advisor","companion"].map(view=>chat.send({workspaceKey:`${view}:same-resume`,rootScopeKey,runtime,messages:[{id:`${view}-u1`,role:"user",content:`合成 ${view} 问题`}]})));
  const session=await project.createSession({workspaceKey:"writing-session",rootScopeKey,projectKey:"project-field",label:"合成项目",sourceText:"参与接口测试。",runtimeBinding});
  await project.startTurn(session.id,{expectedRevision:session.revision,idempotencyKey:"synthetic-project-turn",answer:"",selectedOptionIds:[],consentToSend:true,runtime});
  for(let i=0;i<200;i++){if((await project.getSession(session.id)).phase!=="running")break;await delay(5);}
  assert.equal((await project.getSession(session.id)).phase,"awaiting-answer");
  await refine.refine({workspaceKey:"writing:separate-note",rootScopeKey,parentTaskId:session.id,refinement:{source:{targetRef:{kind:"profile_headline",locale:"zh"},label:"合成字段",text:"参与接口测试。"}},supplement:"",supplementConfirmed:true,runtime});
  const tasks=(await call("")).tasks.map((row:unknown)=>AgentTaskSchema.parse(row)) as AgentTask[];
  assert.equal(tasks.length,5);assert.ok(tasks.every(task=>task.rootScopeKey===rootScopeKey&&task.rootTaskId===root.id&&task.rootLedger!.usage.modelCalls===4&&task.budget.maxModelCalls===4));
  assert.equal(tasks.find(task=>task.kind==="experience_refine")!.parentTaskId,session.id);assert.equal(adapters,1);assert.equal(calls,4);
  await assert.rejects(chat.send({workspaceKey:"advisor:new-message",rootScopeKey,runtime,messages:[{id:"over-limit",role:"user",content:"不能另领额度"}]}),/额度已用尽/);assert.equal(calls,4);assert.equal(adapters,1);
  const createBodies=wire.filter(row=>row.path==="/api/v1/agent/tasks"&&row.body).map(row=>row.body!);
  assert.ok(createBodies.slice(1).every(body=>!("budget" in body)),"schema defaults must not request a fresh ceiling");assert.ok(wire.every(row=>row.path.startsWith("/api/v1/agent/tasks")));
  const ledger=createTaskLedgerClient(options),view=await ledger.read(rootScopeKey);assert.ok(view);assert.equal(view.root.rootLedger!.usage.modelCalls,4);
  const adjusted=await ledger.budget(view.root,{...budget,maxModelCalls:5});assert.equal(adjusted.rootLedger!.usage.modelCalls,4);assert.equal(calls,4,"manual metadata adjustment never starts a model");
  await chat.send({workspaceKey:"advisor:new-message",rootScopeKey,runtime,messages:[{id:"over-limit",role:"user",content:"不能另领额度"}]});assert.equal(calls,5);assert.equal(adapters,1);assert.equal((await ledger.read(rootScopeKey))!.root.rootLedger!.usage.modelCalls,5);
  assert.throws(()=>assertTaskScope({...adjusted,rootScopeKey:undefined},rootScopeKey),/旧记录尚未关联/);
  const beforePause=(await ledger.read(rootScopeKey))!;await ledger.budget(beforePause.root,{...budget,maxModelCalls:6});holdNext=true;
  const pending=chat.send({workspaceKey:"companion:pending-group-stop",rootScopeKey,runtime,messages:[{id:"pending-u1",role:"user",content:"合成整组停止"}]}).then(()=>{throw Error("paused task must not return a successful reply");},error=>error);
  await entered.promise;const running=(await ledger.read(rootScopeKey))!;assert.ok(running.members.some(task=>task.status==="running"));
  await ledger.pause(running.root);const stopped=await pending;assert.ok(stopped instanceof Error);assert.equal(calls,6);assert.equal(adapters,1);
  finish.resolve(JSON.stringify({kind:"reply",content:"迟到的合成输出"}));await delay(20);
  const afterPause=(await ledger.read(rootScopeKey))!,child=afterPause.members.find(task=>task.workspaceKey==="companion:pending-group-stop")!;
  assert.equal(child.kind,"free_chat");assert.equal(child.status,"paused");if(child.kind==="free_chat")assert.equal(child.reply,undefined);
  assert.equal(afterPause.root.status,"ready","stopping a running descendant preserves its non-running root");assert.equal(afterPause.root.rootLedger!.usage.modelCalls,6);assert.ok(wire.some(row=>row.path.endsWith("/pause-group")));
});

test("production legacy association HTTP/client retains original usage, rejects stale consent and reconciles a lost receipt without replay",async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-scope-association-http-"));let calls=0,adapters=0,loseReceipt=false;const writes:string[]=[];
  const server=createAgentServer({host:"127.0.0.1",port:0,authToken:"synthetic-association-token",allowedOrigins:[],runtimeDefinitions:[],identityDirectory:path.join(directory,"identity"),runsDirectory:path.join(directory,"runs"),understandingDirectory:path.join(directory,"understanding"),checkpointer:new MemorySaver() as never,
    careerTaskReasoner:async()=>{adapters++;return async()=>{calls++;return {finishReason:"stop",text:JSON.stringify({kind:"reply",content:"  合成完整答复😀\r\nEND  "})};};}});
  t.after(async()=>{activatePrincipal(undefined);await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});});
  await once(server,"listening");const address=server.address();assert.ok(address&&typeof address!=="string");const baseUrl=`http://127.0.0.1:${address.port}`,identity=await registerTestIdentity(baseUrl,"synthetic-association-token","legacy-association-owner");activatePrincipal(identity.principal);
  const fetcher:typeof fetch=async(url,init)=>{const route=new URL(String(url)).pathname;if(init?.method==="POST")writes.push(route);const headers=new Headers(init?.headers);for(const [key,value]of Object.entries(identity.headers))headers.set(key,value);headers.set("Authorization","Bearer synthetic-association-token");const response=await fetch(url,{...init,headers});if(loseReceipt&&route.endsWith("/associate-scope")){loseReceipt=false;await response.text();throw new Error("synthetic lost acknowledgment after durable association");}return response;};
  const runtime={kind:"model" as const,modelSettings:{provider:"ollama" as const,model:"synthetic-association",baseUrl:"http://127.0.0.1:1/v1"}},options={baseUrl,fetch:fetcher,pollMs:5},chat=createFreeChatTaskClient(options),ledger=createTaskLedgerClient(options),scope="合成旧简历/😀";
  await chat.send({workspaceKey:"old-advisor",runtime,messages:[{id:"old-user",role:"user",content:"  旧原文😀\r\n不截取  "}]});
  assert.equal(await ledger.read(scope),undefined);assert.equal(calls,1);const preview=await ledger.legacy(scope),candidate=preview.candidates[0]!;assert.equal(candidate.ledger.usage.modelCalls,1);assert.ok(candidate.previewToken);
  const malformed=await fetcher(`${baseUrl}/api/v1/agent/tasks/${candidate.rootTaskId}/associate-scope`,{method:"POST",body:JSON.stringify({rootScopeKey:scope,previewToken:candidate.previewToken,consent:true})});assert.equal(malformed.status,400);assert.equal((await malformed.json()).error,"invalid_task_request");assert.equal(await ledger.read(scope),undefined);
  loseReceipt=true;await assert.rejects(ledger.associate(scope,candidate),/尚未确认/);assert.equal(calls,1);assert.equal(adapters,1);
  const recovered=await ledger.read(scope);assert.ok(recovered);assert.equal(recovered.root.id,candidate.rootTaskId);assert.equal(recovered.root.rootLedger!.usage.modelCalls,1);
  const before=writes.length;await ledger.read(scope);await ledger.legacy(scope);assert.equal(writes.length,before,"reconciliation reads do not replay the association or model");
  const acknowledged=await ledger.associate(scope,candidate);assert.equal(acknowledged.association.effect,"records_and_usage_only");assert.equal(calls,1);
  assert.equal((await ledger.legacy(scope)).candidates.length,0);
  await chat.send({workspaceKey:"new-companion",rootScopeKey:scope,runtime,messages:[{id:"new-user",role:"user",content:"新的明确授权原文"}]});
  const next=(await ledger.read(scope))!;assert.equal(next.root.id,candidate.rootTaskId);assert.equal(next.members.length,2);assert.equal(next.root.rootLedger!.usage.modelCalls,2);assert.equal(calls,2);assert.equal(adapters,1);
  assert.ok(writes.every(route=>route.startsWith("/api/v1/agent/tasks")));assert.equal(writes.filter(route=>route.endsWith("/start")).length,2);
});
