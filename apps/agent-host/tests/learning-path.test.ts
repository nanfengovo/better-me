import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { GROWTH_PRACTICE_STARTER_SOURCE, type LearningPath } from "@better-me/agent-contracts";
import { AgentTaskKernel } from "../src/kernel/service.js";
import { LearningPaths } from "../src/growth/learning-service.js";

test("a passage-bound attempt restores without execution, then an unseen due retest preserves both answers and review consent", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-learning-path-"));
  let time = Date.parse("2026-01-01T08:00:00Z"), lookups = 0;
  const access = { session: "synthetic-learning-session", valid: async () => true };
  let kernel = new AgentTaskKernel({ ownerId: "synthetic-owner", directory: path.join(directory, "tasks"), growthPracticeLookup: async input => { lookups++; return input.sourceText; } });
  let service = new LearningPaths({ ownerId: "synthetic-owner", directory: path.join(directory, "learning"), kernel, clock: () => time });
  try {
    const material = await service.importMaterial({ requestId: "notes-v1", consent: true, name: "原创讲义.txt", mediaType: "text/plain",
      base64: Buffer.from("恢复时先读取持久回执。已经完成的步骤不再执行。\n\n没有回执时，结果未知。先用原操作编号对账，不直接重复派送。").toString("base64") }, access);
    let record = await service.create({ requestId: "goal-one", consent: true, title: "实现可恢复的小 Agent", weeklyHours: 4 }, access);
    const send = async (input: Record<string, unknown>) => record = await service.command(record.id, { ...input, expectedRevision: record.revision, consent: true }, access);
    await send({ kind: "select_passage", requestId: "choose-first", citation: { materialId: material.id, materialHash: material.hash,
      materialRevision: 1, page: 1, blockId: "b2", textHash: material.pages[0]!.blocks[1]!.hash } });
    await send({ kind: "start_attempt", requestId: "first-attempt", questionId: "receipt-present-v1" });
    const firstId = record.attempts[0]!.id;
    await send({ kind: "reveal_hint", requestId: "first-hint", attemptId: firstId, draftAnswer: "我先读检查点。" });
    await send({ kind: "submit_answer", requestId: "first-answer", attemptId: firstId, sourceCode: GROWTH_PRACTICE_STARTER_SOURCE,
      answer: "  已有成功回执，直接使用保存的结果。  ", explanation: "引用所选段落，但不重新执行已完成步骤。", decision: "reuse_receipt", attribution: "self_reported" });
    await send({ kind: "step_attempt", requestId: "first-lookup", attemptId: firstId, expectedTaskRevision: record.attempts[0]!.task!.revision });
    assert.equal(record.stage, "checkpoint_saved"); assert.equal(lookups, 1);
    const frozen = JSON.stringify(record);
    await service.close(); await kernel.close();
    kernel = new AgentTaskKernel({ ownerId: "synthetic-owner", directory: path.join(directory, "tasks"), growthPracticeLookup: async input => { lookups++; return input.sourceText; } });
    service = new LearningPaths({ ownerId: "synthetic-owner", directory: path.join(directory, "learning"), kernel, clock: () => time });
    record = await service.get(record.id, access);
    assert.equal(JSON.stringify(record), frozen); assert.equal(lookups, 1);
    await send({ kind: "step_attempt", requestId: "first-verify", attemptId: firstId, expectedTaskRevision: record.attempts[0]!.task!.revision });
    assert.equal(record.stage, "pending_retest"); assert.equal(record.attempts[0]!.independent, false);
    assert.equal(record.attempts[0]!.answer, "  已有成功回执，直接使用保存的结果。  ");
    await assert.rejects(() => service.command(record.id, { kind: "start_attempt", requestId: "too-early", expectedRevision: record.revision, consent: true, questionId: "receipt-missing-v1" }, access), /learning_retest_not_due/);
    time += 7 * 24 * 60 * 60 * 1000;
    record = await service.get(record.id, access); assert.equal(record.stage, "retest_due");
    await send({ kind: "start_attempt", requestId: "second-attempt", questionId: "receipt-missing-v1" });
    const secondId = record.attempts[1]!.id;
    assert.notEqual(record.attempts[1]!.prompt, record.attempts[0]!.prompt);
    await send({ kind: "submit_answer", requestId: "second-answer", attemptId: secondId, sourceCode: GROWTH_PRACTICE_STARTER_SOURCE,
      answer: "我会马上重试。", explanation: "没有回执我就当失败。", decision: "retry_now", attribution: "self_reported" });
    for (const requestId of ["second-lookup", "second-verify"]) await send({ kind: "step_attempt", requestId, attemptId: secondId, expectedTaskRevision: record.attempts[1]!.task!.revision });
    assert.equal(record.attempts[1]!.decisionPassed, false); assert.equal(record.attempts[0]!.decisionPassed, true);
    assert.equal(record.attempts[1]!.independent, true); assert.equal(record.stage, "review");
    await send({ kind: "propose_review", requestId: "weekly-review" });
    const review = record.reviews[0]!;
    assert.deepEqual(review.evidenceAttemptIds, [firstId, secondId]);
    assert.equal(review.nextStep, "supplement"); assert.equal(record.plans.length, 1, "a proposal never silently changes the plan");
    await send({ kind: "decide_review", requestId: "reject-review", reviewId: review.id, decision: "reject" });
    assert.equal(record.plans.length, 1); assert.equal(record.reviews[0]!.status, "rejected");
    assert.equal(record.attempts.length, 2); assert.equal(lookups, 2, "one selected-passage lookup per explicit attempt, never a library scan");
    const revoked = await service.revoke(material.id, "revoke-selected", access); assert.equal(revoked.revoked, true);
    const redacted: LearningPath = await service.get(record.id, access);
    assert.equal(redacted.stage, "source_revoked"); assert.equal(redacted.attempts.some(attempt => attempt.task), false);
    assert.equal(JSON.stringify(redacted).includes("没有回执时，结果未知。"), false);
  } finally { await service.close(); await kernel.close(); await rm(directory, { recursive: true, force: true }); }
});
