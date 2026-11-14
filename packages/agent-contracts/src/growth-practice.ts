import hash from "hash.js";
import { z } from "zod";
import { CareerTaskBudgetSchema, CareerTaskStatusSchema, TaskRootLedgerSchema, type TaskLineage } from "./career-task.js";

const sha256 = (value: string) => hash.sha256().update(value).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().trim().min(1).max(300);
const sourceId = z.string().regex(/^(?:checkpoint-note-v1|ls_[a-f0-9]{64})$/);

export const GROWTH_PRACTICE_SOURCE_ID = "checkpoint-note-v1" as const;
export const GROWTH_PRACTICE_EXAMPLE_SOURCE = "检查点会保存已经完成的工具结果。恢复时先读取检查点，不重复调用已经完成的工具。";
export const GROWTH_PRACTICE_RUNTIME = Object.freeze({
  id: "native:growth-practice-v1",
  label: "合成练习运行器",
  location: "local",
} as const);
export const GROWTH_PRACTICE_BUDGET = Object.freeze({ maxModelCalls: 1, maxToolCalls: 32, maxActiveMs: 600_000 } as const);

/** Candidate code sees JSON only. It asks for the one allowlisted note, then
 * produces a result bound to the durable checkpoint; no host handles exist. */
export const GROWTH_PRACTICE_STARTER_SOURCE = `function decide(input) {
  if (!input.checkpoint) return { kind: "lookup", noteId: input.sourceId };
  return {
    kind: "finish",
    answer: input.answer,
    explanation: input.explanation,
    citedSourceId: input.checkpoint.noteId,
    citedResultHash: input.checkpoint.resultHash
  };
}`;

export const GrowthPracticeRuntimeSchema = z.object({
  id: z.literal(GROWTH_PRACTICE_RUNTIME.id),
  label: z.literal(GROWTH_PRACTICE_RUNTIME.label),
  location: z.literal(GROWTH_PRACTICE_RUNTIME.location),
}).strict();

export const GrowthPracticeRequestSchema = z.object({
  sourceId,
  sourceText: z.string().min(1).max(16_000),
  sourceHash: digest,
  sourceCode: z.string().min(1).max(64 * 1024),
  answer: z.string().min(1).max(12_000),
  explanation: z.string().min(1).max(12_000),
  scenario: z.literal("lost_receipt").optional(),
  scenarioCase: z.literal("new_operation").optional(),
}).strict().superRefine((value, ctx) => {
  if (sha256(value.sourceText) !== value.sourceHash) ctx.addIssue({ code: "custom", path: ["sourceHash"], message: "source hash mismatch" });
  if (value.scenarioCase && value.scenario !== "lost_receipt") ctx.addIssue({ code: "custom", path: ["scenarioCase"], message: "receipt scenario required" });
});
export type GrowthPracticeRequest = z.infer<typeof GrowthPracticeRequestSchema>;
export const growthPracticeRequestHash = (value: GrowthPracticeRequest) =>
  sha256(JSON.stringify(GrowthPracticeRequestSchema.parse(value)));

export const GrowthPracticeDecisionInputSchema = z.object({
  sourceId: z.string().min(1).max(300),
  answer: z.string().max(12_000),
  explanation: z.string().max(12_000),
  delivery: z.enum(["confirmed", "unknown"]).optional(),
  operationId: z.string().min(1).max(300).optional(),
  checkpoint: z.object({ noteId: z.string().min(1).max(300), result: z.string().max(16_000), resultHash: digest }).strict().nullable(),
}).strict();
export type GrowthPracticeDecisionInput = z.infer<typeof GrowthPracticeDecisionInputSchema>;

export const GrowthPracticeDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reconcile"), operationId: z.string().min(1).max(300) }).strict(),
  z.object({ kind: z.literal("lookup"), noteId: z.string().min(1).max(300) }).strict(),
  z.object({ kind: z.literal("finish"), answer: z.string().max(12_000), explanation: z.string().max(12_000),
    citedSourceId: z.string().min(1).max(300), citedResultHash: digest }).strict(),
]);
export type GrowthPracticeDecision = z.infer<typeof GrowthPracticeDecisionSchema>;
export const growthPracticeResultHash = (value: GrowthPracticeDecision | null) =>
  sha256(JSON.stringify(value === null ? null : GrowthPracticeDecisionSchema.parse(value)));

export const GrowthPracticeCheckpointSchema = z.object({
  stepId: z.literal("lookup-note-v1"), noteId: sourceId, result: z.string().min(1).max(16_000),
  resultHash: digest, lookupCalls: z.literal(1), savedAt: z.string().datetime(),
}).strict().superRefine((value, ctx) => {
  if (sha256(value.result) !== value.resultHash) ctx.addIssue({ code: "custom", path: ["resultHash"], message: "checkpoint result hash mismatch" });
});
export type GrowthPracticeCheckpoint = z.infer<typeof GrowthPracticeCheckpointSchema>;
export const growthPracticeCheckpointHash = (value: GrowthPracticeCheckpoint) =>
  sha256(JSON.stringify(GrowthPracticeCheckpointSchema.parse(value)));

export const GrowthPracticeCheckIdSchema = z.enum([
  "correct-reference", "unknown-explicit", "forbidden-tool-rejected", "resume-uses-checkpoint",
]);
export const GrowthPracticeVerificationSchema = z.object({
  verifierVersion: z.enum(["growth-practice-quickjs-v1", "growth-practice-receipt-v2", "growth-practice-receipt-v3"]), sourceHash: digest, sourceCodeHash: digest,
  checkpointHash: digest, resultHash: digest,
  checks: z.array(z.object({ id: GrowthPracticeCheckIdSchema, passed: z.boolean() }).strict()).length(4),
  passed: z.number().int().min(0).max(4), total: z.literal(4), verifiedAt: z.string().datetime(),
  observations: z.array(z.object({ caseId: z.string().max(100), inputHash: digest, decision: GrowthPracticeDecisionSchema.nullable() }).strict()).max(4).optional(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.checks.map(check => check.id)).size !== 4 || value.passed !== value.checks.filter(check => check.passed).length) {
    ctx.addIssue({ code: "custom", message: "verification check summary mismatch" });
  }
});
export type GrowthPracticeVerification = z.infer<typeof GrowthPracticeVerificationSchema>;
export const growthPracticeVerificationHash = (value: GrowthPracticeVerification) =>
  sha256(JSON.stringify(GrowthPracticeVerificationSchema.parse(value)));

export const GrowthPracticeStateSchema = z.object({
  phase: z.enum(["ready", "outcome_unknown", "lookup_saved", "verified", "failed"]),
  checkpoint: GrowthPracticeCheckpointSchema.optional(),
  verification: GrowthPracticeVerificationSchema.optional(),
  verificationHash: digest.optional(),
  error: z.string().max(160).optional(),
}).strict().superRefine((value, ctx) => {
  if (["lookup_saved", "verified"].includes(value.phase) && !value.checkpoint) ctx.addIssue({ code: "custom", message: "checkpoint required" });
  if (value.phase === "verified" && (!value.verification || value.verification.passed !== 4 || value.verificationHash !== sha256(JSON.stringify(value.verification)))) {
    ctx.addIssue({ code: "custom", message: "verified receipt required" });
  }
  if (value.verification && value.verificationHash !== sha256(JSON.stringify(value.verification))) ctx.addIssue({ code: "custom", message: "verification hash mismatch" });
  if (!value.verification && value.verificationHash) ctx.addIssue({ code: "custom", message: "verification hash without receipt" });
});
export type GrowthPracticeState = z.infer<typeof GrowthPracticeStateSchema>;

export const GrowthPracticeTaskCreateSchema = z.object({
  kind: z.literal("growth_practice"), workspaceKey: id, objective: z.string().min(1).max(12_000),
  parentTaskId: id.optional(), rootScopeKey: id.optional(), request: GrowthPracticeRequestSchema,
  runtimeBinding: GrowthPracticeRuntimeSchema, budget: CareerTaskBudgetSchema.default(GROWTH_PRACTICE_BUDGET),
  consent: z.literal(true), idempotencyKey: z.string().min(8).max(160),
}).strict();
export type GrowthPracticeTaskCreate = z.input<typeof GrowthPracticeTaskCreateSchema>;

const EventSchema = z.object({ sequence: z.number().int().positive(), at: z.string(),
  kind: z.enum(["created", "started", "model", "tool_call", "tool_result", "decision", "question", "answer", "draft", "stopped", "budget", "receipt", "fact"]),
  detail: z.string(),
}).strict();
export const GrowthPracticeTaskSchema = z.object({
  kind: z.literal("growth_practice"), id, ownerId: id, workspaceKey: id, objective: z.string().min(1).max(12_000),
  revision: z.number().int().positive(), status: CareerTaskStatusSchema, createdAt: z.string(), updatedAt: z.string(),
  rootScopeKey: id.optional(), rootTaskId: id.optional(), parentTaskId: id.optional(), rootLedger: TaskRootLedgerSchema.optional(),
  request: GrowthPracticeRequestSchema, sourceFingerprint: digest, runtimeBinding: GrowthPracticeRuntimeSchema,
  budget: CareerTaskBudgetSchema, usage: z.object({ modelCalls: z.number().int().nonnegative(), toolCalls: z.number().int().nonnegative(), activeMs: z.number().int().nonnegative() }),
  events: z.array(EventSchema), practice: GrowthPracticeStateSchema, error: z.string().optional(),
}).strict().superRefine((value, ctx) => {
  const allowed = value.practice.phase === "ready" ? ["ready", "running", "interrupted", "paused", "revoked"]
    : value.practice.phase === "outcome_unknown" ? ["running", "interrupted", "failed", "revoked"]
    : value.practice.phase === "lookup_saved" ? ["awaiting_review", "running", "interrupted", "revoked"]
    : value.practice.phase === "verified" ? ["completed"] : ["failed", "budget_exhausted", "revoked"];
  if (!allowed.includes(value.status)) ctx.addIssue({ code: "custom", message: "practice/task status mismatch" });
  // Child objects have already been normalized into canonical schema key order.
  // Hash their parsed values directly so safeParse remains non-throwing even
  // when a child has already contributed a validation issue.
  if (value.sourceFingerprint !== sha256(JSON.stringify(value.request))) ctx.addIssue({ code: "custom", path: ["sourceFingerprint"], message: "request fingerprint mismatch" });
  const checkpoint = value.practice.checkpoint, verification = value.practice.verification;
  if (checkpoint && (checkpoint.noteId !== value.request.sourceId || checkpoint.result !== value.request.sourceText
    || checkpoint.resultHash !== value.request.sourceHash)) ctx.addIssue({ code: "custom", message: "checkpoint source binding mismatch" });
  if (verification) {
    if (!checkpoint || verification.checkpointHash !== sha256(JSON.stringify(checkpoint))
      || verification.sourceHash !== value.request.sourceHash || verification.sourceCodeHash !== sha256(value.request.sourceCode)) {
      ctx.addIssue({ code: "custom", message: "verification snapshot binding mismatch" });
    }
    if (checkpoint && verification.checks.some(check => check.id === "correct-reference" && check.passed)
      && verification.resultHash !== sha256(JSON.stringify({ kind: "finish", answer: value.request.answer,
        explanation: value.request.explanation, citedSourceId: checkpoint.noteId, citedResultHash: checkpoint.resultHash }))) {
      ctx.addIssue({ code: "custom", message: "verification result binding mismatch" });
    }
  }
});
export type GrowthPracticeTask = z.infer<typeof GrowthPracticeTaskSchema> & TaskLineage;

export const GrowthPracticeStepSchema = z.object({
  expectedRevision: z.number().int().positive(), sourceFingerprint: digest, consent: z.literal(true),
}).strict();
export type GrowthPracticeStep = z.infer<typeof GrowthPracticeStepSchema>;
