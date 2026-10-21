import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { queryJobs, type AtlasDataset, type CompensationReviewProposal, type PreviewCompensationReviewInput, type SourceDefinition, type TrustedToolContext } from "@better-me/opportunities";
import type { SourceJobRecord } from "@better-me/source-adapters";
import { createJobApplication } from "../src/application.js";
import { createJobHttpServer } from "../src/http.js";
import { openJobRepository, RepositoryError, type JobRepository } from "../src/repository.js";
import { projectSourcePage } from "../src/projection.js";

const AT = "2026-10-21T00:00:00.000Z";
const LATER = "2026-10-22T00:00:00.000Z";
const DISCLOSURE = "固定工资：税前月薪人民币 15000-30000 元。每年保证发放13个月工资。";
const DISCLOSURE_B = "固定工资：税前月薪人民币 16000-32000 元。每年保证发放13个月工资。";
const opts = (idempotencyKey: string, expectedRevision: number, actorScope = "owner") => ({ actorScope, idempotencyKey, expectedRevision });
const code = (value: string) => (error: unknown) => error instanceof RepositoryError && error.code === value;
const source: SourceDefinition = { sourceId: "salary-source", name: "Synthetic salary source", adapterId: "synthetic", adapterVersion: "1", capabilities: ["list-jobs"], runtime: ["local-service"], entityType: "job-posting", enabled: true, status: "active", remoteFilters: [], endpointPolicy: { allowedHosts: ["careers.example.test"], allowedPathPrefixes: ["/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 }, attribution: { label: "Synthetic", usage: "metadata", requiresAttribution: true }, refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 10, maxPages: 1, requestsPerMinute: 30 } };
function record(id = "42", changed = false): SourceJobRecord {
  return { entityType: "job-posting", sourceRecordId: id, url: `https://careers.example.test/jobs/${id}`, title: "Synthetic backend engineer", companyName: "Synthetic employer", description: changed ? DISCLOSURE_B : DISCLOSURE,
    locations: [{ raw: "Shanghai, China", countryCode: "CN", city: "Shanghai" }], compensations: [{ raw: changed ? DISCLOSURE_B : DISCLOSURE, currency: "CNY", min: changed ? 16000 : 15000, max: changed ? 32000 : 30000, period: "month", tax: "unknown", kind: "unknown" }],
    workMode: "on-site", employmentType: "unknown", remoteEligibleRegions: [], availability: "unknown", completeness: "detail", sourcePublishedAt: "2026-10-01T00:00:00.000Z", evidence: [], warnings: [] };
}
async function ingest(repo: JobRepository, key: string, records = [record()]) {
  const before = await repo.readProjectionSnapshot();
  const projection = await projectSourcePage(before, source, { records, observedAt: AT, coverage: { complete: true, partial: false, fetchedRecords: records.length, appliedFilters: [], ignoredFilters: [] }, warnings: [] }, key);
  return repo.importSnapshot(projection.delta, opts(key, before.revision));
}
function input(data: AtlasDataset, salaryId = data.jobs[0]!.compensationIds[0]!): PreviewCompensationReviewInput {
  const compensation = data.compensations.find(value => value.id === salaryId)!, job = data.jobs.find(value => value.compensationIds.includes(salaryId))!;
  const ref = compensation.evidence[0]!, snapshot = data.snapshots.find(value => value.observationId === ref.observationId)!;
  const proposal: CompensationReviewProposal = { basis: "manual-evidence-review", min: compensation.min, max: compensation.max, currency: "CNY", period: "month", tax: "gross", kind: "base", monthsPerYear: 13,
    supports: (["min", "max", "currency", "period", "tax", "kind", "monthsPerYear"] as const).map(field => ({ field, reference: { ...ref, quote: snapshot.text }, snapshotId: snapshot.id })) };
  return { jobId: job.id, compensationId: salaryId, expectedRevision: data.revision, proposal, reason: "Synthetic reviewed retained salary disclosure" };
}
async function command(repo: JobRepository, specified?: PreviewCompensationReviewInput) {
  const value = specified ?? input(await repo.readProjectionSnapshot());
  return { ...value, previewFingerprint: (await repo.previewCompensationReview(value)).previewFingerprint, reviewed: true as const };
}
async function confirm(repo: JobRepository, key = "confirm", value?: PreviewCompensationReviewInput) {
  const checked = await command(repo, value);
  return repo.confirmCompensationReview(checked, opts(key, checked.expectedRevision));
}
async function fixture(work: (repo: JobRepository, path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "better-me-salary-test-")), path = join(dir, "jobs.sqlite"), repo = openJobRepository(path, { now: () => LATER });
  try { await ingest(repo, "seed"); await work(repo, path); } finally { repo.close(); await rm(dir, { recursive: true, force: true }); }
}

test("salary preview/read are read-only; confirmed effective pay changes actual query without editing source facts", async () => fixture(async repo => {
  const before = await repo.backup(), value = input(before.dataset), preview = await repo.previewCompensationReview(value);
  const reading = await repo.readCompensationReview({ jobId: value.jobId, compensationId: value.compensationId, expectedRevision: value.expectedRevision });
  assert.deepEqual(reading.current, reading.sourceCompensation); assert.deepEqual(reading.history, []); assert.deepEqual(await repo.backup(), before);
  assert.equal(preview.proposed.tax, "gross"); assert.equal(preview.proposed.kind, "base"); assert.equal(preview.proposed.verification, "unverified");
  assert.equal((await queryJobs(before.dataset, { salary: { range: { min: 190000 }, includeUnknown: false } })).totalJobs, 0);
  const saved = await confirm(repo), after = await repo.backup();
  assert.equal(saved.revision, value.expectedRevision + 1); assert.equal(saved.activeDecisionId, saved.decisionId);
  assert.equal((await queryJobs(after.dataset, { salary: { range: { min: 190000 }, includeUnknown: false } })).totalJobs, 1);
  assert.deepEqual(after.baseCompensations, before.baseCompensations); assert.deepEqual(after.baseJobs, before.baseJobs);
  for (const table of ["locations", "observations", "snapshots", "listings", "companies", "sources"] as const) assert.deepEqual(after.dataset[table], before.dataset[table]);
  assert.equal(saved.compensation.raw, before.dataset.compensations[0]!.raw); assert.equal(after.dataset.jobs[0]!.description, before.dataset.jobs[0]!.description);
  assert.equal(after.dataset.jobs[0]!.selectedSnapshotId, before.dataset.jobs[0]!.selectedSnapshotId); assert.ok(after.dataset.jobs[0]!.revision > before.dataset.jobs[0]!.revision);
  const current = await repo.readCompensationReview({ jobId: value.jobId, compensationId: value.compensationId, expectedRevision: saved.revision });
  assert.equal(current.activeDecisionId, saved.decisionId); assert.equal(current.history.length, 1);
  await assert.rejects(repo.importSnapshot(after.dataset, opts("reject-projection-as-source", after.dataset.revision)), code("conflict"));
}));

test("restart and identical confirm/revoke retries recover exact durable receipts; actor/key conflicts cannot overwrite", async () => fixture(async (repo, path) => {
  const value = await command(repo), saved = await repo.confirmCompensationReview(value, opts("stable-confirm", value.expectedRevision));
  const reopened = openJobRepository(path, { now: () => LATER });
  try {
    assert.deepEqual(await reopened.confirmCompensationReview(value, opts("stable-confirm", value.expectedRevision)), saved);
    assert.deepEqual(await reopened.findCompensationReviewReceipt("compensations.confirm-review", value, opts("stable-confirm", value.expectedRevision)), saved);
    await assert.rejects(reopened.confirmCompensationReview({ ...value, reason: "Different command" }, opts("stable-confirm", value.expectedRevision)), code("idempotency-conflict"));
    const revoke = { jobId: value.jobId, compensationId: value.compensationId, expectedRevision: saved.revision, decisionId: saved.decisionId, reason: "Undo synthetic salary review", reviewed: true as const };
    await assert.rejects(reopened.revokeCompensationReview(revoke, opts("foreign", saved.revision, "another-owner")), code("not-authorized"));
    const undone = await reopened.revokeCompensationReview(revoke, opts("stable-revoke", saved.revision));
    assert.equal(undone.activeDecisionId, undefined); assert.equal(undone.compensation.tax, "unknown");
    assert.deepEqual(await reopened.revokeCompensationReview(revoke, opts("stable-revoke", saved.revision)), undone);
    await assert.rejects(reopened.revokeCompensationReview({ ...revoke, expectedRevision: undone.revision }, opts("repeat-revoke", undone.revision)), code("conflict"));
    assert.equal((await reopened.backup()).compensationDecisions.length, 2);
    const db = new DatabaseSync(path); try { assert.throws(() => db.exec("DELETE FROM compensation_decisions"), /immutable-compensation-decision/); assert.throws(() => db.exec("UPDATE compensation_decisions SET document=document"), /immutable-compensation-decision/); } finally { db.close(); }
  } finally { reopened.close(); }
}));

test("salary sources A to B to A cannot revive an old confirmation; sparse refresh preserves active review", async () => fixture(async repo => {
  const saved = await confirm(repo), originalCompensationId = saved.compensationId;
  const sparse = record(); sparse.compensations = [];
  await ingest(repo, "sparse", [sparse]); assert.equal((await repo.readSnapshot()).compensations.find(value => value.id === originalCompensationId)!.tax, "gross");
  const changed = await ingest(repo, "source-b", [record("42", true)]), middle = await repo.backup();
  assert.notEqual(middle.dataset.jobs[0]!.compensationIds[0], originalCompensationId);
  const invalidation = middle.compensationDecisions.find(value => value.kind === "invalidate")!;
  assert.equal(invalidation.revision, changed.revision); if (invalidation.kind === "invalidate") assert.deepEqual(invalidation.targetDecisionIds, [saved.decisionId]);
  await ingest(repo, "source-a-again"); const after = await repo.readSnapshot();
  assert.equal(after.jobs[0]!.compensationIds[0], originalCompensationId); assert.equal(after.compensations.find(value => value.id === originalCompensationId)!.tax, "unknown");
  const target = openJobRepository(":memory:", { now: () => LATER });
  try { await target.restore(await repo.backup(), opts("restore-source-return", 0)); assert.equal((await target.readSnapshot()).compensations.find(value => value.id === originalCompensationId)!.tax, "unknown"); }
  finally { target.close(); }
  const fresh = await confirm(repo, "review-a-again"); assert.notEqual(fresh.decisionId, saved.decisionId);
}));

test("two reviewed salaries can revoke to preceding valid review and restore every historical receipt", async () => fixture(async repo => {
  const first = await confirm(repo, "first"), next = input(await repo.readProjectionSnapshot());
  next.proposal.monthsPerYear = undefined; next.proposal.supports = next.proposal.supports.filter(value => value.field !== "monthsPerYear");
  const second = await confirm(repo, "second", next);
  const undone = await repo.revokeCompensationReview({ jobId: next.jobId, compensationId: next.compensationId, expectedRevision: second.revision, decisionId: second.decisionId, reason: "Restore earlier salary reading", reviewed: true }, opts("undo-second", second.revision));
  assert.equal(undone.activeDecisionId, first.decisionId); assert.equal(undone.compensation.monthsPerYear, 13);
  await ingest(repo, "later-source", [record("42", true)]);
  const target = openJobRepository(":memory:", { now: () => LATER });
  try { await target.restore(await repo.backup(), opts("restore-history", 0)); assert.equal((await target.backup()).compensationDecisions.length, 4); } finally { target.close(); }
}));

test("changed source URLs permanently invalidate salary review and historical revoke receipts restore against their original listing identity", async () => fixture(async repo => {
  const first = await confirm(repo, "url-first"), second = await confirm(repo, "url-second");
  const before = await repo.readSnapshot();
  const undone = await repo.revokeCompensationReview({ jobId: before.jobs[0]!.id, compensationId: first.compensationId, expectedRevision: second.revision, decisionId: second.decisionId, reason: "Restore first salary before source URL changes", reviewed: true }, opts("url-undo-second", second.revision));
  assert.equal(undone.activeDecisionId, first.decisionId);
  const changed = record(); changed.url = "https://careers.example.test/new-jobs/42";
  await ingest(repo, "url-b", [changed]); let data = await repo.readSnapshot(); assert.equal(data.compensations[0]!.tax, "unknown");
  const revoked = await repo.revokeCompensationReview({ jobId: data.jobs[0]!.id, compensationId: first.compensationId, expectedRevision: data.revision, decisionId: first.decisionId, reason: "Explicitly revoke an already source-invalidated historical review", reviewed: true }, opts("url-undo-invalidated", data.revision));
  assert.equal(revoked.activeDecisionId, undefined);
  await ingest(repo, "url-a-again"); data = await repo.readSnapshot(); assert.equal(data.compensations[0]!.tax, "unknown");
  const target = openJobRepository(":memory:", { now: () => LATER });
  try { await target.restore(await repo.backup(), opts("restore-urls", 0)); assert.deepEqual((await target.readSnapshot()).compensations, data.compensations); } finally { target.close(); }
}));

test("one source refresh invalidates multiple salaries and office points under one revision, with scoped read history", async () => fixture(async repo => {
  await ingest(repo, "second-salary", [record("43")]);
  const firstInput = input(await repo.readProjectionSnapshot()); const first = await confirm(repo, "review-one", firstInput);
  const data = await repo.readProjectionSnapshot(), secondId = data.jobs.find(job => job.id !== firstInput.jobId)!.compensationIds[0]!;
  const second = await confirm(repo, "review-two", input(data, secondId));
  const withSalary = await repo.readSnapshot(), locationId = withSalary.jobs.find(job => job.id === firstInput.jobId)!.locationIds[0]!;
  const officeInput = { jobId: firstInput.jobId, locationId, expectedRevision: second.revision, reason: "Synthetic address and coordinates", proposal: { basis: "manual-user-confirmation" as const, countryCode: "CN", formattedAddress: "Shanghai Example Road 123", streetAddress: "Example Road 123", coordinates: { latitude: 31.2, longitude: 121.5, coordinateSystem: "WGS84" as const }, evidenceUrl: "https://careers.example.test/jobs/42", coordinateMeaning: "building" as const } };
  const office = await repo.confirmOfficeAddress({ ...officeInput, reviewed: true, previewFingerprint: (await repo.previewOfficeConfirmation(officeInput)).previewFingerprint }, opts("office", second.revision));
  const changedOne = record("42", true); changedOne.locations[0] = { raw: "Beijing, China", countryCode: "CN", city: "Beijing" };
  const changed = await ingest(repo, "salary-office-change", [changedOne, record("43", true)]), backup = await repo.backup();
  const compensationInvalidation = backup.compensationDecisions.find(entry => entry.kind === "invalidate")!, officeInvalidation = backup.officeDecisions.find(entry => entry.kind === "invalidate")!;
  assert.equal(officeInvalidation.revision, changed.revision); assert.equal(compensationInvalidation.revision, changed.revision); assert.equal(backup.dataset.revision, office.revision + 1);
  if (compensationInvalidation.kind === "invalidate") assert.deepEqual(compensationInvalidation.targetDecisionIds, [first.decisionId, second.decisionId]);
  await ingest(repo, "salary-office-return", [record("42"), record("43")]);
  const restoredData = await repo.readSnapshot(), read = await repo.readCompensationReview({ jobId: firstInput.jobId, compensationId: first.compensationId, expectedRevision: restoredData.revision });
  const scoped = read.history.find(entry => entry.kind === "invalidate"); if (scoped?.kind === "invalidate") assert.deepEqual(scoped.targetDecisionIds, [first.decisionId]); else assert.fail("Expected scoped invalidation history");
  const target = openJobRepository(":memory:", { now: () => LATER }); try { await target.restore(await repo.backup(), opts("restore-combined", 0)); } finally { target.close(); }
}));

test("location-scoped salary review retains exactly its disclosed office scope through preview/save/revoke", async () => fixture(async repo => {
  const seed = await repo.readProjectionSnapshot(), salary = seed.compensations[0]!, own = seed.jobs[0]!;
  salary.locationIds = [...own.locationIds];
  const target = openJobRepository(":memory:", { now: () => LATER });
  try {
    await target.importSnapshot(seed, opts("scoped-seed", 0)); const value = input(await target.readProjectionSnapshot()), preview = await target.previewCompensationReview(value);
    assert.deepEqual(preview.proposed.locationIds, salary.locationIds); const saved = await confirm(target); assert.deepEqual(saved.compensation.locationIds, salary.locationIds);
    const undone = await target.revokeCompensationReview({ jobId: value.jobId, compensationId: value.compensationId, expectedRevision: saved.revision, decisionId: saved.decisionId, reason: "Undo scoped salary", reviewed: true }, opts("scoped-revoke", saved.revision));
    assert.deepEqual(undone.compensation.locationIds, salary.locationIds);
  } finally { target.close(); }
}));

test("legacy salaries without listing contribution arrays bind only through a unique retained evidence owner", async () => fixture(async repo => {
  const seed = await repo.readProjectionSnapshot(); delete seed.listings[0]!.compensationIds;
  const target = openJobRepository(":memory:", { now: () => LATER });
  try {
    await target.importSnapshot(seed, opts("legacy-salary", 0)); const saved = await confirm(target); assert.equal(saved.compensation.tax, "gross");
    const backup = await target.backup(), restored = openJobRepository(":memory:", { now: () => LATER });
    try { await restored.restore(backup, opts("restore-legacy-salary", 0)); assert.deepEqual((await restored.readSnapshot()).compensations, backup.dataset.compensations); } finally { restored.close(); }
  } finally { target.close(); }
  const missing = structuredClone(seed); missing.compensations[0]!.evidence = [];
  const rejected = openJobRepository(":memory:", { now: () => LATER });
  try { await rejected.importSnapshot(missing, opts("legacy-missing-evidence", 0)); await assert.rejects(rejected.previewCompensationReview(input(await repo.readProjectionSnapshot())), code("conflict")); } finally { rejected.close(); }
}));

test("salary confirmation survives canonical merge/split and source alias refresh", async () => fixture(async repo => {
  await ingest(repo, "second-job", [record("43")]); let data = await repo.readSnapshot();
  const origin = data.jobs.find(job => data.listings.find(listing => listing.sourceRecordId === "42")!.canonicalJobId === job.id)!, other = data.jobs.find(job => job.id !== origin.id)!;
  const originalInput = input(data, origin.compensationIds[0]!); const saved = await confirm(repo, "confirm-before-merge", originalInput);
  const merged = await repo.mergeJobs({ targetJobId: other.id, sourceJobId: origin.id, reason: "Synthetic reviewed shared vacancy", companyIdentityConfirmed: true }, opts("merge", saved.revision));
  const reading = await repo.readCompensationReview({ jobId: origin.id, compensationId: saved.compensationId, expectedRevision: merged.revision }); assert.equal(reading.activeDecisionId, saved.decisionId);
  const afterRefresh = await ingest(repo, "refresh-alias", [record("42")]);
  data = await repo.readSnapshot(); assert.equal(data.jobs.length, 1); assert.equal(data.compensations.find(value => value.id === saved.compensationId)!.tax, "gross");
  const split = await repo.revokeMerge({ decisionId: merged.decision.id, reason: "Undo synthetic merge" }, opts("split", afterRefresh.revision));
  const undone = await repo.revokeCompensationReview({ jobId: origin.id, compensationId: saved.compensationId, expectedRevision: split.revision, decisionId: saved.decisionId, reason: "Undo original salary review", reviewed: true }, opts("undo-after-split", split.revision));
  assert.equal(undone.compensation.tax, "unknown"); assert.equal((await repo.readSnapshot()).jobs.length, 2);
  const target = openJobRepository(":memory:", { now: () => LATER }); try { await target.restore(await repo.backup(), opts("restore-alias", 0)); } finally { target.close(); }
}));

test("v4 databases and v1-v4 backups upgrade source salary without changing content or revision", async () => fixture(async (repo, path) => {
  const before = await repo.readSnapshot(); repo.close();
  const db = new DatabaseSync(path); try { db.exec("DROP TRIGGER fx_snapshots_no_update; DROP TRIGGER fx_snapshots_no_delete; DROP TRIGGER fx_activations_no_update; DROP TRIGGER fx_activations_no_delete; DROP TABLE fx_activations; DROP TABLE fx_snapshots; DROP TRIGGER compensation_decisions_no_update; DROP TRIGGER compensation_decisions_no_delete; DROP TABLE compensation_decisions; DROP TABLE base_compensations; PRAGMA user_version=4;"); } finally { db.close(); }
  const upgraded = openJobRepository(path, { now: () => LATER });
  try {
    assert.deepEqual(await upgraded.readSnapshot(), before); const backup = await upgraded.backup(); assert.equal(backup.schemaVersion, 6); assert.deepEqual(backup.baseCompensations, before.compensations);
    for (const version of [1, 2, 3, 4] as const) {
      const { baseCompensations: _baseCompensations, compensationDecisions: _compensationDecisions, ...legacy } = structuredClone(backup);
      const old: Record<string, unknown> = { ...legacy, schemaVersion: version };
      if (version < 2) for (const field of ["baseJobs", "mergeDecisions", "aliasHistory", "jobVersions"]) delete old[field];
      if (version < 3) for (const field of ["baseLocations", "locationDecisions"]) delete old[field];
      if (version < 4) delete old.officeDecisions;
      const target = openJobRepository(":memory:", { now: () => LATER });
      try { await target.restore(old, opts(`restore-v${version}`, 0)); assert.deepEqual((await target.readProjectionSnapshot()).compensations, before.compensations); await confirm(target, `review-v${version}`); }
      finally { target.close(); }
    }
    await confirm(upgraded);
  } finally { upgraded.close(); }
}));

test("forged preview/evidence, stale version and changed same-id source salary leave base/history/receipts intact", async () => fixture(async repo => {
  const value = input(await repo.readSnapshot()), before = await repo.backup(), cmd = await command(repo, value);
  await assert.rejects(repo.confirmCompensationReview({ ...cmd, previewFingerprint: "0".repeat(64) }, opts("bad-fingerprint", value.expectedRevision)), code("stale-version"));
  await assert.rejects(repo.confirmCompensationReview({ ...cmd, reviewed: false } as never, opts("unreviewed", value.expectedRevision)), code("invalid-data"));
  await assert.rejects(repo.previewCompensationReview({ ...value, expectedRevision: value.expectedRevision - 1 }), code("stale-version"));
  const forged = structuredClone(value); forged.proposal.supports[0]!.reference.quote = "The salary is invented at CNY 15000-30000";
  await assert.rejects(repo.previewCompensationReview(forged), code("invalid-data"));
  const sameId = await repo.readProjectionSnapshot(); sameId.compensations[0]!.min = 1;
  await assert.rejects(repo.importSnapshot(sameId, opts("changed-same-id", sameId.revision)), code("conflict"));
  assert.deepEqual(await repo.backup(), before);
}));

test("a failed receipt insertion rolls back decisions/effective indices and permits the exact confirmed retry", async () => fixture(async (repo, path) => {
  const before = await repo.backup(), cmd = await command(repo), db = new DatabaseSync(path);
  try {
    db.exec("CREATE TRIGGER synthetic_salary_receipt_failure BEFORE INSERT ON receipts WHEN NEW.tool='compensations.confirm-review' BEGIN SELECT RAISE(ABORT,'synthetic-failure'); END;");
    await assert.rejects(repo.confirmCompensationReview(cmd, opts("retry", cmd.expectedRevision)), code("storage-error")); assert.deepEqual(await repo.backup(), before);
    db.exec("DROP TRIGGER synthetic_salary_receipt_failure;"); await repo.confirmCompensationReview(cmd, opts("retry", cmd.expectedRevision));
  } finally { db.close(); }
}));

test("backup validation rejects modified salary projection, decision source, receipt body and unrelated receipt job atomically", async () => fixture(async repo => {
  await ingest(repo, "other", [record("43")]); const saved = await confirm(repo), before = await repo.backup();
  const variants = [structuredClone(before), structuredClone(before), structuredClone(before), structuredClone(before)];
  variants[0]!.dataset.compensations.find(value => value.id === saved.compensationId)!.tax = "net";
  const decision = variants[1]!.compensationDecisions[0]!; if (decision.kind === "confirm") decision.sourceCompensation.raw = "tampered source";
  const receipt = variants[2]!.receipts.find(value => value.tool === "compensations.confirm-review")!; if ("compensation" in receipt.response) receipt.response.compensation.min = 1;
  const unrelated = variants[3]!.receipts.find(value => value.tool === "compensations.confirm-review")!; if ("jobId" in unrelated.response) unrelated.response.jobId = before.dataset.jobs.find(value => !value.compensationIds.includes(saved.compensationId))!.id;
  for (const [index, bad] of variants.entries()) { await assert.rejects(repo.restore(bad, opts(`bad-${index}`, before.dataset.revision)), code("invalid-backup")); assert.deepEqual(await repo.backup(), before); }
}));

test("invalidated review archives cannot contradict retained immutable material or invent a false content hash", async () => fixture(async repo => {
  await confirm(repo, "archive-confirm"); const changed = record(); changed.url = "https://careers.example.test/new-jobs/42"; await ingest(repo, "archive-url-change", [changed]);
  const before = await repo.backup(); assert.equal(before.compensationDecisions.at(-1)!.kind, "invalidate");
  const target = openJobRepository(":memory:", { now: () => LATER });
  try {
    // The genuine historical URL differs from the current listing and remains restorable.
    await target.restore(before, opts("genuine-archive", 0)); const targetBefore = await target.backup();
    const variants = [structuredClone(before), structuredClone(before), structuredClone(before), structuredClone(before)];
    const observationChange = variants[0]!.compensationDecisions.find(entry => entry.kind === "confirm")!;
    if (observationChange.kind === "confirm") observationChange.sourceBinding.observations[0]!.rawText = (observationChange.sourceBinding.observations[0]!.rawText ?? "") + " Forged source context.";
    const snapshotChange = variants[1]!.compensationDecisions.find(entry => entry.kind === "confirm")!;
    if (snapshotChange.kind === "confirm") snapshotChange.sourceBinding.snapshots[0]!.sourceUrl = "https://careers.example.test/forged-attribution";
    const hashChange = variants[2]!.compensationDecisions.find(entry => entry.kind === "confirm")!;
    if (hashChange.kind === "confirm") {
      // A retained row and archive changing together still must satisfy the actual SHA256.
      const archived = hashChange.sourceBinding.snapshots[0]!; archived.contentHash = "0".repeat(64);
      variants[2]!.dataset.snapshots.find(snapshot => snapshot.id === archived.id)!.contentHash = archived.contentHash;
      const observation = hashChange.sourceBinding.observations.find(value => value.snapshotId === archived.id)!; observation.contentHash = archived.contentHash;
      variants[2]!.dataset.observations.find(value => value.id === observation.id)!.contentHash = archived.contentHash;
    }
    const detachedHashChange = variants[3]!.compensationDecisions.find(entry => entry.kind === "confirm")!;
    if (detachedHashChange.kind === "confirm") {
      const archived = structuredClone(detachedHashChange.sourceBinding.snapshots[0]!); archived.id = "archive-only-snapshot"; archived.observationId = "archive-only-observation"; archived.contentHash = "0".repeat(64);
      const observation = structuredClone(detachedHashChange.sourceBinding.observations[0]!); observation.id = archived.observationId; observation.snapshotId = archived.id; observation.contentHash = archived.contentHash;
      detachedHashChange.sourceBinding.snapshots.push(archived); detachedHashChange.sourceBinding.observations.push(observation);
    }
    for (const [index, bad] of variants.entries()) {
      await assert.rejects(target.restore(bad, opts(`forged-archive-${index}`, targetBefore.dataset.revision)), code("invalid-backup"));
      assert.deepEqual(await target.backup(), targetBefore);
    }
  } finally { target.close(); }
}));

test("interrupted confirm and revoke tools recover committed receipts without rerunning writes; effects are enforced", async () => fixture(async repo => {
  let confirmations = 0, revocations = 0;
  const wrapped: JobRepository = { ...repo, confirmCompensationReview: async (...args) => { confirmations++; await repo.confirmCompensationReview(...args); throw new Error("Synthetic lost confirmation response"); },
    revokeCompensationReview: async (...args) => { revocations++; await repo.revokeCompensationReview(...args); throw new Error("Synthetic lost revocation response"); } };
  const app = createJobApplication({ repository: wrapped, now: () => LATER }), cmd = await command(repo);
  const context: TrustedToolContext = { requestId: "salary-tools", actorScope: "owner", idempotencyKey: "recover-confirm", signal: new AbortController().signal, allowedEffects: ["read-index", "local-write"], budget: { requests: 0, bytes: 1000000, timeoutMs: 5000 } };
  try {
    const denied = await app.registry.execute("compensations.confirm-review", cmd, { ...context, idempotencyKey: "denied", allowedEffects: ["read-index"] }); assert.equal(denied.ok, false); assert.equal(confirmations, 0);
    assert.equal((await app.registry.execute("compensations.confirm-review", cmd, context)).ok, false);
    const recovered = await app.registry.execute("compensations.confirm-review", cmd, context); assert.equal(recovered.ok, true); assert.equal(confirmations, 1);
    const history = await repo.backup(), first = history.compensationDecisions[0]!;
    const revoke = { jobId: cmd.jobId, compensationId: cmd.compensationId, expectedRevision: history.dataset.revision, decisionId: first.id, reason: "Undo lost-response salary review", reviewed: true };
    const revokeContext = { ...context, idempotencyKey: "recover-revoke" };
    assert.equal((await app.registry.execute("compensations.revoke-review", revoke, revokeContext)).ok, false);
    assert.equal((await app.registry.execute("compensations.revoke-review", revoke, revokeContext)).ok, true); assert.equal(revocations, 1); assert.equal((await repo.backup()).compensationDecisions.length, 2);
  } finally { await app.shutdown(); }
}));

test("all salary HTTP endpoints share auth/tool contracts and confirm/revoke require durable idempotency keys", async () => fixture(async repo => {
  const app = createJobApplication({ repository: repo, now: () => LATER }), token = "synthetic-salary-token-only-1234567890", server = createJobHttpServer({ registry: app.registry, token, allowedOrigins: ["http://localhost:5173"], port: 0 });
  const { url } = await server.listen(), value = input(await repo.readSnapshot()), headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const read = { jobId: value.jobId, compensationId: value.compensationId, expectedRevision: value.expectedRevision };
  const post = (path: string, body: unknown, key?: string) => fetch(`${url}/api/v1/compensations/${path}`, { method: "POST", headers: { ...headers, ...(key ? { "Idempotency-Key": key } : {}) }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(`${url}/api/v1/compensations/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(read) })).status, 401);
    assert.equal((await post("review", read)).status, 200);
    const previewResponse = await post("preview", value); assert.equal(previewResponse.status, 200); const preview = (await previewResponse.json() as { value: { previewFingerprint: string } }).value;
    const cmd = { ...value, previewFingerprint: preview.previewFingerprint, reviewed: true };
    assert.equal((await post("confirm", cmd)).status, 400);
    const saved = await post("confirm", cmd, "http-confirm"); assert.equal(saved.status, 200); const receipt = (await saved.json() as { value: { decisionId: string; revision: number } }).value;
    assert.equal((await post("confirm", cmd, "http-confirm")).status, 200);
    assert.equal((await post("review", { ...read, expectedRevision: receipt.revision })).status, 200);
    const revoke = { ...read, expectedRevision: receipt.revision, decisionId: receipt.decisionId, reason: "Undo HTTP salary review", reviewed: true };
    assert.equal((await post("revoke", revoke)).status, 400); assert.equal((await post("revoke", revoke, "http-revoke")).status, 200);
  } finally { await server.close(); await app.shutdown(); }
}));
