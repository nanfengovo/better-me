import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openJobRepository, type JobRepository } from "../src/repository.js";
import { applyDatasetDelta, DATASET_TABLES, DatasetSyncResponseSchema, SYNC_REVISION_WINDOW, type DatasetCursor } from "../src/dataset-sync-contract.js";
import { createDatasetSyncStore } from "../src/dataset-sync.js";
import { syntheticAtlas, SYNTHETIC_AT } from "./synthetic-atlas.js";

const options = (idempotencyKey: string, expectedRevision?: number) => ({ actorScope: "synthetic-owner", idempotencyKey, ...(expectedRevision === undefined ? {} : { expectedRevision }) });
async function baseline(repo: JobRepository) {
  const result = DatasetSyncResponseSchema.parse(await repo.syncSnapshot());
  assert.equal(result.kind, "snapshot");
  if (result.kind !== "snapshot") throw new Error("expected baseline");
  assert.deepEqual(result.dataset, await repo.readSnapshot());
  return result;
}
async function assertDelta(repo: JobRepository, before: Awaited<ReturnType<typeof baseline>>) {
  const value = DatasetSyncResponseSchema.parse(await repo.syncSnapshot({ cursor: before.cursor }));
  assert.equal(value.kind, "delta");
  if (value.kind !== "delta") throw new Error("expected delta");
  assert.deepEqual(applyDatasetDelta(before.dataset, before.cursor, value), await repo.readSnapshot());
  return value;
}

test("incremental net changes match full export across missed revisions, merge tombstones, split and idempotent replay", async () => {
  const repo = openJobRepository(":memory:");
  try {
    await repo.importSnapshot(syntheticAtlas(3), options("seed", 0));
    const initial = await baseline(repo);
    await repo.importSnapshot(syntheticAtlas(2, "new"), options("new", 1));
    const companyOnly = syntheticAtlas(0);
    companyOnly.companies = [{ ...initial.dataset.companies[0]!, names: ["Updated synthetic employer"] }];
    await repo.importSnapshot(companyOnly, options("company", 2));
    const net = await assertDelta(repo, initial);
    assert.equal(net.to.revision, 3); assert.equal(net.upserts.jobs.length, 2);
    assert.equal(net.upserts.companies.length, 3); assert.equal(net.upserts.sources.length, 0);
    const beforeMerge = await baseline(repo);
    const [target, source] = beforeMerge.dataset.jobs;
    const input = { targetJobId: target!.id, sourceJobId: source!.id, reason: "Synthetic reviewed same requisition", companyIdentityConfirmed: true };
    const merged = await repo.mergeJobs(input, options("merge", 3));
    const deletion = await assertDelta(repo, beforeMerge);
    assert.deepEqual(deletion.deletes.jobs, [source!.id]);
    assert.ok(deletion.upserts.listings.some(listing => listing.canonicalJobId === target!.id));
    await repo.mergeJobs(input, options("merge", 3));
    assert.deepEqual(await repo.syncSnapshot({ cursor: deletion.to }), { protocol: deletion.protocol, kind: "unchanged", cursor: deletion.to });
    const mergedBaseline = await baseline(repo);
    await repo.revokeMerge({ decisionId: merged.decision.id, reason: "Synthetic split" }, options("split", merged.revision));
    const split = await assertDelta(repo, mergedBaseline);
    assert.ok(split.upserts.jobs.some(job => job.id === source!.id));
    assert.deepEqual(split.deletes.jobs, []);
    await assertDelta(repo, beforeMerge); // Delete then re-create collapses to its latest entity.
  } finally { repo.close(); }
});

test("public legacy office quarantine and its warning disappear together when superseded or revoked", async () => {
  const repo = openJobRepository(":memory:", { now: () => SYNTHETIC_AT });
  try {
    const seed = syntheticAtlas(1);
    delete seed.locations[0]!.coordinates; seed.locations[0]!.precision = "unknown";
    await repo.importSnapshot(seed, options("seed"));
    const initial = await baseline(repo);
    async function confirm(reason: string, key: string) {
      const data = await repo.readSnapshot();
      const input = { jobId: data.jobs[0]!.id, locationId: data.locations[0]!.id, expectedRevision: data.revision, reason,
        proposal: { basis: "manual-user-confirmation" as const, countryCode: "CN", formattedAddress: "上海 Synthetic Road 123", streetAddress: "Synthetic Road 123", evidenceUrl: seed.listings[0]!.canonicalUrl, coordinates: { latitude: 31.2, longitude: 121.5, coordinateSystem: "WGS84" as const }, coordinateMeaning: "building" as const } };
      const preview = await repo.previewOfficeConfirmation(input);
      return repo.confirmOfficeAddress({ ...input, reviewed: true, previewFingerprint: preview.previewFingerprint }, options(key, data.revision));
    }
    await confirm("企业公开办公区与园区坐标核实：Synthetic legacy campus", "legacy");
    const quarantined = await assertDelta(repo, initial);
    assert.equal(quarantined.upserts.locations[0]!.coordinates, undefined);
    assert.match(quarantined.upserts.observations[0]!.warnings.join(" "), /legacy-office-coordinate-quarantined/);
    const legacy = await baseline(repo);
    const manual = await confirm("本人核对实际办公位置的合成测试", "manual");
    const reviewed = await assertDelta(repo, legacy);
    assert.ok(reviewed.upserts.locations[0]!.coordinates);
    assert.deepEqual(reviewed.upserts.observations[0]!.warnings, []);
    const manualBaseline = await baseline(repo);
    await repo.revokeOfficeAddress({ jobId: seed.jobs[0]!.id, locationId: seed.locations[0]!.id, decisionId: manual.decisionId,
      expectedRevision: manual.revision, reviewed: true, reason: "Synthetic revoke to legacy source" }, options("revoke", manual.revision));
    const revoked = await assertDelta(repo, manualBaseline);
    assert.equal(revoked.upserts.locations[0]!.coordinates, undefined);
    assert.match(revoked.upserts.observations[0]!.warnings.join(" "), /legacy-office-coordinate-quarantined/);
  } finally { repo.close(); }
});

test("reopen/WAL readers retain cursors; failed writes roll back markers; restore creates a new epoch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "better-me-sync-durable-"));
  const path = join(directory, "jobs.sqlite");
  let repo = openJobRepository(path);
  let reader: JobRepository | undefined;
  const inspector = new DatabaseSync(path);
  try {
    await repo.importSnapshot(syntheticAtlas(2), options("seed"));
    const initial = await baseline(repo), backup = await repo.backup();
    const markers = inspector.prepare("SELECT * FROM dataset_changes ORDER BY table_name,entity_id").all();
    inspector.exec("CREATE TRIGGER synthetic_failed_job BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT,'synthetic-rollback'); END");
    await assert.rejects(repo.importSnapshot(syntheticAtlas(1, "rolled-back"), options("fail", 1)));
    assert.deepEqual(inspector.prepare("SELECT * FROM dataset_changes ORDER BY table_name,entity_id").all(), markers);
    assert.equal((await repo.syncSnapshot({ cursor: initial.cursor })).kind, "unchanged");
    inspector.exec("DROP TRIGGER synthetic_failed_job");
    repo.close(); repo = openJobRepository(path); reader = openJobRepository(path, { readOnly: true });
    assert.equal((await reader.syncSnapshot({ cursor: initial.cursor })).kind, "unchanged");
    await repo.importSnapshot(syntheticAtlas(1, "committed"), options("new", 1));
    await assertDelta(reader, initial);
    const beforeRestore = await baseline(reader);
    await repo.restore(backup, options("restore", beforeRestore.cursor.revision) as Parameters<typeof repo.restore>[1]);
    const reset = await reader.syncSnapshot({ cursor: beforeRestore.cursor });
    assert.equal(reset.kind, "snapshot");
    if (reset.kind !== "snapshot") throw new Error("expected reset");
    assert.equal(reset.reason, "store-changed"); assert.notEqual(reset.cursor.epoch, beforeRestore.cursor.epoch);
    assert.deepEqual(reset.dataset, await reader.readSnapshot());
  } finally { inspector.close(); reader?.close(); repo.close(); await rm(directory, { recursive: true, force: true }); }
});

test("V5 migration establishes a baseline without rewriting library rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "better-me-sync-migrate-"));
  const path = join(directory, "jobs.sqlite");
  let repo = openJobRepository(path);
  try {
    await repo.importSnapshot(syntheticAtlas(2), options("seed"));
    const before = await repo.readSnapshot(); repo.close();
    const db = new DatabaseSync(path);
    try { db.exec("DROP TABLE base_job_dependencies; DROP TABLE dataset_changes; DELETE FROM metadata WHERE key IN ('sync_epoch','sync_floor'); PRAGMA user_version=5; CREATE TRIGGER synthetic_no_job_rewrite BEFORE UPDATE ON jobs BEGIN SELECT RAISE(ABORT,'must-not-rewrite'); END"); }
    finally { db.close(); }
    repo = openJobRepository(path);
    const first = await baseline(repo);
    assert.deepEqual(first.dataset, before);
    const old = await repo.syncSnapshot({ cursor: { ...first.cursor, revision: 0 } });
    assert.equal(old.kind, "snapshot"); if (old.kind === "snapshot") assert.equal(old.reason, "cursor-expired");
    await repo.importSnapshot(syntheticAtlas(1, "new"), options("new", 1));
    await assertDelta(repo, first);
  } finally { repo.close(); await rm(directory, { recursive: true, force: true }); }
});

test("unchanged and metadata-only revisions do not call full snapshot projection; bounded gaps reset safely", async () => {
  const repo = openJobRepository(":memory:");
  try {
    const first = await baseline(repo);
    const db = new DatabaseSync(":memory:");
    try {
      // A deliberately minimal adapter makes any accidental full projection fail.
      db.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE dataset_changes(table_name TEXT,entity_id TEXT,revision INTEGER,deleted INTEGER,PRIMARY KEY(table_name,entity_id)); CREATE INDEX dataset_changes_revision ON dataset_changes(revision)");
      for (const table of DATASET_TABLES) db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY,document TEXT)`);
      for (const [key, value] of Object.entries({ revision: "1", sync_epoch: first.cursor.epoch, sync_floor: "0" })) db.prepare("INSERT INTO metadata VALUES (?,?)").run(key, value);
      let snapshots = 0;
      const sync = createDatasetSyncStore(db, () => { snapshots++; return { ...first.dataset, revision: Number((db.prepare("SELECT value FROM metadata WHERE key='revision'").get() as { value: string }).value) }; }, rows => rows);
      const cursor: DatasetCursor = { ...first.cursor, revision: 1 };
      assert.equal(sync.read({ cursor }).kind, "unchanged"); assert.equal(snapshots, 0);
      const metadataOnly = sync.read({ cursor: { ...cursor, revision: 0 } });
      assert.equal(metadataOnly.kind, "delta"); assert.equal(snapshots, 0);
      if (metadataOnly.kind === "delta") assert.ok(DATASET_TABLES.every(table => metadataOnly.upserts[table].length === 0));
      const ahead = sync.read({ cursor: { ...cursor, revision: 2 } });
      assert.equal(ahead.kind, "snapshot"); if (ahead.kind === "snapshot") assert.equal(ahead.reason, "cursor-ahead");
      db.prepare("UPDATE metadata SET value=? WHERE key='revision'").run(String(SYNC_REVISION_WINDOW + 2)); sync.finish(SYNC_REVISION_WINDOW + 2);
      const expired = sync.read({ cursor }); assert.equal(expired.kind, "snapshot"); if (expired.kind === "snapshot") assert.equal(expired.reason, "cursor-expired");
    } finally { db.close(); }
  } finally { repo.close(); }
});

test("oversized change sets reset to a complete same-revision snapshot instead of truncating", async () => {
  const repo = openJobRepository(":memory:");
  try {
    const first = await baseline(repo);
    await repo.importSnapshot(syntheticAtlas(700), options("large-batch"));
    const value = DatasetSyncResponseSchema.parse(await repo.syncSnapshot({ cursor: first.cursor }));
    assert.equal(value.kind, "snapshot");
    if (value.kind === "snapshot") { assert.equal(value.reason, "delta-too-large"); assert.equal(value.dataset.jobs.length, 700); assert.equal(value.cursor.revision, value.dataset.revision); }
  } finally { repo.close(); }
});

test("a byte-heavy small batch also resets completely instead of bypassing the delta byte budget", async () => {
  const repo = openJobRepository(":memory:");
  try {
    const first = await baseline(repo), incoming = syntheticAtlas(120);
    for (let index = 0; index < incoming.jobs.length; index++) {
      const text = `Synthetic ${index} ${"Long synthetic description. ".repeat(1000)}`;
      incoming.jobs[index]!.description = text; incoming.snapshots[index]!.text = text;
      const contentHash = createHash("sha256").update(text).digest("hex");
      incoming.snapshots[index]!.contentHash = contentHash; incoming.observations[index]!.contentHash = contentHash;
    }
    await repo.importSnapshot(incoming, options("large-text"));
    const response = await repo.syncSnapshot({ cursor: first.cursor });
    assert.equal(response.kind, "snapshot");
    if (response.kind === "snapshot") { assert.equal(response.reason, "delta-too-large"); assert.equal(response.dataset.jobs.length, 120); assert.deepEqual(response.dataset, await repo.readSnapshot()); }
  } finally { repo.close(); }
});

test("a failed V6 migration rolls back both cursor metadata and change markers without changing V5 evidence", async t => {
  const directory = await mkdtemp(join(tmpdir(), "better-me-sync-migration-failure-")), path = join(directory, "jobs.sqlite");
  const repo = openJobRepository(path);
  try {
    await repo.importSnapshot(syntheticAtlas(2), options("seed")); repo.close();
    const previous = new DatabaseSync(path);
    try { previous.exec("DROP TABLE base_job_dependencies; DROP TABLE dataset_changes; DELETE FROM metadata WHERE key IN ('sync_epoch','sync_floor'); PRAGMA user_version=5"); }
    finally { previous.close(); }
    const original = DatabaseSync.prototype.exec;
    const failure = t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      original.call(this, sql);
      if (sql.includes("CREATE TABLE dataset_changes")) throw new Error("synthetic migration interruption");
    });
    assert.throws(() => openJobRepository(path)); failure.mock.restore();
    const inspector = new DatabaseSync(path);
    try {
      assert.equal((inspector.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 5);
      assert.equal(inspector.prepare("SELECT name FROM sqlite_schema WHERE name='dataset_changes'").get(), undefined);
      assert.equal(inspector.prepare("SELECT value FROM metadata WHERE key='sync_epoch'").get(), undefined);
      assert.equal((inspector.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number }).count, 2);
    } finally { inspector.close(); }
    const reopened = openJobRepository(path);
    try { assert.equal((await baseline(reopened)).dataset.jobs.length, 2); } finally { reopened.close(); }
  } finally { repo.close(); await rm(directory, { recursive: true, force: true }); }
});
