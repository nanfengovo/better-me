import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type SourceDefinition, type TrustedToolContext, type ToolResult } from "@better-me/opportunities";
import { SourceTransportError, type SourceAdapter, type SourceAdapterRequest, type SourceJobRecord, type SourcePage, type SourceTransport } from "@better-me/source-adapters";
import { createJobApplication } from "../src/application.js";
import { createJobHttpServer } from "../src/http.js";
import { openJobRepository } from "../src/repository.js";

const at = "2026-10-18T12:00:00.000Z";
const scope = { roles: [], regions: [], companyNames: [] };
const source: SourceDefinition = {
  sourceId: "synthetic-app-source", name: "Synthetic app source", adapterId: "synthetic-app", adapterVersion: "1", capabilities: ["list-jobs", "discover-sources"],
  runtime: ["local-service"], entityType: "job-posting", enabled: true, status: "active", remoteFilters: [],
  endpointPolicy: { allowedHosts: ["careers.example.test", "api.github.com"], allowedPathPrefixes: ["/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
  attribution: { label: "Synthetic company website", usage: "metadata", requiresAttribution: true },
  refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 100, maxPages: 10, requestsPerMinute: 30 },
};
function record(id: string, overrides: Partial<SourceJobRecord> = {}): SourceJobRecord {
  return { entityType: "job-posting", sourceRecordId: id, url: `https://careers.example.test/jobs/${id}`, companyName: "Synthetic employer", title: "TypeScript engineer", description: `Synthetic original JD ${id}`,
    locations: [{ raw: "上海", countryCode: "CN", city: "上海" }], compensations: [], workMode: "on-site", employmentType: "social", remoteEligibleRegions: [], availability: "unknown", completeness: "detail", evidence: [], warnings: [], ...overrides };
}
function page(request: SourceAdapterRequest, records: SourceJobRecord[], nextCursor?: string): SourcePage {
  return { records, observedAt: request.context.observedAt, ...(nextCursor ? { nextCursor } : {}), coverage: { complete: !nextCursor, partial: false, fetchedRecords: records.length, appliedFilters: [], ignoredFilters: (Object.keys(request.scope) as Array<keyof typeof scope>).filter((key) => request.scope[key].length > 0) }, warnings: [] };
}
function context(key?: string, signal = new AbortController().signal): TrustedToolContext {
  return { requestId: randomUUID(), actorScope: "local-owner", allowedEffects: ["read-index", "local-write", "external-read"], signal, budget: { requests: 20, bytes: 4_000_000, timeoutMs: 4000 }, ...(key ? { idempotencyKey: key } : {}) };
}
function value<T = any>(result: ToolResult<T>): T { assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) throw new Error(result.error.code); return result.value; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function fixture(handler: SourceAdapter["list"], transport?: SourceTransport) {
  const directory = await mkdtemp(join(tmpdir(), "better-me-app-test-"));
  const path = join(directory, "test.sqlite");
  const repository = openJobRepository(path, { now: () => at });
  await repository.registerSource(source, { actorScope: "local-owner", idempotencyKey: "seed" });
  const adapter: SourceAdapter = { adapterId: source.adapterId, version: "1", capabilities: ["list-jobs"], remoteFilters: [], entityTypes: ["job-posting", "discovery-lead", "recruitment-campaign"], list: handler };
  let application = createJobApplication({ repository, adapters: [adapter], now: () => at, transport });
  return { directory, path, repository, adapter, get application() { return application; }, async restartApplication() { await application.shutdown(); application = createJobApplication({ repository, adapters: [adapter], now: () => at, transport }); },
    async close() { await application.shutdown(); repository.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("actual sync, HTTP and tools share one query; overlapping pages preserve source chains and distinct same-title jobs", async () => {
  let fetches = 0;
  const f = await fixture(async (request) => { fetches++; return request.cursor ? page(request, [record("a"), record("b")]) : page(request, [record("a")], "next"); });
  let server: ReturnType<typeof createJobHttpServer> | undefined;
  try {
    const synced = value(await f.application.registry.execute("sources.sync", { sourceId: source.sourceId, scope }, context("sync")));
    assert.equal(synced.run.status, "completed"); assert.equal(fetches, 2);
    const snapshot = await f.repository.readSnapshot();
    assert.equal(snapshot.jobs.length, 2); assert.equal(snapshot.observations.length, 2); assert.equal(snapshot.snapshots.length, 2);
    const expected = value(await f.application.registry.execute("jobs.search", {}, context()));
    assert.equal(expected.totalJobs, 2);
    const token = "synthetic-http-integration-token-1234567890";
    server = createJobHttpServer({ registry: f.application.registry, token, allowedOrigins: ["http://localhost:5173"], port: 0 });
    const address = await server.listen();
    const response = await fetch(`${address.url}/api/v1/jobs/search`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(response.status, 200);
    const http = value(await response.json() as ToolResult);
    assert.deepEqual(http, expected);
    const detail = value(await f.application.registry.execute("jobs.read-detail", { jobId: snapshot.jobs[0]!.id }, context()));
    assert.equal(detail.sources[0].attribution.label, source.attribution.label); assert.equal(detail.observations.length, 1);
  } finally { await server?.close(); await f.close(); }
});

test("durable run receipts replay after process objects are recreated and do not fetch again", async () => {
  let calls = 0;
  const f = await fixture(async (request) => { calls++; return page(request, [record("a")]); });
  try {
    const initial = value(await f.application.registry.execute("sources.sync", { sourceId: source.sourceId }, context("durable")));
    await f.application.shutdown();
    // A fresh SQLite connection and fresh application model a process restart.
    f.repository.close();
    const reopened = openJobRepository(f.path, { now: () => at });
    const next = createJobApplication({ repository: reopened, adapters: [f.adapter], now: () => at });
    try {
      const replay = value(await next.registry.execute("sources.sync", { sourceId: source.sourceId }, context("durable")));
      assert.equal(replay.run.runId, initial.run.runId); assert.equal(replay.run.status, "completed"); assert.equal(calls, 1);
      const conflict = await next.registry.execute("sources.sync", { sourceId: source.sourceId, maxRecords: 1 }, context("durable"));
      assert.equal(conflict.ok, false); if (!conflict.ok) assert.equal(conflict.error.code, "idempotency-conflict");
    } finally { await next.shutdown(); reopened.close(); }
  } finally { await f.close(); }
});

test("a later 429 reports partial work, preserves known jobs and never infers closed from absence", async () => {
  let rateLimit = false;
  const f = await fixture(async (request) => {
    if (request.cursor) throw new SourceTransportError("rate-limited", 429, 45);
    return page(request, [record("a")], rateLimit ? "more" : undefined);
  });
  try {
    value(await f.application.registry.execute("sources.sync", { sourceId: source.sourceId }, context("first")));
    rateLimit = true;
    const result = value(await f.application.registry.execute("sources.sync", { sourceId: source.sourceId }, context("second")));
    assert.equal(result.run.status, "partial"); assert.equal(result.sourceError.code, "rate-limited"); assert.equal(result.sourceError.retryAfterSeconds, 45);
    const current = await f.repository.readSnapshot(); assert.equal(current.jobs.length, 1); assert.equal(current.jobs[0]!.status, "unknown"); assert.equal(current.snapshots.length, 1);
  } finally { await f.close(); }
});

test("explicit cancellation and source edits both reject a late page without restoring old source configuration", async () => {
  for (const action of ["cancel", "edit"] as const) {
    const entered = deferred<void>(); const release = deferred<void>();
    const f = await fixture(async (request) => { entered.resolve(); await release.promise; return page(request, [record("late")]); });
    try {
      const syncing = f.application.registry.execute("sources.sync", { sourceId: source.sourceId }, context(`sync-${action}`));
      await entered.promise;
      const run = (await f.repository.listRuns())[0]!;
      if (action === "cancel") value(await f.application.registry.execute("runs.cancel", { runId: run.runId }, context("cancel")));
      else {
        const revision = (await f.repository.readSnapshot()).revision;
        value(await f.application.registry.execute("sources.register", { source: { ...source, enabled: false, status: "disabled", name: "Changed explicitly" }, expectedRevision: revision }, context("edit")));
      }
      release.resolve();
      const result = value(await syncing);
      assert.equal(result.run.status, action === "cancel" ? "cancelled" : "superseded");
      const current = await f.repository.readSnapshot(); assert.equal(current.jobs.length, 0);
      if (action === "edit") { assert.equal(current.sources[0]!.enabled, false); assert.equal(current.sources[0]!.name, "Changed explicitly"); }
    } finally { release.resolve(); await f.close(); }
  }
});

test("unknown employers and campaigns stay leads, and local scope filtering does not claim upstream support", async () => {
  const f = await fixture(async (request) => page(request, [record("good"), record("different", { title: "Marketing manager" }), record("lead", { companyName: undefined }), record("campaign", { entityType: "recruitment-campaign", completeness: "lead" })]));
  try {
    const input = { sourceId: source.sourceId, scope: { ...scope, roles: ["TypeScript"] } };
    const preview = value(await f.application.registry.execute("sources.preview", input, context()));
    assert.deepEqual(preview.page.coverage.ignoredFilters, ["roles"]); assert.equal(preview.localMatchedRecords, 3);
    assert.equal((await f.repository.readSnapshot()).jobs.length, 0);
    const result = value(await f.application.registry.execute("sources.sync", input, context("leads")));
    assert.equal(result.run.summary.leads, 2); assert.equal((await f.repository.readSnapshot()).jobs.length, 1);
    assert.equal(value(await f.application.registry.execute("leads.list", {}, context())).length, 2);
    const invalid = await f.application.registry.execute("sources.sync", { sourceId: source.sourceId, scope: { ...scope, roles: ["!!!"] } }, context("bad-scope"));
    assert.equal(invalid.ok, false); if (!invalid.ok) assert.equal(invalid.error.code, "invalid-input");
  } finally { await f.close(); }
});

test("source refresh interval is checked before superseding a running task", async () => {
  const entered = deferred<void>(); const release = deferred<void>();
  const f = await fixture(async (request) => { entered.resolve(); await release.promise; return page(request, []); });
  try {
    await f.repository.registerSource({ ...source, refreshPolicy: { ...source.refreshPolicy, minIntervalSeconds: 60 } }, { expectedRevision: (await f.repository.readSnapshot()).revision, actorScope: "local-owner", idempotencyKey: "interval" });
    const first = f.application.registry.execute("sources.sync", { sourceId: source.sourceId }, context("running")); await entered.promise;
    const denied = await f.application.registry.execute("sources.sync", { sourceId: source.sourceId }, context("too-soon"));
    assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.error.code, "rate-limited");
    assert.equal((await f.repository.listRuns())[0]!.status, "running");
    release.resolve(); assert.equal(value(await first).run.status, "completed");
  } finally { release.resolve(); await f.close(); }
});

test("shutdown aborts and drains sync work before the caller can close SQLite", async () => {
  const entered = deferred<void>();
  const f = await fixture(async (request) => { entered.resolve(); await new Promise<void>((resolve) => request.context.signal.addEventListener("abort", () => resolve(), { once: true })); request.context.throwIfCancelled(); return page(request, []); });
  try {
    const syncing = f.application.registry.execute("sources.sync", { sourceId: source.sourceId }, context("shutdown")); await entered.promise;
    await f.application.shutdown();
    assert.equal((await f.repository.listRuns())[0]!.status, "cancelled");
    const result = value(await syncing); assert.equal(result.run.status, "cancelled");
    const blocked = await f.application.registry.execute("jobs.export-public", {}, context()); assert.equal(blocked.ok, false);
  } finally { await f.close(); }
});

test("discovery tools use configured transport and remain candidates rather than registered sources or jobs", async () => {
  const f = await fixture(async (request) => page(request, []), { async request(request) { request.context.consumeRequests(); return { url: request.url, status: 200, headers: {}, text: JSON.stringify({ total_count: 1, items: [{ full_name: "synthetic/jobs", default_branch: "main", description: "Synthetic source list" }] }) }; } });
  try {
    const discovered = value(await f.application.registry.execute("sources.discover", { sourceId: source.sourceId, request: { provider: "github-repositories", query: "synthetic jobs" } }, context()));
    assert.equal(discovered.candidates.length, 1); assert.equal(discovered.candidates[0].status, "needs-review");
    assert.equal((await f.repository.readSnapshot()).sources.length, 1); assert.equal((await f.repository.readSnapshot()).jobs.length, 0);
  } finally { await f.close(); }
});
