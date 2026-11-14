import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { GROWTH_PRACTICE_STARTER_SOURCE, type LearningPath, type LearningCommandInput } from "@better-me/agent-contracts";
import { AgentTaskKernel } from "../src/kernel/service.js";
import { LearningPaths } from "../src/growth/learning-service.js";

const reconcileCode = `function decide(input) {
  if (input.delivery === "unknown") return {kind:"reconcile",operationId:input.operationId};
  if (!input.checkpoint) return {kind:"lookup",noteId:input.sourceId};
  return {kind:"finish",answer:input.answer,explanation:input.explanation,
    citedSourceId:input.checkpoint.noteId,citedResultHash:input.checkpoint.resultHash};
}`;

async function fixture(lookup?: (input: { sourceText: string }) => Promise<string>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-learning-review-"));
  let time = Date.parse("2026-01-01T00:00:00Z"), serial = 0;
  const kernel = new AgentTaskKernel({ ownerId: "review-owner", directory: path.join(directory, "tasks"), growthPracticeLookup: lookup });
  const service = new LearningPaths({ ownerId: "review-owner", directory: path.join(directory, "learning"), kernel, clock: () => time });
  const access = { session: "review-session", valid: async () => true };
  const material = await service.importMaterial({ requestId: "review-notes", consent: true, name: "原创讲义.txt", mediaType: "text/plain",
    base64: Buffer.from("已有成功回执时先复用；回执丢失时结果未知，先用原编号对账，不直接重试。").toString("base64") }, access);
  let record: LearningPath = await service.create({ requestId: "review-path", consent: true, title: "可复核学习项目", weeklyHours: 4 }, access);
  const send = async (input: LearningCommandInput, requestId = `op-${++serial}`) => record = await service.command(record.id, { ...input, expectedRevision: record.revision, consent: true, requestId }, access);
  await send({ kind: "select_passage", citation: { materialId: material.id, materialHash: material.hash, materialRevision: 1, page: 1, blockId: "b1", textHash: material.pages[0]!.blocks[0]!.hash } });
  return { service, kernel, access, get: () => record, send, advance: () => { time += 7 * 86400_000; },
    close: async () => { await service.close(); await kernel.close(); await rm(directory, { recursive: true, force: true }); } };
}

async function submit(f: Awaited<ReturnType<typeof fixture>>, first: boolean, code = first ? GROWTH_PRACTICE_STARTER_SOURCE : reconcileCode) {
  await f.send({ kind: "start_attempt", questionId: first ? "receipt-present-v1" : f.get().attempts.some(item => item.questionId === "receipt-missing-v1") ? "receipt-transfer-v1" : "receipt-missing-v1" });
  const attemptId = f.get().attempts.at(-1)!.id;
  await f.send({ kind: "submit_answer", attemptId, answer: first ? "复用成功回执" : "未知不等于失败，先对账", explanation: "这是本人原文，不作自动语义评分。",
    sourceCode: code, decision: first ? "reuse_receipt" : "reconcile_unknown", attribution: "self_reported" });
  return attemptId;
}
async function run(f: Awaited<ReturnType<typeof fixture>>, attemptId: string) {
  for (let step = 0; step < 2; step++) await f.send({ kind: "step_attempt", attemptId, expectedTaskRevision: f.get().attempts.at(-1)!.task!.revision });
}

test("a due independent retest uses actual reconcile outputs; only acceptance versions the plan and binds a complete project", async () => {
  const f = await fixture();
  try {
    await run(f, await submit(f, true)); f.advance();
    const secondId = await submit(f, false);
    const before = f.get(), input = { kind: "step_attempt" as const, attemptId: secondId, expectedTaskRevision: before.attempts[1]!.task!.revision,
      expectedRevision: before.revision, consent: true as const, requestId: "exact-once-step" };
    const once = await f.service.command(before.id, input, f.access);
    const twice = await f.service.command(before.id, input, f.access);
    assert.equal(twice.revision, once.revision); assert.equal(twice.usage.lookupCalls, 2);
    await assert.rejects(() => f.service.command(before.id, { ...input, expectedTaskRevision: 999 }, f.access), /learning_idempotency_conflict/);
    // Refresh via the public API; the fixture's next send must carry its real revision.
    await f.send({ kind: "step_attempt", attemptId: secondId, expectedTaskRevision: twice.attempts[1]!.task!.revision }, "stale-fixture-read").catch(error => assert.match(error.message, /learning_revision_conflict/));
    const verified = await f.service.command(before.id, { kind: "step_attempt", attemptId: secondId, expectedRevision: twice.revision,
      expectedTaskRevision: twice.attempts[1]!.task!.revision, requestId: "verify-second", consent: true }, f.access);
    const report = verified.attempts[1]!.task!.practice.verification!;
    assert.equal(report.verifierVersion, "growth-practice-receipt-v2"); assert.equal(report.passed, 4);
    assert.deepEqual(report.observations?.filter(item => item.decision?.kind === "reconcile").map(item => item.decision),
      [{ kind: "reconcile", operationId: "existing-operation-v1" }, { kind: "reconcile", operationId: "existing-operation-v1" }]);
    let record = verified;
    const send = async (command: LearningCommandInput) => record = await f.service.command(record.id, { ...command, expectedRevision: record.revision, consent: true, requestId: `project-${record.revision}` }, f.access);
    await send({ kind: "propose_review" }); assert.equal(record.plans.length, 1); assert.equal(record.reviews[0]!.nextStep, "project");
    await send({ kind: "decide_review", reviewId: record.reviews[0]!.id, decision: "accept" });
    assert.equal(record.stage, "project"); assert.equal(record.plans.length, 2);
    const project = { kind: "accept_project" as const, attemptId: secondId, reportHash: record.attempts[1]!.task!.practice.verificationHash!,
      runInstructions: "在受限 QuickJS 中调用保存的 decide(input)，使用这份报告中的输入。", sample: "unknown + 原 operationId → reconcile 原编号",
      limitations: "仅通过四项固定检查；解释未评分；不代表生产或长期掌握。", personalWork: "本人原答、代码、验证与验收。", toolWork: "系统提供选段、输入、受限执行和报告。" };
    await assert.rejects(() => send({ ...project, reportHash: "0".repeat(64) }), /learning_project_not_ready/);
    await send(project); assert.equal(record.stage, "completed"); assert.equal(record.project?.scope, "learning_project");
    assert.equal(record.usage.lookupCalls, 2); assert.equal(record.usage.modelCalls, 0);
    await f.service.revoke(record.citation!.materialId, "revoke-project", f.access);
    const revoked = await f.service.get(record.id, f.access);
    assert.equal(revoked.usage.lookupCalls, 2, "revocation redacts bodies, never rewrites historical usage to zero");
    assert.equal(revoked.attempts.some(attempt => attempt.task), false);
  } finally { await f.close(); }
});

test("an accepted supplement leads to a new operation-id transfer case without erasing the failed retest", async () => {
  const f = await fixture();
  try {
    const firstId = await submit(f, true);
    await run(f, firstId);
    f.advance();
    const secondId = await submit(f, false, GROWTH_PRACTICE_STARTER_SOURCE);
    await run(f, secondId);
    assert.equal(f.get().attempts[0]!.task!.practice.verification!.passed, 4);
    assert.equal(f.get().attempts[1]!.task!.practice.verification!.passed, 2);
    await f.send({ kind: "propose_review" });
    assert.equal(f.get().reviews.at(-1)!.nextStep, "supplement");
    await f.send({ kind: "decide_review", reviewId: f.get().reviews.at(-1)!.id, decision: "accept" });
    const thirdId = await submit(f, false);
    assert.equal(f.get().attempts[2]!.questionId, "receipt-transfer-v1");
    assert.equal(f.get().attempts[2]!.independent, true);
    await run(f, thirdId);
    const report = f.get().attempts[2]!.task!.practice.verification!;
    assert.equal(report.verifierVersion, "growth-practice-receipt-v3");
    assert.equal(report.passed, 4);
    assert.ok(report.observations?.some(item => item.decision?.kind === "reconcile" && item.decision.operationId === "new-operation-v2"));
    assert.deepEqual(f.get().attempts.map(item => item.id), [firstId, secondId, thirdId]);
    assert.equal(f.get().attempts[1]!.task!.practice.verification!.passed, 2);
    await assert.rejects(() => submit(f, false), /learning_review_required/, "a previous supplement plan cannot authorize unlimited new attempts");
    await f.send({ kind: "propose_review" });
    assert.equal(f.get().reviews.at(-1)!.nextStep, "project");
    assert.deepEqual(f.get().reviews.at(-1)!.evidenceAttemptIds, [firstId, secondId, thirdId]);
    assert.equal(f.get().usage.lookupCalls, 3);
    assert.equal(f.get().usage.modelCalls, 0);
  } finally { await f.close(); }
});

test("an unknown selected-passage outcome remains unknown on GET and cannot be rerun with a new command", async () => {
  let dispatches = 0;
  const f = await fixture(async () => { dispatches++; throw new Error("receipt_lost"); });
  try {
    const attemptId = await submit(f, true);
    await f.send({ kind: "step_attempt", attemptId, expectedTaskRevision: f.get().attempts[0]!.task!.revision });
    assert.equal(f.get().stage, "outcome_unknown");
    const restored = await f.service.get(f.get().id, f.access);
    assert.equal(restored.stage, "outcome_unknown"); assert.equal(dispatches, 1);
    await assert.rejects(() => f.send({ kind: "step_attempt", attemptId, expectedTaskRevision: restored.attempts[0]!.task!.revision }), /learning_task_not_runnable/);
    assert.equal(dispatches, 1);
  } finally { await f.close(); }
});

test("new learning attempts share the root budget instead of resetting it", async () => {
  const f = await fixture();
  try {
    let stopped = false;
    for (let index = 0; index < 8; index++) {
      const id = await submit(f, index === 0, GROWTH_PRACTICE_STARTER_SOURCE);
      for (let step = 0; step < 2; step++) {
        if (f.get().attempts.at(-1)!.task!.status === "budget_exhausted") break;
        await f.send({ kind: "step_attempt", attemptId: id, expectedTaskRevision: f.get().attempts.at(-1)!.task!.revision });
      }
      if (f.get().attempts.at(-1)!.task!.status === "budget_exhausted") {
        stopped = true;
        await assert.rejects(() => submit(f, false), /learning_budget_exhausted/); break;
      }
      f.advance();
      if (index >= 1) { await f.send({ kind: "propose_review" }); await f.send({ kind: "decide_review", reviewId: f.get().reviews.at(-1)!.id, decision: "accept" }); }
    }
    assert.equal(stopped, true); assert.ok(f.get().usage.toolCalls <= 32); assert.equal(f.get().usage.modelCalls, 0);
  } finally { await f.close(); }
});
