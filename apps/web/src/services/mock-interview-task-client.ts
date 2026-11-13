import {z} from "zod";
import {MockInterviewTaskSchema,MockInterviewTaskCreateSchema,MockInterviewFocusSchema,JdMatchMaterialSchema,careerRuntimeBinding,type MockInterviewTask,type MockInterviewFocus,type JdMatchMaterial} from "@better-me/agent-contracts";
import {captureIdentityLease,IdentityBoundaryError} from "../lib/identity";
import {assertTaskScope,taskCreatePayload} from "./agent-task-scope";
import {createTaskTransport,AgentTaskClientError,taskIssueText,type TaskClientOptions} from "./agent-task-transport";
import {createJdMatchTaskClient} from "./jd-match-task-client";
import type {UnderstandingRuntime} from "./understanding-client";

export type InterviewTaskParams={workspaceKey:string;rootScopeKey:string;matching:JdMatchMaterial;focus:MockInterviewFocus;
  runtime:UnderstandingRuntime;preferredRuntimeId?:string;signal?:AbortSignal;onTask?:(task:MockInterviewTask)=>void};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const digest=async(value:unknown)=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(value)))),byte=>byte.toString(16).padStart(2,"0")).join("");

/** All inference crosses the existing task transport. Recovery is GET-only;
 * answers use the displayed revision and never retry against a new question. */
export function createMockInterviewTaskClient(options:TaskClientOptions={}){
  const {request,read,pause}=createTaskTransport(MockInterviewTaskSchema,options),jd=createJdMatchTaskClient(options);
  function verify(task:MockInterviewTask,params:InterviewTaskParams,execution=false){
    assertTaskScope(task,params.rootScopeKey);
    if(!same(task.matching,JdMatchMaterialSchema.parse(params.matching))||!same(task.interview.focus,MockInterviewFocusSchema.parse(params.focus)))
      throw new AgentTaskClientError("当前资料或攻防点已变化，未发送到旧会话；原记录和草稿保留。","interview_scope_changed",task.id);
    if(execution&&!same(task.runtimeBinding,careerRuntimeBinding(params.runtime,params.preferredRuntimeId)))
      throw new AgentTaskClientError(taskIssueText.runtime_binding_changed!,"runtime_binding_changed",task.id);
  }
  async function found(parentId:string,params:InterviewTaskParams){
    const workspaceKey=`interview:${await digest([params.workspaceKey,parentId,params.focus])}`;
    const response=await request("",undefined,params.signal),parsed=z.object({tasks:z.array(z.object({ownerId:z.string()}).passthrough())}).safeParse(response.raw);
    if(!parsed.success)throw new AgentTaskClientError("对练任务列表无法核对，未新建或派送。","invalid_response");
    if(parsed.data.tasks.some(row=>row.ownerId!==response.ownerId))throw new IdentityBoundaryError();
    const tasks=parsed.data.tasks.filter(row=>row.kind==="mock_interview"&&row.workspaceKey===workspaceKey).map(row=>MockInterviewTaskSchema.parse(row));
    if(tasks.length>1)throw new AgentTaskClientError("对练会话不唯一，未另建预算。","interview_task_unresolved");
    const task=tasks[0];if(task){verify(task,params);if(task.parentTaskId!==parentId)throw new AgentTaskClientError("JD父任务不一致。","interview_parent_changed",task.id);}
    return {task,workspaceKey};
  }
  async function observe(id:string,params:Pick<InterviewTaskParams,"signal"|"onTask">={}){
    const lease=captureIdentityLease();lease.assert();
    let task=await read(id,params.signal);params.onTask?.(task);
    while(task.status==="running"){
      await new Promise<void>((resolve,reject)=>{
        const abort=()=>{clearTimeout(timer);reject(params.signal?.reason??new DOMException("Observer stopped","AbortError"));};
        const timer=setTimeout(()=>{params.signal?.removeEventListener("abort",abort);resolve();},options.pollMs??400);
        params.signal?.addEventListener("abort",abort,{once:true});if(params.signal?.aborted)abort();
      });
      lease.assert();task=await read(id,params.signal);params.onTask?.(task);
    }
    lease.assert();return task;
  }
  async function find(params:InterviewTaskParams){
    const lease=captureIdentityLease();lease.assert();
    const parent=await jd.find({...params,onTask:undefined});lease.assert();if(!parent)return undefined;
    const result=await found(parent.id,params);lease.assert();return result.task;
  }
  async function start(params:InterviewTaskParams&{consent:true}){
    const lease=captureIdentityLease();lease.assert();
    if(params.consent!==true)throw new AgentTaskClientError("请先授权所选JD和当前简历资料用于对练。","interview_consent_required");
    const parent=await jd.prepare({...params,onTask:undefined});lease.assert();
    const result=await found(parent.id,params);lease.assert();let task=result.task;
    if(!task){
      const response=await request("",taskCreatePayload(MockInterviewTaskCreateSchema.parse({kind:"mock_interview",workspaceKey:result.workspaceKey,rootScopeKey:params.rootScopeKey,
        parentTaskId:parent.id,parentSourceFingerprint:parent.sourceFingerprint,focus:params.focus,
        objective:"针对所选攻防点逐题追问，以完整简历自述和本人作答为依据；本人结束后生成评估回执，不认领事实。",
        runtimeBinding:careerRuntimeBinding(params.runtime,params.preferredRuntimeId),consent:true,idempotencyKey:result.workspaceKey})),params.signal);
      const parsed=z.object({task:MockInterviewTaskSchema}).safeParse(response.raw);lease.assert();
      if(!parsed.success)throw new AgentTaskClientError("对练创建回执无法核对，未执行。","invalid_response");
      if(parsed.data.task.ownerId!==lease.ownerId)throw new IdentityBoundaryError();task=parsed.data.task;
      if(task.parentTaskId!==parent.id)throw new AgentTaskClientError("JD父任务不一致。","interview_parent_changed",task.id);
    }
    verify(task,params,true);params.onTask?.(task);
    if(task.status==="ready")task=await execute(task,params,"start");
    return task.status==="running"?observe(task.id,params):task;
  }
  async function execute(task:MockInterviewTask,params:InterviewTaskParams,action:"start"|"answer"|"finish"|"resume",message?:{id:string;role:"user";content:string}){
    const lease=captureIdentityLease();lease.assert();verify(task,params,true);
    const fresh=await read(task.id,params.signal);lease.assert();verify(fresh,params,true);
    if(fresh.revision!==task.revision)throw new AgentTaskClientError("问题或任务状态已变化，请读取现有会话；回答草稿保留，未自动重发。","task_revision_conflict",task.id);
    const next=await read(task.id,params.signal,{expectedRevision:task.revision,sourceFingerprint:task.sourceFingerprint,runtimeBinding:task.runtimeBinding,
      runtime:params.runtime,consent:true,...(action==="answer"?{interviewAction:"answer",message}:action==="finish"?{interviewAction:"finish"}:{})},`/${action==="finish"?"answer":action}`);
    params.onTask?.(next);return next.status==="running"?observe(next.id,params):next;
  }
  return {find,start,get:read,observe,pause,
    answer:(task:MockInterviewTask,params:InterviewTaskParams,content:string,id:string=crypto.randomUUID())=>execute(task,params,"answer",{id,role:"user",content}),
    finish:(task:MockInterviewTask,params:InterviewTaskParams)=>execute(task,params,"finish"),
    resume:(task:MockInterviewTask,params:InterviewTaskParams)=>execute(task,params,"resume"),
  };
}
export type MockInterviewTaskClient=ReturnType<typeof createMockInterviewTaskClient>;
export const defaultMockInterviewTaskClient=createMockInterviewTaskClient();
