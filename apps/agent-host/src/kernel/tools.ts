import { decomposeJdText } from "@better-me/core";
import type { CareerTask, CareerTaskDecision, UnderstandingGrant } from "@better-me/agent-contracts";
import type { EvidenceBroker } from "../understanding/evidence-broker.js";
import { CareerTaskError, evidence, observe, type Observation } from "../tasks/evidence.js";
import { evidenceIndex } from "./context.js";
import { evidenceManifest, resolveEvidenceHandle } from "./evidence-retrieval.js";

type ToolName = Extract<CareerTaskDecision, {kind:"tool"}>["tool"];
type TaskTool = {tool:ToolName;description:string;arguments:string;effect:"read"};
const catalog:TaskTool[] = [
  {tool:"discover_tools",description:"List tools available within this task's exact grants.",arguments:"none",effect:"read"},
  {tool:"list_evidence",description:"Page source handles without summarizing facts.",arguments:"offset? (index), length? (max 40)",effect:"read"},
  {tool:"read_evidence",description:"Read an exact page from an authorized evidence/manifest handle; no new authority. Hash and grant are checked again.",arguments:"id (evidence ID or ref_ manifest handle), offset?, length? (end-exclusive UTF-16 units; default page 2400)",effect:"read"},
  {tool:"build_tool",description:"Generate and qualify a task-local pure JSON tool using this task's runtime and shared budget. Only material-lines-v1 is implemented.",arguments:"id='material-lines-v1'",effect:"read"},
  {tool:"use_tool",description:"Run an exact qualified version on a selected material, independently check actual output. Cannot save or install.",arguments:"id (version), materialId, offset? (record index), length? (max 40)",effect:"read"},
  {tool:"read_job",description:"Read pinned target JD; requirements are not applicant facts.",arguments:"startLine?, endLine?",effect:"read"},
  {tool:"decompose_job",description:"Deterministically decompose the pinned JD; no model or external search.",arguments:"none",effect:"read"},
  {tool:"read_resume",description:"Read authorized original resume fields.",arguments:"id? (field), startLine?, endLine?",effect:"read"},
  {tool:"search_materials",description:"Literal search of explicitly selected material texts.",arguments:"query",effect:"read"},
  {tool:"read_material",description:"Read an explicitly selected material.",arguments:"id (material), startLine?, endLine?",effect:"read"},
  {tool:"list_directory",description:"List an authorized directory, without following unsafe links.",arguments:"id (directory grant), path?",effect:"read"},
  {tool:"search_directory",description:"Bounded literal search inside a directory grant.",arguments:"id (directory grant), query, path?",effect:"read"},
  {tool:"read_file",description:"Read a bounded file span inside a directory grant.",arguments:"id (directory grant), path, startLine?, endLine?",effect:"read"},
];
/** Discovery and dispatch use the same policy; knowing a tool's name never grants it. */
export function taskTools(task:CareerTask):TaskTool[]{
  return catalog.filter(t=>!(t.tool==="search_materials"||t.tool==="read_material")||task.materials.length)
    .filter(t=>t.tool!=="build_tool"||task.toolPolicy?.allowBuild)
    .filter(t=>t.tool!=="use_tool"||Boolean(task.tools?.length||task.toolPolicy?.installedVersionIds.length))
    .filter(t=>!(t.tool==="list_directory"||t.tool==="search_directory"||t.tool==="read_file")||task.directories.length)
    .map(t=>({...t}));
}
export async function executeTaskTool(task:CareerTask,grants:UnderstandingGrant[],broker:EvidenceBroker,request:Extract<CareerTaskDecision,{kind:"tool"}>,signal:AbortSignal,statements:Record<string,string>={}):Promise<Observation>{
  signal.throwIfAborted();
  if(!taskTools(task).some(t=>t.tool===request.tool))throw new CareerTaskError("tool_not_granted",403);
  if(request.tool==="discover_tools")return {evidence:[],detail:{availableTools:taskTools(task)}};
  if(request.tool==="list_evidence"){const offset=request.offset??0,length=Math.min(40,request.length??40);return {evidence:[],detail:{items:evidenceIndex(task.evidence.slice(offset,offset+length)),evidenceManifest:evidenceManifest(task.evidence.slice(offset,offset+length)),total:task.evidence.length,nextOffset:offset+length<task.evidence.length?offset+length:null}};}
  if(request.tool==="read_evidence"){
    const item=task.evidence.find(e=>e.id===request.id)??resolveEvidenceHandle(task.evidence,request.id??"");if(!item)throw new CareerTaskError("unknown_evidence",422);
    const explicitLines=request.startLine!==undefined||request.endLine!==undefined;
    const offset=explicitLines&&request.offset===undefined?undefined:request.offset??item.startOffset??0;
    const length=explicitLines&&request.length===undefined?undefined:request.length??2400;
    if(item.sourceId.startsWith("dir:")){
      const legacyRange=item.startOffset===undefined&&!explicitLines&&request.offset===undefined;
      const result=await observe(task,grants,broker,{...request,offset:legacyRange?undefined:offset,length,
        ...(legacyRange?{startLine:item.startLine,endLine:item.endLine}:{}),tool:"read_file",id:item.sourceId.slice(4),path:item.path},signal);
      if(result.evidence.some(e=>e.hash!==item.hash))throw new CareerTaskError("source_changed_new_comparison_required");
      const page=result.evidence[0];return {...result,detail:{...result.detail as object,rehydratedFrom:request.id,nextOffset:page&&page.endOffset!<page.sourceLength!?page.endOffset:null}};
    }
    const full=item.sourceId==="job"?[task.job.title,task.job.company,task.job.description].join("\n"):
      item.sourceId.startsWith("resume:")?task.resume.fields.find(f=>`resume:${f.id}`===item.sourceId)?.originalText:
      item.sourceId.startsWith("material:")?task.materials.find(m=>`material:${m.id}`===item.sourceId)?.text:statements[item.sourceId];
    if(full===undefined)throw new CareerTaskError("source_rehydration_unavailable",422);
    const page=evidence(item.kind,item.sourceId,item.label,full,request.startLine??1,request.endLine,offset,length);
    if(page.hash!==item.hash)throw new CareerTaskError("source_changed_new_comparison_required");
    return {evidence:[page],detail:{rehydratedFrom:request.id,nextOffset:page.endOffset!<full.length?page.endOffset:null,totalLength:full.length}};
  }
  if(request.tool==="decompose_job")return {evidence:[evidence("job","job",task.job.title,[task.job.title,task.job.company,task.job.description].join("\n"))],detail:{requirements:decomposeJdText(task.job.description),derived:true}};
  return observe(task,grants,broker,request,signal);
}
