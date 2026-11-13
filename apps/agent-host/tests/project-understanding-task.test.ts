import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import {mkdtemp,rm,writeFile,readFile} from "node:fs/promises";
import {setTimeout as delay} from "node:timers/promises";
import {careerRuntimeBinding,ProjectUnderstandingTaskSchema,type ProjectUnderstandingTask,type ProjectUnderstandingTaskCreate} from "@better-me/agent-contracts";
import {AgentTaskKernel,type CareerTaskRuntime} from "../src/kernel/service.js";
const access={session:"synthetic-project-session",valid:async()=>true},binding=careerRuntimeBinding({kind:"native",runtimeId:"codex"});
const input=(key="synthetic-project-task"):ProjectUnderstandingTaskCreate=>({kind:"project_understanding",workspaceKey:"synthetic-project",objective:"建立可确认的项目共识",project:{projectKey:"synthetic-project-field",label:"合成协调项目",sourceText:"参与任务回执接口。"},runtimeBinding:binding,consent:true,idempotencyKey:key,budget:{maxModelCalls:8,maxToolCalls:20,maxActiveMs:60000}});
const command=(task:ProjectUnderstandingTask,key:string,answer="",selectedOptionIds:string[]=[])=>({expectedRevision:task.revision,sourceFingerprint:task.sourceFingerprint,runtimeBinding:task.runtimeBinding,consent:true as const,projectTurn:{expectedRevision:task.revision,idempotencyKey:key,answer,selectedOptionIds,consentToSend:true as const}});
async function read(kernel:AgentTaskKernel,id:string){return ProjectUnderstandingTaskSchema.parse(await kernel.readTask(id));}
async function settled(kernel:AgentTaskKernel,id:string){for(let i=0;i<500;i++){const task=await read(kernel,id);if(task.status!=="running")return task;await delay(5);}throw Error("project did not settle");}
function context(prompt:string){const json=prompt.split("\n\n").find(part=>part.startsWith('{"project":'));assert.ok(json);return JSON.parse(json);}
function reply(prompt:string,ready=true,sourceId?:string){const ctx=context(prompt),user=ctx.context.messages.filter((message:{role:string})=>message.role==="user").at(-1);return JSON.stringify({kind:"reply",message:"合成项目共识，待本人核对。",understanding:{summary:"该项目处理任务回执；不证明个人完成或生产采用。",terms:[],boundaries:["源码不证明本人贡献"],claims:[{id:"scope",text:sourceId?"代码中有回执处理入口。":"本人说明参与任务回执接口。",kind:sourceId?"source":"user",evidenceIds:[sourceId??user.id]}],unknowns:["上线情况未确认"]},readyForConfirmation:ready,...(!ready?{question:{id:"meaning",text:"回执代表哪一步完成？",why:"确定业务完成语义",options:[{id:"accepted",label:"设备接受任务"},{id:"done",label:"设备完成动作"}],allowMultiple:false}}:{})});}
async function fixture(){const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-project-kernel-"));return {directory,kernel:new AgentTaskKernel({ownerId:"synthetic-owner",directory:path.join(directory,"tasks")})};}

test("project-understanding is a real root-linked kind; reads, two turns, exact options and confirmation share one ledger",async t=>{
  const {directory,kernel}=await fixture();t.after(async()=>{await kernel.close();await rm(directory,{recursive:true,force:true});});
  const root=await kernel.createTask({kind:"free_chat",workspaceKey:"synthetic-root",objective:"合成父对话",conversation:{messages:[{id:"u1",role:"user",content:"建立项目理解"}]},runtimeBinding:binding,consent:true,idempotencyKey:"project-parent-task",budget:{maxModelCalls:3,maxToolCalls:10,maxActiveMs:60000}},access);
  let task=await kernel.createTask({...input(),parentTaskId:root.id,budget:undefined},access);assert.equal(task.rootTaskId,root.id);assert.equal(task.usage.modelCalls,0);assert.equal(task.project.id,task.id);assert.equal(task.project.revision,task.revision);assert.deepEqual(await kernel.list(),[]);
  const file=path.join(directory,"Task.cs");await writeFile(file,"class Task {\r\n  void Receipt() {}\r\n}\r\n");task=ProjectUnderstandingTaskSchema.parse(await kernel.grantProject(task.id,task.revision,file,access));const grant=task.project.grants[0]!;let calls=0;
  const runtime:CareerTaskRuntime={runtimeFingerprint:"one-project-runtime",reasoner:async(prompt,_signal,phase)=>{assert.equal(phase,"project_understanding");calls++;const ctx=context(prompt);
    if(calls===1)return JSON.stringify({kind:"read",requests:[{grantId:grant.id,operation:"read",path:"Task.cs"}]});
    const item=ctx.context.evidence[0];assert.ok(item);assert.equal(item.excerpt,"class Task {\r\n  void Receipt() {}\r\n}\r\n");assert.equal(item.startOffset,0);assert.equal(item.endOffset,item.excerpt.length);assert.ok(ctx.citableEvidenceIds.includes(item.id));
    if(calls===3){assert.ok(prompt.includes("  本人只排查回执。  "));assert.ok(prompt.includes("设备完成动作"));}
    return reply(prompt,calls===3,item.id);
  }};
  const first=command(task,"project-first-turn");await kernel.run(task.id,"start",first,runtime,access);task=await settled(kernel,task.id);assert.equal(task.status,"awaiting_answer",task.error);assert.equal(task.usage.modelCalls,2);assert.equal(task.usage.toolCalls,2);
  assert.equal((await kernel.run(task.id,"start",first,runtime,access)).id,task.id);assert.equal(calls,2,"same receipt never replays even with old revision");
  await assert.rejects(kernel.run(task.id,"answer",command(task,"invalid-option-key","",["forged"]),runtime,access),error=>(error as {code?:string}).code==="invalid_input");assert.equal(calls,2);
  await kernel.run(task.id,"answer",command(task,"project-second-turn","  本人只排查回执。  ",["done"]),runtime,access);task=await settled(kernel,task.id);assert.equal(task.status,"awaiting_review",task.error);assert.equal(task.usage.modelCalls,3);assert.equal(task.rootLedger!.usage.modelCalls,3);assert.equal(task.project.confirmation,undefined);
  await assert.rejects(kernel.confirmProject(task.id,task.revision,"wrong",access),/project_confirmation_changed/);
  task=ProjectUnderstandingTaskSchema.parse(await kernel.confirmProject(task.id,task.revision,task.project.summaryHash!,access));assert.equal(task.status,"completed");assert.equal(task.project.phase,"confirmed");assert.equal(task.project.confirmation!.revision,task.revision);assert.equal(task.usage.toolCalls,4,"confirmation revalidation is charged even when model ceiling is reached");assert.equal(calls,3);
});

test("changing a confirmed project root ceiling retains its full understanding and charges but requires exact human reconfirmation",async t=>{
  const {directory,kernel}=await fixture();t.after(async()=>{await kernel.close();await rm(directory,{recursive:true,force:true});});let calls=0;
  let task=await kernel.createTask({...input("project-budget-reconfirm"),rootScopeKey:"synthetic-project-root-scope"},access);
  await kernel.run(task.id,"start",command(task,"budget-first-turn"),{runtimeFingerprint:"one-project-runtime",reasoner:async prompt=>{calls++;return reply(prompt);}},access);
  task=await settled(kernel,task.id);task=ProjectUnderstandingTaskSchema.parse(await kernel.confirmProject(task.id,task.revision,task.project.summaryHash!,access));
  const confirmed=structuredClone(task),understanding=structuredClone(task.project.understanding),messages=structuredClone(task.project.messages),hash=task.project.summaryHash!;
  task=ProjectUnderstandingTaskSchema.parse(await kernel.budget(task.id,task.revision,{...task.budget,maxModelCalls:9},access));
  assert.equal(task.status,"awaiting_review");assert.equal(task.project.phase,"awaiting-confirmation");assert.equal(task.project.confirmation,undefined);
  assert.deepEqual(task.project.understanding,understanding);assert.deepEqual(task.project.messages,messages);assert.equal(task.project.summaryHash,hash);assert.equal(task.rootLedger!.usage.modelCalls,1);assert.equal(calls,1);
  await assert.rejects(kernel.confirmProject(task.id,confirmed.revision,hash,access),/task_revision_conflict/);
  task=ProjectUnderstandingTaskSchema.parse(await kernel.confirmProject(task.id,task.revision,hash,access));assert.equal(task.status,"completed");assert.equal(task.project.confirmation!.revision,task.revision);assert.equal(task.rootLedger!.usage.modelCalls,1);assert.equal(calls,1,"metadata changes and manual reconfirmation never dispatch a model");
});

test("Top-K project passages keep exact UTF-16/CRLF coordinates and manifest pages, not unmounted claim authority",async t=>{
  const {directory,kernel}=await fixture();t.after(async()=>{await kernel.close();await rm(directory,{recursive:true,force:true});});
  const text=Array.from({length:40},(_,index)=>`// section ${index} ${index===39?"任务回执":"other"} 😀\r\n${"code ".repeat(100)}\r\n\r\n`).join("");
  const file=path.join(directory,"Large.cs");await writeFile(file,text);let task=await kernel.createTask(input("project-top-k-task"),access);task=ProjectUnderstandingTaskSchema.parse(await kernel.grantProject(task.id,task.revision,file,access));let calls=0,expectedPage="";
  const runtime:CareerTaskRuntime={runtimeFingerprint:"one-project-runtime",reasoner:async(prompt)=>{calls++;const ctx=context(prompt);
    if(calls===1)return JSON.stringify({kind:"read",requests:[{grantId:task.project.grants[0]!.id,operation:"read",path:"Large.cs"}]});
    if(calls===2){assert.equal(ctx.context.evidence.length,6);assert.ok(ctx.retrieval.totalPassages>6);for(const e of ctx.context.evidence)assert.equal(e.excerpt,text.slice(e.startOffset,e.endOffset));const full=ctx.evidenceManifest.find((e:{startOffset:number;endOffset:number})=>e.startOffset===0&&e.endOffset===text.length);assert.ok(full);const fullId=ctx.recentToolResults.find((item:{operation?:string})=>item.operation==="read").evidenceIds[0];assert.ok(fullId);assert.ok(!ctx.citableEvidenceIds.includes(fullId));return reply(prompt,true,fullId);}
    if(calls===3){assert.ok(prompt.includes("unknown_evidence"),"unmounted full records cannot substantiate a claim");const full=ctx.evidenceManifest.find((e:{startOffset:number;endOffset:number})=>e.startOffset===0&&e.endOffset===text.length);expectedPage=text.slice(6000,6123);return JSON.stringify({kind:"read",requests:[{grantId:"evidence",operation:"read_evidence",path:full.handle,offset:6000,length:123}]});}
    const page=ctx.context.evidence.find((e:{startOffset:number;endOffset:number})=>e.startOffset===6000&&e.endOffset===6123);assert.equal(page?.excerpt,expectedPage);assert.ok(ctx.retrieval.requestedPageEvidenceIds.includes(page.id));return reply(prompt,true,page.id);
  }};
  await kernel.run(task.id,"start",command(task,"top-k-first-turn"),runtime,access);task=await settled(kernel,task.id);assert.equal(task.status,"awaiting_review",task.error);assert.equal(calls,4);assert.ok(task.project.evidence.some(item=>item.excerpt===text));assert.ok(task.project.evidence.some(item=>item.excerpt===expectedPage));
  const raw=JSON.parse(await readFile(path.join(directory,"tasks",`${task.id}.json`),"utf8"));assert.ok(raw.recent.some((item:{output?:string})=>item.output?.includes("read_evidence")));
});

test("revocation retains the private full audit but excludes revoked excerpts and derived prose from later model input",async t=>{
  const {directory,kernel}=await fixture();t.after(async()=>{await kernel.close();await rm(directory,{recursive:true,force:true});});
  const marker="UNIQUE_REVOKED_SOURCE_FRAGMENT",file=path.join(directory,"Scope.cs");await writeFile(file,`class ${marker} {}`);let task=await kernel.createTask(input("project-revoke-task"),access);task=ProjectUnderstandingTaskSchema.parse(await kernel.grantProject(task.id,task.revision,file,access));const grant=task.project.grants[0]!.id;let calls=0;
  const runtime:CareerTaskRuntime={runtimeFingerprint:"one-project-runtime",reasoner:async(prompt)=>{calls++;if(calls===1)return JSON.stringify({kind:"read",requests:[{grantId:grant,operation:"read",path:"Scope.cs"}]});if(calls===2){const result=JSON.parse(reply(prompt));result.message=marker;return JSON.stringify(result);}assert.ok(!prompt.includes(marker));assert.ok(prompt.includes("本人纠正：仅接口排查"));return reply(prompt);}};
  await kernel.run(task.id,"start",command(task,"revoke-first-turn"),runtime,access);task=await settled(kernel,task.id);assert.equal(task.status,"awaiting_review",task.error);task=ProjectUnderstandingTaskSchema.parse(await kernel.revokeProjectGrant(task.id,task.revision,grant,access));assert.equal(task.project.understanding,undefined);assert.ok(task.project.evidence.some(item=>item.excerpt.includes(marker)));assert.ok(task.project.messages.some(message=>message.text===marker));
  await kernel.run(task.id,"start",command(task,"revoke-second-turn","本人纠正：仅接口排查"),runtime,access);task=await settled(kernel,task.id);assert.equal(task.status,"awaiting_review",task.error);assert.equal(task.usage.modelCalls,3);
});

test("source changes before a send or confirmation pause instead of confirming stale implementation",async t=>{
  const {directory,kernel}=await fixture();t.after(async()=>{await kernel.close();await rm(directory,{recursive:true,force:true});});
  const file=path.join(directory,"Changed.cs");await writeFile(file,"class Before {}");let task=await kernel.createTask(input("project-changed-task"),access);task=ProjectUnderstandingTaskSchema.parse(await kernel.grantProject(task.id,task.revision,file,access));let calls=0;
  const runtime:CareerTaskRuntime={runtimeFingerprint:"one-project-runtime",reasoner:async(prompt)=>{calls++;if(calls===1)return JSON.stringify({kind:"read",requests:[{grantId:task.project.grants[0]!.id,operation:"read",path:"Changed.cs"}]});return reply(prompt);}};
  await kernel.run(task.id,"start",command(task,"changed-first-turn"),runtime,access);task=await settled(kernel,task.id);await writeFile(file,"class After {}");
  await assert.rejects(kernel.confirmProject(task.id,task.revision,task.project.summaryHash!,access),/source_changed_new_comparison_required/);task=await read(kernel,task.id);assert.equal(task.status,"paused");assert.equal(task.project.confirmation,undefined);assert.equal(task.project.understanding,undefined);const callsBefore=calls;
  await kernel.run(task.id,"resume",command(task,"changed-second-turn","重新核对"),runtime,access);task=await settled(kernel,task.id);assert.equal(task.status,"paused");assert.equal(task.error,"source_changed_new_comparison_required");assert.equal(calls,callsBefore,"no model send with stale source");
});

test("manual stop fences late output; restart and explicit source update retain history and charges without replay",async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-project-restart-"));let kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory});const entered=Promise.withResolvers<void>(),done=Promise.withResolvers<string>();t.after(async()=>{done.resolve("{}");await kernel.close();await rm(directory,{recursive:true,force:true});});let task=await kernel.createTask(input("project-restart-task"),access),calls=0;
  const runtime:CareerTaskRuntime={runtimeFingerprint:"one-project-runtime",reasoner:async()=>{calls++;entered.resolve();return done.promise;}};
  await kernel.run(task.id,"start",command(task,"restart-first-turn"),runtime,access);await entered.promise;task=await read(kernel,task.id);task=ProjectUnderstandingTaskSchema.parse(await kernel.cancelProject(task.id,task.project.turnCount,access));done.resolve("late-full-output");await delay(20);task=await read(kernel,task.id);assert.equal(task.status,"paused");assert.equal(task.project.understanding,undefined);
  await kernel.close();kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory});task=await read(kernel,task.id);assert.equal(calls,1);assert.equal(task.usage.modelCalls,1);
  const previousFingerprint=task.sourceFingerprint;task=ProjectUnderstandingTaskSchema.parse(await kernel.updateProjectSource(task.id,task.revision,"本人更正后的完整原文。",access));assert.equal(task.status,"ready");assert.notEqual(task.sourceFingerprint,previousFingerprint);assert.equal(task.usage.modelCalls,1);assert.ok(task.project.messages.some(message=>message.text==="参与任务回执接口。"));
  const other=new AgentTaskKernel({ownerId:"another-owner",directory:path.join(directory,"other")});await assert.rejects(other.createTask({...input("cross-owner-child"),parentTaskId:task.id},access),/task_not_found/);await other.close();
});

test("incomplete and oversized project outputs stay complete, paused and private; reopening never retries",async t=>{
  const {directory,kernel}=await fixture();t.after(async()=>{await kernel.close();await rm(directory,{recursive:true,force:true});});let task=await kernel.createTask(input("project-incomplete-task"),access),calls=0;
  const partial="完整传输但结束标记为 length 的部分 JSON😀";await kernel.run(task.id,"start",command(task,"incomplete-first-turn"),{runtimeFingerprint:"one-project-runtime",reasoner:async()=>{calls++;return {text:partial,finishReason:"length"};}},access);task=await settled(kernel,task.id);assert.equal(task.status,"paused");assert.equal(task.partialOutput?.text,partial);assert.equal(task.project.understanding,undefined);assert.equal(calls,1);
  const overflow="完整超额输出😀".repeat(25000);let second=await kernel.createTask(input("project-overflow-task"),access);await kernel.run(second.id,"start",command(second,"overflow-first-turn"),{runtimeFingerprint:"one-project-runtime",reasoner:async()=>{calls++;return overflow;}},access);second=await settled(kernel,second.id);assert.equal(second.error,"decision_output_budget");assert.equal(second.project.understanding,undefined);assert.equal(second.outputArtifacts?.length,1);assert.equal((await kernel.readOutput(second.id,second.outputArtifacts![0]!.id)).text,overflow);assert.equal((await read(kernel,second.id)).usage.modelCalls,1);assert.equal(calls,2);
});

test("refinement consumes confirmed kernel context only while its exact revision and source authority stay valid",async t=>{
  const {directory,kernel}=await fixture(),entered=Promise.withResolvers<void>(),done=Promise.withResolvers<string>();t.after(async()=>{done.resolve("{}");await kernel.close();await rm(directory,{recursive:true,force:true});});
  let project=await kernel.createTask(input("project-refinement-context"),access);const runtime:CareerTaskRuntime={runtimeFingerprint:"one-project-runtime",reasoner:async prompt=>reply(prompt)};
  await kernel.run(project.id,"start",command(project,"context-first-turn"),runtime,access);project=await settled(kernel,project.id);project=ProjectUnderstandingTaskSchema.parse(await kernel.confirmProject(project.id,project.revision,project.project.summaryHash!,access));
  const context={sessionId:project.id,revision:project.revision,summaryHash:project.project.summaryHash!,understanding:project.project.understanding!},source={targetRef:{kind:"profile_headline" as const,locale:"zh" as const},text:"参与任务回执接口。",label:"合成原文"};
  let refine=await kernel.createTask({kind:"experience_refine",parentTaskId:project.id,workspaceKey:"synthetic-refine-child",objective:"只核对本人动作",refinement:{source,projectContext:context},conversation:{messages:[{id:"supp-1",role:"user",content:""}]},runtimeBinding:binding,consent:true,supplementConfirmed:true,idempotencyKey:"project-refine-child"},access);
  const raw=JSON.stringify({questions:["本人做了哪一步？"],rationale:"缺事实先问。",evidenceQuotes:[]});
  await kernel.run(refine.id,"start",{expectedRevision:refine.revision,sourceFingerprint:refine.sourceFingerprint,runtimeBinding:binding,consent:true},{runtimeFingerprint:"one-project-runtime",reasoner:async()=>{entered.resolve();return done.promise;}},access);await entered.promise;
  await kernel.updateProjectSource(project.id,project.revision,"本人明确更正了项目原文。",access);done.resolve(raw);
  for(let i=0;i<200;i++){const task=await kernel.readTask(refine.id);assert.equal(task.kind,"experience_refine");if(task.kind==="experience_refine")refine=task;if(refine.status!=="running")break;await delay(5);}
  assert.equal(refine.status,"paused");assert.equal(refine.error,"project_context_changed");assert.equal(refine.refinementReply,undefined);assert.equal(refine.usage.modelCalls,1);assert.equal(refine.rootLedger!.usage.modelCalls,2);
  const stored=JSON.parse(await readFile(path.join(directory,"tasks",`${refine.id}.json`),"utf8"));assert.ok(stored.recent.some((item:{output?:string})=>item.output===raw),"late authority rejection never discards the complete transport output");
});
