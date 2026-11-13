import { z } from "zod";
import { JdIntakeRequestSchema, JdIntakeTaskCreateSchema, JdIntakeTaskSchema, careerRuntimeBinding, type JdIntakeRequest, type JdIntakeTask } from "@better-me/agent-contracts";
import { captureIdentityLease, IdentityBoundaryError } from "../lib/identity";
import { assertTaskScope, taskCreatePayload } from "./agent-task-scope";
import { AgentTaskClientError, createTaskTransport, taskIssueText, type TaskClientOptions } from "./agent-task-transport";
import type { UnderstandingRuntime } from "./understanding-client";

const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export type JdIntakeParams={workspaceKey:string;rootScopeKey:string;parentTaskId?:string;request:JdIntakeRequest;runtime:UnderstandingRuntime;preferredRuntimeId?:string;
  consent:true;signal?:AbortSignal;onTask?:(task:JdIntakeTask)=>void;resumeTaskId?:string};

/** Complete frozen source, one owner task. Read/reconnect never replays inference. */
export function createJdIntakeTaskClient(options:TaskClientOptions={}){
  const {request,read,pause}=createTaskTransport(JdIntakeTaskSchema,options);
  async function generate(params:JdIntakeParams){
    const lease=captureIdentityLease();lease.assert();params.signal?.throwIfAborted();
    if(!lease.ownerId)throw new AgentTaskClientError("请先登录 BetterMe；未从浏览器直调模型。","identity_required");
    if(params.consent!==true)throw new AgentTaskClientError("请先授权本次完整岗位文字的模型提取。","consent_required");
    const safe=JdIntakeRequestSchema.parse(params.request),binding=careerRuntimeBinding(params.runtime,params.preferredRuntimeId);
    const rows=z.object({tasks:z.array(z.object({ownerId:z.string()}).passthrough())}).parse((await request("",undefined,params.signal)).raw);lease.assert();
    if(rows.tasks.some(row=>row.ownerId!==lease.ownerId))throw new IdentityBoundaryError();
    const matches=rows.tasks.filter(row=>row.kind==="jd_intake"&&row.workspaceKey===params.workspaceKey).map(row=>JdIntakeTaskSchema.parse(row)).filter(task=>same(task.request,safe));
    if(matches.length>1)throw new AgentTaskClientError("无法唯一核对原提取任务，未新建任务清账。","intake_task_unresolved");
    let task=matches[0];
    if(params.resumeTaskId&&task?.id!==params.resumeTaskId)throw new AgentTaskClientError("完整来源或原任务不一致，未恢复或新建任务。","intake_source_changed",params.resumeTaskId);
    if(!task){
      const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify([params.workspaceKey,safe])));
      const key=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,"0")).join("");
      task=z.object({task:JdIntakeTaskSchema}).parse((await request("",taskCreatePayload(JdIntakeTaskCreateSchema.parse({kind:"jd_intake",workspaceKey:params.workspaceKey,rootScopeKey:params.rootScopeKey,parentTaskId:params.parentTaskId,
        objective:"完整岗位文字中提取可核对原文坐标的字段；未知留空，结果由本人审阅。",request:safe,runtimeBinding:binding,consent:true,idempotencyKey:`jd-intake:${key}`})),params.signal)).raw).task;
    }
    lease.assert();if(task.ownerId!==lease.ownerId)throw new IdentityBoundaryError();assertTaskScope(task,params.rootScopeKey);
    if(!same(task.runtimeBinding,binding))throw new AgentTaskClientError(taskIssueText.runtime_binding_changed!,"runtime_binding_changed",task.id);
    if(!same(task.request,safe))throw new AgentTaskClientError("原岗位材料已变化，未覆盖原授权。","intake_source_changed",task.id);
    params.onTask?.(task);params.signal?.throwIfAborted();
    if(task.status==="ready"||params.resumeTaskId&&["paused","interrupted","failed","budget_exhausted"].includes(task.status)){
      task=await read(task.id,params.signal,{expectedRevision:task.revision,sourceFingerprint:task.sourceFingerprint,runtimeBinding:binding,consent:true,runtime:params.runtime},task.status==="ready"?"/start":"/resume");
      lease.assert();params.onTask?.(task);
    }
    while(task.status==="running"){
      await new Promise<void>((resolve,reject)=>{const signal=params.signal,abort=()=>{clearTimeout(timer);reject(signal?.reason??new DOMException("Observer stopped","AbortError"));};
        const timer=setTimeout(()=>{signal?.removeEventListener("abort",abort);resolve();},options.pollMs??400);signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();});
      lease.assert();task=await read(task.id,params.signal);params.onTask?.(task);
    }
    lease.assert();params.signal?.throwIfAborted();
    if(task.status!=="completed"||!task.result)throw new AgentTaskClientError(taskIssueText[task.error??""]??`原任务处于 ${task.status}；完整输入输出和额度已保留，须核对并授权后恢复。`,task.error??"intake_not_ready",task.id);
    return task;
  }
  return {generate,get:read,pause};
}
export const defaultJdIntakeTaskClient=createJdIntakeTaskClient();
