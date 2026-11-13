import { z } from "zod";
import { AgentTaskSchema, ProjectUnderstandingTaskSchema, UnderstandingTurnSchema, type ProjectUnderstandingTask, type CareerRuntimeBinding } from "@better-me/agent-contracts";
import { createTaskTransport, AgentTaskClientError, type TaskClientOptions } from "./agent-task-transport";
import { captureIdentityLease, IdentityBoundaryError } from "../lib/identity";
import type { UnderstandingCreateInput, UnderstandingTurnRequest } from "./understanding-client";
import { assertTaskScope } from "./agent-task-scope";
const one=z.object({task:ProjectUnderstandingTaskSchema});
async function hash(value:unknown){return [...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(value))))].map(byte=>byte.toString(16).padStart(2,"0")).join("");}
/** The session UI is a projection of the authoritative task, never a second executor. */
export function createProjectTaskClient(options:TaskClientOptions={}){
  const {request,read}=createTaskTransport(ProjectUnderstandingTaskSchema,options);
  async function create(input:UnderstandingCreateInput&{runtimeBinding:CareerRuntimeBinding;parentTaskId?:string},signal?:AbortSignal){
    const lease=captureIdentityLease();lease.assert();
    const result=await request("",undefined,signal),parsed=z.object({tasks:z.array(AgentTaskSchema)}).safeParse(result.raw);
    if(!parsed.success)throw new AgentTaskClientError("任务列表无法核对，未新建或重置预算。","invalid_response");
    if(parsed.data.tasks.some(task=>task.ownerId!==lease.ownerId))throw new IdentityBoundaryError();
    const matches=parsed.data.tasks.filter((task):task is ProjectUnderstandingTask=>task.kind==="project_understanding"&&task.workspaceKey===input.workspaceKey&&task.project.projectKey===input.projectKey);
    if(matches.length>1)throw new AgentTaskClientError("无法唯一核对原项目任务，未新建清账。","project_task_unresolved");
    if(matches[0]){assertTaskScope(matches[0],input.rootScopeKey);return matches[0].project;}
    const {workspaceKey,projectKey,label,sourceText,runtimeBinding,parentTaskId,rootScopeKey}=input;
    const created=await request("",{kind:"project_understanding",workspaceKey,rootScopeKey,project:{projectKey,label,sourceText},runtimeBinding,...(parentTaskId?{parentTaskId}:{}),objective:"逐步建立本人确认的项目共识；源码不证明个人贡献或生产使用。",consent:true,idempotencyKey:`project:${await hash([workspaceKey,projectKey])}`},signal);
    const task=one.parse(created.raw).task;lease.assert();if(task.ownerId!==lease.ownerId)throw new IdentityBoundaryError();assertTaskScope(task,rootScopeKey);return task.project;
  }
  async function start(id:string,input:UnderstandingTurnRequest,signal?:AbortSignal){
    const current=await read(id,signal),{runtime,...turn}=input;
    // Use the submitted revision in the receipt. Reading a newer task must not
    // silently authorize it, nor replace the caller's stable submission ID.
    const projectTurn=UnderstandingTurnSchema.parse(turn),op=current.status==="ready"?"start":current.status==="awaiting_answer"?"answer":"resume";
    return (await read(id,signal,{expectedRevision:input.expectedRevision,sourceFingerprint:current.sourceFingerprint,runtimeBinding:current.runtimeBinding,consent:true,projectTurn,runtime},`/${op}`)).project;
  }
  return {create,start,get:async(id:string,signal?:AbortSignal)=>(await read(id,signal)).project,
    source:async(id:string,input:{expectedRevision:number;sourceText:string},signal?:AbortSignal)=>(await read(id,signal,input,"/project/source")).project,
    grant:async(id:string,path:string,signal?:AbortSignal)=>{const current=await read(id,signal);return (await read(id,signal,{expectedRevision:current.revision,path},"/project/grants")).project;},
    revoke:async(id:string,grantId:string,signal?:AbortSignal)=>{const current=await read(id,signal);return (await read(id,signal,{expectedRevision:current.revision,grantId},"/project/revoke-grant")).project;},
    confirm:async(id:string,input:{expectedRevision:number;summaryHash:string},signal?:AbortSignal)=>(await read(id,signal,input,"/project/confirm")).project,
    cancel:async(id:string,expectedTurnCount:number,signal?:AbortSignal)=>(await read(id,signal,{expectedTurnCount},"/project/cancel")).project,
  };
}
