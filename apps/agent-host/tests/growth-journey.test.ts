import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentTaskKernel } from "../src/kernel/service.js";
import { GrowthJourneys } from "../src/growth/service.js";
import { GROWTH_PRACTICE_STARTER_SOURCE } from "@better-me/agent-contracts";

const access = { session: "synthetic-growth-session", valid: async () => true };
test("a synthetic goal and its selected source survive reopening without executing any task", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-growth-journey-"));
  const kernel = new AgentTaskKernel({ ownerId: "synthetic-growth-owner", directory: path.join(directory, "tasks") });
  let journeys = new GrowthJourneys({ ownerId: "synthetic-growth-owner", directory: path.join(directory, "growth"), kernel });
  t.after(async () => { await journeys.close(); await kernel.close(); await rm(directory, { recursive: true, force: true }); });
  let record = await journeys.create({ mode: "synthetic", goal: { title: "  建立可恢复的 Agent 小项目  ", targetWeeks: 12, weeklyHours: 3 }, consent: true, idempotencyKey: "first-synthetic-goal" }, access);
  assert.equal(record.goal.title, "  建立可恢复的 Agent 小项目  ");
  assert.equal(record.stage, "choose_source");
  const sources = await journeys.sources(access);
  assert.equal(sources[0]?.provenance, "authored_synthetic");
  record = await journeys.command(record.id, { kind: "select_source", sourceVersion: sources[0]!.version, expectedRevision: record.revision, requestId: "choose-first-source", consent: true }, access);
  assert.equal(record.stage, "practice");
  assert.equal(record.source?.locator, "合成教材 · 第 1 节 · 保存断点");
  assert.deepEqual(await kernel.listTasks(), []);
  await journeys.close();
  journeys = new GrowthJourneys({ ownerId: "synthetic-growth-owner", directory: path.join(directory, "growth"), kernel });
  assert.deepEqual(await journeys.get(record.id, access), record);
  assert.equal((await journeys.list(access)).length, 1);
  assert.deepEqual(await kernel.listTasks(), []);
});

test("submitting a practice freezes original code and answers in the shared Kernel without executing", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-growth-submit-"));
  const kernel = new AgentTaskKernel({ ownerId: "synthetic-growth-owner", directory: path.join(directory, "tasks") });
  const journeys = new GrowthJourneys({ ownerId: "synthetic-growth-owner", directory: path.join(directory, "growth"), kernel });
  t.after(async () => { await journeys.close(); await kernel.close(); await rm(directory, { recursive: true, force: true }); });
  let record = await journeys.create({ mode: "synthetic", goal: { title: "恢复练习", targetWeeks: 3, weeklyHours: 2 }, consent: true, idempotencyKey: "submit-goal" }, access);
  record = await journeys.command(record.id, { kind: "select_source", sourceVersion: "checkpoint.v1", expectedRevision: record.revision, requestId: "select-source", consent: true }, access);
  const submit = { kind: "submit_practice" as const, expectedRevision: record.revision, requestId: "submit-code", consent: true as const,
    sourceCode: GROWTH_PRACTICE_STARTER_SOURCE, answer: "  读取保存结果，不重复 lookup。\n", explanation: "  这里只验证合成断点，不代表生产经验。  ", attribution: "guided_example" as const };
  record = await journeys.command(record.id, submit, access);
  assert.equal(record.task?.kind, "growth_practice");
  assert.equal(record.task?.request.answer, submit.answer);
  assert.equal(record.task?.request.explanation, submit.explanation);
  assert.equal(record.task?.request.sourceCode, submit.sourceCode);
  assert.equal(record.task?.usage.toolCalls, 0);
  assert.equal(record.task?.usage.modelCalls, 0);
  assert.equal(record.task?.rootScopeKey, `growth:${record.id}`);
  await assert.rejects(journeys.command(record.id, { kind: "select_source", sourceVersion: "reconciliation.v1", expectedRevision: record.revision, requestId: "change-frozen-source", consent: true }, access), { code: "growth_source_frozen" });
  const retried = await journeys.command(record.id, submit, access);
  assert.equal(retried.task?.id, record.task?.id);
  assert.equal((await kernel.listTasks()).length, 1);
  await assert.rejects(journeys.command(record.id, { ...submit, answer: "同一操作号不能覆盖原答" }, access), { code: "growth_idempotency_conflict" });
  await assert.rejects(journeys.command(record.id, { kind: "select_source", sourceVersion: "checkpoint.v1", expectedRevision: record.revision - 1, requestId: "stale-journey-revision", consent: true }, access), { code: "growth_revision_conflict" });
  await assert.rejects(journeys.command(record.id, { kind: "step_practice", taskId: record.task!.id, expectedTaskRevision: record.task!.revision + 1, expectedRevision: record.revision, requestId: "stale-task-revision", consent: true }, access), { code: "growth_task_revision_conflict" });
  assert.deepEqual(await journeys.get(record.id, access), record, "rejected stale or changed commands do not mutate the saved attempt");
});

test("a project accepts only the verified saved-checkpoint attempt and reopening never replays its tool", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-growth-resume-"));
  const options = { ownerId: "synthetic-growth-owner", directory: path.join(directory, "tasks") };
  let kernel = new AgentTaskKernel(options);
  let journeys = new GrowthJourneys({ ownerId: options.ownerId, directory: path.join(directory, "growth"), kernel });
  t.after(async () => { await journeys.close(); await kernel.close(); await rm(directory, { recursive: true, force: true }); });
  let record = await journeys.create({ mode: "synthetic", goal: { title: "最薄成长闭环", targetWeeks: 12, weeklyHours: 3 }, consent: true, idempotencyKey: "resume-goal" }, access);
  record = await journeys.command(record.id, { kind: "select_source", sourceVersion: "checkpoint.v1", expectedRevision: record.revision, requestId: "select-source", consent: true }, access);
  record = await journeys.command(record.id, { kind: "submit_practice", sourceCode: GROWTH_PRACTICE_STARTER_SOURCE,
    answer: "保存结果后，恢复不重新查找。", explanation: "只是合成练习，解释尚待独立复测。", attribution: "guided_example",
    expectedRevision: record.revision, requestId: "submit-resume-code", consent: true }, access);
  const advance = () => journeys.command(record.id, { kind: "step_practice", taskId: record.task!.id,
    expectedTaskRevision: record.task!.revision, expectedRevision: record.revision, requestId: `step-${record.task!.revision}`, consent: true }, access);
  record = await advance();
  assert.equal(record.stage, "checkpoint_saved");
  const beforeRestart = structuredClone(record);
  await journeys.close(); await kernel.close();
  kernel = new AgentTaskKernel(options);
  journeys = new GrowthJourneys({ ownerId: options.ownerId, directory: path.join(directory, "growth"), kernel });
  record = await journeys.get(record.id, access);
  assert.deepEqual(record, beforeRestart);
  assert.deepEqual(record.task?.usage, beforeRestart.task?.usage, "read-only reopening preserves all actual tool and sandbox charges");
  record = await advance();
  assert.equal(record.stage, "ready_for_acceptance");
  assert.equal(record.task?.practice.verification?.passed, 4);
  assert.equal(record.task?.practice.checkpoint?.lookupCalls, 1);
  assert.equal(record.task?.usage.modelCalls, 0);
  assert.equal(record.project, undefined);
  const accept = { kind: "accept_project" as const, taskId: record.task!.id, reportHash: record.reportHash!,
    expectedRevision: record.revision, requestId: "accept-project", consent: true as const };
  await assert.rejects(journeys.command(record.id, { ...accept, reportHash: "0".repeat(64), requestId: "forged-report" }, access), { code: "growth_verified_project_required" });
  const [first, duplicate] = await Promise.all([journeys.command(record.id, accept, access), journeys.command(record.id, accept, access)]);
  assert.deepEqual(first, duplicate);
  record = first;
  assert.equal(record.stage, "completed");
  assert.equal(record.project?.scope, "synthetic_practice");
  assert.equal(record.project?.mastery, "pending_retest");
  assert.equal(record.project?.attribution, "guided_example");
  assert.deepEqual((await journeys.command(record.id, accept, access)).project, record.project);
  assert.equal(record.events.filter(event => event.kind === "project_accepted").length, 1);
});

test("revoked sessions and a second owner cannot claim a private growth store", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-growth-ownership-"));
  const kernel = new AgentTaskKernel({ ownerId: "synthetic-growth-owner", directory: path.join(directory, "tasks") });
  let journeys = new GrowthJourneys({ ownerId: "synthetic-growth-owner", directory: path.join(directory, "growth"), kernel });
  t.after(async () => { await journeys.close(); await kernel.close(); await rm(directory, { recursive: true, force: true }); });
  const record = await journeys.create({ mode: "synthetic", goal: { title: "只属于甲的合成目标", targetWeeks: 2, weeklyHours: 1 }, consent: true, idempotencyKey: "constructor" }, access);
  journeys.invalidateSession(access.session);
  await assert.rejects(journeys.get(record.id, access), { code: "growth_access_invalid" });
  await journeys.close();
  journeys = new GrowthJourneys({ ownerId: "synthetic-owner-b", directory: path.join(directory, "growth"), kernel });
  await assert.rejects(journeys.list({ session: "bob", valid: async () => true }), { code: "growth_owner_mismatch" });
});

for (const outcome of ["saved", "unknown"] as const) test(`a ${outcome} lookup with a lost journey receipt is reconciled under the original command, never dispatched again`, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-growth-pending-"));
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  let lookupCalls = 0;
  const options = { ownerId: "synthetic-growth-owner", directory: path.join(directory, "tasks"),
    growthPracticeLookup: async (note: { sourceText: string }) => { lookupCalls++; entered.resolve(); await finish.promise;
      if (outcome === "unknown") throw new Error("synthetic-lookup-receipt-lost"); return note.sourceText; } };
  let kernel = new AgentTaskKernel(options);
  let journeys = new GrowthJourneys({ ownerId: options.ownerId, directory: path.join(directory, "growth"), kernel });
  t.after(async () => { finish.resolve(); await journeys.close(); await kernel.close(); await rm(directory, { recursive: true, force: true }); });
  let record = await journeys.create({ mode: "synthetic", goal: { title: "回执丢失的断点", targetWeeks: 2, weeklyHours: 1 }, consent: true, idempotencyKey: "pending-goal" }, access);
  record = await journeys.command(record.id, { kind: "select_source", sourceVersion: "checkpoint.v1", expectedRevision: record.revision, requestId: "choose-source", consent: true }, access);
  record = await journeys.command(record.id, { kind: "submit_practice", sourceCode: GROWTH_PRACTICE_STARTER_SOURCE, answer: "读原检查点", explanation: "没有新派送授权", attribution: "guided_example", expectedRevision: record.revision, requestId: "submit-code", consent: true }, access);
  const command = { kind: "step_practice" as const, taskId: record.task!.id, expectedTaskRevision: record.task!.revision,
    expectedRevision: record.revision, requestId: "stable-original-step", consent: true as const };
  const pending = journeys.command(record.id, command, access);
  const rejected = assert.rejects(pending, { code: "growth_access_invalid" });
  await entered.promise; journeys.invalidateSession(access.session); finish.resolve(); await rejected;
  await journeys.close(); await kernel.close(); kernel = new AgentTaskKernel(options);
  journeys = new GrowthJourneys({ ownerId: options.ownerId, directory: path.join(directory, "growth"), kernel });
  const renewed = { session: "explicit-new-synthetic-session", valid: async () => true };
  const restored = await journeys.get(record.id, renewed);
  assert.equal(restored.stage, outcome === "saved" ? "checkpoint_saved" : "outcome_unknown");
  assert.equal(restored.pendingCommand?.requestId, command.requestId);
  const reconciled = await journeys.command(record.id, command, renewed);
  assert.equal(lookupCalls, 1, "the actual lookup adapter is independently observed across reopening and reconciliation");
  assert.equal(reconciled.pendingCommand, undefined);
  assert.deepEqual(reconciled.task?.usage, restored.task?.usage);
  assert.equal(reconciled.task?.practice.phase, restored.task?.practice.phase);
  if (outcome === "unknown") {
    await assert.rejects(journeys.command(record.id, { ...command, expectedRevision: reconciled.revision,
      expectedTaskRevision: reconciled.task!.revision, requestId: "do-not-repeat-unknown-lookup" }, renewed), { code: "growth_task_not_runnable" });
    assert.equal(lookupCalls, 1);
  }
});

test("an explicit corrected attempt preserves the failed source and shares its original cumulative budget", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-growth-corrected-"));
  const kernel = new AgentTaskKernel({ ownerId: "synthetic-growth-owner", directory: path.join(directory, "tasks") });
  const journeys = new GrowthJourneys({ ownerId: "synthetic-growth-owner", directory: path.join(directory, "growth"), kernel });
  t.after(async () => { await journeys.close(); await kernel.close(); await rm(directory, { recursive: true, force: true }); });
  let record = await journeys.create({ mode: "synthetic", goal: { title: "修正练习但不抹去失败和预算", targetWeeks: 2, weeklyHours: 1 }, consent: true, idempotencyKey: "corrected-goal" }, access);
  record = await journeys.command(record.id, { kind: "select_source", sourceVersion: "checkpoint.v1", expectedRevision: record.revision, requestId: "choose-source", consent: true }, access);
  const invalidCode = `function decide(input) { return { kind: "finish", answer: input.answer, explanation: input.explanation, citedSourceId: input.sourceId, citedResultHash: "${"0".repeat(64)}" }; }`;
  record = await journeys.command(record.id, { kind: "submit_practice", sourceCode: invalidCode, answer: "  原始错误作答  ", explanation: "原始解释", attribution: "self_reported", expectedRevision: record.revision, requestId: "first-attempt", consent: true }, access);
  const firstId = record.task!.id;
  record = await journeys.command(record.id, { kind: "step_practice", taskId: firstId, expectedTaskRevision: record.task!.revision, expectedRevision: record.revision, requestId: "fail-first-attempt", consent: true }, access);
  assert.equal(record.stage, "verification_failed");
  assert.equal(record.task?.usage.toolCalls, 1);
  const correction = { kind: "submit_practice" as const, sourceCode: GROWTH_PRACTICE_STARTER_SOURCE, answer: "使用保存结果", explanation: "教学辅助修正", attribution: "guided_example" as const, expectedRevision: record.revision, requestId: "corrected-attempt", consent: true as const };
  record = await journeys.command(record.id, correction, access);
  assert.notEqual(record.task?.id, firstId);
  assert.equal(record.task?.rootTaskId, firstId);
  assert.equal(record.task?.rootLedger?.usage.toolCalls, 1);
  assert.equal(record.taskIds.length, 2);
  assert.equal((await journeys.command(record.id, correction, access)).taskIds.length, 2);
  for (const requestId of ["corrected-lookup", "corrected-verify"]) record = await journeys.command(record.id, { kind: "step_practice", taskId: record.task!.id, expectedTaskRevision: record.task!.revision, expectedRevision: record.revision, requestId, consent: true }, access);
  assert.equal(record.stage, "ready_for_acceptance");
  assert.equal(record.task?.rootLedger?.usage.toolCalls, 7, "one failed check plus the corrected lookup and sandbox checks share one ceiling");
  assert.equal(record.attempts?.[0]?.request.sourceCode, invalidCode);
  assert.equal(record.attempts?.[0]?.request.answer, "  原始错误作答  ");
  assert.equal(record.attempts?.[0]?.practice.phase, "failed");
  assert.equal(record.attempts?.[1]?.practice.phase, "verified");
  assert.equal(record.attemptAttributions?.[firstId], "self_reported");
  assert.equal(record.attemptAttributions?.[record.task!.id], "guided_example");
  assert.equal(record.project, undefined, "a corrected practice still needs its own explicit project acceptance");
});

test("an exhausted practice is a durable known stop, not a permanent pending command or a new budget root", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-growth-budget-"));
  let lookupCalls = 0;
  const kernel = new AgentTaskKernel({ ownerId: "synthetic-growth-owner", directory: path.join(directory, "tasks"),
    growthPracticeLookup: async ({ sourceText }) => { lookupCalls++; return sourceText; } });
  const journeys = new GrowthJourneys({ ownerId: "synthetic-growth-owner", directory: path.join(directory, "growth"), kernel });
  t.after(async () => { await journeys.close(); await kernel.close(); await rm(directory, { recursive: true, force: true }); });
  let record = await journeys.create({ mode: "synthetic", goal: { title: "额度耗尽后仍能读取原停点", targetWeeks: 2, weeklyHours: 1 }, consent: true, idempotencyKey: "budget-goal" }, access);
  record = await journeys.command(record.id, { kind: "select_source", sourceVersion: "checkpoint.v1", expectedRevision: record.revision, requestId: "choose-source", consent: true }, access);
  const submission = { kind: "submit_practice" as const, sourceCode: GROWTH_PRACTICE_STARTER_SOURCE, answer: "保存原账", explanation: "额度不能被新尝试重置", attribution: "guided_example" as const };
  record = await journeys.command(record.id, { ...submission, expectedRevision: record.revision, requestId: "submit-code", consent: true }, access);
  await kernel.budget(record.task!.id, record.task!.revision, { ...record.task!.budget, maxToolCalls: 1 }, access);
  record = await journeys.get(record.id, access);
  const step = { kind: "step_practice" as const, taskId: record.task!.id, expectedTaskRevision: record.task!.revision,
    expectedRevision: record.revision, requestId: "exhausted-step", consent: true as const };
  record = await journeys.command(record.id, step, access);
  assert.equal(record.task?.status, "budget_exhausted");
  assert.equal(record.task?.practice.phase, "failed");
  assert.equal(record.pendingCommand, undefined);
  assert.equal(lookupCalls, 0, "no lookup can be dispatched without its reserved budget");
  assert.ok(record.task!.rootLedger!.usage.toolCalls <= 1);
  assert.deepEqual(await journeys.command(record.id, step, access), record);
  await assert.rejects(journeys.command(record.id, { ...submission, expectedRevision: record.revision, requestId: "cannot-open-fresh-budget", consent: true }, access), { code: "growth_budget_exhausted" });
  assert.equal((await journeys.get(record.id, access)).taskIds.length, 1);
});

test("a drifted project receipt cannot be presented as accepted after reopening the synthetic store", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-growth-project-integrity-"));
  const kernel = new AgentTaskKernel({ ownerId: "synthetic-growth-owner", directory: path.join(directory, "tasks") });
  const options = { ownerId: "synthetic-growth-owner", directory: path.join(directory, "growth"), kernel };
  let journeys = new GrowthJourneys(options);
  t.after(async () => { await journeys.close(); await kernel.close(); await rm(directory, { recursive: true, force: true }); });
  let record = await journeys.create({ mode: "synthetic", goal: { title: "项目回执必须仍指向原报告", targetWeeks: 2, weeklyHours: 1 }, consent: true, idempotencyKey: "project-integrity-goal" }, access);
  record = await journeys.command(record.id, { kind: "select_source", sourceVersion: "checkpoint.v1", expectedRevision: record.revision, requestId: "choose-source", consent: true }, access);
  record = await journeys.command(record.id, { kind: "submit_practice", sourceCode: GROWTH_PRACTICE_STARTER_SOURCE, answer: "保持出处", explanation: "验收不等于绕过哈希", attribution: "guided_example", expectedRevision: record.revision, requestId: "submit-code", consent: true }, access);
  for (const requestId of ["save-checkpoint", "verify-checkpoint"]) record = await journeys.command(record.id, { kind: "step_practice", taskId: record.task!.id, expectedTaskRevision: record.task!.revision, expectedRevision: record.revision, requestId, consent: true }, access);
  record = await journeys.command(record.id, { kind: "accept_project", taskId: record.task!.id, reportHash: record.reportHash!, expectedRevision: record.revision, requestId: "accept-project", consent: true }, access);
  await journeys.close();
  // Deliberately corrupt only this newly created private test fixture, then use
  // the public reopen/read seam. No application or user record is involved.
  const file = path.join(options.directory, `${record.id}.json`);
  const stored = JSON.parse(await readFile(file, "utf8")) as { journey: { project: { reportHash: string } } };
  stored.journey.project.reportHash = "0".repeat(64);
  await writeFile(file, JSON.stringify(stored), { mode: 0o600 });
  journeys = new GrowthJourneys(options);
  await assert.rejects(journeys.get(record.id, access), { code: "growth_project_binding_changed" });
  assert.equal(JSON.parse(await readFile(file, "utf8")).journey.project.reportHash, "0".repeat(64), "invalid history is preserved, not silently repaired");
});
