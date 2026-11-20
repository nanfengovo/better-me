import assert from "node:assert/strict";
import test from "node:test";
import { careerJobSnapshotVersion, careerRequirementCapabilityId, careerTrainingRequirements,
  independentRetestEvidence, TrainingView, type CoachTrainingTarget } from "@better-me/agent-contracts";
import { resolveCareerTrainingTarget, type CoachPlan, type CoachState, DEFAULT_COACH_SETTINGS } from "@better-me/agent-contracts/career-coach";

const at = "2026-11-20T00:00:00.000Z";
const retestAt = "2026-11-21T00:00:00.000Z";
const goal = { id: "goal", recordId: "analysis", confirmedAt: at, goal: "解释交接责任", summary: "本人已确认",
  fingerprint: "goal-fingerprint", contextFingerprint: "context-fingerprint" };
const job = { id: "job", title: "协作负责人", company: "合成企业", description: "岗位要求：负责交付\r\n核对交接责任" };
const requirements = careerTrainingRequirements(job);
const snapshotVersion = careerJobSnapshotVersion(job);
const plan: CoachPlan = {
  kind: "plan", goal: goal.goal, title: "验证交接能力", weeklyHours: 2, durationWeeks: 1, reviewCadence: "隔日复测", risks: [],
  phases: [{ title: "交接", objective: goal.goal, startWeek: 1, endWeek: 1,
    tasks: [{ id: "task", title: "核对情境", week: 1, minutes: 30, deliverable: "两次作答",
      acceptanceCriteria: ["明示尚未满足的交付条件"], resourceQueries: [] }] }],
};
const legacy: CoachTrainingTarget = { id: "c4f950d9-6950-4ac0-b3af-6b5d09785d25", goalId: goal.id,
  planId: "plan", taskId: "task", job, itemId: "req-1", quote: "核对交接责任", competency: goal.goal, criterionIndex: 0, createdAt: at };
const state: CoachState = { schemaVersion: 1, workspaceKey: "synthetic-workspace", revision: 1, updatedAt: at,
  settings: DEFAULT_COACH_SETTINGS, records: [{ id: "plan", createdAt: at, mode: "plan", input: goal.goal, payload: plan,
    model: { provider: "example", name: "fixture", generatedAt: at },
    basis: { resumeShared: false, jobShared: true, goalId: goal.id, goalFingerprint: goal.fingerprint, contextFingerprint: goal.contextFingerprint } }],
  goalConfirmations: [goal], activePlan: { id: "plan", plan, startDate: "2026-11-20", progress: {} }, submissions: [], trainingTargets: [legacy] };
const targetRef = { workspaceKey: state.workspaceKey, targetId: legacy.id };
const capabilityId = careerRequirementCapabilityId(snapshotVersion, legacy.itemId, legacy.quote);

test("legacy positional target preserves its original kit context after an inline requirement is introduced", () => {
  assert.equal(requirements[1]?.id, legacy.itemId);
  const context = resolveCareerTrainingTarget(state, targetRef);
  assert.ok(context);
  assert.deepEqual(JSON.parse(JSON.stringify(context)), {
    ...targetRef, planId: "plan", planTitle: "验证交接能力", taskId: "task", taskTitle: "核对情境",
    goalId: goal.id, goal: goal.goal, competency: goal.goal, criterion: "明示尚未满足的交付条件",
    requirement: { jobId: job.id, title: job.title, company: job.company, snapshotVersion, itemId: legacy.itemId, quote: legacy.quote },
  });
  assert.deepEqual(resolveCareerTrainingTarget({ ...state, activePlan: undefined, planHistory: [state.activePlan!] }, targetRef, false), context);
});

test("capability identity is bound to the exact JD requirement and survives competency labels", () => {
  const updated = { ...legacy, competency: "说明交接范围", capabilityId };
  const current = resolveCareerTrainingTarget({ ...state, trainingTargets: [updated] }, targetRef);
  assert.equal(current?.capabilityId, capabilityId);
  assert.equal(current?.competency, "说明交接范围");
  assert.notEqual(careerRequirementCapabilityId(snapshotVersion, requirements[0]!.id, requirements[0]!.originalQuote), capabilityId);
  assert.equal(resolveCareerTrainingTarget({ ...state, trainingTargets: [{ ...updated, capabilityId: "a".repeat(64) }] }, targetRef), undefined);
});

function independentFixture() {
  const screen = { instruction: "回复交接决定", brief: "合成场景", notes: ["核对审批状态"],
    fields: [{ control: "write", key: "part1", label: "能否交付？" }] };
  const practice = { round: "practice", at, answer: { parts: { part1: "可以交付。" } },
    question: screen, questionVersion: "1".repeat(64), usedPreview: true,
    feedback: { met: false, detail: "已保存", evidence: [{ key: "part1", status: "recorded", detail: "已保存作答", nextStep: "区分批准与意向" }] } };
  const retest = { ...practice, round: "retest", at: retestAt, answer: { parts: { part1: "还未获得签字，暂缓交接。" } },
    questionVersion: "2".repeat(64), usedPreview: false, aids: { preview: false, practiceReference: false },
    retestChange: { key: "part1", before: "签字已确认", after: "签字待确认", criterion: "解释当前签字状态如何影响交付。" } };
  return TrainingView.parse({ id: "0d3f509e-aa34-4fed-931d-237832625292", ownerId: "synthetic-owner", title: "交接复测",
    goal: goal.goal, career: resolveCareerTrainingTarget(state, targetRef), focus: "明确交接可行性", kind: "studio", version: "c".repeat(64),
    origin: "local", modelCalls: 2, verifiedCases: 1, saved: true, revision: 3, stage: "complete", attempts: [practice, retest],
    screen, questionVersion: retest.questionVersion });
}

test("independent evidence distinguishes a completed original writing response from mastery", () => {
  const kit = independentFixture();
  const receipt = independentRetestEvidence(kit);
  assert.ok(receipt);
  assert.equal(receipt.completedAt, retestAt);
  assert.equal(receipt.questionVersion, "2".repeat(64));
  assert.equal(receipt.result, "recorded");
  assert.equal(receipt.change.after, "签字待确认");
  assert.deepEqual(independentRetestEvidence({ ...kit, revision: 4 }), receipt);
  const [practice, retest] = kit.attempts;
  assert.ok(practice && retest?.retestChange);
  assert.equal(independentRetestEvidence({ ...kit, saved: false }), undefined);
  assert.equal(independentRetestEvidence({ ...kit, attempts: [practice, { ...retest, aids: undefined }] }), undefined);
  assert.equal(independentRetestEvidence({ ...kit, attempts: [practice, { ...retest, aids: { preview: false, practiceReference: true } }] }), undefined);
  assert.equal(independentRetestEvidence({ ...kit, attempts: [practice, { ...retest, retestChange: undefined }] }), undefined);
  assert.equal(independentRetestEvidence({ ...kit, attempts: [practice, { ...retest,
    retestChange: { ...retest.retestChange, after: "签字已确认！" } }] }), undefined);
});
