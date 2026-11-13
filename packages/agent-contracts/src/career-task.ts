import { z } from "zod";
import hash from "hash.js";
import { ResumeProposalTargetSchema, type ResumeProposalTarget } from "./index.js";

const id = z.string().trim().min(1).max(300);
const target: z.ZodType<ResumeProposalTarget> = z.lazy(() => ResumeProposalTargetSchema);
const text = (limit: number) => z.string().min(1).max(limit);
export const CAREER_TASK_DEFAULT_BUDGET = { maxModelCalls: 12, maxToolCalls: 30, maxActiveMs: 600_000 } as const;
export const CareerTaskBudgetSchema = z.object({
  maxModelCalls: z.number().int().min(1).max(500), maxToolCalls: z.number().int().min(1).max(2000),
  maxActiveMs: z.number().int().min(1).max(24 * 60 * 60_000),
}).strict();
export type CareerTaskBudget = z.infer<typeof CareerTaskBudgetSchema>;
export const TaskRootLedgerSchema=z.object({rootTaskId:id,budget:CareerTaskBudgetSchema,usage:z.object({modelCalls:z.number().int().nonnegative(),toolCalls:z.number().int().nonnegative(),activeMs:z.number().int().nonnegative()}),memberCount:z.number().int().positive()}).strict();
export type TaskLineage={rootScopeKey?:string;rootTaskId?:string;parentTaskId?:string;rootLedger?:z.infer<typeof TaskRootLedgerSchema>};
export const CareerRuntimeBindingSchema = z.object({ id, label: text(300), location: z.enum(["local", "cloud", "unknown"]) }).strict();
export type CareerRuntimeBinding = z.infer<typeof CareerRuntimeBindingSchema>;
type PublicRuntime = { kind:"model";modelSettings:{provider?:string;model:string;baseUrl?:string} } | {kind:"native";runtimeId:string} | {kind:"chatgpt";profileId:string;model:string} | {kind:"unified";expectedRevision:number};
/** Display/consent identity only. Host must separately pin actual endpoint/account/auth generation. Local CLI does not mean local inference. */
export function careerRuntimeBinding(runtime: PublicRuntime, preferredRuntimeId?: string): CareerRuntimeBinding {
  if (runtime.kind === "native") return {id:`native:${runtime.runtimeId}`,label:runtime.runtimeId,location:"unknown"};
  if (runtime.kind === "chatgpt") return {id:`chatgpt:${runtime.profileId}:${runtime.model}`,label:runtime.model,location:"cloud"};
  if (runtime.kind === "unified") {
    if (!preferredRuntimeId) throw new Error("explicit_selected_runtime_required");
    return {id:`unified:${preferredRuntimeId}:${runtime.expectedRevision}`,label:preferredRuntimeId,location:"unknown"};
  }
  const {model,provider = "openai-compatible",baseUrl} = runtime.modelSettings;
  let location:CareerRuntimeBinding["location"] = "unknown", endpoint="", origin="";
  if (baseUrl) {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    const loopback = ["localhost","127.0.0.1","[::1]"].includes(host);
    if(url.username||url.password||url.search||url.hash||!(url.protocol==="https:"||url.protocol==="http:"&&loopback))throw Object.assign(new Error("unsafe_model_endpoint"),{code:"unsafe_model_endpoint",status:400});
    // Pin the exact transport path as well as authority BEFORE the first send.
    // Only the authority is safe to show; path segments can carry tenant/deployment IDs.
    origin=url.origin;endpoint=origin+url.pathname.replace(/\/+$/u,"");
    location = !loopback || /cloud/i.test(model) ? "cloud" : provider === "ollama" ? "local" : "unknown";
  } else if (provider==="openai-compatible" || provider==="gemini") location="cloud";
  return {id:`model:${provider}:${model}:${hash.sha256().update(endpoint).digest("hex")}`,label:origin?`${origin} · ${model}`.slice(0,300):model,location};
}
export const CareerJobSchema = z.object({ id: id.optional(), title: text(500), company: z.string().max(500), description: text(64000), version: id.optional() }).strict();
export const CareerResumeSchema = z.object({ id, name: text(500), sourceFingerprint: id, fields: z.array(z.object({
  id, targetRef: target, originalText: text(12000),
}).strict()).min(1).max(300) }).strict();
export const CareerMaterialSchema = z.object({ id, label: text(300), text: text(64000), kind: z.enum(["user_statement", "source", "design"]) }).strict();
export const CareerToolPolicySchema=z.object({allowBuild:z.boolean(),installedVersionIds:z.array(z.string().regex(/^tool_[a-f0-9]{32}$/)).max(20)}).strict();
export const CareerToolArtifactSchema=z.object({versionId:z.string().regex(/^tool_[a-f0-9]{32}$/),recipeId:z.literal("material-lines-v1"),label:text(300),source:text(32000),sourceHash:z.string().regex(/^[a-f0-9]{64}$/),profile:z.literal("quickjs-wasm-json-v1"),status:z.literal("qualified"),testsPassed:z.number().int().positive(),testsTotal:z.number().int().positive(),createdAt:z.string()}).strict();
export type CareerToolArtifact=z.infer<typeof CareerToolArtifactSchema>;
export const CareerTaskCreateSchema = z.object({
  kind:z.literal("resume_tailor").optional(),
  parentTaskId:id.optional(),rootScopeKey:id.optional(),
  workspaceKey: id, objective: text(12000), job: CareerJobSchema, resume: CareerResumeSchema,
  materials: z.array(CareerMaterialSchema).max(40).default([]),
  directories: z.array(z.object({ path: text(3000), label: text(300) }).strict()).max(10).default([]),
  runtimeBinding: CareerRuntimeBindingSchema, budget: CareerTaskBudgetSchema.default(CAREER_TASK_DEFAULT_BUDGET),
  toolPolicy:CareerToolPolicySchema.default({allowBuild:false,installedVersionIds:[]}),
  consent: z.literal(true), idempotencyKey: text(160).min(8),
}).strict().superRefine((x, ctx) => {
  if (JSON.stringify(x).length > 500000) ctx.addIssue({ code: "custom", message: "task material size exceeded" });
  for (const ids of [x.materials.map(v => v.id), x.resume.fields.map(v => v.id), x.resume.fields.map(v => JSON.stringify(v.targetRef)), x.directories.map(v => v.path)]) {
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "duplicate source or target" });
  }
});
export type CareerTaskCreate = z.input<typeof CareerTaskCreateSchema>;
export type CareerTaskInput = z.infer<typeof CareerTaskCreateSchema>;
export const CareerTaskStatusSchema = z.enum(["ready","running","awaiting_answer","awaiting_review","paused","interrupted","budget_exhausted","failed","revoked","completed"]);
export type CareerTaskStatus = z.infer<typeof CareerTaskStatusSchema>;
export type CareerTaskEvidence = { id: string; kind: "job"|"resume"|"user_statement"|"source"|"design"; label: string; excerpt: string; sourceId: string; hash: string; path?: string; startLine?: number; endLine?: number; startOffset?:number; endOffset?:number; sourceLength?:number };
export const CareerTaskEvidenceSchema=z.object({id,kind:z.enum(["job","resume","user_statement","source","design"]),label:z.string(),excerpt:z.string(),sourceId:id,hash:id,path:z.string().optional(),startLine:z.number().int().optional(),endLine:z.number().int().optional(),startOffset:z.number().int().optional(),endOffset:z.number().int().optional(),sourceLength:z.number().int().optional()});
const citations = z.array(id).min(1).max(40);
export const CareerTaskPatchSchema = z.object({ fieldId: id, targetRef: target, originalText: text(12000), proposedText: text(12000), evidenceIds: citations, rationale: text(2000),
  sentences: z.array(z.object({ text: text(12000), evidenceIds: citations }).strict()).max(80).optional(),
}).strict();
export type CareerTaskPatch = z.infer<typeof CareerTaskPatchSchema> & { id: string };
export const CareerTaskDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tool"), tool: z.enum(["discover_tools","decompose_job","list_evidence","read_evidence","read_job","read_resume","search_materials","read_material","list_directory","search_directory","read_file","build_tool","use_tool"]),
    id: id.optional(), path: z.string().max(2000).optional(), query: text(200).optional(), startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional(),
    offset:z.number().int().nonnegative().optional(),length:z.number().int().min(1).max(4000).optional(),
    materialId:id.optional(),
  }).strict(),
  z.object({ kind: z.literal("ask_user"), question: text(2000), evidenceIds: z.array(id).max(40).default([]) }).strict(),
  z.object({ kind: z.literal("draft"), patches: z.array(CareerTaskPatchSchema).max(100), unknowns: z.array(text(2000)).max(60) }).strict(),
]);
export type CareerTaskDecision = z.infer<typeof CareerTaskDecisionSchema>;
export type CareerTaskEvent = { sequence: number; at: string; kind: "created"|"started"|"model"|"tool_call"|"tool_result"|"decision"|"question"|"answer"|"draft"|"stopped"|"budget"|"receipt"|"fact"; detail: string };
export type CareerTask = TaskLineage & {
  kind?:"resume_tailor";
  id: string; ownerId: string; workspaceKey: string; objective: string; revision: number; status: CareerTaskStatus;
  createdAt: string; updatedAt: string; job: CareerTaskInput["job"]; resume: CareerTaskInput["resume"];
  materials: CareerTaskInput["materials"]; directories: {id:string;label:string}[]; runtimeBinding: CareerRuntimeBinding;
  budget: CareerTaskBudget; usage: {modelCalls:number;toolCalls:number;activeMs:number};
  events: CareerTaskEvent[]; evidence: CareerTaskEvidence[]; question?: string; questionEvidenceIds?: string[];
  draft?: {hash:string; patches:CareerTaskPatch[]; unknowns:string[]};
  facts: {id:string;text:string;evidenceIds:string[];status:"proposed"|"approved"|"rejected"}[];
  toolPolicy?:z.infer<typeof CareerToolPolicySchema>;tools?:CareerToolArtifact[];toolUsage?:{builds:number;executions:number};
  receipt?: {versionId:string;receiptId?:string;draftHash:string;approvedPatchIds:string[];at:string}; error?:string;
};
export const CareerTaskMutationSchema = z.object({expectedRevision:z.number().int().positive()}).strict();
export const CareerTaskRunSchema = CareerTaskMutationSchema.extend({sourceFingerprint:id,runtimeBinding:CareerRuntimeBindingSchema,consent:z.literal(true),answer:text(12000).optional()}).strict();
export const CareerTaskReceiptSchema = CareerTaskMutationSchema.extend({draftHash:id,versionId:id,receiptId:id.optional(),approvedPatchIds:z.array(id).min(1).max(100)}).strict();
export const CareerTaskSchema: z.ZodType<CareerTask> = z.object({
  kind:z.literal("resume_tailor").optional(),
  rootScopeKey:id.optional(),rootTaskId:id.optional(),parentTaskId:id.optional(),rootLedger:TaskRootLedgerSchema.optional(),
  id, ownerId:id, workspaceKey:id, objective:text(12000), revision:z.number().int().positive(), status:CareerTaskStatusSchema,
  createdAt:z.string(), updatedAt:z.string(), job:CareerJobSchema, resume:CareerResumeSchema, materials:z.array(CareerMaterialSchema),
  directories:z.array(z.object({id,label:text(300)})), runtimeBinding:CareerRuntimeBindingSchema, budget:CareerTaskBudgetSchema,
  usage:z.object({modelCalls:z.number().int().nonnegative(),toolCalls:z.number().int().nonnegative(),activeMs:z.number().int().nonnegative()}),
  events:z.array(z.object({sequence:z.number().int(),at:z.string(),kind:z.enum(["created","started","model","tool_call","tool_result","decision","question","answer","draft","stopped","budget","receipt","fact"]),detail:z.string()})),
  evidence:z.array(CareerTaskEvidenceSchema),
  question:z.string().optional(),questionEvidenceIds:z.array(id).optional(),error:z.string().optional(),
  draft:z.object({hash:id,patches:z.array(CareerTaskPatchSchema.extend({id})),unknowns:z.array(z.string())}).optional(),
  facts:z.array(z.object({id,text:z.string(),evidenceIds:z.array(id),status:z.enum(["proposed","approved","rejected"])})),
  toolPolicy:CareerToolPolicySchema.optional(),tools:z.array(CareerToolArtifactSchema).max(3).optional(),toolUsage:z.object({builds:z.number().int().nonnegative(),executions:z.number().int().nonnegative()}).optional(),
  receipt:z.object({versionId:id,receiptId:id.optional(),draftHash:id,approvedPatchIds:z.array(id),at:z.string()}).optional(),
});
