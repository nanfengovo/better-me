import { z } from "zod";
import { JdOcrRequestSchema,JdOcrTaskCreateSchema,JdOcrTaskSchema,JdOcrImageSchema,careerRuntimeBinding,type JdOcrTask,type JdOcrRequest } from "@better-me/agent-contracts";
import { captureIdentityLease,IdentityBoundaryError } from "../lib/identity";
import { assertTaskScope,taskCreatePayload } from "./agent-task-scope";
import { AgentTaskClientError,createTaskTransport,taskIssueText,type TaskClientOptions } from "./agent-task-transport";
import type { UnderstandingRuntime } from "./understanding-client";

export type OcrOriginalImage={name:string;size:number;dataUrl:string};
export type JdOcrParams={workspaceKey:string;rootScopeKey:string;parentTaskId?:string;images:OcrOriginalImage[];sourceUrl?:string;runtime:UnderstandingRuntime;preferredRuntimeId?:string;
  consent:true;signal?:AbortSignal;onTask?:(task:JdOcrTask)=>void;resumeTaskId?:string};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
async function hash(text:string){return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text))),byte=>byte.toString(16).padStart(2,"0")).join("");}
export async function ocrManifest(images:OcrOriginalImage[],sourceUrl?:string):Promise<JdOcrRequest>{
  if(!images.length)throw new AgentTaskClientError("请先添加岗位截图。","task_images_not_ready");
  if(images.some(image=>!image.dataUrl))throw new AgentTaskClientError("截图仍在读取，请等待全部图片显示后再识别。","task_images_not_ready");
  return JdOcrRequestSchema.parse({images:await Promise.all(images.map(async(image,index)=>{
    const digest=await hash(image.dataUrl),mimeType=/^data:(image\/(?:png|jpeg|webp));base64,/.exec(image.dataUrl)?.[1];
    return {id:`img_${(await hash(`${index}:${digest}`)).slice(0,32)}`,name:image.name,mimeType,byteLength:image.size,hash:digest};
  })),...(sourceUrl?{sourceUrl}:{})});
}

/** One frozen task and ordered original uploads. Reads/reconnects never replay inference. */
export function createJdOcrTaskClient(options:TaskClientOptions={}){
  const {request,read,pause}=createTaskTransport(JdOcrTaskSchema,options);
  async function list(workspaceKey:string,signal?:AbortSignal){
    const {raw,ownerId}=await request("",undefined,signal),rows=z.object({tasks:z.array(z.object({ownerId:z.string()}).passthrough())}).parse(raw).tasks;
    if(rows.some(row=>row.ownerId!==ownerId))throw new IdentityBoundaryError();
    return rows.filter(row=>row.kind==="jd_ocr"&&row.workspaceKey===workspaceKey).map(row=>JdOcrTaskSchema.parse(row));
  }
  async function generate(params:JdOcrParams){
    // Check pending images before touching the network; never send only the completed subset.
    if(!params.images.length||params.images.some(image=>!image.dataUrl))throw new AgentTaskClientError("截图仍在读取，请等待全部图片显示后再识别。","task_images_not_ready");
    const lease=captureIdentityLease();lease.assert();
    if(!lease.ownerId)throw new AgentTaskClientError("请先登录 BetterMe；未从浏览器直调模型。","identity_required");
    if(params.consent!==true)throw new AgentTaskClientError("请先授权本次完整截图的识别。","consent_required");
    const safe=await ocrManifest(params.images,params.sourceUrl);lease.assert();params.signal?.throwIfAborted();
    const binding=careerRuntimeBinding(params.runtime,params.preferredRuntimeId),matches=(await list(params.workspaceKey,params.signal)).filter(task=>same(task.request,safe));lease.assert();
    if(matches.length>1)throw new AgentTaskClientError("无法唯一核对原截图任务，未另建任务清账。","ocr_task_unresolved");
    let task=matches[0];
    if(params.resumeTaskId&&task?.id!==params.resumeTaskId)throw new AgentTaskClientError("原任务、图片顺序或来源已变化，未恢复或新建任务。","ocr_source_changed",params.resumeTaskId);
    if(!task){
      const key=await hash(JSON.stringify([params.workspaceKey,safe]));lease.assert();
      task=z.object({task:JdOcrTaskSchema}).parse((await request("",taskCreatePayload(JdOcrTaskCreateSchema.parse({kind:"jd_ocr",workspaceKey:params.workspaceKey,rootScopeKey:params.rootScopeKey,parentTaskId:params.parentTaskId,
        objective:"按完整原图和原顺序识别岗位文字，待本人核对，不采用岗位或简历。",request:safe,runtimeBinding:binding,consent:true,idempotencyKey:`jd-ocr:${key}`})),params.signal)).raw).task;
    }
    lease.assert();if(task.ownerId!==lease.ownerId)throw new IdentityBoundaryError();assertTaskScope(task,params.rootScopeKey);
    if(!same(task.runtimeBinding,binding))throw new AgentTaskClientError(taskIssueText.runtime_binding_changed!,"runtime_binding_changed",task.id);
    if(!same(task.request,safe))throw new AgentTaskClientError("完整原图或来源已变化，未沿用旧授权。","ocr_source_changed",task.id);
    params.onTask?.(task);params.signal?.throwIfAborted();
    if(task.status==="ready"||params.resumeTaskId&&["paused","interrupted","failed","budget_exhausted"].includes(task.status)){
      for(let index=0;index<safe.images.length;index++){
        const image=safe.images[index]!;if(task.uploadedImageIds.includes(image.id))continue;
        task=await read(task.id,params.signal,{expectedRevision:task.revision,sourceFingerprint:task.sourceFingerprint,consent:true,dataUrl:params.images[index]!.dataUrl},`/images/${image.id}`);
        lease.assert();params.onTask?.(task);
      }
      task=await read(task.id,params.signal,{expectedRevision:task.revision,sourceFingerprint:task.sourceFingerprint,runtimeBinding:binding,consent:true,runtime:params.runtime},task.status==="ready"?"/start":"/resume");
      lease.assert();params.onTask?.(task);
    }
    while(task.status==="running"){
      await new Promise<void>((resolve,reject)=>{const signal=params.signal,abort=()=>{clearTimeout(timer);reject(signal?.reason??new DOMException("Observer stopped","AbortError"));};
        const timer=setTimeout(()=>{signal?.removeEventListener("abort",abort);resolve();},options.pollMs??400);signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();});
      lease.assert();task=await read(task.id,params.signal);params.onTask?.(task);
    }
    lease.assert();params.signal?.throwIfAborted();
    if(task.status!=="completed"||!task.result)throw new AgentTaskClientError(taskIssueText[task.error??""]??`原截图任务处于 ${task.status}；完整材料、输出和用量已保留，请核对并重新授权后恢复。`,task.error??"ocr_not_ready",task.id);
    return task;
  }
  async function getImage(task:JdOcrTask,imageId:string,signal?:AbortSignal){
    const lease=captureIdentityLease();lease.assert();if(lease.ownerId!==task.ownerId)throw new IdentityBoundaryError();
    const result=await request(`/${task.id}/images/${imageId}`,undefined,signal);
    if(result.ownerId!==task.ownerId)throw new IdentityBoundaryError();
    const value=z.object({image:JdOcrImageSchema,dataUrl:z.string()}).strict().parse(result.raw),expected=task.request.images.find(image=>image.id===imageId);
    if(!same(value.image,expected)||await hash(value.dataUrl)!==expected?.hash)throw new AgentTaskClientError("私有原图核对失败；未采用或重新请求模型。","ocr_source_changed",task.id);
    lease.assert();signal?.throwIfAborted();
    return {id:value.image.id,name:value.image.name,size:value.image.byteLength,dataUrl:value.dataUrl};
  }
  return {generate,get:read,pause,list,getImage};
}
export const defaultJdOcrTaskClient=createJdOcrTaskClient();
