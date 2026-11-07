import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SourceDefinitionSchema, type MergeReviewPreview, type ReconciliationReceipt, type RevokeMergeReviewPreview } from "@better-me/opportunities";
import {
  jobPostingJsonLdAdapter, type DiscoveryLead, type LeadQueryResult, type LeadReadResult,
  type OriginalLeadCapture, type OriginalLeadPreview, type OriginalLeadImportInput,
} from "@better-me/source-adapters";
import { createJobApplication } from "../src/application.ts";
import { createJobHttpServer } from "../src/http.ts";
import { openJobRepository } from "../src/repository.ts";
import type { ImportReceipt } from "../src/repository-schema.ts";
import { projectSourcePage } from "../src/projection.ts";

const AT = "2026-10-23T00:00:00.000Z";
const READ_AT = "2026-10-23T00:01:00.000Z";
const ORIGINAL_ORIGIN = "https://careers.synthetic-company.com";
const ORIGINAL_URL = `${ORIGINAL_ORIGIN}/jobs/original-987`;
const LIST_URL = `${ORIGINAL_ORIGIN}/reviewed/list.xml`;
const UI_ORIGIN = "http://atlas-ui.invalid";
const TOKEN = "synthetic-lead-http-token-0123456789";
const PATHS = ["leads/query", "leads/read", "leads/original/read", "leads/original/preview", "leads/original/import"];
type HttpResult = { ok?: boolean; value?: unknown; error?: { code: string } };

function originalSource() {
  return SourceDefinitionSchema.parse({
    sourceId: "synthetic-original", name: "Synthetic employer careers", adapterId: "jobposting-jsonld", adapterVersion: "1",
    enabled: true, status: "active", entityType: "job-posting", capabilities: ["list-jobs"], runtime: ["local-service"], remoteFilters: [],
    entryUrl: LIST_URL, options: { enumerationKind: "sitemap-urlset", enumerationUrls: [LIST_URL], postingPathPrefixes: ["/jobs/"], pageSize: 2 },
    endpointPolicy: { allowedHosts: ["careers.synthetic-company.com"], allowedPathPrefixes: ["/reviewed", "/jobs"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: "Original employer careers", usage: "metadata", requiresAttribution: true },
    refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 20, maxPages: 3, requestsPerMinute: 30 },
  });
}
function discoverySource() {
  return SourceDefinitionSchema.parse({ ...originalSource(), sourceId: "synthetic-discovery", name: "Synthetic GitHub discovery", adapterId: "github-json",
    entityType: "company-directory", entryUrl: "https://raw.githubusercontent.com/synthetic/jobs/main/jobs.json", options: {},
    endpointPolicy: { allowedHosts: ["raw.githubusercontent.com"], allowedPathPrefixes: ["/synthetic/jobs/main"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: "Synthetic GitHub discovery", usage: "link-only", requiresAttribution: true },
  });
}
function discoveryLead(): DiscoveryLead {
  return { id: "synthetic-lead-42", sourceId: discoverySource().sourceId, observedAt: AT,
    record: { entityType: "discovery-lead", sourceRecordId: "github-row-42", url: ORIGINAL_URL, title: "C# discovery lead",
      companyName: "Discovery title is not the original employer", description: "Discovery excerpt only.",
      locations: [{ raw: "Shanghai", countryCode: "CN", city: "Shanghai" }], compensations: [], workMode: "unknown", employmentType: "unknown",
      remoteEligibleRegions: [], availability: "unknown", completeness: "lead", evidence: [], warnings: [] } };
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "better-me-lead-http-"));
  const database = join(directory, "synthetic.sqlite");
  let repository = openJobRepository(database, { now: () => READ_AT });
  const source = originalSource(), lead = discoveryLead(), requests: string[] = [];
  let title = "Original C# engineer";
  await repository.registerSource(source, { actorScope: "local-owner", idempotencyKey: "seed-original" });
  await repository.registerSource(discoverySource(), { actorScope: "local-owner", idempotencyKey: "seed-discovery" });
  await repository.saveDiscoveryLeads([lead], { actorScope: "local-owner", idempotencyKey: "seed-lead" });
  const createApplication = () => createJobApplication({ repository, adapters: [jobPostingJsonLdAdapter], now: () => READ_AT, transport: {
    async request(input) {
      requests.push(input.url); assert.equal(input.url, ORIGINAL_URL);
      return { url: input.url, status: 200, headers: {}, text: `<script type="application/ld+json">${JSON.stringify({
        "@type": "JobPosting", url: ORIGINAL_URL, identifier: "original-987", title,
        hiringOrganization: { name: "Original Synthetic Employer" }, description: "<p>Actual source C# responsibilities and requirements.</p>", datePosted: "2026-09-01",
        jobLocation: { address: { addressCountry: "CN", addressLocality: "Shanghai", streetAddress: "Source Road 10", postalCode: "020000" }, geo: { latitude: 31, longitude: 121 } },
      })}</script>` };
    },
  } });
  let app = createApplication();
  let server = createJobHttpServer({ registry: app.registry, token: TOKEN, allowedOrigins: [UI_ORIGIN], port: 0 });
  let url = (await server.listen()).url;
  async function request(path: string, payload: unknown = {}, options: { method?: string; token?: string | null; origin?: string; key?: string; contentType?: string } = {}) {
    const method = options.method ?? "POST";
    const response = await fetch(`${url}/api/v1/${path}`, { method, headers: {
      ...(options.token === null ? {} : { Authorization: `Bearer ${options.token ?? TOKEN}` }), Origin: options.origin ?? UI_ORIGIN,
      "Content-Type": options.contentType ?? "application/json", ...(options.key ? { "Idempotency-Key": options.key } : {}),
    }, ...(["GET", "HEAD"].includes(method) ? {} : { body: JSON.stringify(payload) }) });
    return { status: response.status, headers: response.headers, body: await response.json() as HttpResult };
  }
  async function value<T>(path: string, payload: unknown = {}, key?: string): Promise<T> {
    const response = await request(path, payload, { key });
    assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(response.body.ok, true); return response.body.value as T;
  }
  async function capture() {
    const item = await value<LeadReadResult>("leads/read", { leadId: lead.id });
    return value<OriginalLeadCapture>("leads/original/read", { leadId: lead.id, leadDigest: item.leadDigest, originalSourceId: source.sourceId, expectedRevision: item.snapshotRevision });
  }
  async function preview(captureValue: OriginalLeadCapture) {
    return value<OriginalLeadPreview>("leads/original/preview", { capture: captureValue, expectedRevision: (await repository.readSnapshot()).revision });
  }
  return {
    get repository() { return repository; }, source, lead, requests, request, value, capture, preview,
    setTitle(next: string) { title = next; },
    async reopen() {
      await server.close(); await app.shutdown(); repository.close(); repository = openJobRepository(database, { now: () => READ_AT });
      app = createApplication(); server = createJobHttpServer({ registry: app.registry, token: TOKEN, allowedOrigins: [UI_ORIGIN], port: 0 }); url = (await server.listen()).url;
    },
    async close() {
      await server.close(); await app.shutdown(); repository.close();
      for (const file of readdirSync(directory)) unlinkSync(join(directory, file)); rmdirSync(directory);
    },
  };
}
function command(capture: OriginalLeadCapture, preview: OriginalLeadPreview): OriginalLeadImportInput {
  return { capture, expectedRevision: preview.expectedRevision, previewFingerprint: preview.previewFingerprint, reviewed: true };
}

test("lead HTTP workflow reads an independent original identity, previews without writes, and persists source and discovery evidence", async () => {
  const f = await fixture();
  try {
    const before = await f.repository.readSnapshot();
    const query = await f.value<LeadQueryResult>("leads/query", { search: "C# Shanghai", limit: 1 });
    assert.equal(query.totalLeads, 1); assert.equal(query.items[0]!.lead.id, f.lead.id);
    assert.deepEqual(query.items[0]!.eligibleOriginalSources.map(source => source.sourceId), [f.source.sourceId]); assert.deepEqual(f.requests, []);
    const capture = await f.capture();
    assert.equal(capture.record.sourceRecordId, "original-987"); assert.notEqual(capture.record.sourceRecordId, f.lead.record.sourceRecordId);
    assert.equal(capture.record.companyName, "Original Synthetic Employer"); assert.equal(capture.record.completeness, "detail");
    assert.equal(capture.observedAt, READ_AT); assert.equal(capture.record.sourcePublishedRaw, "2026-09-01"); assert.deepEqual(f.requests, [ORIGINAL_URL]);
    const preview = await f.preview(capture); assert.equal(preview.listings[0]!.sourceId, f.source.sourceId);
    assert.deepEqual(await f.repository.readSnapshot(), before); assert.equal(preview.locations[0]!.streetAddress, "Source Road 10");
    assert.equal(preview.locations[0]!.coordinates, undefined); assert.equal(preview.locations[0]!.officeResolution, undefined);
    const input = command(capture, preview);
    const noKey = await f.request("leads/original/import", input); assert.equal(noKey.status, 400); assert.equal(noKey.body.error?.code, "invalid-context");
    const receipt = await f.value<ImportReceipt>("leads/original/import", input, "synthetic-original-save"); assert.equal(receipt.counts.newJobs, 1);
    assert.deepEqual(await f.value("leads/original/import", input, "synthetic-original-save"), receipt);
    const after = await f.repository.readSnapshot(); assert.equal(after.jobs.length, 1); assert.equal(after.snapshots[0]!.completeness, "detail");
    assert.equal(after.listings[0]!.sourceRecordId, "original-987"); assert.equal(after.listings[0]!.canonicalUrl, ORIGINAL_URL);
    assert.deepEqual(after.listings[0]!.discoverySourceIds, [f.lead.sourceId]);
    const association = after.observations.find(observation => observation.rawText?.includes('"discovery-lead-original"'));
    assert.ok(association?.rawText); const provenance = JSON.parse(association.rawText);
    assert.equal(provenance.leadId, f.lead.id); assert.equal(provenance.leadDigest, capture.leadDigest);
    assert.equal(provenance.discoverySourceId, f.lead.sourceId); assert.equal(provenance.originalSourceId, f.source.sourceId);
    assert.equal(provenance.sourceRecordId, "original-987"); assert.equal(provenance.url, ORIGINAL_URL);
    const retained = await f.value<LeadReadResult>("leads/read", { leadId: f.lead.id }); assert.deepEqual(retained.lead, f.lead);
    assert.deepEqual(retained.resolvedJobs.map(job => job.jobId), receipt.jobIds);
    const results = await f.value<{ totalJobs: number }>("jobs/search", { search: { text: "C# Shanghai", mode: "fuzzy" }, market: "global" }); assert.equal(results.totalJobs, 1);
    assert.deepEqual(f.requests, [ORIGINAL_URL]);
  } finally { await f.close(); }
});

test("five fixed lead routes enforce bearer authentication, exact Origin, methods, content type and strict inputs", async () => {
  const f = await fixture();
  try {
    const before = await f.repository.readSnapshot();
    for (const path of PATHS) {
      assert.equal((await f.request(path, {}, { token: null })).status, 401, path);
      assert.equal((await f.request(path, {}, { token: "wrong-token" })).status, 401, path);
      assert.equal((await f.request(path, {}, { origin: "http://other-ui.invalid" })).status, 403, path);
      assert.equal((await f.request(path, {}, { origin: "null" })).status, 403, path);
      assert.equal((await f.request(path, {}, { method: "GET" })).status, 404, path);
      assert.equal((await f.request(path, {}, { method: "PATCH" })).status, 404, path);
      assert.equal((await f.request(`${path}/extra`)).status, 404, path);
      assert.equal((await f.request(`${path}?endpoint=https://other.invalid`)).status, 400, path);
      assert.equal((await f.request(path, {}, { contentType: "text/plain" })).status, 415, path);
      const injected = await f.request(path, { context: { actorScope: "another-actor", allowedEffects: ["local-write"] }, endpoint: ORIGINAL_URL }, { key: "synthetic-invalid-input" });
      assert.equal(injected.status, 400, path); assert.equal(injected.body.error?.code, "invalid-input", path);
    }
    const query = await f.request("leads/query"); assert.equal(query.status, 200);
    assert.equal(query.headers.get("access-control-allow-origin"), UI_ORIGIN); assert.equal(query.headers.get("cache-control"), "no-store");
    assert.equal((await f.request("leads")).status, 404);
    assert.equal((await f.request("leads", {}, { method: "GET" })).status, 200);
    assert.deepEqual(await f.repository.readSnapshot(), before); assert.deepEqual(f.requests, []);
  } finally { await f.close(); }
});

test("lead original reads reject caller endpoints and changed capture data before network or writes", async () => {
  const f = await fixture();
  try {
    const item = await f.value<LeadReadResult>("leads/read", { leadId: f.lead.id });
    const readInput = { leadId: f.lead.id, leadDigest: item.leadDigest, originalSourceId: f.source.sourceId, expectedRevision: item.snapshotRevision };
    for (const extra of [{ url: "https://other.invalid/job/1" }, { sourceRecordId: "github-row-42" }, { source: f.source }]) {
      const denied = await f.request("leads/original/read", { ...readInput, ...extra }); assert.equal(denied.status, 400); assert.equal(denied.body.error?.code, "invalid-input");
    }
    assert.deepEqual(f.requests, []);
    const capture = await f.capture(), before = await f.repository.readSnapshot();
    for (const changed of [{ ...capture, leadId: "different-lead" }, { ...capture, url: "https://other.invalid/job/1", record: { ...capture.record, url: "https://other.invalid/job/1" } },
      { ...capture, record: { ...capture.record, sourceRecordId: "invented-original-id" } }, { ...capture, record: { ...capture.record, companyName: "Changed employer" } },
      { ...capture, record: { ...capture.record, description: "Changed source text" } }, { ...capture, originalSourceId: f.lead.sourceId }, { ...capture, readSequence: capture.readSequence + 1 }]) {
      const denied = await f.request("leads/original/preview", { capture: changed, expectedRevision: before.revision });
      assert.equal(denied.status, 422, JSON.stringify(denied.body)); assert.equal(denied.body.error?.code, "source-changed");
    }
    const invalidDigest = await f.request("leads/original/read", { ...readInput, leadDigest: "0".repeat(64) }); assert.equal(invalidDigest.status, 422);
    assert.deepEqual(await f.repository.readSnapshot(), before); assert.deepEqual(f.requests, [ORIGINAL_URL]);
  } finally { await f.close(); }
});

test("committed original receipt and provenance survive SQLite reopen, source changes and expired session proof", async () => {
  const f = await fixture();
  try {
    const capture = await f.capture(), preview = await f.preview(capture), input = command(capture, preview);
    const receipt = await f.value<ImportReceipt>("leads/original/import", input, "synthetic-durable-import");
    await f.repository.registerSource({ ...f.source, enabled: false, status: "disabled" }, { actorScope: "local-owner", expectedRevision: receipt.revision, idempotencyKey: "disable-after-adoption" });
    const before = await f.repository.readSnapshot(); await f.reopen();
    assert.deepEqual(await f.value("leads/original/import", input, "synthetic-durable-import"), receipt);
    assert.deepEqual(await f.repository.readSnapshot(), before);
    const retained = await f.value<LeadReadResult>("leads/read", { leadId: f.lead.id }); assert.deepEqual(retained.resolvedJobs.map(job => job.jobId), receipt.jobIds);
    const unavailableProof = await f.request("leads/original/preview", { capture, expectedRevision: before.revision }); assert.equal(unavailableProof.body.error?.code, "source-changed");
    const conflict = await f.request("leads/original/import", { ...input, previewFingerprint: "0".repeat(64) }, { key: "synthetic-durable-import" });
    assert.equal(conflict.status, 409); assert.equal(conflict.body.error?.code, "idempotency-conflict"); assert.deepEqual(f.requests, [ORIGINAL_URL]);
  } finally { await f.close(); }
});

test("a late original capture cannot replace a newer adopted read from the same clock tick", async () => {
  const f = await fixture();
  try {
    const earlier = await f.capture(); f.setTitle("Newer original C# title"); const later = await f.capture();
    assert.equal(earlier.observedAt, later.observedAt); assert.ok(earlier.readSequence < later.readSequence);
    const preview = await f.preview(later); await f.value("leads/original/import", command(later, preview), "synthetic-newer-original");
    const before = await f.repository.readSnapshot();
    const rejected = await f.request("leads/original/preview", { capture: earlier, expectedRevision: before.revision });
    assert.equal(rejected.status, 409); assert.equal(rejected.body.error?.code, "stale-version");
    assert.deepEqual(await f.repository.readSnapshot(), before); assert.equal(before.jobs[0]!.title.value, "Newer original C# title");
    assert.deepEqual(f.requests, [ORIGINAL_URL, ORIGINAL_URL]);
  } finally { await f.close(); }
});

test("original lead previews expose the current canonical owner through merge, refresh and revocation", async () => {
  const f = await fixture();
  try {
    const firstCapture = await f.capture(), firstPreview = await f.preview(firstCapture);
    const first = await f.value<ImportReceipt>("leads/original/import", command(firstCapture, firstPreview), "synthetic-original-before-merge");
    const originalId = first.jobIds[0]!;
    const base = await f.repository.readProjectionSnapshot();
    const keeper = await projectSourcePage(base, f.source, { observedAt: READ_AT, records: [{ ...firstCapture.record,
      sourceRecordId: "target-123", url: `${ORIGINAL_ORIGIN}/jobs/target-123`, title: "Kept canonical title", description: "Other original source text." }],
      warnings: [], coverage: { fetchedRecords: 1, complete: true, partial: false, appliedFilters: [], ignoredFilters: [] },
    }, "synthetic-keeper-seed");
    const seeded = await f.repository.importSnapshot(keeper.delta, { actorScope: "local-owner", expectedRevision: base.revision, idempotencyKey: "synthetic-keeper-seed" });
    const targetId = seeded.jobIds[0]!;
    const mergePreview = await f.value<MergeReviewPreview>("jobs/reconciliation/preview", { targetJobId: targetId, sourceJobId: originalId,
      expectedRevision: seeded.revision, reason: "Synthetic owner checked same requisition", companyIdentityConfirmed: true });
    const merged = await f.value<ReconciliationReceipt>("jobs/reconciliation/merge", { ...mergePreview.input, previewFingerprint: mergePreview.previewFingerprint, reviewed: true }, "synthetic-lead-merge");
    let lead = await f.value<LeadReadResult>("leads/read", { leadId: f.lead.id, expectedRevision: merged.revision }); assert.equal(lead.resolvedJobs[0]!.jobId, targetId);
    f.setTitle("Refreshed original source title"); const refreshed = await f.capture(), preview = await f.preview(refreshed);
    assert.equal(preview.job.id, originalId); assert.equal(preview.canonicalJobId, targetId);
    assert.ok(preview.warnings.some(warning => warning.includes("归并")));
    const saved = await f.value<ImportReceipt>("leads/original/import", command(refreshed, preview), "synthetic-original-after-merge");
    assert.deepEqual(saved.jobIds, [targetId]); assert.equal((await f.repository.readSnapshot()).jobs.length, 1);
    lead = await f.value<LeadReadResult>("leads/read", { leadId: f.lead.id }); assert.deepEqual(lead.resolvedJobs.map(job => job.jobId), [targetId]);
    const revokeInput = { decisionId: merged.decision.id, expectedRevision: saved.revision, reason: "Synthetic distinct requisitions verified" };
    const revoke = await f.value<RevokeMergeReviewPreview>("jobs/reconciliation/preview-revoke", revokeInput);
    await f.value("jobs/reconciliation/revoke", { ...revokeInput, previewFingerprint: revoke.previewFingerprint, reviewed: true }, "synthetic-lead-merge-revoke");
    lead = await f.value<LeadReadResult>("leads/read", { leadId: f.lead.id }); assert.deepEqual(lead.resolvedJobs.map(job => job.jobId), [originalId]);
    const after = await f.repository.readSnapshot(); assert.equal(after.jobs.length, 2); assert.equal(after.jobs.find(job => job.id === originalId)!.title.value, "Refreshed original source title");
  } finally { await f.close(); }
});
