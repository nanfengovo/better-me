import { z } from "zod";

/** Content selection for isolated Career Studio analyses. These schemas grant
 * neither filesystem access nor direct Fact/Resume/Job mutation. */
export const StudioIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
export const StudioHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const StudioClaimSchema = z.object({ id: StudioIdSchema, text: z.string().trim().min(1).max(8000),
  skillIds: z.array(z.string().trim().min(1).max(100)).max(100), contribution: z.enum(["implementation", "design", "not_mine", "unknown"]),
  confirmedByUser: z.boolean(), confirmedNumericTokens: z.array(z.string().min(1).max(80)).max(100),
}).strict();
export const StudioJobRequirementSchema = z.object({ skillId: z.string().trim().min(1).max(100), weight: z.number().finite().positive().max(100),
  hard: z.boolean(), knowledge: z.enum(["known", "unknown"]), contribution: z.enum(["implementation", "design", "any"]) }).strict();
export const StudioComparableSalarySchema = z.object({ min: z.number().finite().nonnegative(), max: z.number().finite().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/), period: z.literal("annual"), tax: z.literal("gross"), kind: z.literal("base"), disclosedAt: z.string().datetime() }).strict()
  .refine(value => value.min <= value.max, "Salary bounds are reversed.");
export const StudioJobSchema = z.object({ id: StudioIdSchema, title: z.string().min(1).max(1000), company: z.string().max(500),
  description: z.string().max(50_000), sourceUrl: z.string().url().max(2000).nullable(), platform: z.string().max(100),
  capturedAt: z.string().datetime(), firstSeenAt: z.string().datetime().nullable(), lastSeenAt: z.string().datetime().nullable(), publishedAt: z.string().datetime().nullable(),
  availability: z.enum(["active", "closed", "unknown"]), verifiedAt: z.string().datetime().nullable(),
  companyKey: StudioIdSchema.nullable(), locationKey: StudioIdSchema.nullable(), roleKey: StudioIdSchema.nullable(),
  skillIds: z.array(z.string().min(1).max(100)).max(100), salaryText: z.string().max(2000),
  requirements: z.array(StudioJobRequirementSchema).max(100).optional(), comparableSalary: StudioComparableSalarySchema.optional(),
  refreshTimes: z.array(z.string().datetime()).max(1000).optional(), departmentKey: StudioIdSchema.nullable().optional(), platformJobId: StudioIdSchema.optional(),
  coordinates: z.object({ longitude: z.number().finite().min(-180).max(180), latitude: z.number().finite().min(-90).max(90), verified: z.boolean(), precision: z.enum(["office", "city", "unknown"]), persisted: z.boolean(), indexed: z.boolean() }).strict().optional(),
}).strict();
export const StudioContextInputSchema = z.object({ workspaceKey: StudioIdSchema, resumeId: StudioIdSchema, sourceFingerprint: StudioHashSchema,
  claims: z.array(StudioClaimSchema).max(200), jobs: z.array(StudioJobSchema).max(200), consent: z.literal(true) }).strict();
export type StudioContextInput = z.infer<typeof StudioContextInputSchema>;
export type StudioContext = Omit<StudioContextInput, "consent"> & { id: string; ownerId: string; session: string; createdAt: string; expiresAt: string; revoked: boolean; hostGeneration?: string };
export type StudioAccess = { session: string; valid(): Promise<boolean> };
export const StudioLocalRuntimeSchema = z.object({ model: z.string().min(1).max(200), modelDigest: StudioHashSchema }).strict();
export type StudioLocalRuntime = z.infer<typeof StudioLocalRuntimeSchema>;
export const StudioAnalysisRequestSchema = z.object({ contextId: StudioIdSchema, idempotencyKey: StudioIdSchema, consent: z.literal(true), runtime: StudioLocalRuntimeSchema }).strict();
export type StudioOperation<T = unknown> = { id: string; contextId: string; kind: string; inputHash: string; status: "running" | "completed" | "partial" | "failed" | "cancelled" | "interrupted";
  startedAt: string; updatedAt: string; taskStatus?: string; output?: T; errorCode?: string; usage?: { modelCalls?: number; toolCalls?: number; elapsedMs?: number } };
export const StudioOperationSchema = z.object({ id: z.string().regex(/^(?:[a-f0-9]{64}|ct_[a-f0-9]{32})$/), contextId: StudioIdSchema, kind: z.string().min(1).max(100), inputHash: StudioHashSchema,
  status: z.enum(["running", "completed", "partial", "failed", "cancelled", "interrupted"]), startedAt: z.string().datetime(), updatedAt: z.string().datetime(),
  taskStatus: z.enum(["ready", "running", "completed", "paused", "interrupted", "failed", "budget_exhausted", "revoked", "awaiting_answer", "awaiting_review"]).optional(),
  output: z.unknown().optional(), errorCode: z.string().optional(), usage: z.object({ modelCalls: z.number().optional(), toolCalls: z.number().optional(), elapsedMs: z.number().optional() }).strict().optional() }).strict();
export const StudioSourceSelectionSchema = z.object({ label: z.string().min(1).max(500), kind: z.enum(["user_statement", "design", "documentation"]), text: z.string().min(1).max(24_000) }).strict();
export const StudioCodeSelectionSchema = z.object({ root: z.string().min(1).max(2000), files: z.array(z.object({ path: z.string().min(1).max(2000), startLine: z.number().int().positive(), endLine: z.number().int().positive() }).strict()).min(1).max(8) }).strict();
export const StudioCommitteeRequestSchema = StudioAnalysisRequestSchema.extend({ claimIds: z.array(StudioIdSchema).min(1).max(40),
  statements: z.array(StudioSourceSelectionSchema).max(20), code: z.array(StudioCodeSelectionSchema).max(4), jobId: StudioIdSchema.optional() }).strict();
export const StudioModelPurposeSchema = z.enum(["layout_rewrite", "layout_review", "architecture_question", "architecture_review", "skill_mapping"]);
export type StudioModelPurpose = z.infer<typeof StudioModelPurposeSchema>;
export const StudioModelRequestSchema = StudioAnalysisRequestSchema.extend({ purpose: StudioModelPurposeSchema, payload: z.unknown() }).strict();
export const StudioReviewSchema = z.object({ kind: z.enum(["implementation", "design"]), action: z.string().trim().min(1).max(2500), role: z.string().max(300), deployment: z.string().max(600) }).strict();
export const StudioPublicationReviewSchema = z.object({ contextId: StudioIdSchema, operationId: StudioIdSchema, claimId: StudioIdSchema, expectedClaimHash: StudioHashSchema,
  disclosure: z.literal("publishable"), review: StudioReviewSchema, consent: z.literal(true), idempotencyKey: StudioIdSchema }).strict();
export const StudioArchitecturePublicationCatalogSchema = z.object({ contextId: StudioIdSchema }).strict();
export const StudioArchitecturePublicationSourceSchema = z.object({ id: StudioIdSchema, revision: z.number().int().positive(), hash: StudioHashSchema }).strict();
const architectureSelectionIds = (minimum: number, maximum: number) => z.array(z.string().min(1).max(160)).min(minimum).max(maximum)
  .refine(values => new Set(values).size === values.length, "Select each graph item once.");
export const StudioArchitecturePublicationPreviewSchema = z.object({ contextId: StudioIdSchema, publicationId: StudioHashSchema,
  expectedPublicationHash: StudioHashSchema, source: StudioArchitecturePublicationSourceSchema,
  nodeIds: architectureSelectionIds(1, 80), edgeIds: architectureSelectionIds(0, 160),
  fields: z.array(z.enum(["title", "node.label", "edge.label"])).min(1).max(3)
    .refine(values => new Set(values).size === values.length && values.includes("node.label"), "Node labels require an explicit selection."),
  privateTerms: z.array(z.string().trim().min(2).max(500)).max(200), consent: z.literal(true),
}).strict();
export const StudioArchitecturePublicationConfirmSchema = z.object({ contextId: StudioIdSchema, previewId: StudioIdSchema,
  expectedPreviewHash: StudioHashSchema, confirmed: z.literal(true), consent: z.literal(true), idempotencyKey: StudioIdSchema }).strict();
