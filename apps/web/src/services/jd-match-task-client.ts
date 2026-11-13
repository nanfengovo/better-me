import { z } from "zod";
import { JdMatchMaterialSchema,JdMatchTaskCreateSchema,JdMatchTaskSchema,careerRuntimeBinding,type JdMatchMaterial,type JdMatchTask } from "@better-me/agent-contracts";
import { getJdMatchReadiness,type ProjectedResume } from "@better-me/core";
import { captureIdentityLease,IdentityBoundaryError } from "../lib/identity";
import type { UnderstandingRuntime } from "./understanding-client";
import { assertTaskScope,taskCreatePayload } from "./agent-task-scope";
import { AgentTaskClientError,createTaskTransport,taskIssueText,type TaskClientOptions } from "./agent-task-transport";
import type { MatchProposal,ProposalDecision } from "./agent-client";

const hash=async(value:unknown)=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(value)))),byte=>byte.toString(16).padStart(2,"0")).join("");
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
/** Only the visible projection, not hidden facts, is explicitly shared. IDs locate self-report, never verify it. */
export function jdMatchResumeMaterial(resume:ProjectedResume|null):Pick<JdMatchMaterial,"allowedProfileEntryIds"|"sessionClaims">{
  const sessionClaims:Record<string,string>=Object.create(null),allowedProfileEntryIds:string[]=[];
  const put=(key:string,value:string)=>{
    if(Object.hasOwn(sessionClaims,key))throw new AgentTaskClientError("简历条目标识重复，未发送混淆的资料。","duplicate_profile_id");
    sessionClaims[key]=value;
  };
  if(!resume)return {sessionClaims,allowedProfileEntryIds};
  for(const [key,value] of Object.entries({headline:resume.profile.headline,education:resume.profile.education,education_summary:resume.educationSummary,
    location:resume.profile.location,skills:resume.skills?.join(", "),traits:resume.profile.traits?.join(", "),target_roles:resume.profile.targetRoles?.join(", ")}))if(value)put(`profile:${key}`,value);
  for(const exp of resume.experiences){
    put(`experience:${exp.id}`,[exp.type,exp.org,exp.title,exp.start,exp.end??"至今",exp.projectName??"",...exp.techStack].join("\n"));
    for(const claim of exp.claims){put(claim.id,claim.text);allowedProfileEntryIds.push(claim.id);}
  }
  return {sessionClaims,allowedProfileEntryIds};
}
export function createJdMatchTaskClient(options:TaskClientOptions={}){
  const {request,read,pause}=createTaskTransport(JdMatchTaskSchema,options),one=z.object({task:JdMatchTaskSchema});
  async function existing(params:{workspaceKey:string;matching:JdMatchMaterial;signal?:AbortSignal}){
    const workspaceKey=`jd:${await hash([params.workspaceKey,params.matching.rawJd,...(params.matching.reportRequested?["full-report"]:[])])}`;
    const reply=await request("",undefined,params.signal);
    const rows=z.object({tasks:z.array(z.object({ownerId:z.string()}).passthrough())}).safeParse(reply.raw);
    if(!rows.success)throw new AgentTaskClientError("任务列表无法核对，未新建或派送。","invalid_response");
    if(rows.data.tasks.some(row=>row.ownerId!==reply.ownerId))throw new IdentityBoundaryError();
    const candidates=rows.data.tasks.filter(row=>row.kind==="jd_match"&&row.workspaceKey===workspaceKey).map(row=>JdMatchTaskSchema.parse(row));
    if(candidates.length>1)throw new AgentTaskClientError("无法唯一核对岗位分析任务，未新建清账。","jd_task_unresolved");
    return {workspaceKey,task:candidates[0]};
  }
  async function prepare(params:{workspaceKey:string;rootScopeKey?:string;parentTaskId?:string;matching:JdMatchMaterial;consent:true;
    runtime:UnderstandingRuntime;preferredRuntimeId?:string;signal?:AbortSignal;onTask?:(task:JdMatchTask)=>void}){
    const lease=captureIdentityLease();lease.assert();params.signal?.throwIfAborted();
    if(!lease.ownerId)throw new AgentTaskClientError("请先登录 BetterMe；未从浏览器直接调用模型。","identity_required");
    if(params.consent!==true)throw new AgentTaskClientError("请先明确授权当前岗位与简历资料。","jd_consent_required");
    const matching=JdMatchMaterialSchema.parse(params.matching),binding=careerRuntimeBinding(params.runtime,params.preferredRuntimeId);
    const found=await existing({...params,matching});lease.assert();const {workspaceKey}=found;let task=found.task;
    if(!task){
      const created=await request("",taskCreatePayload(JdMatchTaskCreateSchema.parse({kind:"jd_match",workspaceKey,rootScopeKey:params.rootScopeKey,parentTaskId:params.parentTaskId,
        objective:"逐条核对岗位原句与已授权自述，缺事实先问；建议由本人逐条审阅，不自动采用。",matching,runtimeBinding:binding,consent:true,idempotencyKey:`jd:${await hash(workspaceKey)}`})),params.signal);lease.assert();
      const parsed=one.safeParse(created.raw);if(!parsed.success)throw new AgentTaskClientError("新岗位分析任务回执无法核对，未执行。","invalid_response");
      if(parsed.data.task.ownerId!==lease.ownerId)throw new IdentityBoundaryError();task=parsed.data.task;
    }
    assertTaskScope(task,params.rootScopeKey);params.onTask?.(task);lease.assert();
    if(!same(task.runtimeBinding,binding))throw new AgentTaskClientError(taskIssueText.runtime_binding_changed!,"runtime_binding_changed",task.id);
    if(!same(task.matching,matching))throw new AgentTaskClientError("当前简历或岗位共享范围已变化，请先核对原任务；未覆盖记录、发送旧资料或新建清账。","jd_scope_changed",task.id);
    return task;
  }
  /** A JD can parent a focused interview without running a second analysis. */
  async function match(params:Parameters<typeof prepare>[0]){
    const lease=captureIdentityLease();lease.assert();
    let task=await prepare(params);
    const binding=careerRuntimeBinding(params.runtime,params.preferredRuntimeId);
    if(task.status==="ready"){
      task=await read(task.id,params.signal,{expectedRevision:task.revision,sourceFingerprint:task.sourceFingerprint,runtimeBinding:binding,runtime:params.runtime,consent:true},"/start");params.onTask?.(task);
    }
    while(task.status==="running"){
      await new Promise<void>((resolve,reject)=>{const signal=params.signal,abort=()=>{clearTimeout(timer);reject(signal?.reason??new DOMException("Observer stopped","AbortError"));};
        const timer=setTimeout(()=>{signal?.removeEventListener("abort",abort);resolve();},options.pollMs??400);signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();});
      lease.assert();task=await read(task.id,params.signal);params.onTask?.(task);
    }
    lease.assert();params.signal?.throwIfAborted();
    if(!["awaiting_review","completed"].includes(task.status)||!task.result)throw new AgentTaskClientError(taskIssueText[task.error??""]??`任务处于 ${task.status}，完整记录保留；没有自动恢复、重试或切换模型。`,task.error??"jd_result_not_ready",task.id);
    return task;
  }
  async function review(id:string,decisions:Record<string,ProposalDecision>,currentProposals:MatchProposal[],matching:JdMatchMaterial){
    const task=await read(id);
    if(!same(task.matching,JdMatchMaterialSchema.parse(matching)))throw new AgentTaskClientError("当前岗位或简历已变化，未采用旧来源的提案；原记录与用量保留。","jd_scope_changed",id);
    const identity=(items:MatchProposal[])=>items.map(({id,jdItem,evidenceType,profileEntryId,suggestion,rationale})=>({id,jdItem,evidenceType,profileEntryId,suggestion,rationale}));
    if(!task.result||!same(identity(task.result.proposals),identity(currentProposals)))throw new AgentTaskClientError("页面与完整任务提案不一致，未确认选择。","jd_review_changed",id);
    if(Object.keys(decisions).some(key=>!task.result!.proposals.some(item=>item.id===key)))throw new AgentTaskClientError("选择包含未知提案，未确认。","jd_review_changed",id);
    // The explicit Apply selected action excludes unselected proposals. This
    // classification executes no model and cannot modify career records.
    const complete=Object.fromEntries(task.result.proposals.map(item=>[item.id,decisions[item.id]??{status:"rejected" as const}]));
    if(task.status==="completed"){
      if(!same(task.review,complete))throw new AgentTaskClientError("原任务已经确认另一组选择，未覆盖回执。","jd_review_changed",id);
      return task;
    }
    return read(id,undefined,{expectedRevision:task.revision,consent:true,decisions:complete},"/jd-review");
  }
  type ReportParams=Omit<Parameters<typeof match>[0],"matching">&{rawJd:string;resume:ProjectedResume};
  async function report(params:ReportParams){
    const readiness=getJdMatchReadiness(params.resume);
    if(!readiness.ready)throw new AgentTaskClientError(readiness.message,"resume_not_ready");
    const task=await match({...params,matching:{rawJd:params.rawJd,...jdMatchResumeMaterial(params.resume),reportRequested:true}});
    if(!task.result?.report)throw new AgentTaskClientError("完整报告尚未形成；原任务记录保留，没有另发模型请求。","jd_full_report_required",task.id);
    return {task,report:task.result.report};
  }
  /** Restoring an artifact is read-only: no create, start, repair, budget or grant. */
  async function findReport(params:Omit<ReportParams,"consent">){
    const lease=captureIdentityLease();lease.assert();
    if(!lease.ownerId||!getJdMatchReadiness(params.resume).ready)return undefined;
    const matching=JdMatchMaterialSchema.parse({rawJd:params.rawJd,...jdMatchResumeMaterial(params.resume),reportRequested:true});
    const {task}=await existing({...params,matching});lease.assert();params.signal?.throwIfAborted();
    if(!task||!same(task.matching,matching)||!same(task.runtimeBinding,careerRuntimeBinding(params.runtime,params.preferredRuntimeId)))return undefined;
    assertTaskScope(task,params.rootScopeKey);
    return {task,report:task.result?.report};
  }
  async function find(params:Omit<Parameters<typeof prepare>[0],"consent">){
    const lease=captureIdentityLease();lease.assert();
    if(!lease.ownerId)return undefined;
    const {task}=await existing(params);lease.assert();
    if(!task)return undefined;
    assertTaskScope(task,params.rootScopeKey);
    if(!same(task.matching,JdMatchMaterialSchema.parse(params.matching)))throw new AgentTaskClientError("当前简历或岗位共享范围已变化，原记录保留。","jd_scope_changed",task.id);
    return task;
  }
  return {prepare,find,match,report,findReport,review,get:read,pause};
}
export const defaultJdMatchTaskClient=createJdMatchTaskClient();
