import { useEffect, useState } from "react";
import { z } from "zod";
import type { CareerTask } from "@better-me/agent-contracts";

const unsentSchema=z.object({selected:z.array(z.string()).max(300),answers:z.record(z.string(), z.string().max(4000))}).strict();
/** Unsent text is local, confirmed text lives in the Host task. No stored boolean is consent. */
export function WritingPlanReview({task,storage,onChange,disabled}:{task:CareerTask;storage:Storage;onChange:(answer:string)=>void;disabled:boolean}){
  const plan=task.writingPlan!;
  const key=`career-writing.unsent.v1:${task.id}:${plan.hash}`;
  const [draft,setDraft]=useState(()=>{
    try{const parsed=unsentSchema.safeParse(JSON.parse(storage.getItem(key)??"null"));if(parsed.success)return parsed.data;}catch{/* Keep a readable form if storage is unavailable. */}
    return {selected:plan.selections.filter(s=>s.include).map(s=>s.fieldId),answers:{} as Record<string,string>};
  });
  const [review,setReview]=useState(false),[confirmed,setConfirmed]=useState(false),[error,setError]=useState("");
  const payload=JSON.stringify({planHash:plan.hash,selectedFieldIds:draft.selected,answers:plan.questions.map(q=>({questionId:q.id,text:draft.answers[q.id]?.trim()??""})),confirmed:true});
  const tooLong=payload.length>12000;
  const valid=!tooLong&&draft.selected.length>0&&draft.selected.every(id=>plan.selections.some(s=>s.fieldId===id))&&plan.questions.every(q=>draft.answers[q.id]?.trim());
  useEffect(()=>{onChange(confirmed&&valid?payload:"");},[onChange,confirmed,valid,payload]);
  function change(next:typeof draft){
    setDraft(next);setReview(false);setConfirmed(false);onChange("");
    try{storage.setItem(key,JSON.stringify(next));setError("");}catch{setError("补充未能保存到本机；请先保留文字，不要关闭页面。");}
  }
  return <section className="ct-writing-plan" aria-label="选材与事实补充">
    <h3>选材与追问</h3>
    {error&&<p role="alert">{error}</p>}
    {tooLong&&<p role="alert">本次补充合计过长，请缩短回答后再核对；已输入内容仍留在本机。</p>}
    <fieldset disabled={disabled}><legend>本轮采用的材料</legend>{plan.selections.map(s=>{
      const field=task.resume.fields.find(f=>f.id===s.fieldId);
      return <div className="ct-diff" key={s.fieldId}><label className="ct-check"><input type="checkbox" checked={draft.selected.includes(s.fieldId)} onChange={e=>change({...draft,selected:e.target.checked?[...draft.selected,s.fieldId]:draft.selected.filter(id=>id!==s.fieldId)})}/><span>{field?.originalText??"来源已失效"}</span></label><p>{s.include?"建议采用":"建议暂不采用"}：{s.reason}</p>
        <details><summary>原始依据</summary>{s.evidenceIds.map(id=><blockquote key={id}>{task.evidence.find(e=>e.id===id)?.excerpt??"引用无法核对"}</blockquote>)}</details></div>;
    })}</fieldset>
    <p>未选材料只是不参与本次改写，不会从原简历删除。回答仅用于本任务，未知可直接写“未知”，不必补造数字。</p>
    {plan.questions.map(q=><label key={q.id}>{q.question}<textarea data-writing-answer={q.id} maxLength={4000} disabled={disabled} value={draft.answers[q.id]??""} onChange={e=>change({...draft,answers:{...draft.answers,[q.id]:e.target.value}})}/></label>)}
    {!review?<button type="button" disabled={disabled||!valid} onClick={()=>setReview(true)}>核对本次选材与补充</button>:<div className="ct-diff">
      <h4>确认后才交给模型成稿</h4><p>本轮采用 {draft.selected.length} 个字段；补充不会写入长期事实或修改原简历。</p>
      {plan.questions.map(q=><div key={q.id}><strong>{q.question}</strong><p>{draft.answers[q.id]}</p></div>)}
      <label className="ct-check"><input type="checkbox" disabled={disabled} checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>我确认本次选材与回答来自实际经历，保留未知与未完成边界</label>
      <button type="button" disabled={disabled} onClick={()=>{setReview(false);setConfirmed(false);}}>返回修改补充</button>
    </div>}
  </section>;
}
