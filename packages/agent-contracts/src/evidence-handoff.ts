import { z } from "zod";
import type { EvidenceReviewInput, RequirementReference } from "./capabilities.js";
import type { ResumeBusinessAsset } from "./resume-adoption.js";

const claim = z.object({ kind: z.enum(["implementation", "design"]), action: z.string().trim().min(1).max(2500),
  role: z.string().trim().max(300), deployment: z.string().trim().max(600) }).strict();
export const EvidenceDecision = z.union([claim, z.object({ kind: z.enum(["not-mine", "unknown"]), note: z.string().trim().max(2500) }).strict()]);
export type EvidenceDecision = z.infer<typeof EvidenceDecision>;
const command = { expectedRevision: z.number().int().nonnegative(), idempotencyKey: z.string().min(8).max(120), consent: z.literal(true) };
export const EvidenceReviewCommand = z.object({ ...command, taskId: z.string().uuid(), reportReceiptId: z.string().uuid(),
  reportHash: z.string().regex(/^[a-f0-9]{64}$/), itemIndex: z.number().int().nonnegative(), decision: EvidenceDecision }).strict();
export type EvidenceReviewCommand = z.infer<typeof EvidenceReviewCommand>;
export const EvidenceProposalCommand = z.object({ ...command, reviewId: z.string().uuid() }).strict();
export type EvidenceProposalCommand = z.infer<typeof EvidenceProposalCommand>;
export type EvidenceSource = { taskId: string; reportReceiptId: string; reportHash: string; inputHash: string;
  codeHash: string; recipeHash: string; verificationId: string; itemIndex: number; title: string;
  requirement: RequirementReference; notes: EvidenceReviewInput["notes"] };
type CommandReceipt = { id: string; key: string; commandHash: string; revision: number; at: string };
export type PersonalEvidenceReview = { id: string; source: EvidenceSource; decision: EvidenceDecision;
  supersedes?: string; receipt: CommandReceipt };
export type EvidenceChangeProposal = { id: string; reviewId: string; source: EvidenceSource;
  status: "pending_business_review"; candidate: z.infer<typeof claim>; limitations: string[]; receipt: CommandReceipt;
  /** Derived on read; historical proposal payloads are never rewritten. */
  eligibility?: "current" | "review_superseded" | "source_revoked" | "source_invalidated" };
export type WorkspaceEvidenceSnapshot = { revision: number; reviews: PersonalEvidenceReview[]; proposals: EvidenceChangeProposal[]; resumeAssets?: ResumeBusinessAsset[] };
