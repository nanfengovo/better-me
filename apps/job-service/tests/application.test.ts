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
  return { records, observedAt: request.context.observedAt, ...(nextCursor ? { nextCursor } : {}), coverage: { complete: !nextCursor, partial: false, fetchedRecords: records.length, appliedFilters: [], ignoredFilters: (["roles", "regions", "companyNames"] as const).filter((key) => request.scope[key].length > 0) }, warnings: [] };
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

test("source scope preview and sync preserve C#, C++ and .NET semantics despite broad upstream matches", async () => {
  const rows = [
    record("csharp", { title: "Ｃ＃开发工程师", description: "开发后台服务" }),
    record("cpp", { title: "熟悉C++17开发", description: "开发服务" }),
    record("dotnet", { title: "ASP.NET8工程师", description: "开发服务" }),
    record("c-product", { title: "C端产品经理", description: "面向消费者的产品" }),
    record("c-only", { title: "C developer", description: "Embedded language" }),
    record("sharp", { title: "Sharp designer", description: "Visual design" }),
    record("csharpener", { title: "CSharpener operator", description: "Operations" }),
    record("cppcheck", { title: "Cppcheck maintainer", description: "Static analyzer" }),
    record("dotne", { title: "Dotne specialist", description: "Near spelling" }),
    record("domain", { title: "Network operator", description: "Operate example.net website" }),
  ];
  const f = await fixture(async (request) => page(request, rows));
  try {
    for (const [keyword, expectedId] of [["C#", "csharp"], ["C++", "cpp"], [".NET", "dotnet"]]) {
      const input = { sourceId: source.sourceId, scope: { ...scope, roles: [keyword!] } };
      const preview = value(await f.application.registry.execute("sources.preview", input, context()));
      assert.equal(preview.page.records.length, rows.length); assert.equal(preview.localMatchedRecords, 1, keyword);
      const synced = value(await f.application.registry.execute("sources.sync", input, context(`symbol-${expectedId}`)));
      assert.equal(synced.run.summary.records, rows.length); assert.equal(synced.run.summary.added, 1);
      const result = value(await f.application.registry.execute("jobs.search", { search: { text: keyword!, mode: "fuzzy" } }, context()));
      assert.equal(result.totalJobs, 1); assert.equal(result.items[0].sources[0].listingId !== undefined, true);
      const snapshot = await f.repository.readSnapshot();
      assert.equal(snapshot.listings.filter((listing) => listing.sourceRecordId === expectedId).length, 1);
    }
    assert.equal((await f.repository.readSnapshot()).jobs.length, 3);
    const ordinary = value(await f.application.registry.execute("sources.preview", { sourceId: source.sourceId, scope: { ...scope, roles: ["产品经理"], regions: ["上海"], companyNames: ["Synthetic"] } }, context()));
    assert.equal(ordinary.localMatchedRecords, 1);
  } finally { await f.close(); }
});

test("main text scope includes an explicit employer name while the company filter remains an additional AND condition", async () => {
  const rows = [record("company-only", { companyName: "UniqueEmployerOnly", title: "Platform engineer", description: "Build distributed systems" }),
    record("description-only", { companyName: "Another employer", title: "Platform engineer", description: "Integrate UniqueEmployerOnly products" }),
    record("unrelated", { companyName: "Unrelated employer", title: "Platform engineer", description: "Build distributed systems" })];
  const f = await fixture(async (request) => page(request, rows));
  try {
    const input = { sourceId: source.sourceId, scope: { ...scope, roles: ["UniqueEmployerOnly"] } };
    const preview = value(await f.application.registry.execute("sources.preview", input, context()));
    assert.equal(preview.localMatchedRecords, 2);
    const restricted = value(await f.application.registry.execute("sources.preview", { ...input, scope: { ...input.scope, companyNames: ["UniqueEmployerOnly"] } }, context()));
    assert.equal(restricted.localMatchedRecords, 1, "a keyword in another company description cannot bypass the separate employer condition");
    const synced = value(await f.application.registry.execute("sources.sync", input, context("company-keyword")));
    assert.equal(synced.run.summary.records, 3); assert.equal(synced.run.summary.added, 2);
    const searched = value(await f.application.registry.execute("jobs.search", { search: { text: "UniqueEmployerOnly", mode: "fuzzy" } }, context()));
    assert.equal(searched.totalJobs, 2);
    assert.deepEqual((await f.repository.readSnapshot()).listings.map((listing) => listing.sourceRecordId).sort(), ["company-only", "description-only"]);
  } finally { await f.close(); }
});

test("country scope codes match structured country evidence exactly while ordinary region text retains literal matching", async () => {
  const rows = [
    record("us", { locations: [{ raw: "Seattle, United States", countryCode: "US", city: "Seattle" }] }),
    record("au", { locations: [{ raw: "Sydney, Australia", countryCode: "AU", city: "Sydney" }] }),
    record("raw-us", { locations: [{ raw: "Seattle, US", city: "Seattle" }] }),
    record("remote-us", { locations: [], remoteEligibleRegions: ["US"] }),
    record("shanghai", { locations: [{ raw: "上海", countryCode: "CN", city: "上海" }] }),
  ];
  const f = await fixture(async (request) => page(request, rows));
  try {
    const input = { sourceId: source.sourceId, scope: { ...scope, regions: ["US"] } };
    const preview = value(await f.application.registry.execute("sources.preview", input, context()));
    assert.equal(preview.localMatchedRecords, 1, "US never matches Australia, unstructured US text or remote eligibility alone");
    const ordinary = value(await f.application.registry.execute("sources.preview", { ...input, scope: { ...scope, regions: ["上海"] } }, context()));
    assert.equal(ordinary.localMatchedRecords, 1);
    const combined = value(await f.application.registry.execute("sources.preview", { ...input, scope: { ...scope, regions: ["US", "上海"] } }, context()));
    assert.equal(combined.localMatchedRecords, 2, "requested regions retain OR semantics");
    const synced = value(await f.application.registry.execute("sources.sync", input, context("country-code")));
    assert.equal(synced.run.summary.records, 5); assert.equal(synced.run.summary.added, 1);
    const local = value(await f.application.registry.execute("jobs.search", { workRegionIds: ["US"] }, context()));
    assert.equal(local.totalJobs, 1);
    assert.deepEqual((await f.repository.readSnapshot()).listings.map((listing) => listing.sourceRecordId), ["us"]);
  } finally { await f.close(); }
});

test("source country constraints and city interests match the same location and persist in preview, sync and run receipts", async () => {
  const rows = [
    record("target", { locations: [{ raw: "US Springfield", countryCode: "US", city: "Springfield" }] }),
    record("other-country", { locations: [{ raw: "AU Springfield", countryCode: "AU", city: "Springfield" }] }),
    record("crossed-offices", { locations: [{ raw: "US Seattle", countryCode: "US", city: "Seattle" }, { raw: "AU Springfield", countryCode: "AU", city: "Springfield" }] }),
    record("raw-country-unknown", { locations: [{ raw: "Springfield, US", city: "Springfield" }] }),
    record("remote", { locations: [], remoteEligibleRegions: ["Springfield"] }),
    record("remote-crossed", { locations: [{ raw: "US Seattle", countryCode: "US", city: "Seattle" }], remoteEligibleRegions: ["Springfield"] }),
  ];
  const f = await fixture(async (request) => page(request, rows));
  try {
    const input = { sourceId: source.sourceId, scope: { ...scope, regions: ["Springfield"], countryCodes: ["US"] } };
    const preview = value(await f.application.registry.execute("sources.preview", input, context()));
    assert.equal(preview.localMatchedRecords, 1);
    assert.deepEqual(preview.localFilters, input.scope);
    assert.deepEqual(preview.page.coverage.appliedFilters, []);
    assert.deepEqual(preview.page.coverage.ignoredFilters, ["regions"]);
    assert.match(preview.page.warnings.join(" "), /Country-code constraints are checked locally/);
    assert.equal((await f.repository.readSnapshot()).jobs.length, 0, "preview is still read-only");
    const eitherCity = value(await f.application.registry.execute("sources.preview", { ...input, scope: { ...input.scope, regions: ["Springfield", "Seattle"] } }, context()));
    assert.equal(eitherCity.localMatchedRecords, 3, "city interests remain OR within a country");
    const countryOnly = value(await f.application.registry.execute("sources.preview", { ...input, scope: { ...input.scope, regions: [] } }, context()));
    assert.equal(countryOnly.localMatchedRecords, 3);
    const legacy = value(await f.application.registry.execute("sources.preview", { ...input, scope: { ...scope, regions: ["Springfield"] } }, context()));
    assert.equal(legacy.localMatchedRecords, 6, "omitting the country constraint retains legacy remote eligibility matching");
    const explicitEmpty = value(await f.application.registry.execute("sources.preview", { ...input, scope: { ...input.scope, countryCodes: [] } }, context()));
    assert.equal(explicitEmpty.localMatchedRecords, legacy.localMatchedRecords);
    const synced = value(await f.application.registry.execute("sources.sync", input, context("country-and-city")));
    assert.equal(synced.run.summary.records, 6); assert.equal(synced.run.summary.added, 1);
    assert.deepEqual(synced.run.scope.countryCodes, ["US"]);
    assert.deepEqual((await f.repository.getRun(synced.run.runId))!.scope.countryCodes, ["US"]);
    assert.deepEqual((await f.repository.readSnapshot()).listings.map((listing) => listing.sourceRecordId), ["target"]);
    await f.restartApplication();
    const replay = value(await f.application.registry.execute("sources.sync", input, context("country-and-city")));
    assert.equal(replay.run.runId, synced.run.runId); assert.deepEqual(replay.run.scope.countryCodes, ["US"]);
    const changedCountry = await f.application.registry.execute("sources.sync", { ...input, scope: { ...input.scope, countryCodes: ["AU"] } }, context("country-and-city"));
    assert.equal(changedCountry.ok, false); if (!changedCountry.ok) assert.equal(changedCountry.error.code, "idempotency-conflict");
    const queried = value(await f.application.registry.execute("jobs.search", { workCountryCodes: ["US"], workRegionText: "Spring" }, context()));
    assert.equal(queried.totalJobs, 1);
    const invalid = await f.application.registry.execute("sources.preview", { ...input, scope: { ...input.scope, countryCodes: ["us"] } }, context());
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

test("company career discovery reuses registered company metadata without fetching jobs, making HTTP requests or changing the index", async () => {
  let lists = 0; let requests = 0;
  const f = await fixture(async (request) => { lists++; return page(request, []); }, { async request() { requests++; throw new Error("Unexpected company discovery request"); } });
  try {
    await f.repository.registerSource({ ...source, options: { companyName: "Unique Registered Company" } }, {
      expectedRevision: (await f.repository.readSnapshot()).revision, actorScope: "local-owner", idempotencyKey: "company-metadata",
    });
    const before = await f.repository.readSnapshot();
    const found = value(await f.application.registry.execute("companies.discover-careers", {
      sourceId: source.sourceId, request: { companyName: "  UNIQUE   Registered Company  " },
    }, context()));
    assert.equal(found.status, "matched-existing");
    assert.equal(found.observedAt, at);
    assert.deepEqual(found.matchedSources, [{ sourceId: source.sourceId, name: source.name, matchedBy: "company-name", enabled: true, status: "active" }]);
    assert.deepEqual(found.candidates, []); assert.deepEqual(found.proposals, []); assert.deepEqual(found.visitedUrls, []);
    assert.equal(lists, 0); assert.equal(requests, 0);
    assert.deepEqual(await f.repository.readSnapshot(), before);
    assert.deepEqual(await f.repository.listRuns(), []);
    assert.deepEqual(value(await f.application.registry.execute("leads.list", {}, context())), []);
  } finally { await f.close(); }
});

test("unknown company discovery requires a website without guessing a domain or writing an empty search into the index", async () => {
  let lists = 0; let requests = 0;
  const f = await fixture(async (request) => { lists++; return page(request, []); }, { async request() { requests++; throw new Error("Unexpected company discovery request"); } });
  try {
    const before = await f.repository.readSnapshot();
    const found = value(await f.application.registry.execute("companies.discover-careers", {
      sourceId: source.sourceId, request: { companyName: "Unknown Company With No Reviewed Website" },
    }, context()));
    assert.equal(found.status, "requires-company-website");
    assert.deepEqual(found.matchedSources, []); assert.deepEqual(found.candidates, []); assert.deepEqual(found.proposals, []); assert.deepEqual(found.visitedUrls, []);
    assert.equal(found.partial, false);
    assert.match(found.warnings.join(" "), /domains are never guessed/);
    assert.equal(lists, 0); assert.equal(requests, 0);
    assert.deepEqual(await f.repository.readSnapshot(), before);
    assert.deepEqual(await f.repository.listRuns(), []);
  } finally { await f.close(); }
});

test("company career discovery enforces tool effects, endpoint policy and discovery capability before registered-source reuse", async () => {
  let requests = 0;
  const f = await fixture(async (request) => page(request, []), { async request() { requests++; throw new Error("Unexpected unauthorized discovery request"); } });
  try {
    const before = await f.repository.readSnapshot();
    const deniedEffect = await f.application.registry.execute("companies.discover-careers", {
      sourceId: source.sourceId, request: { companyName: source.name },
    }, { ...context(), allowedEffects: ["read-index"] });
    assert.equal(deniedEffect.ok, false); if (!deniedEffect.ok) assert.equal(deniedEffect.error.code, "not-authorized");
    const deniedHost = await f.application.registry.execute("companies.discover-careers", {
      sourceId: source.sourceId, request: { companyName: "Unknown Company", companyWebsite: "https://outside-policy.example.test/" },
    }, context());
    assert.equal(deniedHost.ok, false); if (!deniedHost.ok) assert.equal(deniedHost.error.code, "not-authorized");
    assert.deepEqual(await f.repository.readSnapshot(), before);
    for (const [key, policy] of [
      ["no-discovery-capability", { capabilities: ["list-jobs"] }],
      ["disabled-discovery-source", { enabled: false, status: "disabled" }],
    ] as const) {
      await f.repository.registerSource({ ...source, ...policy, capabilities: [...("capabilities" in policy ? policy.capabilities : source.capabilities)] }, {
        expectedRevision: (await f.repository.readSnapshot()).revision, actorScope: "local-owner", idempotencyKey: key,
      });
      const configured = await f.repository.readSnapshot();
      const denied = await f.application.registry.execute("companies.discover-careers", {
        sourceId: source.sourceId, request: { companyName: source.name },
      }, context());
      assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.error.code, "unsupported-capability");
      assert.deepEqual(await f.repository.readSnapshot(), configured);
    }
    assert.equal(requests, 0);
    assert.deepEqual(await f.repository.listRuns(), []);
  } finally { await f.close(); }
});

test("authenticated company career HTTP route returns existing and unknown results while rejecting missing auth and disallowed discovery hosts", async () => {
  let lists = 0; let requests = 0;
  const f = await fixture(async (request) => { lists++; return page(request, []); }, { async request() { requests++; throw new Error("Unexpected company HTTP discovery request"); } });
  let server: ReturnType<typeof createJobHttpServer> | undefined;
  try {
    await f.repository.registerSource({ ...source, options: { companyName: "HTTP Registered Company" } }, {
      expectedRevision: (await f.repository.readSnapshot()).revision, actorScope: "local-owner", idempotencyKey: "http-company-metadata",
    });
    const before = await f.repository.readSnapshot();
    const token = "synthetic-company-http-token-1234567890";
    const origin = "http://localhost:5173";
    server = createJobHttpServer({ registry: f.application.registry, token, allowedOrigins: [origin], port: 0 });
    const address = await server.listen();
    const url = `${address.url}/api/v1/companies/discover-careers`;
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Origin: origin };
    for (const [companyName, status, matches] of [
      ["HTTP Registered Company", "matched-existing", 1],
      ["HTTP Unknown Company", "requires-company-website", 0],
    ] as const) {
      const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({ sourceId: source.sourceId, request: { companyName } }) });
      assert.equal(response.status, 200); assert.equal(response.headers.get("access-control-allow-origin"), origin);
      const found = value(await response.json() as ToolResult);
      assert.equal(found.status, status); assert.equal(found.matchedSources.length, matches);
      assert.deepEqual(found.candidates, []); assert.deepEqual(found.proposals, []); assert.deepEqual(found.visitedUrls, []);
    }
    const noAuth = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: "{}" });
    assert.equal(noAuth.status, 401); assert.deepEqual(await noAuth.json(), { error: "unauthorized" });
    const foreignOrigin = await fetch(url, { method: "POST", headers: { ...headers, Origin: "https://not-the-ui.example.test" }, body: "{}" });
    assert.equal(foreignOrigin.status, 403); assert.deepEqual(await foreignOrigin.json(), { error: "origin-not-allowed" });
    const outsidePolicy = await fetch(url, { method: "POST", headers, body: JSON.stringify({
      sourceId: source.sourceId, request: { companyName: "HTTP Unknown Company", companyWebsite: "https://outside-policy.example.test/" },
    }) });
    assert.equal(outsidePolicy.status, 403);
    const denied = await outsidePolicy.json() as ToolResult;
    assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.error.code, "not-authorized");
    assert.equal(lists, 0); assert.equal(requests, 0);
    assert.deepEqual(await f.repository.readSnapshot(), before);
    assert.deepEqual(await f.repository.listRuns(), []);
  } finally { await server?.close(); await f.close(); }
});
