import { z } from "zod";
import {
  InterviewDecisionSchema, InterviewFollowUpStateSchema, StudioIdSchema, StudioHashSchema,
  type InterviewFollowUp, type InterviewFollowUpState, type StudioAccess,
} from "@better-me/agent-contracts/career-studio";
import type { TrainingView } from "@better-me/agent-contracts";
import type { OutcomeFeedbackSnapshot } from "@better-me/core/career-intelligence";
import { StudioArtifactStore, StudioError, studioHash, type InterviewSourceScope } from "./storage.js";

const kind = "interview-follow-up";
const listInput = z.object({ contextId: StudioIdSchema, limit: z.number().int().min(1).max(100).default(12), offset: z.number().int().nonnegative().default(0) }).strict();
const decisionInput = z.object({ contextId: StudioIdSchema, consent: z.literal(true), feedbackId: StudioIdSchema,
  id: StudioHashSchema, expectedRevision: z.number().int().nonnegative(), decision: InterviewDecisionSchema }).strict();
const emptyState: InterviewFollowUpState = { plan: null, observation: "", kitId: null, kitVersion: null, retestDueAt: null, retestAt: null,
  independent: null, assessment: null, nextAfterAssessment: "", interviewObservation: "", revision: 0, history: [] };
type Note = OutcomeFeedbackSnapshot["notes"][number];
type Segment = Note["segments"][number];
type InterviewKitProgress = Pick<TrainingView, "id" | "ownerId" | "saved" | "interviewRef" | "version" | "goal" | "dueAt"> & {
  attempts: Array<Pick<TrainingView["attempts"][number], "round" | "at" | "usedPreview" | "aids">>;
};
export type ReadInterviewKit = (kitId: string, access: StudioAccess) => Promise<InterviewKitProgress>;
type InterviewScope = InterviewSourceScope & { fingerprint: string };
type SourceRecord = { ownerId: string; snapshot: OutcomeFeedbackSnapshot };
const sourceId = (feedbackId: string, note: Note, segment: Segment) =>
  studioHash([feedbackId, note.id, note.resumeContentHash, segment.id, segment.hash]);

export function createInterviewFollowUps(options: {
  store: StudioArtifactStore; readKit?: ReadInterviewKit;
  scope: (id: string, access: StudioAccess) => Promise<InterviewScope>;
}) {
  const { store } = options;
  function snapshot(id: string, scope: InterviewScope) {
    const row = store.get<SourceRecord>("outcome-feedback", id);
    const source = row?.value.snapshot;
    if (!row || !source || row.value.ownerId !== store.ownerId || source.binding.ownerId !== store.ownerId ||
        source.binding.workspaceId !== scope.workspaceKey || !source.resumes.some(r => r.resumeId === scope.resumeId &&
          r.versionId === scope.versionId && r.contentHash === scope.contentHash)) throw new StudioError("interview_feedback_unavailable", 404);
    return row.value.snapshot;
  }
  function item(feedbackId: string, note: Note, segment: Segment): InterviewFollowUp {
    const id = sourceId(feedbackId, note, segment);
    const row = store.get<InterviewFollowUpState>(kind, id);
    return { ...(row ? InterviewFollowUpStateSchema.parse(row.value) : emptyState), revision: row?.revision ?? 0,
      id, feedbackId, noteId: note.id, segmentId: segment.id, quote: segment.text, applicationId: note.applicationId,
      versionId: note.resumeVersionId, happenedAt: note.happenedAt };
  }
  function findSource(feedbackId: string, id: string, scope: InterviewScope) {
    for (const note of snapshot(feedbackId, scope).notes) {
      if (note.resumeVersionId !== scope.versionId || note.resumeContentHash !== scope.contentHash) continue;
      const segment = note.segments.find(s => sourceId(feedbackId, note, s) === id);
      if (!segment) continue;
      const links = note.claimLinks.filter(l => l.segmentId === segment.id);
      if (links.some(l => l.confirmedByUser && (l.kind === "questioned" || l.kind === "clarify")) &&
          links.every(l => scope.claims.some(c => c.id === l.claimId && c.hash === l.claimHash))) return item(feedbackId, note, segment);
    }
    throw new StudioError("interview_feedback_unavailable", 404);
  }
  async function recheck(contextId: string, access: StudioAccess, scope: InterviewScope) {
    const current = await options.scope(contextId, access);
    if (current.fingerprint !== scope.fingerprint || current.versionId !== scope.versionId || current.contentHash !== scope.contentHash) throw new StudioError("interview_feedback_scope_changed");
  }
  async function progress(row: InterviewFollowUp, kitId: string, version: string, access: StudioAccess) {
    const kit = await options.readKit?.(kitId, access);
    if (!kit?.saved || kit.ownerId !== store.ownerId || kit.interviewRef !== row.id || kit.id !== kitId || kit.version !== version ||
        kit.goal !== row.plan?.standard) throw new StudioError("interview_training_mismatch");
    const retest = kit.attempts.find(a => a.round === "retest");
    const usedHelp = retest?.usedPreview || retest?.aids?.preview || retest?.aids?.practiceReference;
    return { kitId, kitVersion: version, retestDueAt: kit.dueAt ?? null, retestAt: retest?.at ?? null,
      independent: usedHelp ? false : retest?.aids ? true : null };
  }
  return {
    async followUps(body: unknown, access: StudioAccess) {
      const { contextId, limit, offset } = listInput.parse(body), scope = await options.scope(contextId, access);
      const sources = store.interviewSources(scope, limit + 1, offset);
      const snapshots = new Map<string, OutcomeFeedbackSnapshot>();
      const items = sources.slice(0, limit).map(ref => {
        let source = snapshots.get(ref.feedbackId);
        if (!source) { source = snapshot(ref.feedbackId, scope); snapshots.set(ref.feedbackId, source); }
        const note = source.notes[ref.noteIndex], segment = note?.segments[ref.segmentIndex];
        if (!note || !segment) throw new StudioError("interview_source_changed");
        return item(ref.feedbackId, note, segment);
      });
      await recheck(contextId, access, scope);
      return { items, hasMore: sources.length > limit };
    },
    async decideFollowUp(body: unknown, access: StudioAccess) {
      const request = decisionInput.parse(body), scope = await options.scope(request.contextId, access);
      const original = findSource(request.feedbackId, request.id, scope);
      const decision = request.decision, decisionHash = studioHash(decision);
      if (original.revision !== request.expectedRevision) {
        if (original.revision === request.expectedRevision + 1 && original.history.at(-1)?.decisionHash === decisionHash) {
          await recheck(request.contextId, access, scope);
          return { item: original };
        }
        throw new StudioError("interview_follow_up_changed");
      }
      const next = InterviewFollowUpStateSchema.parse(original);
      let detail: string;
      let previousRound: InterviewFollowUpState["history"][number]["previousRound"];
      switch (decision.kind) {
        case "plan":
          if (JSON.stringify(next.plan) === JSON.stringify(decision.plan)) {
            await recheck(request.contextId, access, scope);
            return { item: original };
          }
          if (next.plan) {
            const { history: _history, revision: _revision, interviewObservation: _laterInterview, ...round } = next;
            previousRound = round;
          }
          Object.assign(next, { ...emptyState, history: next.history, interviewObservation: original.interviewObservation, plan: decision.plan });
          detail = `${{ facts: "核对材料", practice: "表达练习", defer: "暂缓跟进" }[decision.plan.path]} · ${decision.plan.nextAction} · ${decision.plan.standard} · ${decision.plan.dueAt}`;
          break;
        case "observe":
          if (next.plan?.path !== "facts" && next.plan?.path !== "defer") throw new StudioError("interview_observation_requires_plan");
          next.observation = decision.observation;
          detail = `跟进记录 · ${decision.observation}`;
          break;
        case "training": {
          if (next.plan?.path !== "practice" || (next.kitId && (next.kitId !== decision.kitId || next.kitVersion !== decision.kitVersion)))
            throw new StudioError("interview_training_mismatch");
          const result = await progress(original, decision.kitId, decision.kitVersion, access);
          if (next.kitId && next.retestAt === result.retestAt && next.retestDueAt === result.retestDueAt) { await recheck(request.contextId, access, scope); return { item: findSource(request.feedbackId, request.id, scope) }; }
          Object.assign(next, result);
          detail = result.retestAt ? "已带回换题复测记录" : result.retestDueAt ? "已带回首答，等待换题复测" : "已关联保留的练习";
          break;
        }
        case "assess":
          if (!next.retestAt || next.plan?.path !== "practice") throw new StudioError("interview_saved_retest_required");
          next.assessment = decision.assessment; next.observation = decision.observation; next.nextAfterAssessment = decision.nextAction;
          detail = `本人判断${decision.assessment === "met" ? "达标" : "需再练"} · ${decision.observation} · 下一步：${decision.nextAction}`;
          break;
        case "interview":
          if (!next.plan) throw new StudioError("interview_observation_requires_plan");
          next.interviewObservation = decision.observation;
          detail = `后续面试 · ${decision.observation}`;
          break;
      }
      if (next.history.length >= 100) throw new StudioError("interview_follow_up_history_full", 413);
      next.history = [...next.history, { at: new Date().toISOString(), detail, decisionHash, ...(previousRound ? { previousRound } : {}) }];
      next.revision = original.revision + 1;
      await recheck(request.contextId, access, scope);
      store.put(kind, original.id, original.revision, next);
      return { item: { ...original, ...next } };
    },
  };
}
