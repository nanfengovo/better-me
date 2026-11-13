import assert from "node:assert/strict";
import test,{type TestContext} from "node:test";
import os from "node:os";
import path from "node:path";
import {mkdtemp,rm} from "node:fs/promises";
import {setTimeout as delay} from "node:timers/promises";
import {careerRuntimeBinding,JdIntakeTaskSchema,parseJdIntakeResult,type JdIntakeTask,type JdIntakeTaskCreate} from "@better-me/agent-contracts";
import {AgentTaskKernel,type CareerTaskRuntime} from "../src/kernel/service.js";
import {readPrivateJson} from "../src/identity/private-json.js";
import {completeMetadataText,metadataResult,metadataPromptRequest} from "./fixtures/jd-intake.js";
const access={session:"synthetic-intake-session",valid:async()=>true},binding=careerRuntimeBinding({kind:"native",runtimeId:"codex"});
const input=(key="synthetic-intake-source"):JdIntakeTaskCreate=>({kind:"jd_intake",workspaceKey:"synthetic-intake",rootScopeKey:"synthetic-intake-root",objective:"完整合成岗位字段",request:{mode:"metadata",text:completeMetadataText},runtimeBinding:binding,consent:true,idempotencyKey:key});
const command=(task:JdIntakeTask)=>({expectedRevision:task.revision,sourceFingerprint:task.sourceFingerprint,runtimeBinding:task.runtimeBinding,consent:true as const});
async function settled(kernel:AgentTaskKernel,id:string){for(let i=0;i<300;i++){const task=JdIntakeTaskSchema.parse(await kernel.readTask(id));if(task.status!=="running")return task;await delay(5);}throw Error("intake task did not settle");}
async function fixture(t:TestContext){const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-intake-kernel-")),kernel=new AgentTaskKernel({ownerId:"synthetic-intake-owner",directory});t.after(async()=>{await kernel.close();await rm(directory,{recursive:true,force:true});});return {directory,kernel};}

test("intake preserves the entire frozen source and exact tail spans without business effects",async t=>{
  const {kernel}=await fixture(t);let calls=0,task=await kernel.createTask(input(),access);
  assert.ok(task.request.text.length>3000);assert.equal(task.usage.modelCalls,0);
  await kernel.run(task.id,"start",command(task),{runtimeFingerprint:"same",reasoner:async(prompt,_signal,phase)=>{calls++;assert.equal(phase,"jd_intake");assert.equal(metadataPromptRequest(prompt).text,completeMetadataText);return JSON.stringify(metadataResult(completeMetadataText));}},access);
  task=await settled(kernel,task.id);assert.equal(task.status,"completed",task.error);assert.equal(calls,1);assert.deepEqual(task.result,metadataResult(completeMetadataText));assert.equal(task.usage.toolCalls,0);assert.equal((await kernel.createTask(input(),access)).id,task.id);
  await assert.rejects(kernel.fact(task.id,task.revision,"不可采用",["not-an-evidence"],access),/task_kind_not_supported/);
});
test("invented values or wrong UTF-16 offsets are rejected and only charged repairs may correct them",async t=>{
  const {kernel,directory}=await fixture(t),data=input();data.budget={maxModelCalls:2,maxToolCalls:1,maxActiveMs:60000};let task=await kernel.createTask(data,access),calls=0;
  const wrong=metadataResult(data.request.text);wrong.fields.company={value:"虚构企业",start:0,end:4};const raw=JSON.stringify(wrong);
  const runtime:CareerTaskRuntime={runtimeFingerprint:"same",reasoner:async prompt=>{calls++;if(calls===1)return raw;assert.ok(prompt.includes(raw.replaceAll('"','\\"')));return JSON.stringify(metadataResult(data.request.text));}};
  await kernel.run(task.id,"start",command(task),runtime,access);task=await settled(kernel,task.id);assert.equal(task.status,"completed",task.error);assert.equal(task.rootLedger?.usage.modelCalls,2);
  const stored=await readPrivateJson(path.join(directory,`${task.id}.json`)) as {recent:{output?:string}[]};assert.ok(stored.recent.some(item=>item.output===raw));
  await assert.rejects(kernel.createTask(input("synthetic-intake-over-budget"),access),/model_call_budget/);assert.equal(calls,2);
  const quote=metadataResult(completeMetadataText);quote.fields.title!.start--;assert.throws(()=>parseJdIntakeResult(JSON.stringify(quote),data.request),/source span/);
  assert.deepEqual(parseJdIntakeResult(JSON.stringify(metadataResult("这里只含未知正文，不能推断任职地点薪资或企业")),{mode:"metadata",text:"这里只含未知正文，不能推断任职地点薪资或企业"}).fields,{title:null,company:null,salary:null,location:null});
});
test("incomplete output stays full and paused, reads do not replay, explicit resume retains the original ledger",async t=>{
  const {kernel}=await fixture(t);let calls=0,task=await kernel.createTask(input(),access);const output=JSON.stringify(metadataResult(task.request.text));
  await kernel.run(task.id,"start",command(task),{runtimeFingerprint:"same",reasoner:async()=>{calls++;return {text:output,finishReason:"length"};}},access);
  task=await settled(kernel,task.id);assert.equal(task.status,"paused");assert.equal(task.partialOutput?.text,output);assert.equal(task.result,undefined);await kernel.readTask(task.id);assert.equal(calls,1);
  await assert.rejects(kernel.run(task.id,"resume",command(task),{runtimeFingerprint:"changed",reasoner:async()=>output},access),/runtime_authorization_changed/);
  await kernel.run(task.id,"resume",command(task),{runtimeFingerprint:"same",reasoner:async()=>{calls++;return output;}},access);task=await settled(kernel,task.id);assert.equal(task.status,"completed");assert.equal(task.usage.modelCalls,2);
});
test("oversized output remains a full private artifact and stopping fences late results",async t=>{
  const {kernel}=await fixture(t);let calls=0,task=await kernel.createTask(input(),access);const output="完整🚧\r\n".repeat(30000)+"END";
  await kernel.run(task.id,"start",command(task),{runtimeFingerprint:"same",reasoner:async()=>{calls++;return output;}},access);task=await settled(kernel,task.id);assert.equal(task.error,"decision_output_budget");assert.equal((await kernel.readOutput(task.id,task.outputArtifacts![0]!.id)).text,output);assert.equal(calls,1);
  const entered=Promise.withResolvers<void>(),late=Promise.withResolvers<string>();let stopped=await kernel.createTask(input("synthetic-stop-intake"),access);
  await kernel.run(stopped.id,"start",command(stopped),{runtimeFingerprint:"same",reasoner:async()=>{entered.resolve();return late.promise;}},access);await entered.promise;
  stopped=JdIntakeTaskSchema.parse(await kernel.readTask(stopped.id));await kernel.stop(stopped.id,stopped.revision,false,access);late.resolve(JSON.stringify(metadataResult(completeMetadataText)));await delay(10);
  stopped=JdIntakeTaskSchema.parse(await kernel.readTask(stopped.id));assert.equal(stopped.status,"paused");assert.equal(stopped.result,undefined);assert.equal(stopped.usage.modelCalls,1);
});
