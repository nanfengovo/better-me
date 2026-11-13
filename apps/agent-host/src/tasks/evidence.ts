import { createHash } from "node:crypto";
import { isImplementationEvidencePath, type CareerTask, type CareerTaskDecision, type CareerTaskEvidence, type CareerTaskPatch, type UnderstandingGrant } from "@better-me/agent-contracts";
import { EvidenceBroker, EvidenceAccessError } from "../understanding/evidence-broker.js";

export const digest = (x:unknown) => createHash("sha256").update(typeof x==="string"?x:JSON.stringify(x)).digest("hex");
export class CareerTaskError extends Error {
  constructor(readonly code:string,readonly status=409){super(code);this.name="CareerTaskError";}
}
type Tool = Extract<CareerTaskDecision,{kind:"tool"}>;
export function evidence(kind:CareerTaskEvidence["kind"],sourceId:string,label:string,full:string,start=1,end?:number,offset?:number,length=full.length):CareerTaskEvidence {
  const lines=full.split(/\r?\n/),last=Math.min(lines.length,end??lines.length),hash=digest(full);
  if(start>last || start<1) throw new CareerTaskError("invalid_line_range",422);
  const breaks=[...full.matchAll(/\r?\n/g)];
  const lineOffset=start===1?0:breaks[start-2]!.index!+breaks[start-2]![0].length;
  const startOffset=offset??lineOffset;
  if(startOffset>=full.length||startOffset<0)throw new CareerTaskError("invalid_source_offset",422);
  const lineEnd=last<lines.length?breaks[last-1]!.index!:full.length;
  const endOffset=Math.min(full.length,startOffset+length,offset===undefined?lineEnd:full.length);
  const excerpt=full.slice(startOffset,endOffset);
  if (!excerpt.trim()) throw new CareerTaskError("empty_excerpt",422);
  return {id:`ev_${digest([kind,sourceId,hash,startOffset,endOffset,excerpt]).slice(0,28)}`,kind,sourceId,label,excerpt,hash,startLine:full.slice(0,startOffset).split("\n").length,endLine:full.slice(0,endOffset).split("\n").length,startOffset,endOffset,sourceLength:full.length};
}
export type Observation={evidence:CareerTaskEvidence[];detail:unknown};
export async function observe(task:CareerTask, grants:UnderstandingGrant[], broker:EvidenceBroker, req:Tool,signal:AbortSignal):Promise<Observation>{
  signal.throwIfAborted();
  const start=req.startLine??1,end=req.endLine;
  switch(req.tool){
    case "read_job":{const j=task.job;return {evidence:[evidence("job","job",j.title,[j.title,j.company,j.description].join("\n"),start,end,req.offset,req.length)],detail:{revision:j.version??null}};}
    case "read_resume":{
      const selected=req.id?task.resume.fields.filter(v=>v.id===req.id):task.resume.fields;
      if(!selected.length)throw new CareerTaskError("field_not_granted",403);
      return {evidence:selected.map(v=>evidence("resume",`resume:${v.id}`,v.id,v.originalText,start,end,req.offset,req.length)),detail:{fields:selected.map(f=>({id:f.id,targetRef:f.targetRef})),omitted:!req.id&&selected.length<task.resume.fields.length}};
    }
    case "read_material":{
      const m=task.materials.find(x=>x.id===req.id);if(!m)throw new CareerTaskError("material_not_granted",403);
      return {evidence:[evidence(m.kind,`material:${m.id}`,m.label,m.text,start,end,req.offset,req.length)],detail:{sourceType:m.kind}};
    }
    case "search_materials":{
      const query=req.query?.trim().toLowerCase();if(!query)throw new CareerTaskError("literal_query_required",422);
      const matches:CareerTaskEvidence[]=[];
      for(const m of task.materials){ const lines=m.text.split(/\r?\n/);
        for(let i=0;i<lines.length && matches.length<10;i++) if(lines[i]!.toLowerCase().includes(query))matches.push(evidence(m.kind,`material:${m.id}`,m.label,m.text,i+1,i+1));}
      return {evidence:matches,detail:{matched:matches.length,truncated:matches.length===10}};
    }
    default:{
      const grant=grants.find(g=>g.id===req.id&&!g.revokedAt);if(!grant)throw new CareerTaskError("directory_not_granted",403);
      const operation=req.tool==="list_directory"?"list":req.tool==="search_directory"?"search":"read";
      const res=await broker.execute(grant,{operation,path:req.path,query:req.query,startLine:req.startLine,endLine:req.endLine,offset:req.offset,length:req.length},signal);
      return {evidence:res.evidence.map(e=>({id:e.id,kind:isImplementationEvidencePath(e.path)?"source":"design",sourceId:`dir:${grant.id}`,label:`${grant.label}/${e.path}`,excerpt:e.excerpt,hash:e.hash,path:e.path,startLine:e.startLine,endLine:e.endLine,startOffset:e.startOffset,endOffset:e.endOffset,sourceLength:e.sourceLength})),detail:{entries:res.entries,truncated:res.truncated,skipped:res.skipped}};
    }
  }
}
const splitSentences=(text:string)=>text.split(/(?<=[。！？!?；;])\s*|(?<=\.)\s+(?=[A-Z])|\n+/u).map(t=>t.trim()).filter(Boolean);
const metric=(s:string)=>[...s.normalize("NFKC").matchAll(/(?:\d+(?:[.,]\d+)*)(?:\s*(?:%|ms\b|s\b|QPS\b|TPS\b|万|亿|倍|毫秒|秒|人|年|次))?/gi)].map(m=>m[0].replace(/\s/g,"").toLowerCase());
const ownership=/(?:主导|负责|牵头|推动|实现|搭建|独立|交付|落地|部署|上线|改造|开发|优化|implemented|owned|led\b|built\b|delivered|deployed)/i;
const teamOrPlan=/(?:团队|项目计划|拟建|计划|方案|仅设计|设计稿|未(?:上线|落地|实现|部署)|不(?:是本人|负责)|team\b|planned|proposal|not implemented)/i;
// A personal subject does not become "team context" simply by appending 团队.
// 明确否定/计划语气 can stay as caveats; it is never positive personal proof.
const individual=/(?:我(?:本人|独立|主导|牵头|带领|负责|交付|实现|开发|部署|推进|推动)|本人|个人|由我|\bI\s+(?:led|owned|implemented|built|deployed)|\bmy\s+(?:role|responsibility))/i;
const qualifier=/(?:计划|目标是|设计稿|仅设计|尚未|并未|未(?:上线|投产|落地|实现|部署|实施)|不(?:是本人|负责)|提议|planned|proposal|not (?:implemented|deployed|delivered))/i;
const nonPersonal=(s:string)=>qualifier.test(s)||teamOrPlan.test(s)&&!individual.test(s);
const strengthened=[/(?:主导|牵头|带领|领衔|led\b|owned\b)/i,/(?:独立|独自|solely|single.hand)/i,/(?:上线|投产|投运|生产部署|production|deployed)/i];
const tech=(s:string)=>s.match(/[A-Za-z][A-Za-z0-9.+#_-]{2,}/g)??[];
const excludedEnglish=new Set("the and with for built improved developed worked led using delivered reduced increased on in used from to of an this a role designed implementation implemented team as by managed owned system project supported deployed performance".split(" "));
const sameTarget=(a:CareerTaskPatch["targetRef"],b:CareerTaskPatch["targetRef"])=>a.locale===b.locale&&(a.kind==="profile_headline"?b.kind==="profile_headline":b.kind==="claim_text"&&a.experienceId===b.experienceId&&a.claimId===b.claimId);
export function requireEvidence(task:CareerTask,ids:string[],exposedEvidenceIds?:string[]):CareerTaskEvidence[]{
  return ids.map(id=>{const e=task.evidence.find(v=>v.id===id);if(!e)throw new CareerTaskError("unknown_evidence",422);
    if(exposedEvidenceIds&&!exposedEvidenceIds.includes(id))throw new CareerTaskError("evidence_not_mounted_read_first",422);return e;});
}
/** Deterministic rejection checks, not a claim of semantic verification. Full wording remains subject to human review. */
export function validateDraft(task:CareerTask,decision:Extract<CareerTaskDecision,{kind:"draft"}>,exposedEvidenceIds?:string[]):NonNullable<CareerTask["draft"]>{
  if(!task.evidence.some(e=>e.kind==="job")||!task.evidence.some(e=>e.kind==="resume"))throw new CareerTaskError("read_job_and_resume_first",422);
  if(!decision.patches.length&&!decision.unknowns.length)throw new CareerTaskError("empty_draft",422);
  if(new Set(decision.patches.map(x=>x.fieldId)).size!==decision.patches.length)throw new CareerTaskError("duplicate_patch_target",422);
  const patches:CareerTaskPatch[]=decision.patches.map(p=>{
    const field=task.resume.fields.find(f=>f.id===p.fieldId);
    if(!field || !sameTarget(field.targetRef,p.targetRef)||p.originalText!==field.originalText||p.proposedText.trim()===p.originalText.trim())throw new CareerTaskError("source_field_mismatch",422);
    const refs=requireEvidence(task,p.evidenceIds,exposedEvidenceIds);
    if(!refs.some(e=>e.kind==="resume"&&e.sourceId===`resume:${p.fieldId}`))throw new CareerTaskError("original_resume_evidence_required",422);
    const segments=splitSentences(p.proposedText), sentences=p.sentences??(segments.length===1?[{text:p.proposedText,evidenceIds:p.evidenceIds}]:[]);
    if(!sentences.length || sentences.length!==segments.length || !sentences.every((s,i)=>s.text.trim()===segments[i]))throw new CareerTaskError("sentence_evidence_required",422);
    const oldSegments=splitSentences(p.originalText);
    // One field patch = one independently approvable changed sentence. Never bundle unrelated revisions under one approval.
    if(segments.filter(s=>!oldSegments.includes(s)).length>1||oldSegments.filter(s=>!segments.includes(s)).length>1)throw new CareerTaskError("one_sentence_change_per_patch",422);
    for(const sentence of sentences){
      if(sentence.evidenceIds.some(i=>!p.evidenceIds.includes(i)))throw new CareerTaskError("sentence_evidence_outside_patch",422);
      const cited=requireEvidence(task,sentence.evidenceIds,exposedEvidenceIds),personal=cited.filter(e=>e.kind==="resume"&&e.sourceId===`resume:${p.fieldId}`||e.kind==="user_statement");
      if(!personal.length)throw new CareerTaskError("personal_evidence_required",422);
      const grounded=personal.map(e=>e.excerpt).join("\n");
      if(metric(sentence.text).some(n=>!metric(grounded).includes(n)))throw new CareerTaskError("unsupported_number",422);
      const groundedClauses=personal.flatMap(e=>e.excerpt.split(/[。！？!?;；，,\n]+/)).filter(s=>!nonPersonal(s));
      for(const clause of sentence.text.split(/[;；，,]+/)){
        if(nonPersonal(clause))continue;
        if(metric(clause).some(n=>!groundedClauses.some(s=>metric(s).includes(n))))throw new CareerTaskError("team_metric_not_personal",422);
        if(ownership.test(clause)&&!groundedClauses.some(s=>ownership.test(s)))throw new CareerTaskError("unsupported_personal_contribution",422);
        if(strengthened.some(re=>re.test(clause)&&!groundedClauses.some(s=>re.test(s))))throw new CareerTaskError("unsupported_scope_upgrade",422);
      }
      if(tech(sentence.text).some(t=>!excludedEnglish.has(t.toLowerCase())&&!grounded.toLowerCase().includes(t.toLowerCase())))throw new CareerTaskError("unsupported_technology_or_entity",422);
    }
    return {...p,sentences,id:`patch_${digest([task.id,p]).slice(0,24)}`};
  });
  return {hash:digest([task.id,task.resume.sourceFingerprint,patches,decision.unknowns]),patches,unknowns:decision.unknowns};
}
export const safeCode=(e:unknown):string=>e instanceof CareerTaskError||e instanceof EvidenceAccessError?e.code:"operation_failed";
