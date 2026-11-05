import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, rename, symlink, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DocumentSchema } from "@better-me/core/document";
import { syntheticEvidenceReview } from "@better-me/agent-contracts";
import { CareerCapabilities } from "../src/capabilities/service.js";
import { fixtureSource } from "./fixtures/capability-source.js";

const access = { session: "synthetic-adoption-session", valid: async () => true };
const seedTarget = async (service: CareerCapabilities, proposalId: string, key = "create-synthetic-resume") => {
  const state = await service.snapshot();
  const asset = await service.createSyntheticResume({ name: "合成目标简历", expectedRevision: state.workspace!.revision, idempotencyKey: key, consent: true }, access);
  const target = asset.targets[0]!;
  return { asset, request: { kind: "adopt" as const, assetId: asset.id, proposalId, resumeId: target.resumeId,
    experienceId: target.experienceId, expectedVersionId: asset.headVersionId } };
};
async function setup(t: { after: (fn: () => Promise<void>) => void }, onCheckpoint?: ConstructorParameters<typeof CareerCapabilities>[0]["onCheckpoint"]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-adoption-"));
  const service = new CareerCapabilities({ directory, ownerId: "synthetic-adoption-owner", onCheckpoint,
    builder: async () => ({ source: fixtureSource, provider: "regression-substitute", model: "fixture", promptHash: "fixture", durationMs: 0 }) });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  await service.start({ ...syntheticEvidenceReview(2), intent: "prepare-evidence-review", expectedCatalogRevision: 0,
    idempotencyKey: "synthetic-source-task", consent: true, model: "gemma4:e2b-it-qat" }, access);
  await service.settled(); const task = (await service.snapshot()).tasks[0]!;
  const review = await service.reviewEvidence({ taskId: task.id, reportReceiptId: task.receipt!.id, reportHash: task.outputHash!, itemIndex: 1,
    expectedRevision: 0, idempotencyKey: "synthetic-review", consent: true,
    decision: { kind: "design", action: "本人仅设计合成缓存失效方案。", role: "方案设计", deployment: "未实现，未上线" } }, access);
  const proposal = await service.proposeEvidence({ reviewId: review.id, expectedRevision: 1, idempotencyKey: "synthetic-proposal", consent: true }, access);
  return { service, directory, task, proposal };
}

test("preview is read-only; explicit adoption and undo append real document versions while preserving all prior versions", async t => {
  const { service, task, proposal } = await setup(t);
  const asset = await service.createSyntheticResume({ name: "合成目标简历", expectedRevision: 2, idempotencyKey: "create-synthetic-resume", consent: true }, access);
  const original = structuredClone(asset.versions[0]!);
  const target = asset.targets[0]!;
  const request = { kind: "adopt" as const, assetId: asset.id, proposalId: proposal.id, resumeId: target.resumeId,
    experienceId: target.experienceId, expectedVersionId: asset.headVersionId };
  const before = await service.snapshot(), preview = await service.previewResumeChange(request, access);
  assert.deepEqual(await service.snapshot(), before);
  assert.ok(preview.diff.some(item => item.after.includes("仅设计")));
  assert.equal(preview.beforeHash, original.documentHash);
  const adopted = await service.saveResumeChange({ preview: request, previewHash: preview.hash, idempotencyKey: "adopt-synthetic-proposal", consent: true }, access);
  const state = await service.snapshot(), saved = state.workspace!.resumeAssets![0]!;
  assert.equal(saved.versions.length, 2); assert.deepEqual(saved.versions[0], original);
  const doc = DocumentSchema.parse(saved.versions[1]!.document);
  assert.equal(doc.factBase.experiences[0]!.claims.length, 2);
  assert.match(doc.factBase.experiences[0]!.claims[1]!.text.zh, /仅设计.*本人仅设计合成缓存失效方案/);
  assert.match(doc.factBase.experiences[0]!.claims[1]!.text.zh, /未实现，未上线/);
  assert.equal(adopted.kind, "adopt"); assert.equal(adopted.versionId, saved.headVersionId);
  const undoRequest = { kind: "undo" as const, assetId: saved.id, adoptionReceiptId: adopted.id, expectedVersionId: saved.headVersionId };
  const undoPreview = await service.previewResumeChange(undoRequest, access);
  const undone = await service.saveResumeChange({ preview: undoRequest, previewHash: undoPreview.hash, idempotencyKey: "undo-synthetic-adoption", consent: true }, access);
  const final = (await service.snapshot()).workspace!.resumeAssets![0]!;
  assert.equal(final.versions.length, 3); assert.equal(undone.kind, "undo"); assert.equal(undone.undoesReceiptId, adopted.id);
  assert.deepEqual(final.versions[0], original); assert.deepEqual(final.versions[1], saved.versions[1]);
  const restored = DocumentSchema.parse(final.versions[2]!.document), initial = DocumentSchema.parse(original.document);
  assert.deepEqual(restored.factBase.experiences, initial.factBase.experiences);
  assert.deepEqual(restored.factBase.profile, initial.factBase.profile);
  assert.deepEqual((await service.snapshot()).tasks[0], task);
});

test("preview cancellation revokes old adoption authority without deleting versions; a fresh preview requires a fresh explicit save", async t => {
  const { service, proposal } = await setup(t), { asset, request } = await seedTarget(service, proposal.id);
  const preview = await service.previewResumeChange(request, access);
  const command = { preview: request, previewHash: preview.hash, idempotencyKey: "cancelled-preview-save", consent: true as const };
  await service.revokeResumePreview({ assetId: asset.id, expectedAuthorizationRevision: 0, idempotencyKey: "cancel-preview-authority" }, access);
  await assert.rejects(service.saveResumeChange(command, access), /resume_preview_invalidated/);
  assert.equal((await service.snapshot()).workspace!.resumeAssets![0]!.versions.length, 1);
  const fresh = await service.previewResumeChange(request, access); assert.notEqual(fresh.hash, preview.hash);
  await assert.rejects(service.saveResumeChange({ ...command, previewHash: fresh.hash, consent: false } as never, access));
  const saved = await service.saveResumeChange({ ...command, previewHash: fresh.hash }, access);
  assert.equal(saved.kind, "adopt"); assert.equal((await service.snapshot()).workspace!.resumeAssets![0]!.versions.length, 2);
});

for (const kind of ["adopt", "undo"] as const) for (const mode of ["switch", "preview-revoke"] as const) {
  test(`late ${kind} after ${mode} cannot append a business version or revive an old lease`, async t => {
    const reached = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>(); let armed = false;
    t.after(async () => resume.resolve());
    const { service, proposal } = await setup(t, async event => {
      if (armed && event.detail === `workspace-resume-${kind}-before-acceptance`) { reached.resolve(); await resume.promise; }
    });
    const { asset, request } = await seedTarget(service, proposal.id);
    const preview = await service.previewResumeChange(request, access);
    const adopted = kind === "undo" ? await service.saveResumeChange({ preview: request, previewHash: preview.hash, idempotencyKey: "race-seed-adoption", consent: true }, access) : undefined;
    const operationRequest = kind === "adopt" ? request : { kind: "undo" as const, assetId: asset.id, adoptionReceiptId: adopted!.id, expectedVersionId: adopted!.versionId };
    const prepared = await service.previewResumeChange(operationRequest, access), before = (await service.snapshot()).workspace!.resumeAssets![0]!;
    armed = true;
    const pending = service.saveResumeChange({ preview: operationRequest, previewHash: prepared.hash, idempotencyKey: "race-late-save", consent: true }, access);
    const rejected = assert.rejects(pending, mode === "switch" ? /interaction_lease_invalid/ : /resume_preview_invalidated/);
    await reached.promise;
    if (mode === "switch") await service.invalidateSession(access.session);
    else await service.revokeResumePreview({ assetId: asset.id, expectedAuthorizationRevision: 0, idempotencyKey: "race-revoke-preview" }, access);
    resume.resolve(); await rejected;
    const after = (await service.snapshot()).workspace!.resumeAssets![0]!;
    assert.deepEqual(after.versions, before.versions); assert.equal(after.headVersionId, before.headVersionId);
  });
}

test("source revocation blocks a not-yet-accepted adoption, but never retroactively deletes accepted versions and does not prevent explicitly undoing them", async t => {
  const reached = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>(); let armed = false;
  t.after(async () => resume.resolve());
  const { service, proposal, task } = await setup(t, async event => {
    if (armed && event.detail === "workspace-resume-adopt-before-acceptance") { reached.resolve(); await resume.promise; }
  });
  const { asset, request } = await seedTarget(service, proposal.id), { request: second } = await seedTarget(service, proposal.id, "create-second-target");
  const preview = await service.previewResumeChange(request, access);
  const accepted = await service.saveResumeChange({ preview: request, previewHash: preview.hash, idempotencyKey: "accept-before-revoke", consent: true }, access);
  const secondPreview = await service.previewResumeChange(second, access); armed = true;
  const pending = service.saveResumeChange({ preview: second, previewHash: secondPreview.hash, idempotencyKey: "not-accepted-before-revoke", consent: true }, access);
  const rejected = assert.rejects(pending, /source_grant_revoked/); await reached.promise;
  await service.revoke(task.id, access); resume.resolve(); await rejected; armed = false;
  const state = await service.snapshot(); assert.equal(state.workspace!.resumeAssets![0]!.versions.length, 2);
  assert.equal(state.workspace!.resumeAssets![1]!.versions.length, 1);
  const undo = { kind: "undo" as const, assetId: asset.id, adoptionReceiptId: accepted.id, expectedVersionId: accepted.versionId };
  const undoPreview = await service.previewResumeChange(undo, access);
  await service.saveResumeChange({ preview: undo, previewHash: undoPreview.hash, idempotencyKey: "explicit-compensation-after-source-revoke", consent: true }, access);
  assert.equal((await service.snapshot()).workspace!.resumeAssets![0]!.versions.length, 3);
});

test("concurrent old-version adoption has one winner; retries keep one receipt and undo preserves a later independent adopted claim", async t => {
  const { service, proposal, task } = await setup(t), { asset, request } = await seedTarget(service, proposal.id);
  const preview = await service.previewResumeChange(request, access);
  const command = { preview: request, previewHash: preview.hash, idempotencyKey: "one-business-adoption", consent: true as const };
  const [one, same] = await Promise.all([service.saveResumeChange(command, access), service.saveResumeChange(command, access)]);
  assert.deepEqual(one, same);
  await assert.rejects(service.saveResumeChange({ ...command, idempotencyKey: "other-key-old-version" }, access), /resume_version_conflict/);
  await assert.rejects(service.saveResumeChange({ ...command, previewHash: "f".repeat(64) }, access), /resume_idempotency_conflict/);
  let state = await service.snapshot();
  const review = await service.reviewEvidence({ taskId: task.id, reportReceiptId: task.receipt!.id, reportHash: task.outputHash!, itemIndex: 2,
    expectedRevision: state.workspace!.revision, idempotencyKey: "second-independent-review", consent: true,
    decision: { kind: "implementation", action: "本人编写合成部署清单。", role: "维护者", deployment: "合成实验" } }, access);
  state = await service.snapshot();
  const second = await service.proposeEvidence({ reviewId: review.id, expectedRevision: state.workspace!.revision, idempotencyKey: "second-independent-proposal", consent: true }, access);
  const fresh = { ...request, expectedVersionId: one.versionId, proposalId: second.id }, prepared = await service.previewResumeChange(fresh, access);
  const commands = ["second-adopt-key-one", "second-adopt-key-two"].map(idempotencyKey => service.saveResumeChange({ preview: fresh, previewHash: prepared.hash, idempotencyKey, consent: true }, access));
  const results = await Promise.allSettled(commands); assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
  assert.match(String((results.find(item => item.status === "rejected") as PromiseRejectedResult).reason), /resume_version_conflict/);
  const current = (await service.snapshot()).workspace!.resumeAssets![0]!;
  const undo = { kind: "undo" as const, assetId: asset.id, adoptionReceiptId: one.id, expectedVersionId: current.headVersionId };
  const undoPreview = await service.previewResumeChange(undo, access);
  await service.saveResumeChange({ preview: undo, previewHash: undoPreview.hash, idempotencyKey: "undo-first-preserve-later", consent: true }, access);
  const final = (await service.snapshot()).workspace!.resumeAssets![0]!, doc = DocumentSchema.parse(final.versions.at(-1)!.document);
  assert.equal(final.versions.length, 4); assert.equal(doc.factBase.experiences[0]!.claims.length, 2);
  assert.equal(doc.factBase.experiences[0]!.claims[0]!.text.zh, "缓存实验原有说明，必须保留。");
  assert.match(doc.factBase.experiences[0]!.claims[1]!.text.zh, /本人编写合成部署清单/);
  assert.deepEqual(final.versions.slice(0, 3), current.versions);
});

test("save failure issues no version or receipt; retry and restart recover the same accepted operation without model calls", async t => {
  const { service, proposal, directory } = await setup(t), { request } = await seedTarget(service, proposal.id);
  const preview = await service.previewResumeChange(request, access), before = await service.snapshot();
  const command = { preview: request, previewHash: preview.hash, idempotencyKey: "disk-safe-adoption", consent: true as const };
  const filename = path.join(directory, "career-capabilities-v1.json"), backup = path.join(directory, "saved-before-failure.json");
  await rename(filename, backup); await symlink(backup, filename);
  await assert.rejects(service.saveResumeChange(command, access), /private_store_unavailable/);
  assert.deepEqual((await service.snapshot()).workspace, before.workspace);
  await unlink(filename); await rename(backup, filename);
  const saved = await service.saveResumeChange(command, access); await service.close();
  const reopened = new CareerCapabilities({ directory, ownerId: "synthetic-adoption-owner", builder: async () => { throw Error("must_not_build"); } });
  try {
    const again = await reopened.saveResumeChange(command, { session: "new-authenticated-session", valid: async () => true });
    assert.deepEqual(again, saved); assert.equal((await reopened.snapshot()).workspace!.resumeAssets![0]!.versions.length, 2);
  } finally { await reopened.close(); }
});

test("a personal correction or disabled source invalidates an adoption preview; target changes cannot borrow its hash", async t => {
  const { service, proposal, task } = await setup(t), { asset, request } = await seedTarget(service, proposal.id);
  const preview = await service.previewResumeChange(request, access);
  const changedTarget = { ...request, experienceId: asset.targets[1]!.experienceId };
  await assert.rejects(service.saveResumeChange({ preview: changedTarget, previewHash: preview.hash, idempotencyKey: "changed-target-old-authority", consent: true }, access), /resume_preview_invalidated/);
  const before = await service.snapshot();
  await service.reviewEvidence({ taskId: task.id, reportReceiptId: task.receipt!.id, reportHash: task.outputHash!, itemIndex: 1,
    expectedRevision: before.workspace!.revision, idempotencyKey: "correct-before-adoption", consent: true, decision: { kind: "not-mine", note: "原认领需纠正，实际不是本人完成。" } }, access);
  await assert.rejects(service.saveResumeChange({ preview: request, previewHash: preview.hash, idempotencyKey: "corrected-source-old-preview", consent: true }, access), /personal_review_superseded/);
  assert.deepEqual((await service.snapshot()).workspace!.resumeAssets![0]!.versions, asset.versions);
  await service.disable(1, 1, access);
  await assert.rejects(service.previewResumeChange(request, access), /current_verified_evidence_report_required/);
});
