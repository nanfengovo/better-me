import type { CareerTask } from "@better-me/agent-contracts";

/** Deterministic text edition from the exact approved receipt, never a model call or a write to career data. */
export function reviewedWritingText(task:CareerTask):string{
  const {receipt,draft,writingConfirmation}=task;
  if(task.workflow!=="text_v1"||task.status!=="completed"||!receipt||!draft||!writingConfirmation||receipt.draftHash!==draft.hash||!receipt.approvedPatchIds.length)throw Error("请先逐条批准并保存独立版本，再导出。");
  if(new Set(writingConfirmation.selectedFieldIds).size!==writingConfirmation.selectedFieldIds.length||new Set(receipt.approvedPatchIds).size!==receipt.approvedPatchIds.length||receipt.approvedPatchIds.some(id=>!draft.patches.some(p=>p.id===id&&writingConfirmation.selectedFieldIds.includes(p.fieldId))))throw Error("审批回执与成稿不一致，未导出。");
  const lines=writingConfirmation.selectedFieldIds.map(id=>{
    const field=task.resume.fields.find(f=>f.id===id);if(!field)throw Error("所选原文无法核对，未导出。");
    return draft.patches.find(p=>p.fieldId===id&&receipt.approvedPatchIds.includes(p.id))?.proposedText??field.originalText;
  });
  return [`# ${task.resume.name} · ${task.job.title}`,"",...lines.map(text=>`- ${text}`),"","---",`版本：${receipt.versionId}`,`任务：${task.id}`,`批准稿指纹：${draft.hash}`,"仅导出本人批准的文本；来源支持不等于独立事实认证。","",...(draft.unknowns.length?["## 仍待核实",...draft.unknowns.map(text=>`- ${text}`),""]:[])].join("\n");
}
export function downloadReviewedWriting(task:CareerTask){
  const text=reviewedWritingText(task),url=URL.createObjectURL(new Blob([text],{type:"text/markdown;charset=utf-8"}));
  const anchor=document.createElement("a");anchor.href=url;anchor.download=`BetterMe-${task.id}-approved.md`;anchor.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
