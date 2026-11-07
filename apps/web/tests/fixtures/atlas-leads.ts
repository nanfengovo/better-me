import { SourceDefinitionSchema, type AtlasDataset } from "@better-me/opportunities";
import { OriginalLeadCaptureSchema, OriginalLeadPreviewSchema, type LeadQueryItem } from "@better-me/source-adapters/browser-contracts";
import { createAtlasDemo } from "../../src/components/atlas/demo.ts";

const demo = createAtlasDemo();
export const leadAt = "2026-10-22T12:00:00.000Z";
export const originalSource = SourceDefinitionSchema.parse({ ...demo.sources[0]!, enabled: true, status: "active",
  adapterId: "jobposting-jsonld", capabilities: ["list-jobs"], entryUrl: "https://example.invalid/jobs",
  attribution: { label: "Synthetic original employer", usage: "metadata", requiresAttribution: true } });
export const discoverySource = SourceDefinitionSchema.parse({ ...originalSource, sourceId: "synthetic-github-leads", adapterId: "github-json",
  name: "Synthetic GitHub leads", entityType: "company-directory", attribution: { label: "Synthetic GitHub", usage: "metadata", requiresAttribution: true } });
export const leadItem: LeadQueryItem = {
  lead: { id: "synthetic-persisted-lead", sourceId: discoverySource.sourceId, observedAt: leadAt,
    record: { entityType: "discovery-lead", sourceRecordId: "repository-row-37", url: "https://example.invalid/demo/0",
      title: "Synthetic discovery title", companyName: "Synthetic directory employer", description: "Retained discovery excerpt, not an original JD.",
      locations: [], compensations: [], workMode: "unknown", employmentType: "unknown", remoteEligibleRegions: [],
      availability: "unknown", completeness: "lead", evidence: [], sourcePublishedRaw: "2020-01-02", warnings: [] } },
  leadDigest: "a".repeat(64), source: discoverySource, eligibleOriginalSources: [originalSource], resolvedJobs: [],
};
export const leadCapture = OriginalLeadCaptureSchema.parse({
  schemaVersion: 1, leadId: leadItem.lead.id, leadDigest: leadItem.leadDigest,
  discoverySourceId: discoverySource.sourceId, discoverySourceFingerprint: "b".repeat(64),
  originalSourceId: originalSource.sourceId, originalSourceFingerprint: "c".repeat(64),
  url: leadItem.lead.record.url, observedAt: leadAt,
  readSessionId: "d".repeat(32), readSequence: 1, proof: "e".repeat(64),
  record: { entityType: "job-posting", sourceRecordId: "demo-0", url: leadItem.lead.record.url,
    title: demo.jobs[0]!.title.value, companyName: demo.companies[0]!.names[0], description: demo.jobs[0]!.description,
    locations: [{ raw: "Synthetic source work address", countryCode: "CN", city: "上海", streetAddress: "123 Synthetic Road" }], compensations: [],
    workMode: "on-site", employmentType: "social", remoteEligibleRegions: [], availability: "unknown", completeness: "detail",
    evidence: [{ field: "description", sourceUrl: leadItem.lead.record.url, selector: "JobPosting.description", quote: demo.jobs[0]!.description }], warnings: [] },
});
export function leadData(revision = 8): AtlasDataset {
  const data = createAtlasDemo(); data.revision = revision; data.sources = [originalSource, discoverySource];
  data.locations[0] = { ...data.locations[0]!, coordinates: undefined, provider: undefined, streetAddress: "123 Synthetic Road" };
  return data;
}
export const leadPreview = OriginalLeadPreviewSchema.parse({ leadId: leadItem.lead.id, originalSourceId: originalSource.sourceId,
  expectedRevision: 7, previewFingerprint: "f".repeat(64), job: leadData().jobs[0], canonicalJobId: leadData().jobs[0]!.id,
  listings: [leadData().listings[0]], locations: [leadData().locations[0]],
  warnings: ["Synthetic source address is not a confirmed office coordinate."] });
export const leadReceipt = { ok: true as const, revision: 8, jobIds: [leadPreview.job.id], snapshotIds: [],
  counts: { newJobs: 1, updatedJobs: 0, unchangedJobs: 0, newListings: 1, newObservations: 1, newSnapshots: 1 } };
export const leadQuery = { snapshotRevision: 7, items: [leadItem], totalLeads: 1 };
export const leadRead = { snapshotRevision: 7, ...leadItem };
export const leadImport = { capture: leadCapture, expectedRevision: 7, previewFingerprint: leadPreview.previewFingerprint, reviewed: true as const };
