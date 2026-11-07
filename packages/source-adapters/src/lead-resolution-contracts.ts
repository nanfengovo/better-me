import { z } from "zod";
import {
  CanonicalJobSchema, EntityIdSchema, HttpUrlSchema, JobLocationSchema,
  RevisionSchema, SourceDefinitionSchema, SourceListingSchema, TimestampSchema,
} from "@better-me/opportunities";
import { SourceJobRecordSchema } from "./contracts.js";

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const cursor = z.string().min(1).max(2000);

/** A persisted discovery record remains a lead until a separately read posting is reviewed. */
export const DiscoveryLeadSchema = z.object({
  id: EntityIdSchema, sourceId: EntityIdSchema, observedAt: TimestampSchema, record: SourceJobRecordSchema,
}).strict().refine((lead) => lead.record.entityType !== "job-posting", "A discovery lead cannot enter the canonical jobs table.");
export type DiscoveryLead = z.infer<typeof DiscoveryLeadSchema>;

export const LeadQueryInputSchema = z.object({
  sourceId: EntityIdSchema.optional(), search: z.string().trim().min(1).max(500).optional(),
  entityType: z.enum(["discovery-lead", "recruitment-campaign"]).optional(),
  limit: z.number().int().min(1).max(100).default(50), cursor: cursor.optional(),
}).strict();
export type LeadQueryInput = z.input<typeof LeadQueryInputSchema>;

const itemFields = {
  lead: DiscoveryLeadSchema, leadDigest: fingerprint, source: SourceDefinitionSchema,
  eligibleOriginalSources: z.array(SourceDefinitionSchema).max(1000),
  resolvedJobs: z.array(z.object({
    jobId: EntityIdSchema, title: z.string().trim().min(1).max(1000), sourceId: EntityIdSchema, url: HttpUrlSchema,
  }).strict()).max(1000),
};
function validateLeadSource(item: { lead: DiscoveryLead; source: z.infer<typeof SourceDefinitionSchema> }, context: z.RefinementCtx) {
  if (item.source.sourceId !== item.lead.sourceId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["source", "sourceId"], message: "The source must own the persisted discovery lead." });
  }
}
export const LeadQueryItemSchema = z.object(itemFields).strict().superRefine(validateLeadSource);
export type LeadQueryItem = z.infer<typeof LeadQueryItemSchema>;

export const LeadQueryResultSchema = z.object({
  snapshotRevision: RevisionSchema, items: z.array(LeadQueryItemSchema).max(100),
  totalLeads: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), nextCursor: cursor.optional(),
}).strict().superRefine((result, context) => {
  if (result.totalLeads < result.items.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["totalLeads"], message: "The matching lead count cannot be below the returned page size." });
  }
});
export type LeadQueryResult = z.infer<typeof LeadQueryResultSchema>;

export const LeadReadInputSchema = z.object({ leadId: EntityIdSchema, expectedRevision: RevisionSchema.optional() }).strict();
export type LeadReadInput = z.infer<typeof LeadReadInputSchema>;
export const LeadReadResultSchema = z.object({
  snapshotRevision: RevisionSchema, ...itemFields,
}).strict().superRefine(validateLeadSource);
export type LeadReadResult = z.infer<typeof LeadReadResultSchema>;

/** The host selects a retained lead URL; callers cannot supply another endpoint. */
export const OriginalLeadReadInputSchema = z.object({
  leadId: EntityIdSchema, leadDigest: fingerprint, originalSourceId: EntityIdSchema, expectedRevision: RevisionSchema,
}).strict();
export type OriginalLeadReadInput = z.infer<typeof OriginalLeadReadInputSchema>;

/** A proof authenticates one host read, not company ownership, availability, or an office point. */
export const OriginalLeadCaptureSchema = z.object({
  schemaVersion: z.literal(1), leadId: EntityIdSchema, leadDigest: fingerprint,
  discoverySourceId: EntityIdSchema, discoverySourceFingerprint: fingerprint,
  originalSourceId: EntityIdSchema, originalSourceFingerprint: fingerprint,
  url: HttpUrlSchema, observedAt: TimestampSchema, record: SourceJobRecordSchema,
  readSessionId: z.string().regex(/^[a-f0-9]{32}$/),
  readSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), proof: fingerprint,
}).strict().superRefine((capture, context) => {
  const record = capture.record;
  if (record.entityType !== "job-posting" || record.completeness !== "detail"
    || !record.companyName?.trim() || !record.sourceRecordId?.trim() || !record.description?.trim()
    || record.url !== capture.url) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["record"], message: "An original capture requires one detailed job with an employer, stable record ID, readable description, and the exact captured URL." });
  }
});
export type OriginalLeadCapture = z.infer<typeof OriginalLeadCaptureSchema>;

const previewInput = { capture: OriginalLeadCaptureSchema, expectedRevision: RevisionSchema };
export const OriginalLeadPreviewInputSchema = z.object(previewInput).strict();
export type OriginalLeadPreviewInput = z.infer<typeof OriginalLeadPreviewInputSchema>;
export const OriginalLeadPreviewSchema = z.object({
  leadId: EntityIdSchema, originalSourceId: EntityIdSchema, expectedRevision: RevisionSchema,
  previewFingerprint: fingerprint, canonicalJobId: EntityIdSchema, job: CanonicalJobSchema,
  listings: z.array(SourceListingSchema).max(1000), locations: z.array(JobLocationSchema).max(1000),
  warnings: z.array(z.string().min(1).max(2000)).max(100),
}).strict();
export type OriginalLeadPreview = z.infer<typeof OriginalLeadPreviewSchema>;
export const OriginalLeadImportInputSchema = z.object({ ...previewInput, previewFingerprint: fingerprint, reviewed: z.literal(true) }).strict();
export type OriginalLeadImportInput = z.infer<typeof OriginalLeadImportInputSchema>;
