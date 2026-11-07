import assert from "node:assert/strict";
import test from "node:test";
import type { SourceDefinition } from "@better-me/opportunities";
import {
  DiscoveryLeadSchema, LeadQueryInputSchema, LeadQueryItemSchema, LeadQueryResultSchema,
  LeadReadInputSchema, LeadReadResultSchema, OriginalLeadCaptureSchema, OriginalLeadImportInputSchema,
  OriginalLeadPreviewInputSchema, OriginalLeadPreviewSchema, OriginalLeadReadInputSchema,
  type DiscoveryLead, type OriginalLeadCapture,
} from "../src/browser-contracts.js";

const at = "2026-10-23T01:00:00.000Z", digest = "a".repeat(64), url = "https://careers.example.com/jobs/original-1";
const source: SourceDefinition = {
  sourceId: "synthetic-discovery", name: "Synthetic discovery source", adapterId: "synthetic", adapterVersion: "1",
  capabilities: ["discover-sources"], runtime: ["local-service"], entityType: "company-directory", enabled: false, status: "needs-review", remoteFilters: [],
  endpointPolicy: { allowedHosts: ["example.com"], allowedPathPrefixes: ["/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
  attribution: { label: "Synthetic source", usage: "link-only", requiresAttribution: true },
  refreshPolicy: { mode: "manual", minIntervalSeconds: 60, maxRecords: 100, maxPages: 1, requestsPerMinute: 5 }, secretRef: "synthetic-secret-reference",
};
const lead: DiscoveryLead = {
  id: "synthetic-lead", sourceId: source.sourceId, observedAt: at,
  record: { entityType: "discovery-lead", sourceRecordId: "discovery-1", url, title: "Synthetic employer careers",
    locations: [], compensations: [], workMode: "unknown", employmentType: "unknown", remoteEligibleRegions: [], availability: "unknown",
    completeness: "lead", evidence: [], warnings: [] },
};
const item = { lead, leadDigest: digest, source, eligibleOriginalSources: [], resolvedJobs: [{ jobId: "canonical-job", title: "Synthetic original job", sourceId: "original-source", url }] };
const capture: OriginalLeadCapture = {
  schemaVersion: 1, leadId: lead.id, leadDigest: digest, discoverySourceId: source.sourceId, discoverySourceFingerprint: digest,
  originalSourceId: "original-source", originalSourceFingerprint: "b".repeat(64), url, observedAt: at,
  record: { ...lead.record, entityType: "job-posting", completeness: "detail", sourceRecordId: "original-1", companyName: "Synthetic employer", description: "Synthetic original job requirements." },
  readSessionId: "c".repeat(32), readSequence: 1, proof: "d".repeat(64),
};
const readInput = { leadId: lead.id, leadDigest: digest, originalSourceId: capture.originalSourceId, expectedRevision: 4 };
const previewInput = { capture, expectedRevision: 4 };
const job = {
  id: "canonical-job", companyId: "synthetic-employer", title: { value: "Synthetic original job", method: "manual", verification: "unverified", evidence: [], revision: 0 },
  description: capture.record.description!, locationIds: ["source-place"], compensationIds: [], listingIds: ["original-listing"],
  workMode: "unknown", employmentType: "unknown", remoteEligibleRegions: [], status: "unknown", revision: 0, updatedAt: at,
};
const listing = { id: "original-listing", sourceId: capture.originalSourceId, sourceRecordId: "original-1", canonicalUrl: url,
  canonicalJobId: job.id, observationIds: [], firstDiscoveredAt: at, discoverySourceIds: [source.sourceId], discoveredViaUrls: [url] };
const location = { id: "source-place", raw: "Synthetic city", precision: "unknown", evidence: [], verification: "unverified" };
const preview = { leadId: lead.id, originalSourceId: capture.originalSourceId, expectedRevision: 4, previewFingerprint: digest,
  canonicalJobId: job.id, job, listings: [listing], locations: [location], warnings: ["The original source has not established an office point."] };

test("persisted lead contracts keep discovery and recruitment campaigns separate from canonical jobs", () => {
  assert.deepEqual(DiscoveryLeadSchema.parse(lead), lead);
  assert.equal(DiscoveryLeadSchema.safeParse({ ...lead, record: { ...lead.record, entityType: "recruitment-campaign" } }).success, true);
  assert.equal(DiscoveryLeadSchema.safeParse({ ...lead, record: capture.record }).success, false);
  assert.equal(DiscoveryLeadSchema.safeParse({ ...lead, arbitraryUrl: url }).success, false);
  assert.equal(DiscoveryLeadSchema.safeParse({ ...lead, record: { ...lead.record, parser: "arbitrary-code" } }).success, false);
});

test("lead queries have bounded paging and filters without accepting a caller endpoint", () => {
  assert.deepEqual(LeadQueryInputSchema.parse({}), { limit: 50 });
  assert.deepEqual(LeadQueryInputSchema.parse({ sourceId: source.sourceId, search: "  C#  ", entityType: "discovery-lead", limit: 100, cursor: "opaque" }),
    { sourceId: source.sourceId, search: "C#", entityType: "discovery-lead", limit: 100, cursor: "opaque" });
  for (const changes of [{ url }, { sourceId: "bad/source" }, { search: " " }, { search: "x".repeat(501) }, { entityType: "job-posting" },
    { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { cursor: "" }, { cursor: "x".repeat(2001) }]) {
    assert.equal(LeadQueryInputSchema.safeParse(changes).success, false, JSON.stringify(changes));
  }
  assert.equal(LeadQueryInputSchema.safeParse({ cursor: "x".repeat(2000) }).success, true);
});

test("lead query and read results share source ownership, resolved original links and a snapshot revision", () => {
  const result = { snapshotRevision: 4, items: [item], totalLeads: 2, nextCursor: "next-page" };
  assert.deepEqual(LeadQueryResultSchema.parse(result), result);
  assert.deepEqual(LeadReadResultSchema.parse({ snapshotRevision: 4, ...item }), { snapshotRevision: 4, ...item });
  assert.equal(LeadQueryItemSchema.parse(item).source.secretRef, "synthetic-secret-reference");
  for (const candidate of [{ ...item, source: { ...source, sourceId: "wrong-source" } }, { ...item, leadDigest: "g".repeat(64) },
    { ...item, resolvedJobs: [{ ...item.resolvedJobs[0], arbitraryUrl: url }] }, { ...item, source: { ...source, apiKey: "synthetic-forbidden-key" } }]) {
    assert.equal(LeadQueryItemSchema.safeParse(candidate).success, false);
    assert.equal(LeadReadResultSchema.safeParse({ snapshotRevision: 4, ...candidate }).success, false);
  }
  for (const changes of [{ snapshotRevision: -1 }, { snapshotRevision: Number.MAX_SAFE_INTEGER + 1 }, { totalLeads: 0 }, { nextCursor: "x".repeat(2001) }, { unknown: true }]) {
    assert.equal(LeadQueryResultSchema.safeParse({ ...result, ...changes }).success, false);
  }
  assert.equal(LeadQueryResultSchema.safeParse({ ...result, items: Array(101).fill(item), totalLeads: 101 }).success, false);
});

test("original reads and single-lead reads only accept durable identities and expected revisions", () => {
  assert.deepEqual(LeadReadInputSchema.parse({ leadId: lead.id }), { leadId: lead.id });
  assert.deepEqual(OriginalLeadReadInputSchema.parse(readInput), readInput);
  for (const changes of [{ url }, { endpointPolicy: source.endpointPolicy }, { proof: digest }, { expectedRevision: -1 }, { expectedRevision: 1.5 }]) {
    assert.equal(OriginalLeadReadInputSchema.safeParse({ ...readInput, ...changes }).success, false);
  }
  assert.equal(LeadReadInputSchema.safeParse({ leadId: lead.id, expectedRevision: 0 }).success, true);
  assert.equal(LeadReadInputSchema.safeParse({ leadId: lead.id, expectedRevision: Number.MAX_SAFE_INTEGER + 1 }).success, false);
  assert.equal(LeadReadInputSchema.safeParse({ leadId: lead.id, url }).success, false);
});

test("original captures require a detailed same-URL posting with original identity and employer", () => {
  assert.deepEqual(OriginalLeadCaptureSchema.parse(capture), capture);
  for (const record of [{ ...capture.record, entityType: "discovery-lead", completeness: "lead" }, { ...capture.record, completeness: "excerpt" },
    { ...capture.record, companyName: undefined }, { ...capture.record, companyName: " " }, { ...capture.record, sourceRecordId: undefined },
    { ...capture.record, sourceRecordId: " " }, { ...capture.record, url: undefined }, { ...capture.record, url: `${url}/other` },
    { ...capture.record, description: undefined }, { ...capture.record, description: " " }]) {
    assert.equal(OriginalLeadCaptureSchema.safeParse({ ...capture, record }).success, false, JSON.stringify(record));
  }
});

test("capture proofs, digests, session and sequence identities reject malformed authentication fields", () => {
  for (const field of ["leadDigest", "discoverySourceFingerprint", "originalSourceFingerprint", "proof"] as const) {
    for (const value of ["a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), " a".repeat(32)]) {
      assert.equal(OriginalLeadCaptureSchema.safeParse({ ...capture, [field]: value }).success, false, `${field}/${value}`);
    }
  }
  for (const changes of [{ schemaVersion: 2 }, { readSessionId: "c".repeat(31) }, { readSessionId: "c".repeat(33) }, { readSessionId: "C".repeat(32) },
    { readSequence: 0 }, { readSequence: 1.5 }, { readSequence: Number.MAX_SAFE_INTEGER + 1 }, { actorScope: "untrusted" }, { key: "forbidden" }]) {
    assert.equal(OriginalLeadCaptureSchema.safeParse({ ...capture, ...changes }).success, false, JSON.stringify(changes));
  }
});

test("preview and reviewed import require the original capture and exact review fingerprint without widening endpoints", () => {
  assert.deepEqual(OriginalLeadPreviewInputSchema.parse(previewInput), previewInput);
  const input = { ...previewInput, previewFingerprint: digest, reviewed: true };
  assert.deepEqual(OriginalLeadImportInputSchema.parse(input), input);
  for (const changes of [{ url }, { originalSourceId: "other-source" }, { reviewed: false }, { reviewed: undefined }, { previewFingerprint: undefined }, { previewFingerprint: "a".repeat(63) }]) {
    assert.equal(OriginalLeadImportInputSchema.safeParse({ ...input, ...changes }).success, false, JSON.stringify(changes));
  }
  assert.equal(OriginalLeadPreviewInputSchema.safeParse({ ...previewInput, reviewed: true }).success, false);
  assert.equal(OriginalLeadPreviewInputSchema.safeParse({ ...previewInput, expectedRevision: -1 }).success, false);
  assert.equal(OriginalLeadImportInputSchema.safeParse({ ...input, capture: { ...capture, record: lead.record } }).success, false);
});

test("preview output exposes canonical source objects without promoting city disclosures to office points", () => {
  const checked = OriginalLeadPreviewSchema.parse(preview);
  assert.deepEqual(checked, preview); assert.equal(checked.locations[0]!.coordinates, undefined);
  assert.equal(checked.canonicalJobId, job.id);
  assert.equal(OriginalLeadPreviewSchema.parse({ ...preview, canonicalJobId: "existing-merged-owner" }).canonicalJobId, "existing-merged-owner");
  assert.equal(checked.listings[0]!.discoverySourceIds![0], source.sourceId);
  for (const changes of [{ jobs: [job] }, { job: [job] }, { canonicalJobId: undefined }, { canonicalJobId: "" }, { previewFingerprint: "wrong" }, { locations: [{ ...location, secret: "forbidden" }] }, { warnings: [""] }]) {
    assert.equal(OriginalLeadPreviewSchema.safeParse({ ...preview, ...changes }).success, false, JSON.stringify(changes));
  }
});
