import { useEffect, useState } from "react";
import { z } from "zod";
import type { CareerTask } from "@better-me/agent-contracts";
import { useUiPreferences } from "../lib/ui-preferences";

const unsentSchema=z.object({selected:z.array(z.string()).max(300),answers:z.record(z.string(), z.string().max(4000))}).strict();
/** Unsent text is local, confirmed text lives in the Host task. No stored boolean is consent. */
export function WritingPlanReview({task,storage,onChange,disabled,supplement}:{task:CareerTask;storage:Storage;onChange:(answer:string)=>void;disabled:boolean;supplement?:{fieldId:string;text:string}}){
  const {t}=useUiPreferences();
  const plan=task.writingPlan!;
  const key=`career-writing.unsent.v1:${task.id}:${plan.hash}`;
  const [draft,setDraft]=useState(()=>{
    try{const parsed=unsentSchema.safeParse(JSON.parse(storage.getItem(key)??"null"));if(parsed.success)return parsed.data;}catch{/* Keep a readable form if storage is unavailable. */}
    const question=supplement&&plan.questions.find(q=>q.fieldId===supplement.fieldId);
    const answers:Record<string,string>=question&&supplement?{[question.id]:supplement.text}:{};
    return {selected:plan.selections.filter(s=>s.include).map(s=>s.fieldId),answers};
  });
  const [review,setReview]=useState(false),[confirmed,setConfirmed]=useState(false),[error,setError]=useState("");
  const questions=plan.questions.filter(q=>draft.selected.includes(q.fieldId));
  const payload=JSON.stringify({planHash:plan.hash,selectedFieldIds:draft.selected,answers:plan.questions.map(q=>({
    questionId:q.id,text:draft.selected.includes(q.fieldId)?draft.answers[q.id]??"":"保留原文",
  })),confirmed:true});
  const tooLong=payload.length>12000;
  const valid=!tooLong&&draft.selected.length>0&&draft.selected.every(id=>plan.selections.some(s=>s.fieldId===id))&&questions.every(q=>draft.answers[q.id]?.trim());
  useEffect(()=>{onChange(confirmed&&valid?payload:"");},[onChange,confirmed,valid,payload]);
  function change(next:typeof draft){
    setDraft(next);setReview(false);setConfirmed(false);onChange("");
    try{storage.setItem(key,JSON.stringify(next));setError("");}catch{setError(t("补充未能保存到本机，请先保留文字。","The supplement could not be saved locally. Keep a copy of the text."));}
  }
  return <section className="ct-writing-plan" aria-label={t("选材与事实补充","Source selection and facts")}>
    <h3>{t("选材与追问","Source selection and questions")}</h3>
    {error&&<p role="alert">{error}</p>}
    {tooLong&&<p role="alert">{t("本次补充合计过长，请缩短回答后再核对。","The supplements are too long. Shorten the answers before review.")}</p>}
    <fieldset disabled={disabled}><legend>{t("本轮采用的材料","Sources selected for this round")}</legend>{plan.selections.map(s=>{
      const field=task.resume.fields.find(f=>f.id===s.fieldId);
      return <div className="ct-diff" key={s.fieldId}><label className="ct-check"><input type="checkbox" checked={draft.selected.includes(s.fieldId)} onChange={e=>change({...draft,selected:e.target.checked?[...draft.selected,s.fieldId]:draft.selected.filter(id=>id!==s.fieldId)})}/><span>{field?.originalText??t("来源已失效","Source unavailable")}</span></label><p><strong>{s.include?t("建议采用","Suggested"):t("请核对","Review")}</strong> · {s.reason}</p>
        <details><summary>{t("原始依据","Original evidence")}</summary>{s.evidenceIds.map(id=><blockquote key={id}>{task.evidence.find(e=>e.id===id)?.excerpt??t("引用无法核对","Reference unavailable")}</blockquote>)}</details></div>;
    })}</fieldset>
    <p>{t("每个已选字段补充一句完整的本人事实，保留分工和必要限定。没有新增事实可填写“保留原文”或“未知”。","For each selected field, supply one complete personal fact, including responsibility and qualifications. Enter “keep original” or “unknown” if there are no new facts.")}</p>
    {questions.map(q=><label key={q.id}>{q.question}<textarea data-writing-answer={q.id} maxLength={4000} disabled={disabled} value={draft.answers[q.id]??""} onChange={e=>change({...draft,answers:{...draft.answers,[q.id]:e.target.value}})}/></label>)}
    {!review?<button type="button" disabled={disabled||!valid} onClick={()=>setReview(true)}>{t("核对本次选材与补充","Review selected sources and supplements")}</button>:<div className="ct-diff">
      <h4>{t("确认补充内容","Confirm the supplement")}</h4><p>{t(`本轮采用 ${draft.selected.length} 个字段。逐条审核后才可保存独立版本。`,`${draft.selected.length} fields selected. Review each item before saving an independent version.`)}</p>
      {questions.map(q=><div key={q.id}><strong>{q.question}</strong><p>{draft.answers[q.id]}</p></div>)}
      <label className="ct-check"><input type="checkbox" disabled={disabled} checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>{t("我确认本次选材与回答来自实际经历，保留未知与未完成边界","I confirm these sources and answers reflect my actual experience, including unknowns and incomplete work")}</label>
      <button type="button" disabled={disabled} onClick={()=>{setReview(false);setConfirmed(false);}}>{t("返回修改补充","Edit supplements")}</button>
    </div>}
  </section>;
}
