import { z } from "zod";
import { agentOrigin, captureIdentityLease, ownedFetch } from "../lib/identity";
import { readRuntimeConnection } from "../lib/runtime-connection";

const statuses = z.enum(["ready","running","paused","interrupted","budget_exhausted","review_ready"]);
const nonnegative = z.number().int().nonnegative();
const boundedId = z.string().trim().min(1).max(160);
const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
type Json = string | number | boolean | null | Json[] | { [key:string]:Json };
// Only plain bounded JSON. Do not coerce, strip "__proto__", or recurse unboundedly on pasted cases.
function plainJson(value:unknown,depth=0,limit={nodes:0}):boolean {
  if(depth>20 || ++limit.nodes>8192)return false;
  if(value===null || typeof value==="boolean" || typeof value==="string" || (typeof value==="number"&&Number.isFinite(value)))return true;
  if(typeof value!=="object")return false;
  if(Array.isArray(value))return value.length<=8192 && Object.keys(value).length===value.length && value.every(v=>plainJson(v,depth+1,limit));
  const proto=Object.getPrototypeOf(value);if(proto!==null&&proto!==Object.prototype)return false;
  const entries=Object.entries(Object.getOwnPropertyDescriptors(value));
  return entries.length<=8192&&entries.every(([key,d])=>key.length<=256&&d.enumerable&&Object.hasOwn(d,"value")&&plainJson(d.value,depth+1,limit));
}
const json=z.custom<Json>(value=>plainJson(value));
const fixtureId=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/);
const model=z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/).refine(v=>!v.includes("//")&&!v.includes("..")&&!/(?:^|[-.:/_])cloud(?:$|[-.:/_])/i.test(v));
export const validCodingModelName=(value:string)=>model.safeParse(value).success;
const fixture = z.object({ id:fixtureId,input:json,expected:json }).strict();
const casesSchema=z.array(fixture).min(1).max(12).refine(cs=>new Set(cs.map(c=>c.id)).size===cs.length,"duplicate case id")
  .refine(cs=>cs.every(c=>size(c.input)<=32768 && size(c.expected)<=32768) && size(cs)<=65536,"case data too large");
const goalSchema=z.string().trim().min(1).max(4000);
export const CodingInputSchema=z.object({goal:goalSchema,model,cases:casesSchema,
  maxAttempts:z.number().int().min(1).max(8),maxActiveMs:z.number().int().min(1000).max(300000).multipleOf(1000).default(180000),consent:z.literal(true)}).strict();
const check=z.object({id:boundedId,passed:z.boolean(),error:z.string().optional()});
const progress=z.object({number:z.number().int().min(1).max(8),targetCaseId:fixtureId,outcome:z.enum(["accepted","regression","failed","interrupted"]),
  passedIds:z.array(fixtureId).max(12),failedIds:z.array(fixtureId).max(12),sourceHash:z.string().optional(),error:z.string().optional(),activeMs:nonnegative});
const summary=z.object({id:boundedId,status:statuses,revision:nonnegative,goal:goalSchema,autoRunning:z.boolean().optional(),
  model:z.string().optional(),attemptsUsed:nonnegative.optional(),maxAttempts:nonnegative.optional(),updatedAt:z.string().optional()});
const task=summary.extend({ model:z.string().min(1),modelDigest:z.string().min(1),attemptsUsed:nonnegative,maxAttempts:z.number().int().min(1).max(8),
  maxActiveMs:z.number().int().min(1).max(300000),activeMs:nonnegative,cases:casesSchema,
  best:z.object({source:z.string().min(1).max(32768).refine(s=>new TextEncoder().encode(s).length<=32768),sourceHash:z.string().regex(/^[a-f0-9]{64}$/),checks:z.array(check).max(12)}).optional(),
  lastAttempt:z.object({number:nonnegative,targetCaseId:boundedId,outcome:z.enum(["running","accepted","regression","failed","interrupted"]),
    checks:z.array(check).max(12),error:z.string().optional()}).optional(),history:z.array(progress).max(8).optional(),
  autoRunning:z.boolean().optional(),autoStopReason:z.string().max(240).optional(),
  createdAt:z.string(),updatedAt:z.string() }).refine(t=>{
    const ids=new Set(t.cases.map(c=>c.id));
    const complete=(checks:{id:string}[])=>checks.length===ids.size&&new Set(checks.map(c=>c.id)).size===ids.size&&checks.every(c=>ids.has(c.id));
    return t.attemptsUsed<=t.maxAttempts && t.activeMs<=t.maxActiveMs && (!t.best || complete(t.best.checks))
      && (t.status!=="review_ready" || !!t.best && t.best.checks.every(c=>c.passed))
      && (!t.lastAttempt || (ids.has(t.lastAttempt.targetCaseId) && (!t.lastAttempt.checks.length || complete(t.lastAttempt.checks))))
      && (!t.history || t.history.every((h,i)=>{
        const seen=[...h.passedIds,...h.failedIds];
        return h.number===i+1 && h.number<=t.attemptsUsed && ids.has(h.targetCaseId) && seen.every(id=>ids.has(id)) && new Set(seen).size===seen.length;
      }));
  },"invalid receipt for the frozen acceptance cases");
export type CodingTask=z.infer<typeof task>;
export type CodingSummary=z.infer<typeof summary>;
export type CodingInput=z.infer<typeof CodingInputSchema>;
export class CodingHttpError extends Error {
  constructor(readonly status:number,readonly code:string){super(code);this.name="CodingHttpError";}
}
async function request(path:string,body?:unknown,signal?:AbortSignal) {
  const lease=captureIdentityLease(); if(!lease.ownerId) throw new Error("请先登录当前账号。"); lease.assert();
  const timeout=AbortSignal.timeout(path.endsWith("/step")?310_000:20_000);
  const res=await ownedFetch(`${agentOrigin()}/api/v1/agent/sandbox/coding/tasks${path}`,{
    method:body===undefined?"GET":"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${readRuntimeConnection()?.agentToken??"better-me-agent-token"}`},
    ...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:signal?AbortSignal.any([signal,timeout]):timeout,
  });
  const data:unknown=await res.json().catch(()=>undefined); lease.assert();
  if(!res.ok) throw new CodingHttpError(res.status,z.object({error:z.string().max(240)}).safeParse(data).data?.error??`HTTP ${res.status}`);
  return data;
}
async function one(path:string,body?:unknown,id?:string,signal?:AbortSignal){
  const data=z.object({task}).safeParse(await request(path,body,signal));
  if(!data.success || (id && data.data.task.id!==id)) throw new Error("宿主返回了无法核对的任务；未启用候选代码。");
  return data.data.task;
}
const itemPath=(id:string)=>"/"+encodeURIComponent(boundedId.parse(id));
export const sandboxCodingClient={
  async list(signal?:AbortSignal):Promise<CodingSummary[]>{
    const parsed=z.object({tasks:z.array(summary)}).safeParse(await request("",undefined,signal));
    if(!parsed.success)throw new Error("宿主任务目录格式不符。");return parsed.data.tasks;
  },
  get:(id:string,signal?:AbortSignal)=>one(itemPath(id),undefined,id,signal),
  create:(input:CodingInput)=>one("",CodingInputSchema.parse(input)),
  step:(id:string,revision:number)=>one(itemPath(id)+"/step",{expectedRevision:revision,consent:true},id),
  run:(id:string,revision:number)=>one(itemPath(id)+"/run",{expectedRevision:revision,consent:true},id),
  pause:(id:string,revision:number)=>one(itemPath(id)+"/pause",{expectedRevision:revision},id),
};
export type SandboxCodingClient=typeof sandboxCodingClient;
