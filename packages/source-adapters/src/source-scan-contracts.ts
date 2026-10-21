import { z } from "zod";
import { CountryCodeSchema, EntityIdSchema, TimestampSchema } from "@better-me/opportunities";
import { SourceScopeSchema } from "./contracts.js";

const count = () => z.number().int().nonnegative();
export const SourceSyncRunSchema = z.object({
  runId: EntityIdSchema, sourceId: EntityIdSchema, actorScope: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:/-]+$/),
  generation: z.number().int().positive(),
  scope: z.object({ keywords: z.array(z.string().trim().min(1).max(300)).max(100).optional(),
    regions: z.array(z.string().trim().min(1).max(300)).max(100).optional(),
    countryCodes: z.array(CountryCodeSchema).max(300).optional(), companies: z.array(z.string().trim().min(1).max(300)).max(100).optional(),
    maxRecords: z.number().int().min(1).max(100_000).optional(), maxPages: z.number().int().min(1).max(10_000).optional() }).strict(),
  requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  scanId: EntityIdSchema.optional(), continuedFromRunId: EntityIdSchema.optional(),
  status: z.enum(["running", "completed", "partial", "failed", "cancelled", "superseded"]),
  startedAt: TimestampSchema, finishedAt: TimestampSchema.optional(),
  summary: z.object({ added: count().optional(), changed: count().optional(), unchanged: count().optional(), closed: count().optional(),
    failed: count().optional(), needsHuman: count().optional(), records: count().optional(), pages: count().optional(), leads: count().optional(),
    partial: z.boolean().optional(), errorCode: z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/).optional() }).strict().optional(),
}).strict();
export type SourceSyncRun = z.infer<typeof SourceSyncRunSchema>;
export const SourceScanProgressSchema = z.object({
  scanId: EntityIdSchema, sourceId: EntityIdSchema, runId: EntityIdSchema, version: z.number().int().positive(),
  scope: SourceScopeSchema, state: z.enum(["ready", "retry-page", "exhausted", "truncated", "invalidated"]),
  running: z.boolean(), canContinue: z.boolean(), attemptedRecords: count(), pages: count(), hadErrors: z.boolean(),
  updatedAt: TimestampSchema, invalidatedReason: z.enum(["source-config-changed", "new-scan", "source-changed"]).optional(),
}).strict().superRefine((value, context) => {
  if (value.canContinue !== (!value.running && (value.state === "ready" || value.state === "retry-page"))) context.addIssue({ code: "custom", message: "Continuation must reflect a terminal run with a retained checkpoint." });
  if ((value.state === "invalidated") !== Boolean(value.invalidatedReason)) context.addIssue({ code: "custom", message: "Invalidated scans require their permanent reason." });
});
export type SourceScanProgress = z.infer<typeof SourceScanProgressSchema>;
export const ReadSourceScanProgressInputSchema = z.object({ sourceId: EntityIdSchema, runId: EntityIdSchema.optional() }).strict();
export const SourceScanProgressResultSchema = z.object({ sourceId: EntityIdSchema, progress: SourceScanProgressSchema.nullable() }).strict()
  .refine(value => !value.progress || value.progress.sourceId === value.sourceId, "Progress must belong to the requested source.");
export const ContinueSourceScanInputSchema = z.object({ sourceId: EntityIdSchema, fromRunId: EntityIdSchema,
  expectedProgressVersion: z.number().int().positive(), maxRecords: z.number().int().min(1).max(100_000).optional(),
  maxPages: z.number().int().min(1).max(1000).optional() }).strict();
export type ContinueSourceScanInput = z.infer<typeof ContinueSourceScanInputSchema>;
function sameScope(left: z.infer<typeof SourceScopeSchema>, right: z.infer<typeof SourceScopeSchema>): boolean {
  const sameValues = (a: readonly string[] | undefined, b: readonly string[] | undefined) => a === undefined || b === undefined
    ? a === b : a.length === b.length && a.every((value, index) => value === b[index]);
  return sameValues(left.roles, right.roles) && sameValues(left.regions, right.regions)
    && sameValues(left.companyNames, right.companyNames) && sameValues(left.countryCodes, right.countryCodes);
}
export const SourceSyncResultSchema = z.object({ run: SourceSyncRunSchema, localFilters: SourceScopeSchema, warnings: z.array(z.string()),
  sourceError: z.object({ code: z.string(), retryAfterSeconds: z.number().nonnegative().optional() }).strict().optional(),
  scanProgress: SourceScanProgressSchema.optional() }).strict().superRefine((value, context) => {
  const scope = { roles: value.run.scope.keywords ?? [], regions: value.run.scope.regions ?? [], companyNames: value.run.scope.companies ?? [],
    ...(value.run.scope.countryCodes ? { countryCodes: value.run.scope.countryCodes } : {}) };
  if (!sameScope(scope, value.localFilters)) context.addIssue({ code: "custom", message: "Sync results must retain the durable run scope." });
  const progress = value.scanProgress;
  if (progress && (progress.sourceId !== value.run.sourceId || progress.runId !== value.run.runId || progress.scanId !== value.run.scanId
    || progress.running !== (value.run.status === "running") || !sameScope(progress.scope, value.localFilters))) {
    context.addIssue({ code: "custom", message: "Sync progress must belong to this run and its retained scope." });
  }
});
export type SourceSyncResult = z.infer<typeof SourceSyncResultSchema>;
