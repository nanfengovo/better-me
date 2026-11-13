import assert from "node:assert/strict";
import test from "node:test";
import { careerTaskSourceFingerprint, createCareerTaskResume } from "@better-me/core";
import { createInitialDocument } from "@better-me/storage";
import type { CareerTask } from "@better-me/agent-contracts";
import { resumeSaveCommand, inspectCareerTaskWorkspace } from "../src/lib/career-task-reconciliation";
import { approveCareerTaskStatement } from "../src/lib/career-task-facts";

async function scenario() {
  const doc = createInitialDocument("2026-01-01T00:00:00.000Z"), view = doc.resumeViews[0]!;
  const task: CareerTask = { id:"test-task",workspaceKey:doc.documentId!,ownerId:"synthetic",objective:"fixture",revision:4,status:"awaiting_review",
    job:{id:"j",title:"工程师",company:"合成公司",description:"合成要求"}, materials:[],directories:[],
    resume:{id:view.id,name:view.name,sourceFingerprint:await careerTaskSourceFingerprint(doc,view.id),fields:[]},
    runtimeBinding:{id:"test",label:"合成",location:"local"},budget:{maxActiveMs:60000,maxModelCalls:2,maxToolCalls:3},usage:{activeMs:0,modelCalls:1,toolCalls:1},
    evidence:[{id:"e",kind:"user_statement",sourceId:"answer",label:"本人陈述",excerpt:"我设计了测试。",hash:"test-hash"}],
    facts:[{id:"f",status:"proposed",text:"我设计了测试。",evidenceIds:["e"]}],events:[],createdAt:doc.factBase.updatedAt,updatedAt:doc.factBase.updatedAt,
    draft:{hash:"a".repeat(64),unknowns:[],patches:[{id:"p",fieldId:"hf",targetRef:{kind:"profile_headline",locale:"zh"},originalText:doc.factBase.profile.headline!.zh,
      proposedText:"一条合成改写",evidenceIds:["e"],rationale:"合成依据"}]} };
  return {doc,task};
}
test("receipt recovery without a pointer or the source matches only the durable, exact approved edition and never creates a view", async () => {
  const {doc,task} = await scenario();
  const request = {kind:"resume" as const};
  assert.equal((await inspectCareerTaskWorkspace(doc,task,request)).state,"missing");
  const {document:saved,receipt} = await createCareerTaskResume(doc,resumeSaveCommand(task,["p"]));
  saved.resumeViews=saved.resumeViews.filter(v=>v.id!==task.resume.id);
  const before=structuredClone(saved);
  assert.deepEqual(await inspectCareerTaskWorkspace(saved,task,request),{state:"current",receipt:{versionId:receipt.resumeId,receiptId:receipt.id,draftHash:task.draft!.hash,approvedPatchIds:["p"]}});
  assert.deepEqual(saved,before);
  assert.equal((await inspectCareerTaskWorkspace(saved,task,{kind:"resume",hint:{versionId:"someone-else",draftHash:task.draft!.hash,approvedPatchIds:["p"]}})).state,"conflict");
  assert.equal((await inspectCareerTaskWorkspace(saved,task,{kind:"resume",hint:{versionId:receipt.resumeId,draftHash:task.draft!.hash,approvedPatchIds:["wrong-patch"]}})).state,"conflict");
  const changed=structuredClone(task);changed.draft!.patches[0]!.proposedText="另一条未获批准的描述";
  assert.equal((await inspectCareerTaskWorkspace(saved,changed,request)).state,"conflict");
  assert.equal((await inspectCareerTaskWorkspace(saved,{...task,workspaceKey:"unrelated"},request)).state,"conflict");
  saved.resumeViews[0]!.name="后来重命名";
  assert.equal((await inspectCareerTaskWorkspace(saved,task,request)).state,"edited");
  saved.resumeViews=[];
  assert.equal((await inspectCareerTaskWorkspace(saved,task,request)).state,"missing");
});
test("a fact pointer is not proof: a restored away, amended, superseded, or wrong-source statement cannot be acknowledged",async()=>{
  const {doc,task}=await scenario(), query={kind:"fact" as const,factId:"f"};
  assert.equal((await inspectCareerTaskWorkspace(doc,task,query)).state,"missing");
  doc.factBase=approveCareerTaskStatement(doc.factBase,task,"f");
  assert.equal((await inspectCareerTaskWorkspace(doc,task,query)).state,"current");
  const entry=doc.factBase.personalStatements![0]!;
  doc.factBase.personalStatements!.push({...entry,id:"replacement",supersedes:entry.id});
  assert.equal((await inspectCareerTaskWorkspace(doc,task,query)).state,"edited");
  doc.factBase.personalStatements!.pop();entry.evidence[0]!.hash="different-content";
  assert.equal((await inspectCareerTaskWorkspace(doc,task,query)).state,"conflict");
});
