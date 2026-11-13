import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  GROWTH_PRACTICE_RUNTIME,
  GROWTH_PRACTICE_SOURCE_ID,
  GROWTH_PRACTICE_STARTER_SOURCE,
  GrowthPracticeTaskSchema,
  growthPracticeCheckpointHash,
  growthPracticeRequestHash,
  growthPracticeResultHash,
  growthPracticeVerificationHash,
} from "@better-me/agent-contracts";
import { verifyGrowthPractice } from "../src/kernel/growth-practice.js";
import { AgentTaskKernel } from "../src/kernel/service.js";

const access = { session: "synthetic-growth-practice", valid: async () => true };
const sourceText = "检查点会保存已经完成的工具结果。恢复时先读取检查点，不重复调用已经完成的工具。";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

test("a synthetic growth practice resumes from its saved lookup and verifies without executing lookup twice", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-growth-practice-"));
  let actualLookups = 0;
  const growthPracticeLookup = async ({ sourceText }: { sourceText: string }) => { actualLookups++; return sourceText; };
  let kernel = new AgentTaskKernel({ ownerId: "synthetic-growth-owner", directory, growthPracticeLookup });
  t.after(async () => { await kernel.close(); await rm(directory, { recursive: true, force: true }); });

  let task = GrowthPracticeTaskSchema.parse(await kernel.createTask({
    kind: "growth_practice",
    workspaceKey: "synthetic-growth-workspace",
    rootScopeKey: "growth:synthetic-journey",
    objective: "完成只读 lookup 并验证检查点恢复",
    request: {
      sourceId: GROWTH_PRACTICE_SOURCE_ID,
      sourceText,
      sourceHash: sha256(sourceText),
      sourceCode: GROWTH_PRACTICE_STARTER_SOURCE,
      answer: "恢复时使用已经保存的工具结果。",
      explanation: "检查点把 lookup 结果和哈希一起保存，因此恢复不需要再次查找。",
    },
    runtimeBinding: GROWTH_PRACTICE_RUNTIME,
    budget: { maxModelCalls: 1, maxToolCalls: 32, maxActiveMs: 600_000 },
    consent: true,
    idempotencyKey: "synthetic-growth-practice-v1",
  }, access));

  task = GrowthPracticeTaskSchema.parse(await kernel.stepGrowthPractice(task.id, {
    expectedRevision: task.revision, sourceFingerprint: task.sourceFingerprint, consent: true,
  }, access));
  assert.equal(task.status, "awaiting_review");
  assert.equal(task.practice.phase, "lookup_saved");
  assert.equal(task.practice.checkpoint?.lookupCalls, 1);
  assert.equal(actualLookups, 1);
  const beforeRestart = structuredClone(task);

  await kernel.close();
  kernel = new AgentTaskKernel({ ownerId: "synthetic-growth-owner", directory, growthPracticeLookup });
  task = GrowthPracticeTaskSchema.parse(await kernel.readTask(task.id));
  assert.deepEqual(task, beforeRestart);
  assert.equal(task.practice.checkpoint?.lookupCalls, 1);
  assert.equal(actualLookups, 1);

  task = GrowthPracticeTaskSchema.parse(await kernel.stepGrowthPractice(task.id, {
    expectedRevision: task.revision, sourceFingerprint: task.sourceFingerprint, consent: true,
  }, access));
  assert.equal(task.status, "completed");
  assert.equal(task.practice.phase, "verified");
  assert.equal(task.practice.checkpoint?.lookupCalls, 1);
  assert.equal(task.practice.verification?.checks.length, 4);
  assert.ok(task.practice.verification?.checks.every(check => check.passed));
  assert.equal(task.practice.verificationHash, growthPracticeVerificationHash(task.practice.verification!));
  const checkpoint = task.practice.checkpoint!;
  const expectedResult = { kind: "finish" as const, answer: task.request.answer, explanation: task.request.explanation,
    citedSourceId: checkpoint.noteId, citedResultHash: checkpoint.resultHash };
  assert.equal(task.sourceFingerprint, growthPracticeRequestHash(task.request));
  assert.equal(checkpoint.result, task.request.sourceText);
  assert.equal(checkpoint.resultHash, sha256(checkpoint.result));
  assert.equal(task.practice.verification?.sourceHash, task.request.sourceHash);
  assert.equal(task.practice.verification?.sourceCodeHash, sha256(task.request.sourceCode));
  assert.equal(task.practice.verification?.checkpointHash, growthPracticeCheckpointHash(checkpoint));
  assert.equal(task.practice.verification?.resultHash, growthPracticeResultHash(expectedResult));

  const badFingerprint = structuredClone(task); badFingerprint.sourceFingerprint = "0".repeat(64);
  assert.equal(GrowthPracticeTaskSchema.safeParse(badFingerprint).success, false);
  const badCheckpoint = structuredClone(task); badCheckpoint.practice.checkpoint!.result = "tampered source";
  badCheckpoint.practice.checkpoint!.resultHash = sha256("tampered source");
  assert.equal(GrowthPracticeTaskSchema.safeParse(badCheckpoint).success, false);
  const badVerificationSource = structuredClone(task); badVerificationSource.practice.verification!.sourceHash = "0".repeat(64);
  badVerificationSource.practice.verificationHash = growthPracticeVerificationHash(badVerificationSource.practice.verification!);
  assert.equal(GrowthPracticeTaskSchema.safeParse(badVerificationSource).success, false);
  const badVerificationResult = structuredClone(task); badVerificationResult.practice.verification!.resultHash = "0".repeat(64);
  badVerificationResult.practice.verificationHash = growthPracticeVerificationHash(badVerificationResult.practice.verification!);
  assert.equal(GrowthPracticeTaskSchema.safeParse(badVerificationResult).success, false);

  const restored = GrowthPracticeTaskSchema.parse(await kernel.readTask(task.id));
  assert.deepEqual(restored, task);
  assert.equal(restored.practice.checkpoint?.lookupCalls, 1);
  assert.equal(actualLookups, 1);
});

test("an unconfirmed lookup outcome stays unknown after restart and is never dispatched again", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-growth-unknown-"));
  let actualLookups = 0;
  const open = () => new AgentTaskKernel({ ownerId: "synthetic-growth-owner", directory, growthPracticeLookup: async () => {
    actualLookups++; throw new Error("synthetic_transport_lost_after_dispatch");
  } });
  let kernel = open();
  t.after(async () => { await kernel.close(); await rm(directory, { recursive: true, force: true }); });
  let task = GrowthPracticeTaskSchema.parse(await kernel.createTask({
    kind: "growth_practice", workspaceKey: "synthetic-unknown", objective: "保留未知结果", rootScopeKey: "growth:synthetic-unknown",
    request: { sourceId: GROWTH_PRACTICE_SOURCE_ID, sourceText, sourceHash: sha256(sourceText), sourceCode: GROWTH_PRACTICE_STARTER_SOURCE,
      answer: "从检查点继续。", explanation: "已完成的 lookup 不应重新派送。" },
    runtimeBinding: GROWTH_PRACTICE_RUNTIME, budget: { maxModelCalls: 1, maxToolCalls: 32, maxActiveMs: 600_000 }, consent: true,
    idempotencyKey: "synthetic-growth-unknown-v1",
  }, access));
  task = GrowthPracticeTaskSchema.parse(await kernel.stepGrowthPractice(task.id, {
    expectedRevision: task.revision, sourceFingerprint: task.sourceFingerprint, consent: true,
  }, access));
  assert.equal(task.status, "interrupted");
  assert.equal(task.practice.phase, "outcome_unknown");
  assert.equal(task.practice.error, "growth_practice_lookup_outcome_unknown");
  assert.equal(actualLookups, 1);
  await kernel.close(); kernel = open();
  task = GrowthPracticeTaskSchema.parse(await kernel.readTask(task.id));
  await assert.rejects(kernel.stepGrowthPractice(task.id, {
    expectedRevision: task.revision, sourceFingerprint: task.sourceFingerprint, consent: true,
  }, access), /growth_practice_lookup_outcome_unknown/);
  assert.equal(actualLookups, 1);
});

test("a process loss during verification keeps the lookup checkpoint and permits only an explicit verification retry", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-growth-verifier-crash-"));
  let kernel = new AgentTaskKernel({ ownerId: "synthetic-growth-owner", directory });
  t.after(async () => { await kernel.close(); await rm(directory, { recursive: true, force: true }); });
  const slowResumeSource = `function decide(input) {
    if (!input.checkpoint) return { kind: "lookup", noteId: input.sourceId };
    while (true) {}
  }`;
  let task = GrowthPracticeTaskSchema.parse(await kernel.createTask({
    kind: "growth_practice", workspaceKey: "synthetic-crash", objective: "从保存的检查点恢复验收", rootScopeKey: "growth:synthetic-crash",
    request: { sourceId: GROWTH_PRACTICE_SOURCE_ID, sourceText, sourceHash: sha256(sourceText), sourceCode: slowResumeSource,
      answer: "从检查点继续。", explanation: "验收中断不应再次读取资料。" },
    runtimeBinding: GROWTH_PRACTICE_RUNTIME, budget: { maxModelCalls: 1, maxToolCalls: 32, maxActiveMs: 600_000 }, consent: true,
    idempotencyKey: "synthetic-growth-verifier-crash-v1",
  }, access));
  task = GrowthPracticeTaskSchema.parse(await kernel.stepGrowthPractice(task.id, {
    expectedRevision: task.revision, sourceFingerprint: task.sourceFingerprint, consent: true,
  }, access));
  assert.equal(task.practice.checkpoint?.lookupCalls, 1);
  await kernel.close();
  const child = [
    "const {AgentTaskKernel}=await import(process.argv[1]);",
    "const {directory,id}=JSON.parse(process.argv[2]);",
    "const access={session:'synthetic-child',valid:async()=>true};",
    "const kernel=new AgentTaskKernel({ownerId:'synthetic-growth-owner',directory});",
    "const task=await kernel.readTask(id);",
    "void kernel.stepGrowthPractice(id,{expectedRevision:task.revision,sourceFingerprint:task.sourceFingerprint,consent:true},access);",
    "setTimeout(()=>process.exit(19),500);",
  ].join("");
  await assert.rejects(promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", child,
    new URL("../src/kernel/service.ts", import.meta.url).href, JSON.stringify({ directory, id: task.id })],
    { cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, TSX_TSCONFIG_PATH: path.resolve(import.meta.dirname, "../tsconfig.json") }, timeout: 10_000 }),
  (error: NodeJS.ErrnoException) => Number(error.code) === 19);
  kernel = new AgentTaskKernel({ ownerId: "synthetic-growth-owner", directory });
  task = GrowthPracticeTaskSchema.parse(await kernel.readTask(task.id));
  assert.equal(task.status, "interrupted");
  assert.equal(task.practice.phase, "lookup_saved");
  assert.equal(task.practice.checkpoint?.lookupCalls, 1);
  const retried = GrowthPracticeTaskSchema.parse(await kernel.stepGrowthPractice(task.id, {
    expectedRevision: task.revision, sourceFingerprint: task.sourceFingerprint, consent: true,
  }, access));
  assert.equal(retried.practice.checkpoint?.lookupCalls, 1);
  assert.equal(retried.status, "failed");
});

test("a growth practice remains readable after the kernel pauses and revokes it", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-growth-stop-"));
  const kernel = new AgentTaskKernel({ ownerId: "synthetic-growth-owner", directory });
  t.after(async () => { await kernel.close(); await rm(directory, { recursive: true, force: true }); });
  let task = GrowthPracticeTaskSchema.parse(await kernel.createTask({
    kind: "growth_practice", workspaceKey: "synthetic-stop", objective: "保留可撤销的合成练习", rootScopeKey: "growth:synthetic-stop",
    request: { sourceId: GROWTH_PRACTICE_SOURCE_ID, sourceText, sourceHash: sha256(sourceText), sourceCode: GROWTH_PRACTICE_STARTER_SOURCE,
      answer: "从检查点继续。", explanation: "暂停或撤销后仍需保留可审计状态。" },
    runtimeBinding: GROWTH_PRACTICE_RUNTIME, budget: { maxModelCalls: 1, maxToolCalls: 32, maxActiveMs: 600_000 }, consent: true,
    idempotencyKey: "synthetic-growth-stop-v1",
  }, access));
  task = GrowthPracticeTaskSchema.parse(await kernel.stop(task.id, task.revision, false, access));
  assert.equal(task.status, "paused");
  assert.deepEqual(GrowthPracticeTaskSchema.parse(await kernel.readTask(task.id)), task);
  task = GrowthPracticeTaskSchema.parse(await kernel.stepGrowthPractice(task.id, {
    expectedRevision: task.revision, sourceFingerprint: task.sourceFingerprint, consent: true,
  }, access));
  assert.equal(task.status, "awaiting_review");
  assert.equal(task.practice.phase, "lookup_saved");
  task = GrowthPracticeTaskSchema.parse(await kernel.stop(task.id, task.revision, true, access));
  assert.equal(task.status, "revoked");
  assert.deepEqual(GrowthPracticeTaskSchema.parse(await kernel.readTask(task.id)), task);
});

test("revoking the session during bounded source evaluation prevents the lookup dispatch", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-growth-revoked-eval-"));
  let actualLookups = 0;
  const kernel = new AgentTaskKernel({ ownerId: "synthetic-growth-owner", directory,
    growthPracticeLookup: async ({ sourceText }) => { actualLookups++; return sourceText; } });
  t.after(async () => { await kernel.close(); await rm(directory, { recursive: true, force: true }); });
  const checked = Promise.withResolvers<void>();
  const expiringAccess = { session: "synthetic-growth-revoked-eval", valid: async () => { checked.resolve(); return true; } };
  const delayedLookupSource = `function decide(input) {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {}
    return { kind: "lookup", noteId: input.sourceId };
  }`;
  let task = GrowthPracticeTaskSchema.parse(await kernel.createTask({
    kind: "growth_practice", workspaceKey: "synthetic-revoked-eval", objective: "失权后禁止派送 lookup", rootScopeKey: "growth:synthetic-revoked-eval",
    request: { sourceId: GROWTH_PRACTICE_SOURCE_ID, sourceText, sourceHash: sha256(sourceText), sourceCode: delayedLookupSource,
      answer: "从检查点继续。", explanation: "失权后不能继续派送工具。" },
    runtimeBinding: GROWTH_PRACTICE_RUNTIME, budget: { maxModelCalls: 1, maxToolCalls: 32, maxActiveMs: 600_000 }, consent: true,
    idempotencyKey: "synthetic-growth-revoked-eval-v1",
  }, expiringAccess));
  const stepping = kernel.stepGrowthPractice(task.id, {
    expectedRevision: task.revision, sourceFingerprint: task.sourceFingerprint, consent: true,
  }, expiringAccess);
  await checked.promise;
  await new Promise(resolve => setTimeout(resolve, 100));
  await kernel.invalidateSession(expiringAccess.session);
  await assert.rejects(stepping, /interaction_lease_invalid/);
  assert.equal(actualLookups, 0);
  task = GrowthPracticeTaskSchema.parse(await kernel.readTask(task.id));
  assert.equal(task.status, "interrupted");
  assert.equal(task.practice.phase, "ready");
  assert.equal(task.usage.toolCalls, 1, "the completed bounded evaluation remains charged");
});

test("a revoked lease after the source reservation interrupts before starting learner code", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-growth-source-lease-"));
  let actualLookups = 0;
  const kernel = new AgentTaskKernel({ ownerId: "synthetic-growth-owner", directory,
    growthPracticeLookup: async ({ sourceText }) => { actualLookups++; return sourceText; } });
  t.after(async () => { await kernel.close(); await rm(directory, { recursive: true, force: true }); });
  let task = GrowthPracticeTaskSchema.parse(await kernel.createTask({
    kind: "growth_practice", workspaceKey: "synthetic-source-lease", objective: "执行练习代码前确认权限", rootScopeKey: "growth:synthetic-source-lease",
    request: { sourceId: GROWTH_PRACTICE_SOURCE_ID, sourceText, sourceHash: sha256(sourceText),
      sourceCode: "function decide() { throw new Error('learner_code_must_not_start'); }",
      answer: "从检查点继续。", explanation: "代码开始前必须再次确认权限。" },
    runtimeBinding: GROWTH_PRACTICE_RUNTIME, budget: { maxModelCalls: 1, maxToolCalls: 32, maxActiveMs: 600_000 }, consent: true,
    idempotencyKey: "synthetic-growth-source-lease-v1",
  }, access));
  let checks = 0;
  const expiringAccess = { session: "synthetic-growth-source-lease", valid: async () => ++checks < 2 };
  await assert.rejects(kernel.stepGrowthPractice(task.id, {
    expectedRevision: task.revision, sourceFingerprint: task.sourceFingerprint, consent: true,
  }, expiringAccess), /interaction_lease_invalid/);
  task = GrowthPracticeTaskSchema.parse(await kernel.readTask(task.id));
  assert.equal(checks, 2); assert.equal(actualLookups, 0);
  assert.equal(task.status, "interrupted"); assert.equal(task.practice.phase, "ready");
  assert.equal(task.error, "interaction_lease_invalid", "a withdrawn lease is not a learner-code failure");
  assert.equal(task.usage.toolCalls, 1, "the pre-execution reservation remains auditable");
});

test("a final lease check after the durable dispatch reservation prevents an actual lookup", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-growth-final-lease-"));
  let actualLookups = 0;
  const kernel = new AgentTaskKernel({ ownerId: "synthetic-growth-owner", directory,
    growthPracticeLookup: async ({ sourceText }) => { actualLookups++; return sourceText; } });
  t.after(async () => { await kernel.close(); await rm(directory, { recursive: true, force: true }); });
  let task = GrowthPracticeTaskSchema.parse(await kernel.createTask({
    kind: "growth_practice", workspaceKey: "synthetic-final-lease", objective: "派送前最后确认权限", rootScopeKey: "growth:synthetic-final-lease",
    request: { sourceId: GROWTH_PRACTICE_SOURCE_ID, sourceText, sourceHash: sha256(sourceText), sourceCode: GROWTH_PRACTICE_STARTER_SOURCE,
      answer: "从检查点继续。", explanation: "派送前必须再次确认权限。" },
    runtimeBinding: GROWTH_PRACTICE_RUNTIME, budget: { maxModelCalls: 1, maxToolCalls: 32, maxActiveMs: 600_000 }, consent: true,
    idempotencyKey: "synthetic-growth-final-lease-v1",
  }, access));
  let checks = 0;
  const expiringAccess = { session: "synthetic-growth-final-lease", valid: async () => ++checks < 4 };
  await assert.rejects(kernel.stepGrowthPractice(task.id, {
    expectedRevision: task.revision, sourceFingerprint: task.sourceFingerprint, consent: true,
  }, expiringAccess), /interaction_lease_invalid/);
  assert.equal(checks, 4);
  assert.equal(actualLookups, 0);
  task = GrowthPracticeTaskSchema.parse(await kernel.readTask(task.id));
  assert.equal(task.status, "interrupted");
  assert.equal(task.practice.phase, "ready");
  assert.equal(task.usage.toolCalls, 2, "the durable dispatch reservation remains auditable even though no adapter ran");
});

test("revoking the session during verification preserves the checkpoint without publishing a late pass", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-growth-revoked-verification-"));
  let actualLookups = 0;
  const kernel = new AgentTaskKernel({ ownerId: "synthetic-growth-owner", directory,
    growthPracticeLookup: async ({ sourceText }) => { actualLookups++; return sourceText; } });
  t.after(async () => { await kernel.close(); await rm(directory, { recursive: true, force: true }); });
  const delayedFinishSource = `function decide(input) {
    if (!input.checkpoint) return { kind: "lookup", noteId: input.sourceId };
    const deadline = Date.now() + 300;
    while (Date.now() < deadline) {}
    return { kind: "finish", answer: input.answer, explanation: input.explanation,
      citedSourceId: input.checkpoint.noteId, citedResultHash: input.checkpoint.resultHash };
  }`;
  let task = GrowthPracticeTaskSchema.parse(await kernel.createTask({
    kind: "growth_practice", workspaceKey: "synthetic-revoked-verification", objective: "失权后不发布迟到通过", rootScopeKey: "growth:synthetic-revoked-verification",
    request: { sourceId: GROWTH_PRACTICE_SOURCE_ID, sourceText, sourceHash: sha256(sourceText), sourceCode: delayedFinishSource,
      answer: "从检查点继续。", explanation: "失权后保留检查点等待新的明确操作。" },
    runtimeBinding: GROWTH_PRACTICE_RUNTIME, budget: { maxModelCalls: 1, maxToolCalls: 32, maxActiveMs: 600_000 }, consent: true,
    idempotencyKey: "synthetic-growth-revoked-verification-v1",
  }, access));
  task = GrowthPracticeTaskSchema.parse(await kernel.stepGrowthPractice(task.id, {
    expectedRevision: task.revision, sourceFingerprint: task.sourceFingerprint, consent: true,
  }, access));
  assert.equal(actualLookups, 1);
  const checked = Promise.withResolvers<void>();
  const expiringAccess = { session: "synthetic-growth-revoked-verification", valid: async () => { checked.resolve(); return true; } };
  const verification = kernel.stepGrowthPractice(task.id, {
    expectedRevision: task.revision, sourceFingerprint: task.sourceFingerprint, consent: true,
  }, expiringAccess);
  await checked.promise;
  await new Promise(resolve => setTimeout(resolve, 75));
  await kernel.invalidateSession(expiringAccess.session);
  await assert.rejects(verification, /interaction_lease_invalid/);
  task = GrowthPracticeTaskSchema.parse(await kernel.readTask(task.id));
  assert.equal(task.status, "interrupted");
  assert.equal(task.practice.phase, "lookup_saved");
  assert.equal(task.practice.verification, undefined);
  assert.equal(actualLookups, 1);
  task = GrowthPracticeTaskSchema.parse(await kernel.stepGrowthPractice(task.id, {
    expectedRevision: task.revision, sourceFingerprint: task.sourceFingerprint, consent: true,
  }, { session: "synthetic-growth-renewed-verification", valid: async () => true }));
  assert.equal(task.status, "completed");
  assert.equal(task.practice.phase, "verified");
  assert.equal(actualLookups, 1);
});

for (const guestFailure of ["guest failure is not a host denial", "growth_practice_source_not_allowed"]) test(`a guest exception (${guestFailure}) is not proof of host rejection`, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-growth-forbidden-false-positive-"));
  const kernel = new AgentTaskKernel({ ownerId: "synthetic-growth-owner", directory });
  t.after(async () => { await kernel.close(); await rm(directory, { recursive: true, force: true }); });
  const falsePositiveSource = `function decide(input) {
    if (input.sourceId === "network://forbidden") throw new Error(${JSON.stringify(guestFailure)});
    if (!input.checkpoint) return { kind: "lookup", noteId: input.sourceId };
    return { kind: "finish", answer: input.answer, explanation: input.explanation,
      citedSourceId: input.checkpoint.noteId, citedResultHash: input.checkpoint.resultHash };
  }`;
  let task = GrowthPracticeTaskSchema.parse(await kernel.createTask({
    kind: "growth_practice", workspaceKey: "synthetic-forbidden-check", objective: "区分Host拒绝与guest异常", rootScopeKey: "growth:synthetic-forbidden-check",
    request: { sourceId: GROWTH_PRACTICE_SOURCE_ID, sourceText, sourceHash: sha256(sourceText), sourceCode: falsePositiveSource,
      answer: "从检查点继续。", explanation: "只有Host白名单拒绝才是权限证据。" },
    runtimeBinding: GROWTH_PRACTICE_RUNTIME, budget: { maxModelCalls: 1, maxToolCalls: 32, maxActiveMs: 600_000 }, consent: true,
    idempotencyKey: "synthetic-growth-forbidden-check-v1",
  }, access));
  task = GrowthPracticeTaskSchema.parse(await kernel.stepGrowthPractice(task.id, {
    expectedRevision: task.revision, sourceFingerprint: task.sourceFingerprint, consent: true,
  }, access));
  task = GrowthPracticeTaskSchema.parse(await kernel.stepGrowthPractice(task.id, {
    expectedRevision: task.revision, sourceFingerprint: task.sourceFingerprint, consent: true,
  }, access));
  assert.equal(task.status, "failed");
  assert.equal(task.practice.phase, "failed");
  assert.deepEqual(task.practice.verification?.checks.find(check => check.id === "forbidden-tool-rejected"), {
    id: "forbidden-tool-rejected", passed: false,
  });
});

test("the resume check requires the complete finish to equal the first checkpoint-bound result", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-growth-resume-equality-"));
  const kernel = new AgentTaskKernel({ ownerId: "synthetic-growth-owner", directory });
  t.after(async () => { await kernel.close(); await rm(directory, { recursive: true, force: true }); });
  let task = GrowthPracticeTaskSchema.parse(await kernel.createTask({
    kind: "growth_practice", workspaceKey: "synthetic-resume-equality", objective: "恢复结果必须完全一致", rootScopeKey: "growth:synthetic-resume-equality",
    request: { sourceId: GROWTH_PRACTICE_SOURCE_ID, sourceText, sourceHash: sha256(sourceText), sourceCode: GROWTH_PRACTICE_STARTER_SOURCE,
      answer: "从检查点继续。", explanation: "相同检查点必须生成相同完整结果。" },
    runtimeBinding: GROWTH_PRACTICE_RUNTIME, budget: { maxModelCalls: 1, maxToolCalls: 32, maxActiveMs: 600_000 }, consent: true,
    idempotencyKey: "synthetic-growth-resume-equality-v1",
  }, access));
  task = GrowthPracticeTaskSchema.parse(await kernel.stepGrowthPractice(task.id, {
    expectedRevision: task.revision, sourceFingerprint: task.sourceFingerprint, consent: true,
  }, access));
  const checkpoint = task.practice.checkpoint!;
  const exact = { kind: "finish" as const, answer: task.request.answer, explanation: task.request.explanation,
    citedSourceId: checkpoint.noteId, citedResultHash: checkpoint.resultHash };
  const verification = await verifyGrowthPractice(task, checkpoint, async (input, label) => {
    if (label === "resume-actual-checkpoint") return exact;
    if (label === "resume-does-not-lookup") return { ...exact, explanation: "changed on resume" };
    return { kind: "lookup", noteId: input.sourceId };
  });
  assert.deepEqual(verification.checks.find(check => check.id === "resume-uses-checkpoint"), {
    id: "resume-uses-checkpoint", passed: false,
  });
});

test("readTask rejects a stored growth task whose canonical request fingerprint was changed", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-growth-binding-tamper-"));
  let kernel = new AgentTaskKernel({ ownerId: "synthetic-growth-owner", directory });
  t.after(async () => { await kernel.close(); await rm(directory, { recursive: true, force: true }); });
  const task = GrowthPracticeTaskSchema.parse(await kernel.createTask({
    kind: "growth_practice", workspaceKey: "synthetic-binding-tamper", objective: "拒绝失配的私有任务", rootScopeKey: "growth:synthetic-binding-tamper",
    request: { sourceId: GROWTH_PRACTICE_SOURCE_ID, sourceText, sourceHash: sha256(sourceText), sourceCode: GROWTH_PRACTICE_STARTER_SOURCE,
      answer: "从检查点继续。", explanation: "读取时重新验证canonical request hash。" },
    runtimeBinding: GROWTH_PRACTICE_RUNTIME, budget: { maxModelCalls: 1, maxToolCalls: 32, maxActiveMs: 600_000 }, consent: true,
    idempotencyKey: "synthetic-growth-binding-tamper-v1",
  }, access));
  await kernel.close();
  const file = path.join(directory, `${task.id}.json`);
  const stored = JSON.parse(await readFile(file, "utf8")) as { task: { sourceFingerprint: string } };
  stored.task.sourceFingerprint = "0".repeat(64);
  await writeFile(file, JSON.stringify(stored), { mode: 0o600 });
  kernel = new AgentTaskKernel({ ownerId: "synthetic-growth-owner", directory });
  await assert.rejects(kernel.readTask(task.id), /invalid_private_task/);
});

test("checkpoint and verification hashes stay bound to the exact original code, answer and source", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-growth-snapshot-binding-"));
  const kernel = new AgentTaskKernel({ ownerId: "synthetic-growth-owner", directory });
  t.after(async () => { await kernel.close(); await rm(directory, { recursive: true, force: true }); });
  let task = GrowthPracticeTaskSchema.parse(await kernel.createTask({
    kind: "growth_practice", workspaceKey: "synthetic-snapshot-binding", objective: "每次读取都重新绑定原始快照", rootScopeKey: "growth:synthetic-snapshot-binding",
    request: { sourceId: GROWTH_PRACTICE_SOURCE_ID, sourceText, sourceHash: sha256(sourceText), sourceCode: GROWTH_PRACTICE_STARTER_SOURCE,
      answer: "  原始作答\n", explanation: "保留准确代码、原答、资料和断点" },
    runtimeBinding: GROWTH_PRACTICE_RUNTIME, consent: true, idempotencyKey: "synthetic-snapshot-binding-v1",
  }, access));
  for (let step = 0; step < 2; step++) task = GrowthPracticeTaskSchema.parse(await kernel.stepGrowthPractice(task.id, {
    expectedRevision: task.revision, sourceFingerprint: task.sourceFingerprint, consent: true,
  }, access));
  assert.equal(task.practice.phase, "verified");
  assert.equal(task.sourceFingerprint, growthPracticeRequestHash(task.request));
  assert.equal(task.practice.verification!.checkpointHash, growthPracticeCheckpointHash(task.practice.checkpoint!));
  assert.equal(task.practice.verification!.resultHash, growthPracticeResultHash({ kind: "finish", answer: task.request.answer,
    explanation: task.request.explanation, citedSourceId: task.request.sourceId, citedResultHash: task.practice.checkpoint!.resultHash }));
  const changes: { name: string; alter: (value: typeof task) => void }[] = [
    { name: "changed checkpoint body", alter: value => { value.practice.checkpoint!.result += "漂移"; } },
    { name: "changed checkpoint hash", alter: value => { value.practice.checkpoint!.resultHash = "0".repeat(64); } },
    { name: "checkpoint replaced with another coherent text", alter: value => {
      value.practice.checkpoint!.result = "另一份合成原文"; value.practice.checkpoint!.resultHash = sha256(value.practice.checkpoint!.result);
      value.practice.verification!.checkpointHash = growthPracticeCheckpointHash(value.practice.checkpoint!);
      value.practice.verificationHash = growthPracticeVerificationHash(value.practice.verification!);
    } },
    { name: "answer changed after verification", alter: value => {
      value.request.answer += "改写"; value.sourceFingerprint = growthPracticeRequestHash(value.request);
    } },
    { name: "code changed after verification", alter: value => {
      value.request.sourceCode += "\n"; value.sourceFingerprint = growthPracticeRequestHash(value.request);
    } },
    { name: "wrong receipt checkpoint hash", alter: value => {
      value.practice.verification!.checkpointHash = "0".repeat(64); value.practice.verificationHash = growthPracticeVerificationHash(value.practice.verification!);
    } },
    { name: "wrong receipt result hash", alter: value => {
      value.practice.verification!.resultHash = "0".repeat(64); value.practice.verificationHash = growthPracticeVerificationHash(value.practice.verification!);
    } },
  ];
  for (const change of changes) {
    const changed = structuredClone(task); change.alter(changed);
    assert.equal(GrowthPracticeTaskSchema.safeParse(changed).success, false, change.name);
  }
});

for (const allowance of [1, 2] as const) test(`a ${allowance}-tool budget yields a durable exhausted stop without another lookup`, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-growth-budget-stop-"));
  let actualLookups = 0;
  const options = { ownerId: "synthetic-growth-owner", directory,
    growthPracticeLookup: async ({ sourceText }: { sourceText: string }) => { actualLookups++; return sourceText; } };
  let kernel = new AgentTaskKernel(options);
  t.after(async () => { await kernel.close(); await rm(directory, { recursive: true, force: true }); });
  let task = GrowthPracticeTaskSchema.parse(await kernel.createTask({
    kind: "growth_practice", workspaceKey: "synthetic-budget-stop", objective: "预算是原任务的可读停点", rootScopeKey: "growth:synthetic-budget-stop",
    request: { sourceId: GROWTH_PRACTICE_SOURCE_ID, sourceText, sourceHash: sha256(sourceText), sourceCode: GROWTH_PRACTICE_STARTER_SOURCE,
      answer: "保留原账", explanation: "不能将预算错误当作功能检查通过" },
    runtimeBinding: GROWTH_PRACTICE_RUNTIME, budget: { maxModelCalls: 1, maxToolCalls: allowance, maxActiveMs: 600_000 },
    consent: true, idempotencyKey: "synthetic-budget-stop-v1",
  }, access));
  task = GrowthPracticeTaskSchema.parse(await kernel.stepGrowthPractice(task.id, {
    expectedRevision: task.revision, sourceFingerprint: task.sourceFingerprint, consent: true,
  }, access));
  if (allowance === 2) {
    assert.equal(task.practice.phase, "lookup_saved");
    task = GrowthPracticeTaskSchema.parse(await kernel.stepGrowthPractice(task.id, {
      expectedRevision: task.revision, sourceFingerprint: task.sourceFingerprint, consent: true,
    }, access));
  }
  assert.equal(task.status, "budget_exhausted"); assert.equal(task.practice.phase, "failed");
  assert.equal(task.practice.error, "tool_call_budget"); assert.equal(task.practice.verification, undefined);
  assert.equal(actualLookups, allowance === 2 ? 1 : 0); assert.ok(task.usage.toolCalls <= allowance);
  await kernel.close(); kernel = new AgentTaskKernel(options);
  assert.deepEqual(await kernel.readTask(task.id), task);
  assert.equal(actualLookups, allowance === 2 ? 1 : 0, "reopening an exhausted task never grants another dispatch");
});
