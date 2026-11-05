import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { syntheticJobComparison } from "@better-me/agent-contracts";
import { CareerCapabilities } from "../src/capabilities/service.js";
import { fixtureSource } from "./fixtures/capability-source.js";

// Deterministic external model substitute ONLY for regressions, never real-generation acceptance.
export async function fixture(t: { after: (fn: () => Promise<void>) => void }, builder?: ConstructorParameters<typeof CareerCapabilities>[0]["builder"],
  onCheckpoint?: ConstructorParameters<typeof CareerCapabilities>[0]["onCheckpoint"]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-capability-test-"));
  const service = new CareerCapabilities({ directory, ownerId: "alice", builder: builder ?? (async () => ({ source: fixtureSource,
    provider: "regression-substitute", model: "fixture", promptHash: "fixture", durationMs: 0 })), onCheckpoint });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return service;
}
export const request = (key = "logical-operation-1", revision = 0, round = 1) => ({ input: syntheticJobComparison(round),
  idempotencyKey: key, expectedCatalogRevision: revision, consent: true as const, model: "gemma4:e2b-it-qat" as const });
export const access = (session = "session-a") => ({ session, valid: async () => true });

test("first qualified generated tool saves a private report; new input executes same version without building", async t => {
  const service = await fixture(t);
  const first = await service.start(request(), access()); await service.settled();
  const a = (await service.snapshot()).tasks.find(task => task.id === first.id)!;
  assert.equal(a.stage, "completed"); assert.equal(a.builderCalls, 1);
  assert.equal(a.qualification?.status, "passed"); assert.equal(a.taskVerification?.status, "passed");
  assert.equal(a.output?.changes[0]?.added[0], "PostgreSQL"); assert.ok(a.receipt);
  const second = await service.start(request("logical-operation-2", 1, 2), access()); await service.settled();
  const b = (await service.snapshot()).tasks.find(task => task.id === second.id)!;
  assert.equal(b.stage, "completed"); assert.equal(b.builderCalls, 0);
  assert.deepEqual(b.selected, a.selected); assert.notEqual(b.inputHash, a.inputHash);
  assert.notEqual(b.receipt?.id, a.receipt?.id); assert.equal(b.output?.changes[0]?.added[0], "Kubernetes");
  assert.ok(!JSON.stringify(b).includes("FIRST-ONLY-CANARY-7319"));
});

test("concurrent logical tasks serialize one build and produce separate, persistent idempotent receipts", async t => {
  const service = await fixture(t);
  const [a, same, b] = await Promise.all([service.start(request(), access()), service.start(request(), access()),
    service.start(request("concurrent-operation-2", 0, 2), access())]);
  assert.equal(a.id, same.id); assert.notEqual(a.id, b.id); await service.settled();
  const saved = await service.snapshot(); assert.equal(saved.tasks.length, 2); assert.equal(saved.versions.length, 1);
  assert.equal(saved.tasks.reduce((sum, task) => sum + task.builderCalls, 0), 1);
  assert.ok(saved.tasks.every(task => task.stage === "completed"));
  const replay = await service.start(request(), access()); assert.equal(replay.receipt?.id, saved.tasks[0]?.receipt?.id);
  await assert.rejects(service.start(request("logical-operation-1", 0, 2), access()), /idempotency_input_conflict/);
  await assert.rejects(service.start(request("stale-catalog-operation", 0), access()), /catalog_revision_conflict/);
});

test("incorrect generated candidates fail independent validation and exhaust bounded repair without publication", async t => {
  const service = await fixture(t, async () => ({ source: "() => []", provider: "regression-substitute", model: "wrong", promptHash: "fixture", durationMs: 0 }));
  await service.start(request(), access()); await service.settled();
  const state = await service.snapshot(), task = state.tasks[0]!;
  assert.equal(task.stage, "failed"); assert.equal(task.builderCalls, 3); assert.equal(task.error, "build_budget_exhausted");
  assert.equal(state.versions.length, 0); assert.equal(task.receipt, undefined);
  assert.ok(task.builds.every(build => build.qualification?.status === "failed"));
});

for (const mode of ["revoke", "switch-account"] as const) for (const boundary of ["build", "qualification", "publish", "execution", "commit"] as const) {
  test(`${mode} at ${boundary} blocks all subsequent promotion/report acceptance, including late results`, async t => {
    const reached = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>(); let paused = false;
    const service = await fixture(t, undefined, async event => {
      const hit = boundary === "build" ? event.detail.startsWith("正在真实生成候选")
        : boundary === "qualification" ? event.detail === "工具资格验证通过"
        : boundary === "publish" ? event.detail.startsWith("资格通过；")
        : boundary === "execution" ? event.detail === "执行本次生成的固定版本"
        : event.detail.startsWith("本次结果通过；");
      if (hit && !paused) { paused = true; reached.resolve(); await resume.promise; }
    });
    const task = await service.start(request(), access()); await reached.promise;
    if (mode === "revoke") await service.revoke(task.id, access()); else await service.invalidateSession("session-a");
    resume.resolve(); await service.settled();
    const saved = await service.snapshot(); assert.equal(saved.tasks[0]?.stage, "cancelled");
    assert.equal(saved.tasks[0]?.receipt, undefined); assert.ok(saved.versions.every(version => version.state !== "reusable"));
  });
}

test("A→B→A invalidates the original interaction, even when a builder ignores cancellation", async t => {
  const reached = Promise.withResolvers<void>(), output = Promise.withResolvers<void>();
  const service = await fixture(t, async () => { reached.resolve(); await output.promise;
    return { source: fixtureSource, provider: "regression-substitute", model: "late", promptHash: "fixture", durationMs: 0 }; });
  const original = await service.start(request(), access()); await reached.promise;
  await service.invalidateSession("session-a");
  output.resolve(); await service.settled();
  assert.equal((await service.snapshot()).tasks[0]?.stage, "cancelled");
  assert.equal((await service.snapshot()).tasks[0]?.receipt, undefined);
  await assert.rejects(service.start(request("old-session-new-task"), access()), /interaction_lease_invalid/);
  const next = await service.start(request("new-session-new-task"), access("session-a-new")); await service.settled();
  assert.notEqual(original.id, next.id); assert.equal((await service.snapshot()).tasks[1]?.stage, "completed");
});

test("acceptance before revocation keeps its honest receipt, while disabling a version preserves history and CAS", async t => {
  const service = await fixture(t); await service.start(request(), access()); await service.settled();
  const before = await service.snapshot(), saved = before.tasks[0]!;
  await service.revoke(saved.id, access()); assert.deepEqual((await service.snapshot()).tasks[0]?.receipt, saved.receipt);
  const results = await Promise.allSettled([service.disable(1, 1, access()), service.disable(1, 1, access())]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal((await service.snapshot()).versions[0]?.state, "disabled");
  assert.deepEqual((await service.snapshot()).tasks[0]?.output, saved.output);
  await service.start(request("after-disable-new-task", 2, 2), access()); await service.settled();
  const after = await service.snapshot(); assert.equal(after.versions.length, 2); assert.equal(after.tasks[1]?.selected?.version, 2);
  assert.equal(after.versions[0]?.state, "disabled"); assert.deepEqual(after.tasks[0]?.receipt, saved.receipt);
  await service.revalidate(1, 3, access());
  await service.disable(2, 4, access());
  await service.start(request("rollback-future-selection", 5, 2), access()); await service.settled();
  const rolledBack = await service.snapshot();
  assert.equal(rolledBack.tasks[2]?.selected?.version, 1); assert.equal(rolledBack.tasks[2]?.builderCalls, 0);
  assert.equal(rolledBack.versions[0]?.revalidations?.[0]?.status, "passed");
  assert.deepEqual(rolledBack.tasks[0]?.receipt, saved.receipt); assert.deepEqual(rolledBack.tasks[0]?.output, saved.output);
});

test("late catalog management cannot borrow a new login's authorization", async t => {
  const service = await fixture(t); await service.start(request(), access()); await service.settled();
  await service.invalidateSession("session-a");
  await assert.rejects(service.disable(1, 1, access()), /interaction_lease_invalid/);
  assert.equal((await service.snapshot()).versions[0]?.state, "reusable");
});
