import assert from "node:assert/strict";
import test from "node:test";
import { createReplayRun, runReplaySteps, forkReplayCheckpoint, validateReplayCheckpoint } from "../src/career-intelligence/replay.ts";
import { intelligenceHash } from "../src/career-intelligence/snapshots.ts";

class AppendOnlyStore {
  records = new Map(); heads = new Map(); appendCount = 0; failAppendAt = null;
  async read(id) { const record = this.records.get(id); return record ? structuredClone(record) : undefined; }
  async head(id) { return this.heads.get(id) ?? null; }
  async append(checkpoint, { expectedHeadId }) {
    this.appendCount++;
    if (this.appendCount === this.failAppendAt) throw new Error("simulated persistent storage failure");
    if (this.records.has(checkpoint.id)) throw new Error("immutable checkpoint ID");
    if ((this.heads.get(checkpoint.runId) ?? null) !== expectedHeadId) throw new Error("head CAS conflict");
    await validateReplayCheckpoint(checkpoint);
    this.records.set(checkpoint.id, structuredClone(checkpoint)); this.heads.set(checkpoint.runId, checkpoint.id);
  }
  restarted() {
    const next = new AppendOnlyStore();
    next.records = new Map([...this.records].map(([id, value]) => [id, JSON.parse(JSON.stringify(value))])); next.heads = new Map(this.heads);
    return next;
  }
}
const binding = { ownerId: "synthetic-owner", workspaceId: "synthetic-workspace", sessionGeneration: "session-1", factRevision: "facts-v1", rulesVersion: "rules-v1" };
const input = { hypothesis: "original", selectedFactIds: ["fact-1"] };
const steps = [1, 2, 3].map(index => ({ id: `analysis-${index}`, kind: "analysis", operation: "typed-review", input: { index } }));
const analysisRunner = async step => ({ kind: "analysis", summary: `Public result for ${step.id}`, artifact: { type: "report", data: { stepId: step.id } } });
async function authority(id, suppliedInput = input, approvedEffects = []) {
  return { id, binding, purpose: "checkpoint_replay", expiresAt: "2099-01-01T00:00:00.000Z", inputFingerprint: await intelligenceHash(suppliedInput), graphVersion: "graph-v1",
    analysisStepIds: steps.map(step => step.id), approvedNewEffectKeys: approvedEffects.map(step => step.effectKey),
    effectApprovals: await Promise.all(approvedEffects.map(async step => ({ effectKey: step.effectKey, stepHash: await intelligenceHash(step) }))) };
}
async function start(store, runId = "run-original") { return createReplayRun({ runId, binding, graphVersion: "graph-v1", input }, store); }
const isCurrent = () => true;

test("typed replay persists each action/result, restarts from the head and truly skips completed N analysis steps", async () => {
  const store = new AppendOnlyStore(), initial = await start(store), original = structuredClone(initial), firstAuth = await authority("grant-1");
  const first = await runReplaySteps(initial.id, input, steps, firstAuth, { store, runner: analysisRunner, isCurrent, budget: { maxSteps: 2 } });
  assert.equal(first.status, "budget_exhausted");
  assert.deepEqual(first.executedSteps, ["analysis-1", "analysis-2"]);
  assert.equal(first.checkpoint.analysisOutputs.length, 2);
  assert.deepEqual(await store.read(initial.id), original);
  const restarted = store.restarted(), called = [];
  const resumed = await runReplaySteps(first.checkpoint.id, input, steps, await authority("fresh-grant-2"), { store: restarted, isCurrent,
    runner: async step => { called.push(step.id); return analysisRunner(step); } });
  assert.equal(resumed.status, "completed");
  assert.deepEqual(called, ["analysis-3"]);
  assert.deepEqual(resumed.skippedAnalysisSteps, ["analysis-1", "analysis-2"]);
  assert.equal(resumed.checkpoint.analysisOutputs.length, 3);
  assert.ok(resumed.checkpoint.forbiddenAuthorityIds.includes("grant-1"), "all earlier execution grants remain forbidden, not only the last one");
  assert.equal(resumed.checkpoint.observations.length, 6);
  assert.match(resumed.limitations.join(" "), /not model-private chain of thought/);
  assert.deepEqual(await store.read(initial.id), original);
});

test("forking exactly checkpoint N preserves only prior outputs, not later history or old authority", async () => {
  const store = new AppendOnlyStore(), initial = await start(store);
  const one = await runReplaySteps(initial.id, input, [steps[0]], await authority("old-authority"), { store, runner: analysisRunner, isCurrent });
  const later = await runReplaySteps(one.checkpoint.id, input, steps, await authority("later-authority"), { store, runner: analysisRunner, isCurrent });
  const changedInput = { ...input, hypothesis: "new explicit assumption" }, newAuth = await authority("fresh-fork-authority", changedInput);
  const fork = await forkReplayCheckpoint(one.checkpoint.id, { newRunId: "fork-run", binding, input: changedInput, assumptionPatch: { hypothesis: "new explicit assumption" }, freshAuthority: newAuth }, store, isCurrent);
  assert.equal(fork.analysisOutputs.length, 1);
  assert.equal(fork.analysisOutputs[0].inherited, true);
  assert.equal(fork.analysisOutputs[0].originRunId, initial.runId);
  assert.notEqual(fork.analysisOutputs[0].inputFingerprint, fork.inputFingerprint);
  assert.equal(fork.lastAuthorityId, null);
  assert.ok(fork.forbiddenAuthorityIds.includes("old-authority"));
  const called = [];
  const continued = await runReplaySteps(fork.id, changedInput, steps, newAuth, { store, isCurrent, runner: async step => { called.push(step.id); return analysisRunner(step); } });
  assert.deepEqual(called, ["analysis-2", "analysis-3"]);
  assert.deepEqual(continued.skippedAnalysisSteps, ["analysis-1"]);
  assert.deepEqual(await store.read(later.checkpoint.id), later.checkpoint, "fork cannot rewrite original later history");
  await assert.rejects(forkReplayCheckpoint(one.checkpoint.id, { newRunId: "bad-fork", binding, input, assumptionPatch: null, freshAuthority: await authority("old-authority") }, store, isCurrent), /fresh_fork_authority_required/);
});

test("historical successful effects are display-only after fork and never dispatched again", async () => {
  const store = new AppendOnlyStore(), initial = await start(store), effect = { id: "save-proposal", kind: "effect", operation: "host-confirmed-save", input: { proposal: "synthetic" }, effectKey: "save-unique-1" };
  let effects = 0;
  const runner = async step => step.kind === "analysis" ? analysisRunner(step) : (effects++, { kind: "effect", outcome: "succeeded", receiptId: "host-receipt-1" });
  const done = await runReplaySteps(initial.id, input, [steps[0], effect], await authority("old-authority", input, [effect]), { store, isCurrent, runner });
  assert.equal(done.status, "completed"); assert.equal(effects, 1);
  const fresh = await authority("new-fork-authority", input, [effect]);
  const fork = await forkReplayCheckpoint(done.checkpoint.id, { newRunId: "effect-fork", binding, input, assumptionPatch: null, freshAuthority: fresh }, store, isCurrent);
  assert.equal(fork.effectHistory[0].inherited, true); assert.equal(fork.effectHistory[0].originRunId, initial.runId);
  const replayed = await runReplaySteps(fork.id, input, [steps[0], effect], fresh, { store, isCurrent, runner });
  assert.equal(replayed.status, "partial"); assert.deepEqual(replayed.blockedEffectKeys, [effect.effectKey]); assert.equal(effects, 1);
  assert.deepEqual(replayed.executedSteps, []);
});

test("unknown effects after a crash/lost response cannot auto-retry on resume", async () => {
  const store = new AppendOnlyStore(), initial = await start(store), effect = { id: "delivery", kind: "effect", operation: "confirmed-delivery", input: {}, effectKey: "delivery-1" };
  let effects = 0;
  const failed = await runReplaySteps(initial.id, input, [effect], await authority("grant-1", input, [effect]), { store, isCurrent,
    runner: async () => { effects++; throw new Error("secret network trace must not leak"); } });
  assert.equal(failed.status, "partial"); assert.equal(failed.checkpoint.effectHistory[0].outcome, "unknown");
  assert.doesNotMatch(JSON.stringify(failed), /secret network trace/);
  const resumed = await runReplaySteps(failed.checkpoint.id, input, [effect], await authority("grant-2", input, [effect]), { store, isCurrent, runner: async () => { effects++; throw new Error("must not dispatch"); } });
  assert.equal(effects, 1); assert.deepEqual(resumed.blockedEffectKeys, [effect.effectKey]);
});

test("post-effect storage failure retains durable unknown and still prevents duplicate external writes", async () => {
  const store = new AppendOnlyStore(), initial = await start(store), effect = { id: "save", kind: "effect", operation: "confirmed-save", input: {}, effectKey: "save-1" };
  store.failAppendAt = 3; let effects = 0;
  const result = await runReplaySteps(initial.id, input, [effect], await authority("grant-1", input, [effect]), { store, isCurrent,
    runner: async () => { effects++; return { kind: "effect", outcome: "succeeded", receiptId: "receipt" }; } });
  assert.equal(result.status, "storage_conflict"); assert.equal(result.checkpoint.effectHistory[0].outcome, "unknown");
  const resumed = await runReplaySteps(result.checkpoint.id, input, [effect], await authority("grant-2", input, [effect]), { store, isCurrent,
    runner: async () => { effects++; return { kind: "effect", outcome: "succeeded", receiptId: "receipt" }; } });
  assert.equal(effects, 1); assert.equal(resumed.status, "partial");
});

test("late results after cancellation or session/source changes remain unknown and unadopted", async () => {
  for (const mode of ["cancel", "stale"]) {
    const store = new AppendOnlyStore(), initial = await start(store), controller = new AbortController(); let current = true;
    const result = await runReplaySteps(initial.id, input, [steps[0]], await authority("grant-1"), { store, signal: controller.signal, isCurrent: () => current,
      runner: async step => { if (mode === "cancel") controller.abort(); else current = false; return analysisRunner(step); } });
    assert.equal(result.status, mode === "cancel" ? "cancelled" : "stale"); assert.deepEqual(result.checkpoint.analysisOutputs, []);
  }
});

test("uncooperative runner has a finite deadline and does not leak mutable input/output references", async () => {
  const store = new AppendOnlyStore(), initial = await start(store);
  const timeout = await runReplaySteps(initial.id, input, [steps[0]], await authority("grant-1"), { store, isCurrent, budget: { maxDurationMs: 20 }, runner: () => new Promise(() => {}) });
  assert.equal(timeout.status, "budget_exhausted"); assert.deepEqual(timeout.checkpoint.analysisOutputs, []);
  const original = structuredClone(input);
  const result = await runReplaySteps(timeout.checkpoint.id, input, [steps[0]], await authority("fresh-grant"), { store, isCurrent,
    runner: async (step, context) => { context.input.hypothesis = "mutated"; context.authority.binding.ownerId = "changed"; return analysisRunner(step); } });
  assert.equal(result.status, "completed"); assert.deepEqual(input, original); assert.equal(result.checkpoint.binding.ownerId, binding.ownerId);
});

test("fresh grant/input/graph/action hashes, current head, step identity and checkpoint integrity are enforced", async () => {
  const store = new AppendOnlyStore(), initial = await start(store), auth = await authority("grant-1");
  const done = await runReplaySteps(initial.id, input, [steps[0]], auth, { store, isCurrent, runner: analysisRunner });
  assert.equal((await runReplaySteps(done.checkpoint.id, input, steps, auth, { store, isCurrent, runner: analysisRunner })).reason, "fresh_resume_authority_required");
  assert.equal((await runReplaySteps(initial.id, input, steps, await authority("fresh"), { store, isCurrent, runner: analysisRunner })).status, "storage_conflict");
  const changed = { ...steps[0], input: { index: 999 } };
  assert.equal((await runReplaySteps(done.checkpoint.id, input, [changed], await authority("fresh-2"), { store, isCurrent, runner: analysisRunner })).reason, "completed_step_definition_changed");
  await assert.rejects(runReplaySteps(done.checkpoint.id, { hypothesis: "changed" }, steps, await authority("fresh-3"), { store, isCurrent, runner: analysisRunner }), /replay_input_fingerprint_changed/);
  const tampered = structuredClone(done.checkpoint); tampered.analysisOutputs[0].summary = "tampered";
  await assert.rejects(validateReplayCheckpoint(tampered), /checkpoint_hash_changed/);
  const effect = { id: "effect", kind: "effect", operation: "confirmed-save", input: { target: "different" }, effectKey: "effect-1" }, scoped = await authority("fresh-4", input, [effect]);
  scoped.effectApprovals[0].stepHash = "0".repeat(64);
  const blocked = await runReplaySteps(done.checkpoint.id, input, [effect], scoped, { store, isCurrent, runner: async () => { throw new Error("must not execute"); } });
  assert.deepEqual(blocked.blockedEffectKeys, [effect.effectKey]); assert.deepEqual(blocked.executedSteps, []);
});
