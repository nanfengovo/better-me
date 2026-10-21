import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { type SourceDefinition, type TrustedToolContext, type ToolResult } from "@better-me/opportunities";
import { jobPostingJsonLdAdapter, SourceTransportError, SourceScanProgressResultSchema, SourceSyncResultSchema, locallyMatchesSourceScope,
  type SourceAdapter, type SourcePage, type SourceJobRecord, type SourceTransport } from "@better-me/source-adapters";
import { openJobRepository, RepositoryError } from "../src/repository.js";
import { createJobApplication } from "../src/application.js";
import { createJobHttpServer } from "../src/http.js";
import { sourceConfigurationFingerprint } from "../src/source-scan-state.js";
import { projectSourcePage } from "../src/projection.js";

const AT = "2026-10-22T00:00:00.000Z", ORIGIN = "https://careers.synthetic.example", LIST = `${ORIGIN}/reviewed/jobs.xml`;
const SCOPE = { roles: ["C#"], regions: [], companyNames: [] };
const jobUrl = (id: number) => `${ORIGIN}/jobs/${id}`;
const source: SourceDefinition = { sourceId: "synthetic-scan", name: "Synthetic reviewed source", adapterId: "jobposting-jsonld", adapterVersion: "1", capabilities: ["list-jobs"],
  runtime: ["local-service"], entityType: "job-posting", enabled: true, status: "active", remoteFilters: [], entryUrl: LIST,
  options: { enumerationKind: "sitemap-urlset", enumerationUrls: [LIST], postingPathPrefixes: ["/jobs/"], pageSize: 3, priorityPostingUrls: [jobUrl(1), jobUrl(2)] },
  endpointPolicy: { allowedHosts: ["careers.synthetic.example"], allowedPathPrefixes: ["/reviewed", "/jobs"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
  attribution: { label: "Synthetic official jobs", usage: "metadata", requiresAttribution: true }, refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 6, maxPages: 2, requestsPerMinute: 100 } };
function context(key?: string, actorScope = "synthetic-owner"): TrustedToolContext { return { requestId: randomUUID(), actorScope, allowedEffects: ["read-index", "local-write", "external-read"], signal: new AbortController().signal,
  budget: { requests: 100, bytes: 2_000_000, timeoutMs: 5000 }, ...(key ? { idempotencyKey: key } : {}) }; }
function value<T = any>(result: ToolResult<T>): T { assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) throw new Error(result.error.code); return result.value; }
const rejected = (result: ToolResult, code: string) => { assert.equal(result.ok, false, JSON.stringify(result)); if (!result.ok) assert.equal(result.error.code, code); };
const continueInput = (result: any) => ({ sourceId: source.sourceId, fromRunId: result.run.runId, expectedProgressVersion: result.scanProgress.version });
async function fixture(options: { adapter?: SourceAdapter; source?: SourceDefinition; minInterval?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "better-me-source-scan-")), path = join(directory, "jobs.sqlite");
  let time = Date.parse(AT), ids = Array.from({ length: 13 }, (_, index) => index + 1), timeoutId = 0;
  const calls: string[] = [], now = () => new Date(time).toISOString();
  let repository = openJobRepository(path, { now });
  const config = options.source ?? { ...source, refreshPolicy: { ...source.refreshPolicy, minIntervalSeconds: options.minInterval ?? 0 } };
  await repository.registerSource(config, { actorScope: "synthetic-owner", idempotencyKey: "register" });
  const transport: SourceTransport = { request: async ({ url, context: execution }) => {
    execution.throwIfCancelled(); execution.consumeRequests(); calls.push(url);
    if (url === jobUrl(timeoutId)) throw new SourceTransportError("timeout");
    const id = Number(url.split("/").at(-1));
    const text = url === LIST ? `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${ids.map(id => `<url><loc>${jobUrl(id)}</loc></url>`).join("")}</urlset>`
      : `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "JobPosting", url, identifier: { value: String(id) }, hiringOrganization: { name: "Synthetic employer" },
        title: `Synthetic role ${id}`, description: id === 8 || id === 13 ? "Build C# backend services" : "Support unrelated marketing operations", datePosted: "2026-10-20", jobLocation: { address: { addressCountry: "CN", addressLocality: "Shanghai" } } })}</script>`;
    execution.consumeBytes(new TextEncoder().encode(text).length); return { url, text, status: 200, headers: {} };
  } };
  const adapters = [options.adapter ?? jobPostingJsonLdAdapter];
  let application = createJobApplication({ repository, adapters, transport, now });
  return { directory, path, calls, config, now, transport, get repository() { return repository; }, get application() { return application; },
    advance(seconds: number) { time += seconds * 1000; }, setIds(next: number[]) { ids = next; }, timeout(id: number) { timeoutId = id; },
    async restart() { await application.shutdown(); repository.close(); repository = openJobRepository(path, { now }); await repository.recoverInterruptedRuns(); application = createJobApplication({ repository, adapters, transport, now }); },
    async close() { await application.shutdown(); repository.close(); await rm(directory, { recursive: true, force: true }); } };
}
async function sync(f: Awaited<ReturnType<typeof fixture>>, key = "first") { return value(await f.application.registry.execute("sources.sync", { sourceId: source.sourceId, scope: SCOPE }, context(key))); }

test("bounded JSON-LD scanning persists across reopening and reaches matches after the first six candidates", async () => {
  const f = await fixture();
  try {
    const first = await sync(f); SourceSyncResultSchema.parse(first);
    assert.equal(first.run.status, "partial"); assert.equal(first.scanProgress.state, "ready"); assert.equal(first.scanProgress.attemptedRecords, 6);
    assert.equal((await f.repository.readSnapshot()).jobs.length, 0); assert.deepEqual(f.calls.filter(url => url !== LIST), [1, 2, 3, 4, 5, 6].map(jobUrl));
    assert.equal(JSON.stringify(first).includes("cursor"), false);
    const backup = await f.repository.backup(); assert.equal(backup.schemaVersion, 8); assert.equal(backup.sourceScans.length, 3);
    await f.restart(); f.calls.length = 0;
    const second = value(await f.application.registry.execute("sources.continue-sync", continueInput(first), context("second")));
    assert.deepEqual(second.localFilters, SCOPE); assert.deepEqual(f.calls.filter(url => url !== LIST), [7, 8, 9, 10, 11, 12].map(jobUrl));
    assert.equal(second.run.continuedFromRunId, first.run.runId); assert.equal(second.scanProgress.attemptedRecords, 12); assert.equal((await f.repository.readSnapshot()).jobs.length, 1);
    const third = value(await f.application.registry.execute("sources.continue-sync", continueInput(second), context("third")));
    assert.equal(third.scanProgress.state, "exhausted"); assert.equal(third.scanProgress.canContinue, false); assert.equal(third.scanProgress.attemptedRecords, 13);
    const query = value(await f.application.registry.execute("jobs.search", { search: { text: "C#" } }, context())); assert.equal(query.totalJobs, 2);
    const count = f.calls.length;
    const replay = value(await f.application.registry.execute("sources.continue-sync", continueInput(second), context("third")));
    assert.equal(replay.run.runId, third.run.runId); assert.equal(f.calls.length, count);
    const finalBackup = await f.repository.backup();
    const destination = openJobRepository(":memory:", { now: f.now });
    try { await destination.restore(finalBackup, { actorScope: "synthetic-owner", idempotencyKey: "restore", expectedRevision: 0 }); assert.deepEqual((await destination.readScanProgress({ sourceId: source.sourceId, actorScope: "synthetic-owner" })).progress, third.scanProgress); }
    finally { destination.close(); }
  } finally { await f.close(); }
});

test("continuation rejects new scope, raw cursors, another actor, stale versions and duplicate claims before source reads", async () => {
  const f = await fixture();
  try {
    const first = await sync(f), count = f.calls.length, before = await f.repository.backup();
    for (const extra of [{ scope: SCOPE }, { cursor: "forged" }, { maxRecords: 0 }]) rejected(await f.application.registry.execute("sources.continue-sync", { ...continueInput(first), ...extra }, context(randomUUID())), "invalid-input");
    rejected(await f.application.registry.execute("sources.continue-sync", continueInput(first), context("other", "another-owner")), "not-authorized");
    rejected(await f.application.registry.execute("sources.continue-sync", { ...continueInput(first), expectedProgressVersion: 1 }, context("stale")), "stale-version");
    assert.equal(f.calls.length, count); assert.deepEqual(await f.repository.backup(), before);
    const claims = await Promise.all([f.application.registry.execute("sources.continue-sync", continueInput(first), context("claim-a")), f.application.registry.execute("sources.continue-sync", continueInput(first), context("claim-b"))]);
    assert.equal(claims.filter(value => value.ok).length, 1); assert.equal((await f.repository.listRuns()).length, 2);
    rejected(await f.application.registry.execute("sources.sync", { sourceId: source.sourceId, scope: { roles: ["changed"], regions: [], companyNames: [] } }, context("first")), "idempotency-conflict");
  } finally { await f.close(); }
});

test("a fresh sync keeps from-head semantics while source A-B-A edits permanently invalidate old checkpoints", async () => {
  const f = await fixture();
  try {
    const first = await sync(f); f.calls.length = 0;
    const newScan = await sync(f, "from-head"); assert.notEqual(newScan.scanProgress.scanId, first.scanProgress.scanId);
    assert.deepEqual(f.calls.filter(url => url !== LIST), [1, 2, 3, 4, 5, 6].map(jobUrl));
    const old = await f.repository.readScanProgress({ sourceId: source.sourceId, runId: first.run.runId, actorScope: "synthetic-owner" }); assert.equal(old.progress!.state, "invalidated");
    for (const [name, config] of [["b", { ...f.config, name: "Changed source" }], ["a", f.config]] as const) await f.repository.registerSource(config, { actorScope: "synthetic-owner", idempotencyKey: name, expectedRevision: (await f.repository.readSnapshot()).revision });
    const progress = await f.repository.readScanProgress({ sourceId: source.sourceId, actorScope: "synthetic-owner" }); assert.equal(progress.progress!.state, "invalidated");
    const count = f.calls.length; rejected(await f.application.registry.execute("sources.continue-sync", continueInput(newScan), context("invalid")), "stale-version"); assert.equal(f.calls.length, count);
    await f.repository.backup();
  } finally { await f.close(); }
});

test("changed manifest invalidates a cursor instead of applying its offset to new ordering", async () => {
  const f = await fixture();
  try {
    const first = await sync(f); f.setIds([13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]); f.calls.length = 0;
    const changed = value(await f.application.registry.execute("sources.continue-sync", continueInput(first), context("changed-manifest")));
    assert.equal(changed.sourceError.code, "source-changed"); assert.equal(changed.scanProgress.state, "invalidated"); assert.deepEqual(f.calls, [LIST]);
    f.setIds(Array.from({ length: 13 }, (_, index) => index + 1));
    rejected(await f.application.registry.execute("sources.continue-sync", continueInput(changed), context("restored-manifest")), "stale-version"); await f.repository.backup();
  } finally { await f.close(); }
});

test("timeout retains page-start checkpoints for an explicit retry, including the initial page", async () => {
  const f = await fixture();
  try {
    f.timeout(2); const first = await sync(f); assert.equal(first.scanProgress.state, "retry-page"); assert.equal(first.scanProgress.attemptedRecords, 2);
    assert.equal((await f.repository.readScanCheckpoint(first.run.runId, "synthetic-owner")).cursor, undefined);
    assert.deepEqual(f.calls.filter(url => url !== LIST), [1, 2].map(jobUrl));
    f.timeout(0); f.calls.length = 0;
    const second = value(await f.application.registry.execute("sources.continue-sync", continueInput(first), context("retry")));
    assert.deepEqual(f.calls.filter(url => url !== LIST), [1, 2, 3, 4, 5, 6].map(jobUrl)); assert.equal(second.scanProgress.hadErrors, true);
    const cursor = (await f.repository.readScanCheckpoint(second.run.runId, "synthetic-owner")).cursor; assert.ok(cursor);
    f.timeout(8); f.calls.length = 0;
    const third = value(await f.application.registry.execute("sources.continue-sync", continueInput(second), context("retry-later-page")));
    assert.equal(third.scanProgress.state, "retry-page"); assert.equal((await f.repository.readScanCheckpoint(third.run.runId, "synthetic-owner")).cursor, cursor);
    assert.deepEqual(f.calls.filter(url => url !== LIST), [7, 8].map(jobUrl)); await f.repository.backup();
  } finally { await f.close(); }
});

test("partial pages without a continuation cursor stay truncated, never exhausted", async () => {
  const adapter: SourceAdapter = { adapterId: source.adapterId, version: "1", capabilities: ["list-jobs"], remoteFilters: [], entityTypes: ["job-posting"],
    list: async request => ({ records: [], observedAt: request.context.observedAt, coverage: { complete: false, partial: true, fetchedRecords: 0, appliedFilters: [], ignoredFilters: ["roles"] }, stopReason: "record-limit", warnings: [] }) };
  const f = await fixture({ adapter });
  try { const result = await sync(f); assert.equal(result.scanProgress.state, "truncated"); assert.equal(result.scanProgress.canContinue, false); assert.equal(result.run.status, "partial"); await f.repository.backup(); }
  finally { await f.close(); }
});

test("each continuation keeps source interval limits and requested batch allowances", async () => {
  const f = await fixture({ minInterval: 60 });
  try {
    const first = await sync(f), before = await f.repository.backup(), count = f.calls.length;
    rejected(await f.application.registry.execute("sources.continue-sync", continueInput(first), context("too-soon")), "rate-limited"); assert.equal(f.calls.length, count); assert.deepEqual(await f.repository.backup(), before);
    f.advance(60); f.calls.length = 0;
    const second = value(await f.application.registry.execute("sources.continue-sync", { ...continueInput(first), maxRecords: 2, maxPages: 1 }, context("small-batch")));
    assert.deepEqual(f.calls.filter(url => url !== LIST), [7, 8].map(jobUrl)); assert.equal(second.run.summary.records, 2); assert.equal(second.run.scope.maxRecords, 2); assert.equal(second.scanProgress.attemptedRecords, 8);
    const backup = await f.repository.backup(); assert.ok(backup.sourceScans.every(value => value.sourceFingerprint === sourceConfigurationFingerprint(f.config)));
  } finally { await f.close(); }
});

test("authenticated HTTP exposes public progress and continuation with the same inherited scope", async () => {
  const f = await fixture(); const token = "synthetic-source-scan-http-token-123456789";
  const server = createJobHttpServer({ registry: f.application.registry, token, allowedOrigins: ["http://localhost:5173"], port: 0 });
  try {
    const address = await server.listen();
    const post = (path: string, body: unknown, key?: string, auth = true) => fetch(`${address.url}/api/v1/sources/${source.sourceId}/${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { "Idempotency-Key": key } : {}) }, body: JSON.stringify(body) });
    const first = value(await (await post("sync", { scope: SCOPE }, "http-first")).json());
    assert.equal((await post("scan-progress", {}, undefined, false)).status, 401);
    const progressResponse = await post("scan-progress", {}); assert.equal(progressResponse.status, 200); const progress = value(await progressResponse.json()); SourceScanProgressResultSchema.parse(progress); assert.equal(progress.progress.canContinue, true);
    const { sourceId: _sourceId, ...body } = continueInput(first); void _sourceId;
    const next = await post("continue-sync", body, "http-continue"); assert.equal(next.status, 200); const response = value(await next.json()); assert.deepEqual(response.localFilters, SCOPE); assert.equal(response.scanProgress.attemptedRecords, 12);
  } finally { await server.close(); await f.close(); }
});

test("V7 migration preserves prior data and V8 history and page receipts cannot be discarded by restore", async () => {
  const f = await fixture();
  try {
    const old = await f.repository.backup(); old.schemaVersion = 7; old.sourceScans = [];
    const first = await sync(f), before = await f.repository.backup();
    for (const mutate of [
      (backup: typeof before) => { backup.sourceScans.pop(); },
      (backup: typeof before) => { backup.sourceScans.at(-1)!.cursor = "changed"; },
      (backup: typeof before) => { backup.sourceScans[0]!.actorScope = "another-owner"; },
      (backup: typeof before) => { backup.receipts = backup.receipts.filter(value => value.tool !== "sources.commit-page"); },
      (backup: typeof before) => { const receipt = backup.receipts.find(value => value.tool === "sources.commit-page")!; receipt.idempotencyKey = "changed-key"; },
    ]) {
      const changed = structuredClone(before); mutate(changed);
      await assert.rejects(f.repository.restore(changed, { actorScope: "synthetic-owner", idempotencyKey: randomUUID(), expectedRevision: before.dataset.revision }), error => error instanceof RepositoryError && ["invalid-backup", "conflict"].includes(error.code));
      assert.deepEqual(await f.repository.backup(), before);
    }
    await assert.rejects(f.repository.restore(old, { actorScope: "synthetic-owner", idempotencyKey: "old-backup", expectedRevision: before.dataset.revision }), error => error instanceof RepositoryError && error.code === "conflict");
    const destination = openJobRepository(":memory:", { now: f.now });
    try { await destination.restore(old, { actorScope: "synthetic-owner", idempotencyKey: "old-clean", expectedRevision: 0 }); assert.deepEqual((await destination.backup()).sourceScans, []); }
    finally { destination.close(); }
    const inspector = new DatabaseSync(f.path);
    try { assert.equal((inspector.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 8); assert.throws(() => inspector.exec("UPDATE source_scan_events SET document=document"), /immutable-source-scan/); }
    finally { inspector.close(); }
    assert.equal(first.scanProgress.canContinue, true);
  } finally { await f.close(); }
});

test("page import, discovery leads, checkpoint, summary and all receipts roll back together at every cancellation boundary", async () => {
  const f = await fixture();
  try {
    const run = await f.repository.startRun({ sourceId: source.sourceId, scope: { keywords: SCOPE.roles, regions: [], companies: [], maxRecords: 6, maxPages: 2 },
      actorScope: "synthetic-owner", idempotencyKey: "atomic-start", requestFingerprint: createHash("sha256").update("atomic-start").digest("hex"), scan: { scope: SCOPE, sourceFingerprint: sourceConfigurationFingerprint(f.config) } });
    const row: SourceJobRecord = { entityType: "job-posting", sourceRecordId: "atomic", url: `${ORIGIN}/jobs/atomic`, companyName: "Synthetic employer", title: "C# engineer", description: "C# source evidence", locations: [], compensations: [], workMode: "unknown", employmentType: "unknown", remoteEligibleRegions: [], availability: "unknown", completeness: "detail", evidence: [], warnings: [] };
    const page: SourcePage = { records: [row, { ...row, entityType: "discovery-lead", sourceRecordId: "lead", url: `${ORIGIN}/jobs/lead`, completeness: "lead" }], observedAt: AT,
      coverage: { complete: true, partial: false, fetchedRecords: 2, appliedFilters: [], ignoredFilters: ["roles"] }, warnings: [] };
    const projected = await projectSourcePage(await f.repository.readProjectionSnapshot(), f.config, page, run.runId); projected.delta.sources = [];
    const checkpoint = await f.repository.readScanCheckpoint(run.runId, "synthetic-owner"), before = await f.repository.backup();
    const input = { delta: projected.delta, leads: projected.leads, page, expectedProgressVersion: checkpoint.version, summary: { records: 2, pages: 1, partial: false } };
    for (const stopAt of [1, 2, 3, 4]) {
      let checks = 0;
      await assert.rejects(f.repository.commitScanPage(input, { actorScope: "synthetic-owner", idempotencyKey: `atomic-page-${stopAt}`, runId: run.runId, expectedRevision: before.dataset.revision,
        throwIfCancelled: () => { if (++checks === stopAt) throw new Error("synthetic cancellation"); } }));
      assert.equal(checks, stopAt); assert.deepEqual(await f.repository.backup(), before);
    }
    const pageOptions = { actorScope: "synthetic-owner", idempotencyKey: "atomic-page", runId: run.runId, expectedRevision: before.dataset.revision };
    const receipt = await f.repository.commitScanPage(input, pageOptions);
    assert.equal(receipt.leadIds.length, 1); assert.equal((await f.repository.readSnapshot()).jobs.length, 1); assert.equal((await f.repository.listDiscoveryLeads()).length, 1);
    await f.repository.finishRun(run.runId, { actorScope: "synthetic-owner", status: "completed", summary: (await f.repository.getRun(run.runId))!.summary });
    assert.deepEqual(await f.repository.commitScanPage(input, pageOptions), receipt);
    const final = await f.repository.backup(); assert.equal(final.sourceScans.length, 2); assert.equal(final.receipts.filter(value => value.idempotencyKey === "atomic-page").length, 3);
  } finally { await f.close(); }
});

test("V7 SQLite migration creates append-only scan storage without changing existing data or receipts", async () => {
  const f = await fixture();
  try {
    const before = await f.repository.backup(); await f.application.shutdown(); f.repository.close();
    const old = new DatabaseSync(f.path);
    try { old.exec("DROP TRIGGER source_scan_events_no_update; DROP TRIGGER source_scan_events_no_delete; DROP TABLE source_scan_events; PRAGMA user_version=7;"); }
    finally { old.close(); }
    const migrated = openJobRepository(f.path, { now: f.now });
    try { const after = await migrated.backup(); assert.deepEqual(after.dataset, before.dataset); assert.deepEqual(after.runs, before.runs); assert.deepEqual(after.receipts, before.receipts); assert.deepEqual(after.sourceScans, []); }
    finally { migrated.close(); }
  } finally { await f.close(); }
});

test("an interrupted run retains committed counts and its last page cursor while reopening performs no source request", async () => {
  const f = await fixture();
  try {
    const run = await f.repository.startRun({ sourceId: source.sourceId, scope: { keywords: SCOPE.roles, regions: [], companies: [], maxRecords: 6, maxPages: 2 }, actorScope: "synthetic-owner",
      idempotencyKey: "interrupted-start", requestFingerprint: createHash("sha256").update("interrupted-start").digest("hex"), scan: { scope: SCOPE, sourceFingerprint: sourceConfigurationFingerprint(f.config) } });
    const page = await jobPostingJsonLdAdapter.list({ source: f.config, scope: SCOPE, transport: f.transport,
      context: { ...context(), observedAt: AT, consumeRequests: () => {}, consumeBytes: () => {}, throwIfCancelled: () => {} } });
    const projected = await projectSourcePage(await f.repository.readProjectionSnapshot(), f.config, { ...page, records: page.records.filter(value => locallyMatchesSourceScope(value, SCOPE)) }, run.runId); projected.delta.sources = [];
    await f.repository.commitScanPage({ delta: projected.delta, leads: projected.leads, page, expectedProgressVersion: 1, summary: { records: 3, pages: 1, partial: false } },
      { actorScope: "synthetic-owner", idempotencyKey: `${run.runId}.page-0`, expectedRevision: (await f.repository.readSnapshot()).revision, runId: run.runId });
    const checkpoint = await f.repository.readScanCheckpoint(run.runId, "synthetic-owner"), count = f.calls.length;
    await f.restart(); assert.equal(f.calls.length, count);
    const recovered = (await f.repository.getRun(run.runId))!; assert.equal(recovered.status, "failed"); assert.equal(recovered.summary!.records, 3); assert.equal(recovered.summary!.pages, 1); assert.equal(recovered.summary!.errorCode, "service-restarted");
    const progress = (await f.repository.readScanProgress({ sourceId: source.sourceId, actorScope: "synthetic-owner" })).progress!;
    assert.equal(progress.canContinue, true); assert.equal(progress.attemptedRecords, 3); assert.equal((await f.repository.readScanCheckpoint(run.runId, "synthetic-owner")).cursor, checkpoint.cursor);
    f.calls.length = 0;
    const continued = value(await f.application.registry.execute("sources.continue-sync", { sourceId: source.sourceId, fromRunId: run.runId, expectedProgressVersion: progress.version }, context("after-interruption")));
    assert.deepEqual(f.calls.filter(value => value !== LIST), [4, 5, 6, 7, 8, 9].map(jobUrl)); assert.equal(continued.scanProgress.attemptedRecords, 9); await f.repository.backup();
  } finally { await f.close(); }
});
