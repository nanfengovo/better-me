import { z } from "zod";
import { ExperienceRefineTaskCreateSchema, ExperienceRefineTaskSchema, ExperienceRefinementSchema, careerRuntimeBinding, type ExperienceRefineTask } from "@better-me/agent-contracts";
import { captureIdentityLease, IdentityBoundaryError } from "../lib/identity";
import type { UnderstandingRuntime } from "./understanding-client";
import { assertTaskScope, taskCreatePayload } from "./agent-task-scope";
import { AgentTaskClientError, createTaskTransport, taskIssueText, type TaskClientOptions } from "./agent-task-transport";
export { AgentTaskClientError as ExperienceRefineTaskError } from "./agent-task-transport";
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const hash=async(value:unknown)=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(value)))),byte=>byte.toString(16).padStart(2,"0")).join("");

/** One stable writing note, frozen source/background, cumulative turns and repairs. */
export function createExperienceRefineTaskClient(options:TaskClientOptions={}){
  const {request,read,pause}=createTaskTransport(ExperienceRefineTaskSchema,options),one=z.object({task:ExperienceRefineTaskSchema});
  async function refine(params:{workspaceKey:string;rootScopeKey?:string;parentTaskId?:string;refinement:z.infer<typeof ExperienceRefinementSchema>;supplement:string;supplementConfirmed:true;
    runtime:UnderstandingRuntime;preferredRuntimeId?:string;signal?:AbortSignal;onTask?:(task:ExperienceRefineTask)=>void}){
    const lease=captureIdentityLease();lease.assert();params.signal?.throwIfAborted();
    if(!lease.ownerId)throw new AgentTaskClientError("请先登录 BetterMe，未直接从浏览器调用模型。","identity_required");
    if(params.supplementConfirmed!==true)throw new AgentTaskClientError("请先确认本人补充；未提交模型。","confirmed_supplement_required");
    const refinement=ExperienceRefinementSchema.parse(params.refinement),binding=careerRuntimeBinding(params.runtime,params.preferredRuntimeId);
    const rows=z.object({tasks:z.array(z.object({ownerId:z.string()}).passthrough())}).safeParse((await request("",undefined,params.signal)).raw);lease.assert();
    if(!rows.success)throw new AgentTaskClientError("任务列表无法核对，未新建或派送。","invalid_response");
    if(rows.data.tasks.some(row=>row.ownerId!==lease.ownerId))throw new IdentityBoundaryError();
    const matches=rows.data.tasks.filter(row=>row.kind==="experience_refine"&&row.workspaceKey===params.workspaceKey).map(row=>ExperienceRefineTaskSchema.parse(row));
    if(matches.length>1)throw new AgentTaskClientError("无法唯一核对原伴写任务，未新建清账。","refinement_task_unresolved");
    let task=matches[0];
    if(!task){
      const created=await request("",taskCreatePayload(ExperienceRefineTaskCreateSchema.parse({kind:"experience_refine",workspaceKey:params.workspaceKey,rootScopeKey:params.rootScopeKey,parentTaskId:params.parentTaskId,
        objective:"核对当前字段的本人动作和可观察结果；缺关键事实先问，候选由本人审阅采用。",refinement,
        conversation:{messages:[{id:`supp_${await hash([params.workspaceKey,1,params.supplement])}`,role:"user",content:params.supplement}]},
        runtimeBinding:binding,consent:true,supplementConfirmed:true,idempotencyKey:`refine:${await hash(params.workspaceKey)}`})),params.signal);lease.assert();
      const parsed=one.safeParse(created.raw);if(!parsed.success)throw new AgentTaskClientError("新伴写任务回执无法核对，未执行。","invalid_response");
      if(parsed.data.task.ownerId!==lease.ownerId)throw new IdentityBoundaryError();task=parsed.data.task;
    }
    assertTaskScope(task,params.rootScopeKey);params.onTask?.(task);lease.assert();params.signal?.throwIfAborted();
    if(!same(task.runtimeBinding,binding))throw new AgentTaskClientError(taskIssueText.runtime_binding_changed!,"runtime_binding_changed",task.id);
    if(!same(task.refinement,refinement))throw new AgentTaskClientError("原文字段、引用或共享背景已变化，未覆盖原任务、重发旧资料或新建清账。","refinement_scope_changed",task.id);
    const previous=task.conversation.messages.filter(message=>message.role==="user").at(-1)!;
    const duplicate=previous.content===params.supplement;
    if(!duplicate&&task.status!=="awaiting_answer")throw new AgentTaskClientError(`原任务处于 ${task.status}，请先核对后明确恢复；没有自动重发。`,task.error??"task_not_runnable",task.id);
    if(!duplicate||task.status==="ready"){
      task=await read(task.id,params.signal,{expectedRevision:task.revision,sourceFingerprint:task.sourceFingerprint,runtimeBinding:binding,consent:true,runtime:params.runtime,
        ...(!duplicate?{supplementConfirmed:true,message:{id:`supp_${await hash([task.id,task.turn+1,params.supplement])}`,role:"user",content:params.supplement}}:{})},duplicate?"/start":"/answer");
      params.onTask?.(task);lease.assert();
    }
    while(task.status==="running"){
      await new Promise<void>((resolve,reject)=>{const signal=params.signal,abort=()=>{clearTimeout(timer);reject(signal?.reason??new DOMException("Observer stopped","AbortError"));};
        const timer=setTimeout(()=>{signal?.removeEventListener("abort",abort);resolve();},options.pollMs??400);signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();});
      lease.assert();task=await read(task.id,params.signal);params.onTask?.(task);
    }
    lease.assert();params.signal?.throwIfAborted();
    if(task.status!=="awaiting_answer"||!task.refinementReply||task.conversation.messages.filter(message=>message.role==="user").at(-1)?.content!==params.supplement)
      throw new AgentTaskClientError(taskIssueText[task.error??""]??`任务处于 ${task.status}，没有完整伴写回执；原始输出保留，未自动重试。`,task.error??"reply_not_ready",task.id);
    return task.refinementReply;
  }
  return {refine,get:read,pause};
}
export const defaultExperienceRefineTaskClient=createExperienceRefineTaskClient();
