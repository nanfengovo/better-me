import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { queryJobs, type SourceDefinition, type PreviewLocationConfirmationInput, type ConfirmLocationInput, type AtlasDataset, type TrustedToolContext } from "@better-me/opportunities";
import type { SourceJobRecord } from "@better-me/source-adapters";
import { openJobRepository, RepositoryError, type JobRepository } from "../src/repository.js";
import { projectSourcePage } from "../src/projection.js";
import { createJobApplication } from "../src/application.js";

const AT = "2026-10-19T00:00:00.000Z", LATER = "2026-10-20T00:00:00.000Z";
const options = (idempotencyKey: string, expectedRevision: number) => ({ actorScope: "local-owner", idempotencyKey, expectedRevision });
const code = (value: string) => (error: unknown) => error instanceof RepositoryError && error.code === value;
function source(suffix: string): SourceDefinition { return { sourceId: `location-source-${suffix}`, name: `Synthetic ${suffix}`, adapterId: "synthetic", adapterVersion: "1", capabilities: ["list-jobs"], runtime: ["local-service"], entityType: "job-posting", enabled: true, status: "active", remoteFilters: [], endpointPolicy: { allowedHosts: ["careers.example.test"], allowedPathPrefixes: ["/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 }, attribution: { label: suffix, usage: "metadata", requiresAttribution: true }, refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 100, maxPages: 1, requestsPerMinute: 30 } }; }
function record(suffix: string, raw = "上海-浦东新区"): SourceJobRecord { return { entityType: "job-posting", sourceRecordId: "42", url: `https://careers.example.test/${suffix}/jobs/42`, applicationUrl: "https://careers.example.test/jobs/R123456", title: "Synthetic C# engineer", companyName: "Synthetic employer", description: "Synthetic original full JD", locations: [{ raw }], compensations: [], workMode: "unknown", employmentType: "unknown", remoteEligibleRegions: [], availability: "unknown", completeness: "detail", evidence: [], warnings: [] }; }
async function ingest(repo: JobRepository, suffix: string, raw: string, run: string, at = AT) {
  const before = await repo.readProjectionSnapshot(); const projected = await projectSourcePage(before, source(suffix), { records: [record(suffix, raw)], observedAt: at, coverage: { complete: true, partial: false, fetchedRecords: 1, appliedFilters: [], ignoredFilters: [] }, warnings: [] }, run);
  for (const location of projected.delta.locations) location.kind = "unknown";
  return repo.importSnapshot(projected.delta, options(run, before.revision));
}
function input(data: AtlasDataset, index = 0): PreviewLocationConfirmationInput { const job = data.jobs[index]!; return { jobId: job.id, locationId: job.locationIds[0]!, expectedRevision: data.revision, proposal: { locationKind: "office", countryCode: "CN", area: { kind: "china-catalog", provinceCode: "31", cityCode: "3101", districtCode: "310115" } }, reason: "Synthetic user checked original location" }; }
async function command(repo: JobRepository, value: PreviewLocationConfirmationInput): Promise<ConfirmLocationInput> { return { ...value, previewFingerprint: (await repo.previewLocationConfirmation(value)).previewFingerprint, reviewed: true }; }
async function fixture(work: (repo: JobRepository, path: string) => Promise<void>, two = false) { const dir = await mkdtemp(join(tmpdir(), "better-me-location-test-")); const path = join(dir, "jobs.sqlite"); const repo = openJobRepository(path, { now: () => AT }); try { await ingest(repo, "a", "上海-浦东新区", "seed-a"); if (two) await ingest(repo, "b", "上海", "seed-b"); await work(repo, path); } finally { repo.close(); await rm(dir, { recursive: true, force: true }); } }

test("area preview is read-only; confirmation filters a real source location while retaining raw evidence and unknown coordinates", async () => fixture(async repo => {
  const original = await repo.readSnapshot(), before = await repo.backup(); const value = input(original);
  const preview = await repo.previewLocationConfirmation(value);
  assert.deepEqual(await repo.backup(), before); assert.equal(preview.proposed.city, "上海市"); assert.equal(preview.proposed.district, "浦东新区"); assert.equal(preview.proposed.precision, "city"); assert.equal(preview.proposed.coordinates, undefined);
  const result = await repo.confirmLocation({ ...value, reviewed: true, previewFingerprint: preview.previewFingerprint }, options("confirm", original.revision));
  assert.equal(result.revision, original.revision + 1); assert.equal(result.activeDecisionId, result.decisionId);
  const after = await repo.readSnapshot(); assert.deepEqual(after.locations[0]!.evidence, original.locations[0]!.evidence); assert.equal(after.locations[0]!.raw, original.locations[0]!.raw); assert.equal(after.locations[0]!.verification, "unverified");
  assert.equal(after.jobs[0]!.revision, original.jobs[0]!.revision + 1); assert.equal(after.jobs[0]!.description, original.jobs[0]!.description);
  assert.deepEqual((await repo.readProjectionSnapshot()).locations, original.locations);
  assert.equal((await queryJobs(after, { market: "domestic", workCountryCodes: ["CN"], workRegionGroups: [["上海市"], ["浦东新区"]] })).totalJobs, 1);
  assert.equal((await queryJobs(after, { market: "domestic", workCountryCodes: ["CN"], workRegionGroups: [["北京市"]] })).totalJobs, 0);
  await assert.rejects(repo.importSnapshot(after, options("privileged-import", after.revision)), code("conflict"));
}));

test("same source refresh preserves confirmation; changed raw location gets a fresh unconfirmed identity", async () => fixture(async repo => {
  const first = await repo.readSnapshot(); const value = input(first); await repo.confirmLocation(await command(repo, value), options("confirm", first.revision));
  await ingest(repo, "a", "上海-浦东新区", "same-source", LATER); let data = await repo.readSnapshot(); assert.ok(data.locations.find(location => location.id === first.locations[0]!.id)!.userResolution); assert.equal(data.jobs[0]!.locationIds[0], first.locations[0]!.id);
  await ingest(repo, "a", "北京-海淀区", "changed-source", LATER); data = await repo.readSnapshot(); const current = data.locations.find(location => location.id === data.jobs[0]!.locationIds[0])!;
  assert.notEqual(current.id, first.locations[0]!.id); assert.equal(current.raw, "北京-海淀区"); assert.equal(current.userResolution, undefined); assert.equal(current.countryCode, undefined);
  assert.equal((await repo.backup()).locationDecisions.length, 1);
}));

test("durable replay checks original request before stale version and revoke restores prior selection then source", async () => fixture(async (repo, path) => {
  const first = await repo.readSnapshot(), value = input(first), confirm = await command(repo, value);
  const result = await repo.confirmLocation(confirm, options("first", first.revision));
  const secondInput = { ...value, expectedRevision: result.revision, proposal: { locationKind: "unknown" as const, countryCode: "DE", area: { kind: "manual-area" as const, region: "Berlin", city: "Berlin" } } };
  const second = await repo.confirmLocation(await command(repo, secondInput), options("second", result.revision));
  const reopened = openJobRepository(path, { now: () => LATER }); try {
    assert.deepEqual(await reopened.confirmLocation(confirm, options("first", first.revision)), result);
    await assert.rejects(reopened.confirmLocation({ ...confirm, reason: "different" }, options("first", first.revision)), code("idempotency-conflict"));
    const revoke = { jobId: value.jobId, locationId: value.locationId, decisionId: second.decisionId, expectedRevision: second.revision, reason: "Undo synthetic second selection", reviewed: true as const };
    const undone = await reopened.revokeLocationConfirmation(revoke, options("undo-second", second.revision)); assert.equal(undone.activeDecisionId, result.decisionId); assert.equal(undone.location.countryCode, "CN");
    assert.deepEqual(await reopened.revokeLocationConfirmation(revoke, options("undo-second", second.revision)), undone);
    const sourceAgain = await reopened.revokeLocationConfirmation({ ...revoke, decisionId: result.decisionId, expectedRevision: undone.revision }, options("undo-first", undone.revision)); assert.equal(sourceAgain.activeDecisionId, undefined); assert.deepEqual(sourceAgain.location, first.locations[0]);
    const inspector = new DatabaseSync(path); try { assert.throws(() => inspector.exec("DELETE FROM location_decisions"), /immutable-location-decision/); assert.throws(() => inspector.exec("UPDATE location_decisions SET document=document"), /immutable-location-decision/); } finally { inspector.close(); }
  } finally { reopened.close(); }
}));

test("confirmation and revoke survive canonical merge and split without moving the source contribution", async () => fixture(async repo => {
  const first = await repo.readSnapshot(); const a = first.jobs[0]!, b = first.jobs[1]!;
  const merged = await repo.mergeJobs({ targetJobId: a.id, sourceJobId: b.id, reason: "Synthetic same requisition", companyIdentityConfirmed: true }, options("merge", first.revision));
  const mergedData = await repo.readSnapshot(); const value = { ...input(mergedData), locationId: b.locationIds[0]! };
  const confirmed = await repo.confirmLocation(await command(repo, value), options("confirm-merged", merged.revision));
  const split = await repo.revokeMerge({ decisionId: merged.decision.id, reason: "Synthetic split" }, options("split", confirmed.revision));
  const data = await repo.readSnapshot(); assert.equal(data.jobs.length, 2); assert.equal(data.locations.find(location => location.id === b.locationIds[0])!.userResolution?.decisionId, confirmed.decisionId); assert.equal(data.locations.find(location => location.id === a.locationIds[0])!.userResolution, undefined);
  const revoked = await repo.revokeLocationConfirmation({ jobId: b.id, locationId: b.locationIds[0]!, decisionId: confirmed.decisionId, expectedRevision: split.revision, reason: "Synthetic revoke after split", reviewed: true }, options("revoke", split.revision)); assert.equal(revoked.location.userResolution, undefined);
  const backup = await repo.backup(), restored = openJobRepository(":memory:", { now: () => LATER }); try { await restored.restore(backup, options("restore-after-split", 0)); assert.deepEqual((await restored.readSnapshot()).locations, backup.dataset.locations); } finally { restored.close(); }
}, true));

test("v3 backup restores/replays sources, decisions and receipts; forged catalog/overlay/receipt backup is atomic rejection", async () => fixture(async repo => {
  const data = await repo.readSnapshot(); const confirm = await command(repo, input(data)); const saved = await repo.confirmLocation(confirm, options("confirm", data.revision)); const backup = await repo.backup();
  assert.equal(backup.schemaVersion, 8); assert.deepEqual(backup.baseLocations, data.locations); assert.equal(backup.locationDecisions.length, 1);
  for (const mutate of [
    (value: typeof backup) => { value.dataset.locations[0]!.raw = "forged"; },
    (value: typeof backup) => { const event = value.locationDecisions[0]!; if (event.kind === "confirm") event.area.city = "Paris"; },
    (value: typeof backup) => { value.receipts.find(receipt => receipt.tool === "locations.confirm")!.response = value.receipts[0]!.response; },
  ]) { const bad = structuredClone(backup); mutate(bad); await assert.rejects(repo.restore(bad, options(`bad-${JSON.stringify(bad).length}`, saved.revision)), code("invalid-backup")); assert.deepEqual(await repo.backup(), backup); }
  const restored = openJobRepository(":memory:", { now: () => LATER }); try { await restored.restore(backup, options("restore", 0)); assert.deepEqual((await restored.readSnapshot()).locations, backup.dataset.locations); assert.deepEqual(await restored.confirmLocation(confirm, options("confirm", data.revision)), saved); await ingest(restored, "a", "北京-海淀区", "refresh-restored", LATER); } finally { restored.close(); }
}));

test("v2 migration initializes source location base without altering current rows or revision", async () => fixture(async (repo, path) => {
  const before = await repo.readSnapshot(); repo.close(); const legacy = new DatabaseSync(path); try { legacy.exec("DROP TRIGGER source_scan_events_no_update; DROP TRIGGER source_scan_events_no_delete; DROP TABLE source_scan_events; DROP TRIGGER company_control_decisions_no_update; DROP TRIGGER company_control_decisions_no_delete; DROP TABLE company_control_decisions; DROP TABLE base_companies; DROP TRIGGER fx_snapshots_no_update; DROP TRIGGER fx_snapshots_no_delete; DROP TRIGGER fx_activations_no_update; DROP TRIGGER fx_activations_no_delete; DROP TABLE fx_activations; DROP TABLE fx_snapshots; DROP TRIGGER compensation_decisions_no_update; DROP TRIGGER compensation_decisions_no_delete; DROP TABLE compensation_decisions; DROP TABLE base_compensations; DROP TRIGGER office_decisions_no_update; DROP TRIGGER office_decisions_no_delete; DROP TABLE office_decisions; DROP TRIGGER location_decisions_no_update; DROP TRIGGER location_decisions_no_delete; DROP TABLE location_decisions; DROP TABLE base_locations; PRAGMA user_version=2;"); } finally { legacy.close(); }
  const upgraded = openJobRepository(path, { now: () => AT }); try { assert.deepEqual(await upgraded.readSnapshot(), before); assert.deepEqual((await upgraded.backup()).baseLocations, before.locations); const value = input(before); await upgraded.confirmLocation(await command(upgraded, value), options("confirm-upgraded", before.revision)); } finally { upgraded.close(); }
}));

test("stale, wrong-owner, unreviewed and untrusted paths never write; shared tool enforces effect authorization", async () => fixture(async repo => {
  const data = await repo.readSnapshot(), value = input(data), before = await repo.backup();
  await assert.rejects(repo.previewLocationConfirmation({ ...value, expectedRevision: 0 }), code("stale-version"));
  await assert.rejects(repo.previewLocationConfirmation({ ...value, jobId: data.jobs[1]!.id }), code("not-found"));
  await assert.rejects(repo.previewLocationConfirmation({ ...value, proposal: { ...value.proposal, area: { kind: "china-catalog", provinceCode: "11", cityCode: "3101" } } }), code("invalid-data"));
  await assert.rejects(repo.previewLocationConfirmation({ ...value, proposal: { ...value.proposal, countryCode: "ZZ", area: { kind: "manual-area" } } }), code("invalid-data"));
  await assert.rejects(repo.confirmLocation({ ...await command(repo, value), reviewed: false } as never, options("unreviewed", data.revision)), code("invalid-data"));
  const app = createJobApplication({ repository: repo, now: () => AT });
  const context: TrustedToolContext = { requestId: "location-test", actorScope: "local-owner", idempotencyKey: "denied", signal: new AbortController().signal, allowedEffects: ["read-index"], budget: { requests: 0, bytes: 1000000, timeoutMs: 5000 } };
  try { const result = await app.registry.execute("locations.confirm", await command(repo, value), context); assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "not-authorized"); assert.deepEqual(await repo.backup(), before); } finally { await app.shutdown(); }
}, true));

test("a saved area clears a source office point and revoke recovers it; failed receipt writes roll back decisions and indices", async () => fixture(async repo => {
  const data = await repo.readProjectionSnapshot(); data.locations[0]!.kind = "office"; data.locations[0]!.precision = "address"; data.locations[0]!.coordinates = { latitude: 31.2, longitude: 121.5, coordinateSystem: "WGS84" };
  const target = openJobRepository(":memory:", { now: () => AT });
  try { await target.importSnapshot(data, options("seed-coordinates", 0)); const before = await target.readSnapshot(), value = input(before); const saved = await target.confirmLocation(await command(target, value), options("area-only", before.revision)); assert.equal(saved.location.coordinates, undefined); assert.equal(saved.location.precision, "city"); assert.equal((await target.candidateIds({ viewport: [121, 31, 122, 32] })).indexedHits.length, 0);
    const undone = await target.revokeLocationConfirmation({ jobId: value.jobId, locationId: value.locationId, decisionId: saved.decisionId, expectedRevision: saved.revision, reason: "Synthetic source recovery", reviewed: true }, options("recover-point", saved.revision)); assert.deepEqual(undone.location, data.locations[0]); assert.equal((await target.candidateIds({ viewport: [121, 31, 122, 32] })).indexedHits.length, 1);
  } finally { target.close(); }
}));

test("transaction failure preserves base, effective projection and retryability", async () => fixture(async (repo, path) => {
  const data = await repo.readSnapshot(), before = await repo.backup(), value = await command(repo, input(data)); const inspector = new DatabaseSync(path);
  try { inspector.exec("CREATE TRIGGER synthetic_location_receipt_failure BEFORE INSERT ON receipts WHEN NEW.tool='locations.confirm' BEGIN SELECT RAISE(ABORT,'synthetic-failure'); END;"); await assert.rejects(repo.confirmLocation(value, options("retry", data.revision)), code("storage-error")); assert.deepEqual(await repo.backup(), before); inspector.exec("DROP TRIGGER synthetic_location_receipt_failure;"); assert.equal((await repo.confirmLocation(value, options("retry", data.revision))).revision, data.revision + 1); } finally { inspector.close(); }
}));

test("backup receipts cannot recover a location write under an unrelated existing job ID", async () => fixture(async repo => {
  const data = await repo.readSnapshot(), value = input(data); await repo.confirmLocation(await command(repo, value), options("confirm", data.revision)); const before = await repo.backup(), bad = structuredClone(before);
  const receipt = bad.receipts.find(value => value.tool === "locations.confirm")!;
  if ("jobId" in receipt.response) receipt.response.jobId = data.jobs[1]!.id;
  await assert.rejects(repo.restore(bad, options("wrong-receipt-job", before.dataset.revision)), code("invalid-backup")); assert.deepEqual(await repo.backup(), before);
}, true));

test("ambiguous shared legacy locations and locations without source evidence require source repair before confirmation", async () => fixture(async repo => {
  const seed = await repo.readProjectionSnapshot();
  for (const missingEvidence of [false, true]) {
    const data = structuredClone(seed);
    if (missingEvidence) data.locations.find(value => value.id === data.jobs[0]!.locationIds[0])!.evidence = [];
    else { const id = data.jobs[0]!.locationIds[0]!; data.jobs[1]!.locationIds = [id]; data.listings.find(value => value.canonicalJobId === data.jobs[1]!.id)!.locationIds = [id]; }
    const target = openJobRepository(":memory:", { now: () => AT }); try { await target.importSnapshot(data, options("seed-legacy", 0)); const before = await target.backup(); await assert.rejects(target.previewLocationConfirmation(input(await target.readSnapshot())), code("conflict")); assert.deepEqual(await target.backup(), before); } finally { target.close(); }
  }
}, true));
