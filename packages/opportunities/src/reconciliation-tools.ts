import { z } from "zod";
import { CanonicalJobSchema, CompanySchema, CompensationSchema, EntityIdSchema, JobLocationSchema, RevisionSchema, SourceDefinitionSchema, SourceListingSchema } from "./schema.js";
import { MergeCandidateSchema, MergeConflictSchema, MergeDecisionSchema } from "./reconciliation.js";

const reason = z.string().trim().min(1).max(2000);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const boundedRead = { limit: z.number().int().min(1).max(100).default(50), jobId: EntityIdSchema.optional() };
export const ListMergeCandidatesInputSchema = z.object(boundedRead).strict();
export type ListMergeCandidatesInput = z.input<typeof ListMergeCandidatesInputSchema>;
export const MergeCandidatesPageSchema = z.object({
  snapshotRevision: RevisionSchema, candidates: z.array(MergeCandidateSchema).max(100),
  limit: z.number().int().min(1).max(100), scannedCandidateLimit: z.literal(1000), truncated: z.boolean(), warnings: z.array(z.string().max(2000)).max(20),
}).strict();
export type MergeCandidatesPage = z.infer<typeof MergeCandidatesPageSchema>;

const pairReview = { targetJobId: EntityIdSchema, sourceJobId: EntityIdSchema, expectedRevision: RevisionSchema, reason, companyIdentityConfirmed: z.boolean().default(false) };
export const PreviewMergeReviewInputSchema = z.object(pairReview).strict();
export type PreviewMergeReviewInput = z.input<typeof PreviewMergeReviewInputSchema>;
export const ConfirmMergeReviewInputSchema = z.object({ ...pairReview, previewFingerprint: fingerprint, reviewed: z.literal(true) }).strict();
export type ConfirmMergeReviewInput = z.input<typeof ConfirmMergeReviewInputSchema>;
export const RejectMergeReviewInputSchema = ConfirmMergeReviewInputSchema;
export type RejectMergeReviewInput = z.input<typeof RejectMergeReviewInputSchema>;
export const PreviewRevokeMergeReviewInputSchema = z.object({ decisionId: EntityIdSchema, expectedRevision: RevisionSchema, reason }).strict();
export type PreviewRevokeMergeReviewInput = z.infer<typeof PreviewRevokeMergeReviewInputSchema>;
export const RevokeMergeReviewInputSchema = PreviewRevokeMergeReviewInputSchema.extend({ previewFingerprint: fingerprint, reviewed: z.literal(true) }).strict();
export type RevokeMergeReviewInput = z.infer<typeof RevokeMergeReviewInputSchema>;
export const ReconciliationJobSideSchema = z.object({
  requestedJobId: EntityIdSchema, canonicalJobId: EntityIdSchema,
  job: CanonicalJobSchema, company: CompanySchema,
  listings: z.array(SourceListingSchema).max(1000), sources: z.array(SourceDefinitionSchema).max(1000),
  locations: z.array(JobLocationSchema).max(1000), compensations: z.array(CompensationSchema).max(1000),
}).strict();
export const MergeReviewPreviewSchema = z.object({
  snapshotRevision: RevisionSchema, expectedRevision: RevisionSchema, previewFingerprint: fingerprint,
  input: PreviewMergeReviewInputSchema, target: ReconciliationJobSideSchema, source: ReconciliationJobSideSchema,
  candidate: MergeCandidateSchema, warnings: z.array(z.string().max(2000)).max(20),
}).strict();
export type MergeReviewPreview = z.infer<typeof MergeReviewPreviewSchema>;
export const RevokeMergeReviewPreviewSchema = z.object({
  snapshotRevision: RevisionSchema, expectedRevision: RevisionSchema, previewFingerprint: fingerprint,
  input: PreviewRevokeMergeReviewInputSchema, decision: MergeDecisionSchema,
  before: z.array(ReconciliationJobSideSchema).max(1000), after: z.array(ReconciliationJobSideSchema).max(1000),
  counts: z.object({ beforeJobs: z.number().int().nonnegative(), afterJobs: z.number().int().nonnegative() }).strict(),
  warnings: z.array(z.string().max(2000)).max(20),
}).strict();
export type RevokeMergeReviewPreview = z.infer<typeof RevokeMergeReviewPreviewSchema>;

export const ListMergeDecisionsInputSchema = z.object(boundedRead).strict();
export type ListMergeDecisionsInput = z.input<typeof ListMergeDecisionsInputSchema>;
export const ReconciliationConflictGroupSchema = z.object({ canonicalJobId: EntityIdSchema, summaryJobId: EntityIdSchema,
  conflicts: z.array(MergeConflictSchema).max(12), decisionIds: z.array(EntityIdSchema).max(1000) }).strict();
export const MergeDecisionsPageSchema = z.object({
  snapshotRevision: RevisionSchema, items: z.array(z.object({ decision: MergeDecisionSchema, status: z.enum(["active", "revoked", "revocation"]) }).strict()).max(100),
  totalAvailable: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100), truncated: z.boolean(), warnings: z.array(z.string().max(2000)).max(20),
}).strict();
export type MergeDecisionsPage = z.infer<typeof MergeDecisionsPageSchema>;
