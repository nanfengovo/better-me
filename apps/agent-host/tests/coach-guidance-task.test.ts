import assert from "node:assert/strict";
import test, {type TestContext} from "node:test";
import os from "node:os";
import path from "node:path";
import {mkdtemp,rm} from "node:fs/promises";
import {setTimeout as delay} from "node:timers/promises";
import {careerRuntimeBinding,CoachGuidanceTaskSchema,type CoachGuidanceTask,type CoachGuidanceTaskCreate} from "@better-me/agent-contracts";
import {AgentTaskKernel,type CareerTaskRuntime} from "../src/kernel/service.js";
import {readPrivateJson} from "../src/identity/private-json.js";
import {coachPayload,coachRequest} from "./fixtures/career-coach.js";
const access={session:"synthetic-coach-session",valid:async()=>true},binding=careerRuntimeBinding({kind:"native",runtimeId:"codex"});
const input=(mode:CoachGuidanceTaskCreate["request"]["mode"]="analysis",key=`synthetic-coach-${mode}`):CoachGuidanceTaskCreate=>({kind:"career_coach",workspaceKey:"synthetic-coach",rootScopeKey:"synthetic-coach-root",objective:"合成职业成长任务",request:coachRequest(mode),runtimeBinding:binding,consent:true,idempotencyKey:key});
const command=(task:CoachGuidanceTask)=>({expectedRevision:task.revision,sourceFingerprint:task.sourceFingerprint,runtimeBinding:task.runtimeBinding,consent:true as const});
async function settled(kernel:AgentTaskKernel,id:string){for(let i=0;i<300;i++){const task=CoachGuidanceTaskSchema.parse(await kernel.readTask(id));if(task.status!=="running")return task;await delay(5);}throw Error("coaching task not settled");}
async function fixture(t:TestContext){const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-coach-kernel-")),kernel=new AgentTaskKernel({ownerId:"synthetic-coach-owner",directory});t.after(async()=>{await kernel.close();await rm(directory,{recursive:true,force:true});});return {kernel,directory};}

test("six coaching operations are real frozen tasks, sharing root budget with no tool or business effects",async t=>{
  const {kernel}=await fixture(t);let calls=0;
  for(const mode of ["analysis","resume","plan","review","drill","interview"] as const){
    const data=input(mode),task=await kernel.createTask(data,access);assert.equal(task.kind,"career_coach");assert.deepEqual(task.request,data.request);assert.equal(task.usage.modelCalls,0);
    const runtime:CareerTaskRuntime={runtimeFingerprint:"same-coach-runtime",reasoner:async(prompt,_signal,phase)=>{calls++;assert.equal(phase,"career_coach");assert.ok(prompt.includes("完整输入🚧END"));return JSON.stringify(coachPayload(data.request));}};
    await kernel.run(task.id,"start",command(task),runtime,access);const done=await settled(kernel,task.id);assert.equal(done.status,"completed",done.error);assert.equal(done.result!.payload.kind,mode);assert.equal(done.rootLedger!.usage.modelCalls,calls);
    assert.equal(done.usage.toolCalls,0);assert.ok(!("grants" in done));assert.equal((await kernel.createTask(data,access)).id,done.id);
    await assert.rejects(kernel.fact(done.id,done.revision,"不可自动采用",["invalid"],access),/task_kind_not_supported/);
  }
  const tasks=await kernel.listTasks();assert.equal(new Set(tasks.map(task=>task.rootTaskId)).size,1);assert.equal(calls,6);
  const invalid=input("review","invalid-review-synthetic");delete invalid.request.task;await assert.rejects(kernel.createTask(invalid,access),/invalid_coach_request/);assert.equal(calls,6);
});

test("invalid modes, copied source and workflow violations repair only through the same charged ledger",async t=>{
  const {kernel,directory}=await fixture(t),data=input("resume");data.budget={maxModelCalls:2,maxToolCalls:1,maxActiveMs:60000};let task=await kernel.createTask(data,access),calls=0;
  const wrong=coachPayload(data.request);assert.equal(wrong.kind,"resume");if(wrong.kind!=="resume")throw Error();wrong.proposals[0]!.originalText="不是原文";
  const raw=JSON.stringify(wrong),runtime:CareerTaskRuntime={runtimeFingerprint:"same-coach-runtime",reasoner:async prompt=>{calls++;if(calls===1)return raw;assert.ok(prompt.includes("完整原文无法"));return JSON.stringify(coachPayload(data.request));}};
  await kernel.run(task.id,"start",command(task),runtime,access);task=await settled(kernel,task.id);assert.equal(task.status,"completed",task.error);assert.equal(task.usage.modelCalls,2);assert.equal(calls,2);
  const stored=await readPrivateJson(path.join(directory,`${task.id}.json`)) as {recent:{output?:string}[]};assert.ok(stored.recent.some(item=>item.output===raw));
  await assert.rejects(kernel.createTask(input("analysis","synthetic-coach-root-full"),access),/model_call_budget/);assert.equal(calls,2);
});

test("complete whitespace, Unicode input, invalid output and incomplete output survive without auto continuation",async t=>{
  const {kernel,directory}=await fixture(t),data=input();data.request.input="  早期纠正\r\n"+"完整🚧材料\r\n".repeat(600)+"INPUT-END  ";let calls=0,task=await kernel.createTask(data,access);const output=JSON.stringify(coachPayload(data.request));
  const runtime:CareerTaskRuntime={runtimeFingerprint:"same-coach-runtime",reasoner:async prompt=>{calls++;const messages=prompt.split("\n\n"),request=JSON.parse(messages.find(item=>item.startsWith("以下JSON"))!.split("\n").slice(1).join("\n"));assert.equal(request.input,data.request.input);return {text:output,finishReason:"length"};}};
  await kernel.run(task.id,"start",command(task),runtime,access);task=await settled(kernel,task.id);assert.equal(task.status,"paused");assert.equal(task.partialOutput!.text,output);assert.equal(task.result,undefined);assert.equal(calls,1);
  await kernel.readTask(task.id);assert.equal(calls,1);assert.equal(task.request.input,data.request.input);
  const stored=await readPrivateJson(path.join(directory,`${task.id}.json`));assert.ok(JSON.stringify(stored).includes("INPUT-END"));
  await assert.rejects(kernel.run(task.id,"resume",command(task),{...runtime,runtimeFingerprint:"changed-authorization"},access),/runtime_authorization_changed/);assert.equal(calls,1);
  await kernel.run(task.id,"resume",command(task),{...runtime,reasoner:async()=>{calls++;return JSON.stringify(coachPayload(data.request));}},access);task=await settled(kernel,task.id);assert.equal(task.status,"completed");assert.equal(task.usage.modelCalls,2);
});

test("oversized coaching output is a complete private artifact, never a clipped success or hidden retry",async t=>{
  const {kernel}=await fixture(t);let calls=0,task=await kernel.createTask(input(),access);const output="输出🚧\r\n".repeat(30000)+"OUTPUT-END";
  await kernel.run(task.id,"start",command(task),{runtimeFingerprint:"same",reasoner:async()=>{calls++;return output;}},access);task=await settled(kernel,task.id);assert.equal(task.status,"budget_exhausted");assert.equal(task.error,"decision_output_budget");assert.equal(calls,1);assert.equal(task.result,undefined);
  assert.equal((await kernel.readOutput(task.id,task.outputArtifacts![0]!.id)).text,output);
});

test("stopping and restarting fence late coaching output and preserve the existing request and charges",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-coach-restart-"));let kernel=new AgentTaskKernel({ownerId:"synthetic-coach-owner",directory}),calls=0;
  const entered=Promise.withResolvers<void>(),late=Promise.withResolvers<string>();
  try{let task=await kernel.createTask(input(),access);await kernel.run(task.id,"start",command(task),{runtimeFingerprint:"same",reasoner:async()=>{calls++;entered.resolve();return late.promise;}},access);await entered.promise;await kernel.close();kernel=new AgentTaskKernel({ownerId:"synthetic-coach-owner",directory});task=CoachGuidanceTaskSchema.parse(await kernel.readTask(task.id));assert.equal(task.status,"interrupted");assert.equal(task.usage.modelCalls,1);assert.equal(calls,1);
    late.resolve(JSON.stringify(coachPayload(task.request)));await delay(10);assert.equal(CoachGuidanceTaskSchema.parse(await kernel.readTask(task.id)).result,undefined);
    await kernel.run(task.id,"resume",command(task),{runtimeFingerprint:"same",reasoner:async()=>{calls++;return JSON.stringify(coachPayload(task.request));}},access);task=await settled(kernel,task.id);assert.equal(task.status,"completed");assert.equal(calls,2);assert.equal(task.usage.modelCalls,2);
  }finally{late.resolve("{}");await kernel.close();await rm(directory,{recursive:true,force:true});}
});
