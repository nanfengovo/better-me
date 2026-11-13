import assert from "node:assert/strict";
import test from "node:test";
import { addCoachRecord, addCoachSubmission, adoptCoachPlan, contextFingerprint, createCoachRecord, createCoachState, goalFingerprint } from "../src/lib/career-coach/state";
import { confirmGoal, confirmedGoal, createDrill, drillMatches, evaluateDrill, planChanges, saveDrillAnswer } from "../src/lib/career-coach/journey";
import { gradePractice, PRACTICE_CASES, practiceBundle, practiceEvidence, readPracticeBundle } from "../src/lib/career-coach/practice";
import { IndexedDbCoachRepository } from "../src/lib/career-coach/storage";
import { parseCoachPayload, validateCoachRequest } from "../src/lib/career-coach/model";
import { CoachStateSchema, type CoachPayload, type CoachRequest, type CoachState } from "../src/lib/career-coach/types";
import { buildCoachMessages } from "@better-me/agent-contracts/career-coach-protocol";
import { ResumeEditContextSchema } from "@better-me/agent-contracts";

const model = { provider: "isolated", name: "fixture", generatedAt: "2026-11-01T00:00:00.000Z" };
const fp = contextFingerprint({});
const initial = () => { const state = createCoachState("isolated-growth-tests"); state.settings.goal = "练习可靠的状态迁移"; state.settings.durationWeeks = 1; return state; };
const analysis: CoachPayload = { kind: "analysis", summary: "先验证状态边界，再讨论工程应用；个人经验待核对。", directions: [{ title: "可靠实现", reason: "用户选择", evidence: ["目标"], tradeoffs: [] }], strengths: [], gaps: [{ skill: "状态模型", status: "unknown", reason: "未提供证据" }], questions: [], nextActions: ["实现隔离练习"] };
const plan: CoachPayload = { kind: "plan", title: "状态建模", goal: "完成可验证练习", durationWeeks: 1, weeklyHours: 5, phases: [{ title: "实践", startWeek: 1, endWeek: 1, objective: "给出测试依据", tasks: [{ id: "task-1", title: "状态练习", week: 1, minutes: 30, deliverable: "实现与测试", acceptanceCriteria: ["非法迁移与重复操作"], resourceQueries: [] }] }], risks: [], reviewCadence: "完成后复盘" };
function record(payload: CoachPayload, state = initial()) { return createCoachRecord({ payload, model }, { mode: payload.kind, settings: state.settings, input: "隔离输入", confirmedGoal: state.goalConfirmations?.at(-1) }); }
function agreed() { const state = initial(), r = record(analysis, state); return confirmGoal(addCoachRecord(state, r), r.id, fp); }
function adopted() { const state = agreed(), r = record(plan, state); return adoptCoachPlan(addCoachRecord(state, r), r.id); }

test("goal confirmation binds the analysis, budget and explicit context; unknown remains unknown", () => {
  const state = agreed(), goal = confirmedGoal(state, fp)!;
  assert.ok(goal); assert.equal(state.records[0]?.payload.kind, "analysis");
  assert.equal(confirmGoal(state, goal.recordId, fp), state);
  for (const changed of [{ goal: "改方向" }, { weeklyHours: 4 }, { background: "新限制" }]) {
    const next = { ...state, settings: { ...state.settings, ...changed } };
    assert.equal(confirmedGoal(next, fp), undefined);
    assert.throws(() => confirmGoal(next, goal.recordId, fp), /变化/);
  }
  assert.equal(confirmedGoal(state, contextFingerprint({ job: { title: "新岗位" } })), undefined);
  assert.equal(confirmedGoal({ ...state, settings: { ...state.settings, interviewRounds: 7 } }, fp)?.id, goal.id, "interview budget is not a goal change");
});

test("resumed Host-normalized context confirms against the same UI source without ignoring real changes", () => {
  const resume = {
    locale: "zh" as const,
    profile: { skills: ["C#", ".NET"], headline: { text: "  合成原文\r\nEND🚧  ", targetRef: { locale: "zh" as const, kind: "profile_headline" as const } } },
    experiences: [],
  };
  const context = { resume, job: { description: "完整合成岗位", title: "工程师" } };
  const parsedContext = { job: { title: "工程师", description: "完整合成岗位" }, resume: ResumeEditContextSchema.parse(resume) };
  assert.notEqual(JSON.stringify(context), JSON.stringify(parsedContext), "exercise the actual Host schema reordering on recovery");
  const state = initial();
  const recovered = createCoachRecord({ payload: analysis, model, task: { id: "ct_" + "a".repeat(32), revision: 2, rootTaskId: "ct_" + "b".repeat(32) } },
    { mode: "analysis", settings: state.settings, input: "完整恢复输入", context: parsedContext });
  const next = confirmGoal(addCoachRecord(state, recovered), recovered.id, contextFingerprint(context));
  assert.equal(confirmedGoal(next, contextFingerprint(context))?.recordId, recovered.id);
  assert.equal(contextFingerprint({ ...context, job: undefined }), contextFingerprint({ resume }), "JSON-omitted undefined is not new shared material");
  for (const changed of [
    { ...context, resume: { ...resume, profile: { ...resume.profile, headline: { ...resume.profile.headline, text: resume.profile.headline.text.trim() } } } },
    { ...context, resume: { ...resume, profile: { ...resume.profile, skills: [...resume.profile.skills].reverse() } } },
    { ...context, job: { ...context.job, description: context.job.description + "新内容" } },
    { resume }, { job: context.job }, {},
  ]) {
    assert.notEqual(contextFingerprint(changed), contextFingerprint(context));
    assert.equal(confirmedGoal(next, contextFingerprint(changed)), undefined);
    assert.throws(() => confirmGoal(next, recovered.id, contextFingerprint(changed)), /变化/);
  }
  const legacy = { ...recovered, basis: { ...recovered.basis, contextFingerprint: "context-v1-legacy-order-dependent" } };
  const legacyState = CoachStateSchema.parse(addCoachRecord(state, legacy));
  assert.equal(legacyState.records[0]?.basis.contextFingerprint, legacy.basis.contextFingerprint, "legacy records remain readable without silently rewriting their approval basis");
  assert.throws(() => confirmGoal(legacyState, legacy.id, contextFingerprint(context)), /变化/);
});

test("plan replacement archives full progress and submissions, not just the old model response", () => {
  let state = adopted();
  state = addCoachSubmission(state, { taskId: "task-1", evidence: "练习真实输出", minutes: 10 });
  const before = structuredClone(state.activePlan);
  const r = record({ ...plan, title: "修改后的计划" }, state);
  state = adoptCoachPlan(addCoachRecord(state, r), r.id);
  assert.deepEqual(state.planHistory, [before]);
  assert.equal(state.submissions.length, 1);
  assert.equal(state.activePlan?.progress["task-1"]?.status, "todo");
  assert.equal(adoptCoachPlan(state, r.id), state);
  assert.deepEqual(CoachStateSchema.parse(state), state, "additive storage schema retains all new history");
});

test("old data remains readable and a stale new plan cannot overwrite it", () => {
  const legacy = createCoachState("legacy"); assert.deepEqual(CoachStateSchema.parse(legacy), legacy);
  const state = agreed(), r = record(plan, state);
  const next = addCoachRecord({ ...state, settings: { ...state.settings, weeklyHours: 4 } }, r);
  assert.throws(() => adoptCoachPlan(next, r.id), /变化/); assert.equal(next.activePlan, undefined);
});

test("plan diff compares task content instead of recycling generated IDs", () => {
  const next = structuredClone(plan); next.phases[0]!.tasks[0]!.title = "增加失败恢复测试";
  assert.deepEqual(planChanges(plan, next), { added: ["增加失败恢复测试"], removed: ["状态练习"], budgetChanged: false, goalChanged: false });
  next.phases[0]!.tasks[0]!.title = "状态练习"; next.phases[0]!.tasks[0]!.id = "another-id";
  assert.deepEqual(planChanges(plan, next).added, []);
});

test("practice grades actual outputs and rejects forged pass counts, incomplete receipts and wrong shape", () => {
  assert.equal(PRACTICE_CASES.length, 11);
  const checks = gradePractice(PRACTICE_CASES.map(({ next }) => JSON.stringify({ ok: true, state: next })));
  assert.equal(checks.filter(item => item.passed).length, 5);
  assert.equal(checks.length, 11);
  assert.throws(() => gradePractice({ passed: 11 }), /不完整/);
  assert.throws(() => gradePractice(["{}"]), /不完整/);
  assert.ok(gradePractice(Array.from({ length: 11 }, () => "undefined")).every(item => !item.passed));
  assert.throws(() => gradePractice(Array.from({ length: 11 }, () => "a".repeat(401))), /限制/);
});

test("exercise imports only code from matching bounded bundles, no file paths or shell operations", () => {
  assert.equal(readPracticeBundle(practiceBundle("return {};")), "return {};");
  assert.throws(() => readPracticeBundle('{"format":"betterme-practice-v1","exerciseId":"other","version":"1","source":"x"}'), /不匹配/);
  assert.equal(readPracticeBundle(practiceBundle("中".repeat(20000))).length, 20000, "Unicode code exports must roundtrip without a smaller file limit");
  assert.throws(() => readPracticeBundle(" ".repeat(128001)), /过大/);
});

test("maximum code and all checks stay complete through saved evidence and the model prompt; duplicate receipts do not duplicate submissions", () => {
  const receipt = { id: "run-max", exerciseId: "state-transitions", version: "1", sourceHash: "a".repeat(64), source: "/".repeat(20000),
    at: model.generatedAt, runner: "opaque-browser-worker" as const,
    checks: gradePractice(Array.from({ length: 11 }, () => "x".repeat(400))) };
  const evidence = practiceEvidence(receipt);
  assert.ok(evidence.length > 20000); assert.ok(evidence.endsWith(receipt.source)); assert.doesNotMatch(evidence, /仅摘录/);
  const next = addCoachSubmission(adopted(), { taskId: "task-1", evidence, minutes: 0, practice: receipt });
  assert.equal(next.submissions[0]?.practice?.source.length, 20000);
  assert.equal(addCoachSubmission(next, { taskId: "task-1", evidence, minutes: 0, practice: receipt }), next);
  assert.equal(next.activePlan?.progress["task-1"]?.status, "submitted", "a receipt is not self-completion");
  const request = validateCoachRequest({ mode: "review", settings: next.settings, input: "完整实践复盘", plan, task: plan.phases[0]!.tasks[0], submission: { evidence, minutes: 0 } });
  assert.equal(request.submission?.evidence, evidence);
  assert.ok(buildCoachMessages(request).some(message => message.content.includes(JSON.stringify(evidence))));
  assert.throws(() => addCoachSubmission(next, { taskId: "task-1", evidence: "x".repeat(64001), minutes: 0 }));
  assert.throws(() => validateCoachRequest({ ...request, submission: { evidence: "x".repeat(64001), minutes: 0 } }));
});

test("storage budget still fails closed before opening IndexedDB and never trims history", async () => {
  const state = initial(); state.revision = 1;
  state.records = Array.from({ length: 260 }, (_, index) => ({ ...record(analysis, state), id: `record-${index}`, input: "x".repeat(12000) }));
  await assert.rejects(new IndexedDbCoachRepository().save(state, 0), /3 MB/);
  assert.equal(state.records.length, 260);
});

const question = { text: "为什么失败后应保留原状态？", skill: "状态边界", why: "关联目标", criteria: ["解释不变量"] };
test("drill saves answers before assessment; duplicate retry does not mutate original evidence", () => {
  let state: CoachState = agreed();
  const r = record({ kind: "drill", question }, state);
  state = createDrill(addCoachRecord(state, r), r, "状态边界", fp);
  const id = state.drills![0]!.id;
  const answer = "  避免非法迁移破坏不变量。\r\n完整作答🚧END  ";
  state = saveDrillAnswer(state, id, answer);
  assert.equal(state.drills![0]!.answer, answer);
  assert.equal(saveDrillAnswer(state, id, answer), state);
  assert.throws(() => saveDrillAnswer(state, id, answer.trim()), /不覆盖/);
  assert.throws(() => saveDrillAnswer(state, id, "覆盖旧答案"), /不覆盖/);
  const feedback = record({ kind: "drill", feedback: { verdict: "supported", quote: "不变量", explanation: "回答说明失败边界，仍未证明生产实践。", nextAction: "增加反例" } }, state);
  state = evaluateDrill(addCoachRecord(state, feedback), id, feedback);
  assert.equal(state.drills![0]!.feedbackRecordId, feedback.id);
  assert.ok(drillMatches(state.drills![0]!, state, fp));
  assert.equal(drillMatches(state.drills![0]!, { ...state, settings: { ...state.settings, goal: "新方向" } }, fp), false);
});

test("drill model protocol rejects pre-answer grades and invented citations", () => {
  const state = agreed(), request: CoachRequest = { mode: "drill", input: "", settings: state.settings, drill: { topic: "状态迁移" } };
  assert.equal(validateCoachRequest(request).mode, "drill");
  const feedback = { kind: "drill", feedback: { verdict: "supported", quote: "虚构原话", explanation: "说明", nextAction: "行动" } };
  assert.throws(() => parseCoachPayload(JSON.stringify(feedback), request), /作答阶段/);
  assert.throws(() => parseCoachPayload(JSON.stringify(feedback), { ...request, drill: { topic: "状态", question, answer: "保持不变量" } }), /引用/);
  assert.throws(() => validateCoachRequest({ ...request, drill: { topic: "状态", answer: "缺原题" } }), /原题/);
  const accepted = { ...feedback, feedback: { ...feedback.feedback, quote: "不变量" } };
  assert.equal(parseCoachPayload(JSON.stringify(accepted), { ...request, drill: { topic: "状态", question, answer: "保持不变量" } }).kind, "drill");
});

test("adaptive interview may conclude based on an answer, but never before one or past its budget", () => {
  const state = agreed(), request: CoachRequest = { mode: "interview", input: "", settings: state.settings,
    interview: { turns: [{ question: "解释状态", answer: "使用允许迁移表，并覆盖失败路径" }], totalRounds: 4, adaptive: true } };
  const payload = { kind: "interview", complete: true, summary: "本场已讨论状态边界，未覆盖性能", feedback: { summary: "基于迁移表和失败路径的回答", strengths: [], improvements: [], rubric: [{ criterion: "边界", score: 2, comment: "给出了迁移表，缺并发依据" }] }, nextActions: ["并发练习"] };
  assert.equal(parseCoachPayload(JSON.stringify(payload), request).kind, "interview");
  assert.throws(() => parseCoachPayload(JSON.stringify(payload), { ...request, interview: { ...request.interview!, turns: [] } }), /尚未收到/);
  assert.throws(() => parseCoachPayload(JSON.stringify(payload), { ...request, interview: { ...request.interview!, adaptive: false } }), /轮次/);
  assert.equal(goalFingerprint(state.settings), state.goalConfirmations!.at(-1)!.fingerprint);
});
