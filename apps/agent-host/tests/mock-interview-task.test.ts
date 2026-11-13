import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp,rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { careerRuntimeBinding,type MockInterviewTask,type MockInterviewTaskCreate,type JdMatchTask } from "@better-me/agent-contracts";
import { AgentTaskKernel,type CareerTaskRuntime } from "../src/kernel/service.js";
import { readPrivateJson } from "../src/identity/private-json.js";

const access={session:"synthetic-interview",valid:async()=>true},binding=careerRuntimeBinding({kind:"native",runtimeId:"codex"});
const focus={question:"请说明接口异常重试的测试边界？",gapItem:"接口异常重试",corePoints:["本人职责","异常覆盖"]};
const command=(task:MockInterviewTask)=>({expectedRevision:task.revision,sourceFingerprint:task.sourceFingerprint,runtimeBinding:task.runtimeBinding,consent:true as const});
async function read(kernel:AgentTaskKernel,id:string){const task=await kernel.readTask(id);assert.equal(task.kind,"mock_interview");return task as MockInterviewTask;}
async function settled(kernel:AgentTaskKernel,id:string){for(let i=0;i<300;i++){const task=await read(kernel,id);if(task.status!=="running")return task;await delay(5);}throw Error("Interview did not settle");}
type Context={phase:string;conversation:{messages:{id:string;role:string;content:string}[]};evidence:{id:string;sourceId:string;excerpt:string;startOffset:number;endOffset:number}[];evidenceManifest:{handle:string;sourceId:string}[]};
const context=(prompt:string)=>JSON.parse(prompt.split("\n\n").at(-1)!) as Context;
const question=(state:Context,content="你如何区分重试成功和重复提交？")=>JSON.stringify({kind:"question",content,evidenceIds:state.evidence.filter(item=>item.sourceId.startsWith("claim:")).map(item=>item.id)});
const receipt=(state:Context)=>({kind:"receipt",receipt:{summary:"仅评估本次合成作答，事实仍待核实。",answers:state.conversation.messages.filter(message=>message.role==="user").map(message=>({answerId:message.id,quote:message.content,assessment:"partial",gap:"需要说明测试观察与未覆盖边界。",improvedExpression:message.content,evidenceIds:state.evidence.filter(item=>item.sourceId===`answer:${message.id}`).map(item=>item.id)})),nextSteps:["补充测试环境中的可核对证据。"]}});
async function fixture(t:test.TestContext){
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-interview-")),kernel=new AgentTaskKernel({ownerId:"synthetic-interview-owner",directory});
  t.after(async()=>{await kernel.close();await rm(directory,{recursive:true,force:true});});return {directory,kernel};
}
async function parent(kernel:AgentTaskKernel,key="parent",claims:Record<string,string>={"claim-1":"只参与 C# 接口测试，验证异常重试；不负责生产上线。"}){
  return kernel.createTask({kind:"jd_match",workspaceKey:"synthetic-jd",rootScopeKey:"synthetic-career",objective:"核对岗位自述",runtimeBinding:binding,consent:true,idempotencyKey:`synthetic-interview-${key}`,
    matching:{rawJd:"岗位要求\n了解 C# 接口异常重试。",allowedProfileEntryIds:Object.keys(claims),sessionClaims:claims}},access);
}
const input=(parent:JdMatchTask,key="session"):MockInterviewTaskCreate=>({kind:"mock_interview",workspaceKey:"synthetic-workspace",rootScopeKey:"synthetic-career",objective:"针对选定攻防点逐题追问，手动结束后评估。",parentTaskId:parent.id,parentSourceFingerprint:parent.sourceFingerprint,focus,runtimeBinding:binding,consent:true,idempotencyKey:`synthetic-interview-${key}`});

test("a real interview child freezes parent sources, asks multiple turns and only human finish produces a complete receipt under one root",async t=>{
  const {kernel,directory}=await fixture(t),p=await parent(kernel),original=structuredClone(p.matching);let calls=0;
  let task=await kernel.createTask(input(p),access);assert.equal(task.parentTaskId,p.id);assert.equal(task.rootTaskId,p.id);assert.equal(task.status,"ready");assert.equal(task.usage.modelCalls,0);assert.deepEqual(task.conversation.messages,[]);
  assert.equal((await kernel.createTask(input(p),access)).id,task.id);assert.deepEqual(await kernel.list(),[]);
  const runtime:CareerTaskRuntime={runtimeFingerprint:"synthetic-generation",reasoner:async(prompt,_signal,phase)=>{calls++;assert.equal(phase,"mock_interview");assert.ok(prompt.includes("EVERY user answer"));const state=context(prompt);return state.phase==="evaluation"?JSON.stringify(receipt(state)):question(state);}};
  await kernel.run(task.id,"start",command(task),runtime,access);task=await settled(kernel,task.id);assert.equal(task.status,"awaiting_answer",task.error);assert.equal(task.interview.receipt,undefined);assert.equal(calls,1);
  for(const [id,content] of [["answer-1","我核对测试环境中的响应，没有验证生产行为。"],["answer-2","我对重复请求检查了返回结果，未验证所有并发路径。"]]){
    await kernel.run(task.id,"answer",{...command(task),interviewAction:"answer",message:{id:id!,role:"user",content:content!}},runtime,access);task=await settled(kernel,task.id);assert.equal(task.status,"awaiting_answer",task.error);
  }
  assert.equal(calls,3);assert.equal(task.interview.receipt,undefined);assert.equal(task.conversation.messages.length,5);
  await kernel.run(task.id,"answer",{...command(task),interviewAction:"finish"},runtime,access);task=await settled(kernel,task.id);
  assert.equal(task.status,"completed",task.error);assert.equal(calls,4);assert.equal(task.rootLedger!.usage.modelCalls,4);assert.equal(task.rootLedger!.memberCount,2);assert.equal(task.usage.toolCalls,0);
  assert.deepEqual(task.interview.receipt!.answers.map(item=>item.answerId),["answer-1","answer-2"]);assert.match(task.reply!.content,/面试攻防评估回执/);assert.ok(task.reply!.content.includes("未验证所有并发路径"));
  assert.deepEqual((await kernel.readTask(p.id) as JdMatchTask).matching,original);assert.ok(!("facts" in task));assert.equal((await kernel.readTask(p.id)).usage.modelCalls,0);
  await assert.rejects(kernel.run(task.id,"answer",{...command(task),interviewAction:"finish"},runtime,access),/task_not_runnable/);assert.equal(calls,4);
  const saved=await readPrivateJson(path.join(directory,`${task.id}.json`)) as {recent:{output?:string}[]};assert.equal(saved.recent.filter(item=>item.output).length,4);
});

test("wrong parent kind, changed parent snapshot, runtime, scope and child budget cannot create fresh interview authority",async t=>{
  const {kernel}=await fixture(t),p=await parent(kernel);
  await assert.rejects(kernel.createTask({...input(p,"changed"),parentSourceFingerprint:"changed"},access),/interview_parent_source_changed/);
  await assert.rejects(kernel.createTask({...input(p,"runtime"),runtimeBinding:{...binding,id:"other"}},access),/root_runtime_binding_changed/);
  await assert.rejects(kernel.createTask({...input(p,"scope"),rootScopeKey:"other-scope"},access),/root_scope_changed/);
  await assert.rejects(kernel.createTask({...input(p,"budget"),budget:{maxModelCalls:500,maxToolCalls:2000,maxActiveMs:600000}},access),/child_budget_must_inherit_root/);
  let task=await kernel.createTask(input(p),access);
  await assert.rejects(kernel.createTask({...input(p,"wrong-kind"),parentTaskId:task.id,parentSourceFingerprint:task.sourceFingerprint},access),/task_kind_not_supported_by_operation/);
  const runtime={runtimeFingerprint:"synthetic-generation",reasoner:async(prompt:string)=>question(context(prompt))};
  await assert.rejects(kernel.run(task.id,"start",{...command(task),interviewAction:"finish"},runtime,access),/interview_action_unexpected/);
  task=await read(kernel,task.id);assert.equal(task.status,"ready");assert.equal(task.usage.modelCalls,0);
});

test("premature receipts, changed answer quotes and unsupported rewrite metrics are rejected and repairs share the ledger",async t=>{
  const {kernel}=await fixture(t),p=await parent(kernel);let task=await kernel.createTask(input(p),access),calls=0;
  const runtime:CareerTaskRuntime={runtimeFingerprint:"synthetic-generation",reasoner:async prompt=>{
    calls++;const state=context(prompt);
    if(calls===1)return JSON.stringify(receipt(state));
    if(state.phase==="interview")return question(state);
    const result=receipt(state);if(calls===4)result.receipt.answers[0]!.quote="原答中不存在";
    if(calls===5)result.receipt.answers[0]!.improvedExpression="主导生产上线，提高性能 80%。";
    return JSON.stringify(result);
  }};
  await kernel.run(task.id,"start",command(task),runtime,access);task=await settled(kernel,task.id);assert.equal(calls,2);assert.equal(task.status,"awaiting_answer");
  await assert.rejects(kernel.run(task.id,"answer",{...command(task),message:{id:"u",role:"user",content:"只有回答，没有明确操作"}},runtime,access),/interview_action_required/);
  await kernel.run(task.id,"answer",{...command(task),interviewAction:"answer",message:{id:"u",role:"user",content:"我只验证测试环境的异常重试。"}},runtime,access);task=await settled(kernel,task.id);
  await assert.rejects(kernel.run(task.id,"answer",{...command(task),interviewAction:"answer",message:{id:"u",role:"user",content:"重复消息"}},runtime,access),/duplicate_message_identity/);
  await kernel.run(task.id,"answer",{...command(task),interviewAction:"finish"},runtime,access);task=await settled(kernel,task.id);
  assert.equal(task.status,"completed",task.error);assert.equal(calls,6);assert.equal(task.rootLedger!.usage.modelCalls,6);assert.doesNotMatch(task.reply!.content,/80%/);
});

test("interview reads exact UTF-16 manifest pages with every model/read charged and no source truncation",async t=>{
  const {kernel}=await fixture(t),long="边界😀\r\n"+"完整背景。".repeat(2000)+"稀有异常处理尾部-END";
  const claims=Object.fromEntries(Array.from({length:10},(_,i)=>[`claim-${i}`,i===9?long:"C# 接口异常重试测试。"]));
  const p=await parent(kernel,"paging",claims);let task=await kernel.createTask(input(p),access),calls=0;
  const offset=long.indexOf("稀有异常");
  await kernel.run(task.id,"start",command(task),{runtimeFingerprint:"synthetic-generation",reasoner:async prompt=>{
    calls++;const state=context(prompt);assert.equal(state.evidenceManifest.length,10);
    if(calls===1){assert.ok(state.evidence.length<=6);assert.ok(!state.evidence.some(item=>item.excerpt.endsWith("尾部-END")));return JSON.stringify({kind:"read_evidence",handle:state.evidenceManifest.find(item=>item.sourceId==="claim:claim-9")!.handle,offset,length:4000});}
    const page=state.evidence.find(item=>item.sourceId==="claim:claim-9"&&item.startOffset===offset)!;assert.equal(page.excerpt,long.slice(offset));assert.equal(page.endOffset,long.length);
    return JSON.stringify({kind:"question",content:"这段材料中的异常场景，你实际验证了哪些？",evidenceIds:[page.id]});
  }},access);task=await settled(kernel,task.id);assert.equal(task.status,"awaiting_answer",task.error);assert.equal(calls,2);assert.equal(task.usage.toolCalls,1);assert.equal(task.rootLedger!.usage.modelCalls,2);assert.equal(task.matching.sessionClaims["claim-9"],long);
});

test("parent group stop fences late interview output without refund and exhausted root prevents another child",async t=>{
  const {kernel}=await fixture(t);let p=await parent(kernel);await kernel.budget(p.id,p.revision,{maxModelCalls:1,maxToolCalls:2,maxActiveMs:60000},access);p=await kernel.readTask(p.id) as JdMatchTask;
  let task=await kernel.createTask(input(p),access);const entered=Promise.withResolvers<void>(),finish=Promise.withResolvers<string>();let calls=0;
  try{
    await kernel.run(task.id,"start",command(task),{runtimeFingerprint:"synthetic-generation",reasoner:async()=>{calls++;entered.resolve();return finish.promise;}},access);await entered.promise;
    p=await kernel.readTask(p.id) as JdMatchTask;await kernel.pauseGroup(p.id,p.revision,access);finish.resolve(JSON.stringify({kind:"question",content:"迟到问题不采用",evidenceIds:[]}));await delay(20);task=await read(kernel,task.id);
    assert.equal(task.status,"paused");assert.equal(task.reply,undefined);assert.equal(task.rootLedger!.usage.modelCalls,1);assert.equal(calls,1);
    await assert.rejects(kernel.createTask(input(p,"another"),access),/model_call_budget/);
  }finally{finish.resolve("late");}
});

test("Host restart, incomplete and oversized interview outputs preserve complete records without replay",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-interview-restart-"));let kernel=new AgentTaskKernel({ownerId:"synthetic-interview-owner",directory}),calls=0;
  const entered=Promise.withResolvers<void>(),finish=Promise.withResolvers<string>();
  try{
    const p=await parent(kernel);let task=await kernel.createTask(input(p),access);
    await kernel.run(task.id,"start",command(task),{runtimeFingerprint:"same",reasoner:async()=>{calls++;entered.resolve();return finish.promise;}},access);await entered.promise;
    await kernel.close();kernel=new AgentTaskKernel({ownerId:"synthetic-interview-owner",directory});task=await read(kernel,task.id);assert.equal(task.status,"interrupted");assert.equal(calls,1);
    finish.resolve("late");await delay(20);assert.equal((await read(kernel,task.id)).reply,undefined);
    await kernel.run(task.id,"resume",command(task),{runtimeFingerprint:"same",reasoner:async prompt=>{calls++;return {text:question(context(prompt)),finishReason:"length"};}},access);task=await settled(kernel,task.id);assert.equal(task.status,"paused");assert.equal(task.error,"model_output_incomplete");assert.ok(task.partialOutput!.text.endsWith("}"));assert.equal(task.reply,undefined);
    const output="完整面试输出。".repeat(22000)+"INTERVIEW-END";
    await kernel.run(task.id,"resume",command(task),{runtimeFingerprint:"same",reasoner:async()=>{calls++;return output;}},access);task=await settled(kernel,task.id);assert.equal(task.error,"decision_output_budget");assert.equal((await kernel.readOutput(task.id,task.outputArtifacts![0]!.id)).text,output);assert.equal(calls,3);assert.equal(task.rootLedger!.usage.modelCalls,3);
  }finally{finish.resolve("late");await kernel.close();await rm(directory,{recursive:true,force:true});}
});
