import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { AtlasDataset, CanonicalJob, Compensation, JdSnapshot, JobLocation, JobQueryResult, SourceDefinition, SourceListing, SourceObservation, ToolResult, TrustedToolContext } from "@better-me/opportunities";
import type { SourceAdapter, SourceJobRecord } from "@better-me/source-adapters";
import { createJobApplication } from "../src/application.js";
import { createJobHttpServer } from "../src/http.js";
import { openJobRepository, type JobRepository } from "../src/repository.js";
import type { SyncRun } from "../src/repository-schema.js";

const AT = "2026-10-18T00:00:00.000Z";
const LATER = "2026-10-19T00:00:00.000Z";
const ACTOR = "local-owner";
const TOKEN = "synthetic-reconciliation-http-token-1234567890";
const ORIGIN = "http://localhost:5173";
const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Origin: ORIGIN };
const writeOptions = (idempotencyKey: string, expectedRevision: number) => ({ actorScope: ACTOR, idempotencyKey, expectedRevision });
function value<T>(result: ToolResult<unknown>): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error(result.error.code);
  return result.value as T;
}
function context(idempotencyKey?: string): TrustedToolContext {
  return { requestId: "synthetic-reconciliation-request", actorScope: ACTOR, allowedEffects: ["read-index", "local-write", "external-read"],
    signal: new AbortController().signal, budget: { requests: 10, bytes: 4_000_000, timeoutMs: 4000 }, ...(idempotencyKey ? { idempotencyKey } : {}) };
}
function source(suffix: string): SourceDefinition {
  return { sourceId: `synthetic-reconcile-app-${suffix}`, name: `Synthetic source ${suffix}`, adapterId: "synthetic-reconcile-app", adapterVersion: "1",
    capabilities: ["list-jobs"], runtime: ["local-service"], entityType: "job-posting", enabled: true, status: "active", remoteFilters: [],
    endpointPolicy: { allowedHosts: ["careers.example.test"], allowedPathPrefixes: ["/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: `Synthetic source ${suffix}`, usage: "metadata", requiresAttribution: true },
    refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 100, maxPages: 2, requestsPerMinute: 30 } };
}
const sourceA = source("a"), sourceB = source("b");
function record(suffix: string, overrides: Partial<SourceJobRecord> = {}): SourceJobRecord {
  return { entityType: "job-posting", sourceRecordId: "job-42", url: `https://careers.example.test/${suffix}/jobs/42`,
    applicationUrl: "https://careers.example.test/jobs/REQ-123456", companyName: "Synthetic shared employer", title: "Synthetic software engineer",
    description: `Synthetic original responsibilities from ${suffix}.`, locations: [{ raw: suffix === "a" ? "上海" : "北京", countryCode: "CN", city: suffix === "a" ? "上海" : "北京" }],
    compensations: [{ raw: "Synthetic annual salary", currency: "CNY", period: "year", min: suffix === "a" ? 200_000 : 300_000, tax: "gross", kind: "base" }],
    workMode: "on-site", employmentType: "social", remoteEligibleRegions: [], availability: "unknown", completeness: "detail", evidence: [], warnings: [], ...overrides };
}
type Detail = { snapshotRevision: number; job: CanonicalJob; locations: JobLocation[]; compensations: Compensation[]; listings: SourceListing[]; observations: SourceObservation[]; snapshots: JdSnapshot[]; sources: SourceDefinition[] };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "better-me-app-reconciliation-test-")); const path = join(directory, "jobs.sqlite");
  let now = AT;
  let repository = openJobRepository(path, { now: () => now });
  for (const item of [sourceA, sourceB]) await repository.registerSource(item, { actorScope: ACTOR, idempotencyKey: `register-${item.sourceId}` });
  const records = new Map([[sourceA.sourceId, record("a")], [sourceB.sourceId, record("b")]]);
  const adapter: SourceAdapter = { adapterId: sourceA.adapterId, version: "1", capabilities: ["list-jobs"], remoteFilters: [], entityTypes: ["job-posting"],
    async list(request) {
      const items = [records.get(request.source.sourceId)!];
      return { records: items, observedAt: request.context.observedAt, coverage: { complete: true, partial: false, fetchedRecords: items.length, appliedFilters: [], ignoredFilters: [] }, warnings: [] };
    } };
  const createApplication = (candidate: JobRepository = repository) => createJobApplication({ repository: candidate, adapters: [adapter], now: () => now });
  let application = createApplication();
  const sync = async (sourceId: string, key: string) => value<{ run: SyncRun }>(await application.registry.execute("sources.sync", { sourceId }, context(key)));
  for (const item of [sourceA, sourceB]) assert.equal((await sync(item.sourceId, `seed-${item.sourceId}`)).run.status, "completed");
  const origins = await repository.readProjectionSnapshot();
  const ids = [sourceA, sourceB].map((item) => origins.listings.find((listing) => listing.sourceId === item.sourceId)!.canonicalJobId!);
  return {
    path, ids, get repository() { return repository; }, get application() { return application; }, records, createApplication, sync,
    setNow(at: string) { now = at; },
    async reopen(asV1 = false) {
      await application.shutdown(); repository.close();
      if (asV1) {
        const legacy = new DatabaseSync(path);
        try { legacy.exec("DROP TRIGGER source_scan_events_no_update; DROP TRIGGER source_scan_events_no_delete; DROP TABLE source_scan_events; DELETE FROM receipts WHERE tool='sources.commit-page'; UPDATE runs SET document=json_remove(document,'$.scanId','$.continuedFromRunId'); UPDATE receipts SET response=json_remove(response,'$.scanId','$.continuedFromRunId') WHERE tool='runs.start'; DROP TRIGGER company_control_decisions_no_update; DROP TRIGGER company_control_decisions_no_delete; DROP TABLE company_control_decisions; DROP TABLE base_companies; DROP TRIGGER fx_snapshots_no_update; DROP TRIGGER fx_snapshots_no_delete; DROP TRIGGER fx_activations_no_update; DROP TRIGGER fx_activations_no_delete; DROP TABLE fx_activations; DROP TABLE fx_snapshots; DROP TRIGGER compensation_decisions_no_update; DROP TRIGGER compensation_decisions_no_delete; DROP TABLE compensation_decisions; DROP TABLE base_compensations; DROP TRIGGER office_decisions_no_update; DROP TRIGGER office_decisions_no_delete; DROP TABLE office_decisions; DROP TRIGGER location_decisions_no_update; DROP TRIGGER location_decisions_no_delete; DROP TABLE location_decisions; DROP TABLE base_locations; DROP TRIGGER merge_decisions_no_update; DROP TRIGGER merge_decisions_no_delete; DROP TRIGGER job_alias_history_no_update; DROP TRIGGER job_alias_history_no_delete; DROP TABLE merge_decisions; DROP TABLE job_aliases; DROP TABLE job_alias_history; DROP TABLE base_jobs; DROP TABLE job_versions; PRAGMA user_version=1;"); }
        finally { legacy.close(); }
      }
      repository = openJobRepository(path, { now: () => now }); application = createApplication();
    },
    async close() { await application.shutdown(); repository.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test("HTTP keeps canonical search/export and old-ID detail while source refresh and later split retain latest origin data", async () => {
  const f = await fixture(); let http: ReturnType<typeof createJobHttpServer> | undefined;
  try {
    const [a, b] = f.ids;
    const merge = await f.repository.mergeJobs({ targetJobId: a!, sourceJobId: b!, reason: "Synthetic manual same-job confirmation", companyIdentityConfirmed: true }, writeOptions("merge", (await f.repository.readSnapshot()).revision));
    // Reopen schema v2 and recreate the application before using existing HTTP routes.
    await f.reopen();
    http = createJobHttpServer({ registry: f.application.registry, token: TOKEN, allowedOrigins: [ORIGIN], port: 0 }); const { url } = await http.listen();
    const get = async <T,>(path: string) => { const response = await fetch(`${url}${path}`, { headers }); assert.equal(response.status, 200); return value<T>(await response.json() as ToolResult<unknown>); };
    const before = await get<Detail>(`/api/v1/jobs/${b}`);
    assert.equal(before.job.id, a); assert.equal(before.listings.length, 2); assert.equal(before.sources.length, 2);
    assert.equal(before.snapshotRevision, merge.revision);
    assert.deepEqual(before.locations.map((location) => location.city).sort(), ["上海", "北京"].sort());
    assert.deepEqual(before.compensations.map((pay) => pay.min).sort(), [200_000, 300_000]);
    f.setNow(LATER);
    const updated = record("b", { title: "Synthetic senior software engineer", description: "Synthetic updated source B responsibilities.",
      locations: [{ raw: "深圳", countryCode: "CN", city: "深圳" }], compensations: [{ raw: "Synthetic gross annual 450000", currency: "CNY", period: "year", min: 450_000, tax: "gross", kind: "base" }] });
    f.records.set(sourceB.sourceId, updated);
    const refresh = await fetch(`${url}/api/v1/sources/${sourceB.sourceId}/sync`, { method: "POST", headers: { ...headers, "Idempotency-Key": "refresh-merged-b" }, body: "{}" });
    assert.equal(refresh.status, 200); assert.equal(value<{ run: SyncRun }>(await refresh.json() as ToolResult<unknown>).run.status, "completed");
    const detail = await get<Detail>(`/api/v1/jobs/${b}`);
    assert.equal(detail.job.id, a); assert.equal(detail.job.title.value, before.job.title.value); assert.equal(detail.observations.length, 3); assert.equal(detail.snapshots.length, 3);
    assert.ok(detail.snapshotRevision > before.snapshotRevision);
    assert.deepEqual(detail.locations.map((location) => location.city).sort(), ["上海", "深圳"].sort());
    assert.deepEqual(detail.compensations.map((pay) => pay.min).sort(), [200_000, 450_000]);
    assert.ok(detail.snapshots.some((snapshot) => snapshot.text === updated.description));
    const exported = await get<AtlasDataset>("/api/v1/dataset/export");
    assert.equal(exported.jobs.length, 1); assert.equal(exported.jobs[0]!.id, a); assert.equal(exported.listings.length, 2);
    const searchResponse = await fetch(`${url}/api/v1/jobs/search`, { method: "POST", headers, body: "{}" });
    assert.equal(searchResponse.status, 200); const search = value<JobQueryResult>(await searchResponse.json() as ToolResult<unknown>);
    assert.equal(search.totalJobs, 1); assert.equal(search.items[0]!.job.id, a);
    await f.repository.revokeMerge({ decisionId: merge.decision.id, reason: "Synthetic independent source split" }, writeOptions("revoke-after-refresh", exported.revision));
    const split = await get<Detail>(`/api/v1/jobs/${b}`);
    assert.equal(split.job.id, b); assert.equal(split.job.title.value, updated.title); assert.equal(split.job.description, updated.description);
    assert.ok(split.snapshotRevision > detail.snapshotRevision);
    assert.deepEqual(split.locations.map((location) => location.city), ["深圳"]);
    assert.deepEqual(split.compensations.map((pay) => pay.min), [450_000]);
    const latest = await f.repository.readSnapshot();
    assert.deepEqual(split.job.locationIds.map((id) => latest.locations.find((location) => location.id === id)!.city), ["深圳"]);
    assert.deepEqual(split.job.compensationIds.map((id) => latest.compensations.find((pay) => pay.id === id)!.min), [450_000]);
    assert.equal((await get<AtlasDataset>("/api/v1/dataset/export")).jobs.length, 2);
    assert.equal((await get<Detail>(`/api/v1/jobs/${a}`)).job.title.value, before.job.title.value);
  } finally { await http?.close(); await f.close(); }
});

test("existing application sync and detail continue after a persisted v1 SQLite file upgrades to v2", async () => {
  const f = await fixture();
  try {
    const before = await f.repository.readSnapshot(); await f.reopen(true);
    assert.deepEqual(await f.repository.readSnapshot(), before);
    const check = new DatabaseSync(f.path);
    try { assert.equal((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 8); } finally { check.close(); }
    for (const jobId of f.ids) assert.equal(value<Detail>(await f.application.registry.execute("jobs.read-detail", { jobId }, context())).job.id, jobId);
    f.setNow(LATER); f.records.set(sourceB.sourceId, record("b", { description: "Synthetic source B refreshed after schema-v1 upgrade." }));
    assert.equal((await f.sync(sourceB.sourceId, "refresh-upgraded-v1")).run.status, "completed");
    const [a, b] = f.ids;
    await f.repository.mergeJobs({ targetJobId: a!, sourceJobId: b!, reason: "Synthetic merge after upgrade", companyIdentityConfirmed: true }, writeOptions("merge-upgraded-v1", (await f.repository.readSnapshot()).revision));
    assert.equal(value<Detail>(await f.application.registry.execute("jobs.read-detail", { jobId: b }, context())).job.id, a);
    assert.equal(value<JobQueryResult>(await f.application.registry.execute("jobs.search", {}, context())).totalJobs, 1);
  } finally { await f.close(); }
});

test("detail binds old-ID resolution to its captured snapshot when a merge or revoke commits between reads", async () => {
  const f = await fixture();
  try {
    const [a, b] = f.ids; let action: (() => Promise<void>) | undefined;
    const racingRepository: JobRepository = { ...f.repository, async readSnapshot() {
      const snapshot = await f.repository.readSnapshot(); const pending = action; action = undefined;
      if (pending) await pending(); return snapshot;
    } };
    const app = f.createApplication(racingRepository);
    try {
      let decisionId = "";
      action = async () => {
        decisionId = (await f.repository.mergeJobs({ targetJobId: a!, sourceJobId: b!, reason: "Synthetic concurrent merge", companyIdentityConfirmed: true }, writeOptions("concurrent-merge", (await f.repository.readSnapshot()).revision))).decision.id;
      };
      // The request captured the unmerged snapshot; it must still return B from that snapshot.
      const unmerged = value<Detail>(await app.registry.execute("jobs.read-detail", { jobId: b }, context()));
      assert.equal(unmerged.job.id, b);
      assert.deepEqual(unmerged.locations.map((location) => location.city), ["北京"]);
      assert.deepEqual(unmerged.compensations.map((pay) => pay.min), [300_000]);
      assert.equal((await f.repository.readSnapshot()).jobs.length, 1);
      action = async () => { await f.repository.revokeMerge({ decisionId, reason: "Synthetic concurrent revoke" }, writeOptions("concurrent-revoke", (await f.repository.readSnapshot()).revision)); };
      // This request captured the merged snapshot; the same old ID resolves to A at that revision.
      const merged = value<Detail>(await app.registry.execute("jobs.read-detail", { jobId: b }, context()));
      assert.equal(merged.job.id, a);
      assert.ok(merged.snapshotRevision > unmerged.snapshotRevision);
      assert.deepEqual(merged.locations.map((location) => location.city).sort(), ["上海", "北京"].sort());
      assert.deepEqual(merged.compensations.map((pay) => pay.min).sort(), [200_000, 300_000]);
      assert.equal((await f.repository.readSnapshot()).jobs.length, 2);
    } finally { await app.shutdown(); }
  } finally { await f.close(); }
});
