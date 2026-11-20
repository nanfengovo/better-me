import { z } from "zod";
import { FactBaseSchema } from "./fact.js";
import { ResumeViewSchema } from "./resume.js";

const evidenceDigest = z.string().regex(/^[a-f0-9]{64}$/);
const RequirementEvidenceReviewSchema = z.object({
  jobVersion: evidenceDigest,
  jobId: z.string().optional(),
  itemId: z.string().min(1),
  quote: z.string().min(1).max(2000),
  capabilityId: evidenceDigest.optional(), // Legacy work associations resolve from their frozen requirement.
  sourceVersion: evidenceDigest,
  contribution: z.enum(["design", "implementation", "collaboration", "maintenance", "other"]),
  assessment: z.enum(["supports", "partial", "withdrawn"]),
  reviewedAt: z.string().datetime(),
});

const WorkRequirementEvidenceSchema = RequirementEvidenceReviewSchema.extend({
  sourceKind: z.literal("work").optional(),
  experienceId: z.string().min(1),
  claimId: z.string().min(1),
  sourceLabel: z.string().max(1000).optional(),
  sourceExcerpt: z.string().max(2000).optional(),
});

const RetestRequirementEvidenceSchema = RequirementEvidenceReviewSchema.extend({
  sourceKind: z.literal("independent-retest"),
  kitId: z.string().uuid(),
  kitVersion: evidenceDigest,
  questionVersion: evidenceDigest,
  sourceLabel: z.string().min(1).max(80),
  changedCondition: z.string().min(1).max(1050),
  criterion: z.string().min(1).max(300),
  completedAt: z.string().datetime(),
  result: z.enum(["met", "missed", "recorded"]),
});

/** User-reviewed links and their earlier decisions. The underlying material stays in its owning record. */
export const RequirementEvidenceLinkSchema = z.union([WorkRequirementEvidenceSchema, RetestRequirementEvidenceSchema]);
export type RequirementEvidenceLink = z.infer<typeof RequirementEvidenceLinkSchema>;

/** Pure document contract shared by browser persistence and private recovery; no browser or AI imports. */
export const DocumentSchema = z.object({
  documentId: z.string().min(1).max(200).optional(),
  factBase: FactBaseSchema,
  requirementEvidence: z.array(RequirementEvidenceLinkSchema).max(10000).optional(),
  resumeViews: z.array(ResumeViewSchema).min(1),
  activeResumeId: z.string().min(1),
}).refine(doc => doc.resumeViews.some(view => view.id === doc.activeResumeId), {
  message: "当前简历视图不存在，请检查备份中的 activeResumeId。", path: ["activeResumeId"],
});
export type RecoveryDocument = z.infer<typeof DocumentSchema>;
