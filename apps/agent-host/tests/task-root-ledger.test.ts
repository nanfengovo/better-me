import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import {mkdtemp,rm} from "node:fs/promises";
import {setTimeout as delay} from "node:timers/promises";
import {setImmediate as nextTurn} from "node:timers/promises";
import {careerRuntimeBinding,isCareerTask,type AgentTask,type FreeChatTaskCreate,type ExperienceRefineTaskCreate,type CareerTaskCreate} from "@better-me/agent-contracts";
import {AgentTaskKernel,type CareerTaskRuntime} from "../src/kernel/service.js";
import {readPrivateJson} from "../src/identity/private-json.js";

const access={session:"synthetic-root-session",valid:async()=>true};
const binding=careerRuntimeBinding({kind:"native",runtimeId:"codex"});
const budget={maxModelCalls:3,maxToolCalls:6,maxActiveMs:60000};
const input=(key:string,parentTaskId?:string):FreeChatTaskCreate=>({kind:"free_chat",workspaceKey:`synthetic-${key}`,objective:"讨论合成经历，不写资料",runtimeBinding:binding,consent:true,idempotencyKey:`root-ledger-${key}`,conversation:{messages:[{id:"u1",role:"user",content:"参与接口测试，不负责上线。"}]},...(parentTaskId?{parentTaskId}:{budget})});
const command=(task:AgentTask)=>({expectedRevision:task.revision,sourceFingerprint:isCareerTask(task)?task.resume.sourceFingerprint:task.sourceFingerprint,runtimeBinding:task.runtimeBinding,consent:true as const});
const reply=()=>JSON.stringify({kind:"reply",content:"合成候选仍需本人核对。"});
async function settled(kernel:AgentTaskKernel,id:string){for(let i=0;i<300;i++){const task=await kernel.readTask(id);if(task.status!=="running")return task;await delay(5);}throw Error("synthetic root task did not settle");}

test("mixed kinds inherit one root budget, including every repair; derived ledger is never a second persistent counter",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-root-mixed-")),kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory});let calls=0;
  try{
    let root=await kernel.createTask(input("mixed"),access);
    const runtime:CareerTaskRuntime={runtimeFingerprint:"one-owner-runtime",reasoner:async(prompt,_signal,phase)=>{calls++;const state=JSON.parse(prompt.split("\n\n").at(-1)!);assert.equal(state.rootLedger.rootTaskId,root.id);assert.equal(state.rootLedger.usage.modelCalls,calls);
      if(phase==="free_chat")return reply();if(calls===2)return "invalid output retained";
      return JSON.stringify({questions:["请说明你亲手做了什么"],rationale:"先问，不猜",evidenceQuotes:[]});}};
    await kernel.run(root.id,"start",command(root),runtime,access);root=await settled(kernel,root.id) as typeof root;
    const refinement:ExperienceRefineTaskCreate={kind:"experience_refine",parentTaskId:root.id,workspaceKey:"synthetic-refine",objective:"仅润色当前字段",runtimeBinding:binding,consent:true,supplementConfirmed:true,idempotencyKey:"root-ledger-mixed-refine",refinement:{source:{targetRef:{kind:"profile_headline",locale:"zh"},text:"参与接口测试。",label:"合成字段"}},conversation:{messages:[{id:"u1",role:"user",content:""}]}};
    let child=await kernel.createTask(refinement,access);assert.equal(child.parentTaskId,root.id);assert.equal(child.rootTaskId,root.id);assert.deepEqual(child.budget,budget);
    assert.equal(child.rootLedger!.usage.modelCalls,1);await kernel.run(child.id,"start",command(child),runtime,access);child=await settled(kernel,child.id) as typeof child;
    assert.equal(child.status,"awaiting_answer",child.error);assert.equal(child.usage.modelCalls,2);assert.equal(child.rootLedger!.usage.modelCalls,3);assert.equal(child.rootLedger!.memberCount,2);
    const viewed=await kernel.readTask(root.id);assert.equal(viewed.usage.modelCalls,1);assert.equal(viewed.rootLedger!.usage.modelCalls,3);
    await assert.rejects(kernel.run(child.id,"answer",{...command(child),message:{id:"u2",role:"user",content:"仅做测试。"},supplementConfirmed:true},runtime,access),/model_call_budget/);
    await assert.rejects(kernel.createTask(input("another",root.id),access),/model_call_budget/);assert.equal(calls,3);
    const stored=await readPrivateJson(path.join(directory,`${child.id}.json`)) as {task:AgentTask;recent:unknown[]};assert.equal(stored.task.rootLedger,undefined);assert.ok(JSON.stringify(stored.recent).includes("invalid output retained"));
  }finally{await kernel.close();await rm(directory,{recursive:true,force:true});}
});

test("concurrent siblings cannot overspend their root during format repair",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-root-concurrent-")),kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory});const finish=Promise.withResolvers<void>();let calls=0;
  try{
    const root=await kernel.createTask({...input("concurrent"),budget:{...budget,maxModelCalls:2}},access),a=await kernel.createTask(input("sibling-a",root.id),access),b=await kernel.createTask(input("sibling-b",root.id),access);
    const runtime:CareerTaskRuntime={runtimeFingerprint:"one-owner-runtime",reasoner:async()=>{calls++;await finish.promise;return "invalid JSON";}};
    await Promise.all([kernel.run(a.id,"start",command(a),runtime,access),kernel.run(b.id,"start",command(b),runtime,access)]);
    for(let i=0;calls<2&&i<100;i++)await delay(5);assert.equal(calls,2);finish.resolve();
    const results=await Promise.all([settled(kernel,a.id),settled(kernel,b.id)]);assert.ok(results.every(task=>task.status==="budget_exhausted"&&task.error==="model_call_budget"));
    assert.equal((await kernel.readTask(root.id)).rootLedger!.usage.modelCalls,2);assert.equal(calls,2);
  }finally{finish.resolve();await kernel.close();await rm(directory,{recursive:true,force:true});}
});

test("restart retains descendant charges and pinned runtime; only explicit root budget changes can extend the ceiling",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-root-restart-"));let kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory}),calls=0;const finish=Promise.withResolvers<string>(),entered=Promise.withResolvers<void>();
  try{
    let root=await kernel.createTask({...input("restart"),budget:{...budget,maxModelCalls:2}},access),child=await kernel.createTask(input("restart-child",root.id),access);
    await assert.rejects(kernel.createTask({...input("oversize-child",root.id),budget},access),/child_budget_must_inherit_root/);
    await kernel.run(child.id,"start",command(child),{runtimeFingerprint:"one-owner-runtime",reasoner:async()=>{calls++;entered.resolve();return finish.promise;}},access);await entered.promise;
    await kernel.close();kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory});child=await kernel.readTask(child.id) as typeof child;root=await kernel.readTask(root.id) as typeof root;
    assert.equal(child.status,"interrupted");assert.equal(root.rootLedger!.usage.modelCalls,1);assert.equal(calls,1);finish.resolve(reply());
    await assert.rejects(kernel.run(root.id,"start",command(root),{runtimeFingerprint:"different-owner-runtime",reasoner:async()=>reply()},access),/root_runtime_authorization_changed/);
    const runtime:CareerTaskRuntime={runtimeFingerprint:"one-owner-runtime",reasoner:async()=>{calls++;return reply();}};
    await kernel.run(child.id,"resume",command(child),runtime,access);child=await settled(kernel,child.id) as typeof child;
    await assert.rejects(kernel.budget(child.id,child.revision,budget,access),/adjust_root_budget_only/);
    root=await kernel.readTask(root.id) as typeof root;await assert.rejects(kernel.run(root.id,"start",command(root),runtime,access),/model_call_budget/);
    await assert.rejects(kernel.budget(root.id,root.revision,{...budget,maxModelCalls:1},access),/budget_below_usage/);
    await kernel.budget(root.id,root.revision,budget,access);root=await kernel.readTask(root.id) as typeof root;
    assert.equal(root.rootLedger!.usage.modelCalls,2);assert.equal((await kernel.readTask(child.id)).budget.maxModelCalls,3);
    await kernel.run(root.id,"start",command(root),runtime,access);root=await settled(kernel,root.id) as typeof root;
    assert.equal(root.rootLedger!.usage.modelCalls,3);assert.equal(calls,3);
  }finally{finish.resolve(reply());await kernel.close();await rm(directory,{recursive:true,force:true});}
});

test("root pause fences pending siblings, revocation blocks descendants, and another owner cannot attach",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-root-revoke-")),otherDirectory=await mkdtemp(path.join(os.tmpdir(),"betterme-root-other-"));
  const kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory}),other=new AgentTaskKernel({ownerId:"other-owner",directory:otherDirectory}),entered=Promise.withResolvers<void>(),finish=Promise.withResolvers<string>();
  try{
    let root=await kernel.createTask(input("revoke"),access),child=await kernel.createTask(input("revoke-child",root.id),access);
    await assert.rejects(other.createTask(input("cross-owner",root.id),access),/task_not_found/);
    await assert.rejects(kernel.createTask({...input("other-binding",root.id),runtimeBinding:careerRuntimeBinding({kind:"native",runtimeId:"claude"})},access),/root_runtime_binding_changed/);
    await kernel.run(child.id,"start",command(child),{runtimeFingerprint:"one-owner-runtime",reasoner:async()=>{entered.resolve();return finish.promise;}},access);await entered.promise;
    root=await kernel.readTask(root.id) as typeof root;await assert.rejects(kernel.budget(root.id,root.revision,budget,access),/pause_before_adjusting_budget/);
    await kernel.stop(root.id,root.revision,false,access);finish.resolve(reply());await delay(15);child=await kernel.readTask(child.id) as typeof child;
    assert.equal(child.status,"paused");assert.equal(child.reply,undefined);assert.equal(child.rootLedger!.usage.modelCalls,1);
    root=await kernel.readTask(root.id) as typeof root;await kernel.stop(root.id,root.revision,true,access);child=await kernel.readTask(child.id) as typeof child;
    await assert.rejects(kernel.run(child.id,"resume",command(child),{runtimeFingerprint:"one-owner-runtime",reasoner:async()=>reply()},access),/root_task_revoked/);
    await assert.rejects(kernel.createTask(input("revoked-new",root.id),access),/root_task_revoked/);
  }finally{finish.resolve(reply());await kernel.close();await other.close();await rm(directory,{recursive:true,force:true});await rm(otherDirectory,{recursive:true,force:true});}
});

test("generated source repairs and QuickJS qualification debit the same ancestor model/tool ledger",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-root-builder-")),kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory});let calls=0;
  try{
    const root=await kernel.createTask({...input("builder"),budget:{...budget,maxToolCalls:10}},access);
    const data:CareerTaskCreate={parentTaskId:root.id,workspaceKey:"synthetic-builder",objective:"仅在合成材料上测试逐行整理工具",job:{title:"合成岗位",company:"合成公司",description:"测试"},resume:{id:"synthetic-resume",name:"合成简历",sourceFingerprint:"synthetic-source",fields:[{id:"f1",targetRef:{kind:"profile_headline",locale:"zh"},originalText:"参与测试。"}]},materials:[{id:"m1",label:"合成材料",text:"first\nsecond",kind:"user_statement"}],runtimeBinding:binding,toolPolicy:{allowBuild:true,installedVersionIds:[]},consent:true,idempotencyKey:"root-ledger-builder-child"};
    let child=await kernel.createTask(data,access);
    await kernel.run(child.id,"start",command(child),{runtimeFingerprint:"one-owner-runtime",reasoner:async(_prompt,_signal,phase)=>{calls++;return phase==="tool_source"?JSON.stringify({source:"function(input) { return {records:[]}; }"}):JSON.stringify({kind:"tool",tool:"build_tool",id:"material-lines-v1"});}},access);
    child=await settled(kernel,child.id) as typeof child;assert.equal(child.status,"budget_exhausted");assert.equal(child.error,"model_call_budget");
    assert.equal(calls,3);assert.equal(child.usage.modelCalls,3);assert.equal(child.usage.toolCalls,3);assert.equal(child.rootLedger!.usage.modelCalls,3);assert.equal(child.rootLedger!.usage.toolCalls,3);
    // Model and tool gates are independent: qualification of the final model
    // result is a third real tool execution, not an uncharged or skipped one.
    assert.equal((await kernel.readTask(root.id)).rootLedger!.usage.toolCalls,3);assert.deepEqual(child.tools,[]);
  }finally{await kernel.close();await rm(directory,{recursive:true,force:true});}
});

test("concurrent children share aggregate active time instead of each receiving a full root wall-clock lease",async(t)=>{
  t.mock.timers.enable({apis:["Date","setTimeout"],now:1000});
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-root-time-")),kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory});const finish=Promise.withResolvers<string>();let calls=0;
  const entered=Promise.withResolvers<void>();
  try{
    const root=await kernel.createTask({...input("time"),budget:{...budget,maxActiveMs:400}},access),a=await kernel.createTask(input("time-a",root.id),access),b=await kernel.createTask(input("time-b",root.id),access);
    const runtime:CareerTaskRuntime={runtimeFingerprint:"one-owner-runtime",reasoner:async()=>{if(++calls===2)entered.resolve();return finish.promise;}};
    await Promise.all([kernel.run(a.id,"start",command(a),runtime,access),kernel.run(b.id,"start",command(b),runtime,access)]);
    await entered.promise;t.mock.timers.tick(200);
    const settleWithoutMockedDelay=async(id:string)=>{for(let i=0;i<1000;i++){const task=await kernel.readTask(id);if(task.status!=="running")return task;await nextTurn();}throw Error("synthetic root task did not settle");};
    const results=await Promise.all([settleWithoutMockedDelay(a.id),settleWithoutMockedDelay(b.id)]);assert.equal(calls,2);assert.ok(results.every(task=>task.error==="active_time_budget"&&task.status==="budget_exhausted"));
    assert.ok(results.every(task=>task.usage.activeMs<350),"each child must not receive its own 400ms allowance");
    const current=await kernel.readTask(root.id);assert.ok(current.rootLedger!.usage.activeMs>=380);await assert.rejects(kernel.createTask(input("time-c",root.id),access),/active_time_budget/);
  }finally{finish.resolve(reply());await kernel.close();await rm(directory,{recursive:true,force:true});t.mock.timers.reset();}
});
