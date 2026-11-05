import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, rename, symlink, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { syntheticEvidenceReview, type CapabilityTask } from "@better-me/agent-contracts";
import { CareerCapabilities } from "../src/capabilities/service.js";
import { fixtureSource } from "./fixtures/capability-source.js";

const access = { session: "synthetic-handoff-session", valid: async () => true };
const reviewCommand = (task: CapabilityTask, expectedRevision = 0, key = "review-redis-item") => ({ taskId: task.id,
  reportReceiptId: task.receipt!.id, reportHash: task.outputHash!, itemIndex: 1, expectedRevision, idempotencyKey: key, consent: true as const,
  decision: { kind: "implementation" as const, action: "本人实现了合成缓存的失效处理。", role: "实现者", deployment: "仅合成实验，未上线" } });
async function setup(t: { after: (fn: () => Promise<void>) => void }, onCheckpoint?: ConstructorParameters<typeof CareerCapabilities>[0]["onCheckpoint"]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-capability-handoff-"));
  const service = new CareerCapabilities({ directory, ownerId: "synthetic-alice", onCheckpoint, builder: async () => ({ source: fixtureSource,
    provider: "regression-substitute", model: "fixture", promptHash: "fixture", durationMs: 0 }) });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  await service.start({ ...syntheticEvidenceReview(2), intent: "prepare-evidence-review", idempotencyKey: "handoff-report-seed",
    expectedCatalogRevision: 0, consent: true, model: "gemma4:e2b-it-qat" }, access);
  await service.settled(); const task = (await service.snapshot()).tasks[0]!;
  assert.equal(task.stage, "completed");
  return { service, directory, task };
}

test("owner reviews their exact saved evidence item then creates a pending Workspace proposal without rewriting its report", async t => {
  const { service, task } = await setup(t);
  const review = await service.reviewEvidence({ taskId: task.id, reportReceiptId: task.receipt!.id, reportHash: task.outputHash!,
    itemIndex: 1, expectedRevision: 0, idempotencyKey: "review-redis-item", consent: true,
    decision: { kind: "implementation", action: "本人实现了合成缓存的失效处理。", role: "实现者", deployment: "仅合成实验，未上线" } }, access);
  assert.equal(review.decision.kind, "implementation"); assert.equal(review.source.requirement.text, "Redis");
  const proposal = await service.proposeEvidence({ reviewId: review.id, expectedRevision: 1, idempotencyKey: "propose-redis-item", consent: true }, access);
  assert.equal(proposal.status, "pending_business_review"); assert.equal(proposal.candidate.action, "本人实现了合成缓存的失效处理。");
  assert.equal(proposal.reviewId, review.id); assert.equal(proposal.source.reportReceiptId, task.receipt!.id);
  const state = await service.snapshot(); assert.equal(state.workspace?.proposals.length, 1); assert.equal(state.workspace?.revision, 2);
  assert.deepEqual(state.tasks[0], task); assert.equal(state.tasks[0]?.builderCalls, 1);
  assert.ok(!proposal.candidate.action.includes("EVIDENCE-SECOND-ONLY"));
});

test("concurrent different reviews cannot overwrite a revision; report binding and unclaimed actions fail closed", async t => {
  const { service, task } = await setup(t), command = reviewCommand(task);
  for (const invalid of [{ ...command, reportHash: "f".repeat(64) }, { ...command, itemIndex: 9999 },
    { ...command, reportReceiptId: "11111111-1111-4111-8111-111111111111" }])
    await assert.rejects(service.reviewEvidence(invalid, access), /evidence_report_binding_changed/);
  await assert.rejects(service.reviewEvidence({ ...command, decision: { ...command.decision, action: "不确定" } }, access), /personal_action_required/);
  const settled = await Promise.allSettled([service.reviewEvidence(command, access), service.reviewEvidence({ ...command,
    itemIndex: 2, idempotencyKey: "conflicting-review-other-item" }, access)]);
  assert.equal(settled.filter(item => item.status === "fulfilled").length, 1);
  const rejected = settled.find(item => item.status === "rejected"); assert.ok(rejected && rejected.status === "rejected");
  assert.match(String(rejected.reason), /workspace_revision_conflict/);
  const uncertain = await service.reviewEvidence({ ...reviewCommand(task, 1, "unknown-review-operation"), decision: { kind: "unknown", note: "需再核对" } }, access);
  await assert.rejects(service.proposeEvidence({ reviewId: uncertain.id, expectedRevision: 2, idempotencyKey: "unknown-proposal-operation", consent: true }, access), /personal_contribution_not_claimed/);
  assert.equal((await service.snapshot()).workspace?.revision, 2);
});

for (const commandKind of ["review", "proposal"] as const) for (const mode of ["revoke", "switch"] as const) {
  test(`a late Workspace ${commandKind} after ${mode} cannot accept a receipt or revive the old interaction`, async t => {
    const reached = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>(); let armed = false;
    t.after(async () => { resume.resolve(); });
    const { service, task } = await setup(t, async event => {
      if (armed && event.detail === `workspace-${commandKind}-before-acceptance`) { reached.resolve(); await resume.promise; }
    });
    const review = commandKind === "proposal" ? await service.reviewEvidence(reviewCommand(task), access) : undefined;
    const before = await service.snapshot(); armed = true;
    const pending = commandKind === "review" ? service.reviewEvidence(reviewCommand(task), access)
      : service.proposeEvidence({ reviewId: review!.id, expectedRevision: 1, idempotencyKey: "late-proposal-operation", consent: true }, access);
    const rejected = assert.rejects(pending, mode === "switch" ? /interaction_lease_invalid/ : /source_grant_revoked/);
    await reached.promise;
    if (mode === "switch") await service.invalidateSession(access.session); else await service.revoke(task.id, access);
    resume.resolve(); await rejected;
    const after = await service.snapshot(); assert.deepEqual(after.workspace, before.workspace); assert.deepEqual(after.tasks[0]?.receipt, task.receipt);
    if (mode === "switch") await assert.rejects(service.reviewEvidence(reviewCommand(task), access), /interaction_lease_invalid/);
  });
}

test("save failure issues no review receipt; retry and restart preserve exact history without model calls", async t => {
  const { service, directory, task } = await setup(t), command = reviewCommand(task);
  const filename = path.join(directory, "career-capabilities-v1.json"), backup = path.join(directory, "last-good.json");
  await rename(filename, backup); await symlink(backup, filename);
  await assert.rejects(service.reviewEvidence(command, access), /private_store_unavailable/);
  assert.equal((await service.snapshot()).workspace, undefined);
  await unlink(filename); await rename(backup, filename);
  const saved = await service.reviewEvidence(command, access); await service.close();
  const reopened = new CareerCapabilities({ directory, ownerId: "synthetic-alice", builder: async () => { throw Error("must_not_generate"); } });
  try {
    const again = await reopened.reviewEvidence(command, { session: "new-explicit-interaction", valid: async () => true });
    assert.deepEqual(again, saved); assert.equal(JSON.stringify((await reopened.snapshot()).tasks[0]), JSON.stringify(task));
    const proposal = await reopened.proposeEvidence({ reviewId: saved.id, expectedRevision: 1, idempotencyKey: "restart-proposal-operation", consent: true },
      { session: "new-explicit-interaction", valid: async () => true });
    assert.equal(proposal.candidate.action, command.decision.action);
  } finally { await reopened.close(); }
});

test("design stays design and a disabled source cannot authorize new proposals", async t => {
  const { service, task } = await setup(t);
  const review = await service.reviewEvidence({ ...reviewCommand(task), decision: { kind: "design", action: "只完成缓存失效方案设计。", role: "方案设计", deployment: "未实现" } }, access);
  const proposal = await service.proposeEvidence({ reviewId: review.id, expectedRevision: 1, idempotencyKey: "design-proposal-operation", consent: true }, access);
  assert.equal(proposal.candidate.kind, "design"); assert.ok(proposal.limitations.includes("仅声明设计方案，未声明实现或上线。"));
  await service.disable(1, 1, access);
  await assert.rejects(service.reviewEvidence({ ...reviewCommand(task, 2, "disabled-source-review") }, access), /current_verified_evidence_report_required/);
  assert.equal((await service.snapshot()).workspace?.proposals.length, 1);
});

test("a corrected personal review preserves history and invalidates old proposal creation; uncertain or unowned work cannot become a contribution", async t => {
  const { service, task } = await setup(t);
  const first = await service.reviewEvidence(reviewCommand(task), access);
  const proposal = await service.proposeEvidence({ reviewId: first.id, expectedRevision: 1, idempotencyKey: "first-proposal-key", consent: true }, access);
  const correction = await service.reviewEvidence({ ...reviewCommand(task, 2, "correct-personal-review"),
    decision: { kind: "not-mine", note: "此前认领有误，合成代码是同事实现的。" } }, access);
  assert.equal(correction.supersedes, first.id);
  await assert.rejects(service.proposeEvidence({ reviewId: first.id, expectedRevision: 3, idempotencyKey: "stale-proposal-key", consent: true }, access), /personal_review_superseded/);
  await assert.rejects(service.proposeEvidence({ reviewId: correction.id, expectedRevision: 3, idempotencyKey: "unowned-proposal-key", consent: true }, access), /personal_contribution_not_claimed/);
  const state = await service.snapshot(); assert.deepEqual(state.workspace?.reviews[0], first);
  assert.deepEqual(state.workspace?.proposals[0], { ...proposal, eligibility: "review_superseded" });
  assert.deepEqual(state.tasks[0], task); assert.equal(state.workspace?.revision, 3);
  assert.equal(state.workspace?.proposals[0]?.eligibility, "review_superseded", "Workspace, not just the UI, must mark an obsolete proposal");
});

test("same commands retrieve one receipt; changed input and fresh keys cannot create or rebind duplicate proposals", async t => {
  const { service, task } = await setup(t), command = reviewCommand(task);
  const [a, b] = await Promise.all([service.reviewEvidence(command, access), service.reviewEvidence(command, access)]);
  assert.equal(a.id, b.id); assert.equal(a.receipt.id, b.receipt.id);
  await assert.rejects(service.reviewEvidence({ ...command, decision: { ...command.decision, action: "不同的个人动作" } }, access), /workspace_idempotency_conflict/);
  const request = { reviewId: a.id, expectedRevision: 1, idempotencyKey: "one-proposal-operation", consent: true as const };
  const [p, q] = await Promise.all([service.proposeEvidence(request, access), service.proposeEvidence(request, access)]);
  assert.equal(p.id, q.id); assert.equal(p.receipt.id, q.receipt.id);
  await assert.rejects(service.proposeEvidence({ ...request, expectedRevision: 2, idempotencyKey: "duplicate-with-new-key" }, access), /proposal_already_exists/);
  assert.equal((await service.snapshot()).workspace?.proposals.length, 1);
});
