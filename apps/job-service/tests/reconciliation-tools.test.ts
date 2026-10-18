import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  ConfirmMergeReviewInputSchema, MergeCandidatesPageSchema, MergeDecisionsPageSchema, MergeReviewPreviewSchema, ReconciliationReceiptSchema, RevokeMergeReviewPreviewSchema,
  type PreviewMergeReviewInput, type ConfirmMergeReviewInput, type MergeReviewPreview, type SourceDefinition, type TrustedToolContext,
} from "@better-me/opportunities";
import type { SourceJobRecord } from "@better-me/source-adapters";
import { createJobApplication } from "../src/application.js";
import { createJobHttpServer } from "../src/http.js";
import { openJobRepository, type JobRepository } from "../src/repository.js";
import { projectSourcePage } from "../src/projection.js";

const AT = "2026-10-19T00:00:00.000Z";
const options = (idempotencyKey: string, expectedRevision: number) => ({ actorScope: "local-owner", idempotencyKey, expectedRevision });
function source(suffix: string): SourceDefinition { return { sourceId: `review-source-${suffix}`, name: `Synthetic ${suffix}`, adapterId: "synthetic", adapterVersion: "1", capabilities: ["list-jobs"], runtime: ["local-service"], entityType: "job-posting", enabled: true, status: "active", remoteFilters: [], endpointPolicy: { allowedHosts: ["careers.example.test"], allowedPathPrefixes: ["/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 }, attribution: { label: `Synthetic ${suffix}`, usage: "metadata", requiresAttribution: true }, refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 100, maxPages: 1, requestsPerMinute: 30 } }; }
function record(suffix: string): SourceJobRecord { return { entityType: "job-posting", sourceRecordId: "42", url: `https://careers.example.test/${suffix}/jobs/42`, applicationUrl: "https://careers.example.test/careers", title: "Synthetic C# engineer", companyName: "Synthetic common-name employer", description: `Synthetic original full JD ${suffix}`, locations: [{ raw: suffix === "a" ? "Shanghai" : suffix === "b" ? "London" : "Berlin", countryCode: suffix === "a" ? "CN" : suffix === "b" ? "GB" : "DE" }], compensations: [{ raw: `Synthetic disclosed annual pay ${suffix}`, currency: "CNY", period: "year", min: suffix === "a" ? 200000 : 300000, tax: "unknown", kind: "base" }], workMode: "unknown", employmentType: "social", remoteEligibleRegions: [], availability: "unknown", completeness: "detail", evidence: [], warnings: [] }; }
async function fixture(work: (repo: JobRepository, path: string, app: ReturnType<typeof createJobApplication>) => Promise<void>, count = 3) {
  const dir = await mkdtemp(join(tmpdir(), "better-me-reviewed-reconciliation-")); const path = join(dir, "jobs.sqlite");
  const repo = openJobRepository(path, { now: () => AT });
  let app: ReturnType<typeof createJobApplication> | undefined;
  try {
    for (const suffix of ["a", "b", "c"].slice(0, count)) {
      const before = await repo.readProjectionSnapshot();
      const projection = await projectSourcePage(before, source(suffix), { records: [record(suffix)], observedAt: AT, coverage: { complete: true, partial: false, fetchedRecords: 1, appliedFilters: [], ignoredFilters: [] }, warnings: [] }, `seed-${suffix}`);
      await repo.importSnapshot(projection.delta, options(`seed-${suffix}`, before.revision));
    }
    app = createJobApplication({ repository: repo, now: () => AT }); await work(repo, path, app);
  } finally { await app?.shutdown(); repo.close(); await rm(dir, { recursive: true, force: true }); }
}
function context(key?: string, overrides: Partial<TrustedToolContext> = {}): TrustedToolContext { return { requestId: "reconciliation-tools-fixture", actorScope: "local-owner", signal: new AbortController().signal, allowedEffects: ["read-index", "local-write"], budget: { requests: 0, bytes: 16 * 1024 * 1024, timeoutMs: 30000 }, ...(key ? { idempotencyKey: key } : {}), ...overrides }; }
async function execute(app: ReturnType<typeof createJobApplication>, name: string, input: unknown, key?: string) {
  const result = await app.registry.execute(name, input, context(key)); assert.ok(result.ok, JSON.stringify(result)); return result.value;
}
async function pair(repo: JobRepository): Promise<PreviewMergeReviewInput> {
  const data = await repo.readSnapshot(); return { targetJobId: data.jobs[0]!.id, sourceJobId: data.jobs[1]!.id, expectedRevision: data.revision, reason: "Synthetic person checked actual employer and requisition", companyIdentityConfirmed: true };
}
async function preview(app: ReturnType<typeof createJobApplication>, input: PreviewMergeReviewInput): Promise<MergeReviewPreview> { return MergeReviewPreviewSchema.parse(await execute(app, "jobs.preview-merge", input)); }
async function reviewed(app: ReturnType<typeof createJobApplication>, input: PreviewMergeReviewInput): Promise<ConfirmMergeReviewInput> {
  const p = await preview(app, input); return ConfirmMergeReviewInputSchema.parse({ ...p.input, previewFingerprint: p.previewFingerprint, reviewed: true });
}
async function error(app: ReturnType<typeof createJobApplication>, tool: string, input: unknown, expected: string, key = "bad-command", overrides: Partial<TrustedToolContext> = {}) {
  const result = await app.registry.execute(tool, input, context(key, overrides)); assert.equal(result.ok, false, JSON.stringify(result)); if (!result.ok) assert.equal(result.error.code, expected);
}

test("bounded candidates and explicit directional previews read one version and preserve unknown evidence without writes", async () => fixture(async (repo, _path, app) => {
  const before = await repo.backup();
  const list = MergeCandidatesPageSchema.parse(await execute(app, "jobs.list-merge-candidates", { limit: 1 }));
  assert.equal(list.snapshotRevision, before.dataset.revision); assert.equal(list.candidates.length, 1); assert.equal(list.truncated, true); assert.equal(list.scannedCandidateLimit, 1000);
  assert.match(list.warnings.join(" "), /有限扫描.*10000对/); assert.equal(list.candidates[0]!.strong, false); assert.equal(list.candidates[0]!.requiresCompanyConfirmation, true);
  const value = await pair(repo), p = await preview(app, value);
  assert.equal(p.target.requestedJobId, value.targetJobId); assert.equal(p.source.requestedJobId, value.sourceJobId);
  assert.equal(p.snapshotRevision, p.candidate.snapshotRevision); assert.equal(p.target.job.id, p.target.canonicalJobId);
  assert.equal(p.target.locations.length, 1); assert.equal(p.source.compensations[0]!.tax, "unknown");
  assert.ok(p.candidate.conflicts.some(conflict => conflict.field === "description")); assert.match(p.warnings.join(" "), /弱信号/);
  const reverse = await preview(app, { ...value, targetJobId: value.sourceJobId, sourceJobId: value.targetJobId }); assert.notEqual(reverse.previewFingerprint, p.previewFingerprint);
  assert.notEqual((await preview(app, { ...value, reason: "different checked reason" })).previewFingerprint, p.previewFingerprint);
  assert.notEqual((await preview(app, { ...value, companyIdentityConfirmed: false })).previewFingerprint, p.previewFingerprint);
  assert.deepEqual(await repo.backup(), before);
}));

test("reviewed merge preserves every source and directional summary, then revocation previews and restores the split", async () => fixture(async (repo, _path, app) => {
  const before = await repo.readSnapshot(), value = await pair(repo), command = await reviewed(app, value);
  const result = ReconciliationReceiptSchema.parse(await execute(app, "jobs.merge", command, "merge")); const after = await repo.readSnapshot();
  assert.equal(result.revision, before.revision + 1); assert.equal(after.jobs.length, 2);
  const target = after.jobs.find(job => job.id === value.targetJobId)!; assert.equal(target.listingIds.length, 2); assert.equal(target.locationIds.length, 2); assert.equal(target.compensationIds.length, 2);
  assert.equal(target.description, before.jobs.find(job => job.id === value.targetJobId)!.description); assert.deepEqual(after.snapshots, before.snapshots); assert.deepEqual(after.observations, before.observations);
  const input = { decisionId: result.decision.id, expectedRevision: result.revision, reason: "Synthetic distinct requisitions verified" };
  const p = RevokeMergeReviewPreviewSchema.parse(await execute(app, "jobs.preview-revoke-merge", input)); assert.equal(p.counts.beforeJobs, 1); assert.equal(p.counts.afterJobs, 2);
  assert.equal(p.before[0]!.listings.length, 2); assert.ok(p.after.every(side => side.listings.length === 1));
  const undone = ReconciliationReceiptSchema.parse(await execute(app, "jobs.revoke-merge", { ...input, previewFingerprint: p.previewFingerprint, reviewed: true }, "undo"));
  assert.equal((await repo.readSnapshot()).jobs.length, 3); assert.equal((await repo.resolveJobId(value.sourceJobId))!.canonicalJobId, value.sourceJobId);
  const history = MergeDecisionsPageSchema.parse(await execute(app, "jobs.list-merge-decisions", { limit: 1 })); assert.equal(history.truncated, true); assert.equal(history.totalAvailable, 2); assert.equal(history.items[0]!.status, "revocation");
  const all = MergeDecisionsPageSchema.parse(await execute(app, "jobs.list-merge-decisions", {})); assert.equal(all.items.find(item => item.decision.id === result.decision.id)!.status, "revoked"); assert.equal(all.snapshotRevision, undone.revision);
}));

test("changed reason, role direction, employer confirmation, forged fingerprint and changed version never bypass preview", async () => fixture(async (repo, _path, app) => {
  const input = await pair(repo), command = await reviewed(app, input), before = await repo.backup();
  for (const [index, mutation] of [
    { reason: "reason changed after review" }, { targetJobId: input.sourceJobId, sourceJobId: input.targetJobId }, { companyIdentityConfirmed: false }, { previewFingerprint: "0".repeat(64) }, { expectedRevision: 0 },
  ].entries()) await error(app, "jobs.merge", { ...command, ...mutation }, "stale-version", `tamper-${index}`);
  assert.deepEqual(await repo.backup(), before);
}));

test("review, reason, strict public fields, permissions and idempotency key are required for writes", async () => fixture(async (repo, _path, app) => {
  const input = await pair(repo), command = await reviewed(app, input), before = await repo.backup();
  for (const [index, mutation] of [{ reviewed: false }, { reason: " " }, { requisitionLinks: [] }, { token: "synthetic-private" }, { privateResume: {} }].entries()) await error(app, "jobs.merge", { ...command, ...mutation }, "invalid-input", `bad-field-${index}`);
  await error(app, "jobs.merge", command, "not-authorized", "denied", { allowedEffects: ["read-index"] });
  const missingKey = await app.registry.execute("jobs.merge", command, context()); assert.equal(missingKey.ok, false); if (!missingKey.ok) assert.equal(missingKey.error.code, "invalid-context");
  const notConfirmed = await reviewed(app, { ...input, companyIdentityConfirmed: false }); await error(app, "jobs.merge", notConfirmed, "stale-version", "no-company-confirmation");
  await error(app, "jobs.preview-merge", { ...input, actorScope: "other" }, "invalid-input");
  await error(app, "jobs.preview-merge", { ...input, sourceJobId: input.targetJobId }, "invalid-input");
  assert.deepEqual(await repo.backup(), before);
}));

test("merge receipt replay survives reopen and later revisions while changed original body under the same key conflicts", async () => fixture(async (repo, path, app) => {
  const command = await reviewed(app, await pair(repo)); const result = await execute(app, "jobs.merge", command, "lost-merge-response");
  const data = await repo.readSnapshot(); await repo.registerSource({ ...data.sources[0]!, name: "Synthetic config changed" }, options("later-config", data.revision));
  const reopened = openJobRepository(path, { now: () => AT }); const other = createJobApplication({ repository: reopened, now: () => AT });
  try {
    assert.deepEqual(await execute(other, "jobs.merge", command, "lost-merge-response"), result);
    await error(other, "jobs.merge", { ...command, previewFingerprint: "0".repeat(64) }, "idempotency-conflict", "lost-merge-response");
    await error(other, "jobs.merge", { ...command, reason: "different reason" }, "idempotency-conflict", "lost-merge-response");
    await error(other, "jobs.merge", command, "stale-version", "new-key-old-preview");
  } finally { await other.shutdown(); reopened.close(); }
}));

test("rejecting a reviewed pair leaves jobs unchanged, removes only that pair and revoking rejection restores eligibility", async () => fixture(async (repo, _path, app) => {
  const command = await reviewed(app, await pair(repo)); const before = await repo.readSnapshot();
  const rejected = ReconciliationReceiptSchema.parse(await execute(app, "jobs.reject-merge", command, "reject"));
  assert.deepEqual((await repo.readSnapshot()).jobs, before.jobs);
  let candidates = MergeCandidatesPageSchema.parse(await execute(app, "jobs.list-merge-candidates", { limit: 1 })); assert.equal(candidates.candidates.length, 1, "rejection is removed before caller limit");
  const pairIds = [command.targetJobId, command.sourceJobId].sort().join(":"); assert.ok(candidates.candidates.every(candidate => [candidate.leftJobId, candidate.rightJobId].sort().join(":") !== pairIds));
  assert.deepEqual(await execute(app, "jobs.reject-merge", command, "reject"), rejected);
  const input = { decisionId: rejected.decision.id, expectedRevision: rejected.revision, reason: "Synthetic evidence reconsidered" };
  const p = RevokeMergeReviewPreviewSchema.parse(await execute(app, "jobs.preview-revoke-merge", input)); assert.equal(p.counts.beforeJobs, 2); assert.equal(p.counts.afterJobs, 2);
  const undo = { ...input, previewFingerprint: p.previewFingerprint, reviewed: true };
  const receipt = await execute(app, "jobs.revoke-merge", undo, "undo-rejection"); assert.deepEqual(await execute(app, "jobs.revoke-merge", undo, "undo-rejection"), receipt);
  await error(app, "jobs.revoke-merge", { ...undo, reason: "different" }, "idempotency-conflict", "undo-rejection");
  candidates = MergeCandidatesPageSchema.parse(await execute(app, "jobs.list-merge-candidates", {})); assert.equal(candidates.candidates.length, 3);
}));

test("old job IDs resolve within the preview version, and a second merge revocation reports the full current group", async () => fixture(async (repo, _path, app) => {
  const original = await repo.readSnapshot(), value = await pair(repo);
  const first = ReconciliationReceiptSchema.parse(await execute(app, "jobs.merge", await reviewed(app, value), "first"));
  const third = original.jobs.find(job => job.id !== value.targetJobId && job.id !== value.sourceJobId)!;
  const p = await preview(app, { ...value, targetJobId: value.sourceJobId, sourceJobId: third.id, expectedRevision: first.revision });
  assert.equal(p.target.requestedJobId, value.sourceJobId); assert.equal(p.target.canonicalJobId, value.targetJobId); assert.equal(p.target.listings.length, 2);
  const secondCommand = { ...p.input, previewFingerprint: p.previewFingerprint, reviewed: true };
  const second = ReconciliationReceiptSchema.parse(await execute(app, "jobs.merge", secondCommand, "second")); assert.equal((await repo.readSnapshot()).jobs.length, 1);
  assert.deepEqual(await execute(app, "jobs.merge", secondCommand, "second"), second);
  const revoke = RevokeMergeReviewPreviewSchema.parse(await execute(app, "jobs.preview-revoke-merge", { decisionId: first.decision.id, expectedRevision: second.revision, reason: "Synthetic chain split reviewed" }));
  assert.equal(revoke.counts.beforeJobs, 1); assert.equal(revoke.counts.afterJobs, 2); assert.equal(revoke.before[0]!.listings.length, 3);
  assert.equal(revoke.after.reduce((sum, side) => sum + side.listings.length, 0), 3);
  const filtered = MergeDecisionsPageSchema.parse(await execute(app, "jobs.list-merge-decisions", { jobId: value.sourceJobId })); assert.equal(filtered.items.length, 2);
}));

test("revocation binds impact preview and reason, rejects foreign owners and keeps durable replay before stale revisions", async () => fixture(async (repo, path, app) => {
  const merged = ReconciliationReceiptSchema.parse(await execute(app, "jobs.merge", await reviewed(app, await pair(repo)), "merge"));
  const input = { decisionId: merged.decision.id, expectedRevision: merged.revision, reason: "Synthetic person reviewed affected group" };
  const p = RevokeMergeReviewPreviewSchema.parse(await execute(app, "jobs.preview-revoke-merge", input)); const command = { ...input, previewFingerprint: p.previewFingerprint, reviewed: true };
  const before = await repo.backup(); await error(app, "jobs.revoke-merge", { ...command, reason: "changed" }, "stale-version", "changed"); await error(app, "jobs.revoke-merge", { ...command, reviewed: false }, "invalid-input");
  await error(app, "jobs.preview-revoke-merge", input, "not-authorized", "foreign", { actorScope: "another-owner" }); assert.deepEqual(await repo.backup(), before);
  const result = await execute(app, "jobs.revoke-merge", command, "lost-revoke");
  const reopened = openJobRepository(path, { now: () => AT }); const other = createJobApplication({ repository: reopened, now: () => AT });
  try { assert.deepEqual(await execute(other, "jobs.revoke-merge", command, "lost-revoke"), result); await error(other, "jobs.revoke-merge", command, "stale-version", "new-key-old-revoke"); }
  finally { await other.shutdown(); reopened.close(); }
}));

test("application composition takes a single atomic state and avoids separate snapshot, aliases or decisions reads", async () => fixture(async (repo, _path, app) => {
  const value = await pair(repo); let states = 0;
  const wrapped = new Proxy(repo, { get(target, prop) {
    if (["readSnapshot", "listMergeDecisions", "resolveJobId", "readReconciliationConflicts"].includes(String(prop))) return () => { throw new Error("must not assemble mixed-version reads"); };
    if (prop === "readReconciliationState") return async () => { states++; return target.readReconciliationState(); };
    return Reflect.get(target, prop);
  } });
  const isolated = createJobApplication({ repository: wrapped, now: () => AT });
  try { await preview(isolated, value); assert.equal(states, 1); await execute(isolated, "jobs.list-merge-candidates", {}); assert.equal(states, 2); await execute(isolated, "jobs.list-merge-decisions", {}); assert.equal(states, 3); }
  finally { await isolated.shutdown(); }
  assert.equal((await repo.readSnapshot()).revision, value.expectedRevision);
  assert.ok(app);
}));

test("cancellation arriving inside async merge or reject work reaches the final transaction gate and writes nothing", async () => fixture(async (repo, _path, app) => {
  const command = await reviewed(app, await pair(repo)), before = await repo.backup();
  for (const tool of ["jobs.merge", "jobs.reject-merge"] as const) {
    const controller = new AbortController();
    const wrapped = new Proxy(repo, { get(target, prop) {
      if (prop === (tool === "jobs.merge" ? "mergeJobs" : "rejectMerge")) return (input: never, opts: never) => { const task = tool === "jobs.merge" ? target.mergeJobs(input, opts) : target.rejectMerge(input, opts); controller.abort(); return task; };
      return Reflect.get(target, prop);
    } });
    const isolated = createJobApplication({ repository: wrapped, now: () => AT });
    try { const result = await isolated.registry.execute(tool, command, context(`cancel-${tool}`, { signal: controller.signal })); assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "cancelled"); }
    finally { await isolated.shutdown(); }
    assert.deepEqual(await repo.backup(), before);
  }
}));

test("the final gate checks an expired logical deadline before its timeout timer can run", async () => fixture(async (repo, _path, app) => {
  const command = await reviewed(app, await pair(repo)), before = await repo.backup();
  const originalNow = Date.now; let expired = false; const baseline = originalNow();
  const clock = mock.method(Date, "now", () => expired ? baseline + 60000 : baseline);
  const wrapped = new Proxy(repo, { get(target, prop) {
    if (prop === "mergeJobs") return (input: never, opts: never) => { const task = target.mergeJobs(input, opts); expired = true; return task; };
    return Reflect.get(target, prop);
  } });
  const isolated = createJobApplication({ repository: wrapped, now: () => AT });
  try {
    const result = await isolated.registry.execute("jobs.merge", command, context("deadline-before-timer"));
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "timeout");
    assert.deepEqual(await repo.backup(), before);
  } finally { clock.mock.restore(); await isolated.shutdown(); }
}));

for (const tool of ["jobs.merge", "jobs.reject-merge", "jobs.revoke-merge"] as const) test(`${tool} recovers a committed but interrupted output in the same application without executing a second mutation`, async () => fixture(async (repo, _path, app) => {
  let command: unknown = await reviewed(app, await pair(repo));
  if (tool === "jobs.revoke-merge") {
    const merged = ReconciliationReceiptSchema.parse(await execute(app, "jobs.merge", command, "prepare-revoke"));
    const p = RevokeMergeReviewPreviewSchema.parse(await execute(app, "jobs.preview-revoke-merge", { decisionId: merged.decision.id, expectedRevision: merged.revision, reason: "Synthetic reviewed interrupted revoke" }));
    command = { ...p.input, previewFingerprint: p.previewFingerprint, reviewed: true };
  }
  let committed!: () => void, release!: () => void; const committedPromise = new Promise<void>(resolve => { committed = resolve; }), releasePromise = new Promise<void>(resolve => { release = resolve; });
  let writes = 0; const method = tool === "jobs.merge" ? "mergeJobs" : tool === "jobs.reject-merge" ? "rejectMerge" : "revokeMerge";
  const wrapped = new Proxy(repo, { get(target, prop) {
    if (prop === method) return async (input: never, opts: never) => { writes++; const receipt = await target[method](input, opts); committed(); await releasePromise; return receipt; };
    return Reflect.get(target, prop);
  } });
  const isolated = createJobApplication({ repository: wrapped, now: () => AT }); const abort = new AbortController();
  try {
    const first = isolated.registry.execute(tool, command, context("lost-output", { signal: abort.signal, ...(tool === "jobs.merge" ? { budget: { requests: 0, bytes: 16 * 1024 * 1024, timeoutMs: 300 } } : {}) }));
    await committedPromise; if (tool !== "jobs.merge") abort.abort();
    const failure = await first; assert.equal(failure.ok, false); if (!failure.ok) assert.equal(failure.error.code, tool === "jobs.merge" ? "timeout" : "cancelled");
    const beforeRecovery = await repo.backup();
    const receipt = ReconciliationReceiptSchema.parse(await execute(isolated, tool, command, "lost-output"));
    assert.equal(writes, 1); assert.equal(receipt.revision, beforeRecovery.dataset.revision); assert.deepEqual(await repo.backup(), beforeRecovery);
    assert.deepEqual(await execute(isolated, tool, command, "lost-output"), receipt);
    await error(isolated, tool, { ...(command as Record<string, unknown>), reason: "changed after unknown outcome" }, "idempotency-conflict", "lost-output");
  } finally { release(); await isolated.shutdown(); }
}));

for (const scenario of ["invalid-output", "budget-exceeded"] as const) test(`a committed merge recovers after ${scenario} without another mutation or database change`, async () => fixture(async (repo, _path, app) => {
  const command = await reviewed(app, await pair(repo)); let writes = 0;
  const wrapped = new Proxy(repo, { get(target, prop) {
    if (prop === "mergeJobs") return async (input: never, opts: never) => {
      writes++; const receipt = await target.mergeJobs(input, opts);
      return scenario === "invalid-output" ? { ...receipt, unexpected: "synthetic-invalid-return" } : receipt;
    };
    return Reflect.get(target, prop);
  } });
  const isolated = createJobApplication({ repository: wrapped, now: () => AT });
  try {
    const result = await isolated.registry.execute("jobs.merge", command, context("committed-invalid-result", scenario === "budget-exceeded" ? { budget: { requests: 0, timeoutMs: 30000, bytes: Buffer.byteLength(JSON.stringify(command)) } } : {}));
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, scenario);
    const beforeRecovery = await repo.backup(); assert.equal(beforeRecovery.dataset.revision, command.expectedRevision + 1);
    const receipt = ReconciliationReceiptSchema.parse(await execute(isolated, "jobs.merge", command, "committed-invalid-result"));
    assert.equal(receipt.revision, beforeRecovery.dataset.revision); assert.equal(writes, 1); assert.deepEqual(await repo.backup(), beforeRecovery);
    assert.deepEqual(await execute(isolated, "jobs.merge", command, "committed-invalid-result"), receipt); assert.equal(writes, 1);
  } finally { await isolated.shutdown(); }
}));

test("receipt storage failure rolls back the reviewed decision and permits the exact original retry", async () => fixture(async (repo, path, app) => {
  const command = await reviewed(app, await pair(repo)), before = await repo.backup(); const inspector = new DatabaseSync(path);
  try {
    inspector.exec("CREATE TRIGGER synthetic_merge_receipt_failure BEFORE INSERT ON receipts WHEN NEW.tool='jobs.merge' BEGIN SELECT RAISE(ABORT,'synthetic-failure'); END;");
    await error(app, "jobs.merge", command, "invalid-input", "atomic-retry"); assert.deepEqual(await repo.backup(), before);
    inspector.exec("DROP TRIGGER synthetic_merge_receipt_failure;");
    const restarted = createJobApplication({ repository: repo, now: () => AT });
    try { const receipt = ReconciliationReceiptSchema.parse(await execute(restarted, "jobs.merge", command, "atomic-retry")); assert.equal(receipt.revision, before.dataset.revision + 1); }
    finally { await restarted.shutdown(); }
  } finally { inspector.close(); }
}));

test("authenticated HTTP and public tools use the same preview, reviewed writes, history and old-request replay", async () => fixture(async (repo, _path, app) => {
  const api = createJobHttpServer({ registry: app.registry, token: "synthetic-reconciliation-api-token", allowedOrigins: ["http://synthetic-ui.invalid"], port: 0 });
  const { url } = await api.listen();
  const post = async (path: string, value: unknown, key?: string, token = "synthetic-reconciliation-api-token") => fetch(`${url}/api/v1/jobs/reconciliation/${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Origin: "http://synthetic-ui.invalid", ...(key ? { "Idempotency-Key": key } : {}) }, body: JSON.stringify(value) });
  try {
    assert.equal((await post("candidates", {}, undefined, "wrong-token")).status, 401);
    const listResponse = await post("candidates", {}); assert.equal(listResponse.status, 200); MergeCandidatesPageSchema.parse((await listResponse.json()).value);
    const input = await pair(repo); const p = MergeReviewPreviewSchema.parse((await (await post("preview", input)).json()).value);
    const command = { ...p.input, previewFingerprint: p.previewFingerprint, reviewed: true };
    assert.equal((await post("merge", command)).status, 400);
    const first = await post("merge", command, "http-merge"); assert.equal(first.status, 200); const result = (await first.json()).value; ReconciliationReceiptSchema.parse(result);
    const replay = await post("merge", command, "http-merge"); assert.equal(replay.status, 200); assert.deepEqual((await replay.json()).value, result);
    assert.equal((await post("merge", { ...command, reason: "changed" }, "http-merge")).status, 409);
    const history = await post("history", {}); MergeDecisionsPageSchema.parse((await history.json()).value);
    const revokeInput = { decisionId: result.decision.id, expectedRevision: result.revision, reason: "Synthetic HTTP checked split" };
    const revoke = RevokeMergeReviewPreviewSchema.parse((await (await post("preview-revoke", revokeInput)).json()).value);
    assert.equal((await post("revoke", { ...revoke.input, previewFingerprint: revoke.previewFingerprint, reviewed: true }, "http-revoke")).status, 200);
  } finally { await api.close(); }
}));
