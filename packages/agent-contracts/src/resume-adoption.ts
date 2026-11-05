import { z } from "zod";
import type { EvidenceSource } from "./evidence-handoff.js";

const id = z.string().uuid(), key = z.string().min(8).max(120);
export const CreateSyntheticResumeCommand = z.object({ name: z.string().trim().min(1).max(80), expectedRevision: z.number().int().nonnegative(), idempotencyKey: key, consent: z.literal(true) }).strict();
export type CreateSyntheticResumeCommand = z.infer<typeof CreateSyntheticResumeCommand>;
export const ResumeChangeRequest = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("adopt"), assetId: id, expectedVersionId: id, proposalId: id, resumeId: z.string().min(1).max(200), experienceId: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("undo"), assetId: id, expectedVersionId: id, adoptionReceiptId: id }).strict(),
]);
export type ResumeChangeRequest = z.infer<typeof ResumeChangeRequest>;
export const SaveResumeChangeCommand = z.object({ preview: ResumeChangeRequest, previewHash: z.string().regex(/^[a-f0-9]{64}$/), idempotencyKey: key, consent: z.literal(true) }).strict();
export type SaveResumeChangeCommand = z.infer<typeof SaveResumeChangeCommand>;
export const RevokeResumePreviewCommand = z.object({ assetId: id, expectedAuthorizationRevision: z.number().int().nonnegative(), idempotencyKey: key }).strict();
export type RevokeResumePreviewCommand = z.infer<typeof RevokeResumePreviewCommand>;
export type ResumeBusinessReceipt = { id: string; key: string; commandHash: string; at: string; kind: "create" | "adopt" | "undo" | "revoke-preview";
  assetId: string; versionId: string; previousVersionId?: string; proposalId?: string; undoesReceiptId?: string;
  experienceId?: string; claimId?: string; claimHash?: string; source?: EvidenceSource };
/** document is the existing core DocumentSchema; transport consumers must validate it before use. */
export type ResumeBusinessVersion = { id: string; document: unknown; documentHash: string; projection: string; receipt: ResumeBusinessReceipt };
export type ResumeBusinessAsset = { id: string; name: string; synthetic: true; authorizationRevision: number; headVersionId: string;
  targets: { resumeId: string; experienceId: string; label: string }[]; versions: ResumeBusinessVersion[]; revocations: ResumeBusinessReceipt[] };
export type ResumeChangePreview = { request: ResumeChangeRequest; hash: string; beforeHash: string; afterHash: string;
  authorizationRevision: number; diff: { label: string; before: string; after: string }[];
  beforeProjection: string; afterProjection: string; warnings: string[] };
