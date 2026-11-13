import { randomUUID } from "node:crypto";
import { ProjectUnderstandingTaskDecisionSchema, type ProjectUnderstandingTask, type UnderstandingEvidence, type UnderstandingTurnInput, type CareerTaskEvidence } from "@better-me/agent-contracts";
import { UnderstandingProtocol, canonicalUnderstanding, type UnderstandingProtocolState } from "../understanding/protocol.js";
import { UnderstandingError } from "../understanding/errors.js";
import { CareerTaskError, digest } from "../tasks/evidence.js";
import { EVIDENCE_RETRIEVAL_POLICY, evidenceManifest, rankEvidence, resolveEvidenceHandle } from "./evidence-retrieval.js";
export type ProjectTaskState={agentContextFloor:number;recentContextFloor:number;turnToolStart:number;receipts:Record<string,{fingerprint:string}>;directories?:UnderstandingProtocolState["directories"]};
export type ProjectStore={task:ProjectUnderstandingTask;recent:unknown[];exposedEvidenceIds?:string[];projectState?:ProjectTaskState};
const now=()=>new Date().toISOString();
const fail=(code:string):never=>{throw new CareerTaskError(code,422);};
export const projectProtocol=(s:ProjectStore)=>new UnderstandingProtocol(s.task.budget.maxToolCalls);
export function projectPrivate(s:ProjectStore):ProjectTaskState{return s.projectState??={agentContextFloor:0,recentContextFloor:0,turnToolStart:0,receipts:{}};}
export function protocolState(s:ProjectStore):UnderstandingProtocolState{
  const p=projectPrivate(s);return {session:s.task.project,agentContextFloor:p.agentContextFloor,directories:p.directories,citableEvidenceIds:s.exposedEvidenceIds??[]};
}
export function projectReplay(s:ProjectStore,turn:UnderstandingTurnInput){
  const receipts=projectPrivate(s).receipts,key=digest(turn.idempotencyKey),receipt=Object.hasOwn(receipts,key)?receipts[key]:undefined;if(!receipt)return false;
  if(receipt.fingerprint!==digest(turn))fail("idempotency_conflict");return true;
}
export function beginProjectTurn(s:ProjectStore,turn:UnderstandingTurnInput){
  const session=s.task.project,meta=projectPrivate(s);
  if(turn.expectedRevision!==s.task.revision)fail("task_revision_conflict");
  const labels=projectProtocol(s).optionLabels(session,turn.selectedOptionIds);
  if(session.question&&!turn.answer.trim()&&!labels.length)fail("project_answer_required");
  // Preserve exact user bytes; trim is only an emptiness check, never a rewrite.
  const text=[turn.answer,labels.length?`已选择（服务端核对选项）：${labels.join("；")}`:""].filter(value=>value!=="").join("\n");
  if(text)session.messages.push({id:`msg_${randomUUID()}`,role:"user",text,at:now(),selectedOptionIds:turn.selectedOptionIds});
  delete session.confirmation;delete session.summaryHash;delete session.question;delete session.error;delete s.task.partialOutput;
  session.turnCount++;meta.turnToolStart=s.task.usage.toolCalls;
  session.checkpoint={turn:session.turnCount,status:"reading",used:0,budget:s.task.budget.maxToolCalls,evidenceIds:[],reusedDirectories:0};
  meta.receipts[digest(turn.idempotencyKey)]={fingerprint:digest(turn)};
}
export function invalidateProject(s:ProjectStore,clearUnderstanding=true){
  const session=s.task.project,meta=projectPrivate(s);
  delete session.confirmation;delete session.summaryHash;delete session.question;delete session.error;
  if(clearUnderstanding)delete session.understanding;
  meta.agentContextFloor=session.messages.length;meta.recentContextFloor=s.recent.length;meta.directories=[];s.exposedEvidenceIds=[];
}
export function activeProjectEvidence(s:ProjectStore){
  const active=new Set(s.task.project.grants.filter(grant=>!grant.revokedAt).map(grant=>grant.id));
  const messages=new Set(projectProtocol(s).contextMessages(protocolState(s)).map(message=>message.id));
  return s.task.project.evidence.filter(item=>item.grantId==="conversation"?messages.has(item.path):active.has(item.grantId));
}
function careerEvidence(item:UnderstandingEvidence):CareerTaskEvidence{return {...item,kind:item.grantId==="conversation"?"user_statement":"source",sourceId:item.grantId,label:item.path};}
function understandingEvidence(item:CareerTaskEvidence):UnderstandingEvidence{return {id:item.id,grantId:item.sourceId,path:item.path!,hash:item.hash,startLine:item.startLine!,endLine:item.endLine!,excerpt:item.excerpt,collectedAt:now(),startOffset:item.startOffset,endOffset:item.endOffset,sourceLength:item.sourceLength};}
export function collectProjectEvidence(s:ProjectStore,item:UnderstandingEvidence){
  const previous=s.task.project.evidence.find(value=>value.id===item.id);
  if(previous){
    if(previous.hash!==item.hash||previous.excerpt!==item.excerpt||previous.grantId!==item.grantId||previous.path!==item.path)fail("evidence_identity_conflict");
    for(const key of ["startOffset","endOffset","sourceLength"] as const)if(previous[key]===undefined&&item[key]!==undefined)previous[key]=item[key];
    return;
  }
  if(s.task.project.evidence.length>=1000||s.task.project.evidence.reduce((sum,value)=>sum+value.excerpt.length,0)+item.excerpt.length>1_000_000)fail("task_evidence_budget");
  s.task.project.evidence.push(item);
}
export function projectContext(s:ProjectStore){
  const eligible=activeProjectEvidence(s),files=eligible.filter(item=>item.grantId!=="conversation").map(careerEvidence);
  const session=s.task.project,lastUser=session.messages.filter(message=>message.role==="user").at(-1)?.text??"";
  const ranked=rankEvidence(files,[session.label,session.sourceText,lastUser].join("\n"));
  const recent=s.recent.slice(projectPrivate(s).recentContextFloor),last=recent.at(-1) as {operation?:string;evidenceIds?:string[]}|undefined;
  const requested=last?.operation==="read_evidence"?eligible.filter(item=>last.evidenceIds?.includes(item.id)):[];
  const mounted=[...new Map([...eligible.filter(item=>item.grantId==="conversation"),...requested,...ranked.selected.map(item=>understandingEvidence(item.evidence))].map(item=>[item.id,item])).values()];
  return {evidence:mounted,evidenceManifest:evidenceManifest(eligible.map(careerEvidence)),retrieval:{...EVIDENCE_RETRIEVAL_POLICY,totalPassages:ranked.totalPassages,coordinateRereadRequired:ranked.unlocatedEvidenceIds,selected:ranked.selected.map(({evidence,...score})=>({id:evidence.id,...score})),requestedPageEvidenceIds:requested.map(item=>item.id)}};
}
export function mountProjectContext(s:ProjectStore){
  const projection=projectContext(s);for(const item of projection.evidence)collectProjectEvidence(s,item);
  s.exposedEvidenceIds=[...new Set([...(s.exposedEvidenceIds??[]),...projection.evidence.map(item=>item.id)])];return projection;
}
export function projectPrompt(s:ProjectStore){
  const meta=projectPrivate(s),remaining=s.task.rootLedger?s.task.rootLedger.budget.maxToolCalls-s.task.rootLedger.usage.toolCalls:s.task.budget.maxToolCalls-s.task.usage.toolCalls;
  return [projectProtocol(s).prompt(protocolState(s),s.recent.slice(meta.recentContextFloor),remaining<=0,projectContext(s)),JSON.stringify({taskId:s.task.id,budget:s.task.budget,usage:s.task.usage,rootLedger:s.task.rootLedger})].join("\n\n");
}
export function projectDecision(s:ProjectStore,output:string){
  const clean=output.trim().replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,"");
  const parsed=ProjectUnderstandingTaskDecisionSchema.safeParse(JSON.parse(clean));if(!parsed.success)fail("invalid_project_decision");
  const result=parsed.data!;
  try{if(result.kind==="reply")projectProtocol(s).validateReply(protocolState(s),result);}
  catch(error){if(error instanceof UnderstandingError)throw new CareerTaskError(error.code,error.status);throw error;}
  return result;
}
export function projectHandle(s:ProjectStore,handle:string){
  const item=resolveEvidenceHandle(activeProjectEvidence(s).map(careerEvidence),handle);return item?understandingEvidence(item):undefined;
}
export const understandingHash=(value:unknown)=>digest(canonicalUnderstanding(value));
