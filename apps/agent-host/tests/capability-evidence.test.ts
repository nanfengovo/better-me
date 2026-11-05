import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, rename, symlink, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { syntheticJobComparison, syntheticEvidenceReview } from "@better-me/agent-contracts";
import { CareerCapabilities } from "../src/capabilities/service.js";
import { fixtureSource } from "./fixtures/capability-source.js";

const access = { session: "synthetic-session", valid: async () => true };
const request = (key: string, revision: number) => ({ input: syntheticJobComparison(2), idempotencyKey: key,
  expectedCatalogRevision: revision, consent: true as const, model: "gemma4:e2b-it-qat" as const });
const evidence = { notes: [{ id: "evidence-1", project: "合成调度项目", source: "合成发布说明#3",
  excerpt: "项目使用 PostgreSQL；这是项目背景，不是我的贡献证明。", links: [{ rowIndex: 0, requirementIndex: 2,
    sourceNamespace: "synthetic:acme-board", jobId: "101", snapshotAt: "2026-11-04T00:00:00Z", text: "Kubernetes" }] }] };
async function setup(t: { after: (fn: () => Promise<void>) => void }, onCheckpoint?: ConstructorParameters<typeof CareerCapabilities>[0]["onCheckpoint"]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-capability-evidence-"));
  const service = new CareerCapabilities({ directory, ownerId: "synthetic-alice", onCheckpoint, builder: async () => ({ source: fixtureSource,
    provider: "regression-substitute", model: "fixture", promptHash: "fixture", durationMs: 0 }) });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { service, directory };
}

test("a second business task reuses the qualified tool, binds its own evidence, and saves only pending claims", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-capability-evidence-"));
  const service = new CareerCapabilities({ directory, ownerId: "synthetic-alice", builder: async () => ({ source: fixtureSource,
    provider: "regression-substitute", model: "fixture", promptHash: "fixture", durationMs: 0 }) });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  await service.start(request("first-comparison", 0), access); await service.settled();
  const original = (await service.snapshot()).tasks[0]!;
  const result = await service.start({ ...request("second-business", 1), intent: "prepare-evidence-review", evidence }, access);
  await service.settled();
  const saved = (await service.snapshot()).tasks.find(task => task.id === result.id)!;
  assert.equal(saved.stage, "completed"); assert.equal(saved.builderCalls, 0); assert.deepEqual(saved.selected, original.selected);
  assert.equal(saved.output, undefined); assert.equal(saved.evidenceReport?.items.length, 4);
  assert.deepEqual(saved.evidenceReport?.items[2]?.evidenceIds, ["evidence-1"]);
  assert.equal(saved.evidenceReport?.items[2]?.status, "needs_personal_confirmation");
  assert.equal(saved.evidenceReport?.items[0]?.status, "needs_evidence");
  assert.equal(saved.taskVerification?.status, "passed"); assert.ok(saved.composition?.recipeHash);
  assert.notEqual(saved.inputHash, original.inputHash); assert.notEqual(saved.receipt?.id, original.receipt?.id);
  assert.deepEqual((await service.snapshot()).tasks[0], original);
});

test("evidence report expansion cannot bypass the output budget or manufacture a saved receipt", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-capability-evidence-limit-"));
  const service = new CareerCapabilities({ directory, ownerId: "synthetic-alice", builder: async () => ({ source: fixtureSource,
    provider: "regression-substitute", model: "fixture", promptHash: "fixture", durationMs: 0 }) });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const input = syntheticJobComparison(2);
  input.after = { format: "board-v1", sourceNamespace: "s".repeat(1000), capturedAt: "2026-11-04T00:00:00Z",
    jobs: Array.from({ length: 20 }, (_, i) => ({ jobId: String(i), title: "t".repeat(1000), requirements: Array.from({ length: 100 }, () => "SQL") })) };
  await service.start({ ...request("expanded-evidence", 0), input, intent: "prepare-evidence-review", evidence: { notes: [] } }, access);
  await service.settled(); const saved = (await service.snapshot()).tasks[0]!;
  assert.equal(saved.stage, "failed"); assert.equal(saved.error, "evidence_report_output_limit"); assert.equal(saved.receipt, undefined);
});

test("new evidence changes the input binding; old links stay unresolved and prior notes never enter the new report", async t => {
  const { service } = await setup(t);
  const first = { ...request("evidence-input-binding", 0), ...syntheticEvidenceReview(1), intent: "prepare-evidence-review" as const };
  await service.start(first, access); await service.settled(); const before = (await service.snapshot()).tasks[0]!;
  const second = { ...request("evidence-input-binding", 1), ...syntheticEvidenceReview(2), intent: "prepare-evidence-review" as const };
  await assert.rejects(service.start(second, access), /idempotency_input_conflict/);
  second.evidence.notes[0]!.links.push({ ...second.evidence.notes[0]!.links[0]!, sourceNamespace: "another-source" });
  await service.start({ ...second, idempotencyKey: "evidence-second-operation" }, access); await service.settled();
  const after = (await service.snapshot()).tasks[1]!;
  assert.equal(after.stage, "completed"); assert.equal(after.builderCalls, 0); assert.notEqual(after.inputHash, before.inputHash);
  assert.equal(after.evidenceReport?.unresolvedLinks.length, 1); assert.equal(after.evidenceReport?.items[1]?.status, "needs_personal_confirmation");
  assert.equal(after.evidenceReport?.items[2]?.status, "needs_evidence");
  assert.ok(!JSON.stringify(after).includes("EVIDENCE-FIRST-ONLY-8421")); assert.deepEqual(after.composition, before.composition);
  await assert.rejects(service.start({ ...second, idempotencyKey: "comparison-cannot-read-evidence", intent: "compare-job-exports" }, access));
});

test("mixed business tasks share one build while keeping separate operation receipts and report types", async t => {
  const { service } = await setup(t);
  await Promise.all([service.start(request("mixed-comparison", 0), access), service.start({ ...request("mixed-evidence", 0),
    ...syntheticEvidenceReview(), intent: "prepare-evidence-review" }, access)]);
  await service.settled(); const state = await service.snapshot();
  assert.equal(state.versions.length, 1); assert.equal(state.tasks.reduce((sum, item) => sum + item.builderCalls, 0), 1);
  assert.ok(state.tasks[0]?.output); assert.equal(state.tasks[0]?.evidenceReport, undefined);
  assert.ok(state.tasks[1]?.evidenceReport); assert.equal(state.tasks[1]?.output, undefined);
  assert.notEqual(state.tasks[0]?.receipt?.id, state.tasks[1]?.receipt?.id);
});

for (const mode of ["revoke", "switch"] as const) for (const boundary of ["execution", "commit"] as const) {
  test(`evidence composition ${mode} before ${boundary} cannot accept a late business report`, async t => {
    const reached = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>(); let armed = false, paused = false;
    t.after(() => { resume.resolve(); return Promise.resolve(); });
    const { service } = await setup(t, async event => {
      if (armed && !paused && (boundary === "execution" ? event.detail.startsWith("命中同版本工具") : event.detail.startsWith("本次结果通过；"))) {
        paused = true; reached.resolve(); await resume.promise;
      }
    });
    await service.start(request("seed-qualified-tool", 0), access); await service.settled();
    const prior = (await service.snapshot()).tasks[0]!; armed = true;
    const task = await service.start({ ...request("late-evidence-operation", 1), ...syntheticEvidenceReview(), intent: "prepare-evidence-review" }, access);
    await reached.promise;
    if (mode === "revoke") await service.revoke(task.id, access); else await service.invalidateSession(access.session);
    resume.resolve(); await service.settled(); const state = await service.snapshot();
    assert.equal(state.tasks[1]?.stage, "cancelled"); assert.equal(state.tasks[1]?.receipt, undefined);
    assert.deepEqual(state.tasks[0], prior); assert.equal(state.versions[0]?.state, "reusable");
  });
}

test("evidence save-only recovery keeps the recipe and creates one receipt without rebuilding or rewriting prior reports", async t => {
  let faulted = false, filename = "", backup = "";
  const { service, directory } = await setup(t, async event => {
    if (!faulted && event.detail.startsWith("本次结果通过；")) { faulted = true; await rename(filename, backup); await symlink(backup, filename); }
  });
  filename = path.join(directory, "career-capabilities-v1.json"); backup = path.join(directory, "last-good.json");
  const task = await service.start({ ...request("evidence-save-failure", 0), ...syntheticEvidenceReview(), intent: "prepare-evidence-review" }, access);
  await service.settled(); const failed = (await service.snapshot()).tasks[0]!;
  assert.equal(failed.stage, "partial"); assert.ok(failed.evidenceReport); assert.equal(failed.receipt, undefined);
  await unlink(filename); await rename(backup, filename);
  const [a, b] = await Promise.all([service.retrySave(task.id, access), service.retrySave(task.id, access)]);
  assert.equal(a.id, b.id); const saved = (await service.snapshot()).tasks[0]!;
  assert.equal(saved.stage, "completed"); assert.equal(saved.builderCalls, 1); assert.deepEqual(saved.composition, failed.composition);
});
