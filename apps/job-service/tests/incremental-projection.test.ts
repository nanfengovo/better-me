import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { SourcePageSchema } from "@better-me/source-adapters";
import { openJobRepository, RepositoryError } from "../src/repository.ts";
import { projectSourcePage, sourceProjectionSelection } from "../src/projection.ts";
import { syntheticAtlas } from "./synthetic-atlas.ts";

const AT = "2026-10-28T00:00:00.000Z";
const options = (idempotencyKey: string, actorScope = "hot-owner") => ({ actorScope, idempotencyKey });

/** Count materialized SQL rows at the real repository seam, not wall-clock noise. */
function observeReads(t: TestContext) {
  const reads: { sql: string; rows: number }[] = [];
  const original = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    const statement = original.call(this, sql);
    return new Proxy(statement, { get(target, property) {
      if (property === "all") return (...args: Parameters<typeof statement.all>) => {
        const rows = statement.all(...args); reads.push({ sql, rows: rows.length }); return rows;
      };
      if (property === "get") return (...args: Parameters<typeof statement.get>) => {
        const row = statement.get(...args); if (row && "document" in row) reads.push({ sql, rows: 1 }); return row;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  });
  return () => reads.reduce((total, value) => total + value.rows, 0);
}

test("one-job ingestion materializes only its affected projection, not the unrelated library", async t => {
  const repo = openJobRepository(":memory:", { now: () => AT });
  try {
    await repo.importSnapshot(syntheticAtlas(200), options("seed", "seed-owner"));
    const count = observeReads(t), started = performance.now();
    await repo.importSnapshot(syntheticAtlas(1, "new"), options("one"));
    const rows = count(); t.diagnostic(JSON.stringify({ operation: "ingest", materializedRows: rows, elapsedMs: Math.round(performance.now() - started) }));
    t.mock.restoreAll();
    assert.ok(rows < 200, `one new job materialized ${rows} rows from a 200-job library`);
    assert.equal((await repo.readSnapshot()).jobs.length, 201);
  } finally { t.mock.restoreAll(); repo.close(); }
});

test("company enrichment includes source siblings even when different canonical summaries hide their company", async () => {
  const repo = openJobRepository(":memory:", { now: () => AT });
  try {
    const data = syntheticAtlas(4, "shared");
    data.jobs[1]!.companyId = data.jobs[0]!.companyId;
    data.companies.splice(1, 1);
    for (let index = 0; index < 2; index++) {
      const text = `Synthetic engineer\n实际控制人：Synthetic controller ${index}\n`;
      data.jobs[index]!.description = text;
      const hash = createHash("sha256").update(text).digest("hex");
      data.snapshots[index]!.text = text; data.snapshots[index]!.contentHash = hash; data.observations[index]!.contentHash = hash;
    }
    await repo.importSnapshot(data, options("seed", "seed-owner"));
    const delta = syntheticAtlas(0), job = structuredClone(data.jobs[0]!);
    job.revision++; job.title.value = "Synthetic updated engineer"; delta.jobs.push(job);
    await repo.importSnapshot(delta, options("queue-shared"));
    await repo.mergeJobs({ targetJobId: "job-shared-2", sourceJobId: "job-shared-0", reason: "Synthetic reviewed identity", companyIdentityConfirmed: true }, { ...options("merge-a"), expectedRevision: 2 });
    await repo.mergeJobs({ targetJobId: "job-shared-3", sourceJobId: "job-shared-1", reason: "Synthetic reviewed identity", companyIdentityConfirmed: true }, { ...options("merge-b"), expectedRevision: 3 });
    await repo.processEnrichmentBatch({ actorScope: "hot-owner", limit: 1 });
    const after = await repo.readSnapshot();
    assert.deepEqual(after.companies.find(company => company.id === "company-shared-0")!.ultimateControllers.value, [], "conflicting source disclosures must not become a single-company candidate");
  } finally { repo.close(); }
});

test("one background item materializes only its affected projection, not the unrelated library", async t => {
  const repo = openJobRepository(":memory:", { now: () => AT });
  try {
    await repo.importSnapshot(syntheticAtlas(200), options("seed", "seed-owner"));
    await repo.importSnapshot(syntheticAtlas(1, "new"), options("one"));
    const count = observeReads(t), started = performance.now();
    const receipt = await repo.processEnrichmentBatch({ actorScope: "hot-owner", limit: 1 });
    const rows = count(); t.diagnostic(JSON.stringify({ operation: "enrich", materializedRows: rows, elapsedMs: Math.round(performance.now() - started) }));
    t.mock.restoreAll();
    assert.equal(receipt.changedJobs, 1);
    assert.ok(rows < 200, `one background item materialized ${rows} rows from a 201-job library`);
    const data = await repo.readSnapshot();
    assert.equal(data.jobs.length, 201);
    assert.equal(data.locations.find(row => row.id === "location-new-0")!.countryCode, "CN");
  } finally { t.mock.restoreAll(); repo.close(); }
});

test("source-page preparation uses bounded context and exactly matches full projection across address, salary and remote history", async t => {
  const repo = openJobRepository(":memory:", { now: () => AT });
  try {
    await repo.importSnapshot(syntheticAtlas(200), options("seed", "seed-owner"));
    const source = syntheticAtlas(0).sources[0]!;
    for (const [index, street] of ["上海市合成路1号", "上海市合成路2号", "上海市合成路1号", "remote", "sparse"].entries()) {
      const page = SourcePageSchema.parse({ records: [{ entityType: "job-posting", sourceRecordId: "context-history", url: "https://careers.example.test/jobs/context-history", title: "Synthetic C# engineer", companyName: "Synthetic context company", description: "Synthetic complete JD",
        locations: street === "sparse" ? [] : [{ raw: "上海", countryCode: "CN", region: "上海市", city: "上海市", ...(street !== "remote" ? { streetAddress: street } : {}) }],
        compensations: [{ raw: index === 1 ? "30k" : "20k", period: "unknown", tax: "unknown", kind: "unknown" }], workMode: street === "remote" ? "remote" : street === "sparse" ? "unknown" : "on-site", employmentType: "social", remoteEligibleRegions: [], availability: "unknown", completeness: "detail", evidence: [], warnings: [] }],
        observedAt: new Date(Date.parse(AT) + index * 60_000).toISOString(), coverage: { complete: true, partial: false, fetchedRecords: 1, appliedFilters: [], ignoredFilters: [] }, warnings: [] });
      const full = await repo.readProjectionSnapshot();
      const expected = await projectSourcePage(full, source, page, `context-${index}`);
      const count = observeReads(t);
      const slice = await repo.readProjectionSnapshot(await sourceProjectionSelection(source, page));
      const actual = await projectSourcePage(slice, source, page, `context-${index}`);
      const rows = count(); t.mock.restoreAll();
      assert.deepEqual(actual, expected, `source history ${index}`);
      assert.ok(rows < 100, `one source page materialized ${rows} rows`);
      await repo.importSnapshot(actual.delta, options(`context-${index}`));
    }
    assert.equal((await repo.readSnapshot()).jobs.length, 201);
  } finally { t.mock.restoreAll(); repo.close(); }
});

test("a shared source location updates all affected job versions while an unrelated job and alias history stay intact", async () => {
  const repo = openJobRepository(":memory:", { now: () => AT });
  try {
    const data = syntheticAtlas(3, "shared-location");
    data.jobs[1]!.locationIds = [...data.jobs[0]!.locationIds];
    data.listings[1]!.locationIds = [...data.jobs[0]!.locationIds];
    await repo.importSnapshot(data, options("seed", "seed-owner"));
    const before = await repo.backup(), delta = syntheticAtlas(0);
    delta.locations.push({ ...data.locations[0]!, streetAddress: "Synthetic disclosed street 1" });
    await repo.importSnapshot(delta, options("street"));
    const after = await repo.backup();
    for (const id of ["job-shared-location-0", "job-shared-location-1"]) assert.equal(after.dataset.jobs.find(job => job.id === id)!.revision, before.dataset.jobs.find(job => job.id === id)!.revision + 1);
    assert.deepEqual(after.dataset.jobs.find(job => job.id === "job-shared-location-2"), before.dataset.jobs.find(job => job.id === "job-shared-location-2"));
    assert.deepEqual(after.aliasHistory, before.aliasHistory);
  } finally { repo.close(); }
});

test("V6 migration preserves revision, epoch and facts; V7 restore rebuilds derived dependencies and a reopened writer stays incremental", async t => {
  const directory = await mkdtemp(join(tmpdir(), "better-me-projection-v7-")), path = join(directory, "jobs.sqlite");
  let repo = openJobRepository(path, { now: () => AT });
  try {
    await repo.importSnapshot(syntheticAtlas(30), options("seed", "seed-owner"));
    const before = await repo.readSnapshot(), baseline = await repo.syncSnapshot();
    assert.equal(baseline.kind, "snapshot");
    repo.close();
    const legacy = new DatabaseSync(path);
    try { legacy.exec("DROP TABLE base_job_dependencies; PRAGMA user_version=6; CREATE TRIGGER no_source_rewrite BEFORE UPDATE ON base_jobs BEGIN SELECT RAISE(ABORT,'must-not-rewrite'); END;"); } finally { legacy.close(); }
    repo = openJobRepository(path, { now: () => AT });
    assert.deepEqual(await repo.readSnapshot(), before);
    if (baseline.kind === "snapshot") assert.equal((await repo.syncSnapshot({ cursor: baseline.cursor })).kind, "unchanged");
    const backup = await repo.backup(); assert.equal(backup.schemaVersion, 7);
    await repo.restore(backup, { ...options("restore"), expectedRevision: before.revision });
    repo.close(); repo = openJobRepository(path, { now: () => AT });
    const count = observeReads(t);
    await repo.importSnapshot(syntheticAtlas(1, "after-reopen"), options("new"));
    assert.ok(count() < 100); t.mock.restoreAll();
    const inspector = new DatabaseSync(path, { readOnly: true });
    try { assert.equal((inspector.prepare("SELECT COUNT(*) AS count FROM base_job_dependencies WHERE job_id=?").get("job-after-reopen-0") as { count: number }).count, 3); }
    finally { inspector.close(); }
  } finally { t.mock.restoreAll(); repo.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a dependency write failure rolls back base origins, facts, cursor and receipt before an exact retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "better-me-projection-rollback-")), path = join(directory, "jobs.sqlite"), repo = openJobRepository(path, { now: () => AT });
  try {
    await repo.importSnapshot(syntheticAtlas(3), options("seed", "seed-owner"));
    const before = await repo.backup(), inspector = new DatabaseSync(path);
    try {
      inspector.exec("CREATE TRIGGER fail_dependency BEFORE INSERT ON base_job_dependencies WHEN NEW.job_id='job-new-0' BEGIN SELECT RAISE(ABORT,'synthetic dependency failure'); END;");
      await assert.rejects(repo.importSnapshot(syntheticAtlas(1, "new"), options("retry")), error => error instanceof RepositoryError && error.code === "storage-error");
      assert.deepEqual(await repo.backup(), before);
      inspector.exec("DROP TRIGGER fail_dependency");
      assert.equal((await repo.importSnapshot(syntheticAtlas(1, "new"), options("retry"))).counts.newJobs, 1);
    } finally { inspector.close(); }
  } finally { repo.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a failed V7 migration rolls back derived tables and leaves V6 facts and sync epoch reusable", async t => {
  const directory = await mkdtemp(join(tmpdir(), "better-me-projection-migration-")), path = join(directory, "jobs.sqlite");
  let repo = openJobRepository(path, { now: () => AT });
  try {
    await repo.importSnapshot(syntheticAtlas(2), options("seed", "seed-owner"));
    const before = await repo.readSnapshot(); repo.close();
    const legacy = new DatabaseSync(path); try { legacy.exec("DROP TABLE base_job_dependencies; PRAGMA user_version=6"); } finally { legacy.close(); }
    const original = DatabaseSync.prototype.exec;
    t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      const result = original.call(this, sql);
      if (sql.includes("CREATE TABLE base_job_dependencies")) throw new Error("synthetic migration interruption");
      return result;
    });
    assert.throws(() => openJobRepository(path)); t.mock.restoreAll();
    const inspector = new DatabaseSync(path);
    try {
      assert.equal((inspector.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 6);
      assert.equal(inspector.prepare("SELECT name FROM sqlite_schema WHERE name='base_job_dependencies'").get(), undefined);
    } finally { inspector.close(); }
    repo = openJobRepository(path, { now: () => AT }); assert.deepEqual(await repo.readSnapshot(), before);
  } finally { t.mock.restoreAll(); repo.close(); await rm(directory, { recursive: true, force: true }); }
});

test("partial writes still enforce whole-library public entity limits and reject atomically", async () => {
  const repo = openJobRepository(":memory:", { now: () => AT });
  try {
    const data = syntheticAtlas(0), source = data.sources[0]!;
    data.sources = Array.from({ length: 10_000 }, (_, index) => ({ ...source, sourceId: `synthetic-limit-${index}` }));
    await repo.importSnapshot(data, options("at-limit"));
    await assert.rejects(repo.importSnapshot(syntheticAtlas(0), options("over-limit")), error => error instanceof RepositoryError && error.code === "invalid-data");
    const after = await repo.readSnapshot(); assert.equal(after.sources.length, 10_000); assert.equal(after.revision, 1);
  } finally { repo.close(); }
});

test("5000/15000 jobs: three ingestion/enrichment batches materialize the same bounded rows", { skip: process.env.BETTER_ME_PROJECTION_BENCH !== "1", timeout: 180_000 }, async t => {
  let reference: { ingest: number; enrich: number }[] | undefined;
  for (const size of [5000, 15000]) {
    const repo = openJobRepository(":memory:", { now: () => AT });
    try {
      await repo.importSnapshot(syntheticAtlas(size), options("seed", "seed-owner"));
      const batches: { ingest: number; enrich: number }[] = [], timings: { ingestMs: number; enrichMs: number }[] = [];
      for (let batch = 0; batch < 3; batch++) {
        let count = observeReads(t), at = performance.now();
        await repo.importSnapshot(syntheticAtlas(16, `batch-${batch}`), options(`batch-${batch}`));
        const ingestMs = Math.round(performance.now() - at), ingest = count(); t.mock.restoreAll();
        count = observeReads(t); at = performance.now();
        const receipt = await repo.processEnrichmentBatch({ actorScope: "hot-owner", limit: 32 });
        const enrichMs = Math.round(performance.now() - at), enrich = count(); t.mock.restoreAll();
        assert.equal(receipt.completed, 16); assert.equal(receipt.changedJobs, 16);
        assert.ok(ingest < 100 && enrich < 1000, `hot batch loaded an unbounded library: ${JSON.stringify({ ingest, enrich })}`);
        batches.push({ ingest, enrich }); timings.push({ ingestMs, enrichMs });
      }
      if (reference) assert.deepEqual(batches, reference, "unrelated library growth must not increase projection materialization");
      reference = batches;
      const data = await repo.readSnapshot(); assert.equal(data.jobs.length, size + 48);
      t.diagnostic(JSON.stringify({ syntheticJobs: size, batches, timings, finalJobs: data.jobs.length }));
    } finally { t.mock.restoreAll(); repo.close(); }
  }
});
