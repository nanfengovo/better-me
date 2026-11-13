import { careerTaskCommandFingerprint, careerTaskSourceFingerprint, type CareerTaskResumeCommand } from "@better-me/core";
import type { CareerTask } from "@better-me/agent-contracts";
import type { BetterMeDocument } from "@better-me/storage";

export type ResumeReceiptPointer = { versionId:string; receiptId?:string; draftHash:string; approvedPatchIds:string[] };
export type WorkspaceReceiptRequest = { kind:"resume"; hint?:ResumeReceiptPointer } | { kind:"fact"; factId:string };
export type WorkspaceReceiptInspection = { state:"current"; receipt?:ResumeReceiptPointer } | { state:"missing"|"edited"|"conflict" };
const sameIds = (a:string[], b:string[]) => a.length===b.length && a.every((id,i)=>id===b[i]);

/** Both save and read-only reconciliation derive the same command from the approved host draft. */
export function resumeSaveCommand(task:CareerTask, approvedPatchIds:string[]):CareerTaskResumeCommand {
  const draft=task.draft, selected=new Set(approvedPatchIds);
  if(!draft || !selected.size || selected.size!==approvedPatchIds.length) throw Error("逐句批准清单不正确。");
  const patches=draft.patches.filter(p=>selected.has(p.id)), ids=patches.map(p=>p.id);
  if(!sameIds(approvedPatchIds,ids)) throw Error("逐句批准清单与草稿不一致。");
  return {taskId:task.id,sourceResumeId:task.resume.id,sourceFingerprint:task.resume.sourceFingerprint,approvalHash:draft.hash,
    name:`${task.job.company} · ${task.job.title} 定制版`,job:{id:task.job.id,title:task.job.title,company:task.job.company},
    approvedPatchIds:ids,patches:patches.map(p=>({targetRef:p.targetRef,originalText:p.originalText,proposedText:p.proposedText,evidenceIds:p.evidenceIds}))};
}

/** Read only embedded business data. A delivery pointer alone is not a receipt. */
export async function inspectCareerTaskWorkspace(doc:BetterMeDocument|null,task:CareerTask,query:WorkspaceReceiptRequest):Promise<WorkspaceReceiptInspection>{
  if(!doc)return {state:"missing"};
  if((doc.documentId??"default")!==task.workspaceKey)return {state:"conflict"};
  if(query.kind==="fact"){
    const found=(doc.factBase.personalStatements??[]).filter(s=>s.id===`career-fact:${task.id}:${query.factId}`);
    if(!found.length)return {state:"missing"};
    const record=found[0]!, fact=task.facts.find(f=>f.id===query.factId);
    if(found.length!==1||!fact||record.taskId!==task.id||record.kind!=="user_statement"||record.text!==fact.text||
      !sameIds(record.evidence.map(e=>e.id),fact.evidenceIds)||!record.evidence.every(e=>{
        const source=task.evidence.find(item=>item.id===e.id);
        return source&&source.hash===e.hash&&source.kind===e.kind&&source.label===e.label&&source.excerpt===e.excerpt;
      })) return {state:"conflict"};
    return {state:doc.factBase.personalStatements?.some(s=>s.supersedes===record.id)?"edited":"current"};
  }
  const views=doc.resumeViews.filter(v=>v.careerTaskReceipt?.taskId===task.id);
  if(!views.length)return {state:"missing"};
  const view=views[0]!, record=view.careerTaskReceipt!, hint=query.hint;
  const ids=record.approvedPatchIds??hint?.approvedPatchIds;
  if(views.length!==1||!view.isolatedFactBase||record.resumeId!==view.id||record.sourceResumeId!==task.resume.id
    ||record.sourceFingerprint!==task.resume.sourceFingerprint||record.approvalHash!==task.draft?.hash||!ids
    ||hint&&(hint.versionId!==view.id||hint.receiptId!==undefined&&hint.receiptId!==record.id||hint.draftHash!==record.approvalHash||!sameIds(hint.approvedPatchIds,ids)))return {state:"conflict"};
  try {
    if(await careerTaskCommandFingerprint(resumeSaveCommand(task,ids))!==record.contentHash)return {state:"conflict"};
    if(await careerTaskSourceFingerprint(doc,view.id)!==record.snapshotHash)return {state:"edited"};
  } catch {return {state:"conflict"};}
  return {state:"current",receipt:{versionId:view.id,receiptId:record.id,draftHash:record.approvalHash,approvedPatchIds:[...ids]}};
}
