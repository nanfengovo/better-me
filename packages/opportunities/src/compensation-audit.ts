import { z } from "zod";
import {
  CompensationSchema,
  CurrencyCodeSchema,
  EntityIdSchema,
  EvidenceRefSchema,
  RevisionSchema,
} from "./schema.js";
import {
  NormalizedCompensationSchema,
} from "./compensation.js";

export const CompensationAuditProposalSchema = z.object({
  currency: CurrencyCodeSchema.default("CNY"),
  period: z.enum(["month", "year", "hour", "day", "week"]).default("month"),
  min: z.number().finite().nonnegative().optional(),
  max: z.number().finite().nonnegative().optional(),
  tax: z.enum(["gross", "net", "unknown"]).default("gross"),
  kind: z.enum(["base", "bonus", "equity", "total", "unknown"]).default("base"),
  monthsPerYear: z.number().finite().positive().max(36).optional(),
  hoursPerYear: z.number().finite().positive().max(8784).optional(),
  daysPerYear: z.number().finite().positive().max(366).optional(),
  weeksPerYear: z.number().finite().positive().max(53).optional(),
  evidence: z.array(EvidenceRefSchema).min(1).max(200),
  reason: z.string().trim().min(1).max(2000),
}).strict().refine((p) => p.min !== undefined || p.max !== undefined, "At least min or max amount required");

export type CompensationAuditProposal = z.infer<typeof CompensationAuditProposalSchema>;

export const PreviewCompensationAuditInputSchema = z.object({
  jobId: EntityIdSchema,
  compensationId: EntityIdSchema,
  expectedRevision: RevisionSchema,
  proposal: CompensationAuditProposalSchema,
}).strict();

export type PreviewCompensationAuditInput = z.infer<typeof PreviewCompensationAuditInputSchema>;

export const ConfirmCompensationAuditInputSchema = PreviewCompensationAuditInputSchema.extend({
  previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  reviewed: z.literal(true),
}).strict();

export type ConfirmCompensationAuditInput = z.infer<typeof ConfirmCompensationAuditInputSchema>;

export const RevokeCompensationAuditInputSchema = z.object({
  jobId: EntityIdSchema,
  compensationId: EntityIdSchema,
  expectedRevision: RevisionSchema,
  decisionId: EntityIdSchema,
  reason: z.string().trim().min(1).max(2000),
  reviewed: z.literal(true),
}).strict();

export type RevokeCompensationAuditInput = z.infer<typeof RevokeCompensationAuditInputSchema>;

export const CompensationAuditPreviewSchema = z.object({
  jobId: EntityIdSchema,
  compensationId: EntityIdSchema,
  previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  proposed: CompensationSchema,
  normalized: NormalizedCompensationSchema,
}).strict();

export type CompensationAuditPreview = z.infer<typeof CompensationAuditPreviewSchema>;

export const CompensationAuditReceiptSchema = z.object({
  ok: z.literal(true),
  revision: RevisionSchema,
  decisionId: EntityIdSchema,
  activeDecisionId: EntityIdSchema.optional(),
  compensation: CompensationSchema,
  normalized: NormalizedCompensationSchema,
}).strict();

export type CompensationAuditReceipt = z.infer<typeof CompensationAuditReceiptSchema>;
