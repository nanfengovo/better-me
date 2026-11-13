import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp,rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { careerRuntimeBinding,JdMatchTaskCreateSchema,type JdMatchTask,type JdMatchTaskCreate } from "@better-me/agent-contracts";
import { AgentTaskKernel,type CareerTaskRuntime } from "../src/kernel/service.js";
import { readPrivateJson } from "../src/identity/private-json.js";

const access={session:"synthetic-jd",valid:async()=>true},binding=careerRuntimeBinding({kind:"native",runtimeId:"codex"});
const input=(key="synthetic-jd-match-1"):JdMatchTaskCreate=>({kind:"jd_match",workspaceKey:"synthetic-jd",rootScopeKey:"synthetic-career",objective:"逐条核对，不编造。",runtimeBinding:binding,consent:true,idempotencyKey:key,
  matching:{rawJd:"岗位职责\n维护 C# 导入工具。\n任职要求\n了解异常重试。",allowedProfileEntryIds:["claim-1"],sessionClaims:{"claim-1":"维护 C# 导入工具，验证异常重试。"}}});
const command=(task:JdMatchTask)=>({expectedRevision:task.revision,sourceFingerprint:task.sourceFingerprint,runtimeBinding:task.runtimeBinding,consent:true as const});
async function read(kernel:AgentTaskKernel,id:string){const task=await kernel.readTask(id);assert.equal(task.kind,"jd_match");return task as JdMatchTask;}
async function settled(kernel:AgentTaskKernel,id:string){for(let i=0;i<300;i++){const task=await read(kernel,id);if(task.status!=="running")return task;await delay(5);}throw Error("JD task did not settle");}
type Context={requiredItems:string[];evidence:Array<{id:string;sourceId:string;excerpt:string;startOffset:number;endOffset:number;sourceLength:number}>;evidenceManifest:Array<{handle:string;sourceId:string}>;observations:unknown[]};
const context=(prompt:string)=>JSON.parse(prompt.split("\n\n").at(-1)!) as Context;
const match=(state:Context)=>JSON.stringify({kind:"match",proposals:state.requiredItems.map(jdItem=>({jdItem,evidenceType:"claimed",suggestion:"维护 C# 导入工具，验证异常重试。",rationale:"仅使用已共享的自述，仍需本人核对。",evidenceIds:[state.evidence.find(item=>item.excerpt.includes("验证异常重试"))!.id]}))});
async function fixture(t:test.TestContext){
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-jd-task-")),kernel=new AgentTaskKernel({ownerId:"synthetic-jd-owner",directory});
  t.after(async()=>{await kernel.close();await rm(directory,{recursive:true,force:true});});return {directory,kernel};
}

test("jd_match freezes all material, decomposes locally, never treats an allowed ID as verification, and reviews without inference",async t=>{
  const {kernel,directory}=await fixture(t),data=input(),original=structuredClone(data);let calls=0;
  let task=await kernel.createTask(data,access);assert.equal(task.kind,"jd_match");assert.equal(task.status,"ready");assert.equal(task.usage.modelCalls,0);assert.deepEqual(task.matching,data.matching);
  assert.deepEqual(task.structuredJd.responsibilities,["维护 C# 导入工具。"]);assert.deepEqual(task.structuredJd.requirements,["了解异常重试。"]);
  assert.equal((await kernel.createTask(data,access)).id,task.id);assert.deepEqual(await kernel.list(),[]);
  await assert.rejects(kernel.createTask({...data,matching:{...data.matching,rawJd:"changed"}},access),/idempotency_conflict/);
  assert.equal(JdMatchTaskCreateSchema.safeParse({...data,directories:[{path:"/not-authorized"}]}).success,false);
  await kernel.run(task.id,"start",command(task),{runtimeFingerprint:"synthetic-generation",reasoner:async(prompt,_signal,phase)=>{
    calls++;assert.equal(phase,"jd_match");assert.ok(prompt.includes("not independent verification"));return match(context(prompt));
  }},access);task=await settled(kernel,task.id);
  assert.equal(task.status,"awaiting_review",task.error);assert.equal(calls,1);assert.equal(task.usage.modelCalls,1);assert.equal(task.usage.toolCalls,0);assert.equal(task.result!.proposals.length,2);
  assert.ok(task.result!.proposals.every(item=>item.evidenceType==="claimed"));assert.equal(task.review,undefined);assert.deepEqual(data,original);
  await assert.rejects(kernel.reviewJdMatch(task.id,task.revision,{},access),/review_decisions_must_match_proposals/);
  const decisions=Object.fromEntries(task.result!.proposals.map(item=>[item.id,{status:"accepted" as const}]));
  const reviewed=await kernel.reviewJdMatch(task.id,task.revision,decisions,access);assert.equal(reviewed.status,"completed");assert.equal(calls,1);assert.ok(!("receipt" in reviewed));assert.ok(!("facts" in reviewed));
  const stored=await readPrivateJson(path.join(directory,`${task.id}.json`)) as {recent:{output?:string}[]};assert.ok(stored.recent[0]!.output!.includes("验证异常重试"));
});

test("Top-K retains every source and manifest, exact UTF-16 pages are charged and become citable",async t=>{
  const {kernel}=await fixture(t),data=input("synthetic-jd-paging"),long="边界😀\r\n"+"背景材料完整保留。".repeat(900)+"维护 C# 导入工具，验证异常重试。TAIL-END";
  data.matching.sessionClaims=Object.fromEntries(Array.from({length:10},(_,i)=>[`claim-${i}`,i===9?long:`维护 C# 导入工具，验证异常重试。背景 ${i}`]));
  data.matching.allowedProfileEntryIds=Object.keys(data.matching.sessionClaims);let calls=0,offset=0;
  let task=await kernel.createTask(data,access);
  await kernel.run(task.id,"start",command(task),{runtimeFingerprint:"synthetic-generation",reasoner:async(prompt)=>{
    calls++;const state=context(prompt);assert.equal(state.evidenceManifest.length,10);
    if(calls===1){
      assert.ok(state.evidence.length<=6);assert.ok(!state.evidence.some(item=>item.excerpt.includes("TAIL-END")));
      offset=long.indexOf("维护 C#");return JSON.stringify({kind:"read_evidence",handle:state.evidenceManifest.find(item=>item.sourceId==="claim:claim-9")!.handle,offset,length:4000});
    }
    const page=state.evidence.find(item=>item.sourceId==="claim:claim-9"&&item.startOffset===offset)!;
    assert.equal(page.excerpt,long.slice(offset));assert.equal(page.endOffset,long.length);assert.equal(page.sourceLength,long.length);
    return JSON.stringify({kind:"match",proposals:state.requiredItems.map(jdItem=>({jdItem,evidenceType:"claimed",profileEntryId:"claim-9",suggestion:"维护 C# 导入工具，验证异常重试。",rationale:"本次精确回读的本人自述。",evidenceIds:[page.id]}))});
  }},access);task=await settled(kernel,task.id);
  assert.equal(task.status,"awaiting_review",task.error);assert.equal(calls,2);assert.equal(task.usage.toolCalls,1);assert.equal(task.matching.sessionClaims["claim-9"],long);
  assert.equal(task.evidence.find(item=>item.startOffset===offset)!.startLine,2);
});

test("explicit full reports share the JD ledger, charge missing-report repair and bind complete original claims locally",async t=>{
  const {kernel,directory}=await fixture(t),data=input("synthetic-jd-full-report");data.matching.reportRequested=true;
  let task=await kernel.createTask(data,access),calls=0;
  const report={matchScore:73,scoreSummary:"仅为所选文本的待核实参考，不是能力认证。",matchingStrengths:["当前材料有 C# 导入工具自述。"],missingGaps:["真实职责与范围仍需本人确认。"],
    tailoredSuggestions:[{claimId:"claim-1",suggestedText:"维护 C# 导入工具，验证异常重试。",reason:"不改变职责范围。"},
      {claimId:"unknown",suggestedText:"未知来源不能展示",reason:"合成反例"},
      {claimId:"claim-1",currentText:"被改动的原文",suggestedText:"错引原文不能展示",reason:"合成反例"}],
    unverifiedSuggestionCount:999,interviewDefenseTips:["请说明测试过的异常重试场景及尚未验证的边界？"]};
  await kernel.run(task.id,"start",command(task),{runtimeFingerprint:"synthetic-generation",reasoner:async prompt=>{
    calls++;assert.ok(prompt.includes("full report in the SAME match decision"));const result=JSON.parse(match(context(prompt)));
    return JSON.stringify(calls===1?result:{...result,report});
  }},access);task=await settled(kernel,task.id);
  assert.equal(task.status,"awaiting_review",task.error);assert.equal(calls,2);assert.equal(task.rootLedger!.usage.modelCalls,2);
  assert.equal(task.result!.report!.matchScore,73);assert.equal(task.result!.report!.unverifiedSuggestionCount,2);
  assert.equal(task.result!.report!.tailoredSuggestions.length,1);assert.equal(task.result!.report!.tailoredSuggestions[0]!.currentText,data.matching.sessionClaims["claim-1"]);
  const stored=await readPrivateJson(path.join(directory,`${task.id}.json`)) as {recent:{output?:string}[]};assert.ok(stored.recent.some(row=>row.output?.includes("999")),"full rejected/excluded raw output remains in private audit");
});

test("a full report cannot smuggle unbacked metrics through a valid original-claim locator",async t=>{
  const {kernel}=await fixture(t),data=input("synthetic-jd-report-number");data.matching.reportRequested=true;let calls=0,task=await kernel.createTask(data,access);
  await kernel.run(task.id,"start",command(task),{runtimeFingerprint:"synthetic-generation",reasoner:async prompt=>{
    calls++;return JSON.stringify({...JSON.parse(match(context(prompt))),report:{matchScore:73,scoreSummary:"合成待核实",matchingStrengths:[],missingGaps:[],
      tailoredSuggestions:[{claimId:"claim-1",suggestedText:calls===1?"维护 C# 导入工具，提高效率 80%。":"维护 C# 导入工具，验证异常重试。",reason:"合成候选"}],interviewDefenseTips:[]}});
  }},access);task=await settled(kernel,task.id);assert.equal(task.status,"awaiting_review",task.error);assert.equal(calls,2);assert.equal(task.rootLedger!.usage.modelCalls,2);
  assert.doesNotMatch(task.result!.report!.tailoredSuggestions[0]!.suggestedText,/80/);
});

test("coverage, citations and unbacked metrics reject complete raw outputs and charge each repair to the root",async t=>{
  const {kernel,directory}=await fixture(t),data=input("synthetic-jd-repair");data.budget={maxModelCalls:3,maxToolCalls:2,maxActiveMs:60000};let calls=0;
  let task=await kernel.createTask(data,access);const outputs:string[]=[];
  await kernel.run(task.id,"start",command(task),{runtimeFingerprint:"synthetic-generation",reasoner:async(prompt)=>{
    const state=context(prompt),valid=JSON.parse(match(state));calls++;
    if(calls===1)valid.proposals.pop();if(calls===2)valid.proposals[0].suggestion="主导上线，性能提高 80%。";
    if(calls===3){assert.ok(prompt.includes("jd_requirement_coverage_incomplete"));assert.ok(prompt.includes("jd_unsupported_personal_claim"));}
    const output=JSON.stringify(valid);outputs.push(output);return output;
  }},access);task=await settled(kernel,task.id);assert.equal(task.status,"awaiting_review",task.error);assert.equal(task.usage.modelCalls,3);assert.equal(task.rootLedger!.usage.modelCalls,3);
  const saved=await readPrivateJson(path.join(directory,`${task.id}.json`)) as {recent:{output?:string}[]};assert.deepEqual(saved.recent.filter(item=>item.output).map(item=>item.output),outputs);
  await assert.rejects(kernel.createTask({...input("synthetic-jd-budget-child"),workspaceKey:"another"},access),/model_call_budget/);
});

test("unread and fabricated profile references are rejected, no semantic keyword hit becomes verified",async t=>{
  const {kernel}=await fixture(t);let task=await kernel.createTask(input("synthetic-jd-reference"),access),calls=0;
  await kernel.run(task.id,"start",command(task),{runtimeFingerprint:"synthetic-generation",reasoner:async prompt=>{
    calls++;const state=context(prompt),value=JSON.parse(match(state));
    if(calls===1)value.proposals[0].evidenceIds=["ev_never_mounted"];
    if(calls===2)value.proposals[0].profileEntryId="ungranted";
    return JSON.stringify(value);
  }},access);task=await settled(kernel,task.id);assert.equal(task.status,"awaiting_review",task.error);assert.equal(calls,3);
});

test("shared root, pause and resume never refund usage or adopt a late JD result",async t=>{
  const {kernel}=await fixture(t),entered=Promise.withResolvers<void>(),finish=Promise.withResolvers<void>();let calls=0;
  const root=await kernel.createTask({kind:"free_chat",workspaceKey:"advisor",rootScopeKey:"synthetic-career",objective:"synthetic",runtimeBinding:binding,consent:true,idempotencyKey:"synthetic-jd-root",budget:{maxModelCalls:2,maxToolCalls:3,maxActiveMs:60000},conversation:{messages:[{id:"u1",role:"user",content:"只验证测试环境。"}]}},access);
  let task=await kernel.createTask(input("synthetic-jd-paused"),access);assert.equal(task.rootTaskId,root.id);assert.equal(task.parentTaskId,root.id);
  const runtime:CareerTaskRuntime={runtimeFingerprint:"synthetic-generation",reasoner:async prompt=>{calls++;entered.resolve();await finish.promise;return match(context(prompt));}};
  try{
    await kernel.run(task.id,"start",command(task),runtime,access);await entered.promise;
    task=await read(kernel,task.id);await kernel.stop(task.id,task.revision,false,access);finish.resolve();await delay(20);task=await read(kernel,task.id);
    assert.equal(task.status,"paused");assert.equal(task.result,undefined);assert.equal(task.rootLedger!.usage.modelCalls,1);
    await kernel.run(task.id,"resume",command(task),runtime,access);task=await settled(kernel,task.id);assert.equal(task.status,"awaiting_review",task.error);assert.equal(calls,2);assert.equal(task.rootLedger!.usage.modelCalls,2);
    await assert.rejects(kernel.createTask(input("synthetic-jd-third"),access),/model_call_budget/);
  }finally{finish.resolve();}
});

test("a JD task survives Host restart without replay or refund, then resumes only on explicit command",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-jd-restart-"));let kernel=new AgentTaskKernel({ownerId:"synthetic-jd-owner",directory});
  const entered=Promise.withResolvers<void>(),finish=Promise.withResolvers<string>();let calls=0;
  try{
    let task=await kernel.createTask(input("synthetic-jd-restart"),access);
    await kernel.run(task.id,"start",command(task),{runtimeFingerprint:"same-generation",reasoner:async()=>{calls++;entered.resolve();return finish.promise;}},access);await entered.promise;
    await kernel.close();kernel=new AgentTaskKernel({ownerId:"synthetic-jd-owner",directory});task=await read(kernel,task.id);
    assert.equal(task.status,"interrupted");assert.equal(task.usage.modelCalls,1);assert.equal(task.rootLedger!.usage.modelCalls,1);assert.equal(calls,1);
    finish.resolve(JSON.stringify({kind:"match",proposals:[]}));await delay(20);assert.equal((await read(kernel,task.id)).result,undefined);
    await kernel.run(task.id,"resume",command(task),{runtimeFingerprint:"same-generation",reasoner:async prompt=>{calls++;return match(context(prompt));}},access);task=await settled(kernel,task.id);
    assert.equal(task.status,"awaiting_review",task.error);assert.equal(task.usage.modelCalls,2);assert.equal(task.rootLedger!.usage.modelCalls,2);assert.equal(calls,2);assert.deepEqual(task.matching,input().matching);
  }finally{finish.resolve("late");await kernel.close();await rm(directory,{recursive:true,force:true});}
});

test("incomplete and oversized outputs remain complete, cannot be adopted or auto-retried",async t=>{
  const {kernel}=await fixture(t);const output="完整超长输出。".repeat(22000)+"JD-OUTPUT-END";
  let task=await kernel.createTask(input("synthetic-jd-overflow"),access),calls=0;
  await kernel.run(task.id,"start",command(task),{runtimeFingerprint:"synthetic-generation",reasoner:async()=>{calls++;return output;}},access);task=await settled(kernel,task.id);
  assert.equal(calls,1);assert.equal(task.result,undefined);assert.equal(task.error,"decision_output_budget");assert.equal((await kernel.readOutput(task.id,task.outputArtifacts![0]!.id)).text,output);
  task=await kernel.createTask(input("synthetic-jd-incomplete"),access);
  await kernel.run(task.id,"start",command(task),{runtimeFingerprint:"synthetic-generation",reasoner:async prompt=>{calls++;return {text:match(context(prompt)),finishReason:"length"};}},access);task=await settled(kernel,task.id);
  assert.equal(calls,2);assert.equal(task.status,"paused");assert.equal(task.error,"model_output_incomplete");assert.equal(task.result,undefined);assert.ok(task.partialOutput!.text.endsWith("}"));
});
