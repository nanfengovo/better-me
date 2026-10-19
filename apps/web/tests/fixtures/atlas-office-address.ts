import { applyOfficeAddressConfirmation, type OfficeAddressCandidate, type OfficeAddressPreview, type OfficeAddressProposal,
  type OfficeAddressReceipt, type PreviewOfficeConfirmationInput, type OfficeAddressCandidatesResult } from "@better-me/opportunities";
import { createAtlasDemo } from "../../src/components/atlas/demo.ts";

export const officeAt = "2026-10-19T12:00:00.000Z";
export const officeBase = createAtlasDemo();
export const officeSource = { id: officeBase.locations[0]!.id, raw: "Synthetic Shanghai office", kind: "office" as const,
  countryCode: "CN", city: "Shanghai", precision: "city" as const, verification: "unverified" as const, evidence: officeBase.locations[0]!.evidence };
export const officeProposal: OfficeAddressProposal = { basis: "manual-user-confirmation", countryCode: "CN",
  formattedAddress: "Synthetic Example Road 10, Shanghai", streetAddress: "Synthetic Example Road 10", postalCode: "200000",
  coordinates: { latitude: 31.123456, longitude: 121.654321, coordinateSystem: "WGS84" }, coordinateMeaning: "building",
  evidenceUrl: "https://careers.example.invalid/jobs/synthetic-office" };
export const officeJobId = officeBase.jobs[0]!.id;
export const officeReason = "Synthetic fixture: personally checked this job, address and WGS84 point.";
export const officeConfirmed = applyOfficeAddressConfirmation(officeSource, { id: "synthetic-office-confirmation", kind: "confirm",
  jobId: officeJobId, listingId: officeBase.listings[0]!.id, locationId: officeSource.id, actorScope: "synthetic-owner", at: officeAt,
  revision: 12, reason: officeReason, sourceLocation: officeSource, proposal: officeProposal });
export const officeReceipt: OfficeAddressReceipt = { ok: true, revision: 12, jobId: officeJobId, locationId: officeSource.id,
  decisionId: "synthetic-office-confirmation", activeDecisionId: "synthetic-office-confirmation", location: officeConfirmed };
export const officeRevocation: OfficeAddressReceipt = { ok: true, revision: 12, jobId: officeJobId, locationId: officeSource.id,
  decisionId: "synthetic-office-revocation", location: officeSource };
export const officeSnapshot = { ...officeBase, revision: 12, locations: officeBase.locations.map(location => location.id === officeSource.id ? officeConfirmed : location) };
export function officePreview(input?: PreviewOfficeConfirmationInput): OfficeAddressPreview {
  return { expectedRevision: input?.expectedRevision ?? 11, previewFingerprint: "b".repeat(64), jobId: input?.jobId ?? officeJobId,
    locationId: input?.locationId ?? officeSource.id, current: officeSource, sourceLocation: officeSource, proposed: officeConfirmed,
    warnings: ["Synthetic manual confirmation stays unverified; not an employer-certified office."] };
}
export const officeCandidate: OfficeAddressCandidate = { id: "synthetic-office-candidate", providerId: "synthetic-address-provider", proposal: officeProposal,
  attribution: "Synthetic address fixture", evidenceUrl: "https://maps.example.invalid/place/synthetic", estimated: true, verification: "unverified" };
export const officeCandidates: OfficeAddressCandidatesResult = { revision: 11, jobId: officeJobId, locationId: officeSource.id, sourceLocation: officeSource,
  configured: true, status: "candidates", candidates: [officeCandidate], warnings: ["Synthetic candidate, not employer verification."] };
export const officeRoutes = { candidates: "/api/v1/locations/office-address/candidates", preview: "/api/v1/locations/office-address/preview",
  confirm: "/api/v1/locations/office-address/confirmations", revoke: "/api/v1/locations/office-address/revoke", snapshot: "/api/v1/dataset/export" };
