import { z } from "zod";
import { AtlasDatasetSchema, CountryCodeSchema, EntityIdSchema, JobLocationSchema, RevisionSchema, TimestampSchema, type AtlasDataset, type JobLocation } from "./schema.js";

const label = z.string().trim().min(1).max(500).refine(value => !/[\p{Cc}\p{Cs}]/u.test(value), "Use plain place names.");
const area = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("china-catalog"), provinceCode: z.string().regex(/^\d{2}$/), cityCode: z.string().regex(/^\d{4}$/).optional(), districtCode: z.string().regex(/^\d{6}(?:\d{3})?$/).optional() }).strict(),
  z.object({ kind: z.literal("manual-area"), region: label.optional(), city: label.optional(), district: label.optional() }).strict(),
]);
export const LocationConfirmationProposalSchema = z.object({ locationKind: z.enum(["office", "remote-region", "unknown"]), countryCode: CountryCodeSchema, area }).strict()
  .superRefine((proposal, context) => {
    if (proposal.area.kind === "china-catalog" && (proposal.countryCode !== "CN" || proposal.area.districtCode && !proposal.area.cityCode)) context.addIssue({ code: "custom", message: "A Chinese catalog path needs CN and all parent levels." });
  });
export type LocationConfirmationProposal = z.infer<typeof LocationConfirmationProposalSchema>;
const input = { jobId: EntityIdSchema, locationId: EntityIdSchema, expectedRevision: RevisionSchema, proposal: LocationConfirmationProposalSchema, reason: label };
export const PreviewLocationConfirmationInputSchema = z.object(input).strict();
export type PreviewLocationConfirmationInput = z.infer<typeof PreviewLocationConfirmationInputSchema>;
export const ConfirmLocationInputSchema = z.object({ ...input, previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/), reviewed: z.literal(true) }).strict();
export type ConfirmLocationInput = z.infer<typeof ConfirmLocationInputSchema>;
export const RevokeLocationConfirmationInputSchema = z.object({ jobId: EntityIdSchema, locationId: EntityIdSchema, decisionId: EntityIdSchema, expectedRevision: RevisionSchema, reason: label, reviewed: z.literal(true) }).strict();
export type RevokeLocationConfirmationInput = z.infer<typeof RevokeLocationConfirmationInputSchema>;
export const ResolvedLocationAreaSchema = z.object({
  countryCode: CountryCodeSchema, kind: z.enum(["office", "remote-region", "unknown"]), regionId: label.optional(), region: label.optional(), city: label.optional(), district: label.optional(),
  basis: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("manual-area") }).strict(),
    z.object({ kind: z.literal("china-catalog"), datasetId: EntityIdSchema, version: EntityIdSchema, provinceCode: z.string().regex(/^\d{2}$/), cityCode: z.string().regex(/^\d{4}$/).optional(), districtCode: z.string().regex(/^\d{6}(?:\d{3})?$/).optional() }).strict(),
  ]),
}).strict();
export type ResolvedLocationArea = z.infer<typeof ResolvedLocationAreaSchema>;
const metadata = { id: EntityIdSchema, jobId: EntityIdSchema, listingId: EntityIdSchema, locationId: EntityIdSchema, actorScope: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:/-]+$/), at: TimestampSchema, revision: RevisionSchema, reason: label };
export const LocationConfirmationDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ ...metadata, kind: z.literal("confirm"), sourceLocation: JobLocationSchema.refine(value => !value.userResolution && !value.officeResolution, "Decisions must retain the original source location."), area: ResolvedLocationAreaSchema }).strict(),
  z.object({ ...metadata, kind: z.literal("revoke"), targetDecisionId: EntityIdSchema,
    sourceLocation: JobLocationSchema.refine(value => !value.userResolution && !value.officeResolution, "Keep original source at revocation.").optional() }).strict(),
]);
export type LocationConfirmationDecision = z.infer<typeof LocationConfirmationDecisionSchema>;
export const LocationConfirmationPreviewSchema = z.object({ expectedRevision: RevisionSchema, previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/), jobId: EntityIdSchema, locationId: EntityIdSchema, original: JobLocationSchema, current: JobLocationSchema, proposed: JobLocationSchema, activeDecisionId: EntityIdSchema.optional(), warnings: z.array(z.string().min(1).max(3000)).max(20) }).strict();
export type LocationConfirmationPreview = z.infer<typeof LocationConfirmationPreviewSchema>;
export const LocationConfirmationReceiptSchema = z.object({ ok: z.literal(true), revision: RevisionSchema, jobId: EntityIdSchema, locationId: EntityIdSchema, decisionId: EntityIdSchema, activeDecisionId: EntityIdSchema.optional(), location: JobLocationSchema }).strict();
export type LocationConfirmationReceipt = z.infer<typeof LocationConfirmationReceiptSchema>;

function stable(value: unknown): unknown { return Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, stable(entry)])) : value; }
export function sameLocationValue(left: unknown, right: unknown) { return JSON.stringify(stable(left)) === JSON.stringify(stable(right)); }
/** Only additive source address/evidence enrichment may retain a prior administrative decision. */
export function compatibleSourceLocation(previous: JobLocation, current: JobLocation): boolean {
  const { streetAddress: oldStreet, postalCode: oldPostal, evidence: oldEvidence, ...oldCore } = previous;
  const { streetAddress, postalCode, evidence, ...core } = current;
  return sameLocationValue(oldCore, core) && (!oldStreet || oldStreet === streetAddress) && (!oldPostal || oldPostal === postalCode)
    && oldEvidence.every(entry => evidence.some(value => sameLocationValue(entry, value)));
}
/** Administrative confirmation never guesses or inherits an office point. Revocation restores the source point. */
export function applyLocationConfirmation(source: JobLocation, decision: Extract<LocationConfirmationDecision, { kind: "confirm" }>): JobLocation {
  const { countryCode: _country, regionId: _regionId, region: _region, city: _city, district: _district, coordinates: _coordinates, originalCoordinates: _originalCoordinates, provider: _provider, resolvedAt: _resolvedAt, userResolution: _userResolution, ...original } = source;
  const { basis, ...fields } = decision.area;
  return JobLocationSchema.parse({ ...original, ...fields, precision: fields.city ? "city" : fields.region ? "region" : "country", verification: "unverified", userResolution: { decisionId: decision.id, method: "explicit-user-confirmation", at: decision.at, originalLocationId: source.id, basis } });
}
/** Pure replay shared by transactions and backup verification. Source text and evidence stay untouched. */
export function projectLocationConfirmations(base: AtlasDataset, input: readonly LocationConfirmationDecision[]): AtlasDataset {
  const decisions = input.map(value => LocationConfirmationDecisionSchema.parse(value));
  const sources = new Map(base.locations.map(location => [location.id, location]));
  const seen = new Map<string, LocationConfirmationDecision>(); const revoked = new Set<string>();
  let previousRevision = -1;
  for (const decision of decisions) {
    if (seen.has(decision.id) || decision.revision <= previousRevision || decision.revision > base.revision || !sources.has(decision.locationId)
      || !base.jobs.some(job => job.id === decision.jobId && job.listingIds.includes(decision.listingId))) throw new Error("invalid-location-decision");
    previousRevision = decision.revision;
    if (decision.kind === "confirm") {
      if (!decision.sourceLocation.evidence.length || decision.sourceLocation.id !== decision.locationId || !compatibleSourceLocation(decision.sourceLocation, sources.get(decision.locationId)!)
        || decision.sourceLocation.evidence.some(evidence => base.observations.find(observation => observation.id === evidence.observationId)?.listingId !== decision.listingId)) throw new Error("invalid-location-source");
    } else {
      const target = seen.get(decision.targetDecisionId);
      if (!target || target.kind !== "confirm" || target.locationId !== decision.locationId || target.jobId !== decision.jobId || target.listingId !== decision.listingId || target.actorScope !== decision.actorScope || revoked.has(target.id)) throw new Error("invalid-location-revocation");
      revoked.add(target.id);
      if (decision.sourceLocation && (decision.sourceLocation.id !== decision.locationId || !compatibleSourceLocation(decision.sourceLocation, sources.get(decision.locationId)!)
        || decision.sourceLocation.evidence.some(evidence => base.observations.find(observation => observation.id === evidence.observationId)?.listingId !== decision.listingId))) throw new Error("invalid-location-revoke-source");
    }
    seen.set(decision.id, decision);
  }
  const active = new Map<string, Extract<LocationConfirmationDecision, { kind: "confirm" }>>();
  for (const decision of decisions) if (decision.kind === "confirm" && !revoked.has(decision.id)) active.set(decision.locationId, decision);
  return AtlasDatasetSchema.parse({ ...base, locations: base.locations.map(location => active.has(location.id) ? applyLocationConfirmation(location, active.get(location.id)!) : location) });
}
