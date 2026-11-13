import type { CareerTask, CareerTaskEvidence } from "@better-me/agent-contracts";
import { EVIDENCE_RETRIEVAL_POLICY, evidenceManifest, rankEvidence } from "./evidence-retrieval.js";

export function evidenceIndex(items:CareerTaskEvidence[]){
  return items.map(({id,kind,sourceId,label,hash,startOffset,endOffset,sourceLength,path,startLine,endLine})=>({id,kind,sourceId,label,hash,startOffset,endOffset,sourceLength,path,startLine,endLine}));
}
/** Explicit ranked projection, not a shortened record. Full observations, personal
 * corrections and explicitly requested pages remain intact; every other source has a reread handle. */
export function taskContext(task:CareerTask,recent:unknown[]){
  const retrieval=rankEvidence(task.evidence.filter(item=>item.kind!=="user_statement"),[task.job.title,task.job.description,task.objective].join("\n"));
  const last=recent.at(-1) as {tool?:string;evidenceIds?:string[]}|undefined;
  const requested=last?.tool==="read_evidence"?task.evidence.filter(item=>last.evidenceIds?.includes(item.id)):[];
  const pinned=task.evidence.filter(item=>item.kind==="user_statement");
  const mounted=[...new Map([...pinned,...requested,...retrieval.selected.map(item=>item.evidence)].map(item=>[item.id,item])).values()];
  return {evidence:mounted,evidenceIndex:evidenceIndex(task.evidence),evidenceCount:task.evidence.length,indexTruncated:false,
    evidenceManifest:evidenceManifest(task.evidence),
    retrieval:{...EVIDENCE_RETRIEVAL_POLICY,totalPassages:retrieval.totalPassages,coordinateRereadRequired:retrieval.unlocatedEvidenceIds,selected:retrieval.selected.map(({evidence,...score})=>({id:evidence.id,...score})),
      pinnedPersonalEvidenceIds:pinned.map(item=>item.id),requestedPageEvidenceIds:requested.map(item=>item.id)},
    unloadedPersonalStatements:[],recentObservations:recent,
    contextPolicy:"Explicit two-phase retrieval: local BM25 then query-coverage reranking mounts Top-K exact passages. Full user statements/corrections and the latest explicit read_evidence page are additionally pinned. All collected source records and observations remain intact, with a complete evidenceManifest for read_evidence pagination; manifest handles are NOT citable evidence. Historical file records lacking character coordinates require read_evidence before ranking/citation; never invent offset zero. Offsets are end-exclusive UTF-16 code units. A range is only that range, never the whole file. No generated summary is factual evidence. Context-limit errors must be explicit; never silently trim input or output."};
}
