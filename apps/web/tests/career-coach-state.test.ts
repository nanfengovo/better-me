import assert from "node:assert/strict";
import test from "node:test";
import {
  addCoachRecord, addCoachSubmission, adoptCoachPlan, contextFingerprint, createCoachRecord,
  createCoachState, getCoachProgress, localCoachDate, updateCoachTask,
} from "../src/lib/career-coach/state";
import { DEFAULT_COACH_SETTINGS, type CoachPlan, type CoachRecord, type CoachState } from "../src/lib/career-coach/types";

const AT = "2026-10-22T08:00:00.000Z";
function planRecord(id = "plan-a"): CoachRecord {
  const plan: CoachPlan = {
    kind: "plan", title: "合成学习方案", goal: "用可核验产物练习", durationWeeks: 2, weeklyHours: 3,
    phases: [{ title: "基础练习", startWeek: 1, endWeek: 2, objective: "形成两类证据", tasks: [
      { id: "task-a", title: "完成练习", week: 1, minutes: 60, deliverable: "测试记录", acceptanceCriteria: ["测试能复现"], resourceQueries: [] },
      { id: "task-b", title: "解释方案", week: 1, minutes: 30, deliverable: "方案说明", acceptanceCriteria: ["说明约束"], resourceQueries: [] },
      { id: "task-c", title: "总结复盘", week: 2, minutes: 45, deliverable: "复盘笔记", acceptanceCriteria: ["区分证据和自评"], resourceQueries: [] },
    ] }], risks: [], reviewCadence: "每周自查一次",
  };
  return { id, createdAt: AT, mode: "plan", input: "合成输入", payload: plan,
    model: { provider: "fixture", name: "synthetic-model", generatedAt: AT },
    basis: { resumeShared: false, jobShared: false, contextFingerprint: contextFingerprint({}) } };
}
function adopted(): CoachState {
  return adoptCoachPlan(addCoachRecord(createCoachState("workspace-a", AT), planRecord()), "plan-a", "2026-10-22");
}

test("fresh workspaces have independent settings and no records or adopted plan", () => {
  const a = createCoachState("workspace-a", AT), b = createCoachState("workspace-b", AT);
  assert.equal(a.workspaceKey, "workspace-a"); assert.equal(b.workspaceKey, "workspace-b");
  assert.equal(a.revision, 0); assert.equal(a.updatedAt, AT);
  assert.deepEqual(a.settings, DEFAULT_COACH_SETTINGS);
  assert.deepEqual(a.records, []); assert.deepEqual(a.submissions, []); assert.equal(a.activePlan, undefined);
  a.settings.goal = "只修改甲"; a.records.push(planRecord());
  assert.equal(b.settings.goal, ""); assert.deepEqual(b.records, []); assert.equal(DEFAULT_COACH_SETTINGS.goal, "");
});

test("record creation records explicit context sharing and rejects mismatched result kinds", () => {
  const record = planRecord();
  const generated = createCoachRecord({ payload: record.payload, model: record.model }, {
    mode: "plan", settings: { ...DEFAULT_COACH_SETTINGS }, input: "生成方案", context: { job: { title: "合成岗位" } },
  });
  assert.equal(generated.basis.resumeShared, false); assert.equal(generated.basis.jobShared, true);
  assert.equal(generated.basis.contextFingerprint, contextFingerprint({ job: { title: "合成岗位" } }));
  assert.notEqual(generated.basis.contextFingerprint, contextFingerprint({}));
  assert.throws(() => addCoachRecord(createCoachState("workspace-a", AT), { ...record, mode: "review" }), /类型.*不一致/);
});

test("duplicate record delivery is idempotent and cannot replace an earlier record", () => {
  const initial = createCoachState("workspace-a", AT), record = planRecord();
  const next = addCoachRecord(initial, record);
  const duplicate = addCoachRecord(next, { ...record, input: "迟到的不同内容" });
  assert.equal(duplicate, next); assert.equal(next.records.length, 1); assert.equal(next.records[0]?.input, "合成输入");
  assert.deepEqual(initial.records, [], "adding a record must not mutate the previous state");
});

test("record limits fail visibly without silently truncating history", () => {
  let state = createCoachState("workspace-a", AT);
  for (let index = 0; index < 80; index++) state = addCoachRecord(state, planRecord(`plan-${index}`));
  const ids = state.records.map(record => record.id);
  assert.throws(() => addCoachRecord(state, planRecord("over-limit")), /80.*备份/);
  assert.deepEqual(state.records.map(record => record.id), ids);
  assert.equal(addCoachRecord(state, state.records[0]!), state, "duplicate delivery remains harmless even at the limit");
});

test("adopting a saved plan initializes tasks and adopting it again preserves progress", () => {
  const state = adopted();
  assert.equal(state.activePlan?.startDate, "2026-10-22");
  assert.deepEqual(Object.keys(state.activePlan!.progress), ["task-a", "task-b", "task-c"]);
  assert.ok(Object.values(state.activePlan!.progress).every(item => item.status === "todo"));
  const changed = updateCoachTask(state, "task-a", "in_progress");
  assert.equal(adoptCoachPlan(changed, "plan-a", "2026-11-01"), changed);
  assert.equal(state.activePlan?.progress["task-a"]?.status, "todo", "updates are immutable");
});

test("switching plans retains earlier records and submissions and scopes progress totals to the new plan", () => {
  let state = addCoachSubmission(adopted(), { taskId: "task-a", evidence: "甲方案证据", minutes: 90 });
  const oldSubmission = structuredClone(state.submissions[0]);
  state = addCoachRecord(state, planRecord("plan-b"));
  state = adoptCoachPlan(state, "plan-b", "2026-10-29");
  assert.deepEqual(state.records.map(record => record.id), ["plan-a", "plan-b"]);
  assert.deepEqual(state.submissions, [oldSubmission]);
  assert.equal(state.activePlan?.progress["task-a"]?.status, "todo");
  assert.equal(getCoachProgress(state).totalMinutes, 0, "reused task IDs do not import evidence from another plan");
  state = addCoachSubmission(state, { taskId: "task-a", evidence: "乙方案独立证据", minutes: 25 });
  assert.deepEqual(state.submissions.map(item => item.planId), ["plan-a", "plan-b"]);
  assert.equal(getCoachProgress(state).totalMinutes, 25);
});

test("unknown plans, non-plan records, and duplicate task IDs cannot be adopted", () => {
  const state = createCoachState("workspace-a", AT);
  assert.throws(() => adoptCoachPlan(state, "missing"), /未找到/);
  const review: CoachRecord = { ...planRecord("review-a"), mode: "review", payload: { kind: "review", summary: "合成评估", evidenceAssessment: "insufficient", strengths: [], improvements: [], nextActions: [], checkQuestions: [] } };
  assert.throws(() => adoptCoachPlan(addCoachRecord(state, review), review.id), /未找到/);
  const duplicate = planRecord();
  if (duplicate.payload.kind !== "plan") throw new Error("fixture must be a plan");
  duplicate.payload.phases[0]!.tasks[1]!.id = "task-a";
  assert.throws(() => adoptCoachPlan(addCoachRecord(state, duplicate), duplicate.id), /标识重复/);
  assert.deepEqual(state.records, []);
});

test("submitting evidence is distinct from self-completion and never implies verified mastery", () => {
  const initial = adopted();
  const submitted = addCoachSubmission(initial, { taskId: "task-a", evidence: "  可复查的合成测试输出  ", minutes: 60 });
  assert.equal(submitted.activePlan?.progress["task-a"]?.status, "submitted");
  assert.equal(submitted.submissions[0]?.evidence, "可复查的合成测试输出");
  assert.equal(submitted.submissions[0]?.planId, "plan-a");
  const summary = getCoachProgress(submitted, new Date(2026, 9, 23));
  assert.equal(summary.submitted, 1); assert.equal(summary.selfCompleted, 0); assert.equal(summary.totalMinutes, 60);
  const selfCompleted = updateCoachTask(submitted, "task-a", "self_completed");
  assert.equal(getCoachProgress(selfCompleted).selfCompleted, 1); assert.equal(getCoachProgress(selfCompleted).submitted, 0);
  assert.deepEqual(selfCompleted.submissions, submitted.submissions); assert.deepEqual(initial.submissions, []);
});

test("unknown task IDs and invalid submission data leave existing state untouched", () => {
  const state = adopted(), before = structuredClone(state);
  assert.throws(() => updateCoachTask(state, "foreign-task", "self_completed"), /不属于/);
  assert.throws(() => addCoachSubmission(state, { taskId: "foreign-task", evidence: "证据", minutes: 10 }), /不属于/);
  assert.throws(() => addCoachSubmission(state, { taskId: "task-a", evidence: "   ", minutes: 10 }));
  assert.throws(() => addCoachSubmission(state, { taskId: "task-a", evidence: "证据", minutes: -1 }));
  assert.throws(() => addCoachSubmission(createCoachState("workspace-b", AT), { taskId: "task-a", evidence: "证据", minutes: 10 }), /先采纳/);
  assert.deepEqual(state, before);
});

test("submission limits preserve every prior submission and do not advance a task on failure", () => {
  let state = adopted();
  for (let index = 0; index < 240; index++) state = addCoachSubmission(state, { taskId: "task-a", evidence: `证据 ${index}`, minutes: 1 });
  const before = structuredClone(state);
  assert.throws(() => addCoachSubmission(state, { taskId: "task-b", evidence: "超额提交", minutes: 1 }), /240.*备份/);
  assert.deepEqual(state, before); assert.equal(state.activePlan?.progress["task-b"]?.status, "todo");
});

test("overdue dates use local calendar week boundaries; submitted work still awaits self-check", () => {
  let state = updateCoachTask(adopted(), "task-a", "self_completed");
  state = addCoachSubmission(state, { taskId: "task-b", evidence: "尚待自检", minutes: 20 });
  assert.equal(localCoachDate(new Date(2026, 9, 28, 23, 59, 59)), "2026-10-28");
  assert.equal(getCoachProgress(state, new Date(2026, 9, 28, 23, 59, 59, 999)).overdue, 0);
  const firstWeekEnd = getCoachProgress(state, new Date(2026, 9, 29, 0, 0, 0));
  assert.equal(firstWeekEnd.overdue, 1); assert.equal(firstWeekEnd.selfCompleted, 1); assert.equal(firstWeekEnd.submitted, 1);
  assert.equal(getCoachProgress(state, new Date(2026, 10, 5, 0, 0, 0)).overdue, 2);
  assert.deepEqual(getCoachProgress(createCoachState("empty", AT)), { total: 0, selfCompleted: 0, submitted: 0, overdue: 0, totalMinutes: 0 });
});
