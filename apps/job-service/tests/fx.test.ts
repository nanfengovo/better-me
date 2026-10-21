import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { queryJobs, type FxImportDraft, type FxMutationReceipt, type FxState, type JobQueryResult, type SourceDefinition, type TrustedToolContext } from "@better-me/opportunities";
import type { SourceJobRecord } from "@better-me/source-adapters";
import { openJobRepository, RepositoryError, type JobRepository } from "../src/repository.js";
import { projectSourcePage } from "../src/projection.js";
import { createJobApplication } from "../src/application.js";
import { createJobHttpServer } from "../src/http.js";

const AT = "2026-10-21T12:00:00.000Z";
const RETRIEVED = "2026-10-21T11:00:00.000Z";
const actorScope = "fx-synthetic-owner";
const opts = (idempotencyKey: string, expectedRevision: number) => ({ actorScope, idempotencyKey, expectedRevision });
const code = (value: string) => (error: unknown) => error instanceof RepositoryError && error.code === value;
function draft(cny = 8, usd = 2, date = "2026-10-21"): FxImportDraft {
  return { schemaVersion: 1, provider: "Synthetic EUR reference", sourceUrl: "https://reference.example.test/latest", retrievedAt: RETRIEVED,
    raw: JSON.stringify({ date, base: "EUR", amount: 1, rates: { CNY: cny, USD: usd } }), format: "eur-reference-json-v1" };
}
const source: SourceDefinition = { sourceId: "fx-synthetic-source", name: "Synthetic salary source", adapterId: "synthetic", adapterVersion: "1", capabilities: ["list-jobs"], runtime: ["local-service"], entityType: "job-posting", enabled: true, status: "active", remoteFilters: [], endpointPolicy: { allowedHosts: ["careers.example.test"], allowedPathPrefixes: ["/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 }, attribution: { label: "Synthetic", usage: "metadata", requiresAttribution: true }, refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 10, maxPages: 1, requestsPerMinute: 30 } };
function record(id: string, currency: string, amount: number): SourceJobRecord {
  const raw = `Annual gross fixed salary ${currency} ${amount}.`;
  return { entityType: "job-posting", sourceRecordId: id, url: `https://careers.example.test/jobs/${id}`, title: `Synthetic ${id} engineer`, companyName: "Synthetic employer", description: raw,
    locations: [{ raw: "Shanghai, China", countryCode: "CN", city: "Shanghai" }], compensations: [{ raw, currency, min: amount, max: amount, period: "year", tax: "gross", kind: "base" }],
    workMode: "on-site", employmentType: "unknown", remoteEligibleRegions: [], availability: "unknown", completeness: "detail", evidence: [], warnings: [] };
}
async function seed(repo: JobRepository) {
  const page = { records: [record("cny", "CNY", 200000), record("usd", "USD", 30000), record("eur", "EUR", 25000)], observedAt: AT,
    coverage: { complete: true, partial: false, fetchedRecords: 3, appliedFilters: [], ignoredFilters: [] }, warnings: [] };
  const projection = await projectSourcePage(await repo.readProjectionSnapshot(), source, page, "synthetic-seed");
  await repo.importSnapshot(projection.delta, opts("synthetic-seed", 0));
}
async function command(repo: JobRepository, value = draft(), activate = true) {
  const expectedRevision = (await repo.readSnapshot()).revision, preview = await repo.previewFxImport({ draft: value, expectedRevision });
  return { draft: value, expectedRevision, previewFingerprint: preview.previewFingerprint, reviewed: true as const, activate };
}
async function save(repo: JobRepository, key: string, value = draft(), activate = true) {
  const input = await command(repo, value, activate); return repo.confirmFxImport(input, opts(key, input.expectedRevision));
}
async function fixture(work: (repo: JobRepository, path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "better-me-fx-test-")), path = join(dir, "jobs.sqlite"), repo = openJobRepository(path, { now: () => AT });
  try { await seed(repo); await work(repo, path); } finally { repo.close(); await rm(dir, { recursive: true, force: true }); }
}
function trusted(key?: string): TrustedToolContext {
  return { requestId: "synthetic-fx-tools", actorScope, signal: new AbortController().signal, budget: { requests: 10, bytes: 1000000, timeoutMs: 5000 }, allowedEffects: ["read-index", "local-write", "external-read"], ...(key ? { idempotencyKey: key } : {}) };
}
function value<T>(result: { ok: boolean; value?: unknown; error?: unknown }): T { assert.equal(result.ok, true, JSON.stringify(result)); return result.value as T; }

test("FX preview is read-only; immutable rates and explicit activation change real query sorting while preserving all job facts", async () => fixture(async repo => {
  const before = await repo.backup(), noFx = await repo.readFxState({ expectedRevision: before.dataset.revision });
  assert.equal(noFx.context.activeSnapshot, undefined);
  const preview = await repo.previewFxImport({ draft: draft(), expectedRevision: before.dataset.revision });
  assert.equal(preview.snapshot.fx.ratesToCny.USD, 4); assert.equal(preview.snapshot.fx.ratesToCny.EUR, 8); assert.equal(preview.snapshot.fx.ratesToCny.CNY, 1);
  assert.deepEqual(await repo.backup(), before);
  const app = createJobApplication({ repository: repo, now: () => AT,
    resolveQueryOptions: () => ({ fx: { id: "host-must-not-override", provider: "wrong host", date: "2026-10-21", ratesToCny: { USD: 1000, EUR: 1000 } }, now: "2030-01-01T00:00:00.000Z" }) });
  try {
    const search = () => app.registry.execute("jobs.search", { salary: { includeEstimates: false }, sort: { field: "salary", direction: "desc" } }, trusted());
    const original = value<JobQueryResult>(await search()); assert.equal(original.unknownSalaryCount, 2); assert.equal(original.items[0]!.job.title.value, "Synthetic cny engineer");
    const imported = await save(repo, "first", draft(), false), inactive = await repo.readFxState({ expectedRevision: imported.revision });
    assert.equal(inactive.context.activeSnapshot, undefined); assert.equal(inactive.snapshots.length, 1); assert.equal(value<JobQueryResult>(await search()).unknownSalaryCount, 2);
    const selected = await repo.activateFxSnapshot({ snapshotId: imported.snapshotId, expectedRevision: imported.revision, reviewed: true }, opts("activate-first", imported.revision));
    const first = value<JobQueryResult>(await search()); assert.equal(first.snapshotVersion, selected.revision); assert.equal(first.unknownSalaryCount, 0); assert.equal(first.items.at(-1)!.job.title.value, "Synthetic usd engineer");
    const secondReceipt = await save(repo, "second", draft(12, 1)), second = value<JobQueryResult>(await search());
    assert.equal(second.items[0]!.job.title.value, "Synthetic usd engineer"); assert.equal(second.snapshotVersion, secondReceipt.revision); assert.notEqual(second.queryId, first.queryId);
    const captured = await repo.readFxQuerySnapshot(), local = await queryJobs(captured.dataset, { salary: { includeEstimates: false }, sort: { field: "salary", direction: "desc" } }, { now: captured.context.asOf, fx: captured.context.activeSnapshot?.fx });
    assert.deepEqual(second, local); assert.equal(captured.context.asOf, RETRIEVED);
    const stopped = await repo.activateFxSnapshot({ snapshotId: null, expectedRevision: secondReceipt.revision, reviewed: true }, opts("deactivate", secondReceipt.revision));
    assert.equal(stopped.activeSnapshotId, null); assert.equal(value<JobQueryResult>(await search()).unknownSalaryCount, 2);
    const after = await repo.backup(); const { revision: _beforeRevision, ...beforeFacts } = before.dataset, { revision: _afterRevision, ...afterFacts } = after.dataset;
    assert.deepEqual(afterFacts, beforeFacts); assert.deepEqual(after.baseCompensations, before.baseCompensations); assert.equal(after.fxSnapshots.length, 2); assert.equal(after.fxActivations.length, 4);
  } finally { await app.shutdown(); }
}));

test("FX durable import/selection receipts survive reopen and recover identical commands before stale revision checks", async () => fixture(async (repo, path) => {
  const input = await command(repo), first = await repo.confirmFxImport(input, opts("fixed-import", input.expectedRevision));
  const reopened = openJobRepository(path, { now: () => AT });
  try {
    assert.deepEqual(await reopened.confirmFxImport(input, opts("fixed-import", input.expectedRevision)), first);
    assert.deepEqual(await reopened.findFxReceipt("fx.confirm-import", input, opts("fixed-import", input.expectedRevision)), first);
    await assert.rejects(reopened.confirmFxImport({ ...input, activate: false }, opts("fixed-import", input.expectedRevision)), code("idempotency-conflict"));
    const deactivate = { snapshotId: null, expectedRevision: first.revision, reviewed: true as const }, stopped = await reopened.activateFxSnapshot(deactivate, opts("fixed-stop", first.revision));
    assert.deepEqual(await reopened.activateFxSnapshot(deactivate, opts("fixed-stop", first.revision)), stopped);
    assert.deepEqual(await reopened.findFxReceipt("fx.activate", deactivate, opts("fixed-stop", first.revision)), stopped);
    await assert.rejects(reopened.activateFxSnapshot({ ...deactivate, snapshotId: first.snapshotId }, opts("fixed-stop", first.revision)), code("idempotency-conflict"));
    await assert.rejects(reopened.readFxState({ expectedRevision: first.revision }), code("stale-version"));
    await assert.rejects(reopened.previewFxImport({ draft: draft(), expectedRevision: first.revision }), code("stale-version"));
    const current = await reopened.readFxState({ expectedRevision: stopped.revision }); assert.equal(current.context.activeSnapshot, undefined); assert.equal(current.snapshots.length, 1);
    const inspector = new DatabaseSync(path);
    try {
      assert.equal((inspector.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 6);
      for (const table of ["fx_snapshots", "fx_activations"]) { assert.throws(() => inspector.exec(`UPDATE ${table} SET document=document`), /immutable-fx-/); assert.throws(() => inspector.exec(`DELETE FROM ${table}`), /immutable-fx-/); }
    } finally { inspector.close(); }
  } finally { reopened.close(); }
}));

test("V6 backup replays snapshots, activation choices, source evidence and durable receipts into an empty database", async () => fixture(async repo => {
  const firstInput = await command(repo), first = await repo.confirmFxImport(firstInput, opts("import-one", firstInput.expectedRevision));
  await save(repo, "import-two", draft(12, 1), false);
  const rev = (await repo.readSnapshot()).revision, stopInput = { snapshotId: null, expectedRevision: rev, reviewed: true as const };
  const stop = await repo.activateFxSnapshot(stopInput, opts("stop-one", rev));
  const reselectInput = { snapshotId: first.snapshotId, expectedRevision: stop.revision, reviewed: true as const }, selected = await repo.activateFxSnapshot(reselectInput, opts("reselect-one", stop.revision));
  const backup = await repo.backup(), target = openJobRepository(":memory:", { now: () => AT });
  try {
    await target.restore(backup, opts("restore", 0)); const after = await target.backup();
    assert.deepEqual(after.fxSnapshots, backup.fxSnapshots); assert.deepEqual(after.fxActivations, backup.fxActivations); assert.deepEqual(after.dataset.compensations, backup.dataset.compensations);
    assert.equal((await target.readFxState()).context.activeSnapshot?.fx.id, selected.activeSnapshotId);
    assert.deepEqual(await target.confirmFxImport(firstInput, opts("import-one", firstInput.expectedRevision)), first);
    assert.deepEqual(await target.activateFxSnapshot(stopInput, opts("stop-one", rev)), stop);
    assert.deepEqual(await target.activateFxSnapshot(reselectInput, opts("reselect-one", stop.revision)), selected);
  } finally { target.close(); }
}));

test("V6 restore rejects polluted rates, raw hashes, activation history and command receipts without changing target data", async () => fixture(async repo => {
  await save(repo, "source-import"); const good = await repo.backup();
  const changes: Array<(backup: typeof good) => void> = [
    backup => { backup.fxSnapshots[0]!.snapshot.fx.ratesToCny.USD = 999; },
    backup => { backup.fxSnapshots[0]!.snapshot.raw = backup.fxSnapshots[0]!.snapshot.raw.replace('"CNY":8', '"CNY":9'); },
    backup => { backup.fxSnapshots[0]!.snapshot.contentHash = "f".repeat(64); },
    backup => { backup.fxActivations[0]!.activeSnapshotId = null; },
    backup => { backup.fxActivations[0]!.revision++; },
    backup => { backup.fxActivations[0]!.previewFingerprint = "f".repeat(64); },
    backup => { backup.fxActivations = []; },
    backup => { backup.receipts.find(value => value.tool === "fx.confirm-import")!.signature = "f".repeat(64); },
    backup => { const saved = backup.receipts.find(value => value.tool === "fx.confirm-import")!; (saved.response as FxMutationReceipt).activeSnapshotId = null; },
    backup => { backup.receipts = backup.receipts.filter(value => value.tool !== "fx.confirm-import"); },
    backup => { backup.schemaVersion = 5; },
  ];
  for (const mutate of changes) {
    const bad = structuredClone(good); mutate(bad); const target = openJobRepository(":memory:", { now: () => AT });
    try { const before = await target.backup(); await assert.rejects(target.restore(bad, opts("bad", 0)), code("invalid-backup")); assert.deepEqual(await target.backup(), before); }
    finally { target.close(); }
  }
}));

test("old V1-V5 backups have no implicit FX and schema V5 files migrate without touching public facts or revision", async () => fixture(async (repo, path) => {
  const backup = await repo.backup(), before = backup.dataset;
  for (const version of [1, 2, 3, 4, 5] as const) {
    const old: Record<string, unknown> = structuredClone(backup); old.schemaVersion = version; delete old.fxSnapshots; delete old.fxActivations;
    if (version < 5) { delete old.baseCompensations; delete old.compensationDecisions; }
    if (version < 4) delete old.officeDecisions;
    if (version < 3) { delete old.baseLocations; delete old.locationDecisions; }
    if (version < 2) for (const field of ["baseJobs", "mergeDecisions", "aliasHistory", "jobVersions"]) delete old[field];
    const target = openJobRepository(":memory:", { now: () => AT });
    try { await target.restore(old, opts(`v${version}`, 0)); assert.deepEqual((await target.readFxState()).snapshots, []); assert.deepEqual((await target.readSnapshot()).compensations, before.compensations); }
    finally { target.close(); }
  }
  repo.close(); const inspector = new DatabaseSync(path);
  try { inspector.exec("DROP TRIGGER fx_snapshots_no_update; DROP TRIGGER fx_snapshots_no_delete; DROP TRIGGER fx_activations_no_update; DROP TRIGGER fx_activations_no_delete; DROP TABLE fx_activations; DROP TABLE fx_snapshots; PRAGMA user_version=5;"); }
  finally { inspector.close(); }
  const migrated = openJobRepository(path, { now: () => AT });
  try { assert.deepEqual(await migrated.readSnapshot(), before); assert.deepEqual((await migrated.readFxState()).snapshots, []); assert.equal((await migrated.backup()).schemaVersion, 6); }
  finally { migrated.close(); }
}));

test("stale FX remains explicit original-only; fixed query time advances next UTC day and active selection can be disabled", async () => {
  let clock = AT; const repo = openJobRepository(":memory:", { now: () => clock }); await seed(repo);
  const app = createJobApplication({ repository: repo });
  try {
    const input = await command(repo, draft(8, 2, "2026-09-21")); await repo.confirmFxImport(input, opts("30-days", input.expectedRevision));
    const search = () => app.query.search({ salary: { includeEstimates: false }, sort: { field: "salary" } });
    assert.equal((await search()).unknownSalaryCount, 0); assert.equal((await repo.readFxState()).context.asOf, RETRIEVED);
    clock = "2026-10-22T05:00:00.000Z";
    const stale = await search(); assert.equal(stale.unknownSalaryCount, 2); assert.equal((await repo.readFxState()).context.asOf, "2026-10-22T00:00:00.000Z");
    for (const item of stale.items.filter(value => value.job.title.value !== "Synthetic cny engineer")) assert.equal(item.salaryCandidates[0]!.reason, "fx-stale");
  } finally { await app.shutdown(); repo.close(); }
});

test("authenticated FX HTTP routes share tool validation, write confirmation and durable retry behavior", async () => fixture(async repo => {
  const app = createJobApplication({ repository: repo, fxReferenceProvider: { read: async () => draft() } });
  const token = "synthetic-fx-http-token-only-123456789", origin = "http://localhost:5173", server = createJobHttpServer({ registry: app.registry, token, allowedOrigins: [origin], port: 0 });
  const { url } = await server.listen(), headers = { Authorization: `Bearer ${token}`, Origin: origin, "Content-Type": "application/json" };
  async function post(path: string, body: unknown, key?: string) { return fetch(`${url}/api/v1/fx/${path}`, { method: "POST", headers: { ...headers, ...(key ? { "Idempotency-Key": key } : {}) }, body: JSON.stringify(body) }); }
  try {
    assert.equal((await fetch(`${url}/api/v1/fx/state`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } })).status, 401);
    assert.equal((await post("reference", {})).status, 200); assert.equal((await post("reference", { url: "https://evil.example" })).status, 400);
    const state = value<FxState>(await (await post("state", {})).json());
    assert.equal((await post("import", { ...(await command(repo)), reviewed: false }, "not-reviewed")).status, 400);
    const preview = await (await post("preview", { draft: draft(), expectedRevision: state.revision })).json() as { ok: boolean; value: { previewFingerprint: string } };
    const body = { draft: draft(), expectedRevision: state.revision, previewFingerprint: preview.value.previewFingerprint, reviewed: true, activate: true };
    assert.equal((await post("import", body)).status, 400);
    const saved = value<FxMutationReceipt>(await (await post("import", body, "http-import")).json());
    assert.deepEqual(value<FxMutationReceipt>(await (await post("import", body, "http-import")).json()), saved);
    assert.equal((await post("state", { expectedRevision: state.revision })).status, 409);
    const stop = { snapshotId: null, expectedRevision: saved.revision, reviewed: true }, stopped = value<FxMutationReceipt>(await (await post("activate", stop, "http-stop")).json());
    assert.equal(stopped.activeSnapshotId, null); assert.deepEqual(value<FxMutationReceipt>(await (await post("activate", stop, "http-stop")).json()), stopped);
    assert.equal((await repo.backup()).fxActivations.length, 2);
  } finally { await server.close(); await app.shutdown(); }
}));

test("uninstalled FX source is explicit unsupported-capability and never silently fetches or imports", async () => fixture(async repo => {
  const app = createJobApplication({ repository: repo }); const before = await repo.backup();
  try { const result = await app.registry.execute("fx.fetch-reference", {}, trusted()); assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "unsupported-capability"); assert.deepEqual(await repo.backup(), before); }
  finally { await app.shutdown(); }
}));

test("read-state and preview reject a revision changed while hashes are being checked; concurrent imports commit once", async () => fixture(async repo => {
  const first = await save(repo, "seed-fx"), reading = repo.readFxState({ expectedRevision: first.revision });
  const stopped = await repo.activateFxSnapshot({ snapshotId: null, expectedRevision: first.revision, reviewed: true }, opts("race-read", first.revision));
  await assert.rejects(reading, code("stale-version"));
  const previewing = repo.previewFxImport({ draft: draft(12, 1), expectedRevision: stopped.revision });
  const selected = await repo.activateFxSnapshot({ snapshotId: first.snapshotId, expectedRevision: stopped.revision, reviewed: true }, opts("race-preview", stopped.revision));
  await assert.rejects(previewing, code("stale-version"));
  const input = await command(repo, draft(12, 1));
  const [one, two] = await Promise.all([repo.confirmFxImport(input, opts("same-concurrent-command", selected.revision)), repo.confirmFxImport(input, opts("same-concurrent-command", selected.revision))]);
  assert.deepEqual(one, two); assert.equal(one.revision, selected.revision + 1);
  const before = await repo.backup(), newInput = await command(repo, draft(16, 4));
  const raced = await Promise.allSettled([repo.confirmFxImport(newInput, opts("different-one", one.revision)), repo.confirmFxImport(newInput, opts("different-two", one.revision))]);
  assert.equal(raced.filter(value => value.status === "fulfilled").length, 1);
  const loser = raced.find(value => value.status === "rejected"); assert.ok(loser?.status === "rejected" && code("stale-version")(loser.reason));
  assert.equal((await repo.backup()).fxActivations.length, before.fxActivations.length + 1);
}));

test("interrupted FX writes recover original receipts with no second mutation and enforce effect permission", async () => fixture(async repo => {
  let imports = 0, selections = 0;
  const wrapped: JobRepository = { ...repo,
    confirmFxImport: async (...args) => { imports++; await repo.confirmFxImport(...args); throw new Error("Synthetic import response lost after commit"); },
    activateFxSnapshot: async (...args) => { selections++; await repo.activateFxSnapshot(...args); throw new Error("Synthetic selection response lost after commit"); } };
  const app = createJobApplication({ repository: wrapped });
  try {
    const input = await command(repo), context = trusted("tool-import");
    assert.equal((await app.registry.execute("fx.confirm-import", input, { ...context, allowedEffects: ["read-index"] })).ok, false); assert.equal(imports, 0);
    assert.equal((await app.registry.execute("fx.confirm-import", input, context)).ok, false); assert.equal(imports, 1);
    const recovered = value<FxMutationReceipt>(await app.registry.execute("fx.confirm-import", input, context)); assert.equal(imports, 1);
    const stopInput = { snapshotId: null, expectedRevision: recovered.revision, reviewed: true }, stopContext = trusted("tool-stop");
    assert.equal((await app.registry.execute("fx.activate", stopInput, stopContext)).ok, false);
    const stopped = value<FxMutationReceipt>(await app.registry.execute("fx.activate", stopInput, stopContext)); assert.equal(stopped.activeSnapshotId, null); assert.equal(selections, 1);
    assert.equal((await repo.backup()).fxActivations.length, 2);
  } finally { await app.shutdown(); }
}));

test("FX commands reject future evidence, unreviewed choices, changed previews and cancelled commits atomically", async () => fixture(async repo => {
  const before = await repo.backup(), original = draft(), revision = before.dataset.revision;
  for (const invalid of [{ ...original, retrievedAt: "2026-10-22T00:00:00.000Z" }, draft(8, 2, "2026-10-22"), { ...original, sourceUrl: "https://reference.example.test/latest?token=private" }]) {
    await assert.rejects(repo.previewFxImport({ draft: invalid, expectedRevision: revision }), code("invalid-data"));
  }
  const input = await command(repo);
  await assert.rejects(repo.confirmFxImport({ ...input, previewFingerprint: "f".repeat(64) }, opts("changed-preview", revision)), code("stale-version"));
  await assert.rejects(repo.confirmFxImport({ ...input, reviewed: false }, opts("not-reviewed", revision)), code("invalid-data"));
  await assert.rejects(repo.activateFxSnapshot({ snapshotId: null, expectedRevision: revision, reviewed: false }, opts("not-reviewed-stop", revision)), code("invalid-data"));
  await assert.rejects(repo.confirmFxImport(input, { ...opts("cancelled", revision), throwIfCancelled: () => { throw new RepositoryError("cancelled"); } }), code("cancelled"));
  assert.deepEqual(await repo.backup(), before);
  const first = await save(repo, "valid"), after = await repo.backup();
  await assert.rejects(repo.activateFxSnapshot({ snapshotId: `fx_${"f".repeat(64)}`, expectedRevision: first.revision, reviewed: true }, opts("unknown", first.revision)), code("not-found"));
  await assert.rejects(repo.activateFxSnapshot({ snapshotId: null, expectedRevision: first.revision, reviewed: true }, { ...opts("cancelled-stop", first.revision), throwIfCancelled: () => { throw new RepositoryError("cancelled"); } }), code("cancelled"));
  assert.deepEqual(await repo.backup(), after);
}));

test("duplicate immutable imports remain explicit events and restoration cannot orphan existing FX history", async () => fixture(async repo => {
  const first = await save(repo, "same-one"), firstBackup = await repo.backup(), second = await save(repo, "same-two");
  assert.equal(first.snapshotId, second.snapshotId); const after = await repo.backup(); assert.equal(after.fxSnapshots.length, 1); assert.equal(after.fxActivations.length, 2);
  const target = openJobRepository(":memory:", { now: () => AT });
  try {
    await target.restore(after, opts("restore-duplicate", 0)); assert.equal((await target.backup()).fxActivations.length, 2);
    const before = await target.backup(); await assert.rejects(target.restore(firstBackup, opts("do-not-orphan", before.dataset.revision)), code("conflict")); assert.deepEqual(await target.backup(), before);
  } finally { target.close(); }
}));

test("restore refuses FX evidence or selection from the target clock's future without changing its database", async () => {
  const future = "2026-10-22T12:00:00.000Z", sourceRepo = openJobRepository(":memory:", { now: () => future });
  try {
    const futureDraft = { ...draft(8, 2, "2026-10-22"), retrievedAt: "2026-10-22T11:00:00.000Z" };
    for (const [index, evidence] of [futureDraft, draft()].entries()) {
      const source = index === 0 ? sourceRepo : openJobRepository(":memory:", { now: () => future });
      try {
        await save(source, `future-${index}`, evidence); const backup = await source.backup(), target = openJobRepository(":memory:", { now: () => AT });
        try {
          const before = await target.backup(); await assert.rejects(target.restore(backup, opts(`refuse-future-${index}`, 0)), code("invalid-backup"));
          assert.deepEqual(await target.backup(), before); assert.equal((await target.readFxState()).context.activeSnapshot, undefined);
          assert.equal((await target.readFxQuerySnapshot()).dataset.revision, 0);
        } finally { target.close(); }
      } finally { if (source !== sourceRepo) source.close(); }
    }
  } finally { sourceRepo.close(); }
});

test("a future backup creation stamp alone does not reject already available FX evidence and decisions", async () => {
  let clock = AT; const source = openJobRepository(":memory:", { now: () => clock }), target = openJobRepository(":memory:", { now: () => AT });
  try {
    const saved = await save(source, "available-fx"); clock = "2026-10-22T12:00:00.000Z";
    const backup = await source.backup(); await target.restore(backup, opts("future-container-only", 0));
    assert.equal((await target.readFxState()).context.activeSnapshot?.fx.id, saved.snapshotId); assert.equal((await target.readFxQuerySnapshot()).context.activeSnapshot?.fx.id, saved.snapshotId);
  } finally { source.close(); target.close(); }
});
