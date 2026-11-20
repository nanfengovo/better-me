import { CoachRecordSchema, CoachStateSchema, CoachSubmissionSchema, DEFAULT_COACH_SETTINGS,
  resolveCareerTrainingTarget, type CoachContext, type CoachGeneration, type CoachRecord, type CoachRequest, type CoachState, type CoachTaskStatus, type CoachSettings, type PracticeReceipt } from "./types";
import { careerJobSnapshotVersion, careerRequirementCapabilityId, careerWritingEvidenceVersion, CoachTrainingTargetSchema, type CoachTrainingTarget, type TrainingView } from "@better-me/agent-contracts";

export function createCoachState(workspaceKey: string, now = new Date().toISOString()): CoachState {
  return CoachStateSchema.parse({ schemaVersion: 1, workspaceKey, revision: 0, updatedAt: now,
    settings: DEFAULT_COACH_SETTINGS, records: [], submissions: [] });
}

/** Non-secret change token, not a cryptographic identity or an authorization token. */
export function contextFingerprint(context: CoachContext): string {
  return fingerprintValue(canonicalContext(context));
}
/** Schema parsing can reorder object keys; it must not invalidate unchanged source consent.
 * Preserve array order and exact text bytes. Legacy fingerprints are never silently upgraded. */
function canonicalContext(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalContext);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, canonicalContext(entry)]));
  }
  return value;
}
function fingerprintValue(value: unknown): string {
  const raw = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index++) hash = Math.imul(hash ^ raw.charCodeAt(index), 16777619);
  return `context-v1-${raw.length}-${(hash >>> 0).toString(16)}`;
}
export function goalFingerprint(settings: CoachSettings): string {
  const { goal, background, durationWeeks, weeklyHours } = settings;
  return fingerprintValue({ goal, background, durationWeeks, weeklyHours });
}

export function createCoachRecord(generation: CoachGeneration, request: CoachRequest): CoachRecord {
  return CoachRecordSchema.parse({ id: generation.task?.id ?? crypto.randomUUID(), createdAt: new Date().toISOString(), mode: request.mode,
    input: request.input, payload: generation.payload, model: generation.model,
    basis: { resumeShared: Boolean(request.context?.resume), jobShared: Boolean(request.context?.job),
      contextFingerprint: contextFingerprint(request.context ?? {}), goalFingerprint: goalFingerprint(request.settings),
      ...(request.confirmedGoal ? { goalId: request.confirmedGoal.id } : {}),
      ...(generation.task ? { taskId: generation.task.id } : {}),
      ...(request.agentMemoryIds?.length ? { agentMemoryIds: request.agentMemoryIds } : {}) } });
}

export function addCoachRecord(state: CoachState, record: CoachRecord): CoachState {
  const parsed = CoachRecordSchema.parse(record);
  if (parsed.mode !== parsed.payload.kind) throw new Error("结果类型与本次任务不一致，未保存。");
  if (state.records.some((item) => item.id === parsed.id)) return state;
  return { ...state, records: [...state.records, parsed] };
}

export function localCoachDate(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function adoptCoachPlan(state: CoachState, recordId: string, startDate = localCoachDate()): CoachState {
  const record = state.records.find((item) => item.id === recordId);
  if (!record || record.payload.kind !== "plan") throw new Error("未找到可采纳的学习方案。");
  if (state.activePlan?.id === recordId) return state;
  const ids = record.payload.phases.flatMap((phase) => phase.tasks.map((task) => task.id));
  if (new Set(ids).size !== ids.length) throw new Error("方案任务标识重复，请重新生成。");
  const now = new Date().toISOString();
  if (record.basis.goalFingerprint && record.basis.goalFingerprint !== goalFingerprint(state.settings)) throw new Error("目标或时间预算已变化，请重新确认并生成方案；旧方案未覆盖。");
  return { ...state, planHistory: state.activePlan ? [...(state.planHistory ?? []), structuredClone(state.activePlan)] : state.planHistory,
    activePlan: { id: record.id, plan: record.payload, startDate,
    progress: Object.fromEntries(ids.map((id) => [id, { status: "todo" as const, updatedAt: now }])) } };
}

export function updateCoachTask(state: CoachState, taskId: string, status: CoachTaskStatus): CoachState {
  if (!state.activePlan?.plan.phases.some((phase) => phase.tasks.some((task) => task.id === taskId))) throw new Error("该任务不属于当前已采纳方案。");
  return { ...state, activePlan: { ...state.activePlan, progress: { ...state.activePlan.progress,
    [taskId]: { status, updatedAt: new Date().toISOString() } } } };
}

export function addCoachSubmission(state: CoachState, input: { taskId: string; evidence: string; minutes: number; practice?: PracticeReceipt }): CoachState {
  if (!state.activePlan) throw new Error("请先采纳一个学习方案。");
  if (input.practice && state.submissions.some(item => item.practice?.id === input.practice?.id)) return state;
  const next = updateCoachTask(state, input.taskId, "submitted");
  const submission = CoachSubmissionSchema.parse({ id: crypto.randomUUID(), planId: state.activePlan.id, ...input, createdAt: new Date().toISOString() });
  return { ...next, submissions: [...state.submissions, submission] };
}

export function addCareerTrainingTarget(state: CoachState, input: CoachTrainingTarget): CoachState {
  const target = CoachTrainingTargetSchema.parse({ ...input,
    capabilityId: careerRequirementCapabilityId(careerJobSnapshotVersion(input.job), input.itemId, input.quote) });
  if (state.trainingTargets?.some(item => item.id === target.id)) throw new Error("此能力目标已存在。");
  const next = { ...state, trainingTargets: [...(state.trainingTargets ?? []), target] };
  if (!resolveCareerTrainingTarget(next, { workspaceKey: state.workspaceKey, targetId: target.id }))
    throw new Error("岗位原文、已确认目标或当前计划任务已变化。");
  return next;
}

/** Called only after fetching the saved kit from the authenticated Host. The
 * review submission is an explicit snapshot of the completed round(s). */
export function addCareerTrainingEvidence(state: CoachState, kit: TrainingView): CoachState {
  const { career } = kit;
  const last = kit.attempts.at(-1);
  const current = career && resolveCareerTrainingTarget(state, {
    workspaceKey: career.workspaceKey, targetId: career.targetId,
  }, false);
  if (!kit.saved || !last || !career || !current || JSON.stringify(current) !== JSON.stringify(career))
    throw new Error("无法核对练习的原计划与任务关联，请从原任务打开。");
  if (!last.questionVersion || kit.attempts.some(attempt => !attempt.question || !attempt.questionVersion))
    throw new Error("练习缺少作答时的题目版本，无法保存为任务证据。");
  const writingVersion = careerWritingEvidenceVersion(kit.attempts);
  const transferEvidenceVersion = kit.transferDecision?.evidenceVersion;
  if (state.submissions.some(({ training }) => training?.kitId === kit.id && training.version === kit.version
      && training.round === last.round && training.writingVersion === writingVersion
      && training.transferEvidenceVersion === transferEvidenceVersion)) return state;
  const observation = {
    source: "BetterMe 已保留训练观察",
    scope: kit.kind === "studio" ? "逐项标明题面约束核对、公开用例运行或开放原答记录"
      : kit.kind === "canvas" ? "开放填写和自述" : "具体练习规则和沙箱计算",
    goalId: career.goalId,
    goal: kit.goal,
    planId: career.planId,
    taskId: career.taskId,
    targetId: career.targetId,
    requirement: career.requirement,
    competency: career.competency,
    criterion: career.criterion,
    title: kit.title,
    kind: kit.kind,
    origin: kit.origin,
    model: kit.model,
    modelDigest: kit.modelDigest,
    verifiedCases: kit.verifiedCases,
    kitId: kit.id,
    version: kit.version,
    ...(kit.followFrom ? { followFrom: kit.followFrom } : {}),
    ...(kit.transferFrom ? { transferFrom: kit.transferFrom } : {}),
    ...(kit.transferDecision ? { transferDecision: kit.transferDecision } : {}),
    ...(writingVersion ? { writingVersion, writingScope: "引文来自提交的原答，点评来自模型，改写由本人提交" } : {}),
    attempts: kit.attempts,
  };
  const submission = CoachSubmissionSchema.parse({
    id: crypto.randomUUID(), planId: career.planId, createdAt: new Date().toISOString(),
    taskId: career.taskId,
    evidence: JSON.stringify(observation, null, kit.transferFrom || kit.transferDecision ? undefined : 2),
    minutes: 0,
    training: { targetId: career.targetId, kitId: kit.id, version: kit.version, round: last.round, questionVersion: last.questionVersion,
      ...(writingVersion ? { writingVersion } : {}), ...(transferEvidenceVersion ? { transferEvidenceVersion } : {}) },
  });
  const next = state.activePlan?.id === career.planId && state.activePlan.progress[career.taskId]?.status !== "self_completed"
    ? updateCoachTask(state, career.taskId, "submitted") : state;
  return { ...next, submissions: [...next.submissions, submission] };
}

export function getCoachProgress(state: CoachState, now = new Date()) {
  const active = state.activePlan;
  if (!active) return { total: 0, selfCompleted: 0, submitted: 0, overdue: 0, totalMinutes: 0 };
  const tasks = active.plan.phases.flatMap((phase) => phase.tasks);
  const start = new Date(`${active.startDate}T00:00:00`);
  return {
    total: tasks.length,
    selfCompleted: tasks.filter((task) => active.progress[task.id]?.status === "self_completed").length,
    submitted: tasks.filter((task) => active.progress[task.id]?.status === "submitted").length,
    overdue: tasks.filter((task) => {
      const due = new Date(start); due.setDate(due.getDate() + task.week * 7);
      return due.getTime() <= now.getTime() && active.progress[task.id]?.status !== "self_completed";
    }).length,
    totalMinutes: state.submissions.filter((entry) => entry.planId === active.id).reduce((sum, entry) => sum + entry.minutes, 0),
  };
}
