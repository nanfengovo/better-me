import { z } from "zod";
import { AtlasDatasetSchema, CoordinatesSchema, CountryCodeSchema, EntityIdSchema, HttpUrlSchema, JobLocationSchema, RevisionSchema, TimestampSchema, type AtlasDataset, type JobLocation } from "./schema.js";
import { sameLocationValue } from "./location-confirmation.js";

const text = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\p{Cc}\p{Cs}]/u.test(value), "Use plain address text.");
/** A person confirms an address and a map point; this never claims the employer/provider verified it. */
export const OfficeAddressProposalSchema = z.object({
  basis: z.literal("manual-user-confirmation"), countryCode: CountryCodeSchema,
  formattedAddress: text(2000), streetAddress: text(1000), postalCode: text(100).optional(),
  coordinates: CoordinatesSchema, evidenceUrl: HttpUrlSchema,
  coordinateMeaning: z.enum(["building", "entrance", "site"]),
}).strict();
export type OfficeAddressProposal = z.infer<typeof OfficeAddressProposalSchema>;
export const OfficeAddressCandidatesInputSchema = z.object({ jobId: EntityIdSchema, locationId: EntityIdSchema, expectedRevision: RevisionSchema,
  /** Explicit address only. A host provider is never invoked merely by opening a job. */
  query: text(2000).optional(),
}).strict();
export type OfficeAddressCandidatesInput = z.infer<typeof OfficeAddressCandidatesInputSchema>;
export const OfficeAddressCandidateSchema = z.object({ id: EntityIdSchema, providerId: EntityIdSchema,
  proposal: OfficeAddressProposalSchema, attribution: text(2000), evidenceUrl: HttpUrlSchema,
  estimated: z.literal(true), verification: z.literal("unverified"),
}).strict();
export type OfficeAddressCandidate = z.infer<typeof OfficeAddressCandidateSchema>;
export const OfficeAddressCandidatesResultSchema = z.object({ revision: RevisionSchema, jobId: EntityIdSchema, locationId: EntityIdSchema,
  sourceLocation: JobLocationSchema, configured: z.boolean(), status: z.enum(["manual-available", "not-configured", "candidates", "no-address-match"]),
  candidates: z.array(OfficeAddressCandidateSchema).max(20), warnings: z.array(text(3000)).max(20),
}).strict();
export type OfficeAddressCandidatesResult = z.infer<typeof OfficeAddressCandidatesResultSchema>;
const command = { jobId: EntityIdSchema, locationId: EntityIdSchema, expectedRevision: RevisionSchema, proposal: OfficeAddressProposalSchema, reason: text(500) };
export const PreviewOfficeConfirmationInputSchema = z.object(command).strict();
export type PreviewOfficeConfirmationInput = z.infer<typeof PreviewOfficeConfirmationInputSchema>;
export const ConfirmOfficeAddressInputSchema = z.object({ ...command, previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/), reviewed: z.literal(true) }).strict();
export type ConfirmOfficeAddressInput = z.infer<typeof ConfirmOfficeAddressInputSchema>;
export const RevokeOfficeAddressInputSchema = z.object({ jobId: EntityIdSchema, locationId: EntityIdSchema, decisionId: EntityIdSchema,
  expectedRevision: RevisionSchema, reason: text(500), reviewed: z.literal(true) }).strict();
export type RevokeOfficeAddressInput = z.infer<typeof RevokeOfficeAddressInputSchema>;
const metadata = { id: EntityIdSchema, jobId: EntityIdSchema, listingId: EntityIdSchema, locationId: EntityIdSchema,
  actorScope: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:/-]+$/), at: TimestampSchema, revision: RevisionSchema, reason: text(500) };
export const OfficeAddressDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ ...metadata, kind: z.literal("confirm"), sourceLocation: JobLocationSchema.refine(value => !value.officeResolution, "Keep the effective source/admin location before office confirmation."), proposal: OfficeAddressProposalSchema }).strict(),
  z.object({ ...metadata, kind: z.literal("revoke"), targetDecisionId: EntityIdSchema,
    sourceLocation: JobLocationSchema.refine(value => !value.officeResolution, "Keep the effective location at revocation for historical receipt validation.") }).strict(),
  z.object({ id: EntityIdSchema, kind: z.literal("invalidate"), actorScope: metadata.actorScope, at: TimestampSchema, revision: RevisionSchema,
    reason: z.literal("source-changed"), targetDecisionIds: z.array(EntityIdSchema).min(1).max(200_000).refine(values => new Set(values).size === values.length, "Invalidations cannot repeat a target.") }).strict(),
]);
export type OfficeAddressDecision = z.infer<typeof OfficeAddressDecisionSchema>;
export const OfficeAddressPreviewSchema = z.object({ expectedRevision: RevisionSchema, previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  jobId: EntityIdSchema, locationId: EntityIdSchema, current: JobLocationSchema, sourceLocation: JobLocationSchema, proposed: JobLocationSchema,
  activeDecisionId: EntityIdSchema.optional(), warnings: z.array(text(3000)).max(20) }).strict();
export type OfficeAddressPreview = z.infer<typeof OfficeAddressPreviewSchema>;
export const OfficeAddressReceiptSchema = z.object({ ok: z.literal(true), revision: RevisionSchema, jobId: EntityIdSchema, locationId: EntityIdSchema,
  decisionId: EntityIdSchema, activeDecisionId: EntityIdSchema.optional(), location: JobLocationSchema }).strict();
export type OfficeAddressReceipt = z.infer<typeof OfficeAddressReceiptSchema>;

export function applyOfficeAddressConfirmation(source: JobLocation, decision: Extract<OfficeAddressDecision, { kind: "confirm" }>): JobLocation {
  const proposal = decision.proposal;
  if (source.kind !== "office" || !source.evidence.length || source.officeResolution || source.countryCode && source.countryCode !== proposal.countryCode) throw new Error("invalid-office-source");
  const { originalCoordinates: _originalCoordinates, postalCode: _postalCode, ...retained } = source;
  return JobLocationSchema.parse({ ...retained, countryCode: proposal.countryCode, streetAddress: proposal.streetAddress,
    ...(proposal.postalCode ? { postalCode: proposal.postalCode } : {}), coordinates: proposal.coordinates, precision: "address", verification: "unverified",
    provider: "manual-user-confirmation", resolvedAt: decision.at,
    officeResolution: { decisionId: decision.id, method: "manual-user-confirmation", at: decision.at, originalLocationId: source.id,
      formattedAddress: proposal.formattedAddress, streetAddress: proposal.streetAddress, ...(proposal.postalCode ? { postalCode: proposal.postalCode } : {}),
      coordinateMeaning: proposal.coordinateMeaning, evidenceUrl: proposal.evidenceUrl },
  });
}

/** Historical decisions remain valid history when their full effective source/area has changed. */
export function projectOfficeAddressConfirmations(base: AtlasDataset, input: readonly OfficeAddressDecision[]): AtlasDataset {
  const decisions = input.map(value => OfficeAddressDecisionSchema.parse(value));
  const seen = new Map<string, OfficeAddressDecision>(); const revoked = new Set<string>(); const invalidated = new Set<string>(); let previous = -1;
  for (const decision of decisions) {
    if (seen.has(decision.id) || decision.revision <= previous || decision.revision > base.revision) throw new Error("invalid-office-decision");
    previous = decision.revision;
    if (decision.kind === "confirm") {
      if (decision.sourceLocation.id !== decision.locationId || decision.sourceLocation.kind !== "office" || !decision.sourceLocation.evidence.length
        || decision.sourceLocation.evidence.some(ref => base.observations.find(value => value.id === ref.observationId)?.listingId !== decision.listingId)
        || !base.listings.some(value => value.id === decision.listingId)) throw new Error("invalid-office-source");
      applyOfficeAddressConfirmation(decision.sourceLocation, decision);
    } else if (decision.kind === "revoke") {
      const target = seen.get(decision.targetDecisionId);
      if (!target || target.kind !== "confirm" || target.locationId !== decision.locationId || target.jobId !== decision.jobId || target.listingId !== decision.listingId
        || target.actorScope !== decision.actorScope || revoked.has(target.id)) throw new Error("invalid-office-revocation");
      revoked.add(target.id);
      if (decision.sourceLocation.id !== decision.locationId || !decision.sourceLocation.evidence.length
        || decision.sourceLocation.evidence.some(ref => base.observations.find(value => value.id === ref.observationId)?.listingId !== decision.listingId)) throw new Error("invalid-office-revoke-source");
    } else {
      for (const id of decision.targetDecisionIds) {
        if (seen.get(id)?.kind !== "confirm" || revoked.has(id) || invalidated.has(id)) throw new Error("invalid-office-invalidation");
        invalidated.add(id);
      }
    }
    seen.set(decision.id, decision);
  }
  const active = new Map<string, Extract<OfficeAddressDecision, { kind: "confirm" }>>();
  for (const decision of decisions) if (decision.kind === "confirm" && !revoked.has(decision.id) && !invalidated.has(decision.id)) active.set(decision.locationId, decision);
  return AtlasDatasetSchema.parse({ ...base, locations: base.locations.map(location => {
    const decision = active.get(location.id);
    const owner = decision && base.jobs.find(job => job.id === decision.jobId && job.listingIds.includes(decision.listingId) && job.locationIds.includes(location.id));
    return decision && owner && sameLocationValue(location, decision.sourceLocation) ? applyOfficeAddressConfirmation(location, decision) : location;
  }) });
}
