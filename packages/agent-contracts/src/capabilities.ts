import { z } from "zod";
import type { WorkspaceEvidenceSnapshot } from "./evidence-handoff.js";

const text = z.string().min(1).max(2000);
const batchBase = { sourceNamespace: text, capturedAt: z.string().datetime() };
export const JobExport = z.discriminatedUnion("format", [
  z.object({ format: z.literal("board-v1"), ...batchBase, jobs: z.array(z.object({ jobId: text, title: text,
    requirements: z.array(text).max(100) }).strict()).max(200) }).strict(),
  z.object({ format: z.literal("board-v2"), ...batchBase, positions: z.array(z.object({ id: text, name: text,
    needs: z.array(text).max(100) }).strict()).max(200) }).strict(),
]);
export const JobComparisonInput = z.object({ before: JobExport, after: JobExport }).strict();
export type JobComparisonInput = z.infer<typeof JobComparisonInput>;
export const RequirementReference = z.object({ rowIndex: z.number().int().nonnegative(), requirementIndex: z.number().int().nonnegative(),
  sourceNamespace: text, jobId: text, snapshotAt: z.string().datetime(), text }).strict();
export type RequirementReference = z.infer<typeof RequirementReference>;
export const EvidenceReviewInput = z.object({ notes: z.array(z.object({ id: text, project: text, source: text,
  excerpt: z.string().min(1).max(8000), links: z.array(RequirementReference).max(20) }).strict()).max(80) }).strict()
  .superRefine((value, context) => { if (new Set(value.notes.map(note => note.id)).size !== value.notes.length)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "evidence_ids_must_be_unique" }); });
export type EvidenceReviewInput = z.infer<typeof EvidenceReviewInput>;
export const CapabilityTaskRequest = z.object({ input: JobComparisonInput, idempotencyKey: z.string().min(8).max(120),
  expectedCatalogRevision: z.number().int().nonnegative(), consent: z.literal(true),
  intent: z.enum(["compare-job-exports", "prepare-evidence-review"]).optional(), evidence: EvidenceReviewInput.optional(),
  // M1 is intentionally local-only, no URL/key/provider sent by a model or client.
  model: z.literal("gemma4:e2b-it-qat").default("gemma4:e2b-it-qat") }).strict().superRefine((value, context) => {
    if ((value.intent === "prepare-evidence-review") !== Boolean(value.evidence))
      context.addIssue({ code: z.ZodIssueCode.custom, message: "evidence_requires_its_own_task_scope" });
  });
export type CapabilityTaskRequest = z.infer<typeof CapabilityTaskRequest>;
export const NormalizedJob = z.object({ batch: z.enum(["before", "after"]), index: z.number().int().nonnegative(),
  sourceNamespace: text, jobId: text, title: text, requirements: z.array(text), snapshotAt: z.string().datetime() }).strict();
export const NormalizedJobs = z.array(NormalizedJob).max(400);
export type NormalizedJob = z.infer<typeof NormalizedJob>;
export type CapabilityStage = "assessing" | "acquiring" | "qualifying" | "executing" | "verifying" | "completed" | "failed" | "cancelled" | "interrupted" | "partial";
export type CapabilityAssessment = { kind: "ready" | "compose" | "missing_input" | "needs_grant" | "temporary_unavailable" | "gap" | "prohibited";
  reason: string; version?: number; receiptId?: string };
export type VerificationReceipt = { id: string; kind: "qualification" | "task"; targetHash: string; verifierVersion: string;
  status: "passed" | "failed"; checks: string[]; at: string };
export type CapabilityVersion = { id: string; version: number; codeHash: string; source: string; contract: string; environment: string;
  provenance: { provider: string; model: string; modelDigest?: string; redistribution: "not-reviewed-private-only" };
  state: "qualified" | "reusable" | "disabled"; qualification: VerificationReceipt; sourceTask: string; disabledReason?: string;
  revalidations?: VerificationReceipt[] };
export type ComparisonReport = { rowsBefore: number; rowsAfter: number; changes: Array<{ identity: string; title: string;
  added: string[]; removed: string[]; beforeRef: number; afterRef: number }>; unmatched: Array<{ batch: "before" | "after"; index: number; reason: string }>;
  limitations: string[] };
export type EvidenceReviewReport = { rowsReviewed: number; emptyJobRows: number[];
  items: Array<{ requirement: RequirementReference; title: string; evidenceIds: string[];
    status: "needs_evidence" | "needs_personal_confirmation"; question: string }>;
  unresolvedLinks: Array<{ evidenceId: string; linkIndex: number; reason: string }>; unlinkedEvidenceIds: string[]; limitations: string[] };
export type CapabilityComposition = { id: string; version: number; recipeHash: string; verifier: string;
  dependency: { id: string; version: number; codeHash: string } };
export type BuildAttempt = { id: string; attempt: number; source?: string; codeHash?: string; provider: string; model: string;
  modelDigest?: string; promptHash?: string; generatedTokens?: number; durationMs?: number; status: "requested" | "generated" | "rejected" | "qualified";
  error?: string; qualification?: VerificationReceipt };
export type CapabilityTask = { id: string; ownerId: string; stage: CapabilityStage; inputHash: string; input: JobComparisonInput;
  intent?: "compare-job-exports" | "prepare-evidence-review"; evidence?: EvidenceReviewInput;
  evidenceReport?: EvidenceReviewReport; composition?: CapabilityComposition;
  logicalKey: string; requestHash: string; session: string; grant: { revision: number; revoked: boolean; expiresAt: number };
  contract: { version: string; deliverable: string; acceptance: string[]; buildLimit: number; deadline: number };
  acquisition?: { gap: string; method: string; verifier: string; scope: string }; events: Array<{ stage: string; detail: string; at: string }>;
  builds: BuildAttempt[]; builderCalls: number; selected?: { id: string; version: number; codeHash: string };
  qualification?: VerificationReceipt; taskVerification?: VerificationReceipt; output?: ComparisonReport; outputHash?: string;
  receipt?: { id: string; reportId: string; revision: number; inputHash: string; codeHash: string; at: string };
  error?: string; reviewReason?: string; createdAt: string };
export type CapabilitySnapshot = { ownerId: string; catalogRevision: number; tasks: CapabilityTask[]; versions: CapabilityVersion[];
  workspace?: WorkspaceEvidenceSnapshot; storageError?: string };

/** Synthetic exports only. No resume, job index or Agent-history reads. */
export function syntheticJobComparison(round = 1): JobComparisonInput {
  return { before: { format: "board-v1", sourceNamespace: "synthetic:acme-board", capturedAt: "2026-11-01T00:00:00Z",
    jobs: [{ jobId: "101", title: "合成后端工程师", requirements: round === 1 ? ["TypeScript", "FIRST-ONLY-CANARY-7319"] : ["TypeScript", "Redis"] },
      { jobId: "102", title: "合成测试工程师", requirements: ["测试"] }] },
    after: { format: "board-v2", sourceNamespace: "synthetic:acme-board", capturedAt: "2026-11-04T00:00:00Z",
      positions: [{ id: "101", name: "合成后端工程师", needs: round === 1 ? ["TypeScript", "PostgreSQL"] : ["TypeScript", "Redis", "Kubernetes"] },
        { id: "103", name: "合成平台工程师", needs: ["Linux"] }] } };
}

/** Explicit associations are user-supplied leads, never verified personal claims. */
export function syntheticEvidenceReview(round = 1): { input: JobComparisonInput; evidence: EvidenceReviewInput } {
  const input = syntheticJobComparison(2);
  return { input, evidence: { notes: [{ id: "synthetic-evidence-1", project: "合成调度项目", source: "合成发布说明#3",
    excerpt: round === 1 ? "EVIDENCE-FIRST-ONLY-8421：项目采用 Kubernetes；个人行动、结果与归属仍待核对。"
      : "EVIDENCE-SECOND-ONLY-9273：项目有 Redis 缓存说明；不代表本人已完成或掌握。",
    links: [{ rowIndex: 0, requirementIndex: round === 1 ? 2 : 1, sourceNamespace: input.after.sourceNamespace,
      jobId: "101", snapshotAt: input.after.capturedAt, text: round === 1 ? "Kubernetes" : "Redis" }] }] } };
}
