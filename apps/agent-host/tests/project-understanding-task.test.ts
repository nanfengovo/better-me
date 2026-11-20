import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import {mkdir,mkdtemp,rm,writeFile,readFile} from "node:fs/promises";
import {setTimeout as delay} from "node:timers/promises";
import {careerRuntimeBinding,ProjectUnderstandingTaskSchema,type ProjectUnderstandingTask,type ProjectUnderstandingTaskCreate} from "@better-me/agent-contracts";
import { careerTaskProtocol } from "../src/kernel/model-protocol.js";
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

test("warehouse project retrieves citable history, keeps inferences and unknowns distinct, and retires replaced sources across restart", async t => {
  const golden: { id: string; query: string; sources: { id: string; text: string }[]; expectedFacts: { sourceId: string; quote: string }[]; expectedInterpretation: string; expectedProductionBenefit: string } =
    JSON.parse(await readFile(new URL("../../../evals/resume-quality/gold/warehouse-replay-v1.json", import.meta.url), "utf8"));
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-warehouse-memory-"));
  const options = { ownerId: "synthetic-warehouse-owner", directory: path.join(directory, "tasks") };
  const materials = path.join(directory, "notes");
  await mkdir(materials);
  for (const source of golden.sources) await writeFile(path.join(materials, source.id + ".md"), "历史项目材料\n" + source.text);
  let kernel = new AgentTaskKernel(options);
  t.after(async () => { await kernel.close(); await rm(directory, { recursive: true, force: true }); });
  const priorText = "仓储早期草稿：将投产写进了本人职责。";
  const correctedText = "我只核对了仓储联调记录，未提供上线收益。";
  const independentAnswer = "我保留了联调用例的编号。";
  const base = input("warehouse-knowledge-fixture");
  let task = await kernel.createTask({ ...base, objective: golden.query,
    project: { projectKey: "warehouse", label: "仓储项目", sourceText: priorText },
    budget: { maxModelCalls: 8, maxToolCalls: 40, maxActiveMs: 60000 } }, access);
  task = ProjectUnderstandingTaskSchema.parse(await kernel.grantProject(task.id, task.revision, materials, access));
  const initialMessageId = task.project.messages[0]!.id;
  const initialRevision = task.revision;
  const receipts: { paths: string[]; ids: string[] }[] = [];
  type Excerpt = ProjectUnderstandingTask["project"]["evidence"][number];
  const reviewed = (prompt: string) => {
    const ctx = context(prompt);
    const facts = golden.expectedFacts.map(expected => {
      const file = expected.sourceId + ".md";
      const source: Excerpt | undefined = ctx.context.evidence.find((item: Excerpt) => item.path === file && item.excerpt === expected.quote);
      assert.ok(source, file); assert.ok(ctx.citableEvidenceIds.includes(source.id));
      assert.equal(source.startLine, 2); assert.equal(source.endLine, 2);
      assert.equal(source.excerpt, ("历史项目材料\n" + expected.quote).slice(source.startOffset, source.endOffset));
      return { id: expected.sourceId, text: "材料记录：" + source.excerpt, kind: "documentation", evidenceIds: [source.id] };
    });
    receipts.push({ paths: facts.map(fact => fact.id), ids: facts.map(fact => fact.evidenceIds[0]!) });
    return { kind: "reply", message: "请核对仓储项目资料。", readyForConfirmation: true,
      understanding: { summary: "材料记录了去重和 Redis 回放。", terms: [], boundaries: ["联调记录的适用范围是测试环境。"],
        claims: [...facts, { id: "interpretation", kind: "inference", text: "按编号去重可能避免重复处理。", evidenceIds: [facts[0]!.evidenceIds[0]!] },
          { id: "production", kind: "unknown", text: "上线收益未知。", evidenceIds: [] }], unknowns: ["上线收益"] } };
  };
  let calls = 0;
  const runtime: CareerTaskRuntime = { runtimeFingerprint: "synthetic-warehouse-runtime", reasoner: async prompt => {
    if (++calls === 1) return JSON.stringify({ kind: "read", requests: golden.sources.map(source => ({
      grantId: task.project.grants[0]!.id, operation: "read", path: source.id + ".md", startLine: 2, endLine: 2 })) });
    return JSON.stringify(reviewed(prompt));
  } };
  await kernel.run(task.id, "start", command(task, "warehouse-first-turn", independentAnswer), runtime, access);
  task = await settled(kernel, task.id);
  assert.equal(task.status, "awaiting_review", task.error);
  assert.deepEqual(task.project.understanding!.claims.map(claim => claim.kind), ["documentation", "documentation", golden.expectedInterpretation, golden.expectedProductionBenefit]);
  task = ProjectUnderstandingTaskSchema.parse(await kernel.confirmProject(task.id, task.revision, task.project.summaryHash!, access));
  const confirmed = task.project.confirmation!;
  await kernel.close(); kernel = new AgentTaskKernel(options);
  task = await read(kernel, task.id);
  assert.deepEqual(task.project.confirmation, confirmed);
  const other = new AgentTaskKernel({ ownerId: "synthetic-other", directory: path.join(directory, "other") });
  try { await assert.rejects(other.readTask(task.id), /task_not_found/); } finally { await other.close(); }
  await assert.rejects(kernel.updateProjectSource(task.id, initialRevision, correctedText, access), /task_revision_conflict/);
  task = ProjectUnderstandingTaskSchema.parse(await kernel.updateProjectSource(task.id, task.revision, correctedText, access));
  assert.equal(task.project.confirmation, undefined);
  assert.equal(task.project.messages.at(-1)?.supersedesSourceId, initialMessageId);
  assert.equal(task.project.messages[0]?.text, priorText);
  await kernel.close(); kernel = new AgentTaskKernel(options);
  let correctionCalls = 0;
  await kernel.run(task.id, "start", command(task, "warehouse-corrected-turn"), { ...runtime, reasoner: async prompt => {
    correctionCalls++;
    const ctx = context(prompt);
    assert.ok(!ctx.context.messages.some((message: { id: string }) => message.id === initialMessageId));
    assert.ok(!prompt.includes(priorText)); assert.ok(prompt.includes(correctedText)); assert.ok(prompt.includes(independentAnswer));
    const reply = reviewed(prompt);
    if (correctionCalls === 1) reply.understanding.claims.push({ id: "stale", kind: "user", text: "引用旧版个人表述", evidenceIds: [initialMessageId] });
    return JSON.stringify(reply);
  } }, access);
  task = await settled(kernel, task.id);
  assert.equal(task.status, "awaiting_review", task.error);
  assert.equal(correctionCalls, 2);
  assert.ok(task.events.some(event => event.detail.includes("unknown_evidence")));
  assert.deepEqual(receipts.at(0), receipts.at(-1), "unchanged source citations survive a correction and restart");
  t.diagnostic(JSON.stringify({
    golden: golden.id, model: "scripted", taskKind: task.kind, query: golden.query,
    claims: task.project.understanding!.claims.map(claim => ({
      text: claim.text, kind: claim.kind, sources: claim.evidenceIds.map(id => {
        const evidence = task.project.evidence.find(item => item.id === id)!;
        return { path: evidence.path, sha256: evidence.hash, lines: [evidence.startLine, evidence.endLine], quote: evidence.excerpt };
      }),
    })),
    correction: { supersedes: task.project.messages.find(message => message.supersedesSourceId)?.supersedesSourceId,
      rejectedOldReference: task.events.some(event => event.detail.includes("unknown_evidence")), attempts: correctionCalls, confirmation: task.project.phase },
  }));
});

test("a repeated read of the same evidence switches the project model to the reply schema and fences further tool reads", async t => {
  const { directory, kernel } = await fixture();
  t.after(async () => { await kernel.close(); await rm(directory, { recursive: true, force: true }); });
  let task = await kernel.createTask(input("project-read-progress"), access);
  const file = path.join(directory, "history.md");
  await writeFile(file, "仓储项目联调记录。");
  task = ProjectUnderstandingTaskSchema.parse(await kernel.grantProject(task.id, task.revision, file, access));
  const readRequest = JSON.stringify({ kind: "read", requests: [{ grantId: task.project.grants[0]!.id, operation: "read", path: "history.md" }] });
  let calls = 0;
  const runtime: CareerTaskRuntime = { runtimeFingerprint: "project-repeat-fixture", reasoner: async (prompt, _signal, phase, _images, _source, mode) => {
    const schema = careerTaskProtocol(phase, undefined, mode).schema;
    calls++;
    if (calls <= 2) {
      assert.ok(schema.safeParse(JSON.parse(readRequest)).success);
      const page = {kind:"read",requests:[{grantId:"evidence",operation:"read_evidence",path:"ref_synthetic",offset:0,length:20}]};
      assert.equal(schema.safeParse(page).success,calls===2,"paging becomes available only after material has a manifest");
      return readRequest;
    }
    assert.ok(prompt.includes("SYNTHESIS_ONLY"));
    assert.ok(!prompt.includes("stable-id"),"the final reply does not receive an example claim to copy");
    assert.equal(schema.safeParse(JSON.parse(readRequest)).success, false);
    const inventedCitation = JSON.parse(reply(prompt));
    inventedCitation.understanding.claims[0].evidenceIds = ["ev_unmounted"];
    assert.equal(schema.safeParse(inventedCitation).success, false);
    assert.ok(schema.safeParse(JSON.parse(reply(prompt))).success);
    if (calls === 3) return readRequest;
    return reply(prompt);
  } };
  await kernel.run(task.id, "start", command(task, "project-repeat-turn"), runtime, access);
  task = await settled(kernel, task.id);
  assert.equal(task.status, "awaiting_review", task.error);
  assert.equal(calls, 4);
  assert.ok(task.events.some(event => event.detail.includes("project_synthesis_required")));
  assert.equal(task.events.filter(event => event.kind === "tool_result" && event.detail.startsWith("project read:")).length, 2);
});

test("the final reserved model call can report unknowns without spending tools on unreadable future results", async t => {
  const { directory, kernel } = await fixture();
  t.after(async () => { await kernel.close(); await rm(directory, { recursive: true, force: true }); });
  const base = input("project-last-call");
  let task = await kernel.createTask({ ...base, budget: { maxModelCalls: 1, maxToolCalls: 8, maxActiveMs: 60_000 } }, access);
  await kernel.run(task.id, "start", command(task, "last-project-turn"), { runtimeFingerprint: "synthetic-one-call", reasoner: async (prompt, _signal, phase, _images, _source, mode) => {
    assert.ok(prompt.includes("SYNTHESIS_ONLY"));
    assert.equal(careerTaskProtocol(phase, undefined, mode).name, "agent_project_understanding_reply");
    return reply(prompt);
  } }, access);
  task = await settled(kernel, task.id);
  assert.equal(task.status, "awaiting_review", task.error);
  assert.equal(task.usage.toolCalls, 0);
  assert.deepEqual(task.project.understanding?.unknowns, ["上线情况未确认"]);
});

test("explicit quotation review visits remaining files, keeps confirmed history and adopts only verified source spans", async t => {
  const {directory,kernel}=await fixture();
  t.after(async()=>{await kernel.close();await rm(directory,{recursive:true,force:true});});
  const notes=path.join(directory,"notes"); await mkdir(notes);
  await writeFile(path.join(notes,"one.md"),"项目说明\r\n仅在联调环境验证。\r\n");
  await writeFile(path.join(notes,"two.md"),"测试说明\n使用本机记录回放。\n");
  let task=await kernel.createTask({...input("quote-existing-history"),budget:{maxModelCalls:9,maxToolCalls:40,maxActiveMs:60000}},access);
  task=ProjectUnderstandingTaskSchema.parse(await kernel.grantProject(task.id,task.revision,notes,access));
  const fingerprint="quote-history-model";
  await kernel.run(task.id,"start",command(task,"old-project-turn"),{runtimeFingerprint:fingerprint,reasoner:async prompt=>reply(prompt)},access);
  task=await settled(kernel,task.id);
  task=ProjectUnderstandingTaskSchema.parse(await kernel.confirmProject(task.id,task.revision,task.project.summaryHash!,access));
  const old=structuredClone(task.project.understanding!);
  let calls=0;
  const runtime:CareerTaskRuntime={runtimeFingerprint:fingerprint,reasoner:async(prompt,_signal,_phase,_images,_source,mode)=>{
    calls++;
    if(calls<=2){
      assert.equal(mode?.mode,"project_quote_sources");
      const pending=mode!.files as string[];
      assert.deepEqual(pending,calls===1?["one.md","two.md"]:["two.md"]);
      return JSON.stringify({kind:"read",requests:[{operation:"read",path:pending[0],grantId:task.project.grants[0]!.id}]});
    }
    assert.equal(mode?.mode,"project_quote_review");
    const {material}=JSON.parse(prompt.split("\n\n").at(-1)!);
    const selected=material.filter((row:{line:number})=>row.line===2).map((row:{id:string})=>row.id);
    assert.equal(selected.length,2);
    return JSON.stringify({kind:"quote_review",facts:selected,inferences:[{text:calls===3?"能否复用记录？":"这种方法可能用于复用已有的测试记录。",basis:[selected[0]]}],unknowns:["是否已投产？"]});
  }};
  await kernel.run(task.id,"resume",command(task,"read-historical-notes","请逐字引用 one.md、two.md 的联调和回放记录。"),runtime,access);
  task=await settled(kernel,task.id);
  assert.equal(task.status,"awaiting_review",task.error);
  assert.equal(calls,4);
  assert.equal(task.project.confirmation,undefined);
  assert.equal(task.project.understanding!.summary,old.summary);
  assert.ok(task.project.understanding!.claims.some(claim=>claim.id===old.claims[0]!.id&&claim.text===old.claims[0]!.text));
  const quoted=task.project.understanding!.claims.filter(claim=>claim.kind==="documentation");
  assert.deepEqual(new Set(quoted.map(claim=>claim.text)),new Set(["仅在联调环境验证。","使用本机记录回放。"]));
  for(const claim of quoted){
    const evidence=task.project.evidence.find(item=>item.id===claim.evidenceIds[0])!;
    assert.equal(evidence.excerpt,claim.text); assert.equal(evidence.startLine,2);
  }
  assert.ok(task.project.understanding!.claims.some(claim=>claim.kind==="unknown"&&claim.text.includes("无法确认")));
  assert.ok(task.events.some(event=>event.detail.includes("project_quote_inference_requires_statement")));
});

for (const change of ["replace","revoke"] as const) test(`quote selections lose authority if the cited source changes during dispatch (${change})`, async t=>{
  const {directory,kernel}=await fixture();
  const release=Promise.withResolvers<void>(), entered=Promise.withResolvers<void>();
  t.after(async()=>{release.resolve();await kernel.close();await rm(directory,{recursive:true,force:true});});
  const file=path.join(directory,"audit.md"); await writeFile(file,"仅在联调环境复测。");
  let task=await kernel.createTask(input("quote-lease-"+change),access);
  task=ProjectUnderstandingTaskSchema.parse(await kernel.grantProject(task.id,task.revision,file,access));
  const runtime:CareerTaskRuntime={runtimeFingerprint:"quote-race",reasoner:async(prompt,_signal,_phase,_images,_source,mode)=>{
    if(mode?.mode==="project_quote_sources")return JSON.stringify({kind:"read",requests:[{operation:"read",path:"audit.md",grantId:task.project.grants[0]!.id}]});
    const {material}=JSON.parse(prompt.split("\n\n").at(-1)!);
    entered.resolve(); await release.promise;
    return JSON.stringify({kind:"quote_review",facts:[material[0].id],inferences:[],unknowns:[]});
  }};
  await kernel.run(task.id,"start",command(task,"quote-race-turn","请逐字引用 audit.md 的记录。"),runtime,access);
  await entered.promise;
  task=await read(kernel,task.id);
  if(change==="replace")await writeFile(file,"来源发生变化。");
  else await kernel.revokeProjectGrant(task.id,task.revision,task.project.grants[0]!.id,access);
  release.resolve();
  task=await settled(kernel,task.id);
  assert.equal(task.project.understanding,undefined);
  if(change==="replace") {
    assert.equal(task.status,"paused"); assert.equal(task.error,"source_changed_new_comparison_required");
    const state=JSON.parse(await readFile(path.join(directory,"tasks",task.id+".json"),"utf8"));
    assert.ok(state.recent.some((row:{kind?:string;check?:string;result?:{error?:{code:string}}})=>row.kind==="project_verification_result"&&row.check==="selected_quote"&&row.result?.error?.code==="source_changed_new_comparison_required"));
  }
  else assert.ok(task.project.grants[0]!.revokedAt);
});

test("quote review can cite every explicitly requested file beyond the general retrieval limit", async t=>{
  const {directory,kernel}=await fixture();
  t.after(async()=>{await kernel.close();await rm(directory,{recursive:true,force:true});});
  const notes=path.join(directory,"notes");await mkdir(notes);
  const names=Array.from({length:8},(_,index)=>`note-${index+1}.md`);
  const texts=names.map((_,index)=>`合成测试记录编号 ${index+1} 已核对。`);
  await Promise.all(names.map((name,index)=>writeFile(path.join(notes,name),texts[index]!)));
  let task=await kernel.createTask({...input("quote-eight-files"),budget:{maxModelCalls:4,maxToolCalls:40,maxActiveMs:60000}},access);
  task=ProjectUnderstandingTaskSchema.parse(await kernel.grantProject(task.id,task.revision,notes,access));
  const grantId=task.project.grants[0]!.id;
  const runtime:CareerTaskRuntime={runtimeFingerprint:"eight-files-model",reasoner:async(prompt,_signal,_phase,_images,_source,mode)=>{
    if(mode?.mode==="project_quote_sources")return JSON.stringify({kind:"read",requests:names.map(path=>({operation:"read",path,grantId}))});
    assert.equal(mode?.mode,"project_quote_review");
    const {material,unavailable}=JSON.parse(prompt.split("\n\n").at(-1)!);
    assert.deepEqual(unavailable,[]);
    assert.deepEqual(new Set(material.map((row:{file:string})=>row.file)),new Set(names));
    return JSON.stringify({kind:"quote_review",facts:material.map((row:{id:string})=>row.id),inferences:[],unknowns:[]});
  }};
  await kernel.run(task.id,"start",command(task,"eight-quote-turn",`请逐字引用 ${names.join("、")} 的每份测试记录。`),runtime,access);
  task=await settled(kernel,task.id);
  assert.equal(task.status,"awaiting_review",task.error);
  const claims=task.project.understanding!.claims;
  assert.deepEqual(new Set(claims.map(claim=>claim.text)),new Set(texts));
  for(const claim of claims){
    const cite=task.project.evidence.find(item=>item.id===claim.evidenceIds[0]);
    assert.ok(cite&&cite.excerpt===claim.text&&cite.grantId===grantId&&names.includes(cite.path));
  }
  task=ProjectUnderstandingTaskSchema.parse(await kernel.confirmProject(task.id,task.revision,task.project.summaryHash!,access));
  assert.equal(task.status,"completed");
  const saved=JSON.parse(await readFile(path.join(directory,"tasks",task.id+".json"),"utf8"));
  const outcomes=saved.recent.filter((row:{call?:number;result?:unknown})=>row.call!==undefined&&row.result!==undefined);
  assert.deepEqual(outcomes.map((row:{call:number})=>row.call),Array.from({length:task.usage.toolCalls},(_,index)=>index+1));
  assert.equal(task.usage.toolCalls,32);
  assert.equal(outcomes.filter((row:{check?:string})=>row.check==="human_confirmation").length,8);
  assert.ok(outcomes.every((row:{result:{error?:unknown}})=>!row.result.error));
});

test("two projects with the same label and filename keep their grants and citations independent across restart", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-project-label-isolation-"));
  const options = { ownerId: "synthetic-owner", directory: path.join(directory, "tasks") };
  let kernel = new AgentTaskKernel(options);
  t.after(async () => { await kernel.close(); await rm(directory, { recursive: true, force: true }); });

  const sameLabel = "合成协调项目";
  const files = ["alpha", "beta"].map(name => path.join(directory, name, "Task.cs"));
  const texts = ["class Task { void ReceiptAlpha() {} }\n", "class Task { void ReceiptBeta() {} }\n"];
  for (const [index, file] of files.entries()) {
    await mkdir(path.dirname(file));
    await writeFile(file, texts[index]!);
  }
  const create = async (index: number) => {
    const projectKey = `independent-project-${index}`;
    const task = await kernel.createTask({ ...input(projectKey), project: { projectKey, label: sameLabel, sourceText: "参与任务回执接口。" } }, access);
    return ProjectUnderstandingTaskSchema.parse(await kernel.grantProject(task.id, task.revision, files[index]!, access));
  };
  const readRequest = (grantId: string) => JSON.stringify({ kind: "read", requests: [{ grantId, operation: "read", path: "Task.cs" }] });
  let first = await create(0), second = await create(1);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.sourceFingerprint, second.sourceFingerprint);
  let calls = 0;
  await kernel.run(first.id, "start", command(first, "same-label-first"), {
    runtimeFingerprint: "same-label-isolation",
    reasoner: async prompt => {
      if (++calls === 1) return readRequest(first.project.grants[0]!.id);
      const item = context(prompt).context.evidence[0];
      assert.equal(item.excerpt, texts[0]);
      assert.ok(!prompt.includes(texts[1]!));
      return reply(prompt, true, item.id);
    },
  }, access);
  first = await settled(kernel, first.id);
  assert.equal(first.status, "awaiting_review", first.error);
  first = ProjectUnderstandingTaskSchema.parse(await kernel.confirmProject(first.id, first.revision, first.project.summaryHash!, access));
  const foreignGrant = first.project.grants[0]!.id, foreignEvidence = first.project.evidence[0]!.id;

  calls = 0;
  await kernel.run(second.id, "start", command(second, "same-label-second"), {
    runtimeFingerprint: "same-label-isolation",
    reasoner: async prompt => {
      assert.ok(!prompt.includes(texts[0]!));
      switch (++calls) {
        case 1: return readRequest(foreignGrant);
        case 2:
          assert.ok(prompt.includes("grant_unavailable"));
          return readRequest(second.project.grants[0]!.id);
        case 3: return reply(prompt, true, foreignEvidence);
        default: {
          const ctx = context(prompt);
          assert.ok(!ctx.citableEvidenceIds.includes(foreignEvidence));
          assert.ok(prompt.includes("unknown_evidence"));
          const item = ctx.context.evidence[0];
          assert.equal(item.excerpt, texts[1]);
          return reply(prompt, true, item.id);
        }
      }
    },
  }, access);
  second = await settled(kernel, second.id);
  assert.equal(second.status, "awaiting_review", second.error);
  assert.equal(calls, 4);
  second = ProjectUnderstandingTaskSchema.parse(await kernel.confirmProject(second.id, second.revision, second.project.summaryHash!, access));
  await kernel.close();
  kernel = new AgentTaskKernel(options);
  for (const [index, task] of [first, second].entries()) {
    const saved = await read(kernel, task.id);
    assert.equal(saved.status, "completed");
    assert.equal(saved.project.label, sameLabel);
    assert.deepEqual(saved.project.evidence.map(item => item.excerpt), [texts[index]]);
    assert.deepEqual(saved.project.understanding!.claims[0]!.evidenceIds, [saved.project.evidence[0]!.id]);
    assert.equal(saved.project.summaryHash, task.project.summaryHash);
  }
});
