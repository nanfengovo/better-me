import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import {mkdtemp,rm,readFile} from "node:fs/promises";
import {setTimeout as delay} from "node:timers/promises";
import {careerRuntimeBinding,type FreeChatTaskCreate,type AgentTask,type TaskScopeAssociationRequest} from "@better-me/agent-contracts";
import {AgentTaskKernel} from "../src/kernel/service.js";
import {writePrivateJson} from "../src/identity/private-json.js";

const access={session:"synthetic-association",valid:async()=>true},runtimeBinding=careerRuntimeBinding({kind:"native",runtimeId:"codex"});
const chat=(key:string):FreeChatTaskCreate=>({kind:"free_chat",workspaceKey:key,objective:"完整合成原文😀\r\n不裁剪  ",runtimeBinding,consent:true,idempotencyKey:`association-${key}`,conversation:{messages:[{id:"u1",role:"user",content:"  合成原文😀\r\nEND  "}]}});
const command=(task:AgentTask)=>({expectedRevision:task.revision,sourceFingerprint:"sourceFingerprint"in task?task.sourceFingerprint:"",runtimeBinding,consent:true as const});
const association=(rootScopeKey:string,previewToken:string):TaskScopeAssociationRequest=>({rootScopeKey,previewToken,confirmation:"associate_records_and_usage_only"});
async function stopped(kernel:AgentTaskKernel,id:string){for(let i=0;i<200;i++){const task=await kernel.readTask(id);if(task.status!=="running")return task;await delay(5);}throw new Error("synthetic task did not stop");}
async function setup(t:test.TestContext){
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-task-association-")),kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory});
  const kernels=[kernel],track=(next:AgentTaskKernel)=>{kernels.push(next);return next;};
  t.after(async()=>{for(const current of kernels)await current.close();await rm(directory,{recursive:true,force:true});});
  return {directory,kernel,track};
}

test("explicit legacy association is one metadata write, preserving every original journal, charge, source and runtime",async t=>{
  const {directory,kernel,track}=await setup(t);let calls=0;
  const runtime={runtimeFingerprint:"exact-account-generation",reasoner:async()=>{calls++;return JSON.stringify({kind:"reply",content:"  全文😀\r\nEND  "});}};
  const root=await kernel.createTask({...chat("root"),budget:{maxModelCalls:2,maxToolCalls:7,maxActiveMs:60000}},access);
  await kernel.run(root.id,"start",command(root),runtime,access);await stopped(kernel,root.id);
  const child=await kernel.createTask({...chat("child"),parentTaskId:root.id},access);
  await kernel.run(child.id,"start",command(child),runtime,access);await stopped(kernel,child.id);
  const before=await Promise.all([root.id,child.id].map(id=>readFile(path.join(directory,`${id}.json`),"utf8")));
  const preview=await kernel.previewLegacyScopes("resume-scope",access),candidate=preview.candidates[0]!;
  assert.equal(candidate.ledger.usage.modelCalls,2);assert.equal(candidate.ledger.memberCount,2);assert.ok(candidate.previewToken);
  const linked=await kernel.associateLegacyScope(root.id,association("resume-scope",candidate.previewToken!),access);
  assert.equal(linked.task.rootScopeKey,"resume-scope");assert.equal(linked.task.rootLedger!.usage.modelCalls,2);assert.equal(calls,2);
  assert.deepEqual(await Promise.all([root.id,child.id].map(id=>readFile(path.join(directory,`${id}.json`),"utf8"))),before);
  assert.equal((await kernel.readTask(child.id)).rootScopeKey,"resume-scope");
  await assert.rejects(kernel.createTask({...chat("no-refund"),rootScopeKey:"resume-scope"},access),/model_call_budget/);
  const retry=await kernel.associateLegacyScope(root.id,association("resume-scope",candidate.previewToken!),access);assert.deepEqual(retry.association,linked.association);
  await kernel.close();const reopened=track(new AgentTaskKernel({ownerId:"synthetic-owner",directory}));
  assert.equal((await reopened.readTask(child.id)).rootLedger!.usage.modelCalls,2);assert.equal((await reopened.previewLegacyScopes("resume-scope",access)).candidates.length,0);
  const current=await reopened.readTask(root.id);await reopened.budget(root.id,current.revision,{...current.budget,maxModelCalls:3},access);
  const next=await reopened.createTask({...chat("next"),rootScopeKey:"resume-scope"},access);assert.equal(next.parentTaskId,root.id);assert.equal(next.rootScopeKey,"resume-scope");assert.equal(next.budget.maxModelCalls,3);
  await assert.rejects(reopened.run(next.id,"start",command(next),{...runtime,runtimeFingerprint:"changed-account"},access),/root_runtime_authorization_changed/);
  await reopened.run(next.id,"start",command(next),runtime,access);await stopped(reopened,next.id);assert.equal(calls,3);
  const raw=JSON.parse(await readFile(path.join(directory,`${next.id}.json`),"utf8"));assert.equal(raw.task.rootScopeKey,"resume-scope");
  assert.equal((await reopened.readTask(root.id)).rootLedger!.usage.modelCalls,3);
});

test("preview pins descendants too; changed scope, revision or explicit confirmation never associates",async t=>{
  const {kernel}=await setup(t),root=await kernel.createTask(chat("stale-root"),access),child=await kernel.createTask({...chat("stale-child"),parentTaskId:root.id},access);
  const token=(await kernel.previewLegacyScopes("target",access)).candidates[0]!.previewToken!;
  await assert.rejects(kernel.associateLegacyScope(root.id,association("different",token),access),/scope_association_preview_changed/);
  await assert.rejects(kernel.associateLegacyScope(root.id,{...association("target",token),confirmation:undefined} as unknown as TaskScopeAssociationRequest,access));
  await kernel.stop(child.id,child.revision,false,access);
  await assert.rejects(kernel.associateLegacyScope(root.id,association("target",token),access),/scope_association_preview_changed/);
  assert.equal((await kernel.readTask(root.id)).rootScopeKey,undefined);
  const fresh=(await kernel.previewLegacyScopes("target",access)).candidates[0]!.previewToken!;
  await kernel.associateLegacyScope(root.id,association("target",fresh),access);
  await assert.rejects(kernel.associateLegacyScope(root.id,association("other",fresh),access),/task_scope_already_associated/);
});

test("concurrent confirmations cannot claim an occupied scope or discard either root's charges",async t=>{
  const {kernel}=await setup(t),roots=await Promise.all(["a","b"].map(key=>kernel.createTask(chat(key),access)));
  const preview=await kernel.previewLegacyScopes("one-scope",access);
  const results=await Promise.allSettled(preview.candidates.map(candidate=>kernel.associateLegacyScope(candidate.rootTaskId,association("one-scope",candidate.previewToken!),access)));
  assert.equal(results.filter(result=>result.status==="fulfilled").length,1);assert.match(String((results.find(result=>result.status==="rejected") as PromiseRejectedResult).reason),/root_scope_occupied/);
  const conflict=await kernel.previewLegacyScopes("one-scope",access);assert.ok(conflict.existingRootTaskId);assert.equal(conflict.candidates.length,1);assert.equal(conflict.candidates[0]!.blockedBy,"root_scope_occupied");assert.equal(conflict.candidates[0]!.previewToken,undefined);
  assert.equal((await kernel.listTasks()).length,2);assert.ok(roots.some(root=>root.id===conflict.candidates[0]!.rootTaskId));
});

test("running and revoked groups require stopping/review; association cannot authorize execution or another owner",async t=>{
  const {kernel,directory,track}=await setup(t),root=await kernel.createTask(chat("pending"),access),entered=Promise.withResolvers<void>(),finish=Promise.withResolvers<string>();
  t.after(()=>finish.resolve(JSON.stringify({kind:"reply",content:"late"})));
  await kernel.run(root.id,"start",command(root),{runtimeFingerprint:"pending",reasoner:async()=>{entered.resolve();return finish.promise;}},access);await entered.promise;
  const blocked=(await kernel.previewLegacyScopes("scope",access)).candidates[0]!;assert.equal(blocked.blockedBy,"pause_before_scope_association");assert.equal(blocked.previewToken,undefined);
  await assert.rejects(kernel.associateLegacyScope(root.id,association("scope","a".repeat(64)),access),/pause_before_scope_association/);
  const current=await kernel.readTask(root.id);await kernel.stop(root.id,current.revision,true,access);finish.resolve(JSON.stringify({kind:"reply",content:"late"}));
  const revoked=(await kernel.previewLegacyScopes("scope",access)).candidates[0]!;assert.equal(revoked.blockedBy,"root_task_revoked");
  await assert.rejects(kernel.previewLegacyScopes("scope",{session:"invalid",valid:async()=>false}),/interaction_lease_invalid/);
  await kernel.close();const other=track(new AgentTaskKernel({ownerId:"other-owner",directory}));
  await assert.rejects(other.previewLegacyScopes("scope",access),/invalid_private_task/);
});

test("atomic registry is owner-bound and rejects unconfirmed unscoped members or corrupted mappings",async t=>{
  const {kernel,directory}=await setup(t),root=await kernel.createTask(chat("tamper-root"),access),token=(await kernel.previewLegacyScopes("target",access)).candidates[0]!.previewToken!;
  await kernel.associateLegacyScope(root.id,association("target",token),access);
  const raw=JSON.parse(await readFile(path.join(directory,`${root.id}.json`),"utf8")),id=`ct_${"f".repeat(32)}`;
  raw.task={...raw.task,id,parentTaskId:root.id,rootTaskId:root.id};await writePrivateJson(path.join(directory,`${id}.json`),raw);
  await assert.rejects(kernel.readTask(root.id),/invalid_task_scope_associations/);
  const registryFile=path.join(directory,"task-scope-associations-v1.json"),registry=JSON.parse(await readFile(registryFile,"utf8"));
  await writePrivateJson(registryFile,{...registry,ownerId:"other-owner"});await assert.rejects(kernel.readTask(root.id),/invalid_task_scope_associations/);
});

test("old records without stored rootTaskId obtain a derived lineage, not a journal rewrite",async t=>{
  const {kernel,directory}=await setup(t),task=await kernel.createTask(chat("pre-lineage"),access),file=path.join(directory,`${task.id}.json`),raw=JSON.parse(await readFile(file,"utf8"));
  delete raw.task.rootTaskId;await writePrivateJson(file,raw);const before=await readFile(file,"utf8");
  const token=(await kernel.previewLegacyScopes("oldest",access)).candidates[0]!.previewToken!,result=await kernel.associateLegacyScope(task.id,association("oldest",token),access);
  assert.equal(result.task.rootTaskId,task.id);assert.equal(result.task.rootScopeKey,"oldest");assert.equal(await readFile(file,"utf8"),before);
  const next=await kernel.createTask({...chat("oldest-next"),rootScopeKey:"oldest"},access);assert.equal(next.rootTaskId,task.id);assert.equal(next.parentTaskId,task.id);
});

test("interrupted legacy takeover retains the old call and requires a separate exact-runtime resume",async t=>{
  const {kernel,directory,track}=await setup(t),root=await kernel.createTask(chat("interrupted"),access),entered=Promise.withResolvers<void>(),late=Promise.withResolvers<string>();let calls=0;
  const originalRuntime={runtimeFingerprint:"interrupted-runtime-generation",reasoner:async()=>{calls++;entered.resolve();return late.promise;}};
  await kernel.run(root.id,"start",command(root),originalRuntime,access);await entered.promise;await kernel.close();
  const reopened=track(new AgentTaskKernel({ownerId:"synthetic-owner",directory}));t.after(()=>{late.resolve(JSON.stringify({kind:"reply",content:"late"}));});
  const interrupted=await reopened.readTask(root.id);assert.equal(interrupted.status,"interrupted");assert.equal(interrupted.usage.modelCalls,1);
  const token=(await reopened.previewLegacyScopes("recovered",access)).candidates[0]!.previewToken!,linked=await reopened.associateLegacyScope(root.id,association("recovered",token),access);
  assert.equal(linked.task.status,"interrupted");assert.equal(calls,1);assert.equal(linked.task.rootLedger!.usage.modelCalls,1);
  await assert.rejects(reopened.run(root.id,"resume",{...command(linked.task),consent:undefined} as never,originalRuntime,access));assert.equal(calls,1);
  await assert.rejects(reopened.run(root.id,"resume",command(linked.task),{...originalRuntime,runtimeFingerprint:"changed-generation"},access),/runtime_authorization_changed/);assert.equal(calls,1);
  await reopened.run(root.id,"resume",command(linked.task),{runtimeFingerprint:originalRuntime.runtimeFingerprint,reasoner:async()=>{calls++;return JSON.stringify({kind:"reply",content:"新的明确恢复结果"});}},access);
  const result=await stopped(reopened,root.id);assert.equal(result.rootLedger!.usage.modelCalls,2);assert.equal(calls,2);assert.equal(result.kind,"free_chat");if(result.kind==="free_chat")assert.equal(result.reply!.content,"新的明确恢复结果");
  late.resolve(JSON.stringify({kind:"reply",content:"late"}));await delay(20);assert.deepEqual((await reopened.readTask(root.id)).usage,result.usage);
});
