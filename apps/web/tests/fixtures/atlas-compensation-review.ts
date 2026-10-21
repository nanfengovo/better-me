import {
  AtlasDatasetSchema, applyCompensationReviewConfirmation, captureCompensationReviewSourceBinding,
  type Compensation, type CompensationReviewConfirmation, type CompensationReviewProposal,
  type CompensationReviewPreview, type CompensationReviewReadResult, type CompensationReviewReceipt, type PreviewCompensationReviewInput,
} from "@better-me/opportunities";
import { createAtlasDemo } from "../../src/components/atlas/demo.ts";

export const compensationAt = "2026-10-21T12:00:00.000Z";
export const compensationText = "税前固定月薪人民币 20,000–30,000 元；每年保证发放13个月工资。";
export const compensationData = createAtlasDemo();
compensationData.revision = 11;
export const compensationJobId = compensationData.jobs[0]!.id;
export const compensationListingId = compensationData.listings[0]!.id;
export const compensationObservationId = compensationData.observations[0]!.id;
export const compensationSource: Compensation = { id: compensationData.compensations[0]!.id, locationIds: compensationData.jobs[0]!.locationIds,
  raw: compensationText, period: "unknown", tax: "unknown", kind: "unknown", verification: "unverified",
  evidence: [{ observationId: compensationObservationId, sourceUrl: compensationData.listings[0]!.canonicalUrl!,
    observedAt: compensationAt, quote: "税前固定月薪人民币 20,000–30,000 元" }] };
compensationData.compensations[0] = compensationSource;
compensationData.listings[0]!.compensationIds = [compensationSource.id];
compensationData.observations[0] = { ...compensationData.observations[0]!, fetchedAt: compensationAt, rawText: compensationText };
AtlasDatasetSchema.parse(compensationData);
export const compensationReason = "按已保存的同岗位原文逐字段核对，未纳入奖金和股票。";
export const compensationProposal: CompensationReviewProposal = { basis: "manual-evidence-review", min: 20_000, max: 30_000,
  currency: "CNY", period: "month", tax: "gross", kind: "base", monthsPerYear: 13,
  supports: (["min", "max", "currency", "period", "tax", "kind", "monthsPerYear"] as const).map(field => ({ field,
    reference: { observationId: compensationObservationId, sourceUrl: compensationData.listings[0]!.canonicalUrl!, observedAt: compensationAt, quote: compensationText } })) };
export const compensationInput: PreviewCompensationReviewInput = { jobId: compensationJobId, compensationId: compensationSource.id,
  expectedRevision: 11, proposal: compensationProposal, reason: compensationReason };
export const compensationDecision: CompensationReviewConfirmation = { id: "synthetic-compensation-confirm", kind: "confirm", jobId: compensationJobId,
  listingId: compensationListingId, compensationId: compensationSource.id, actorScope: "synthetic-reviewer", at: compensationAt, revision: 12,
  reason: compensationReason, sourceCompensation: compensationSource, proposal: compensationProposal,
  sourceBinding: captureCompensationReviewSourceBinding(compensationData, { jobId: compensationJobId, listingId: compensationListingId,
    compensationId: compensationSource.id, sourceCompensation: compensationSource, proposal: compensationProposal }) };
export const compensationConfirmed = applyCompensationReviewConfirmation(compensationSource, compensationDecision);
export const compensationReceipt: CompensationReviewReceipt = { ok: true, revision: 12, jobId: compensationJobId, compensationId: compensationSource.id,
  decisionId: compensationDecision.id, activeDecisionId: compensationDecision.id, compensation: compensationConfirmed };
export const compensationRevokeReceipt: CompensationReviewReceipt = { ok: true, revision: 13, jobId: compensationJobId, compensationId: compensationSource.id,
  decisionId: "synthetic-compensation-revoke", compensation: compensationSource };
export const compensationSnapshot = AtlasDatasetSchema.parse({ ...compensationData, revision: 12,
  compensations: compensationData.compensations.map(value => value.id === compensationSource.id ? compensationConfirmed : value) });
export function compensationRead(reviewed = false): CompensationReviewReadResult {
  return { schemaVersion: 1, revision: reviewed ? 12 : 11, jobId: compensationJobId, compensationId: compensationSource.id, listingId: compensationListingId,
    sourceCompensation: compensationSource, current: reviewed ? compensationConfirmed : compensationSource,
    ...(reviewed ? { activeDecisionId: compensationDecision.id } : {}), history: reviewed ? [compensationDecision] : [] };
}
export function compensationPreview(input: PreviewCompensationReviewInput = compensationInput): CompensationReviewPreview {
  return { expectedRevision: input.expectedRevision, previewFingerprint: "c".repeat(64), jobId: input.jobId, compensationId: input.compensationId,
    listingId: compensationListingId, sourceCompensation: compensationSource, current: compensationSource,
    proposed: applyCompensationReviewConfirmation(compensationSource, { ...compensationDecision, proposal: input.proposal }), warnings: ["本人按来源核对，仍标为待核实。"] };
}
export const compensationRoutes = { read: "/api/v1/compensations/review", preview: "/api/v1/compensations/preview", confirm: "/api/v1/compensations/confirm",
  revoke: "/api/v1/compensations/revoke", snapshot: "/api/v1/dataset/export" };
