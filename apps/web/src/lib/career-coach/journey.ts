import { goalFingerprint } from "./state";
import { GoalConfirmationSchema, type CoachPlan, type CoachRecord, type CoachState, type DrillAttempt } from "./types";

/** A confirmation binds the exact goal/budget and authorized context, not a model's confidence. */
export function confirmedGoal(state: CoachState, context: string) {
  const current = state.goalConfirmations?.at(-1);
  return current?.fingerprint === goalFingerprint(state.settings) && current.contextFingerprint === context ? current : undefined;
}
export function confirmGoal(state: CoachState, recordId: string, context: string): CoachState {
  const record = state.records.find(item => item.id === recordId);
  if (!record || record.payload.kind !== "analysis" || record.basis.contextFingerprint !== context
    || record.basis.goalFingerprint !== goalFingerprint(state.settings)) throw new Error("这次理解的目标或授权资料已变化，请重新分析后确认。");
  if (confirmedGoal(state, context)?.recordId === record.id) return state;
  const confirmation = GoalConfirmationSchema.parse({ id: crypto.randomUUID(), recordId, confirmedAt: new Date().toISOString(),
    goal: state.settings.goal, summary: record.payload.summary, fingerprint: goalFingerprint(state.settings),
    contextFingerprint: context, agentMemoryIds: record.basis.agentMemoryIds });
  return { ...state, goalConfirmations: [...(state.goalConfirmations ?? []), confirmation] };
}

/** IDs are local to a generated plan. Compare task content, never task-1 with task-1. */
export function planChanges(previous: CoachPlan | undefined, next: CoachPlan) {
  const before = previous?.phases.flatMap(phase => phase.tasks) ?? [], after = next.phases.flatMap(phase => phase.tasks);
  const key = (task: typeof before[number]) => JSON.stringify([task.title, task.week, task.minutes, task.deliverable, task.acceptanceCriteria, task.resourceQueries]);
  const remaining = before.map(key), added: string[] = [];
  for (const task of after) {
    const index = remaining.indexOf(key(task));
    if (index < 0) added.push(task.title); else remaining.splice(index, 1);
  }
  return { added, removed: remaining.map(item => String((JSON.parse(item) as unknown[])[0])),
    budgetChanged: Boolean(previous && (previous.weeklyHours !== next.weeklyHours || previous.durationWeeks !== next.durationWeeks)),
    goalChanged: Boolean(previous && previous.goal !== next.goal) };
}

export function createDrill(state: CoachState, record: CoachRecord, topic: string, context: string): CoachState {
  if (record.payload.kind !== "drill" || !record.payload.question) throw new Error("本次没有有效题目。");
  const attempt: DrillAttempt = { id: crypto.randomUUID(), at: new Date().toISOString(), topic,
    question: record.payload.question, questionRecordId: record.id, contextFingerprint: context,
    goalFingerprint: goalFingerprint(state.settings), answer: "" };
  return { ...state, drills: [...(state.drills ?? []), attempt] };
}
export function saveDrillAnswer(state: CoachState, id: string, answer: string): CoachState {
  const attempt = state.drills?.find(item => item.id === id);
  if (!attempt || !answer.trim() || answer.length > 12000) throw new Error("请先填写自己的回答。");
  if (attempt.answer) { if (attempt.answer === answer.trim()) return state; throw new Error("这次作答已保存；请发起新的尝试，不覆盖原回答。"); }
  return { ...state, drills: state.drills!.map(item => item.id === id ? { ...item, answer: answer.trim(), draft: undefined } : item) };
}
export function evaluateDrill(state: CoachState, id: string, record: CoachRecord): CoachState {
  const attempt = state.drills?.find(item => item.id === id);
  if (record.payload.kind !== "drill" || !record.payload.feedback || !attempt?.answer
    || !attempt.answer.includes(record.payload.feedback.quote)) throw new Error("评价缺少本次回答的真实引用，未采用。");
  return { ...state, drills: state.drills!.map(item => item.id === id ? { ...item, feedbackRecordId: record.id, disputed: false } : item) };
}

/** A pending/different-goal answer cannot silently become input to a new interview or plan. */
export function drillMatches(attempt: DrillAttempt, state: CoachState, context: string) {
  return attempt.contextFingerprint === context && attempt.goalFingerprint === goalFingerprint(state.settings);
}
