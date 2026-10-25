import { z } from "zod";
import { CountryCodeSchema, EntityIdSchema, TimestampSchema } from "@better-me/opportunities";

const count = () => z.number().int().nonnegative();
const terms = () => z.array(z.string().trim().min(1).max(300)).max(100);

/** Safe search fields retained for a source health card; actor and request fingerprints stay server-side. */
export const SourceHealthScopeSchema = z.object({
  roles: terms().optional(),
  regions: terms().optional(),
  countryCodes: z.array(CountryCodeSchema).max(300).optional(),
  companyNames: terms().optional(),
}).strict();
export type SourceHealthScope = z.infer<typeof SourceHealthScopeSchema>;

export const SourceHealthRunSummarySchema = z.object({
  at: TimestampSchema,
  scope: SourceHealthScopeSchema.optional(),
  partial: z.boolean().optional(),
  errorCode: z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/).optional(),
  records: count().optional(),
  pages: count().optional(),
  added: count().optional(),
  changed: count().optional(),
  unchanged: count().optional(),
}).strict();
export type SourceHealthRunSummary = z.infer<typeof SourceHealthRunSummarySchema>;

export const SourceHealthLatestRunSchema = SourceHealthRunSummarySchema.extend({
  status: z.enum(["running", "completed", "partial", "failed", "cancelled", "superseded"]),
}).strict();
export type SourceHealthLatestRun = z.infer<typeof SourceHealthLatestRunSchema>;

export const SourceHealthErrorSchema = z.object({
  at: TimestampSchema,
  status: z.enum(["failed", "partial", "cancelled", "superseded"]),
  code: z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/).optional(),
}).strict();
export type SourceHealthError = z.infer<typeof SourceHealthErrorSchema>;

export const SourceHealthEntrySchema = z.object({
  sourceId: EntityIdSchema,
  latestRun: SourceHealthLatestRunSchema.optional(),
  lastCompleted: SourceHealthRunSummarySchema.optional(),
  lastPartial: SourceHealthRunSummarySchema.optional(),
  latestError: SourceHealthErrorSchema.optional(),
}).strict();
export type SourceHealthEntry = z.infer<typeof SourceHealthEntrySchema>;

export const SourceHealthResultSchema = z.object({ entries: z.array(SourceHealthEntrySchema).max(10_000) }).strict()
  .superRefine((result, context) => {
    const ids = result.entries.map(entry => entry.sourceId);
    if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "Source health entries must be unique." });
  });
export type SourceHealthResult = z.infer<typeof SourceHealthResultSchema>;
