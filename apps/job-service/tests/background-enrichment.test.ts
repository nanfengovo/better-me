import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { projectLocationConfirmations, projectOfficeAddressConfirmations, projectReconciliation, queryJobs, type AtlasDataset } from "@better-me/opportunities";
import { openJobRepository, RepositoryError } from "../src/repository.ts";

const AT = "2026-10-28T00:00:00.000Z";
const actorScope = "synthetic-enrichment-owner";
const field = <T>(value: T) => ({ value, evidence: [], method: "source-structured" as const, verification: "unverified" as const, revision: 0 });
function fixture(id = "one", raw = "上海", text = "Synthetic TypeScript role"): AtlasDataset {
  const listingId = `listing-${id}`, observationId = `observation-${id}`, snapshotId = `snapshot-${id}`;
  const url = `https://careers.example.test/jobs/${id}`, contentHash = createHash("sha256").update(text).digest("hex");
  return {
    schemaVersion: 1, revision: 0,
    sources: [{ sourceId: "source-one", name: "Synthetic source", adapterId: "synthetic", adapterVersion: "1", capabilities: ["list-jobs"], runtime: ["local-service"], entityType: "job-posting", enabled: true, status: "active", remoteFilters: [], endpointPolicy: { allowedHosts: ["careers.example.test"], allowedPathPrefixes: ["/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 }, attribution: { label: "Synthetic source", usage: "metadata", requiresAttribution: true }, refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 100, maxPages: 10, requestsPerMinute: 30 } }],
    companies: [{ id: `company-${id}`, names: [`Synthetic company ${id}`], domains: [], parentCompanyIds: [], ultimateControllers: field([]), manualOverrides: [] }],
    jobs: [{ id: `job-${id}`, companyId: `company-${id}`, title: field("Synthetic engineer"), description: text, locationIds: [`location-${id}`], compensationIds: [], listingIds: [listingId], selectedSnapshotId: snapshotId, workMode: "on-site", employmentType: "social", remoteEligibleRegions: [], status: "unknown", revision: 0, updatedAt: AT }],
    locations: [{ id: `location-${id}`, raw, kind: "office", precision: "unknown", verification: "unknown", evidence: [{ observationId, sourceUrl: url, observedAt: AT, quote: raw }] }],
    compensations: [],
    listings: [{ id: listingId, sourceId: "source-one", sourceRecordId: id, canonicalUrl: url, canonicalJobId: `job-${id}`, locationIds: [`location-${id}`], observationIds: [observationId], firstDiscoveredAt: AT }],
    observations: [{ id: observationId, listingId, fetchedAt: AT, contentHash, snapshotId, result: "read", availability: "unknown", completeness: "detail", warnings: [] }],
    snapshots: [{ id: snapshotId, listingId, observationId, text, contentHash, createdAt: AT, sourceUrl: url, extractionMethod: "source-structured", completeness: "detail" }],
  };
}
const opts = (idempotencyKey: string, expectedRevision: number) => ({ actorScope, idempotencyKey, expectedRevision });

test("a successful import schedules only its job and background source normalization makes Shanghai queryable without an office point", async () => {
  const repo = openJobRepository(":memory:", { now: () => AT });
  try {
    const source = fixture();
    await repo.importSnapshot(source, opts("import", 0));
    assert.equal((await queryJobs(await repo.readSnapshot(), { workCountryCodes: ["CN"] })).totalJobs, 0);
    assert.deepEqual(await repo.getEnrichmentStatus({ actorScope }), { revision: 1, pending: 1, running: 0, completed: 0, failed: 0 });
    const receipt = await repo.processEnrichmentBatch({ actorScope, limit: 8 });
    assert.equal(receipt.processed, 1);
    assert.equal(receipt.completed, 1);
    assert.equal(receipt.changedJobs, 1);
    const data = await repo.readSnapshot();
    assert.equal(data.revision, 2);
    assert.equal(data.locations[0]!.countryCode, "CN");
    assert.equal(data.locations[0]!.city, "上海市");
    assert.equal(data.locations[0]!.coordinates, undefined);
    assert.equal(data.locations[0]!.userResolution, undefined);
    assert.equal(data.locations[0]!.verification, "unverified");
    assert.deepEqual(data.observations, source.observations);
    assert.deepEqual(data.snapshots, source.snapshots);
    assert.equal((await queryJobs(data, { workCountryCodes: ["CN"], workRegionText: "上海" })).totalJobs, 1);
    assert.equal((await repo.processEnrichmentBatch({ actorScope })).processed, 0);
    assert.equal((await repo.readSnapshot()).revision, 2);
  } finally { repo.close(); }
});

test("company candidates parse only their own explicit controller disclosure and remain unverified, never manual", async () => {
  const repo = openJobRepository(":memory:", { now: () => AT });
  try {
    const input = fixture("owned", "上海", "Synthetic engineer\n实际控制人：上海市国资委\n职位说明");
    const unrelated = fixture("unrelated", "上海", "Synthetic engineer without any company controller disclosure");
    for (const table of ["companies", "jobs", "locations", "listings", "observations", "snapshots"] as const) (input[table] as unknown[]).push(...unrelated[table]);
    await repo.importSnapshot(input, opts("company-source", 0));
    await repo.processEnrichmentBatch({ actorScope });
    const data = await repo.readSnapshot();
    const company = data.companies.find(value => value.id === "company-owned")!;
    assert.deepEqual(company.ultimateControllers.value, [{ name: "上海市国资委", kind: "state" }]);
    assert.equal(company.ultimateControllers.method, "parser");
    assert.equal(company.ultimateControllers.verification, "unverified");
    assert.deepEqual(company.manualOverrides, []);
    assert.equal(company.ultimateControllers.evidence[0]!.observationId, "observation-owned");
    assert.equal(company.ultimateControllers.evidence[0]!.quote, "实际控制人：上海市国资委");
    assert.deepEqual(data.companies.find(value => value.id === "company-unrelated")!.ultimateControllers.value, []);
    assert.equal((await queryJobs(data, { ownershipKinds: ["state"] })).totalJobs, 0, "an unverified candidate is not a verified state-owned employer");
  } finally { repo.close(); }
});

test("durable pending work survives reopening, exact receipt replay does not enqueue twice, and actors cannot process one another's queue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "better-me-enrichment-"));
  const path = join(dir, "jobs.sqlite");
  let repo = openJobRepository(path, { now: () => AT });
  try {
    const first = await repo.importSnapshot(fixture(), opts("durable-import", 0));
    repo.close(); repo = openJobRepository(path, { now: () => AT });
    await repo.recoverInterruptedRuns();
    assert.equal((await repo.getEnrichmentStatus({ actorScope })).pending, 1);
    assert.equal((await repo.processEnrichmentBatch({ actorScope: "other-owner" })).processed, 0);
    assert.deepEqual(await repo.importSnapshot(fixture(), opts("durable-import", 0)), first);
    assert.equal((await repo.getEnrichmentStatus({ actorScope })).pending, 1);
    await repo.processEnrichmentBatch({ actorScope });
    const completed = await repo.getEnrichmentStatus({ actorScope });
    await repo.importSnapshot(fixture(), opts("durable-import", 0));
    assert.deepEqual(await repo.getEnrichmentStatus({ actorScope }), completed);
    assert.equal((await repo.processEnrichmentBatch({ actorScope })).processed, 0);
  } finally { repo.close(); await rm(dir, { recursive: true, force: true }); }
});

test("backup queue identities remain separate when actor and job IDs contain the kind separator", async () => {
  const repo = openJobRepository(":memory:", { now: () => AT });
  try {
    const firstActor = "a:source-metadata-v1:job-b";
    await repo.importSnapshot(fixture("c"), { ...opts("first", 0), actorScope: firstActor });
    await repo.importSnapshot(fixture("b:source-metadata-v1:job-c"), { ...opts("second", 1), actorScope: "a" });
    const backup = await repo.backup();
    assert.equal(backup.enrichmentTasks.length, 2);
    assert.equal((await repo.getEnrichmentStatus({ actorScope: firstActor })).pending, 1);
    assert.equal((await repo.getEnrichmentStatus({ actorScope: "a" })).pending, 1);
  } finally { repo.close(); }
});

test("ambiguous source cities and explicit manual choices are not overwritten by background parsing", async () => {
  const repo = openJobRepository(":memory:", { now: () => AT });
  try {
    await repo.importSnapshot(fixture("ambiguous", "上海 / 杭州"), opts("ambiguous", 0));
    const none = await repo.processEnrichmentBatch({ actorScope });
    assert.equal(none.changedJobs, 0); assert.equal(none.revision, 1);
    assert.equal((await repo.readSnapshot()).locations[0]!.countryCode, undefined);
    const manual = fixture("manual", "上海", "实际控制人：上海市国资委");
    manual.companies[0]!.manualOverrides.push({ id: "human-controller", field: "ultimateControllers", reason: "Synthetic reviewed control", at: AT, basedOnRevision: 0,
      value: { ...field([{ name: "Human reviewed controller", kind: "private" as const }]), method: "manual", revision: 1 } });
    await repo.importSnapshot(manual, opts("manual-source", 1));
    const command = { jobId: "job-manual", locationId: "location-manual", expectedRevision: 2, reason: "Synthetic explicit area", proposal: { locationKind: "office" as const, countryCode: "US", area: { kind: "manual-area" as const, city: "Boston" } } };
    const preview = await repo.previewLocationConfirmation(command);
    await repo.confirmLocation({ ...command, previewFingerprint: preview.previewFingerprint, reviewed: true }, opts("manual-location", 2));
    const before = await repo.readSnapshot();
    await repo.processEnrichmentBatch({ actorScope });
    const after = await repo.readSnapshot();
    assert.deepEqual(after.locations, before.locations);
    assert.deepEqual(after.companies, before.companies);
    assert.equal(after.revision, before.revision);
    assert.equal(after.locations.find(value => value.id === "location-manual")!.countryCode, "US");
  } finally { repo.close(); }
});

test("two city-prefixed address fragments stay ambiguous rather than silently selecting the first city", async () => {
  const repo = openJobRepository(":memory:", { now: () => AT });
  try {
    await repo.importSnapshot(fixture("multiple-addresses", "上海市浦东新区 / 杭州市余杭区"), opts("multiple-addresses", 0));
    const receipt = await repo.processEnrichmentBatch({ actorScope });
    assert.equal(receipt.changedJobs, 0);
    assert.equal(receipt.revision, 1);
    assert.equal((await repo.readSnapshot()).locations[0]!.countryCode, undefined);
  } finally { repo.close(); }
});

test("multiple explicit city names in an unsplit address remain unknown", async () => {
  const repo = openJobRepository(":memory:", { now: () => AT });
  try {
    await repo.importSnapshot(fixture("either-city", "上海市浦东新区或杭州市余杭区"), opts("either-city", 0));
    const receipt = await repo.processEnrichmentBatch({ actorScope });
    assert.equal(receipt.changedJobs, 0);
    assert.equal((await repo.readSnapshot()).locations[0]!.countryCode, undefined);
  } finally { repo.close(); }
});

test("background projection matches domain replay for empty, rejected, active and revoked merges while retaining alias history", async () => {
  for (const scenario of ["empty", "reject", "merge", "revoked", "manual-area"] as const) {
    const repo = openJobRepository(":memory:", { now: () => AT });
    try {
      const input = fixture("a");
      const second = fixture("b");
      for (const table of ["companies", "jobs", "locations", "listings", "observations", "snapshots"] as const) (input[table] as unknown[]).push(...second[table]);
      await repo.importSnapshot(input, opts("seed", 0));
      if (scenario === "reject") await repo.rejectMerge({ leftJobId: "job-a", rightJobId: "job-b", reason: "Synthetic distinct requisitions" }, opts("reject", 1));
      if (scenario === "merge" || scenario === "revoked") {
        const merged = await repo.mergeJobs({ targetJobId: "job-a", sourceJobId: "job-b", reason: "Synthetic same requisition reviewed", companyIdentityConfirmed: true }, opts("merge", 1));
        if (scenario === "revoked") await repo.revokeMerge({ decisionId: merged.decision.id, reason: "Synthetic split reviewed" }, opts("revoke", 2));
      }
      if (scenario === "manual-area") {
        const value = { jobId: "job-a", locationId: "location-a", expectedRevision: 1, reason: "Synthetic reviewed area", proposal: { locationKind: "office" as const, countryCode: "US", area: { kind: "manual-area" as const, city: "Boston" } } };
        const preview = await repo.previewLocationConfirmation(value);
        await repo.confirmLocation({ ...value, previewFingerprint: preview.previewFingerprint, reviewed: true }, opts("manual-area", 1));
      }
      const before = await repo.backup();
      await repo.processEnrichmentBatch({ actorScope });
      const after = await repo.backup(), base = await repo.readProjectionSnapshot();
      const reference = projectReconciliation(projectOfficeAddressConfirmations(projectLocationConfirmations(base, after.locationDecisions), after.officeDecisions), after.mergeDecisions);
      const jobBodies = (data: AtlasDataset) => data.jobs.map(({ revision: _revision, updatedAt: _at, ...job }) => job);
      assert.deepEqual(jobBodies(after.dataset), jobBodies(reference.dataset), scenario);
      assert.deepEqual(after.dataset.locations, reference.dataset.locations, scenario);
      assert.deepEqual(after.dataset.listings, reference.dataset.listings, scenario);
      assert.deepEqual(after.aliasHistory, before.aliasHistory, scenario);
      for (const alias of reference.aliases) assert.equal((await repo.resolveJobId(alias.jobId))!.canonicalJobId, alias.canonicalJobId, scenario);
    } finally { repo.close(); }
  }
});

test("one background item writes only its changed source location and no unchanged alias rows", async (t) => {
  const repo = openJobRepository(":memory:", { now: () => AT });
  try {
    const input = fixture("a"), second = fixture("b");
    for (const table of ["companies", "jobs", "locations", "listings", "observations", "snapshots"] as const) (input[table] as unknown[]).push(...second[table]);
    await repo.importSnapshot(input, opts("seed", 0));
    let locationWrites = 0, aliasWrites = 0;
    const original = DatabaseSync.prototype.prepare;
    t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      const statement = original.call(this, sql);
      if (!sql.startsWith("INSERT INTO base_locations") && !sql.startsWith("INSERT INTO job_aliases")) return statement;
      return new Proxy(statement, { get(target, property) {
        if (property === "run") return (...args: Parameters<typeof statement.run>) => { if (sql.startsWith("INSERT INTO base_locations")) locationWrites++; else aliasWrites++; return statement.run(...args); };
        const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
      } });
    });
    await repo.processEnrichmentBatch({ actorScope, limit: 1 });
    assert.equal(locationWrites, 1); assert.equal(aliasWrites, 0);
    assert.equal((await repo.getEnrichmentStatus({ actorScope })).pending, 1);
  } finally { repo.close(); }
});

test("a later source contribution supersedes queued input and withdraws the old source-only company candidate", async () => {
  const repo = openJobRepository(":memory:", { now: () => AT });
  try {
    await repo.importSnapshot(fixture("one", "上海", "实际控制人：上海市国资委"), opts("first", 0));
    await repo.processEnrichmentBatch({ actorScope });
    const newer = fixture("one", "杭州", "Updated role without a controller disclosure");
    newer.locations[0]!.id = "location-moved";
    newer.jobs[0]!.locationIds = ["location-moved"]; newer.listings[0]!.locationIds = ["location-moved"];
    newer.jobs[0]!.revision = 1; newer.jobs[0]!.updatedAt = "2026-10-28T01:00:00.000Z";
    newer.observations[0]!.id = "observation-new"; newer.snapshots[0]!.observationId = "observation-new";
    newer.locations[0]!.evidence[0]!.observationId = "observation-new";
    newer.snapshots[0]!.id = "snapshot-new"; newer.observations[0]!.snapshotId = "snapshot-new"; newer.jobs[0]!.selectedSnapshotId = "snapshot-new";
    newer.listings[0]!.observationIds = ["observation-new"];
    await repo.importSnapshot(newer, opts("refresh", 2));
    assert.equal((await repo.getEnrichmentStatus({ actorScope })).pending, 1, "the same origin job coalesces instead of adding a second task");
    await repo.processEnrichmentBatch({ actorScope });
    const data = await repo.readSnapshot();
    assert.equal(data.locations.find(value => value.id === "location-moved")!.city, "杭州市");
    assert.deepEqual(data.companies[0]!.ultimateControllers.value, []);
    assert.equal(data.companies[0]!.ultimateControllers.verification, "unknown");
    assert.equal(data.observations.length, 2);
    assert.equal(data.snapshots.length, 2);
  } finally { repo.close(); }
});

test("outbox enqueue is atomic with import facts and receipt", async (t) => {
  const repo = openJobRepository(":memory:", { now: () => AT });
  try {
    const before = await repo.backup();
    const original = DatabaseSync.prototype.prepare;
    const failure = t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      if (sql.startsWith("INSERT INTO enrichment_tasks")) throw new Error("synthetic storage failure");
      return original.call(this, sql);
    });
    await assert.rejects(repo.importSnapshot(fixture(), opts("retryable", 0)), (error: unknown) => error instanceof RepositoryError && error.code === "storage-error");
    failure.mock.restore();
    assert.deepEqual(await repo.backup(), before);
    assert.equal((await repo.importSnapshot(fixture(), opts("retryable", 0))).counts.newJobs, 1);
    assert.equal((await repo.getEnrichmentStatus({ actorScope })).pending, 1);
  } finally { repo.close(); }
});

test("storage failure rolls back enrichment facts, persists bounded retry state, and never spins after three attempts", async (t) => {
  let clock = AT;
  const repo = openJobRepository(":memory:", { now: () => clock });
  try {
    await repo.importSnapshot(fixture(), opts("retry-source", 0));
    const original = DatabaseSync.prototype.prepare;
    const failure = t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      if (sql.startsWith("INSERT INTO locations")) throw new Error("synthetic failed fact write");
      return original.call(this, sql);
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      await assert.rejects(repo.processEnrichmentBatch({ actorScope }), (error: unknown) => error instanceof RepositoryError && error.code === "storage-error");
      const status = await repo.getEnrichmentStatus({ actorScope });
      assert.equal(status.failed, 1); assert.equal(status.running, 0); assert.equal(status.revision, 1);
      assert.equal((await repo.readSnapshot()).locations[0]!.countryCode, undefined);
      assert.equal((await repo.processEnrichmentBatch({ actorScope })).processed, 0, "not due or exhausted attempts must not run");
      if (attempt < 2) { assert.ok(status.nextRetryAt); clock = status.nextRetryAt; }
      else assert.equal(status.nextRetryAt, undefined);
    }
    failure.mock.restore();
    clock = "2026-10-29T00:00:00.000Z";
    assert.equal((await repo.processEnrichmentBatch({ actorScope })).processed, 0);
    const backup = await repo.backup(); assert.equal(backup.enrichmentTasks[0]!.attempts, 3);
  } finally { repo.close(); }
});

test("a durable running lease interrupted before apply is reset only by owned startup recovery", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "better-me-enrichment-recovery-")), path = join(dir, "jobs.sqlite");
  let repo = openJobRepository(path, { now: () => AT });
  try {
    await repo.importSnapshot(fixture(), opts("interrupted-source", 0));
    const original = DatabaseSync.prototype.prepare;
    let interrupted = false;
    const failure = t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      if (sql === "SELECT document FROM jobs WHERE id=?") { interrupted = true; throw new Error("synthetic storage outage after claim"); }
      if (interrupted && sql.startsWith("INSERT INTO enrichment_tasks")) throw new Error("synthetic storage unavailable for cleanup");
      return original.call(this, sql);
    });
    await assert.rejects(repo.processEnrichmentBatch({ actorScope }));
    failure.mock.restore();
    repo.close(); repo = openJobRepository(path, { now: () => AT });
    assert.equal((await repo.getEnrichmentStatus({ actorScope })).running, 1);
    assert.equal((await repo.processEnrichmentBatch({ actorScope })).processed, 0, "another owner cannot steal a nonexpired lease");
    await repo.recoverInterruptedRuns();
    assert.equal((await repo.getEnrichmentStatus({ actorScope })).pending, 1);
    assert.equal((await repo.processEnrichmentBatch({ actorScope })).completed, 1);
    assert.equal((await repo.getEnrichmentStatus({ actorScope })).running, 0);
  } finally { repo.close(); await rm(dir, { recursive: true, force: true }); }
});

test("v4 migration does not enqueue or relabel historical jobs and v5 backups preserve queued work", async () => {
  const dir = await mkdtemp(join(tmpdir(), "better-me-enrichment-migration-")), path = join(dir, "jobs.sqlite");
  let repo = openJobRepository(path, { now: () => AT });
  try {
    await repo.importSnapshot(fixture("old"), opts("historical", 0));
    repo.close();
    const old = new DatabaseSync(path);
    try { old.exec("DROP TABLE base_job_dependencies; DROP TABLE dataset_changes; DELETE FROM metadata WHERE key IN ('sync_epoch','sync_floor'); DROP TABLE enrichment_tasks; PRAGMA user_version=4;"); } finally { old.close(); }
    repo = openJobRepository(path, { now: () => AT });
    await repo.recoverInterruptedRuns();
    assert.equal((await repo.getEnrichmentStatus({ actorScope })).pending, 0);
    assert.equal((await repo.processEnrichmentBatch({ actorScope })).processed, 0);
    assert.equal((await repo.readSnapshot()).locations[0]!.countryCode, undefined);
    await repo.importSnapshot(fixture("new"), opts("only-new", 1));
    const backup = await repo.backup(); assert.equal(backup.enrichmentTasks.length, 1);
    const restored = openJobRepository(":memory:", { now: () => AT });
    try {
      await restored.restore(backup, opts("restore-queue", 0));
      assert.equal((await restored.getEnrichmentStatus({ actorScope })).pending, 1);
      await restored.processEnrichmentBatch({ actorScope });
      const data = await restored.readSnapshot();
      assert.equal(data.locations.find(value => value.id === "location-old")!.countryCode, undefined);
      assert.equal(data.locations.find(value => value.id === "location-new")!.countryCode, "CN");
    } finally { restored.close(); }
  } finally { repo.close(); await rm(dir, { recursive: true, force: true }); }
});

test("failed queue restoration is atomic with all existing facts and receipts", async (t) => {
  const source = openJobRepository(":memory:", { now: () => AT });
  const target = openJobRepository(":memory:", { now: () => AT });
  try {
    await source.importSnapshot(fixture("incoming"), opts("source-import", 0));
    const incoming = await source.backup();
    await target.importSnapshot(fixture("existing"), opts("target-import", 0));
    const before = await target.backup();
    const invalid = structuredClone(incoming);
    invalid.enrichmentTasks[0]!.jobId = "job-not-in-backup";
    await assert.rejects(target.restore(invalid, opts("invalid-restore", 1)), (error: unknown) => error instanceof RepositoryError && error.code === "invalid-backup");
    assert.deepEqual(await target.backup(), before);
    const original = DatabaseSync.prototype.prepare;
    const failure = t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      if (sql.startsWith("INSERT INTO enrichment_tasks")) throw new Error("synthetic queue restore failure");
      return original.call(this, sql);
    });
    await assert.rejects(target.restore(incoming, opts("valid-restore", 1)), (error: unknown) => error instanceof RepositoryError && error.code === "storage-error");
    failure.mock.restore();
    assert.deepEqual(await target.backup(), before);
    await target.restore(incoming, opts("valid-restore", 1));
    assert.deepEqual((await target.readSnapshot()).jobs.map(job => job.id), ["job-incoming"]);
    assert.equal((await target.getEnrichmentStatus({ actorScope })).pending, 1);
  } finally { source.close(); target.close(); }
});

test("a failed v5 migration rolls back its schema and preserves the v4 source facts", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "better-me-enrichment-migration-failure-")), path = join(dir, "jobs.sqlite");
  const seed = openJobRepository(path, { now: () => AT });
  try {
    await seed.importSnapshot(fixture("historical"), opts("seed", 0));
    seed.close();
    const previous = new DatabaseSync(path);
    try { previous.exec("DROP TABLE base_job_dependencies; DROP TABLE dataset_changes; DELETE FROM metadata WHERE key IN ('sync_epoch','sync_floor'); DROP TABLE enrichment_tasks; PRAGMA user_version=4;"); } finally { previous.close(); }
    const original = DatabaseSync.prototype.exec;
    const failure = t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      original.call(this, sql);
      if (sql.includes("CREATE TABLE enrichment_tasks")) throw new Error("synthetic migration failure after table creation");
    });
    assert.throws(() => openJobRepository(path, { now: () => AT }), (error: unknown) => error instanceof RepositoryError && error.code === "storage-error");
    failure.mock.restore();
    const inspector = new DatabaseSync(path);
    try {
      assert.equal((inspector.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 4);
      assert.equal(inspector.prepare("SELECT name FROM sqlite_schema WHERE name='enrichment_tasks'").get(), undefined);
      assert.equal((inspector.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number }).count, 1);
    } finally { inspector.close(); }
    const migrated = openJobRepository(path, { now: () => AT });
    try {
      assert.equal((await migrated.readSnapshot()).jobs[0]!.id, "job-historical");
      assert.equal((await migrated.getEnrichmentStatus({ actorScope })).pending, 0);
    } finally { migrated.close(); }
  } finally { seed.close(); await rm(dir, { recursive: true, force: true }); }
});

test("invalid base entity structure and dangling base references reject background application without changing public facts", async () => {
  for (const corruption of ["job-structure", "job-reference", "location-reference"] as const) {
    const dir = await mkdtemp(join(tmpdir(), "better-me-enrichment-base-validation-")), path = join(dir, "jobs.sqlite");
    const repo = openJobRepository(path, { now: () => AT });
    try {
      await repo.importSnapshot(fixture(), opts("seed", 0));
      const before = await repo.readSnapshot(), inspector = new DatabaseSync(path);
      try {
        if (corruption === "job-structure") inspector.prepare("UPDATE base_jobs SET document=json_set(document,'$.title.value',17) WHERE id=?").run("job-one");
        if (corruption === "job-reference") inspector.prepare("UPDATE base_jobs SET document=json_set(document,'$.companyId','missing-company') WHERE id=?").run("job-one");
        if (corruption === "location-reference") inspector.prepare("UPDATE base_locations SET document=json_set(document,'$.evidence[0].observationId','missing-observation') WHERE id=?").run("location-one");
      } finally { inspector.close(); }
      await assert.rejects(repo.readProjectionSnapshot(), (error: unknown) => error instanceof RepositoryError && error.code === "invalid-data", corruption);
      await assert.rejects(repo.processEnrichmentBatch({ actorScope }), (error: unknown) => error instanceof RepositoryError && error.code === "invalid-data", corruption);
      assert.deepEqual(await repo.readSnapshot(), before, corruption);
      assert.equal((await repo.getEnrichmentStatus({ actorScope })).failed, 1, corruption);
    } finally { repo.close(); await rm(dir, { recursive: true, force: true }); }
  }
});

test("synthetic bounded-batch latency probe", { skip: process.env.BETTER_ME_ENRICHMENT_BENCH !== "1" }, async (t) => {
  for (const size of [10, 100, 5000]) {
    const repo = openJobRepository(":memory:", { now: () => AT });
    try {
      const input = fixture("bench-0");
      for (let index = 1; index < size; index++) {
        const item = fixture(`bench-${index}`);
        for (const table of ["companies", "jobs", "locations", "listings", "observations", "snapshots"] as const) (input[table] as unknown[]).push(...item[table]);
      }
      const start = performance.now();
      await repo.importSnapshot(input, opts("benchmark-seed", 0));
      const importMs = performance.now() - start;
      let pending = size;
      for (const limit of [1, 16]) {
        const startedAt = performance.now();
        const timer = new Promise<number>(resolve => setTimeout(() => resolve(performance.now() - startedAt), 0));
        const result = await repo.processEnrichmentBatch({ actorScope, limit });
        const elapsed = performance.now() - startedAt;
        const timerDelay = await timer;
        const processed = Math.min(limit, pending); pending -= processed;
        assert.equal(result.processed, processed); assert.equal(result.completed, processed); assert.equal(result.changedJobs, processed);
        assert.equal(result.status.pending, pending);
        t.diagnostic(JSON.stringify({ syntheticJobs: size, batchLimit: limit, processed, importMs: Math.round(importMs), batchMs: Math.round(elapsed), eventLoopTimerDelayMs: Math.round(timerDelay), pending }));
      }
    } finally { repo.close(); }
  }
});
