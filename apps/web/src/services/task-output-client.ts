import {TaskOutputArtifactSchema,type AgentTask,type TaskOutputArtifact} from "@better-me/agent-contracts";
import {agentOrigin,captureIdentityLease,IdentityBoundaryError,ownedFetch} from "../lib/identity";
import {readRuntimeConnection} from "../lib/runtime-connection";
import {AgentTaskClientError,type TaskClientOptions} from "./agent-task-transport";

export type TaskOutputSource=Pick<AgentTask,"id"|"ownerId">&{outputArtifacts?:TaskOutputArtifact[]};
export type VerifiedTaskOutput={artifact:TaskOutputArtifact;text:string};
const issue=(code:string)=>new AgentTaskClientError("完整原始输出尚未核实，未显示或下载部分内容。请核对原任务后手动重读。",code);

/** Read-only, owner-bound immutable bytes. No inference, retry, persistence or text clipping. */
export function createTaskOutputClient(options:Pick<TaskClientOptions,"fetch"|"baseUrl">={}){
  return {async read(task:TaskOutputSource,outputId:string,signal?:AbortSignal):Promise<VerifiedTaskOutput>{
    const lease=captureIdentityLease();lease.assert();signal?.throwIfAborted();
    if(!lease.ownerId||task.ownerId!==lease.ownerId)throw new IdentityBoundaryError();
    const parsed=TaskOutputArtifactSchema.safeParse(task.outputArtifacts?.find(item=>item.id===outputId));
    if(!/^ct_[a-f0-9]{32}$/.test(task.id)||!parsed.success)throw issue("task_output_not_found");
    const artifact=parsed.data,combined=AbortSignal.any([lease.signal,AbortSignal.timeout(30_000),...(signal?[signal]:[])]);
    let response:Response;
    try{
      response=await ownedFetch(`${options.baseUrl??agentOrigin()}/api/v1/agent/tasks/${task.id}/outputs/${artifact.id}`,{
        method:"GET",headers:{Authorization:`Bearer ${readRuntimeConnection()?.agentToken??"better-me-agent-token"}`},signal:combined,
      },options.fetch??fetch);
    }catch(error){lease.assert();combined.throwIfAborted();if(error instanceof IdentityBoundaryError)throw error;throw issue("task_output_read_failed");}
    if(!response.ok){
      const raw:unknown=await response.json().catch(()=>undefined);lease.assert();combined.throwIfAborted();
      const code=raw&&typeof raw==="object"&&"error"in raw&&typeof raw.error==="string"&&/^[a-z][a-z0-9_]{1,100}$/.test(raw.error)?raw.error:"task_output_read_failed";
      throw issue(code);
    }
    if(!/^text\/plain(?:;|$)/i.test(response.headers.get("Content-Type")??""))throw issue("invalid_task_output_type");
    let bytes:ArrayBuffer;
    try{bytes=await response.arrayBuffer();}catch{lease.assert();combined.throwIfAborted();throw issue("task_output_incomplete");}
    lease.assert();combined.throwIfAborted();
    if(bytes.byteLength!==artifact.bytes)throw issue("task_output_size_mismatch");
    const digest=await crypto.subtle.digest("SHA-256",bytes);lease.assert();combined.throwIfAborted();
    const hash=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,"0")).join("");
    if(hash!==artifact.hash)throw issue("task_output_hash_mismatch");
    // Response.text() strips a leading UTF-8 BOM. It is part of the saved output,
    // so decode explicitly and reject invalid UTF-8 instead of replacing bytes.
    let text:string;try{text=new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw issue("invalid_task_output_encoding");}
    return {artifact,text};
  }};
}
export const defaultTaskOutputClient=createTaskOutputClient();
