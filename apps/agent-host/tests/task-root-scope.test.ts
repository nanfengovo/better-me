import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import {mkdtemp,rm} from "node:fs/promises";
import {setTimeout as delay} from "node:timers/promises";
import {careerRuntimeBinding,type FreeChatTaskCreate} from "@better-me/agent-contracts";
import {AgentTaskKernel} from "../src/kernel/service.js";

const access={session:"synthetic-scope",valid:async()=>true},runtimeBinding=careerRuntimeBinding({kind:"native",runtimeId:"codex"});
const chat=(key:string):FreeChatTaskCreate=>({kind:"free_chat",workspaceKey:key,rootScopeKey:"synthetic-resume-scope",objective:"合成连续对话",runtimeBinding,consent:true,idempotencyKey:`synthetic-scope-${key}`,conversation:{messages:[{id:"u1",role:"user",content:"只参与测试。"}]}});

test("concurrent distinct facades atomically select one workspace root and inherit its non-default ceiling",async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-root-scope-")),kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory});t.after(async()=>{await kernel.close();await rm(directory,{recursive:true,force:true});});
  const budget={maxModelCalls:2,maxToolCalls:7,maxActiveMs:60000};
  const root=await kernel.createTask({...chat("advisor"),budget},access);
  const children=await Promise.all([
    kernel.createTask(chat("companion"),access),
    kernel.createTask({kind:"project_understanding",workspaceKey:"project-field",rootScopeKey:root.rootScopeKey,objective:"合成项目理解",project:{projectKey:"field",label:"合成项目",sourceText:"项目语义待确认。"},runtimeBinding,consent:true,idempotencyKey:"synthetic-project-scope"},access),
    kernel.createTask({kind:"experience_refine",workspaceKey:"writing-note",rootScopeKey:root.rootScopeKey,objective:"合成字段润色",refinement:{source:{targetRef:{kind:"profile_headline",locale:"zh"},text:"参与测试。",label:"合成原文"}},conversation:{messages:[{id:"u1",role:"user",content:""}]},runtimeBinding,consent:true,supplementConfirmed:true,idempotencyKey:"synthetic-refine-scope"},access),
  ]);
  assert.ok(children.every(task=>task.parentTaskId===root.id&&task.rootTaskId===root.id&&task.rootScopeKey===root.rootScopeKey));
  assert.ok(children.every(task=>JSON.stringify(task.budget)===JSON.stringify(budget)));
  assert.equal((await kernel.readTask(root.id)).rootLedger!.memberCount,4);
  // A scope is only a ledger association: none of the parent's text becomes a
  // project evidence grant, a conversation message, or a personal assertion.
  const project=children.find(task=>task.kind==="project_understanding")!;assert.equal(project.kind,"project_understanding");
  assert.deepEqual(project.project.grants,[]);assert.deepEqual(project.project.evidence,[]);assert.equal(project.project.messages.length,1);
  await assert.rejects(kernel.createTask({...chat("oversize"),budget:{...budget,maxModelCalls:12}},access),/child_budget_must_inherit_root/);
  await assert.rejects(kernel.createTask({...chat("other-model"),runtimeBinding:careerRuntimeBinding({kind:"native",runtimeId:"claude-code"})},access),/root_runtime_binding_changed/);
});

test("simultaneous first creates cannot fork a scope, and reopening keeps the same parent without replay",async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-root-scope-first-"));let kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory});t.after(async()=>{await kernel.close();await rm(directory,{recursive:true,force:true});});
  const tasks=await Promise.all(["a","b","c"].map(key=>kernel.createTask(chat(key),access)));
  const roots=tasks.filter(task=>!task.parentTaskId);assert.equal(roots.length,1);assert.ok(tasks.every(task=>task.rootTaskId===roots[0]!.id));
  await kernel.close();kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory});
  const next=await kernel.createTask(chat("after-reopen"),access);assert.equal(next.parentTaskId,roots[0]!.id);assert.equal(next.rootLedger!.memberCount,4);assert.equal(next.rootLedger!.usage.modelCalls,0);
  const ancestor=await kernel.readTask(roots[0]!.id);await kernel.stop(ancestor.id,ancestor.revision,true,access);
  await assert.rejects(kernel.createTask(chat("revoked-scope"),access),/root_task_revoked/);
});

test("scope association rejects mismatched explicit parents and leaves legacy and another owner untouched",async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-root-scope-owner-")),otherDirectory=await mkdtemp(path.join(os.tmpdir(),"betterme-root-scope-other-"));
  const kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory}),other=new AgentTaskKernel({ownerId:"other-owner",directory:otherDirectory});t.after(async()=>{await kernel.close();await other.close();await rm(directory,{recursive:true,force:true});await rm(otherDirectory,{recursive:true,force:true});});
  const legacy=await kernel.createTask({...chat("legacy"),rootScopeKey:undefined},access),root=await kernel.createTask(chat("root"),access);
  await assert.rejects(kernel.createTask({...chat("mismatch"),parentTaskId:legacy.id},access),/root_scope_changed/);
  await assert.rejects(kernel.createTask({...chat("different-scope"),rootScopeKey:"different-workspace",parentTaskId:root.id},access),/root_scope_changed/);
  const child=await kernel.createTask({...chat("explicit"),rootScopeKey:undefined,parentTaskId:root.id},access);assert.equal(child.rootScopeKey,root.rootScopeKey);
  const isolated=await other.createTask(chat("root"),access);assert.notEqual(isolated.id,root.id);assert.equal(isolated.rootTaskId,isolated.id);assert.equal(isolated.parentTaskId,undefined);
  assert.equal((await kernel.readTask(legacy.id)).rootScopeKey,undefined);assert.equal((await kernel.readTask(legacy.id)).rootTaskId,legacy.id);
});

test("manual group pause stops a pending descendant without overwriting its waiting root or accepting a late reply",async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-root-scope-stop-")),kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory}),entered=Promise.withResolvers<void>(),finish=Promise.withResolvers<string>();t.after(async()=>{finish.resolve(JSON.stringify({kind:"reply",content:"迟到输出"}));await kernel.close();await rm(directory,{recursive:true,force:true});});
  let root=await kernel.createTask(chat("waiting-root"),access);
  const command=(task:typeof root)=>({expectedRevision:task.revision,sourceFingerprint:task.sourceFingerprint,runtimeBinding,consent:true as const});
  await kernel.run(root.id,"start",command(root),{runtimeFingerprint:"one-scope-runtime",reasoner:async()=>JSON.stringify({kind:"reply",content:"已完成根首问"})},access);
  for(let i=0;i<200;i++){root=await kernel.readTask(root.id) as typeof root;if(root.status!=="running")break;await delay(5);}assert.equal(root.status,"awaiting_answer");
  const child=await kernel.createTask(chat("pending-child"),access);await kernel.run(child.id,"start",command(child),{runtimeFingerprint:"one-scope-runtime",reasoner:async()=>{entered.resolve();return finish.promise;}},access);await entered.promise;
  await assert.rejects(kernel.pauseGroup(child.id,child.revision+1,access),/root_task_required|task_revision_conflict/);
  root=await kernel.readTask(root.id) as typeof root;const paused=await kernel.pauseGroup(root.id,root.revision,access);assert.equal(paused.status,"awaiting_answer");assert.equal((paused as typeof root).reply?.content,"已完成根首问");assert.equal(paused.rootLedger!.usage.modelCalls,2);
  finish.resolve(JSON.stringify({kind:"reply",content:"迟到输出"}));await delay(20);const result=await kernel.readTask(child.id);assert.equal(result.status,"paused");assert.equal((result as typeof root).reply,undefined);
});
