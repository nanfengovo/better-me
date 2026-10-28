import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { openJobRepository, RepositoryError } from "../src/repository.ts";
import { startJobApplicationRuntime } from "../src/application-runtime.ts";
import { syntheticAtlas } from "./synthetic-atlas.ts";

test("WAL read-only lane reads a coherent committed snapshot while the writer holds its transaction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "better-me-wal-reader-"));
  const path = join(directory, "jobs.sqlite");
  const writer = openJobRepository(path);
  let reader: ReturnType<typeof openJobRepository> | undefined, raw: DatabaseSync | undefined;
  try {
    await writer.importSnapshot(syntheticAtlas(3), { actorScope: "synthetic", idempotencyKey: "seed" });
    reader = openJobRepository(path, { readOnly: true });
    raw = new DatabaseSync(path); raw.exec("BEGIN IMMEDIATE; UPDATE metadata SET value='2' WHERE key='revision';");
    assert.equal((await reader.readSnapshot()).revision, 1);
    raw.exec("COMMIT");
    assert.equal((await reader.readSnapshot()).revision, 2);
    await assert.rejects(reader.importSnapshot(syntheticAtlas(1, "forbidden"), { actorScope: "synthetic", idempotencyKey: "forbidden" }), error => error instanceof RepositoryError);
    assert.equal((await writer.readSnapshot()).jobs.length, 3);
  } finally { raw?.close(); reader?.close(); writer.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a one-job import writes only its changed base origins and leaves other source evidence intact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "better-me-incremental-origins-"));
  const path = join(directory, "jobs.sqlite"), repository = openJobRepository(path);
  try {
    await repository.importSnapshot(syntheticAtlas(30), { actorScope: "synthetic", idempotencyKey: "seed" });
    const before = await repository.readProjectionSnapshot();
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TRIGGER unrelated_base_job BEFORE UPDATE ON base_jobs WHEN OLD.id LIKE 'job-scale-%' BEGIN SELECT RAISE(ABORT, 'unrelated base job rewritten'); END; CREATE TRIGGER unrelated_base_location BEFORE UPDATE ON base_locations WHEN OLD.id LIKE 'location-scale-%' BEGIN SELECT RAISE(ABORT, 'unrelated base location rewritten'); END;");
    raw.close();
    await repository.importSnapshot(syntheticAtlas(1, "new"), { actorScope: "synthetic", idempotencyKey: "delta", expectedRevision: 1 });
    const after = await repository.readProjectionSnapshot();
    assert.equal(after.jobs.length, 31);
    for (const table of ["jobs", "locations", "observations", "snapshots"] as const) assert.deepEqual(after[table].filter(value => before[table].some(previous => previous.id === value.id)), before[table]);
  } finally { repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test("isolated runtime preserves CAS, exact idempotent receipts, cancellation and shutdown gating", async () => {
  const directory = await mkdtemp(join(tmpdir(), "better-me-runtime-"));
  const runtime = await startJobApplicationRuntime({ databasePath: join(directory, "jobs.sqlite"), config: { dataDirectory: directory, allowedOrigins: ["http://localhost:5296"] } });
  const context = (key: string) => ({ requestId: key, actorScope: "synthetic-owner", signal: new AbortController().signal, budget: { requests: 0, bytes: 64 * 1024 * 1024, timeoutMs: 30_000 }, allowedEffects: ["read-index", "local-write"] as const, idempotencyKey: key });
  try {
    const input = { dataset: syntheticAtlas(3), expectedRevision: 0 };
    const first = await runtime.registry.execute("jobs.import-public", input, context("write"));
    assert.equal(first.ok, true);
    assert.deepEqual(await runtime.registry.execute("jobs.import-public", input, context("write")), first);
    const stale = await runtime.registry.execute("jobs.import-public", { dataset: syntheticAtlas(1, "stale"), expectedRevision: 0 }, context("stale"));
    assert.equal(stale.ok, false); if (!stale.ok) assert.equal(stale.error.code, "stale-version");
    const cancelled = new AbortController(); cancelled.abort();
    const aborted = await runtime.registry.execute("jobs.import-public", { dataset: syntheticAtlas(1, "cancelled"), expectedRevision: 1 }, { ...context("cancelled"), signal: cancelled.signal });
    assert.equal(aborted.ok, false); if (!aborted.ok) assert.equal(aborted.error.code, "cancelled");
    const read = await runtime.registry.execute<{ jobs: unknown[] }>("jobs.export-public", {}, context("read"));
    assert.equal(read.ok, true); if (read.ok) assert.equal(read.value.jobs.length, 3);
    await runtime.shutdown();
    assert.equal((await runtime.registry.execute("jobs.export-public", {}, context("closed"))).ok, false);
  } finally { await runtime.shutdown(); await rm(directory, { recursive: true, force: true }); }
});

test("runtime startup failure fails closed rather than opening an unisolated fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "better-me-runtime-failure-"));
  try {
    await assert.rejects(startJobApplicationRuntime({ databasePath: join(directory, "missing", "jobs.sqlite"), config: { dataDirectory: directory, allowedOrigins: ["http://localhost:5296"] } }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
