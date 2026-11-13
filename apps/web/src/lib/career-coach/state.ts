import { CoachRecordSchema, CoachStateSchema, CoachSubmissionSchema, DEFAULT_COACH_SETTINGS,
  type CoachContext, type CoachGeneration, type CoachRecord, type CoachRequest, type CoachState, type CoachTaskStatus, type CoachSettings, type PracticeReceipt } from "./types";

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
