import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { queryJobs, type AtlasDataset } from "@better-me/opportunities";
import { openJobRepository, RepositoryError, type JobRepository } from "../src/repository.ts";
import type { DiscoveryLead } from "../src/repository-schema.ts";

const AT = "2026-10-18T00:00:00.000Z";
const LATER = "2026-10-19T00:00:00.000Z";
const actorScope = "local-ui:synthetic";
const field = <T>(value: T) => ({ value, evidence: [], method: "manual" as const, verification: "unverified" as const, revision: 0 });
function fixture(id = "one"): AtlasDataset {
  const listingId = `listing-${id}`; const observationId = `observation-${id}`; const snapshotId = `snapshot-${id}`;
  const sourceUrl = `https://careers.example.test/jobs/${id}`;
  const text = "合成公开职责 TypeScript C# .NET C++ 后端软件工程师";
  const contentHash = createHash("sha256").update(text).digest("hex");
  return {
    schemaVersion: 1, revision: 0,
    sources: [{ sourceId: "source-one", name: "合成公开来源", adapterId: "synthetic", adapterVersion: "1", capabilities: ["list-jobs"], runtime: ["local-service"], entityType: "job-posting", enabled: true, status: "active", remoteFilters: [], endpointPolicy: { allowedHosts: ["careers.example.test"], allowedPathPrefixes: ["/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 }, attribution: { label: "合成来源", usage: "metadata", requiresAttribution: true }, refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 100, maxPages: 10, requestsPerMinute: 30 } }],
    companies: [{ id: `company-${id}`, names: ["合成公司"], domains: [], parentCompanyIds: [], ultimateControllers: field([]), manualOverrides: [] }],
    jobs: [{ id: `job-${id}`, companyId: `company-${id}`, title: field("后端软件工程师 TypeScript"), description: text, locationIds: [`location-${id}`], compensationIds: [], listingIds: [listingId], selectedSnapshotId: snapshotId, workMode: "on-site", employmentType: "social", remoteEligibleRegions: [], status: "unknown", revision: 0, updatedAt: AT }],
    locations: [{ id: `location-${id}`, raw: "合成地点", countryCode: "CN", city: "合成城市", coordinates: { latitude: 31.2, longitude: 121.5, coordinateSystem: "WGS84" }, precision: "city", kind: "office", evidence: [], verification: "unverified" }], compensations: [],
    listings: [{ id: listingId, sourceId: "source-one", sourceRecordId: id, canonicalUrl: sourceUrl, canonicalJobId: `job-${id}`, observationIds: [observationId], firstDiscoveredAt: AT, recordLastSeenAt: AT }],
    observations: [{ id: observationId, listingId, fetchedAt: AT, contentHash, snapshotId, result: "read", availability: "unknown", completeness: "detail", warnings: [] }],
    snapshots: [{ id: snapshotId, listingId, observationId, text, contentHash, createdAt: AT, sourceUrl, extractionMethod: "source-structured", completeness: "detail" }],
  };
}
function options(key: string, expectedRevision?: number) { return { actorScope, idempotencyKey: key, ...(expectedRevision === undefined ? {} : { expectedRevision }) }; }
async function tempRepo(run: (repo: JobRepository, path: string, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "better-me-repository-test-"));
  const path = join(dir, "jobs.sqlite"); const repo = openJobRepository(path, { now: () => AT });
  try { await run(repo, path, dir); } finally { repo.close(); await rm(dir, { recursive: true, force: true }); }
}
function code(expected: string) { return (error: unknown) => error instanceof RepositoryError && error.code === expected; }
function sourceOnly(): AtlasDataset { const value = fixture(); return { ...value, companies: [], jobs: [], locations: [], listings: [], observations: [], snapshots: [] }; }

test("real SQLite migrations, normalized references, FTS5, RTree and immutable triggers exist", async () => tempRepo(async (repo, path) => {
  const imported = await repo.importSnapshot(fixture(), options("import-1", 0));
  assert.equal(imported.revision, 1);
  assert.deepEqual(imported.counts, { newJobs: 1, updatedJobs: 0, unchangedJobs: 0, newListings: 1, newObservations: 1, newSnapshots: 1 });
  const inspector = new DatabaseSync(path);
  try {
    assert.equal((inspector.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
    assert.equal((inspector.prepare("SELECT COUNT(*) AS n FROM job_listings").get() as { n: number }).n, 1);
    assert.equal((inspector.prepare("SELECT COUNT(*) AS n FROM location_rtree").get() as { n: number }).n, 1);
    assert.equal((inspector.prepare("SELECT COUNT(*) AS n FROM jobs_fts WHERE jobs_fts MATCH 'dotnet OR csharp OR cpp OR 后端'").get() as { n: number }).n, 1);
    assert.throws(() => inspector.prepare("UPDATE observations SET document=document WHERE id=?").run("observation-one"), /immutable-observation/);
    assert.throws(() => inspector.prepare("DELETE FROM snapshots WHERE id=?").run("snapshot-one"), /immutable-snapshot/);
    assert.deepEqual(inspector.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { inspector.close(); }
}));

test("incremental imports do not clear prior jobs and actual query service reads persisted data", async () => tempRepo(async (repo) => {
  await repo.importSnapshot(fixture("one"), options("one"));
  await repo.importSnapshot(fixture("two"), options("two", 1));
  const snapshot = await repo.readSnapshot(); assert.equal(snapshot.jobs.length, 2); assert.equal(snapshot.revision, 2);
  const result = await queryJobs(snapshot, { search: { text: "后端 TypeScript" } }, { now: AT });
  assert.equal(result.totalJobs, 2); assert.equal(result.mapBuckets[0]!.jobCount, 2);
}));

test("durable idempotency survives reopening and actor scopes cannot collide", async () => tempRepo(async (repo, path) => {
  const input = fixture(); const first = await repo.importSnapshot(input, options("stable", 0)); repo.close();
  const reopened = openJobRepository(path);
  try {
    assert.deepEqual(await reopened.importSnapshot(input, options("stable", 0)), first);
    assert.equal((await reopened.readSnapshot()).revision, 1);
    const other = await reopened.importSnapshot(input, { ...options("stable", 1), actorScope: "another:actor" });
    assert.equal(other.revision, 1); assert.equal(other.counts.unchangedJobs, 1);
    const changed = fixture(); changed.jobs[0]!.description = "changed";
    await assert.rejects(reopened.importSnapshot(changed, options("stable", 0)), code("idempotency-conflict"));
  } finally { reopened.close(); }
}));

test("stale revisions, broken refs, unknown private payload keys and immutable conflicts roll back with no receipt", async () => tempRepo(async (repo) => {
  await repo.importSnapshot(fixture(), options("initial"));
  const before = await repo.backup();
  await assert.rejects(repo.importSnapshot(fixture("two"), options("retryable", 0)), code("stale-version"));
  const broken = fixture("two"); broken.jobs[0]!.companyId = "missing";
  await assert.rejects(repo.importSnapshot(broken, options("retryable", 1)), code("invalid-data"));
  const privatePayload = { ...fixture("two"), application: { apiKey: "PRIVATE_SENTINEL" } };
  await assert.rejects(repo.importSnapshot(privatePayload, options("private", 1)), (error: unknown) => { assert.ok(error instanceof RepositoryError); assert.equal(error.message.includes("PRIVATE_SENTINEL"), false); return true; });
  const tampered = fixture(); tampered.snapshots[0]!.text = "different same snapshot id";
  await assert.rejects(repo.importSnapshot(tampered, options("immutable", 1)), code("conflict"));
  assert.deepEqual(await repo.backup(), before);
  const wrongHash = fixture("invalid-hash"); wrongHash.snapshots[0]!.contentHash = "0".repeat(64);
  await assert.rejects(repo.importSnapshot(wrongHash, options("invalid-hash", 1)), code("invalid-data"));
  assert.equal((await repo.importSnapshot(fixture("two"), options("retryable", 1))).revision, 2);
}));

test("deltas reference existing rows, append observations and retain listing history", async () => tempRepo(async (repo) => {
  await repo.importSnapshot(fixture(), options("initial"));
  const delta = fixture(); delta.companies = []; delta.sources = []; delta.locations = []; delta.snapshots = [];
  const oldObservation = delta.observations[0]!;
  delta.observations = [{ ...oldObservation, id: "observation-new", fetchedAt: LATER }];
  delta.listings[0]!.observationIds = ["observation-new"]; delta.listings[0]!.firstDiscoveredAt = LATER; delta.listings[0]!.recordLastSeenAt = LATER;
  delta.jobs[0]!.revision = 1; delta.jobs[0]!.updatedAt = LATER;
  await repo.importSnapshot(delta, options("delta", 1));
  const snapshot = await repo.readSnapshot();
  assert.deepEqual(snapshot.listings[0]!.observationIds, ["observation-one", "observation-new"]);
  assert.equal(snapshot.listings[0]!.firstDiscoveredAt, AT); assert.equal(snapshot.observations.length, 2); assert.equal(snapshot.snapshots.length, 1);
}));

test("source refresh cannot downgrade verified company facts or remove/change manual overrides", async () => tempRepo(async (repo) => {
  const dataset = fixture();
  const evidence = [{ observationId: "observation-one", sourceUrl: "https://careers.example.test/jobs/one", observedAt: AT, quote: "Synthetic controlling company" }];
  dataset.companies[0]!.ultimateControllers = { value: [], evidence, method: "manual", verification: "verified", revision: 1 };
  dataset.companies[0]!.manualOverrides = [{ id: "override-one", field: "names", value: ["人工合成名称"], reason: "合成修订", at: AT, basedOnRevision: 0 }];
  await repo.importSnapshot(dataset, options("first"));
  const sourceUpdate = fixture(); sourceUpdate.companies[0]!.names = ["来源新名称"];
  await repo.importSnapshot(sourceUpdate, options("refresh", 1));
  const company = (await repo.readSnapshot()).companies[0]!;
  assert.equal(company.ultimateControllers.verification, "verified"); assert.equal(company.manualOverrides.length, 1);
  assert.deepEqual(company.names, ["合成公司", "来源新名称"]);
  const conflict = fixture(); conflict.companies[0]!.manualOverrides = [{ ...dataset.companies[0]!.manualOverrides[0]!, reason: "rewritten" }];
  await assert.rejects(repo.importSnapshot(conflict, options("change-override")), code("conflict"));
}));

test("job revisions and entity identity conflicts cannot overwrite newer projections", async () => tempRepo(async (repo) => {
  await repo.importSnapshot(fixture(), options("first"));
  const older = fixture(); older.jobs[0]!.description = "same revision differs";
  await assert.rejects(repo.importSnapshot(older, options("older")), code("conflict"));
  const updated = fixture(); updated.jobs[0]!.revision = 1; updated.jobs[0]!.updatedAt = LATER; updated.jobs[0]!.description = "new projection";
  await repo.importSnapshot(updated, options("new"));
  await assert.rejects(repo.importSnapshot(fixture(), options("old-again")), code("conflict"));
  const changedListing = structuredClone(updated); changedListing.listings[0]!.sourceRecordId = "different-identity";
  await assert.rejects(repo.importSnapshot(changedListing, options("identity")), code("conflict"));
}));

test("durable sync runs enforce actor ownership, cancellation, supersession and late result rejection", async () => tempRepo(async (repo) => {
  await repo.importSnapshot(sourceOnly(), options("source"));
  const run = await repo.startRun({ sourceId: "source-one", scope: { keywords: ["后端"] }, actorScope, idempotencyKey: "run-1" });
  assert.deepEqual(await repo.startRun({ sourceId: "source-one", scope: { keywords: ["后端"] }, actorScope, idempotencyKey: "run-1" }), run);
  await assert.rejects(repo.cancelRun(run.runId, { actorScope: "another:actor" }), code("not-authorized"));
  const next = await repo.startRun({ sourceId: "source-one", scope: {}, actorScope, idempotencyKey: "run-2" });
  assert.equal(next.generation, 2); assert.equal((await repo.getRun(run.runId))!.status, "superseded");
  await assert.rejects(repo.importSnapshot(fixture(), { ...options("late"), runId: run.runId }), code("stale-version"));
  await repo.cancelRun(next.runId, { actorScope });
  await assert.rejects(repo.importSnapshot(fixture(), { ...options("cancelled"), runId: next.runId }), code("cancelled"));
  assert.equal((await repo.readSnapshot()).jobs.length, 0);
  const third = await repo.startRun({ sourceId: "source-one", scope: {}, actorScope, idempotencyKey: "run-3" });
  await repo.importSnapshot(fixture(), { ...options("current"), runId: third.runId });
  await repo.finishRun(third.runId, { actorScope, status: "partial", summary: { added: 1, records: 1, partial: true } });
  await assert.rejects(repo.assertRunCurrent(third.runId), code("stale-version"));
  assert.equal((await repo.listRuns()).length, 3);
}));

test("sync summaries reject private and raw-text fields and run state persists after reopen", async () => tempRepo(async (repo, path) => {
  await repo.importSnapshot(sourceOnly(), options("source"));
  const scoped = { countryCodes: ["CN"], regions: ["北京"] };
  const run = await repo.startRun({ sourceId: "source-one", scope: scoped, actorScope, idempotencyKey: "run" });
  await assert.rejects(repo.finishRun(run.runId, { actorScope, status: "failed", summary: { records: 0, apiKey: "PRIVATE" } as never }), code("invalid-data"));
  repo.close(); const reopened = openJobRepository(path);
  try {
    assert.equal((await reopened.getRun(run.runId))!.status, "running");
    assert.deepEqual((await reopened.getRun(run.runId))!.scope, scoped);
    assert.deepEqual(await reopened.recoverInterruptedRuns(), { recovered: 1 });
    const replay = await reopened.startRun({ sourceId: "source-one", scope: scoped, actorScope, idempotencyKey: "run" });
    assert.equal(replay.status, "failed"); assert.equal(replay.summary?.errorCode, "service-restarted");
    assert.deepEqual(await reopened.recoverInterruptedRuns(), { recovered: 0 });
  }
  finally { reopened.close(); }
}));

test("durable run fingerprints distinguish original caller inputs and survive policy edits, disabled sources and reopening", async () => tempRepo(async (repo, path) => {
  const source = sourceOnly().sources[0]!;
  await repo.registerSource(source, options("fingerprint-source"));
  const fingerprint = (maxRecords: number) => createHash("sha256").update(JSON.stringify({ sourceId: source.sourceId, maxRecords })).digest("hex");
  const input = { sourceId: source.sourceId, scope: { maxRecords: 100, maxPages: 1 }, actorScope, idempotencyKey: "fingerprint-run", requestFingerprint: fingerprint(101) };
  const first = await repo.startRun(input);
  assert.equal(first.requestFingerprint, fingerprint(101));
  assert.deepEqual(await repo.findRunByRequest(input), first);
  await assert.rejects(repo.startRun({ ...input, requestFingerprint: fingerprint(102) }), code("idempotency-conflict"));
  await assert.rejects(repo.findRunByRequest({ ...input, requestFingerprint: fingerprint(102) }), code("idempotency-conflict"));
  assert.equal(await repo.findRunByRequest({ ...input, idempotencyKey: "not-started" }), undefined);
  assert.equal(await repo.findRunByRequest({ ...input, actorScope: "another:actor" }), undefined);
  const finished = await repo.finishRun(first.runId, { actorScope, status: "completed", summary: { records: 1, pages: 1 } });
  await repo.registerSource({ ...source, enabled: false, status: "disabled", refreshPolicy: { ...source.refreshPolicy, maxRecords: 50 } }, options("disable-after-run", 1));
  repo.close();
  const reopened = openJobRepository(path);
  try {
    assert.deepEqual(await reopened.findRunByRequest(input), finished);
    assert.deepEqual(await reopened.startRun({ ...input, scope: { maxRecords: 50, maxPages: 1 } }), finished);
    await assert.rejects(reopened.startRun({ ...input, requestFingerprint: fingerprint(102), scope: { maxRecords: 50, maxPages: 1 } }), code("idempotency-conflict"));
    assert.equal((await reopened.listRuns()).length, 1);
  } finally { reopened.close(); }
}));

test("fingerprint lookup returns current supersession and rejects malformed or unverifiable legacy fingerprints", async () => tempRepo(async (repo) => {
  await repo.registerSource(sourceOnly().sources[0]!, options("fingerprint-source"));
  const input = { sourceId: "source-one", scope: {}, actorScope, idempotencyKey: "fingerprint-first", requestFingerprint: "a".repeat(64) };
  const first = await repo.startRun(input);
  const next = await repo.startRun({ ...input, idempotencyKey: "fingerprint-next" });
  assert.equal((await repo.findRunByRequest(input))!.status, "superseded");
  await repo.cancelRun(next.runId, { actorScope });
  assert.equal((await repo.findRunByRequest({ ...input, idempotencyKey: "fingerprint-next" }))!.status, "cancelled");
  assert.equal((await repo.getRun(first.runId))!.status, "superseded");
  for (const malformed of ["", "a".repeat(63), "a".repeat(65), "A".repeat(64), "z".repeat(64), null, 42]) {
    await assert.rejects(repo.startRun({ ...input, idempotencyKey: "invalid-fingerprint", requestFingerprint: malformed as never }), code("invalid-data"));
    await assert.rejects(repo.findRunByRequest({ ...input, requestFingerprint: malformed as never }), code("invalid-data"));
  }
  const legacy = { sourceId: "source-one", scope: {}, actorScope, idempotencyKey: "legacy-run" };
  const legacyRun = await repo.startRun(legacy);
  assert.deepEqual(await repo.startRun(legacy), legacyRun);
  await assert.rejects(repo.findRunByRequest({ ...legacy, requestFingerprint: input.requestFingerprint }), code("idempotency-conflict"));
}));

test("run delta cannot modify another source by omitting listings, or inject manual overrides", async () => tempRepo(async (repo) => {
  const initial = fixture();
  initial.sources.push({ ...structuredClone(initial.sources[0]!), sourceId: "source-two" });
  await repo.importSnapshot(initial, options("first"));
  const run = await repo.startRun({ sourceId: "source-two", scope: {}, actorScope, idempotencyKey: "wrong-source" });
  const delta = sourceOnly(); delta.sources = []; delta.jobs = [{ ...initial.jobs[0]!, revision: 1, updatedAt: LATER, description: "write from wrong source without supplying listings" }];
  await assert.rejects(repo.importSnapshot(delta, { ...options("wrong-source-write"), runId: run.runId }), code("conflict"));
  const selfRun = await repo.startRun({ sourceId: "source-one", scope: {}, actorScope, idempotencyKey: "right-source" });
  const malicious = fixture(); malicious.companies[0]!.manualOverrides.push({ id: "injected", field: "names", value: ["injected"], reason: "source cannot claim manual authority", at: AT, basedOnRevision: 0 });
  await assert.rejects(repo.importSnapshot(malicious, { ...options("manual-injection"), runId: selfRun.runId }), code("conflict"));
  assert.equal((await repo.readSnapshot()).companies[0]!.manualOverrides.length, 0);
}));

test("explicit source edits require revision, persist idempotently and invalidate old configured runs", async () => tempRepo(async (repo) => {
  const source = fixture().sources[0]!;
  await repo.registerSource(source, options("register"));
  const run = await repo.startRun({ sourceId: source.sourceId, scope: {}, actorScope, idempotencyKey: "run-old-config" });
  const changed = { ...source, enabled: false, status: "disabled" as const };
  await assert.rejects(repo.registerSource(changed, options("needs-revision")), code("stale-version"));
  await assert.rejects(repo.importSnapshot({ ...sourceOnly(), sources: [changed] }, options("untrusted-config-import", 1)), code("conflict"));
  const receipt = await repo.registerSource(changed, options("edit-source", 1));
  assert.equal(receipt.revision, 2);
  assert.deepEqual(await repo.registerSource(changed, options("edit-source", 1)), receipt);
  assert.equal((await repo.getRun(run.runId))!.status, "superseded");
  await assert.rejects(repo.importSnapshot(fixture(), { ...options("late-old-config"), runId: run.runId }), code("stale-version"));
  assert.equal((await repo.readSnapshot()).sources[0]!.enabled, false);
}));

test("source minimum refresh interval is atomic and rejected starts do not supersede a running task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "better-me-rate-repository-test-")); let currentTime = AT;
  const repo = openJobRepository(join(dir, "jobs.sqlite"), { now: () => currentTime });
  try {
    const source = fixture().sources[0]!; source.refreshPolicy.minIntervalSeconds = 60;
    await repo.registerSource(source, options("source"));
    const start = { sourceId: source.sourceId, scope: {}, actorScope, idempotencyKey: "run-first" };
    const first = await repo.startRun(start);
    await assert.rejects(repo.startRun({ ...start, idempotencyKey: "run-too-soon" }), code("rate-limited"));
    assert.equal((await repo.getRun(first.runId))!.status, "running"); assert.equal((await repo.listRuns()).length, 1);
    assert.deepEqual(await repo.startRun(start), first);
    currentTime = "2026-10-18T00:01:00.000Z";
    const next = await repo.startRun({ ...start, idempotencyKey: "run-too-soon" });
    assert.equal(next.generation, 2); assert.equal((await repo.getRun(first.runId))!.status, "superseded");
  } finally { repo.close(); await rm(dir, { recursive: true, force: true }); }
});

test("binary ID ordering across SQLite and merge does not invent a new revision on identical imports", async () => tempRepo(async (repo) => {
  for (const id of ["z", "A", "a", "_", "-"]) {
    // Entity IDs remain valid because the fixture prefix starts with a letter.
    await repo.importSnapshot(fixture(id), options(`import-${id}`));
  }
  const snapshot = await repo.readSnapshot();
  const repeated = await repo.importSnapshot(snapshot, options("all-again", snapshot.revision));
  assert.equal(repeated.revision, snapshot.revision); assert.equal(repeated.counts.unchangedJobs, 5);
}));

test("FTS and RTree candidate diagnostics retain a safe superset for fuzzy/CJK and unknown modes", async () => tempRepo(async (repo) => {
  await repo.importSnapshot(fixture(), options("first"));
  for (const search of ["TypeScript", "后端", "C#", ".NET", "Typscript", "不存在词"]) {
    const candidates = await repo.candidateIds({ search, mode: "fuzzy", viewport: [121, 31, 122, 32] });
    assert.deepEqual(candidates.jobIds, ["job-one"]); assert.equal(candidates.exact, false);
    if (["TypeScript", "后端", "C#", ".NET"].includes(search)) assert.deepEqual(candidates.indexedHits, ["job-one"]);
  }
  assert.deepEqual((await repo.candidateIds({ viewport: [-10, -10, 10, 10] })).indexedHits, []);
  assert.deepEqual((await repo.candidateIds({ viewport: [-10, -10, 10, 10] })).jobIds, ["job-one"]);
}));

function lead(id = "lead-one"): DiscoveryLead {
  return { id, sourceId: "source-one", observedAt: AT, record: { entityType: "recruitment-campaign", sourceRecordId: id, url: "https://careers.example.test/campaign", title: "合成校招批次", companyName: "合成公司", locations: [], compensations: [], workMode: "unknown", employmentType: "campus", remoteEligibleRegions: [], availability: "unknown", completeness: "lead", evidence: [], warnings: [] } };
}
test("discovery leads remain outside canonical counts and reject late runs, private data and wrong entities", async () => tempRepo(async (repo) => {
  await repo.importSnapshot(sourceOnly(), options("source"));
  const run = await repo.startRun({ sourceId: "source-one", scope: {}, actorScope, idempotencyKey: "run" });
  const first = await repo.saveDiscoveryLeads([lead()], { ...options("lead"), runId: run.runId });
  assert.deepEqual(first.leadIds, ["lead-one"]); assert.equal((await repo.readSnapshot()).jobs.length, 0);
  assert.deepEqual(await repo.saveDiscoveryLeads([lead()], { ...options("lead"), runId: run.runId }), first);
  const wrong = lead("wrong"); wrong.record.entityType = "job-posting";
  await assert.rejects(repo.saveDiscoveryLeads([wrong], options("wrong")), code("invalid-data"));
  await assert.rejects(repo.saveDiscoveryLeads([{ ...lead(), apiKey: "PRIVATE" } as never], options("private")), code("invalid-data"));
  await repo.cancelRun(run.runId, { actorScope });
  await assert.rejects(repo.saveDiscoveryLeads([lead("late")], { ...options("late-lead"), runId: run.runId }), code("cancelled"));
  assert.equal((await repo.listDiscoveryLeads()).length, 1);
}));

test("versioned backup and atomic restore preserve public rows, receipts and leads while cancelling orphaned runs", async () => tempRepo(async (repo) => {
  await repo.importSnapshot(fixture(), options("first"));
  await repo.saveDiscoveryLeads([lead()], options("lead"));
  const running = await repo.startRun({ sourceId: "source-one", scope: {}, actorScope, idempotencyKey: "running" });
  const backup = await repo.backup();
  await repo.importSnapshot(fixture("two"), options("second"));
  assert.equal((await repo.readSnapshot()).jobs.length, 2);
  const result = await repo.restore(backup, options("restore", 3) as { expectedRevision: number; actorScope: string; idempotencyKey: string });
  assert.equal(result.revision, 4); assert.equal((await repo.readSnapshot()).jobs.length, 1);
  assert.equal((await repo.listDiscoveryLeads()).length, 1); assert.equal((await repo.getRun(running.runId))!.status, "cancelled");
  assert.deepEqual(await repo.restore(backup, options("restore", 3) as { expectedRevision: number; actorScope: string; idempotencyKey: string }), result);
  const beforeInvalid = await repo.backup();
  await assert.rejects(repo.restore({ ...backup, schemaVersion: 999 }, options("bad", 4) as never), code("invalid-backup"));
  const broken = structuredClone(backup); broken.dataset.snapshots[0]!.listingId = "missing";
  await assert.rejects(repo.restore(broken, options("bad-refs", 4) as never), code("invalid-backup"));
  assert.deepEqual(await repo.backup(), beforeInvalid);
}));

test("restore conflicts roll back row replacement and append-only triggers stay active", async () => tempRepo(async (repo, path) => {
  await repo.importSnapshot(fixture(), options("first")); const backup = await repo.backup();
  await repo.importSnapshot(fixture("two"), options("second"));
  const before = await repo.backup();
  const malicious = structuredClone(backup); malicious.receipts[0]!.signature = "0".repeat(64);
  await assert.rejects(repo.restore(malicious, options("restore-conflict", 2) as never), code("conflict"));
  assert.deepEqual(await repo.backup(), before);
  const inspector = new DatabaseSync(path);
  try { assert.throws(() => inspector.exec("DELETE FROM snapshots"), /immutable-snapshot/); }
  finally { inspector.close(); }
}));

test("two connections reject stale writers and newer schema databases are left intact", async () => tempRepo(async (repo, path, dir) => {
  const other = openJobRepository(path);
  try {
    await repo.importSnapshot(fixture(), options("first", 0));
    await assert.rejects(other.importSnapshot(fixture("two"), options("stale", 0)), code("stale-version"));
    assert.equal((await other.readSnapshot()).jobs.length, 1);
  } finally { other.close(); }
  const futurePath = join(dir, "future.sqlite"); const future = new DatabaseSync(futurePath);
  future.exec("PRAGMA user_version=999; CREATE TABLE untouched(value TEXT); INSERT INTO untouched VALUES ('keep');"); future.close();
  assert.throws(() => openJobRepository(futurePath), code("unsupported-schema"));
  const inspector = new DatabaseSync(futurePath);
  try { assert.equal((inspector.prepare("SELECT value FROM untouched").get() as { value: string }).value, "keep"); } finally { inspector.close(); }
}));
