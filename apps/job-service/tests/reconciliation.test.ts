import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { deriveEntityId, explainMergeCandidate, jobSpecificApplicationUrl, queryJobs, type AtlasDataset, type OfficialRequisitionLink } from "@better-me/opportunities";
import type { SourceJobRecord, SourcePage } from "@better-me/source-adapters";
import { openJobRepository, RepositoryError, type JobRepository } from "../src/repository.ts";
import { projectSourcePage } from "../src/projection.ts";

const AT = "2026-10-18T00:00:00.000Z";
const LATER = "2026-10-19T00:00:00.000Z";
const actorScope = "local-owner";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const options = (idempotencyKey: string, expectedRevision: number) => ({ actorScope, idempotencyKey, expectedRevision });
const field = (value: string) => ({ value, evidence: [], method: "source-structured" as const, verification: "unverified" as const, revision: 0 });
const errorCode = (expected: string) => (error: unknown) => error instanceof RepositoryError && error.code === expected;
async function fixture(count = 2) {
  const dataset: AtlasDataset = { schemaVersion: 1, revision: 0, sources: [], companies: [], jobs: [], locations: [], compensations: [], listings: [], observations: [], snapshots: [] };
  const ids: Array<{ jobId: string; listingId: string; companyId: string; sourceId: string; city: string }> = [];
  for (let index = 0; index < count; index++) {
    const sourceId = `reconcile-source-${index}`; const companyName = "合成跨源雇主";
    const listingId = await deriveEntityId("listing", [sourceId, "job-42"]);
    const jobId = await deriveEntityId("job", [sourceId, "job-42"]);
    const companyId = await deriveEntityId("company", [sourceId, companyName]);
    const observationId = `reconcile-observation-${index}`; const snapshotId = `reconcile-snapshot-${index}`;
    const locationId = `reconcile-location-${index}`; const compensationId = `reconcile-pay-${index}`;
    const description = `合成公开职责来源 ${index}：TypeScript 软件工程。`;
    const city = index === 0 ? "上海" : index === 1 ? "北京" : "深圳";
    dataset.sources.push({ sourceId, name: `合成来源 ${index}`, adapterId: "synthetic", adapterVersion: "1", capabilities: ["list-jobs"], runtime: ["local-service"], entityType: "job-posting", enabled: true, status: "active", remoteFilters: [],
      endpointPolicy: { allowedHosts: ["careers.example.test"], allowedPathPrefixes: ["/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 }, attribution: { label: `合成源 ${index}`, usage: "metadata", requiresAttribution: true }, refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 100, maxPages: 2, requestsPerMinute: 30 } });
    dataset.companies.push({ id: companyId, names: [companyName], domains: [], parentCompanyIds: [], manualOverrides: [], ultimateControllers: { value: [], evidence: [], method: "source-structured", verification: "unknown", revision: 0 } });
    dataset.jobs.push({ id: jobId, companyId, title: field("合成软件工程师"), description, locationIds: [locationId], compensationIds: [compensationId], listingIds: [listingId], selectedSnapshotId: snapshotId, workMode: "on-site", employmentType: "social", remoteEligibleRegions: [], status: index === 0 ? "open" : "closed", revision: 0, updatedAt: AT });
    dataset.locations.push({ id: locationId, raw: city, city, countryCode: "CN", kind: "office", precision: "city", evidence: [], verification: "unverified" });
    dataset.compensations.push({ id: compensationId, raw: `合成年薪 ${200_000 + index * 100_000}`, currency: "CNY", period: "year", min: 200_000 + index * 100_000, tax: "gross", kind: "base", evidence: [], verification: "unverified" });
    dataset.listings.push({ id: listingId, sourceId, sourceRecordId: "job-42", canonicalUrl: `https://careers.example.test/${sourceId}/job-42`, applicationUrl: "https://careers.example.test/careers", canonicalJobId: jobId, locationIds: [locationId], compensationIds: [compensationId], observationIds: [observationId], firstDiscoveredAt: AT, recordLastSeenAt: AT });
    dataset.observations.push({ id: observationId, listingId, fetchedAt: AT, result: "read", availability: index === 0 ? "open" : "closed", availabilityMethod: "source-explicit", availabilityVerifiedAt: AT, contentHash: hash(description), snapshotId, completeness: "detail", warnings: [] });
    dataset.snapshots.push({ id: snapshotId, listingId, observationId, text: description, contentHash: hash(description), createdAt: AT, extractionMethod: "source-structured", completeness: "detail" });
    ids.push({ jobId, listingId, companyId, sourceId, city });
  }
  return { dataset, ids };
}
async function withRepository(task: (repo: JobRepository, path: string, fixture: Awaited<ReturnType<typeof fixture>>) => Promise<void>, count = 2) {
  const dir = await mkdtemp(join(tmpdir(), "better-me-reconciliation-test-")); const path = join(dir, "jobs.sqlite");
  const repo = openJobRepository(path, { now: () => AT });
  try { const data = await fixture(count); await repo.importSnapshot(data.dataset, options("seed", 0)); await task(repo, path, data); }
  finally { repo.close(); await rm(dir, { recursive: true, force: true }); }
}

test("merge proposals explain strong job links, while shared names, platform IDs and careers homepages never auto-merge", async () => {
  const { dataset, ids } = await fixture(); const [a, b] = ids;
  const weak = await explainMergeCandidate(dataset, { leftJobId: a!.jobId, rightJobId: b!.jobId });
  assert.equal(weak.strong, false); assert.equal(weak.requiresCompanyConfirmation, true);
  assert.ok(weak.signals.some((signal) => signal.kind === "same-employer-name"));
  for (const generic of ["https://example.test", "https://example.test/careers", "https://example.test/jobs/search?keyword=engineer", "https://example.test/en"]) assert.equal(jobSpecificApplicationUrl(generic), undefined);
  dataset.listings[0]!.applicationUrl = "https://example.test/jobs/R123456?utm_source=platform";
  dataset.listings[1]!.applicationUrl = "https://example.test/jobs/R123456";
  const linked = await explainMergeCandidate(dataset, { leftJobId: a!.jobId, rightJobId: b!.jobId });
  assert.equal(linked.strong, true); assert.equal(linked.requiresCompanyConfirmation, true);
  assert.ok(linked.signals.some((signal) => signal.kind === "same-application-url"));
  dataset.listings.forEach((listing) => { delete listing.applicationUrl; });
  const requisitionLinks: OfficialRequisitionLink[] = ids.map((id, index) => ({ listingId: id.listingId, namespace: "https://employer.example.test/requisitions", value: "REQ-123456", verification: "verified", evidence: [{ observationId: dataset.observations[index]!.id, sourceUrl: `https://employer.example.test/jobs/REQ-123456`, observedAt: AT, quote: "Official requisition REQ-123456" }] }));
  const official = await explainMergeCandidate(dataset, { leftJobId: a!.jobId, rightJobId: b!.jobId, requisitionLinks });
  assert.equal(official.strong, true);
  const bad = structuredClone(requisitionLinks); bad[0]!.evidence[0]!.observationId = dataset.observations[1]!.id;
  await assert.rejects(explainMergeCandidate(dataset, { leftJobId: a!.jobId, rightJobId: b!.jobId, requisitionLinks: bad }));
  assert.equal(dataset.jobs.length, 2);
});

test("manual merge atomically keeps source conflicts, all evidence and old IDs, with durable decisions and replay", async () => withRepository(async (repo, path, data) => {
  const [a, b] = data.ids; const before = await repo.backup();
  const input = { targetJobId: a!.jobId, sourceJobId: b!.jobId, reason: "本人核实为同一招聘需求", companyIdentityConfirmed: true };
  await assert.rejects(repo.mergeJobs({ ...input, companyIdentityConfirmed: false }, options("unconfirmed-company", 1)), errorCode("conflict"));
  assert.deepEqual(await repo.backup(), before);
  const runA = await repo.startRun({ sourceId: a!.sourceId, scope: {}, actorScope, idempotencyKey: "active-a" });
  const runB = await repo.startRun({ sourceId: b!.sourceId, scope: {}, actorScope, idempotencyKey: "active-b" });
  const merged = await repo.mergeJobs(input, options("merge", 1));
  assert.deepEqual(await repo.mergeJobs(input, options("merge", 1)), merged);
  const after = await repo.readSnapshot();
  assert.equal(after.jobs.length, 1); assert.equal(after.jobs[0]!.id, a!.jobId); assert.equal(after.jobs[0]!.status, "open");
  assert.equal(after.jobs[0]!.listingIds.length, 2); assert.equal(after.jobs[0]!.locationIds.length, 2); assert.equal(after.jobs[0]!.compensationIds.length, 2);
  assert.deepEqual(after.observations, before.dataset.observations); assert.deepEqual(after.snapshots, before.dataset.snapshots);
  assert.equal((await queryJobs(after, {}, { now: AT })).totalJobs, 1);
  assert.equal((await repo.resolveJobId(b!.jobId))!.canonicalJobId, a!.jobId);
  const conflicts = await repo.readReconciliationConflicts(b!.jobId);
  assert.equal(conflicts.summaryJobId, a!.jobId); assert.ok(conflicts.conflicts.some((conflict) => conflict.field === "status"));
  assert.equal((await repo.getRun(runA.runId))!.status, "superseded"); assert.equal((await repo.getRun(runB.runId))!.status, "superseded");
  await assert.rejects(repo.importSnapshot(data.dataset, { ...options("late-source", after.revision), runId: runB.runId }), errorCode("stale-version"));
  const inspector = new DatabaseSync(path);
  try {
    assert.throws(() => inspector.prepare("UPDATE merge_decisions SET document=document WHERE id=?").run(merged.decision.id), /immutable-merge-decision/);
    assert.throws(() => inspector.exec("DELETE FROM job_alias_history"), /immutable-alias-history/);
  } finally { inspector.close(); }
  repo.close(); const reopened = openJobRepository(path, { now: () => AT });
  try {
    assert.deepEqual(await reopened.mergeJobs(input, options("merge", 1)), merged);
    assert.equal((await reopened.resolveJobId(b!.jobId))!.canonicalJobId, a!.jobId);
    await assert.rejects(reopened.mergeJobs({ ...input, reason: "different" }, options("merge", 1)), errorCode("idempotency-conflict"));
  } finally { reopened.close(); }
}));

test("real source projection after merging updates its own origin and splitting retains the latest JD, pay and location", async () => withRepository(async (repo, _path, data) => {
  const [a, b] = data.ids;
  const merged = await repo.mergeJobs({ targetJobId: a!.jobId, sourceJobId: b!.jobId, reason: "同岗人工核实", companyIdentityConfirmed: true }, options("merge", 1));
  const run = await repo.startRun({ sourceId: b!.sourceId, scope: {}, actorScope, idempotencyKey: "refresh-b" });
  const origins = await repo.readProjectionSnapshot(); const source = origins.sources.find((source) => source.sourceId === b!.sourceId)!;
  assert.equal(origins.jobs.length, 2);
  const record: SourceJobRecord = { entityType: "job-posting", sourceRecordId: "job-42", url: `https://careers.example.test/${b!.sourceId}/job-42`, companyName: "合成跨源雇主", title: "来源B更新后的高级软件工程师", description: "来源B明确更新后的职责，旧文本必须保留。", locations: [{ raw: "深圳", city: "深圳", countryCode: "CN" }], compensations: [{ raw: "税前年薪400000", currency: "CNY", period: "year", min: 400_000, tax: "gross", kind: "base" }], workMode: "on-site", employmentType: "social", remoteEligibleRegions: [], availability: "unknown", completeness: "detail", evidence: [], warnings: [] };
  const page: SourcePage = { records: [record], observedAt: LATER, coverage: { complete: true, partial: false, fetchedRecords: 1, appliedFilters: [], ignoredFilters: [] }, warnings: [] };
  const projected = await projectSourcePage(origins, source, page, run.runId);
  const receipt = await repo.importSnapshot(projected.delta, { ...options("source-b-page", origins.revision), runId: run.runId });
  assert.deepEqual(receipt.jobIds, [a!.jobId]);
  const current = await repo.readSnapshot();
  assert.equal(current.jobs.length, 1); assert.equal(current.jobs[0]!.title.value, "合成软件工程师");
  assert.equal(current.jobs[0]!.companyId, a!.companyId); assert.equal(current.snapshots.length, 3); assert.equal(current.observations.length, 3);
  assert.equal(current.listings.find((listing) => listing.id === b!.listingId)!.canonicalJobId, a!.jobId);
  assert.ok((await repo.readReconciliationConflicts(a!.jobId)).conflicts.some((conflict) => conflict.field === "title" && conflict.variants.some((variant) => variant.preview.includes("高级"))));
  const split = await repo.revokeMerge({ decisionId: merged.decision.id, reason: "来源职责已分化，恢复分开" }, options("split", current.revision));
  const after = await repo.readSnapshot(); const restoredB = after.jobs.find((job) => job.id === b!.jobId)!;
  assert.equal(after.jobs.length, 2); assert.equal(restoredB.title.value, record.title); assert.equal(restoredB.description, record.description);
  assert.equal(after.snapshots.find((snapshot) => snapshot.id === restoredB.selectedSnapshotId)!.text, record.description);
  assert.deepEqual(restoredB.compensationIds.map((id) => after.compensations.find((salary) => salary.id === id)!.min), [400_000]);
  assert.deepEqual(restoredB.locationIds.map((id) => after.locations.find((location) => location.id === id)!.city), ["深圳"]);
  assert.equal((await repo.resolveJobId(b!.jobId))!.canonicalJobId, b!.jobId);
  assert.equal((await repo.resolveJobId(b!.jobId, { atRevision: merged.revision }))!.canonicalJobId, a!.jobId);
  assert.equal((await repo.resolveJobId(b!.jobId, { atRevision: split.revision }))!.canonicalJobId, b!.jobId);
  assert.equal(after.snapshots.length, 3); assert.equal(after.observations.length, 3);
  assert.equal((await repo.getRun(run.runId))!.status, "superseded");
  await assert.rejects(repo.importSnapshot(projected.delta, { ...options("late-after-split", after.revision), runId: run.runId }), errorCode("stale-version"));
}));

test("nested merge edges can be revoked independently and aliases retain their historical route", async () => withRepository(async (repo, _path, data) => {
  const [a, b, c] = data.ids;
  const first = await repo.mergeJobs({ targetJobId: a!.jobId, sourceJobId: b!.jobId, reason: "第一组合并", companyIdentityConfirmed: true }, options("first", 1));
  const second = await repo.mergeJobs({ targetJobId: c!.jobId, sourceJobId: b!.jobId, reason: "旧ID解析后再合并第三源", companyIdentityConfirmed: true }, options("second", first.revision));
  assert.equal((await repo.readSnapshot()).jobs.length, 1);
  assert.equal((await repo.resolveJobId(b!.jobId))!.canonicalJobId, c!.jobId);
  const revoked = await repo.revokeMerge({ decisionId: first.decision.id, reason: "拆回第一条边" }, options("revoke-first", second.revision));
  assert.equal((await repo.readSnapshot()).jobs.length, 2);
  assert.equal((await repo.resolveJobId(b!.jobId))!.canonicalJobId, b!.jobId);
  assert.equal((await repo.resolveJobId(a!.jobId))!.canonicalJobId, c!.jobId);
  await repo.revokeMerge({ decisionId: second.decision.id, reason: "拆回第二条边" }, options("revoke-second", revoked.revision));
  assert.equal((await repo.readSnapshot()).jobs.length, 3);
  for (const id of data.ids) assert.equal((await repo.resolveJobId(id.jobId))!.canonicalJobId, id.jobId);
  assert.equal((await repo.resolveJobId(b!.jobId, { atRevision: first.revision }))!.canonicalJobId, a!.jobId);
  assert.equal((await repo.resolveJobId(b!.jobId, { atRevision: second.revision }))!.canonicalJobId, c!.jobId);
}, 3));

test("rejections persist, can be revoked, and failed alias writes roll the whole merge and run state back", async () => withRepository(async (repo, path, data) => {
  const [a, b] = data.ids; assert.equal((await repo.listMergeCandidates()).length, 1);
  const reject = await repo.rejectMerge({ leftJobId: a!.jobId, rightJobId: b!.jobId, reason: "同名但目前不足以确认" }, options("reject", 1));
  assert.equal((await repo.listMergeCandidates()).length, 0);
  const undo = await repo.revokeMerge({ decisionId: reject.decision.id, reason: "重新核查" }, options("undo-reject", reject.revision));
  assert.equal((await repo.listMergeCandidates()).length, 1);
  const run = await repo.startRun({ sourceId: b!.sourceId, scope: {}, actorScope, idempotencyKey: "active-during-fault" });
  const before = await repo.backup(); const inspector = new DatabaseSync(path);
  try {
    inspector.exec("CREATE TRIGGER injected_alias_failure BEFORE INSERT ON job_alias_history BEGIN SELECT RAISE(ABORT,'synthetic-write-failure'); END;");
    await assert.rejects(repo.mergeJobs({ targetJobId: a!.jobId, sourceJobId: b!.jobId, reason: "触发真实事务回滚", companyIdentityConfirmed: true }, options("retryable-merge", undo.revision)), errorCode("storage-error"));
    assert.deepEqual(await repo.backup(), before); assert.equal((await repo.getRun(run.runId))!.status, "running");
    inspector.exec("DROP TRIGGER injected_alias_failure");
    await repo.mergeJobs({ targetJobId: a!.jobId, sourceJobId: b!.jobId, reason: "触发真实事务回滚", companyIdentityConfirmed: true }, options("retryable-merge", undo.revision));
    assert.equal((await repo.readSnapshot()).jobs.length, 1);
  } finally { inspector.close(); }
}));

test("stale or unauthorized decisions, cancelled source results and merged public projections cannot rewrite origins", async () => withRepository(async (repo, _path, data) => {
  const [a, b] = data.ids;
  const input = { targetJobId: a!.jobId, sourceJobId: b!.jobId, reason: "显式人工确认", companyIdentityConfirmed: true };
  await assert.rejects(repo.mergeJobs(input, options("stale", 0)), errorCode("stale-version"));
  const merge = await repo.mergeJobs(input, options("merge", 1));
  const before = await repo.backup();
  await assert.rejects(repo.revokeMerge({ decisionId: merge.decision.id, reason: "其他身份尝试撤销" }, { ...options("another-actor", merge.revision), actorScope: "another:actor" }), errorCode("not-authorized"));
  await assert.rejects(repo.importSnapshot(before.dataset, options("merged-export-overwrite", merge.revision)), errorCode("conflict"));
  assert.deepEqual(await repo.backup(), before);
  const run = await repo.startRun({ sourceId: b!.sourceId, scope: {}, actorScope, idempotencyKey: "cancelled-source" });
  await repo.cancelRun(run.runId, { actorScope });
  const afterCancel = await repo.backup();
  await assert.rejects(repo.importSnapshot(await repo.readProjectionSnapshot(), { ...options("cancelled-late", merge.revision), runId: run.runId }), errorCode("cancelled"));
  assert.deepEqual(await repo.backup(), afterCancel);
}));

test("versioned backups preserve merge decisions and split origins while v1 public repository backups still restore", async () => withRepository(async (repo, _path, data) => {
  const [a, b] = data.ids; const old = await repo.backup();
  const legacy = { format: old.format, schemaVersion: 1, createdAt: old.createdAt, dataset: old.dataset, runs: old.runs, receipts: old.receipts, leads: old.leads };
  const merge = await repo.mergeJobs({ targetJobId: a!.jobId, sourceJobId: b!.jobId, reason: "备份前确认同岗", companyIdentityConfirmed: true }, options("merge-before-backup", 1));
  const backup = await repo.backup(); assert.equal(backup.schemaVersion, 5); assert.equal(backup.baseJobs!.length, 2);
  const restored = openJobRepository(":memory:", { now: () => AT });
  try {
    const invalid = structuredClone(backup); invalid.mergeDecisions[0]!.id = "unrelated-replacement";
    await assert.rejects(restored.restore(invalid, options("invalid-reconcile-backup", 0)), errorCode("invalid-backup"));
    const wrongAlias = structuredClone(backup);
    wrongAlias.aliasHistory.findLast((event) => event.jobId === b!.jobId)!.canonicalJobId = b!.jobId;
    await assert.rejects(restored.restore(wrongAlias, options("invalid-current-alias", 0)), errorCode("invalid-backup"));
    const wrongCandidate = structuredClone(backup);
    const savedMerge = wrongCandidate.mergeDecisions[0]!;
    assert.equal(savedMerge.kind, "merge");
    if (savedMerge.kind === "merge") savedMerge.candidate.rightJobId = savedMerge.candidate.leftJobId;
    await assert.rejects(restored.restore(wrongCandidate, options("invalid-decision-candidate", 0)), errorCode("invalid-backup"));
    const missingCounter = structuredClone(backup); missingCounter.jobVersions.pop();
    await assert.rejects(restored.restore(missingCounter, options("missing-revision-counter", 0)), errorCode("invalid-backup"));
    assert.equal((await restored.readSnapshot()).jobs.length, 0);
    await restored.restore(backup, options("restore-v2", 0));
    assert.equal((await restored.readSnapshot()).jobs.length, 1); assert.equal((await restored.resolveJobId(b!.jobId))!.canonicalJobId, a!.jobId);
    const revision = (await restored.readSnapshot()).revision;
    await restored.revokeMerge({ decisionId: merge.decision.id, reason: "备份恢复后拆回" }, options("split-restored", revision));
    assert.equal((await restored.readSnapshot()).jobs.length, 2);
    await restored.restore(legacy, options("restore-v1", (await restored.readSnapshot()).revision));
    assert.equal((await restored.readSnapshot()).jobs.length, 2); assert.equal((await restored.listMergeDecisions()).length, 0);
  } finally { restored.close(); }
}));

test("an actual persisted schema-v1 database migrates to v3 without changing original evidence or identities", async () => withRepository(async (repo, path, data) => {
  const original = await repo.readSnapshot(); repo.close(); const legacy = new DatabaseSync(path);
  try {
    legacy.exec("DROP TRIGGER compensation_decisions_no_update; DROP TRIGGER compensation_decisions_no_delete; DROP TABLE compensation_decisions; DROP TABLE base_compensations; DROP TRIGGER office_decisions_no_update; DROP TRIGGER office_decisions_no_delete; DROP TABLE office_decisions; DROP TRIGGER location_decisions_no_update; DROP TRIGGER location_decisions_no_delete; DROP TABLE location_decisions; DROP TABLE base_locations; DROP TRIGGER merge_decisions_no_update; DROP TRIGGER merge_decisions_no_delete; DROP TRIGGER job_alias_history_no_update; DROP TRIGGER job_alias_history_no_delete; DROP TABLE merge_decisions; DROP TABLE job_aliases; DROP TABLE job_alias_history; DROP TABLE base_jobs; DROP TABLE job_versions; PRAGMA user_version=1;");
    assert.equal((legacy.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 1);
  } finally { legacy.close(); }
  const upgraded = openJobRepository(path, { now: () => AT });
  try {
    assert.deepEqual(await upgraded.readSnapshot(), original); assert.deepEqual(await upgraded.readProjectionSnapshot(), original);
    const check = new DatabaseSync(path);
    try { assert.equal((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 5); } finally { check.close(); }
    for (const id of data.ids) assert.equal((await upgraded.resolveJobId(id.jobId))!.canonicalJobId, id.jobId);
    await upgraded.mergeJobs({ targetJobId: data.ids[0]!.jobId, sourceJobId: data.ids[1]!.jobId, reason: "升级后继续人工确认", companyIdentityConfirmed: true }, options("after-upgrade", original.revision));
    assert.equal((await upgraded.readSnapshot()).jobs.length, 1);
  } finally { upgraded.close(); }
}));
