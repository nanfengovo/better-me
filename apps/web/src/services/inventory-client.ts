import { z } from "zod";
import { InventoryProfileSchema, InventoryViewSchema, InventoryTaskSchema, careerRuntimeBinding, inventoryDigest, inventoryKey, inventoryProbeTaskId,
  type InventoryAction,type InventorySource,type InventoryView,type InventoryProbeRequest } from "@better-me/agent-contracts";
import { agentOrigin,captureIdentityLease,ownedFetch } from "../lib/identity";
import { readRuntimeConnection } from "../lib/runtime-connection";
import { AgentTaskClientError, createTaskTransport } from "./agent-task-transport";
import { assertTaskScope } from "./agent-task-scope";
import type { UnderstandingRuntime } from "./understanding-client";

async function call<T>(path:string, schema:z.ZodType<T,z.ZodTypeDef,unknown>, body?:unknown) {
  const lease=captureIdentityLease();lease.assert();if(!lease.ownerId)throw Error("请先登录本人账号。");
  const res=await ownedFetch(agentOrigin()+"/api/v1/agent/inventory"+path,{method:body===undefined?"GET":"POST",
    headers:{"Content-Type":"application/json",Authorization:"Bearer "+(readRuntimeConnection()?.agentToken??"better-me-agent-token")},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
  if(!res.ok)throw Error(res.status===409?"盘点、底稿或画像已在另一处变化。请重新读取，再核对共识卡。":
    "本机盘点服务未接受请求。请核对登录、服务和材料大小，未自动重发。");
  const raw=await res.json();lease.assert();if(raw.ownerId!==lease.ownerId)throw Error("账号已变化，请重新打开盘点。");
  return schema.parse(raw);
}
const view=z.object({view:InventoryViewSchema});
export const inventoryClient={
  async get(key:string){return (await call("/sessions/"+key,z.object({view:InventoryViewSchema.nullable()}))).view;},
  async start(source:InventorySource){return (await call("/start",view,source)).view;},
  async command(v:InventoryView,action:InventoryAction){return (await call("/sessions/"+inventoryKey(v.session.source)+"/commands",view,{
    ...action,expectedRevision:v.session.revision,fingerprint:v.session.source.fingerprint,commandId:crypto.randomUUID(),
  })).view;},
  async profile(){return (await call("/profile",z.object({profile:InventoryProfileSchema}))).profile;},
  async forget(id:string,revision:number){return (await call("/profile/forget",z.object({profile:InventoryProfileSchema}),{id,revision})).profile;},
};

/** Caller can observe by sending the identical request after an unknown outcome: never POST start again
 * for an existing intent. The original kernel ledger enforces the one-call ceiling. */
export async function inventoryProbe(request:InventoryProbeRequest,rootScopeKey:string,runtime:UnderstandingRuntime,preferred:string|undefined,
  signal:AbortSignal,assertSelection:()=>void){
  signal=AbortSignal.any([signal,AbortSignal.timeout(75000)]);
  const lease=captureIdentityLease(), transport=createTaskTransport(InventoryTaskSchema);
  const binding=careerRuntimeBinding(runtime,preferred), stable=inventoryDigest([request,binding]), workspaceKey="inventory-probe:"+stable;
  const guard=()=>{lease.assert();signal.throwIfAborted();assertSelection();};guard();
  if(!lease.ownerId)throw Error("请先登录本人账号。");
  const idempotencyKey="inventory:"+stable,id=inventoryProbeTaskId(lease.ownerId,idempotencyKey);
  let task;
  try{task=await transport.read(id,signal);}catch(e){
    if(!(e instanceof AgentTaskClientError)||e.code!=="task_not_found")throw e;
  }
  if(!task){
    guard();
    const receipt=await transport.request("",{kind:"career_inventory",workspaceKey,rootScopeKey,objective:"就本轮本人回答提一个具体追问",
      request,runtimeBinding:binding,consent:true,idempotencyKey},signal);guard();
    task=z.object({task:InventoryTaskSchema}).parse(receipt.raw).task;
    if(task.id!==id || task.ownerId!==lease.ownerId || inventoryDigest(task.request)!==inventoryDigest(request))throw Error("任务来源已变化。");
    assertTaskScope(task,rootScopeKey);guard();
    task=await transport.read(task.id,signal,{expectedRevision:task.revision,sourceFingerprint:task.sourceFingerprint,runtimeBinding:binding,runtime,consent:true},"/start");
  }
  assertTaskScope(task,rootScopeKey);guard();
  if(task.ownerId!==lease.ownerId || inventoryDigest(task.request)!==inventoryDigest(request))throw Error("无法核对原任务。");
  while(task.status==="running"){
    await new Promise(resolve=>setTimeout(resolve,350));guard();task=await transport.read(task.id,signal);
  }
  guard();if(task.status!=="completed"||!task.result)throw Error("原追问尚无可用结果（"+task.status+"）。未补发；可继续文字盘点。");
  return task.result.question;
}
