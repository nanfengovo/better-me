import assert from "node:assert/strict";
import test from "node:test";
import type { CareerTask } from "@better-me/agent-contracts";
import { CareerTaskSchema } from "@better-me/agent-contracts";
import { writingAnswerEvidence, writingConfirmation, writingDraft, writingEvidence, writingModelContract, writingPlan } from "../src/kernel/resume-text.js";
import { groundedEditChoices } from "../src/kernel/resume-text-grounded.js";

const original = "记录缓存复测。\r\n原有测试范围仅限本机。";
const supplement = "我在本机使用回放脚本核对缓存失效，未上线。";
function fixture() {
  const task: CareerTask = CareerTaskSchema.parse({
    id:"ct-grounded", ownerId:"synthetic", workspaceKey:"synthetic", kind:"resume_tailor", workflow:"text_v1",
    status:"ready", revision:1, objective:"只补第一项，另一项不动。", createdAt:"now", updatedAt:"now",
    runtimeBinding:{id:"fixture",label:"fixture",location:"local"}, budget:{maxModelCalls:2,maxToolCalls:1,maxActiveMs:10000},
    job:{title:"测试",company:"",description:"缓存与数据库测试。"},
    resume:{id:"r",name:"合成",sourceFingerprint:"version",fields:[
      {id:"cache",targetRef:{kind:"claim_text",locale:"zh",experienceId:"first",claimId:"cache"},originalText:original},
      {id:"db",targetRef:{kind:"claim_text",locale:"zh",experienceId:"second",claimId:"db"},originalText:"整理事务日志。"},
    ]}, materials:[{id:"team",label:"团队文件",kind:"source",text:"系统上线效果未知，团队实现回放。"}],
    directories:[], usage:{modelCalls:0,toolCalls:0,activeMs:0}, events:[], evidence:[], facts:[],
  });
  task.evidence=writingEvidence(task);
  return task;
}
function confirm(task:CareerTask, questions: Array<{fieldId:string;question:string}>, answers:string[], legacy=false) {
  const ref=(fieldId:string)=>[task.evidence.find(item=>item.sourceId===`resume:${fieldId}`)!.id];
  task.writingPlan=writingPlan(task,legacy?{kind:"material_plan",selections:task.resume.fields.map(field=>({fieldId:field.id,include:field.id==="cache",reason:"核对缓存范围。",evidenceIds:ref(field.id)})),
    questions:questions.map((question,index)=>({...question,id:`question-${index}`,evidenceIds:ref(question.fieldId)}))}:
    {kind:"field_plan",selections:[{fieldId:"cache",include:true,reason:"缓存相关。"}],questions});
  task.writingConfirmation=writingConfirmation(task,JSON.stringify({planHash:task.writingPlan.hash,selectedFieldIds:["cache"],confirmed:true,
    answers:task.writingPlan.questions.map((q,index)=>({questionId:q.id,text:answers[index]??"保留原文"}))}));
  task.evidence.push(...writingAnswerEvidence(task,task.writingConfirmation));
  return task;
}
test("compact model planning always preserves every authorized field; the Host asks for personal proof", () => {
  const task=confirm(fixture(),[],[supplement]);
  assert.deepEqual(task.writingPlan!.selections.map(s=>s.fieldId),["cache","db"]);
  assert.equal(task.writingPlan!.selections[1]!.include,false);
  assert.equal(task.writingPlan!.questions.length,2);
  assert.equal(groundedEditChoices(task).length,1);
  assert.deepEqual(writingModelContract(task),{mode:"resume_grounded_edits",ids:["E1"]});
  for(const selectedIds of [[],["E1"],["E1","E1"]]) {
    const draft=writingDraft(task,{kind:"grounded_edits",selectedIds});
    const patch=draft.patches[0]!;
    assert.equal(draft.patches.length,1);
    assert.equal(patch.proposedText,original+"\n"+supplement);
    assert.deepEqual(patch.evidenceIds.map(id=>task.evidence.find(item=>item.id===id)?.excerpt),[original,supplement]);
    assert.deepEqual(patch.sentences?.map(sentence=>sentence.text),["记录缓存复测。","原有测试范围仅限本机。",supplement]);
  }
  assert.throws(()=>writingDraft(task,{kind:"grounded_edits",selectedIds:["foreign-choice"]}),/invalid_writing_edit_selection/);
  const duplicateQuestions=confirm(fixture(),Array.from({length:5},()=>({fieldId:"cache",question:"缓存动作？"})),[supplement]);
  assert.deepEqual(duplicateQuestions.writingPlan!.questions.map(question=>question.fieldId),["cache","db"]);
  const recommendation={fieldId:"cache",include:true,reason:"缓存测试相关。"};
  const repeated=writingPlan(fixture(),{kind:"field_plan",selections:[recommendation,recommendation],questions:[]});
  assert.deepEqual(repeated.selections.map(item=>[item.fieldId,item.include]),[["cache",true],["db",false]]);
  const conflicting=writingPlan(fixture(),{kind:"field_plan",selections:[recommendation,{...recommendation,include:false}],questions:[]});
  assert.equal(conflicting.selections[0]!.include,false);
  assert.match(conflicting.selections[0]!.reason,/冲突/);
  assert.ok(conflicting.questions.some(question=>question.fieldId==="cache"));
});
test("an unknown, unconfirmed multi-sentence report or conflicting choices cannot silently become a factual edit", () => {
  for(const answer of ["未知","保留原文","keep original","我完成测试。另一个人负责上线。"]) {
    const task=confirm(fixture(),[],[answer]);
    const draft=writingDraft(task,{kind:"grounded_edits",selectedIds:[]});
    assert.deepEqual(draft.patches,[]);
    assert.match(draft.unknowns[0]!,/保留原文/);
  }
  const task=confirm(fixture(),[{fieldId:"cache",question:"动作"},{fieldId:"cache",question:"环境"}],[supplement,"我在联调环境核对了异常样本。"],true);
  assert.equal(groundedEditChoices(task).length,2);
  assert.equal(writingDraft(task,{kind:"grounded_edits",selectedIds:[]}).patches.length,0);
  assert.equal(writingDraft(task,{kind:"grounded_edits",selectedIds:["E2"]}).patches.length,1);
  assert.throws(()=>writingDraft(task,{kind:"grounded_edits",selectedIds:["E1","E2"]}),/duplicate_patch_target/);
});
test("legacy output missing original evidence cannot substitute project capabilities or fabricated results", () => {
  const task=confirm(fixture(),[],[supplement]), field=task.resume.fields[0]!, material=task.evidence.find(e=>e.sourceId==="material:team")!;
  const originalSource=task.evidence.find(e=>e.sourceId==="resume:cache")!;
  const proposal={kind:"draft",patches:[{
    fieldId:field.id,targetRef:field.targetRef,originalText:field.originalText,proposedText:"记录缓存复测与回放。\r\n原有测试范围仅限本机。",
    evidenceIds:[material.id], rationale:"项目资料",sentences:[
      {text:"记录缓存复测与回放。",evidenceIds:[material.id]},
      {text:"原有测试范围仅限本机。",evidenceIds:[material.id]},
    ],
  }],unknowns:[]};
  const result=writingDraft(task,proposal);
  assert.equal(result.patches[0]!.proposedText,original+"\n"+supplement);
  assert.ok(result.patches[0]!.evidenceIds.includes(originalSource.id));
  assert.ok(!result.patches[0]!.evidenceIds.includes(material.id));
  proposal.patches[0]!.proposedText="负责生产上线，性能提升90%。\r\n原有测试范围仅限本机。";
  proposal.patches[0]!.sentences[0]!.text="负责生产上线，性能提升90%。";
  assert.throws(()=>writingDraft(task,proposal),/unsupported_number/);
});
