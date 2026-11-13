import {
  CareerTaskCreateSchema, CareerTaskSchema, CareerTaskRunSchema, CareerTaskMutationSchema, CareerTaskReceiptSchema, CareerTaskBudgetSchema,
  CareerToolArtifactSchema, AgentTaskSchema, isCareerTask, type AgentTask, type CareerToolArtifact, type CareerTask, type CareerTaskBudget, type CareerTaskCreate, type CareerRuntimeBinding,
} from "@better-me/agent-contracts";
import { z } from "zod";
import { agentOrigin, captureIdentityLease, IdentityBoundaryError, ownedFetch } from "../lib/identity";
import { readRuntimeConnection } from "../lib/runtime-connection";
import type { UnderstandingRuntime } from "./understanding-client";
import { selectTaskRoot, taskCreatePayload } from "./agent-task-scope";

type Revision = { expectedRevision: number };
export type CareerRunInput = Revision & { sourceFingerprint: string; runtimeBinding: CareerRuntimeBinding; runtime: UnderstandingRuntime; consent: true; answer?: string };
export type CareerReceiptInput = z.input<typeof CareerTaskReceiptSchema>;
export interface CareerTaskClient {
  list(signal?: AbortSignal): Promise<CareerTask[]>;
  root?(rootScopeKey:string,signal?:AbortSignal):Promise<AgentTask|undefined>;
  get(id: string, signal?: AbortSignal): Promise<CareerTask>;
  create(input: CareerTaskCreate): Promise<CareerTask>;
  run(id: string, action: "start" | "resume" | "answer", input: CareerRunInput): Promise<CareerTask>;
  control(id: string, action: "pause" | "revoke", input: Revision): Promise<CareerTask>;
  budget(id: string, input: Revision & { budget: CareerTaskBudget; consent: true }): Promise<CareerTask>;
  receipt(id: string, input: CareerReceiptInput): Promise<CareerTask>;
  proposeFact(id: string, input: Revision & { text: string; evidenceIds: string[] }): Promise<CareerTask>;
  fact(id: string, factId: string, decision: "approve" | "reject", input: Revision): Promise<CareerTask>;
  installedTools?(signal?:AbortSignal):Promise<CareerToolArtifact[]>;
  installTool?(id:string,versionId:string,input:Revision&{sourceHash:string;consent:true}):Promise<CareerTask>;
  revokeTool?(versionId:string,input:{sourceHash:string;consent:true}):Promise<CareerToolArtifact[]>;
  tools?(id:string,signal?:AbortSignal):Promise<{tool:string;description:string;arguments:string;effect:string}[]>;
}
export class CareerTaskError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) { super(message); this.name = "CareerTaskError"; }
}
const statusText: Record<number, string> = { 400:"任务内容未通过校验，请核对资料、目录和预算。", 401:"登录或本机连接授权已过期。",
  403:"当前账号、资料或模型没有这项权限。", 404:"找不到这项任务，请刷新任务列表。", 409:"任务状态或原稿已变化。请刷新后重新核对，未自动重试。",
  413:"单次资料过大，请缩小范围。", 422:"所选底座或授权目录无法执行这项任务；未换用其他服务。", 429:"当前额度已用尽。请核对预算后再决定是否继续。" };
const codeText: Record<string,string> = { runtime_binding_changed:"底座已变化。没有换用其他模型。", runtime_authorization_changed_new_task_required:"模型端点或账号授权已变化。请新建任务，不会改用其他通道。",
  identity_required:"请先登录当前 BetterMe 账号。", explicit_selected_runtime_required:"请选择一个明确的手动底座，本任务不允许自动切换。",
  career_runtime_not_supported:"当前底座不支持此任务，没有改用其他模型。", interaction_lease_invalid:"当前登录或其授权已失效。", task_budget_exhausted:"任务达到额度上限；没有自动加额。",
  source_changed_new_comparison_required:"原稿或项目来源已变化。请重新核对并发起新比较，未套用旧提案。", personal_statement_quote_required:"请选择本人陈述，并从原文摘录；未写入长期记录。",
  task_revision_conflict:"任务记录已变化。请刷新并重新审阅，没有覆盖新结果。", draft_changed:"当前草稿已变化，未接受旧版批准。" };
const taskView=CareerTaskSchema.refine(t=>{
  if(t.status==="awaiting_answer"&&!t.question?.trim() || t.status==="awaiting_review"&&!t.draft)return false;
  if(t.status!=="completed")return !t.receipt;
  return !!t.draft && !!t.receipt && t.draft.hash===t.receipt.draftHash && !!t.receipt.approvedPatchIds.length
    && new Set(t.receipt.approvedPatchIds).size===t.receipt.approvedPatchIds.length
    && t.receipt.approvedPatchIds.every(id=>t.draft!.patches.some(p=>p.id===id));
},"A terminal label is not a business receipt");
const single = z.object({ task: taskView });
const many = z.object({ tasks: z.array(AgentTaskSchema.refine(task=>!isCareerTask(task)||taskView.safeParse(task).success,"A terminal label is not a business receipt")) });
const library=z.object({ownerId:z.string(),tools:z.array(CareerToolArtifactSchema)});
const pathFor = (id: string) => `/${encodeURIComponent(id)}`;

/** Only this same-origin/paired Agent host receives credentials. No browser persistence or automatic retry. */
export function createCareerTaskClient(fetcher?: typeof fetch): CareerTaskClient {
  async function request<S extends z.ZodTypeAny>(path: string, schema: S, body?: unknown, signal?: AbortSignal): Promise<z.output<S>> {
    const lease = captureIdentityLease(); lease.assert();
    if (!lease.ownerId) throw new CareerTaskError("请先登录当前 BetterMe 账号。", 401, "identity_required");
    const timer = AbortSignal.timeout(15_000);
    let res: Response;
    try {
      res = await ownedFetch(`${agentOrigin()}/api/v1/agent/tasks${path}`, { method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type":"application/json", Authorization:`Bearer ${readRuntimeConnection()?.agentToken ?? "better-me-agent-token"}` },
        signal: signal ? AbortSignal.any([signal,timer]) : timer, ...(body === undefined ? {} : {body:JSON.stringify(body)}),
      }, fetcher ?? fetch);
    } catch(failure) {
      if (signal?.aborted || failure instanceof IdentityBoundaryError) throw failure;
      throw new CareerTaskError("未收到本机任务服务的回执。请先刷新任务状态；没有自动重试或切换模型。",undefined,"outcome_unknown");
    }
    const raw: unknown = await res.json().catch((error:unknown) => { if (error instanceof IdentityBoundaryError) throw error; return undefined; });
    lease.assert();
    if (!res.ok) { const issue=z.object({error:z.string()}).safeParse(raw); const code=issue.success?issue.data.error:undefined;
      throw new CareerTaskError((code && codeText[code]) || statusText[res.status] || "本机任务操作未确认；请先刷新状态，没有自动重试。",res.status,code); }
    const parsed=schema.safeParse(raw);
    if (!parsed.success) throw new CareerTaskError("任务回执格式不完整，未采用，也未自动重试。请先刷新状态。",res.status,"invalid_response");
    const view=parsed.data as {task?:AgentTask;tasks?:AgentTask[];ownerId?:string};
    if(view.ownerId!==undefined&&view.ownerId!==lease.ownerId)throw new IdentityBoundaryError();
    if ((view.tasks ?? (view.task ? [view.task] : [])).some(task=>task.ownerId!==lease.ownerId)) throw new IdentityBoundaryError();
    return parsed.data;
  }
  const one=async(id:string,suffix="",body?:unknown,signal?:AbortSignal) => {
    const {task}=await request(pathFor(id)+suffix,single,body,signal);
    if(task.id!==id) throw new CareerTaskError("任务标识不匹配，未载入。",409,"wrong_task"); return task;
  };
  return {
    list:async signal=>(await request("",many,undefined,signal)).tasks.filter(isCareerTask),
    root:async(rootScopeKey,signal)=>selectTaskRoot((await request("",many,undefined,signal)).tasks,rootScopeKey)?.root,
    get:(id,signal)=>one(id,"",undefined,signal),
    create:async input=>(await request("",single,taskCreatePayload(CareerTaskCreateSchema.parse(input),input.budget))).task,
    run:(id,action,{runtime,...input})=>one(id,`/${action}`,{...CareerTaskRunSchema.parse(input),runtime}),
    control:(id,action,input)=>one(id,`/${action}`,CareerTaskMutationSchema.parse(input)),
    budget:(id,input)=>one(id,"/budget",CareerTaskMutationSchema.extend({budget:CareerTaskBudgetSchema,consent:z.literal(true)}).parse(input)),
    receipt:(id,input)=>one(id,"/receipt",CareerTaskReceiptSchema.parse(input)),
    proposeFact:(id,input)=>one(id,"/facts",CareerTaskMutationSchema.extend({text:z.string().trim().min(1).max(4000),evidenceIds:z.array(z.string().min(1)).min(1).max(40)}).parse(input)),
    fact:(id,factId,decision,input)=>one(id,`/facts/${encodeURIComponent(factId)}/${decision}`,CareerTaskMutationSchema.parse(input)),
    installedTools:async signal=>(await request("/tools",library,undefined,signal)).tools,
    installTool:(id,versionId,input)=>one(id,`/tools/${encodeURIComponent(versionId)}/install`,CareerTaskMutationSchema.extend({sourceHash:z.string().regex(/^[a-f0-9]{64}$/),consent:z.literal(true)}).parse(input)),
    revokeTool:async(versionId,input)=>(await request(`/tools/${encodeURIComponent(versionId)}/revoke`,library,z.object({sourceHash:z.string().regex(/^[a-f0-9]{64}$/),consent:z.literal(true)}).strict().parse(input))).tools,
    tools:async(id,signal)=>{const out=await request(pathFor(id)+"/tools",z.object({taskId:z.literal(id),tools:z.array(z.object({tool:z.string(),description:z.string(),arguments:z.string(),effect:z.string()}))}),undefined,signal);return out.tools;},
  };
}
export const defaultCareerTaskClient = createCareerTaskClient();
