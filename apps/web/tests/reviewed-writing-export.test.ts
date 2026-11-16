import assert from "node:assert/strict";
import test from "node:test";
import { CareerTaskSchema, careerRuntimeBinding, type CareerTask } from "@better-me/agent-contracts";
import { reviewedWritingText } from "../src/lib/reviewed-writing-export";

function fixture():CareerTask{
  return CareerTaskSchema.parse({id:"ct_export",ownerId:"synthetic-owner",workspaceKey:"synthetic",workflow:"text_v1",objective:"合成导出",status:"completed",revision:8,createdAt:"now",updatedAt:"now",job:{title:"合成岗位",company:"",description:"合成岗位要求"},runtimeBinding:careerRuntimeBinding({kind:"model",modelSettings:{provider:"ollama",model:"fixture",baseUrl:"http://127.0.0.1:1/v1"}}),
    resume:{id:"synthetic",name:"脱敏资料",sourceFingerprint:"original-fingerprint",fields:[{id:"a",targetRef:{kind:"profile_headline",locale:"zh"},originalText:"原文甲。"},{id:"b",targetRef:{kind:"claim_text",experienceId:"e",claimId:"b",locale:"zh"},originalText:"原文乙。"},{id:"c",targetRef:{kind:"claim_text",experienceId:"e",claimId:"c",locale:"zh"},originalText:"未选的原文丙。"}]},
    materials:[],directories:[],budget:{maxModelCalls:2,maxToolCalls:1,maxActiveMs:300000},usage:{modelCalls:2,toolCalls:0,activeMs:100},events:[],evidence:[],facts:[],
    writingPlan:{kind:"material_plan",hash:"plan-hash",selections:[{fieldId:"a",include:true,reason:"匹配",evidenceIds:["ev"]},{fieldId:"b",include:true,reason:"匹配",evidenceIds:["ev"]},{fieldId:"c",include:false,reason:"不选但不删除",evidenceIds:["ev"]}],questions:[]},
    writingConfirmation:{planHash:"plan-hash",selectedFieldIds:["a","b"],answers:[],confirmed:true},draft:{hash:"draft-hash",unknowns:["上线效果未知。"],patches:[{id:"pa",fieldId:"a",targetRef:{kind:"profile_headline",locale:"zh"},originalText:"原文甲。",proposedText:"已批准的新文甲。",evidenceIds:["ev"],rationale:"更明确"},{id:"pb",fieldId:"b",targetRef:{kind:"claim_text",experienceId:"e",claimId:"b",locale:"zh"},originalText:"原文乙。",proposedText:"未批准的新文乙。",evidenceIds:["ev"],rationale:"待核对"}]},
    receipt:{versionId:"independent-version",draftHash:"draft-hash",approvedPatchIds:["pa"],at:"now"}});
}
test("approved Markdown is deterministic across serialization, omits unselected material and keeps unapproved source text",()=>{
  const task=fixture(),before=JSON.stringify(task),text=reviewedWritingText(task);
  assert.match(text,/已批准的新文甲/);assert.match(text,/原文乙/);assert.doesNotMatch(text,/未批准的新文乙|未选的原文丙/);
  assert.match(text,/上线效果未知/);assert.match(text,/independent-version/);assert.equal(reviewedWritingText(CareerTaskSchema.parse(JSON.parse(before))),text);assert.equal(JSON.stringify(task),before);
});
test("incomplete or inconsistent approvals cannot export",()=>{
  for(const alter of [(t:CareerTask)=>{t.status="awaiting_review";},(t:CareerTask)=>{t.receipt!.draftHash="stale";},(t:CareerTask)=>{t.receipt!.approvedPatchIds=[];},(t:CareerTask)=>{t.receipt!.approvedPatchIds=["pa","pa"];},(t:CareerTask)=>{t.receipt!.approvedPatchIds=["missing"];},(t:CareerTask)=>{t.writingConfirmation!.selectedFieldIds=["b"];},(t:CareerTask)=>{t.writingConfirmation!.selectedFieldIds=["a","a"];}] ){
    const task=fixture();alter(task);assert.throws(()=>reviewedWritingText(task));
  }
});
