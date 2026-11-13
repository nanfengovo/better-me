import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as next, setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { EvidenceHarvester, type HarvesterModel } from "../src/evidence-harvester/service.js";
import { GitEvidenceSource } from "../src/evidence-harvester/git-source.js";
import { SqliteHarvesterLedger } from "../src/evidence-harvester/sqlite-ledger.js";
import { HarvesterError, type HarvesterPolicy, type HarvesterRuntime, type HarvesterWorkspaceAdapter, type HarvesterProposalReceipt } from "../src/evidence-harvester/types.js";

const exec = promisify(execFile);
const runtime: HarvesterRuntime = { id: "synthetic-local", location: "local", endpointFingerprint: "a".repeat(64), model: "synthetic", modelDigest: "b".repeat(64) };
const content = "export const state = 'review';";
const response = () => JSON.stringify({ kind: "proposal", title: "状态转换线索", summary: "项目代码新增 review 状态。", contributionQuestion: "这次变更中你负责实现还是设计？",
  citationIds: ["e1"] });
const policy = (): HarvesterPolicy => ({ expiresAt: Date.now() + 60_000, maxCommitsPerDay: 10, maxModelCallsPerDay: 10, maxInputBytes: 20_000, maxOutputBytes: 8000, maxActiveMs: 3000 });

async function fixture(t: TestContext, overrides: { complete?: HarvesterModel["complete"]; workspace?: HarvesterWorkspaceAdapter; binding?: HarvesterModel["binding"] } = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-harvester-service-")), directory = await fs.realpath(temp);
  const root = path.join(directory, "repo"), store = path.join(directory, "private"); await fs.mkdir(root);
  const git = async (...args: string[]) => (await exec("git", args, { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } })).stdout.trim();
  await git("init", "--initial-branch=main"); await git("config", "user.name", "Synthetic"); await git("config", "user.email", "synthetic@example.invalid");
  const commit = async (text: string) => { await fs.writeFile(path.join(root, "state.ts"), text); await git("add", "state.ts"); await git("commit", "-m", "synthetic"); return git("rev-parse", "HEAD"); };
  await commit("export const initial = true;");
  let calls = 0, writes = 0, valid = true;
  const receipts = new Map<string, HarvesterProposalReceipt>();
  const workspace: HarvesterWorkspaceAdapter = overrides.workspace ?? {
    findReceipt: async key => receipts.get(key),
    propose: async input => { writes++; assert.equal(input.entry.personalContribution, "unknown"); assert.equal(input.consent, true);
      const receipt = { id: `receipt-${writes}`, proposalId: `proposal-${writes}`, status: "pending_business_review" as const }; receipts.set(input.idempotencyKey, receipt); return receipt; },
  };
  const model: HarvesterModel = { binding: overrides.binding ?? (async () => runtime), complete: async input => { calls++; assert.ok(input.signal); assert.doesNotMatch(input.prompt, /synthetic@example.invalid/); return overrides.complete ? overrides.complete(input) : response(); } };
  const ledger = new SqliteHarvesterLedger("owner-a", store), service = new EvidenceHarvester({ ledger, model, workspace });
  t.after(async () => { service.close(); ledger.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const access = { session: "session-a", valid: async () => valid };
  const subscribe = async (limits = policy()) => { const preview = await service.preview(root, access); return service.subscribe({ previewId: preview.previewId, runtime, policy: limits, consent: true, idempotencyKey: preview.previewId }, access); };
  return { service, ledger, root, store, directory, commit, git, access, subscribe, receipts, model, workspace, calls: () => calls, writes: () => writes, invalidate: () => { valid = false; } };
}
const code = (value: string) => (error: unknown) => error instanceof HarvesterError && error.code === value;

test("real commit → local proposal → personal review → Workspace receipt, with no direct Fact write", async t => {
  const f = await fixture(t), sub = await f.subscribe(), commit = await f.commit(content);
  const batch = await f.service.poll(sub.id, f.access), entry = batch.entries[0]!;
  assert.equal(entry.status, "awaiting_review"); assert.equal(entry.personalContribution, "unknown"); assert.equal(entry.citations[0]?.quote, content);
  assert.equal(f.calls(), 1); assert.equal(f.writes(), 0); assert.equal(f.ledger.read().subscriptions[0]?.cursor, commit);
  await assert.rejects(f.service.propose(entry.id, true, f.access), code("micro_fact_contribution_not_claimed"));
  await f.service.review(entry.id, { kind: "design", action: "我提出了 review 状态的设计方案", role: "设计", deployment: "未实现上线" }, f.access);
  const saved = await f.service.propose(entry.id, true, f.access);
  assert.equal(saved.status, "proposal_created"); assert.equal(saved.proposalReceipt?.status, "pending_business_review"); assert.equal(f.writes(), 1);
  assert.equal((await f.service.propose(entry.id, true, f.access)).proposalReceipt?.id, saved.proposalReceipt?.id); assert.equal(f.writes(), 1);
  assert.ok(saved.limitations.some(item => item.includes("不是 Verified Fact")));
});

test("SQLite owner validation, rollback, capacity validation and synchronous transactions", async t => {
  const f = await fixture(t), before = f.ledger.read();
  assert.throws(() => new SqliteHarvesterLedger("owner-b", f.store), code("harvester_store_owner_mismatch"));
  assert.throws(() => f.ledger.transact(state => { state.ownerId = "other"; throw Error("rollback"); }), /rollback/);
  assert.deepEqual(f.ledger.read(), before);
  assert.throws(() => f.ledger.transact(async state => { state.revision++; }), code("async_harvester_transaction_denied"));
  assert.deepEqual(f.ledger.read(), before);
  const second = new SqliteHarvesterLedger("owner-a", f.store); t.after(() => second.close());
  assert.throws(() => f.ledger.transact(() => second.transact(state => { state.revision++; })), /locked/);
  assert.deepEqual(f.ledger.read(), before);
});

test("owner-private store denies symlinks and world-readable SQLite files", async t => {
  const f = await fixture(t), link = path.join(f.directory, "linked"); await fs.symlink(f.store, link);
  assert.throws(() => new SqliteHarvesterLedger("owner-a", link), code("unsafe_harvester_store"));
  if (process.platform !== "win32") { await fs.chmod(path.join(f.store, "acquisition.sqlite"), 0o644);
    assert.throws(() => new SqliteHarvesterLedger("owner-a", f.store), code("unsafe_harvester_store")); }
});

test("subscription pins preview, consent, session, local runtime and expiry before any model call", async t => {
  const f = await fixture(t), p = await f.service.preview(f.root, f.access), base = { previewId: p.previewId, runtime, policy: policy(), consent: true as const, idempotencyKey: "one" };
  await assert.rejects(f.service.subscribe({ ...base, consent: false as unknown as true }, f.access), code("explicit_harvester_consent_required"));
  await assert.rejects(f.service.subscribe({ ...base, runtime: { ...runtime, modelDigest: "c".repeat(64) } }, f.access), code("harvester_runtime_changed"));
  await assert.rejects(f.service.subscribe({ ...base, policy: { ...policy(), expiresAt: Date.now() - 1 } }, f.access), code("invalid_harvester_expiry"));
  await assert.rejects(f.service.subscribe(base, { ...f.access, session: "other" }), code("repository_preview_expired"));
  const saved = await f.service.subscribe(base, f.access); assert.equal((await f.service.subscribe(base, f.access)).id, saved.id);
  await assert.rejects(f.service.subscribe({ ...base, policy: { ...base.policy, maxCommitsPerDay: 2 } }, f.access), code("harvester_idempotency_conflict")); assert.equal(f.calls(), 0);
});

test("changed preview and rewritten history never silently broaden the repository scope", async t => {
  const f = await fixture(t), p = await f.service.preview(f.root, f.access); await f.commit(content);
  await assert.rejects(f.service.subscribe({ previewId: p.previewId, runtime, policy: policy(), consent: true, idempotencyKey: "changed" }, f.access), code("repository_preview_changed"));
});

test("same commit is deduplicated and daily budgets charge attempts without automatic retry", async t => {
  const f = await fixture(t), sub = await f.subscribe({ ...policy(), maxCommitsPerDay: 1, maxModelCallsPerDay: 1 }), commit = await f.commit(content);
  const entries = await Promise.all([f.service.capture(sub.id, commit, f.access), f.service.capture(sub.id, commit, f.access)]);
  assert.equal(entries[0]?.id, entries[1]?.id); assert.equal(f.calls(), 1); assert.equal(f.ledger.read().entries.length, 1);
  const next = await f.commit(`${content}\n// next`);
  await assert.rejects(f.service.capture(sub.id, next, f.access), code("harvester_daily_budget"));
  assert.equal(f.ledger.read().subscriptions[0]?.usage.modelCalls, 1);
});

test("invalid citations and leaked secrets remain failed candidate artifacts, never facts or automatic retries", async t => {
  for (const output of [response().replace("e1", "invented"), '{"kind":"proposal","title":"x","summary":"api_key = \\"synthetic-secret-value\\""}', "not-json"]) {
    const f = await fixture(t, { complete: async () => output }), sub = await f.subscribe(), commit = await f.commit(content);
    const entry = await f.service.capture(sub.id, commit, f.access);
    assert.equal(entry.status, "failed"); assert.equal(entry.citations.length, 0); assert.equal(f.writes(), 0);
    await f.service.capture(sub.id, commit, f.access); assert.equal(f.calls(), 1);
  }
});

test("revocation aborts in-flight model and late output cannot enter the review inbox", async t => {
  let release!: (value: string) => void, started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture(t, { complete: async () => { started(); return new Promise(resolve => { release = resolve; }); } });
  const sub = await f.subscribe(), commit = await f.commit(content), running = f.service.capture(sub.id, commit, f.access);
  await ready; await f.service.revoke(sub.id, f.access); release(response());
  assert.equal((await running).status, "interrupted"); assert.equal(f.ledger.read().entries[0]?.citations.length, 0);
  await assert.rejects(f.service.capture(sub.id, commit, f.access), code("harvester_subscription_not_active"));
});

test("late account/session invalidity rejects response publication", async t => {
  const f = await fixture(t, { complete: async () => { f.invalidate(); return response(); } }), sub = await f.subscribe(), commit = await f.commit(content);
  await assert.rejects(f.service.capture(sub.id, commit, f.access), code("harvester_interaction_invalid"));
  assert.equal(f.ledger.read().entries[0]?.status, "failed"); assert.equal(f.ledger.read().entries[0]?.citations.length, 0);
});

test("a model ignoring AbortSignal is bounded and late promise resolution is discarded", async t => {
  // The production deadline covers Git capture as well as generation. Keep a
  // deliberately slow preparation step, but drive THIS test's 200ms deadline
  // only after a real complete() handshake. Otherwise CPU contention can
  // legitimately exhaust the deadline before the model was ever dispatched.
  const capture = GitEvidenceSource.prototype.capture;
  t.mock.method(GitEvidenceSource.prototype, "capture", async function (this: GitEvidenceSource, ...args: Parameters<GitEvidenceSource["capture"]>) { await delay(250); return capture.apply(this, args); });
  const deadline = new AbortController(), nativeTimeout = AbortSignal.timeout.bind(AbortSignal); let deadlineRequests = 0;
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => { if (milliseconds !== 200) return nativeTimeout(milliseconds); deadlineRequests++; return deadline.signal; });
  let started!: () => void, release!: (value: string) => void, modelSignal: AbortSignal | undefined;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture(t, { complete: async input => { modelSignal = input.signal; assert.equal(input.budget.maxActiveMs, 200); started(); return new Promise(resolve => { release = resolve; }); } });
  const sub = await f.subscribe({ ...policy(), maxActiveMs: 200 }), commit = await f.commit(content), start = Date.now(), running = f.service.capture(sub.id, commit, f.access);
  const first = await Promise.race([ready.then(() => "model-started"), running.then(entry => `capture-finished:${entry.errorCode}`)]);
  assert.equal(first, "model-started"); assert.equal(deadlineRequests, 1); assert.equal(f.calls(), 1); assert.equal(modelSignal?.aborted, false);
  deadline.abort(new DOMException("Synthetic 200ms capture deadline elapsed", "TimeoutError"));
  const entry = await running;
  assert.equal(entry.status, "failed"); assert.ok(Date.now() - start < 2000); assert.equal(f.calls(), 1);
  assert.equal(entry.errorCode, "harvester_cancelled_or_timed_out"); assert.equal(modelSignal?.aborted, true); assert.equal(entry.citations.length, 0); assert.equal(f.writes(), 0);
  const beforeLateResolution = f.ledger.read(); release(response()); await next(); await next();
  assert.deepEqual(f.ledger.read(), beforeLateResolution, "late valid model output cannot publish or change the failed entry");
  assert.equal((await f.service.capture(sub.id, commit, f.access)).status, "failed"); assert.equal(f.calls(), 1, "a timed-out attempt is not automatically retried");
});

test("restart preserves historical inbox but pauses every execution authorization", async t => {
  const f = await fixture(t), sub = await f.subscribe(), commit = await f.commit(content); await f.service.capture(sub.id, commit, f.access); f.service.close();
  const second = new EvidenceHarvester({ ledger: f.ledger, model: f.model, workspace: f.workspace }); t.after(() => second.close());
  assert.equal(f.ledger.read().entries[0]?.status, "awaiting_review"); assert.equal(f.ledger.read().subscriptions[0]?.status, "needs_authorization");
  await assert.rejects(second.poll(sub.id, f.access), code("harvester_subscription_not_active")); assert.equal(f.calls(), 1);
});

test("unknown Workspace result can only reconcile its receipt, not resend the proposal", async t => {
  let calls = 0, receipt: HarvesterProposalReceipt | undefined;
  const f = await fixture(t, { workspace: { findReceipt: async () => receipt, propose: async () => { calls++; receipt = { id: "receipt", proposalId: "proposal", status: "pending_business_review" }; throw Error("connection-lost-after-save"); } } });
  const sub = await f.subscribe(), commit = await f.commit(content), entry = await f.service.capture(sub.id, commit, f.access);
  await f.service.review(entry.id, { kind: "implementation", action: "本人新增了状态转换", role: "实现", deployment: "本地" }, f.access);
  await assert.rejects(f.service.propose(entry.id, true, f.access), /connection-lost/);
  await assert.rejects(f.service.propose(entry.id, true, f.access), code("micro_fact_contribution_not_claimed"));
  assert.equal((await f.service.reconcile(entry.id, f.access)).outcome, "receipt_found"); assert.equal(calls, 1);
});

test("watcher is explicit, low-frequency, removable and never installs or overwrites Git hooks", async t => {
  const f = await fixture(t), sub = await f.subscribe(), hook = path.join(f.root, ".git", "hooks", "post-commit"), original = "#!/bin/sh\n# preserve me\n";
  await fs.writeFile(hook, original);
  await assert.rejects(f.service.installWatcher(sub.id, 1, true, f.access), code("invalid_harvester_watch_policy"));
  const installed = await f.service.installWatcher(sub.id, 60_000, true, f.access); assert.equal(installed.usesGitHooks, false); assert.equal(installed.persistsAcrossRestart, false);
  f.service.uninstallWatcher(sub.id); assert.equal(await fs.readFile(hook, "utf8"), original); assert.equal(f.calls(), 0);
});

test("not-mine and unknown reviews cannot be sent as personal contribution proposals", async t => {
  const f = await fixture(t), sub = await f.subscribe(), commit = await f.commit(content), entry = await f.service.capture(sub.id, commit, f.access);
  for (const kind of ["not-mine", "unknown"] as const) {
    await f.service.review(entry.id, { kind, note: "不认领" }, f.access);
    await assert.rejects(f.service.propose(entry.id, true, f.access), code("micro_fact_contribution_not_claimed"));
  }
});
