import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { OfficeAddressProposalSchema, type AtlasDataset, type OfficeAddressProposal, type PreviewOfficeConfirmationInput, type SourceDefinition, type TrustedToolContext } from "@better-me/opportunities";
import type { SourceJobRecord } from "@better-me/source-adapters";
import { createJobApplication } from "../src/application.js";
import { createJobHttpServer } from "../src/http.js";
import { openJobRepository, RepositoryError, type JobRepository } from "../src/repository.js";
import { projectSourcePage } from "../src/projection.js";
import type { OfficeAddressProvider } from "../src/office-address.js";

const AT = "2026-10-19T00:00:00.000Z";
const opts = (idempotencyKey: string, expectedRevision: number, actorScope = "owner") => ({ actorScope, idempotencyKey, expectedRevision });
const code = (value: string) => (error: unknown) => error instanceof RepositoryError && error.code === value;
const source: SourceDefinition = { sourceId: "office-source", name: "Synthetic office source", adapterId: "synthetic", adapterVersion: "1", capabilities: ["list-jobs"], runtime: ["local-service"], entityType: "job-posting", enabled: true, status: "active", remoteFilters: [], endpointPolicy: { allowedHosts: ["careers.example.test"], allowedPathPrefixes: ["/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 }, attribution: { label: "Synthetic", usage: "metadata", requiresAttribution: true }, refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 10, maxPages: 1, requestsPerMinute: 30 } };
const proposal: OfficeAddressProposal = { basis: "manual-user-confirmation", countryCode: "CN", formattedAddress: "上海市 Example Road 123号", streetAddress: "Example Road 123号", coordinates: { latitude: 31.2, longitude: 121.5, coordinateSystem: "WGS84" }, evidenceUrl: "https://careers.example.test/jobs/42", coordinateMeaning: "building" };
function record(raw = "Shanghai, China", additions: Partial<SourceJobRecord["locations"][number]> = {}): SourceJobRecord { return { entityType: "job-posting", sourceRecordId: "42", url: "https://careers.example.test/jobs/42", title: "Synthetic engineer", companyName: "Synthetic employer", description: "Synthetic full JD", locations: [{ raw, countryCode: "CN", city: "Shanghai", ...additions }], compensations: [], workMode: "on-site", employmentType: "unknown", remoteEligibleRegions: [], availability: "unknown", completeness: "detail", evidence: [], warnings: [] }; }
async function ingest(repo: JobRepository, key: string, raw?: string, additions?: Partial<SourceJobRecord["locations"][number]>) {
  const before = await repo.readProjectionSnapshot();
  const projection = await projectSourcePage(before, source, { records: [record(raw, additions)], observedAt: AT, coverage: { complete: true, partial: false, fetchedRecords: 1, appliedFilters: [], ignoredFilters: [] }, warnings: [] }, key);
  return repo.importSnapshot(projection.delta, opts(key, before.revision));
}
function input(data: AtlasDataset): PreviewOfficeConfirmationInput { return { jobId: data.jobs[0]!.id, locationId: data.jobs[0]!.locationIds[0]!, expectedRevision: data.revision, proposal, reason: "Synthetic user checked job address and WGS84 point" }; }
async function confirm(repo: JobRepository, key = "confirm", value?: PreviewOfficeConfirmationInput) {
  const command = value ?? input(await repo.readSnapshot()); const preview = await repo.previewOfficeConfirmation(command);
  return repo.confirmOfficeAddress({ ...command, previewFingerprint: preview.previewFingerprint, reviewed: true }, opts(key, command.expectedRevision));
}
async function fixture(work: (repo: JobRepository, path: string) => Promise<void>) { const dir = await mkdtemp(join(tmpdir(), "better-me-office-test-")); const path = join(dir, "jobs.sqlite"); const repo = openJobRepository(path, { now: () => AT }); try { await ingest(repo, "seed"); await work(repo, path); } finally { repo.close(); await rm(dir, { recursive: true, force: true }); } }

test("manual office preview is read-only; save preserves source and records address point as unverified", async () => fixture(async repo => {
  const before = await repo.backup(), value = input(before.dataset), preview = await repo.previewOfficeConfirmation(value);
  assert.deepEqual(await repo.backup(), before); assert.equal(preview.proposed.precision, "address"); assert.equal(preview.proposed.verification, "unverified");
  const saved = await confirm(repo); const data = await repo.readSnapshot();
  assert.equal(data.revision, before.dataset.revision + 1); assert.equal(saved.activeDecisionId, saved.decisionId);
  assert.deepEqual(saved.location.coordinates, proposal.coordinates); assert.equal(saved.location.raw, before.dataset.locations[0]!.raw);
  assert.deepEqual(saved.location.evidence, before.dataset.locations[0]!.evidence); assert.equal(saved.location.officeResolution?.coordinateMeaning, "building");
  assert.deepEqual((await repo.readProjectionSnapshot()).locations, before.dataset.locations);
  assert.equal((await repo.candidateIds({ viewport: [121, 31, 122, 32] })).indexedHits.length, 1);
  await assert.rejects(repo.importSnapshot(data, opts("forged-public-overlay", data.revision)), code("conflict"));
}));

test("restart, identical retry and revoke recover durable receipts without repeating writes", async () => fixture(async (repo, path) => {
  const value = input(await repo.readSnapshot()), preview = await repo.previewOfficeConfirmation(value), command = { ...value, previewFingerprint: preview.previewFingerprint, reviewed: true as const };
  const saved = await repo.confirmOfficeAddress(command, opts("save", value.expectedRevision));
  const reopened = openJobRepository(path, { now: () => AT });
  try {
    assert.deepEqual(await reopened.confirmOfficeAddress(command, opts("save", value.expectedRevision)), saved);
    await assert.rejects(reopened.confirmOfficeAddress({ ...command, reason: "changed" }, opts("save", value.expectedRevision)), code("idempotency-conflict"));
    const revoke = { jobId: value.jobId, locationId: value.locationId, decisionId: saved.decisionId, expectedRevision: saved.revision, reason: "Undo synthetic position", reviewed: true as const };
    const undone = await reopened.revokeOfficeAddress(revoke, opts("revoke", saved.revision));
    assert.equal(undone.location.officeResolution, undefined); assert.equal(undone.location.coordinates, undefined);
    assert.deepEqual(await reopened.revokeOfficeAddress(revoke, opts("revoke", saved.revision)), undone);
    const db = new DatabaseSync(path); try { assert.throws(() => db.exec("DELETE FROM office_decisions"), /immutable-office-decision/); assert.throws(() => db.exec("UPDATE office_decisions SET document=document"), /immutable-office-decision/); } finally { db.close(); }
  } finally { reopened.close(); }
}));

test("two office decisions revoke to previous valid point then to unchanged source", async () => fixture(async repo => {
  const first = await confirm(repo, "first"); const secondInput = { ...input(await repo.readSnapshot()), proposal: { ...proposal, coordinates: { ...proposal.coordinates, longitude: 121.6 } } };
  const second = await confirm(repo, "second", secondInput);
  const undo = await repo.revokeOfficeAddress({ jobId: secondInput.jobId, locationId: secondInput.locationId, decisionId: second.decisionId, expectedRevision: second.revision, reason: "Undo second", reviewed: true }, opts("undo-second", second.revision));
  assert.equal(undo.activeDecisionId, first.decisionId); assert.equal(undo.location.coordinates?.longitude, 121.5);
  const backup = await repo.backup(), target = openJobRepository(":memory:", { now: () => AT });
  try { await target.restore(backup, opts("restore", 0)); assert.deepEqual((await target.readSnapshot()).locations, backup.dataset.locations); } finally { target.close(); }
}));

test("historical revoke receipts remain restorable after later source enrichment and a later area choice", async () => fixture(async repo => {
  const first = await confirm(repo, "history-first");
  const second = await confirm(repo, "history-second", { ...input(await repo.readSnapshot()), proposal: { ...proposal, coordinateMeaning: "entrance", coordinates: { ...proposal.coordinates, longitude: 121.7 } } });
  const value = input(await repo.readSnapshot());
  await repo.revokeOfficeAddress({ jobId: value.jobId, locationId: value.locationId, decisionId: second.decisionId, expectedRevision: second.revision, reason: "Restore first position", reviewed: true }, opts("history-undo", second.revision));
  await ingest(repo, "history-source-enrichment", undefined, { streetAddress: "Example Road 123号" });
  let data = await repo.readSnapshot(); assert.equal(data.locations[0]!.officeResolution, undefined);
  const area = { jobId: value.jobId, locationId: value.locationId, expectedRevision: data.revision, reason: "Later area selection", proposal: { locationKind: "office" as const, countryCode: "CN", area: { kind: "manual-area" as const, city: "Beijing" } } };
  const preview = await repo.previewLocationConfirmation(area); const savedArea = await repo.confirmLocation({ ...area, previewFingerprint: preview.previewFingerprint, reviewed: true }, opts("history-area", data.revision));
  await repo.revokeLocationConfirmation({ jobId: value.jobId, locationId: value.locationId, decisionId: savedArea.decisionId, expectedRevision: savedArea.revision, reason: "Revoke later area", reviewed: true }, opts("history-area-undo", savedArea.revision));
  await ingest(repo, "history-postal-enrichment", undefined, { streetAddress: "Example Road 123号", postalCode: "200000" });
  const backup = await repo.backup(), target = openJobRepository(":memory:", { now: () => AT });
  try { await target.restore(backup, opts("restore-history", 0)); data = await target.readSnapshot(); assert.equal(data.locations[0]!.officeResolution, undefined); assert.equal(backup.officeDecisions.find(entry => entry.id === first.decisionId)?.kind, "confirm"); } finally { target.close(); }
}));

test("office points follow source contribution through canonical merge and split", async () => fixture(async repo => {
  const seed = await repo.readProjectionSnapshot();
  const other = record("Berlin, Germany", { countryCode: "DE", city: "Berlin" }); other.sourceRecordId = "43"; other.url = "https://careers.example.test/jobs/43";
  const projected = await projectSourcePage(seed, source, { records: [other], observedAt: AT, coverage: { complete: true, partial: false, fetchedRecords: 1, appliedFilters: [], ignoredFilters: [] }, warnings: [] }, "second-job");
  await repo.importSnapshot(projected.delta, opts("second-job", seed.revision));
  const data = await repo.readSnapshot(), location = data.locations.find(value => value.countryCode === "CN")!, a = data.jobs.find(job => job.locationIds.includes(location.id))!, b = data.jobs.find(job => job.id !== a.id)!;
  const saved = await confirm(repo, "merged-office", { ...input(data), jobId: a.id, locationId: location.id });
  const merged = await repo.mergeJobs({ targetJobId: b.id, sourceJobId: a.id, reason: "Synthetic reviewed same requisition", companyIdentityConfirmed: true }, opts("merge", saved.revision));
  assert.equal((await repo.readSnapshot()).locations.find(location => location.id === saved.locationId)!.officeResolution?.decisionId, saved.decisionId);
  const split = await repo.revokeMerge({ decisionId: merged.decision.id, reason: "Undo synthetic merge" }, opts("split", merged.revision));
  const undone = await repo.revokeOfficeAddress({ jobId: a.id, locationId: saved.locationId, decisionId: saved.decisionId, expectedRevision: split.revision, reason: "Undo source point", reviewed: true }, opts("undo-split-office", split.revision));
  assert.equal(undone.location.officeResolution, undefined);
  const target = openJobRepository(":memory:", { now: () => AT }); try { await target.restore(await repo.backup(), opts("restore-split", 0)); } finally { target.close(); }
}));

test("source location identity change invalidates office position while preserving decision history", async () => fixture(async repo => {
  const saved = await confirm(repo); await ingest(repo, "changed-source", "Beijing, China", { city: "Beijing" });
  const data = await repo.readSnapshot(), current = data.locations.find(location => location.id === data.jobs[0]!.locationIds[0])!;
  assert.notEqual(current.id, saved.locationId); assert.equal(current.officeResolution, undefined); assert.equal(current.coordinates, undefined);
  const backup = await repo.backup(); assert.equal(backup.officeDecisions.filter(value => value.kind === "confirm").length, 1); assert.equal(backup.officeDecisions.filter(value => value.kind === "invalidate").length, 1);
  const target = openJobRepository(":memory:", { now: () => AT }); try { await target.restore(await repo.backup(), opts("restore-changed", 0)); } finally { target.close(); }
}));

test("source A to B to A cannot silently reactivate an old office decision; invalidation shares its source import revision", async () => fixture(async repo => {
  const saved = await confirm(repo); const changed = await ingest(repo, "source-b", "Beijing, China", { city: "Beijing" });
  const intermediate = await repo.backup(), invalidation = intermediate.officeDecisions.find(value => value.kind === "invalidate")!;
  assert.equal(invalidation.revision, changed.revision);
  if (invalidation.kind === "invalidate") assert.deepEqual(invalidation.targetDecisionIds, [saved.decisionId]);
  await ingest(repo, "source-a-again"); const after = await repo.readSnapshot(), location = after.locations.find(value => value.id === saved.locationId)!;
  assert.equal(after.jobs[0]!.locationIds[0], saved.locationId); assert.equal(location.coordinates, undefined); assert.equal(location.officeResolution, undefined);
  const backup = await repo.backup(), target = openJobRepository(":memory:", { now: () => AT });
  try { await target.restore(backup, opts("restore-source-return", 0)); assert.equal((await target.readSnapshot()).locations.find(value => value.id === saved.locationId)!.officeResolution, undefined); } finally { target.close(); }
  const reviewedAgain = await confirm(repo, "confirm-a-again"); assert.notEqual(reviewedAgain.decisionId, saved.decisionId); assert.equal(reviewedAgain.location.officeResolution?.decisionId, reviewedAgain.decisionId);
}));

test("one source import invalidates every superseded confirmation in one append-only event and replay remains durable", async () => fixture(async repo => {
  const first = await confirm(repo, "invalidate-first");
  const second = await confirm(repo, "invalidate-second", { ...input(await repo.readSnapshot()), proposal: { ...proposal, coordinates: { ...proposal.coordinates, longitude: 121.6 } } });
  const before = await repo.readSnapshot(); const base = await repo.readProjectionSnapshot();
  const projected = await projectSourcePage(base, source, { records: [record("Beijing, China", { city: "Beijing" })], observedAt: AT, coverage: { complete: true, partial: false, fetchedRecords: 1, appliedFilters: [], ignoredFilters: [] }, warnings: [] }, "multi-invalidation");
  const receipt = await repo.importSnapshot(projected.delta, opts("multi-invalidation", before.revision));
  const backup = await repo.backup(), invalidations = backup.officeDecisions.filter(value => value.kind === "invalidate");
  assert.equal(invalidations.length, 1); assert.equal(invalidations[0]!.revision, receipt.revision);
  if (invalidations[0]!.kind === "invalidate") assert.deepEqual(invalidations[0]!.targetDecisionIds, [first.decisionId, second.decisionId]);
  assert.deepEqual(await repo.importSnapshot(projected.delta, opts("multi-invalidation", before.revision)), receipt);
  assert.equal((await repo.backup()).officeDecisions.length, backup.officeDecisions.length);
  const target = openJobRepository(":memory:", { now: () => AT }); try { await target.restore(backup, opts("restore-multi-invalidation", 0)); } finally { target.close(); }
}));

test("additive source street/postal evidence retains area choice but invalidates full-source office binding", async () => fixture(async repo => {
  let data = await repo.readSnapshot(); const area = { jobId: data.jobs[0]!.id, locationId: data.jobs[0]!.locationIds[0]!, expectedRevision: data.revision, reason: "Synthetic area", proposal: { locationKind: "office" as const, countryCode: "CN", area: { kind: "manual-area" as const, city: "Shanghai" } } };
  const areaPreview = await repo.previewLocationConfirmation(area); await repo.confirmLocation({ ...area, previewFingerprint: areaPreview.previewFingerprint, reviewed: true }, opts("area", data.revision));
  const saved = await confirm(repo); await ingest(repo, "address-enrichment", undefined, { streetAddress: "Example Road 123号", postalCode: "200000" });
  data = await repo.readSnapshot(); const current = data.locations.find(value => value.id === saved.locationId)!;
  assert.ok(current.userResolution); assert.equal(current.streetAddress, "Example Road 123号"); assert.equal(current.officeResolution, undefined); assert.equal(current.coordinates, undefined);
  const target = openJobRepository(":memory:", { now: () => AT }); try { await target.restore(await repo.backup(), opts("restore-enrichment", 0)); } finally { target.close(); }
}));

test("new effective area disables office point; revocation can restore the original bound effective area", async () => fixture(async repo => {
  const saved = await confirm(repo); const data = await repo.readSnapshot();
  const area = { jobId: data.jobs[0]!.id, locationId: saved.locationId, expectedRevision: data.revision, reason: "Synthetic corrected area", proposal: { locationKind: "office" as const, countryCode: "CN", area: { kind: "manual-area" as const, city: "Beijing" } } };
  const preview = await repo.previewLocationConfirmation(area); const changed = await repo.confirmLocation({ ...area, previewFingerprint: preview.previewFingerprint, reviewed: true }, opts("change-area", data.revision));
  assert.equal(changed.location.officeResolution, undefined); assert.equal(changed.location.coordinates, undefined);
  const target = openJobRepository(":memory:", { now: () => AT }); try { await target.restore(await repo.backup(), opts("restore-area", 0)); } finally { target.close(); }
  const undone = await repo.revokeLocationConfirmation({ jobId: area.jobId, locationId: area.locationId, decisionId: changed.decisionId, expectedRevision: changed.revision, reason: "Undo area", reviewed: true }, opts("undo-area", changed.revision));
  assert.equal(undone.location.officeResolution?.decisionId, saved.decisionId);
}));

test("remote/unknown kinds, city-only street, missing address, mismatched country and foreign coordinate systems cannot confirm", async () => fixture(async repo => {
  const value = input(await repo.readSnapshot()), before = await repo.backup();
  for (const bad of [ { ...proposal, streetAddress: "" }, { ...proposal, streetAddress: "Shanghai" }, { ...proposal, countryCode: "DE" }, { ...proposal, countryCode: "XX" }, { ...proposal, coordinates: { ...proposal.coordinates, coordinateSystem: "GCJ02" } }, { ...proposal, providerId: "pretend-provider" } ]) {
    await assert.rejects(repo.previewOfficeConfirmation({ ...value, proposal: bad }), code("invalid-data"));
  }
  for (const kind of ["unknown", "remote-region"] as const) {
    const data = await repo.readProjectionSnapshot(); data.locations[0]!.kind = kind;
    const target = openJobRepository(":memory:", { now: () => AT }); try { await target.importSnapshot(data, opts("seed", 0)); await assert.rejects(target.previewOfficeConfirmation(input(await target.readSnapshot())), code("conflict")); } finally { target.close(); }
  }
  assert.equal(OfficeAddressProposalSchema.safeParse({ ...proposal, coordinates: { ...proposal.coordinates, latitude: NaN } }).success, false);
  assert.deepEqual(await repo.backup(), before);
}));

test("manual WGS84 replacement discards source original-coordinate metadata and revoke restores source", async () => fixture(async repo => {
  const data = await repo.readProjectionSnapshot(); data.locations[0]!.originalCoordinates = { latitude: 31, longitude: 121, coordinateSystem: "GCJ02" };
  const target = openJobRepository(":memory:", { now: () => AT }); try {
    await target.importSnapshot(data, opts("seed-original-coordinate", 0)); const saved = await confirm(target);
    assert.equal(saved.location.originalCoordinates, undefined);
    const current = input(await target.readSnapshot());
    const undone = await target.revokeOfficeAddress({ jobId: current.jobId, locationId: current.locationId, expectedRevision: current.expectedRevision, decisionId: saved.decisionId, reason: "Restore original coordinate metadata", reviewed: true }, opts("undo", saved.revision));
    assert.deepEqual(undone.location.originalCoordinates, data.locations[0]!.originalCoordinates);
  } finally { target.close(); }
}));

test("an undisclosed source country does not allow an unknown ISO proposal", async () => fixture(async repo => {
  const data = await repo.readProjectionSnapshot(); delete data.locations[0]!.countryCode;
  const target = openJobRepository(":memory:", { now: () => AT });
  try { await target.importSnapshot(data, opts("seed-unknown-country", 0)); const value = input(await target.readSnapshot());
    await assert.rejects(target.previewOfficeConfirmation({ ...value, proposal: { ...proposal, countryCode: "XX" } }), code("invalid-data"));
    assert.equal((await target.previewOfficeConfirmation(value)).proposed.countryCode, "CN");
  } finally { target.close(); }
}));

test("cross-listing location evidence rejects preview before offering a save", async () => fixture(async repo => {
  const seed = await repo.readProjectionSnapshot(), other = record(); other.sourceRecordId = "43"; other.url = "https://careers.example.test/jobs/43";
  const projected = await projectSourcePage(seed, source, { records: [other], observedAt: AT, coverage: { complete: true, partial: false, fetchedRecords: 1, appliedFilters: [], ignoredFilters: [] }, warnings: [] }, "foreign-evidence");
  await repo.importSnapshot(projected.delta, opts("foreign-evidence", seed.revision));
  const data = await repo.readProjectionSnapshot(), selected = data.jobs[0]!, location = data.locations.find(value => value.id === selected.locationIds[0])!, foreign = data.observations.find(value => !selected.listingIds.includes(value.listingId))!;
  location.evidence = [{ ...location.evidence[0]!, observationId: foreign.id }];
  const target = openJobRepository(":memory:", { now: () => AT });
  try { await target.importSnapshot(data, opts("seed-cross-listing", 0)); await assert.rejects(target.previewOfficeConfirmation(input(await target.readSnapshot())), code("conflict")); } finally { target.close(); }
}));

test("stale versions, tampered preview, wrong actor and cancelled transactions never write", async () => fixture(async repo => {
  const data = await repo.readSnapshot(), value = input(data), preview = await repo.previewOfficeConfirmation(value), before = await repo.backup();
  await assert.rejects(repo.previewOfficeConfirmation({ ...value, expectedRevision: 0 }), code("stale-version"));
  await assert.rejects(repo.confirmOfficeAddress({ ...value, previewFingerprint: "0".repeat(64), reviewed: true }, opts("bad-fingerprint", data.revision)), code("stale-version"));
  await assert.rejects(repo.confirmOfficeAddress({ ...value, previewFingerprint: preview.previewFingerprint, reviewed: false } as never, opts("not-reviewed", data.revision)), code("invalid-data"));
  await assert.rejects(repo.confirmOfficeAddress({ ...value, previewFingerprint: preview.previewFingerprint, reviewed: true }, { ...opts("cancelled", data.revision), throwIfCancelled: () => { throw new RepositoryError("cancelled"); } }), code("cancelled"));
  assert.deepEqual(await repo.backup(), before); const saved = await confirm(repo);
  await assert.rejects(repo.revokeOfficeAddress({ jobId: value.jobId, locationId: value.locationId, decisionId: saved.decisionId, expectedRevision: saved.revision, reason: "Wrong actor", reviewed: true }, opts("wrong-actor", saved.revision, "stranger")), code("not-authorized"));
}));

test("v4 backups retain office decisions and receipts; forged overlay, event or receipt rejects atomically", async () => fixture(async repo => {
  await confirm(repo); const backup = await repo.backup(); assert.equal(backup.schemaVersion, 5); assert.equal(backup.officeDecisions.length, 1);
  for (const mutate of [
    (bad: typeof backup) => { bad.dataset.locations[0]!.coordinates!.longitude = 100; },
    (bad: typeof backup) => { const event = bad.officeDecisions[0]!; if (event.kind === "confirm") event.proposal.coordinates.longitude = 100; },
    (bad: typeof backup) => { const receipt = bad.receipts.find(value => value.tool === "locations.confirm-office-address")!; if ("location" in receipt.response) receipt.response.location.raw = "forged"; },
  ]) { const bad = structuredClone(backup); mutate(bad); await assert.rejects(repo.restore(bad, opts(`bad-${JSON.stringify(bad).length}`, backup.dataset.revision)), code("invalid-backup")); assert.deepEqual(await repo.backup(), backup); }
}));

test("source enhancement cannot change a country, raw text, existing address or coordinates under one location identity", async () => fixture(async repo => {
  await ingest(repo, "source-street", undefined, { streetAddress: "Example Road 123号" });
  const base = await repo.readProjectionSnapshot(), backup = await repo.backup();
  for (const change of [{ countryCode: "DE" }, { raw: "different source text" }, { streetAddress: "changed street" }, { coordinates: proposal.coordinates, precision: "address" }]) {
    const delta = { ...base, jobs: [], companies: [], listings: [], observations: [], snapshots: [], sources: [], locations: [{ ...base.locations[0]!, ...change }] };
    await assert.rejects(repo.importSnapshot(delta, opts(`reject-${Object.keys(change)[0]}`, base.revision)), code("conflict"));
    assert.deepEqual(await repo.backup(), backup);
  }
}));

test("v3 file migration and v3 backup compatibility do not alter existing source data", async () => fixture(async (repo, path) => {
  const before = await repo.readSnapshot(), legacyBackup = await repo.backup(); legacyBackup.schemaVersion = 3; legacyBackup.officeDecisions = []; delete legacyBackup.baseCompensations; legacyBackup.compensationDecisions = [];
  repo.close(); const db = new DatabaseSync(path); try { db.exec("DROP TRIGGER compensation_decisions_no_update; DROP TRIGGER compensation_decisions_no_delete; DROP TABLE compensation_decisions; DROP TABLE base_compensations; DROP TRIGGER office_decisions_no_update; DROP TRIGGER office_decisions_no_delete; DROP TABLE office_decisions; PRAGMA user_version=3;"); } finally { db.close(); }
  const reopened = openJobRepository(path, { now: () => AT }); try { assert.deepEqual(await reopened.readSnapshot(), before); assert.equal((await reopened.backup()).schemaVersion, 5); await confirm(reopened); } finally { reopened.close(); }
  const target = openJobRepository(":memory:", { now: () => AT }); try { await target.restore(legacyBackup, opts("restore-v3", 0)); assert.deepEqual((await target.readSnapshot()).locations, before.locations); } finally { target.close(); }
}));

test("receipt failure rolls back office decision and permits exact retry", async () => fixture(async (repo, path) => {
  const before = await repo.backup(), db = new DatabaseSync(path);
  try { db.exec("CREATE TRIGGER synthetic_office_receipt_failure BEFORE INSERT ON receipts WHEN NEW.tool='locations.confirm-office-address' BEGIN SELECT RAISE(ABORT,'synthetic-failure'); END;"); await assert.rejects(confirm(repo), code("storage-error")); assert.deepEqual(await repo.backup(), before); db.exec("DROP TRIGGER synthetic_office_receipt_failure;"); await confirm(repo); } finally { db.close(); }
}));

test("tool candidates are manual by default; configured provider runs only on explicit query and stale results reject", async () => fixture(async repo => {
  const data = await repo.readSnapshot(), value = input(data), targetInput = { jobId: value.jobId, locationId: value.locationId, expectedRevision: value.expectedRevision };
  const context: TrustedToolContext = { requestId: "office-test", actorScope: "owner", signal: new AbortController().signal, allowedEffects: ["read-index", "external-read"], budget: { requests: 10, bytes: 1000000, timeoutMs: 5000 } };
  let reads = 0;
  const disabled = createJobApplication({ repository: repo, now: () => AT });
  try { const result = await disabled.registry.execute("locations.office-address-candidates", { ...targetInput, query: proposal.formattedAddress }, context); assert.equal(result.ok, true); if (result.ok) assert.equal((result.value as { status: string }).status, "not-configured"); } finally { await disabled.shutdown(); }
  const app = createJobApplication({ repository: repo, now: () => AT, officeAddressProvider: { providerId: "synthetic-provider", search: async () => { reads++; return [{ id: "synthetic-address", providerId: "synthetic-provider", proposal, evidenceUrl: proposal.evidenceUrl, attribution: "Synthetic test only", verification: "unverified", estimated: true }]; } } });
  try {
    const local = await app.registry.execute("locations.office-address-candidates", targetInput, context); assert.equal(local.ok, true); assert.equal(reads, 0);
    const external = await app.registry.execute("locations.office-address-candidates", { ...targetInput, query: proposal.formattedAddress }, context); assert.equal(external.ok, true); assert.equal(reads, 1);
    const denied = await app.registry.execute("locations.confirm-office-address", { ...value, previewFingerprint: (await repo.previewOfficeConfirmation(value)).previewFingerprint, reviewed: true }, { ...context, idempotencyKey: "denied", allowedEffects: ["read-index"] }); assert.equal(denied.ok, false);
  } finally { await app.shutdown(); }
  const stale = createJobApplication({ repository: repo, officeAddressProvider: { providerId: "synthetic-provider", search: async () => { await confirm(repo); return []; } } });
  try { const result = await stale.registry.execute("locations.office-address-candidates", { ...targetInput, query: proposal.formattedAddress }, context); assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "stale-version"); } finally { await stale.shutdown(); }
}));

test("office candidate tool forwards only explicitly supplied locality and postal constraints and performs no write", async () => fixture(async repo => {
  await ingest(repo, "postal-source", undefined, { postalCode: "PRIVATE_SOURCE_POSTAL" });
  const before = await repo.backup(), value = input(before.dataset), targetInput = { jobId: value.jobId, locationId: value.locationId, expectedRevision: value.expectedRevision };
  const reads: Parameters<OfficeAddressProvider["search"]>[0][] = [];
  const app = createJobApplication({ repository: repo, now: () => AT, officeAddressProvider: { providerId: "synthetic-provider", search: async request => { reads.push(structuredClone(request)); return []; } } });
  const context: TrustedToolContext = { requestId: "office-explicit-constraints", actorScope: "owner", signal: new AbortController().signal,
    allowedEffects: ["read-index", "external-read"], budget: { requests: 1, bytes: 1000000, timeoutMs: 5000 } };
  try {
    const query = "10 Synthetic Road";
    assert.equal((await app.registry.execute("locations.office-address-candidates", { ...targetInput, query }, context)).ok, true);
    assert.equal(Object.hasOwn(reads[0]!, "locality"), false); assert.equal(Object.hasOwn(reads[0]!, "postalCode"), false);
    const constraints = { locality: "Explicit City", postalCode: "00123" };
    assert.equal((await app.registry.execute("locations.office-address-candidates", { ...targetInput, query, ...constraints }, context)).ok, true);
    assert.deepEqual(reads[1], { query, location: before.dataset.locations[0], ...constraints });
    assert.equal((await app.registry.execute("locations.office-address-candidates", { ...targetInput, query, locality: "Explicit City" }, context)).ok, true);
    assert.equal(reads[2]!.locality, "Explicit City"); assert.equal(Object.hasOwn(reads[2]!, "postalCode"), false);
    for (const invalid of [{ ...targetInput, locality: "Explicit City" }, { ...targetInput, postalCode: "00123" }, { ...targetInput, query, locality: "\nExplicit City" }]) {
      const result = await app.registry.execute("locations.office-address-candidates", invalid, context); assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "invalid-input");
    }
    assert.equal(reads.length, 3); assert.deepEqual(await repo.backup(), before);
  } finally { await app.shutdown(); }
}));

test("an interrupted office tool recovers only the committed durable receipt without resubmitting the write", async () => fixture(async repo => {
  const original = repo.confirmOfficeAddress.bind(repo); let writes = 0;
  const wrapped = { ...repo, confirmOfficeAddress: async (...args: Parameters<typeof repo.confirmOfficeAddress>) => { writes++; await original(...args); throw new Error("Synthetic lost output after commit"); } };
  const app = createJobApplication({ repository: wrapped, now: () => AT });
  const value = input(await repo.readSnapshot()), command = { ...value, previewFingerprint: (await repo.previewOfficeConfirmation(value)).previewFingerprint, reviewed: true };
  const context: TrustedToolContext = { requestId: "office-recovery", actorScope: "owner", idempotencyKey: "recover-office", signal: new AbortController().signal, allowedEffects: ["local-write"], budget: { requests: 0, bytes: 1000000, timeoutMs: 5000 } };
  try {
    const lost = await app.registry.execute("locations.confirm-office-address", command, context); assert.equal(lost.ok, false);
    const recovered = await app.registry.execute("locations.confirm-office-address", command, context); assert.equal(recovered.ok, true); assert.equal(writes, 1);
    assert.equal((await repo.backup()).officeDecisions.length, 1);
  } finally { await app.shutdown(); }
}));

test("four office HTTP routes use the authenticated shared tools and writes require an idempotency key", async () => fixture(async repo => {
  const app = createJobApplication({ repository: repo, now: () => AT }), token = "synthetic-office-token-only-1234567890", server = createJobHttpServer({ registry: app.registry, token, allowedOrigins: ["http://localhost:5173"], port: 0 });
  const { url } = await server.listen(); const value = input(await repo.readSnapshot()); const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const post = (path: string, body: unknown, key?: string) => fetch(`${url}/api/v1/locations/office-address/${path}`, { method: "POST", headers: { ...headers, ...(key ? { "Idempotency-Key": key } : {}) }, body: JSON.stringify(body) });
  try {
    const { proposal: _proposal, reason: _reason, ...candidateInput } = value;
    assert.equal((await post("candidates", candidateInput)).status, 200);
    const previewResponse = await post("preview", value); assert.equal(previewResponse.status, 200); const preview = (await previewResponse.json() as { value: { previewFingerprint: string } }).value;
    const command = { ...value, previewFingerprint: preview.previewFingerprint, reviewed: true };
    assert.equal((await post("confirmations", command)).status, 400);
    const saved = await post("confirmations", command, "http-confirm"); assert.equal(saved.status, 200); const receipt = (await saved.json() as { value: { decisionId: string; revision: number } }).value;
    assert.equal((await post("confirmations", command, "http-confirm")).status, 200);
    assert.equal((await post("revoke", { ...candidateInput, expectedRevision: receipt.revision, decisionId: receipt.decisionId, reason: "Undo HTTP position", reviewed: true }, "http-undo")).status, 200);
  } finally { await server.close(); await app.shutdown(); }
}));
