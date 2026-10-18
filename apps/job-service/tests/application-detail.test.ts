import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  AtlasDataset, CanonicalJob, Company, Compensation, JdSnapshot, JobLocation, SourceDefinition,
  SourceListing, SourceObservation, ToolResult, TrustedToolContext,
} from "@better-me/opportunities";
import type { SourceAdapter, SourceJobRecord } from "@better-me/source-adapters";
import { createJobApplication } from "../src/application.js";
import { createJobHttpServer } from "../src/http.js";
import { openJobRepository, type JobRepository } from "../src/repository.js";

const AT = "2026-10-19T00:00:00.000Z";
const LATER = "2026-10-20T00:00:00.000Z";
const ORIGIN = "http://localhost:5173";
const TOKEN = "synthetic-detail-http-token-1234567890";
const source: SourceDefinition = {
  sourceId: "synthetic-detail-source", name: "Synthetic official careers", adapterId: "synthetic-detail", adapterVersion: "1",
  capabilities: ["list-jobs"], runtime: ["local-service"], entityType: "job-posting", enabled: true, status: "active", remoteFilters: [],
  endpointPolicy: { allowedHosts: ["careers.example.test"], allowedPathPrefixes: ["/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
  attribution: { label: "Synthetic official careers", homepageUrl: "https://careers.example.test/", usage: "metadata", requiresAttribution: true },
  refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 100, maxPages: 1, requestsPerMinute: 20 },
};
type Detail = {
  snapshotRevision: number; job: CanonicalJob; company: Company; locations: JobLocation[]; compensations: Compensation[];
  listings: SourceListing[]; observations: SourceObservation[]; snapshots: JdSnapshot[]; sources: SourceDefinition[];
};
function context(): TrustedToolContext {
  return { requestId: "synthetic-detail-request", actorScope: "local-owner", allowedEffects: ["read-index"],
    signal: new AbortController().signal, budget: { requests: 10, bytes: 4_000_000, timeoutMs: 5000 } };
}
function value<T>(result: ToolResult<unknown>): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error(result.error.code);
  return result.value as T;
}
function record(id = "target", overrides: Partial<SourceJobRecord> = {}): SourceJobRecord {
  return {
    entityType: "job-posting", sourceRecordId: id, url: `https://careers.example.test/jobs/${id}`,
    companyName: "Synthetic detail employer", title: `Synthetic software engineer ${id}`, description: `Synthetic original JD ${id}`,
    locations: [{ raw: "Chicago, Illinois", countryCode: "US", region: "Illinois", city: "Chicago" },
      { raw: "Toronto, Ontario", countryCode: "CA", region: "Ontario", city: "Toronto" }],
    compensations: [
      { raw: "Synthetic base USD 150000–180000", currency: "USD", period: "year", min: 150000, max: 180000, tax: "unknown", kind: "base" },
      { raw: "Synthetic bonus USD 15000–20000", currency: "USD", period: "year", min: 15000, max: 20000, tax: "unknown", kind: "bonus" },
      { raw: "Synthetic equity percentage 0.5%", period: "unknown", tax: "unknown", kind: "equity" },
    ],
    sourcePublishedAt: "2026-10-10T12:00:00.000Z", sourcePublishedRaw: "October 10, 2026",
    workMode: "remote", employmentType: "social", remoteEligibleRegions: ["US", "CA"], availability: "unknown",
    completeness: "detail", evidence: [], warnings: [], ...overrides,
  };
}
async function fixture(target = record()) {
  const directory = await mkdtemp(join(tmpdir(), "better-me-detail-test-"));
  const path = join(directory, "jobs.sqlite");
  let now = AT;
  const repository = openJobRepository(path, { now: () => now });
  const records = [target, record("unrelated", {
    locations: [{ raw: "Sydney, Australia", countryCode: "AU", city: "Sydney" }],
    compensations: [{ raw: "Synthetic unrelated AUD 999999", currency: "AUD", period: "year", min: 999999, tax: "gross", kind: "base" }],
  })];
  let fetches = 0;
  const adapter: SourceAdapter = {
    adapterId: source.adapterId, version: "1", capabilities: ["list-jobs"], remoteFilters: [], entityTypes: ["job-posting"],
    async list(request) {
      fetches++;
      return { records, observedAt: request.context.observedAt, coverage: { complete: true, partial: false, fetchedRecords: records.length, appliedFilters: [], ignoredFilters: [] }, warnings: [] };
    },
  };
  const createApplication = (candidate: JobRepository = repository) => createJobApplication({ repository: candidate, adapters: [adapter], now: () => now });
  const application = createApplication();
  const sync = async (idempotencyKey: string) => value(await application.registry.execute("sources.sync", { sourceId: source.sourceId },
    { ...context(), idempotencyKey, allowedEffects: ["read-index", "local-write", "external-read"] }));
  try {
    await repository.registerSource(source, { actorScope: "local-owner", idempotencyKey: "register-detail-source" });
    await sync("seed-detail-source");
    const snapshot = await repository.readSnapshot();
    const jobId = snapshot.listings.find((listing) => listing.sourceRecordId === "target")!.canonicalJobId!;
    return { repository, application, createApplication, sync, records, jobId, get fetches() { return fetches; },
      setNow(at: string) { now = at; },
      async close() { await application.shutdown(); repository.close(); await rm(directory, { recursive: true, force: true }); } };
  } catch (error) { await application.shutdown(); repository.close(); await rm(directory, { recursive: true, force: true }); throw error; }
}

test("detail tool and authenticated HTTP return the same structured locations, separate pay components and source evidence without writes", async () => {
  const f = await fixture(); let http: ReturnType<typeof createJobHttpServer> | undefined;
  try {
    const before = await f.repository.readSnapshot();
    const runs = await f.repository.listRuns();
    const detail = value<Detail>(await f.application.registry.execute("jobs.read-detail", { jobId: f.jobId }, context()));
    assert.equal(detail.snapshotRevision, before.revision);
    assert.deepEqual(Object.keys(detail).sort(), ["snapshotRevision", "job", "company", "locations", "compensations", "listings", "observations", "snapshots", "sources"].sort());
    assert.deepEqual(detail.locations, before.locations.filter((location) => detail.job.locationIds.includes(location.id)));
    assert.deepEqual(detail.compensations, before.compensations.filter((pay) => detail.job.compensationIds.includes(pay.id)));
    assert.deepEqual(detail.locations.map((location) => location.city).sort(), ["Chicago", "Toronto"]);
    assert.ok(detail.locations.every((location) => location.kind === "remote-region" && !location.coordinates));
    assert.deepEqual(detail.compensations.map((pay) => pay.kind).sort(), ["base", "bonus", "equity"]);
    assert.equal(detail.compensations.find((pay) => pay.kind === "equity")!.min, undefined);
    assert.ok(detail.compensations.every((pay) => pay.tax === "unknown" && pay.verification === "unverified"));
    assert.equal(detail.sources.length, 1); assert.equal(detail.sources[0]!.attribution.label, source.attribution.label);
    assert.equal(detail.listings[0]!.canonicalUrl, "https://careers.example.test/jobs/target");
    assert.equal(detail.observations[0]!.sourcePublishedAt, "2026-10-10T12:00:00.000Z");
    assert.equal(detail.snapshots[0]!.text, "Synthetic original JD target");
    for (const item of [...detail.locations, ...detail.compensations]) for (const evidence of item.evidence) {
      assert.equal(evidence.sourceUrl, detail.listings[0]!.canonicalUrl);
      assert.ok(detail.observations.some((observation) => observation.id === evidence.observationId));
    }
    http = createJobHttpServer({ registry: f.application.registry, token: TOKEN, allowedOrigins: [ORIGIN], port: 0 });
    const { url } = await http.listen();
    const headers = { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN };
    const response = await fetch(`${url}/api/v1/jobs/${f.jobId}`, { headers });
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(value<Detail>(await response.json() as ToolResult), detail);
    assert.equal((await fetch(`${url}/api/v1/jobs/${f.jobId}`, { headers: { Origin: ORIGIN } })).status, 401);
    assert.equal((await fetch(`${url}/api/v1/jobs/${f.jobId}`, { headers: { ...headers, Origin: "https://untrusted.example.test" } })).status, 403);
    assert.deepEqual(await f.repository.readSnapshot(), before);
    assert.deepEqual(await f.repository.listRuns(), runs);
    assert.equal(f.fetches, 1, "detail never reads upstream sources");
  } finally { await http?.close(); await f.close(); }
});

test("detail includes only current job references after a refresh leaves old locations and salaries in SQLite history", async () => {
  const f = await fixture();
  try {
    const first = value<Detail>(await f.application.registry.execute("jobs.read-detail", { jobId: f.jobId }, context()));
    f.setNow(LATER);
    f.records[0] = record("target", {
      locations: [{ raw: "Berlin, Germany", countryCode: "DE", city: "Berlin" }],
      compensations: [{ raw: "Synthetic new EUR 90000", currency: "EUR", period: "year", min: 90000, tax: "gross", kind: "base" }],
      description: "Synthetic refreshed original JD target",
    });
    await f.sync("refresh-detail-source");
    const snapshot = await f.repository.readSnapshot();
    assert.ok(first.locations.every((location) => snapshot.locations.some((row) => row.id === location.id)));
    assert.ok(first.compensations.every((pay) => snapshot.compensations.some((row) => row.id === pay.id)));
    const current = value<Detail>(await f.application.registry.execute("jobs.read-detail", { jobId: f.jobId }, context()));
    assert.equal(current.snapshotRevision, snapshot.revision);
    assert.ok(current.snapshotRevision > first.snapshotRevision);
    assert.deepEqual(current.locations.map((location) => location.city), ["Berlin"]);
    assert.deepEqual(current.compensations.map((pay) => pay.currency), ["EUR"]);
    assert.ok(!current.locations.some((location) => first.job.locationIds.includes(location.id) || location.city === "Sydney"));
    assert.ok(!current.compensations.some((pay) => first.job.compensationIds.includes(pay.id) || pay.currency === "AUD"));
    assert.equal(current.snapshots.length, 2, "immutable JD history remains separate from current structured fields");
    assert.equal(current.observations.length, 2);
  } finally { await f.close(); }
});

test("jobs without disclosed locations or pay return empty arrays instead of borrowing another job's fields", async () => {
  const f = await fixture(record("target", { locations: [], compensations: [], remoteEligibleRegions: [] }));
  try {
    const snapshot = await f.repository.readSnapshot();
    assert.ok(snapshot.locations.length > 0 && snapshot.compensations.length > 0);
    const detail = value<Detail>(await f.application.registry.execute("jobs.read-detail", { jobId: f.jobId }, context()));
    assert.deepEqual(detail.job.locationIds, []); assert.deepEqual(detail.job.compensationIds, []);
    assert.deepEqual(detail.locations, []); assert.deepEqual(detail.compensations, []);
  } finally { await f.close(); }
});

test("detail reads one snapshot and reports that revision even when the repository advances before alias resolution", async () => {
  const f = await fixture();
  let application: ReturnType<typeof createJobApplication> | undefined;
  try {
    const captured = await f.repository.readSnapshot();
    let reads = 0; const resolutions: Array<number | undefined> = [];
    const racing: JobRepository = { ...f.repository,
      async readSnapshot() {
        reads++;
        const snapshot = await f.repository.readSnapshot();
        f.setNow(LATER);
        f.records[0] = record("target", {
          locations: [{ raw: "Singapore", countryCode: "SG", city: "Singapore" }],
          compensations: [{ raw: "Synthetic later SGD 130000", currency: "SGD", period: "year", min: 130000, tax: "gross", kind: "base" }],
        });
        await f.sync("race-detail-source");
        return snapshot;
      },
      async resolveJobId(jobId, options) { resolutions.push(options?.atRevision); return f.repository.resolveJobId(jobId, options); },
    };
    application = f.createApplication(racing);
    const detail = value<Detail>(await application.registry.execute("jobs.read-detail", { jobId: f.jobId }, context()));
    assert.equal(reads, 1); assert.deepEqual(resolutions, [captured.revision]);
    assert.equal(detail.snapshotRevision, captured.revision);
    assert.deepEqual(detail.locations.map((location) => location.city).sort(), ["Chicago", "Toronto"]);
    assert.deepEqual(detail.compensations.map((pay) => pay.kind).sort(), ["base", "bonus", "equity"]);
    const latest = await f.repository.readSnapshot();
    assert.ok(latest.revision > detail.snapshotRevision);
    assert.ok(latest.locations.some((location) => location.city === "Singapore"));
  } finally { await application?.shutdown(); await f.close(); }
});

test("detail rejects unknown IDs, private input fields and missing read permission without fallback or mutation", async () => {
  const f = await fixture(); let http: ReturnType<typeof createJobHttpServer> | undefined;
  try {
    const before = await f.repository.readSnapshot();
    for (const input of [{ jobId: "synthetic-missing-job" }, {}, { jobId: f.jobId, homeAddress: "synthetic-private-value" }]) {
      const result = await f.application.registry.execute("jobs.read-detail", input, context());
      assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "invalid-input");
      assert.ok(!JSON.stringify(result).includes("synthetic-private-value"));
    }
    const denied = await f.application.registry.execute("jobs.read-detail", { jobId: f.jobId }, { ...context(), allowedEffects: ["external-read"] });
    assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.error.code, "not-authorized");
    http = createJobHttpServer({ registry: f.application.registry, token: TOKEN, allowedOrigins: [ORIGIN], port: 0 });
    const { url } = await http.listen();
    const missing = await fetch(`${url}/api/v1/jobs/synthetic-missing-job`, { headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN } });
    assert.equal(missing.status, 400);
    const missingResult = await missing.json() as ToolResult;
    assert.equal(missingResult.ok, false); if (!missingResult.ok) assert.equal(missingResult.error.code, "invalid-input");
    assert.deepEqual(await f.repository.readSnapshot(), before); assert.equal(f.fetches, 1);
  } finally { await http?.close(); await f.close(); }
});

test("detail's strict public output contract rejects private fields injected into locations or compensation", async () => {
  const f = await fixture();
  try {
    const before = await f.repository.readSnapshot();
    for (const table of ["locations", "compensations"] as const) {
      const polluted: JobRepository = { ...f.repository, async readSnapshot() {
        const snapshot = await f.repository.readSnapshot();
        const job = snapshot.jobs.find((job) => job.id === f.jobId)!;
        const id = table === "locations" ? job.locationIds[0] : job.compensationIds[0];
        return { ...snapshot, [table]: snapshot[table].map((row) => row.id === id ? { ...row, apiKey: "synthetic-private-output-sentinel" } : row) } as AtlasDataset;
      } };
      const application = f.createApplication(polluted);
      try {
        const result = await application.registry.execute("jobs.read-detail", { jobId: f.jobId }, context());
        assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "invalid-output");
        assert.ok(!JSON.stringify(result).includes("synthetic-private-output-sentinel"));
      } finally { await application.shutdown(); }
    }
    assert.deepEqual(await f.repository.readSnapshot(), before);
  } finally { await f.close(); }
});
