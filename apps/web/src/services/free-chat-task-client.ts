import { z } from "zod";
import { FreeChatTaskSchema, FreeChatTaskCreateSchema, ChatMessageSchema, AgentChatContextSchema, careerRuntimeBinding, type FreeChatTask, type AgentChatContext } from "@better-me/agent-contracts";
import { captureIdentityLease, IdentityBoundaryError } from "../lib/identity";
import type { UnderstandingRuntime } from "./understanding-client";
import type { ChatMessage } from "./agent-client";
import { assertTaskScope, taskCreatePayload } from "./agent-task-scope";

import { AgentTaskClientError as FreeChatTaskError, createTaskTransport, taskIssueText as issueText } from "./agent-task-transport";
export { AgentTaskClientError as FreeChatTaskError } from "./agent-task-transport";
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const inputIdentity=(message:z.infer<typeof ChatMessageSchema>)=>({id:message.id,role:message.role,content:message.content,attachments:message.attachments,references:message.references});
const one=z.object({task:FreeChatTaskSchema});
/** One task is one append-only conversation. Reads/reconnects never grant another model dispatch. */
export function createFreeChatTaskClient(options:{fetch?:typeof fetch;baseUrl?:string;pollMs?:number}={}){
  const {request,read,pause}=createTaskTransport(FreeChatTaskSchema,options);
  async function list(workspaceKey:string,signal?:AbortSignal){
    const lease=captureIdentityLease();lease.assert();
    const result=await request("",undefined,signal);lease.assert();
    const rows=z.object({tasks:z.array(z.object({ownerId:z.string()}).passthrough())}).safeParse(result.raw);
    if(!rows.success)throw new FreeChatTaskError("任务列表无法核对，未新建或执行。","invalid_response");
    if(rows.data.tasks.some(task=>task.ownerId!==lease.ownerId))throw new IdentityBoundaryError();
    return rows.data.tasks.filter(row=>row.kind==="free_chat"&&row.workspaceKey===workspaceKey).map(row=>FreeChatTaskSchema.parse(row));
  }
  async function observe(task:FreeChatTask,signal?:AbortSignal,onTask?:(task:FreeChatTask)=>void){
    const lease=captureIdentityLease();lease.assert();onTask?.(task);
    while(task.status==="running"){
      await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(signal?.reason??new DOMException("Observer stopped","AbortError"));};
        const timer=setTimeout(()=>{signal?.removeEventListener("abort",abort);resolve();},options.pollMs??400);signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();});
      lease.assert();task=await read(task.id,signal);onTask?.(task);
    }
    lease.assert();signal?.throwIfAborted();return task;
  }
  /** Reconcile an unknown create using the original stable message ID. GET only. */
  async function find(workspaceKey:string,messageId:string,signal?:AbortSignal){
    const matches=(await list(workspaceKey,signal)).filter(task=>task.conversation.messages[0]?.id===messageId);
    if(matches.length>1)throw new FreeChatTaskError("无法唯一核对原任务，未新建或执行。","conversation_task_unresolved");
    return matches[0];
  }
  /** Explicit reauthorization of the exact saved task, never a new task/budget. */
  async function resume(params:{task:FreeChatTask;rootScopeKey:string;runtime:UnderstandingRuntime;preferredRuntimeId?:string;signal?:AbortSignal;onTask?:(task:FreeChatTask)=>void}){
    const lease=captureIdentityLease();lease.assert();params.signal?.throwIfAborted();
    const binding=careerRuntimeBinding(params.runtime,params.preferredRuntimeId),task=params.task;
    if(task.ownerId!==lease.ownerId)throw new IdentityBoundaryError();
    assertTaskScope(task,params.rootScopeKey);
    if(!same(task.runtimeBinding,binding))throw new FreeChatTaskError(issueText.runtime_binding_changed!,"runtime_binding_changed",task.id);
    if(!["paused","interrupted","budget_exhausted","failed"].includes(task.status))throw new FreeChatTaskError("请先读取并核对任务状态；未自动恢复。","task_not_runnable",task.id);
    return observe(await read(task.id,params.signal,{expectedRevision:task.revision,sourceFingerprint:task.sourceFingerprint,runtimeBinding:binding,consent:true,runtime:params.runtime},"/resume"),params.signal,params.onTask);
  }
  async function send(params:{messages:ChatMessage[];context?:AgentChatContext;workspaceKey:string;rootScopeKey?:string;parentTaskId?:string;runtime:UnderstandingRuntime;preferredRuntimeId?:string;signal?:AbortSignal;onTask?:(task:FreeChatTask)=>void}){
    const lease=captureIdentityLease();lease.assert();params.signal?.throwIfAborted();
    if(!lease.ownerId)throw new FreeChatTaskError("请先登录 BetterMe 账号；未从浏览器直接调用其他模型。","identity_required");
    const messages=z.array(ChatMessageSchema).min(1).parse(params.messages),latest=messages.at(-1)!;
    if(latest.role!=="user")throw new FreeChatTaskError("本次发送必须以用户消息结束。","user_message_required");
    const context=params.context?AgentChatContextSchema.parse(params.context):undefined,binding=careerRuntimeBinding(params.runtime,params.preferredRuntimeId);
    const candidates=await list(params.workspaceKey,params.signal);lease.assert();
    const priorId=[...messages].reverse().find(message=>message.meta?.taskId)?.meta?.taskId;
    const matches=candidates.filter(task=>priorId?task.id===priorId:task.conversation.messages[0]?.id===messages[0]!.id);
    if(matches.length>1||priorId&&!matches.length)throw new FreeChatTaskError("无法唯一核对原对话任务，未通过新建任务重置用量。","conversation_task_unresolved",priorId);
    let task=matches[0];
    if(!task){
      const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify([params.workspaceKey,messages[0]!.id])));
      const key=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,"0")).join("");
      const created=await request("",taskCreatePayload(FreeChatTaskCreateSchema.parse({kind:"free_chat",workspaceKey:params.workspaceKey,rootScopeKey:params.rootScopeKey,parentTaskId:params.parentTaskId,objective:"连续职业对话：回应本轮问题，保留完整授权上下文；所有建议待本人核对。",
        conversation:{messages,context},runtimeBinding:binding,consent:true,idempotencyKey:`chat:${key}`})),params.signal);lease.assert();
      const parsed=one.safeParse(created.raw);if(!parsed.success)throw new FreeChatTaskError("新任务回执无法核对；未执行模型。","invalid_response");
      if(parsed.data.task.ownerId!==lease.ownerId)throw new IdentityBoundaryError();task=parsed.data.task;
    }
    assertTaskScope(task,params.rootScopeKey);params.onTask?.(task);lease.assert();
    if(!same(task.runtimeBinding,binding))throw new FreeChatTaskError(issueText.runtime_binding_changed!,"runtime_binding_changed",task.id);
    if(!same(task.conversation.context??{},context??{}))throw new FreeChatTaskError("共享范围或项目共识已变化，请先核对原对话；未重发旧授权资料，也未新建任务清账。","conversation_scope_changed",task.id);
    const known=new Map(task.conversation.messages.map(message=>[message.id,message]));
    for(const message of messages){const old=known.get(message.id);if(old&&!same(inputIdentity(old),inputIdentity(message)))throw new FreeChatTaskError("已登记的消息原文发生变化，未覆盖旧历史。","conversation_history_changed",task.id);}
    const duplicate=known.get(latest.id);
    if(!duplicate){
      const prior=messages.slice(0,-1);
      if(!same(prior.map(inputIdentity),task.conversation.messages.map(inputIdentity)))throw new FreeChatTaskError("当前页面与任务历史不一致，请先读取任务结果；没有丢弃历史或自动另开对话。","conversation_history_changed",task.id);
      if(task.status!=="awaiting_answer")throw new FreeChatTaskError(`原任务处于 ${task.status}，请先核对后明确恢复；未自动重放。`,task.error??"task_not_runnable",task.id);
    }else if(duplicate.role!=="user")throw new FreeChatTaskError("消息标识冲突。","conversation_history_changed",task.id);
    if(!duplicate||task.status==="ready"){
      task=await read(task.id,params.signal,{expectedRevision:task.revision,sourceFingerprint:task.sourceFingerprint,runtimeBinding:binding,consent:true,runtime:params.runtime,...(!duplicate?{message:latest}:{})},duplicate?"/start":"/answer");
      params.onTask?.(task);lease.assert();
    }
    task=await observe(task,params.signal,params.onTask);
    lease.assert();params.signal?.throwIfAborted();
    if(task.status!=="awaiting_answer"||!task.reply||task.conversation.messages.at(-2)?.id!==latest.id)throw new FreeChatTaskError(issueText[task.error??""]??`任务处于 ${task.status}，没有完整回复；原始记录仍在任务内，未自动重试。`,task.error??"reply_not_ready",task.id);
    return task.reply;
  }
  return {send,get:read,pause,find,observe,resume};
}
export const defaultFreeChatTaskClient=createFreeChatTaskClient();
