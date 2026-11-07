import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SourceDefinition, ToolResult, TrustedToolContext } from "@better-me/opportunities";
import type { SourceAdapter, SourceAdapterRequest, SourceJobRecord } from "@better-me/source-adapters";
import { createJobApplication } from "../src/application.js";
import { openJobRepository, RepositoryError, type ImportOptions, type JobRepository } from "../src/repository.js";

const actorScope = "local-owner";
function source(suffix: string): SourceDefinition {
  return { sourceId: `synthetic-concurrent-${suffix}`, name: `Synthetic source ${suffix}`, adapterId: "synthetic-concurrent", adapterVersion: "1", capabilities: ["list-jobs"],
    runtime: ["local-service"], entityType: "job-posting", enabled: true, status: "active", remoteFilters: [],
    endpointPolicy: { allowedHosts: ["careers.example.test"], allowedPathPrefixes: ["/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: `Synthetic source ${suffix}`, usage: "metadata", requiresAttribution: true },
    refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 100, maxPages: 3, requestsPerMinute: 30 } };
}
const sourceA = source("a"), sourceB = source("b");
function record(suffix: string): SourceJobRecord {
  return { entityType: "job-posting", sourceRecordId: "job-1", url: `https://careers.example.test/${suffix}/jobs/1`, companyName: `Synthetic employer ${suffix}`,
    title: "Software engineer", description: `Synthetic responsibilities from ${suffix}.`, locations: [{ raw: "上海", countryCode: "CN", city: "上海" }], compensations: [],
    workMode: "on-site", employmentType: "social", remoteEligibleRegions: [], availability: "unknown", completeness: "detail", evidence: [], warnings: [] };
}
function context(idempotencyKey: string): TrustedToolContext {
  return { requestId: randomUUID(), actorScope, idempotencyKey, allowedEffects: ["read-index", "local-write", "external-read"], signal: new AbortController().signal,
    budget: { requests: 10, bytes: 4_000_000, timeoutMs: 5000 } };
}
function value<T = any>(result: ToolResult<T>): T { assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) throw new Error(result.error.code); return result.value; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function fixture(list: SourceAdapter["list"], beforeImport?: (options: ImportOptions, repository: JobRepository, application: ReturnType<typeof createJobApplication>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "better-me-concurrent-sync-"));
  const repository = openJobRepository(join(directory, "jobs.sqlite"));
  for (const item of [sourceA, sourceB]) await repository.registerSource(item, { actorScope, idempotencyKey: `seed-${item.sourceId}` });
  let imports = 0; const revisions: number[] = [];
  const candidate: JobRepository = { ...repository, importSnapshot: async (input, options) => {
    imports++; revisions.push(options.expectedRevision!);
    await beforeImport?.(options, repository, application);
    return repository.importSnapshot(input, options);
  } };
  const adapter: SourceAdapter = { adapterId: sourceA.adapterId, version: "1", capabilities: ["list-jobs"], remoteFilters: [], entityTypes: ["job-posting"], list };
  const application = createJobApplication({ repository: candidate, adapters: [adapter] });
  return { repository, application, revisions, get imports() { return imports; },
    sync: (sourceId: string, key: string) => application.registry.execute("sources.sync", { sourceId }, context(key)),
    close: async () => { await application.shutdown(); repository.close(); await rm(directory, { recursive: true, force: true }); } };
}
function page(request: SourceAdapterRequest, records = [record(request.source.sourceId)]) {
  return { records, observedAt: request.context.observedAt, coverage: { complete: true, partial: false, fetchedRecords: records.length, appliedFilters: [],
    ignoredFilters: (["roles", "regions", "companyNames"] as const).filter((field) => request.scope[field].length > 0) }, warnings: [] };
}

test("two source fetches overlap and both pages commit against fresh bases without false partial results", { timeout: 6000 }, async () => {
  const entered = deferred<void>(), release = deferred<void>(); let fetching = 0;
  const f = await fixture(async (request) => { if (++fetching === 2) entered.resolve(); await release.promise; return page(request); });
  try {
    const a = f.sync(sourceA.sourceId, "concurrent-a"), b = f.sync(sourceB.sourceId, "concurrent-b");
    await entered.promise; assert.equal(fetching, 2, "network work must not wait for the page mutation queue"); release.resolve();
    for (const result of await Promise.all([a, b])) {
      const synced = value(result); assert.equal(synced.run.status, "completed"); assert.equal(synced.sourceError, undefined);
      assert.equal(synced.run.summary.added, 1); assert.equal(synced.run.summary.records, 1);
    }
    const snapshot = await f.repository.readSnapshot();
    assert.equal(snapshot.jobs.length, 2); assert.equal(snapshot.listings.length, 2); assert.equal(snapshot.observations.length, 2); assert.equal(snapshot.snapshots.length, 2);
    assert.deepEqual(new Set(snapshot.listings.map((listing) => listing.sourceId)), new Set([sourceA.sourceId, sourceB.sourceId]));
    assert.equal(f.imports, 2); assert.ok(f.revisions[1]! > f.revisions[0]!);
  } finally { release.resolve(); await f.close(); }
});

test("an unrelated source registration during import retries the actual revision race without refetching or duplicating observations", async () => {
  let fetched = 0, registered = false;
  const f = await fixture(async (request) => { fetched++; return page(request); }, async (_options, repository, application) => {
    if (registered) return; registered = true;
    const expectedRevision = (await repository.readSnapshot()).revision;
    value(await application.registry.execute("sources.register", { source: source("external"), expectedRevision }, context("external-register")));
  });
  try {
    const result = value(await f.sync(sourceA.sourceId, "race-register"));
    assert.equal(result.run.status, "completed"); assert.equal(result.sourceError, undefined); assert.equal(result.run.summary.added, 1);
    assert.equal(fetched, 1); assert.equal(f.imports, 2); assert.ok(f.revisions[1]! > f.revisions[0]!);
    const snapshot = await f.repository.readSnapshot();
    assert.equal(snapshot.sources.length, 3); assert.equal(snapshot.jobs.length, 1); assert.equal(snapshot.observations.length, 1); assert.equal(snapshot.snapshots.length, 1);
  } finally { await f.close(); }
});

test("source configuration changes, cancellation and same-source replacement never become CAS retries", async () => {
  for (const action of ["edit", "cancel", "supersede"] as const) {
    let changed = false;
    const f = await fixture(async (request) => page(request), async (options, repository, application) => {
      if (changed) return; changed = true;
      if (action === "edit") value(await application.registry.execute("sources.register", { source: { ...sourceA, enabled: false, status: "disabled" }, expectedRevision: (await repository.readSnapshot()).revision }, context("edit-source")));
      else if (action === "cancel") value(await application.registry.execute("runs.cancel", { runId: options.runId }, context("cancel-run")));
      else await repository.startRun({ sourceId: sourceA.sourceId, scope: {}, actorScope, idempotencyKey: "replacement-generation" });
    });
    try {
      const result = value(await f.sync(sourceA.sourceId, `reject-${action}`));
      assert.equal(result.run.status, action === "cancel" ? "cancelled" : "superseded"); assert.equal(f.imports, 1);
      const snapshot = await f.repository.readSnapshot(); assert.equal(snapshot.jobs.length, 0); assert.equal(snapshot.observations.length, 0);
      if (action === "edit") assert.equal(snapshot.sources.find((item) => item.sourceId === sourceA.sourceId)!.enabled, false);
    } finally { await f.close(); }
  }
});

test("continued external writes exhaust a finite retry budget without overwriting them", async () => {
  let writes = 0;
  const f = await fixture(async (request) => page(request), async (_options, repository, application) => {
    const next = ++writes;
    value(await application.registry.execute("sources.register", { source: source(`external-${next}`), expectedRevision: (await repository.readSnapshot()).revision }, context(`external-register-${next}`)));
  });
  try {
    const result = value(await f.sync(sourceA.sourceId, "bounded-races"));
    assert.equal(result.sourceError.code, "stale-version"); assert.equal(f.imports, 3); assert.equal(writes, 3);
    const snapshot = await f.repository.readSnapshot(); assert.equal(snapshot.jobs.length, 0); assert.equal(snapshot.sources.length, 5);
  } finally { await f.close(); }
});

test("a stale failure with no index revision advance is not retried", async () => {
  const f = await fixture(async (request) => page(request), async () => { throw new RepositoryError("stale-version"); });
  try {
    const result = value(await f.sync(sourceA.sourceId, "semantic-stale"));
    assert.equal(result.sourceError.code, "stale-version"); assert.equal(f.imports, 1); assert.equal((await f.repository.readSnapshot()).jobs.length, 0);
  } finally { await f.close(); }
});

test("one failed projection does not poison the next source's page queue", async () => {
  const f = await fixture(async (request) => request.source.sourceId === sourceA.sourceId
    ? page(request, [record("duplicate"), { ...record("duplicate"), title: "Conflicting same-source record" }]) : page(request));
  try {
    const [failed, successful] = await Promise.all([f.sync(sourceA.sourceId, "bad-page"), f.sync(sourceB.sourceId, "good-page")]);
    assert.ok(value(failed).sourceError); assert.equal(value(successful).run.status, "completed");
    const snapshot = await f.repository.readSnapshot(); assert.equal(snapshot.jobs.length, 1); assert.equal(snapshot.listings[0]!.sourceId, sourceB.sourceId);
  } finally { await f.close(); }
});

test("preview and sync share token matching, while an unread keyword stays unknown once even across a CAS retry", async () => {
  const rows: SourceJobRecord[] = [
    { ...record("matched"), sourceRecordId: "matched", description: "Build TypeScript services." },
    { ...record("unknown"), sourceRecordId: "unknown", title: "Platform specialist", description: undefined, completeness: "excerpt" },
    { ...record("excluded"), sourceRecordId: "excluded", title: "Marketing specialist", description: "Create brand campaigns." },
  ];
  let registered = false;
  const f = await fixture(async (request) => page(request, rows), async (_options, repository, application) => {
    if (registered) return; registered = true;
    value(await application.registry.execute("sources.register", { source: source("match-race"), expectedRevision: (await repository.readSnapshot()).revision }, context("match-external-register")));
  });
  try {
    const input = { sourceId: sourceA.sourceId, scope: { roles: ["TypeScript engineer"], regions: [], companyNames: [] } };
    const preview = value(await f.application.registry.execute("sources.preview", input, context("match-preview")));
    assert.equal(preview.localMatchedRecords, 1); assert.equal(preview.page.records.length, 3);
    const result = value(await f.application.registry.execute("sources.sync", input, context("match-sync")));
    assert.equal(result.run.status, "completed"); assert.equal(result.run.summary.needsHuman, 1); assert.equal(result.run.summary.records, 3); assert.equal(f.imports, 2);
    const snapshot = await f.repository.readSnapshot(); assert.equal(snapshot.jobs.length, 1); assert.equal(snapshot.listings[0]!.sourceRecordId, "matched");
    const searched = value(await f.application.registry.execute("jobs.search", { search: { text: "TypeScript engineer", mode: "fuzzy" } }, context("match-search")));
    assert.equal(searched.totalJobs, 1);
  } finally { await f.close(); }
});
