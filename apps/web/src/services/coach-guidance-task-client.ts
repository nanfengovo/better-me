import { z } from "zod";
import { CoachGuidanceTaskCreateSchema, CoachGuidanceTaskSchema, careerRuntimeBinding, type CoachGuidanceTask } from "@better-me/agent-contracts";
import { validateCoachRequest } from "@better-me/agent-contracts/career-coach-protocol";
import type { CoachRequest } from "@better-me/agent-contracts/career-coach";
import { captureIdentityLease, IdentityBoundaryError } from "../lib/identity";
import { assertTaskScope, taskCreatePayload } from "./agent-task-scope";
import { AgentTaskClientError, createTaskTransport, taskIssueText, type TaskClientOptions } from "./agent-task-transport";
import type { UnderstandingRuntime } from "./understanding-client";

const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const hash=async(value:unknown)=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(value)))),byte=>byte.toString(16).padStart(2,"0")).join("");
export type CoachTaskParams={workspaceKey:string;rootScopeKey:string;parentTaskId?:string;request:CoachRequest;runtime:UnderstandingRuntime;preferredRuntimeId?:string;
  signal?:AbortSignal;onTask?:(task:CoachGuidanceTask)=>void;resume?:boolean;resumeTaskId?:string;consent:true};

/** Frozen coaching requests and their complete results live in the owner kernel.
 * Reopening/observing never dispatches. An interrupted attempt needs explicit resume. */
export function createCoachGuidanceTaskClient(options:TaskClientOptions={}){
  const {request,read,pause}=createTaskTransport(CoachGuidanceTaskSchema,options),one=z.object({task:CoachGuidanceTaskSchema});
  async function generate(params:CoachTaskParams){
    const lease=captureIdentityLease();lease.assert();params.signal?.throwIfAborted();
    if(!lease.ownerId)throw new AgentTaskClientError("请先登录 BetterMe；没有从浏览器直调模型。","identity_required");
    if(params.consent!==true)throw new AgentTaskClientError("请先核对本次目标与共享资料，再明确生成。","consent_required");
    const safe=validateCoachRequest(params.request),binding=careerRuntimeBinding(params.runtime,params.preferredRuntimeId);
    const listed=z.object({tasks:z.array(z.object({ownerId:z.string()}).passthrough())}).parse((await request("",undefined,params.signal)).raw);lease.assert();
    if(listed.tasks.some(row=>row.ownerId!==lease.ownerId))throw new IdentityBoundaryError();
    const matches=listed.tasks.filter(row=>row.kind==="career_coach"&&row.workspaceKey===params.workspaceKey).map(row=>CoachGuidanceTaskSchema.parse(row)).filter(task=>same(task.request,safe));
    if(matches.length>1)throw new AgentTaskClientError("本次成长任务无法唯一核对；没有新建任务清账。","coach_task_unresolved");
    let task=matches[0];
    if(params.resume&&(!task||task.id!==params.resumeTaskId))throw new AgentTaskClientError("原任务与这次核对的完整请求不一致；没有另建任务或扩大授权。","coach_scope_changed",params.resumeTaskId);
    if(!task){
      const created=one.parse((await request("",taskCreatePayload(CoachGuidanceTaskCreateSchema.parse({kind:"career_coach",workspaceKey:params.workspaceKey,rootScopeKey:params.rootScopeKey,parentTaskId:params.parentTaskId,
        objective:"根据本次明确目标和授权材料提供职业成长参考；未知先问，候选由本人决定。",request:safe,runtimeBinding:binding,consent:true,
        idempotencyKey:`coach:${await hash([params.workspaceKey,safe])}`})),params.signal)).raw);lease.assert();task=created.task;
    }
    if(task.ownerId!==lease.ownerId)throw new IdentityBoundaryError();
    assertTaskScope(task,params.rootScopeKey);params.onTask?.(task);lease.assert();params.signal?.throwIfAborted();
    if(!same(task.runtimeBinding,binding))throw new AgentTaskClientError(taskIssueText.runtime_binding_changed!,"runtime_binding_changed",task.id);
    if(!same(task.request,safe))throw new AgentTaskClientError("本次目标或资料与原任务不一致，未覆盖原授权。","coach_scope_changed",task.id);
    if(task.status==="ready"||params.resume&&["paused","interrupted","budget_exhausted","failed"].includes(task.status)){
      task=await read(task.id,params.signal,{expectedRevision:task.revision,sourceFingerprint:task.sourceFingerprint,runtimeBinding:binding,consent:true,runtime:params.runtime},task.status==="ready"?"/start":"/resume");
      params.onTask?.(task);lease.assert();
    }
    while(task.status==="running"){
      await new Promise<void>((resolve,reject)=>{const signal=params.signal,abort=()=>{clearTimeout(timer);reject(signal?.reason??new DOMException("Observer stopped","AbortError"));};
        const timer=setTimeout(()=>{signal?.removeEventListener("abort",abort);resolve();},options.pollMs??400);signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();});
      lease.assert();task=await read(task.id,params.signal);params.onTask?.(task);
    }
    lease.assert();params.signal?.throwIfAborted();
    if(task.status!=="completed"||!task.result)throw new AgentTaskClientError(taskIssueText[task.error??""]??`任务处于 ${task.status}；完整记录和额度保留，请核对后明确恢复，没有自动重发。`,task.error??"coach_result_not_ready",task.id);
    return {...task.result,task:{id:task.id,revision:task.revision,rootTaskId:task.rootTaskId??task.id}};
  }
  return {generate,get:read,pause};
}
export const defaultCoachGuidanceTaskClient=createCoachGuidanceTaskClient();
