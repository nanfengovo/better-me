import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp,rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { ExperienceRefineTaskCreateSchema,careerRuntimeBinding,type ExperienceRefineTask,type ExperienceRefineTaskCreate } from "@better-me/agent-contracts";
import { AgentTaskKernel,type CareerTaskRuntime } from "../src/kernel/service.js";
import { readPrivateJson } from "../src/identity/private-json.js";

const access={session:"synthetic-refine-session",valid:async()=>true};
const source={targetRef:{kind:"claim_text" as const,experienceId:"synthetic-exp",claimId:"synthetic-claim",locale:"zh" as const},text:"参与设备联调。",label:"合成经历"};
const input=(key="synthetic-refine-task"):ExperienceRefineTaskCreate=>({kind:"experience_refine",workspaceKey:"synthetic-writing",objective:"只打磨当前字段，不编造。",refinement:{source},
  conversation:{messages:[{id:"supp-1",role:"user",content:""}]},consent:true,supplementConfirmed:true,idempotencyKey:key,runtimeBinding:careerRuntimeBinding({kind:"native",runtimeId:"codex"}),budget:{maxModelCalls:4,maxToolCalls:4,maxActiveMs:60000}});
const command=(t:ExperienceRefineTask)=>({expectedRevision:t.revision,sourceFingerprint:t.sourceFingerprint,runtimeBinding:t.runtimeBinding,consent:true as const});
async function read(kernel:AgentTaskKernel,id:string){const task=await kernel.readTask(id);assert.equal(task.kind,"experience_refine");return task as ExperienceRefineTask;}
async function settled(kernel:AgentTaskKernel,id:string){for(let i=0;i<300;i++){const task=await read(kernel,id);if(task.status!=="running")return task;await delay(5);}throw Error("refine did not settle");}
const json=(proposedText?:string,evidenceQuotes:string[]=[])=>JSON.stringify({questions:proposedText?[]:["你本人具体做了哪一步？"],rationale:"按本人材料核对。",evidenceQuotes,...(proposedText?{proposedText}:{})});

test("experience_refine has a frozen exact source and explicit supplement consent, no fake JD or write grants",async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-refine-contract-")),kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory});t.after(async()=>{await kernel.close();await rm(directory,{recursive:true,force:true});});
  const data=input(),task=await kernel.createTask(data,access);assert.equal(task.kind,"experience_refine");assert.equal(task.usage.modelCalls,0);assert.ok(!("job" in task));assert.ok(!("resume" in task));
  assert.equal((await kernel.createTask(data,access)).id,task.id);assert.deepEqual(await kernel.list(),[]);
  assert.equal(ExperienceRefineTaskCreateSchema.safeParse({...data,supplementConfirmed:false}).success,false);
  assert.equal(ExperienceRefineTaskCreateSchema.safeParse({...data,refinement:{source:{...source,quote:{exact:"不存在",prefix:"",suffix:"",start:0,end:3}}}}).success,false);
  await assert.rejects(kernel.fact(task.id,task.revision,"not allowed",[],access),/task_kind_not_supported_by_operation/);
});

test("questions, confirmed corrections and fact/JSON repairs share the same counted task and complete history",async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-refine-turns-")),kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory});t.after(async()=>{await kernel.close();await rm(directory,{recursive:true,force:true});});
  let task=await kernel.createTask(input(),access),calls=0;const supplement="本人按任务编号关联日志，定位设备回执问题。",invalid=json("降低错误率80%",[source.text]);
  const runtime:CareerTaskRuntime={runtimeFingerprint:"same-refine-runtime",reasoner:async(prompt,_signal,phase)=>{assert.equal(phase,"experience_refine");calls++;
    if(calls===1)return json("未确认也不能采纳的候选",[source.text]);
    assert.ok(prompt.includes(supplement));if(calls===2)return invalid;
    assert.ok(prompt.includes("invalid_experience_reply"));assert.ok(prompt.includes("80%"));return {text:json("按任务编号关联日志，定位设备回执问题。",[supplement]),finishReason:"stop"};}};
  await kernel.run(task.id,"start",command(task),runtime,access);task=await settled(kernel,task.id);assert.equal(task.status,"awaiting_answer",task.error);assert.equal(task.refinementReply?.proposedText,undefined);assert.ok(task.refinementReply?.questions.length);
  await assert.rejects(kernel.run(task.id,"answer",{...command(task),message:{id:"supp-2",role:"user",content:supplement}},runtime,access),/confirmed_supplement_required/);
  await kernel.run(task.id,"answer",{...command(task),supplementConfirmed:true,message:{id:"supp-2",role:"user",content:supplement}},runtime,access);task=await settled(kernel,task.id);
  assert.equal(task.usage.modelCalls,3);assert.equal(task.usage.toolCalls,0);assert.equal(task.turn,2);assert.equal(task.conversation.messages.length,4);assert.equal(task.refinementReply?.proposedText,"按任务编号关联日志，定位设备回执问题。");
  const stored=await readPrivateJson(path.join(directory,`${task.id}.json`)) as {recent:{output?:string}[]};assert.ok(stored.recent.some(item=>item.output===invalid));
  await assert.rejects(kernel.run(task.id,"answer",{...command(task),sourceFingerprint:"changed",supplementConfirmed:true,message:{id:"supp-3",role:"user",content:"新补充"}},runtime,access),/source_changed_new_comparison_required/);assert.equal(calls,3);
});

test("length-limited output stays paused across restart; explicit resume retains usage and original full output",async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-refine-restart-"));let kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory});t.after(async()=>{await kernel.close();await rm(directory,{recursive:true,force:true});});
  let task=await kernel.createTask(input(),access),calls=0;const output=json();
  const runtime:CareerTaskRuntime={runtimeFingerprint:"same-refine-runtime",reasoner:async()=>{calls++;return {text:output,finishReason:calls===1?"length":"stop"};}};
  await kernel.run(task.id,"start",command(task),runtime,access);task=await settled(kernel,task.id);assert.equal(task.status,"paused");assert.equal(task.partialOutput?.text,output);assert.equal(task.refinementReply,undefined);
  await kernel.close();kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory});task=await read(kernel,task.id);assert.equal(calls,1);assert.equal(task.usage.modelCalls,1);
  await kernel.run(task.id,"resume",command(task),runtime,access);task=await settled(kernel,task.id);assert.equal(task.status,"awaiting_answer",task.error);assert.equal(task.usage.modelCalls,2);assert.equal(calls,2);
});

test("explicit pause fences late refinement output without discarding source or refunding a model call",async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-refine-pause-")),kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory});const entered=Promise.withResolvers<void>(),done=Promise.withResolvers<string>();
  t.after(async()=>{done.resolve(json());await kernel.close();await rm(directory,{recursive:true,force:true});});
  let task=await kernel.createTask(input(),access);await kernel.run(task.id,"start",command(task),{runtimeFingerprint:"same-refine-runtime",reasoner:async()=>{entered.resolve();return done.promise;}},access);
  await entered.promise;task=await read(kernel,task.id);await kernel.stop(task.id,task.revision,false,access);done.resolve(json());await delay(20);task=await read(kernel,task.id);
  assert.equal(task.status,"paused");assert.equal(task.refinementReply,undefined);assert.equal(task.conversation.messages.length,1);assert.equal(task.usage.modelCalls,1);assert.equal(task.refinement.source.text,source.text);
});
