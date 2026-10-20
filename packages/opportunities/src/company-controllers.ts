import { z } from "zod";
import {
  CompanyControllerSchema,
  CompanyControllersSchema,
  CompanySchema,
  EntityIdSchema,
  EvidenceRefSchema,
  RevisionSchema,
} from "./schema.js";
import {
  CompanyClassificationSchema,
  CompanyColorMatchSchema,
} from "./colors.js";

export const CompanyControllerOverrideProposalSchema = z.object({
  controllers: z.array(CompanyControllerSchema).min(1).max(100),
  evidence: z.array(EvidenceRefSchema).min(1).max(200),
  reason: z.string().trim().min(1).max(2000),
}).strict();

export type CompanyControllerOverrideProposal = z.infer<typeof CompanyControllerOverrideProposalSchema>;

export const PreviewCompanyControllerOverrideInputSchema = z.object({
  companyId: EntityIdSchema,
  expectedRevision: RevisionSchema,
  proposal: CompanyControllerOverrideProposalSchema,
}).strict();

export type PreviewCompanyControllerOverrideInput = z.infer<typeof PreviewCompanyControllerOverrideInputSchema>;

export const ConfirmCompanyControllerOverrideInputSchema = PreviewCompanyControllerOverrideInputSchema.extend({
  previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  reviewed: z.literal(true),
}).strict();

export type ConfirmCompanyControllerOverrideInput = z.infer<typeof ConfirmCompanyControllerOverrideInputSchema>;

export const RevokeCompanyControllerOverrideInputSchema = z.object({
  companyId: EntityIdSchema,
  expectedRevision: RevisionSchema,
  decisionId: EntityIdSchema,
  reason: z.string().trim().min(1).max(2000),
  reviewed: z.literal(true),
}).strict();

export type RevokeCompanyControllerOverrideInput = z.infer<typeof RevokeCompanyControllerOverrideInputSchema>;

export const CompanyControllerOverridePreviewSchema = z.object({
  companyId: EntityIdSchema,
  previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  proposedControllers: CompanyControllersSchema,
  classification: CompanyClassificationSchema,
  colorMatch: CompanyColorMatchSchema,
}).strict();

export type CompanyControllerOverridePreview = z.infer<typeof CompanyControllerOverridePreviewSchema>;

export const CompanyControllerOverrideReceiptSchema = z.object({
  ok: z.literal(true),
  revision: RevisionSchema,
  decisionId: EntityIdSchema,
  activeDecisionId: EntityIdSchema.optional(),
  company: CompanySchema,
  classification: CompanyClassificationSchema,
  colorMatch: CompanyColorMatchSchema,
}).strict();

export type CompanyControllerOverrideReceipt = z.infer<typeof CompanyControllerOverrideReceiptSchema>;
