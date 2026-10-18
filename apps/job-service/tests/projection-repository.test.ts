import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type SourceDefinition } from "@better-me/opportunities";
import { type SourceJobRecord, type SourcePage } from "@better-me/source-adapters";
import { openJobRepository, type JobRepository } from "../src/repository.ts";
import { emptyDelta, projectSourcePage } from "../src/projection.ts";

const source: SourceDefinition = {
  sourceId: "projection-source", name: "合成投影来源", adapterId: "synthetic", adapterVersion: "1", capabilities: ["list-jobs"], runtime: ["local-service"], entityType: "job-posting", enabled: true, status: "active", remoteFilters: [],
  endpointPolicy: { allowedHosts: ["careers.example.test"], allowedPathPrefixes: ["/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 }, attribution: { label: "合成来源", usage: "metadata", requiresAttribution: true }, refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 100, maxPages: 10, requestsPerMinute: 30 },
};
const actorScope = "local-ui:projection-test";
function record(id: string, city: string): SourceJobRecord {
  return { entityType: "job-posting", sourceRecordId: id, url: `https://careers.example.test/jobs/${id}`, title: "同名合成软件工程师", companyName: "合成同公司", description: `合成公开职责 ${city}，TypeScript 与测试。`, locations: [{ raw: `中国 ${city}`, countryCode: "CN", city }], compensations: [], workMode: "on-site", employmentType: "social", remoteEligibleRegions: [], availability: "unknown", completeness: "detail", evidence: [], warnings: [] };
}
function page(records: SourceJobRecord[], observedAt: string): SourcePage {
  return { records, observedAt, coverage: { complete: true, partial: false, fetchedRecords: records.length, appliedFilters: [], ignoredFilters: [] }, warnings: [] };
}
async function withRepository(task: (repo: JobRepository) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "better-me-project-repository-test-"));
  const repo = openJobRepository(join(dir, "jobs.sqlite"));
  try {
    const seed = emptyDelta(); seed.sources = [source];
    await repo.importSnapshot(seed, { actorScope, idempotencyKey: "seed" });
    await task(repo);
  } finally { repo.close(); await rm(dir, { recursive: true, force: true }); }
}
async function applyPage(repo: JobRepository, records: SourceJobRecord[], key: string, observedAt: string, runId?: string) {
  const run = runId ?? (await repo.startRun({ sourceId: source.sourceId, scope: {}, actorScope, idempotencyKey: `${key}.start` })).runId;
  const before = await repo.readSnapshot();
  const projection = await projectSourcePage(before, source, page(records, observedAt), run);
  const receipt = await repo.importSnapshot(projection.delta, { actorScope, idempotencyKey: key, expectedRevision: before.revision, runId: run });
  return { projection, receipt, runId: run };
}
test("real projection+SQLite repeated runs keep identities/snapshots and distinct same-title cities, while changed JD appends history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "better-me-project-repository-test-"));
  const repo = openJobRepository(join(dir, "jobs.sqlite"));
  try {
    const seed = emptyDelta(); seed.sources = [source];
    await repo.importSnapshot(seed, { actorScope, idempotencyKey: "seed" });
    const entries = [record("shanghai-42", "上海"), record("beijing-43", "北京")];
    async function refresh(key: string, entries: SourceJobRecord[], date: string) {
      const run = await repo.startRun({ sourceId: source.sourceId, scope: {}, actorScope, idempotencyKey: key });
      const before = await repo.readSnapshot();
      const projection = await projectSourcePage(before, source, page(entries, date), run.runId);
      const receipt = await repo.importSnapshot(projection.delta, { actorScope, idempotencyKey: `${key}.page-1`, expectedRevision: before.revision, runId: run.runId });
      await repo.finishRun(run.runId, { actorScope, status: "completed", summary: { records: entries.length, pages: 1, added: receipt.counts.newJobs, changed: receipt.counts.updatedJobs } });
      return { receipt, projection };
    }
    const first = await refresh("first", entries, "2026-10-18T00:00:00.000Z");
    assert.equal(first.receipt.counts.newJobs, 2);
    const initial = await repo.readSnapshot();
    assert.equal(initial.jobs.length, 2); assert.equal(initial.snapshots.length, 2); assert.equal(initial.companies.length, 1);
    const jobIds = initial.jobs.map((job) => job.id).sort(); const snapshotIds = initial.snapshots.map((snapshot) => snapshot.id).sort();
    assert.equal(new Set(initial.jobs.map((job) => job.locationIds[0])).size, 2);
    const second = await refresh("second", entries, "2026-10-19T00:00:00.000Z");
    const unchanged = await repo.readSnapshot();
    assert.deepEqual(unchanged.jobs.map((job) => job.id).sort(), jobIds);
    assert.deepEqual(unchanged.snapshots.map((snapshot) => snapshot.id).sort(), snapshotIds);
    assert.equal(unchanged.observations.length, 4); assert.equal(second.receipt.counts.newJobs, 0); assert.equal(second.receipt.counts.newSnapshots, 0);
    assert.equal(second.projection.unchangedJobs, 2);
    const modified = structuredClone(entries); modified[0]!.description += " JD新增明确职责，不改旧快照。";
    const third = await refresh("third", modified, "2026-10-20T00:00:00.000Z");
    const changed = await repo.readSnapshot();
    assert.deepEqual(changed.jobs.map((job) => job.id).sort(), jobIds);
    assert.equal(changed.snapshots.length, 3); assert.equal(changed.observations.length, 6); assert.equal(third.receipt.counts.updatedJobs, 1);
    for (const snapshot of initial.snapshots) assert.deepEqual(changed.snapshots.find((value) => value.id === snapshot.id), snapshot);
    for (const listing of changed.listings) assert.equal(listing.observationIds.length, 3);
    const adoptedOldSnapshot = initial.jobs.find((job) => job.description.includes("上海"))!.selectedSnapshotId;
    assert.ok(changed.snapshots.some((snapshot) => snapshot.id === adoptedOldSnapshot));
    assert.notEqual(changed.jobs.find((job) => job.description.includes("新增"))!.selectedSnapshotId, adoptedOldSnapshot);
  } finally { repo.close(); await rm(dir, { recursive: true, force: true }); }
});

test("overlapping pages in one run reuse observations while a changed JD appends a distinct immutable observation", async () => {
  await withRepository(async (repo) => {
    const entry = record("overlap-42", "上海");
    const first = await applyPage(repo, [entry], "page-1", "2026-10-18T00:00:00.000Z");
    const before = await repo.readSnapshot();
    const overlap = await applyPage(repo, [entry, structuredClone(entry)], "page-2", "2026-10-18T00:01:00.000Z", first.runId);
    const identical = await repo.readSnapshot();
    assert.equal(overlap.receipt.counts.newObservations, 0);
    assert.equal(overlap.receipt.counts.newSnapshots, 0);
    assert.equal(identical.observations.length, 1);
    assert.equal(identical.snapshots.length, 1);
    assert.deepEqual(identical.observations, before.observations);
    const revised = { ...entry, description: `${entry.description} 本页发现新增职责。` };
    const changed = await applyPage(repo, [revised], "page-3", "2026-10-18T00:02:00.000Z", first.runId);
    const after = await repo.readSnapshot();
    assert.equal(changed.receipt.counts.newObservations, 1);
    assert.equal(changed.receipt.counts.newSnapshots, 1);
    assert.equal(changed.receipt.counts.updatedJobs, 1);
    assert.equal(after.observations.length, 2);
    assert.equal(after.snapshots.length, 2);
    assert.equal(after.listings[0]!.observationIds.length, 2);
    assert.deepEqual(after.snapshots.find((item) => item.id === before.snapshots[0]!.id), before.snapshots[0]);
    assert.notEqual(after.jobs[0]!.selectedSnapshotId, before.jobs[0]!.selectedSnapshotId);
  });
});

test("remote regions are not offices and absent source fields preserve prior location, salary, eligibility and JD", async () => {
  await withRepository(async (repo) => {
    const entry: SourceJobRecord = {
      ...record("remote-42", "上海"), workMode: "remote", remoteEligibleRegions: ["中国大陆"],
      compensations: [{ raw: "人民币税前月薪 20,000–30,000，13薪", currency: "CNY", period: "month", min: 20_000, max: 30_000, tax: "gross", kind: "base", monthsPerYear: 13 }],
    };
    await applyPage(repo, [entry], "remote-first", "2026-10-18T00:00:00.000Z");
    const initial = await repo.readSnapshot();
    assert.equal(initial.locations[0]!.kind, "remote-region");
    const absent: SourceJobRecord = { ...entry, locations: [], compensations: [], remoteEligibleRegions: [], workMode: "unknown", employmentType: "unknown", completeness: "excerpt" };
    delete absent.description;
    await applyPage(repo, [absent], "remote-absent", "2026-10-19T00:00:00.000Z");
    const retained = await repo.readSnapshot();
    assert.deepEqual(retained.jobs, initial.jobs);
    assert.deepEqual(retained.listings[0]!.locationIds, initial.listings[0]!.locationIds);
    assert.deepEqual(retained.listings[0]!.compensationIds, initial.listings[0]!.compensationIds);
    assert.deepEqual(retained.jobs[0]!.remoteEligibleRegions, ["中国大陆"]);
    assert.equal(retained.jobs[0]!.selectedSnapshotId, initial.jobs[0]!.selectedSnapshotId);
    assert.equal(retained.snapshots.length, 1);
    await applyPage(repo, [{ ...entry, workMode: "unknown" }], "remote-unknown", "2026-10-20T00:00:00.000Z");
    const unknownMode = await repo.readSnapshot();
    assert.equal(unknownMode.locations.length, 1);
    assert.equal(unknownMode.locations[0]!.kind, "remote-region");
    assert.deepEqual(unknownMode.jobs[0]!.locationIds, initial.jobs[0]!.locationIds);
    assert.equal(unknownMode.jobs[0]!.workMode, "remote");
  });
});

test("a stable listing cannot silently adopt a different employer identity", async () => {
  await withRepository(async (repo) => {
    const entry = record("identity-42", "上海");
    await applyPage(repo, [entry], "identity-first", "2026-10-18T00:00:00.000Z");
    const initial = await repo.readSnapshot();
    await assert.rejects(
      projectSourcePage(initial, source, page([{ ...entry, companyName: "另一个无关雇主" }], "2026-10-19T00:00:00.000Z"), "identity-next-run"),
      (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "source-changed"),
    );
    assert.deepEqual(await repo.readSnapshot(), initial);
    const sameEmployer = { ...entry, companyName: " 合成同公司 " };
    const compatible = await projectSourcePage(initial, source, page([sameEmployer], "2026-10-19T00:00:00.000Z"), "identity-next-run");
    assert.equal(compatible.delta.companies.length, 0);
    assert.equal(compatible.delta.jobs[0]!.companyId, initial.jobs[0]!.companyId);
  });
});

test("duplicate source locations, salaries and remote regions normalize to valid unique public references", async () => {
  await withRepository(async (repo) => {
    const entry = record("duplicates-42", "上海");
    const salary: SourceJobRecord["compensations"][number] = { raw: "年薪人民币 300,000", currency: "CNY", period: "year", min: 300_000, max: 300_000, tax: "gross", kind: "base" };
    entry.locations.push(structuredClone(entry.locations[0]!));
    entry.compensations = [salary, structuredClone(salary)];
    entry.remoteEligibleRegions = ["中国大陆", "中国大陆"];
    entry.workMode = "remote";
    await applyPage(repo, [entry], "duplicates", "2026-10-18T00:00:00.000Z");
    const actual = await repo.readSnapshot();
    assert.equal(actual.locations.length, 1);
    assert.equal(actual.compensations.length, 1);
    assert.equal(actual.listings[0]!.locationIds.length, 1);
    assert.equal(actual.listings[0]!.compensationIds.length, 1);
    assert.deepEqual(actual.jobs[0]!.remoteEligibleRegions, ["中国大陆"]);
  });
});
