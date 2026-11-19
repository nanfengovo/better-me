import { randomUUID, createHash } from "node:crypto";
import {
  TrainingAdvice,
  TrainingBuild,
  TrainingCommand,
  TrainingFollowSource,
  TrainingStart,
  TrainingView,
  TrainingTransferAdvice,
  trainingTransferInput,
  type TrainingTransferDecision,
  type TrainingTransferRef,
  type TrainingTransferSource,
  TrainingWritingFeedback,
  trainingRewriteSourceDetail,
  type TrainingPlan,
  type TrainingDesign,
  type TrainingAttempt,
  type TrainingFeedback,
  type TrainingCareerContext,
  type TrainingCareerRef,
  type TrainingFollowRef,
  type TrainingScreen,
} from "@better-me/agent-contracts";
import type { CareerTaskAccess } from "../kernel/service.js";
import { LearningStore, learningFail } from "./learning-store.js";
import {
  examples,
  exampleSource,
  makeScreen,
  qualify,
  runAnswer,
  TrainingProgramMismatch,
  validateDesign,
} from "./training-rules.js";
import { studioSource } from "./training-studio.js";
import { localTrainingAuthor, type TrainingAuthor } from "./training-model.js";

const DAY = 24 * 60 * 60 * 1000;
type Access = CareerTaskAccess & { signal?: AbortSignal };
type Draft = {
  plan: TrainingPlan;
  pin?: string;
  session: string;
  expires: number;
  used: boolean;
};
type Kit = {
  id: string;
  ownerId: string;
  plan: TrainingPlan;
  modelDigest?: string;
  design: TrainingDesign;
  source: string;
  version: string;
  calls: number;
  checks: number;
  revision: number;
  attempts: TrainingAttempt[];
  explored: [boolean, boolean];
  // Absent in legacy kits, for which opening the first attempt went unobserved.
  practiceReferenceViewed?: boolean;
  transferDecision?: TrainingTransferDecision;
  saved: boolean;
  questions?: [TrainingScreen, TrainingScreen];
};
export type TrainingTargetResolver = (ref: TrainingCareerRef, access: CareerTaskAccess) => Promise<TrainingCareerContext | undefined>;
type Preview = { kit: Kit; session: string; expires: number };
type WritingCommand = Extract<TrainingCommand, { action: "review-writing" | "save-rewrite" }>;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const signature = (
  k: Pick<Kit, "design" | "source" | "plan" | "modelDigest" | "questions">,
) =>
  hash([
    k.plan.transferFrom ? "training-kit-v4" : k.plan.followFrom ? "training-kit-v3" : k.questions ? "training-kit-v2" : "training-kit-v1",
    k.plan.origin,
    k.plan.model ?? null,
    k.modelDigest ?? null,
    k.design,
    k.source,
    ...(k.questions ? [k.plan.career ?? null, k.questions] : []),
    ...(k.plan.followFrom ? [k.plan.followFrom] : []),
    ...(k.plan.transferFrom ? [k.plan.transferFrom] : []),
  ]);
const screenFor = (k: Kit, index: number) => k.questions?.[index] ?? makeScreen(k.design, index);
const questionVersion = (k: Kit, index: number, screen: TrainingScreen) => hash([k.version, index, screen]);
const stage = (k: Kit, now: number): TrainingView["stage"] =>
  !k.attempts[0]
    ? "practice"
    : k.attempts.length > 1
      ? "complete"
      : now >= Date.parse(k.attempts[0].at) + DAY
        ? "retest"
        : "waiting";

const referenceHidden = (k: Kit, phase: TrainingView["stage"]) =>
  phase === "retest" && k.design.kind === "studio" && k.practiceReferenceViewed !== true;

/** One owner. Anonymous/other owners never get this store. Drafts never survive session
 * revocation or restart. Only explicit keep writes content; a request tombstone prevents
 * automatic inference replay even when the host dies before delivering its response. */
export class TrainingKits {
  private trackingReady = false;
  private plans = new Map<string, Draft>();
  private previews = new Map<string, Preview>();
  private active = new Map<
    string,
    { session: string; stop: AbortController }
  >();
  constructor(
    private store: LearningStore,
    private author: TrainingAuthor = localTrainingAuthor,
    private clock: () => number = Date.now,
    private resolveCareerTarget?: TrainingTargetResolver,
  ) {}
  /** Upgrade only rounds that could never have opened under the previous client.
   * The owner store serializes this update with commands; completed evidence is immutable. */
  private async prepare(access: CareerTaskAccess) {
    if (this.trackingReady) return this.store.assert(access);
    await this.store.run(access, db => {
      if (this.trackingReady) return;
      db.prepare(`UPDATE training_kits SET body=json_set(body, '$.practiceReferenceViewed', json('false'))
        WHERE active=1 AND json_extract(body, '$.ownerId')=?
          AND json_extract(body, '$.design.kind')='studio' AND json_type(body, '$.practiceReferenceViewed') IS NULL
          AND (json_array_length(body, '$.attempts')=0 OR (json_array_length(body, '$.attempts')=1
            AND julianday(json_extract(body, '$.attempts[0].at')) > julianday(?)))`)
        .run(this.store.ownerId, new Date(this.clock() - DAY).toISOString());
      this.trackingReady = true;
    });
  }
  private async career(ref: TrainingCareerRef, access: CareerTaskAccess) {
    const value = await this.resolveCareerTarget?.(ref, access);
    if (!value) learningFail("training_career_target_changed", 409);
    return value;
  }
  private async assertCareer(career: TrainingCareerContext | undefined, access: CareerTaskAccess) {
    if (!career) return;
    const current = await this.career({ workspaceKey: career.workspaceKey, targetId: career.targetId }, access);
    if (JSON.stringify(current) !== JSON.stringify(career)) learningFail("training_career_target_changed", 409);
  }
  private async followSource(ref: TrainingFollowRef, goal: string, career: TrainingCareerContext | undefined, access: CareerTaskAccess) {
    const parent = await this.read(ref.kitId, access);
    if (ref.round === "practice" && referenceHidden(parent, stage(parent, this.clock())))
      learningFail("training_practice_reference_required", 409);
    const attempt = parent.attempts.find(item => item.round === ref.round);
    const field = attempt?.question?.fields.find(item => item.key === ref.key);
    const evidence = attempt?.feedback.evidence?.find(item => item.key === ref.key);
    const answer = attempt && "parts" in attempt.answer ? attempt.answer.parts[ref.key] : undefined;
    if (!parent.saved || parent.design.kind !== "studio" || parent.plan.goal !== goal || parent.version !== ref.version ||
        JSON.stringify(parent.plan.career) !== JSON.stringify(career) ||
        !attempt?.questionVersion || !field || !evidence || !answer)
      learningFail("training_follow_source_changed", 409);
    const review = ref.useRewrite && attempt.writingReviews?.find(item =>
      item.key === ref.key && item.questionVersion === attempt.questionVersion);
    if (ref.useRewrite && (field.control !== "write" || !review || !review.rewrite))
      learningFail("training_follow_source_changed", 409);
    return TrainingFollowSource.parse({
      kitId: parent.id, version: parent.version, round: attempt.round, key: ref.key,
      questionVersion: attempt.questionVersion, kitTitle: parent.design.title, questionLabel: field.label,
      answer, usedPreview: attempt.usedPreview, status: evidence.status, detail: evidence.detail, nextStep: evidence.nextStep,
      ...(review && review.rewrite ? {
        useRewrite: true, answer: review.rewrite.answer, usedPreview: true, status: "recorded",
        detail: trainingRewriteSourceDetail, nextStep: review.revisionPrompt,
      } : {}),
    });
  }
  private transferInput(k: Kit) {
    if (!k.saved || k.design.kind !== "studio" || k.plan.origin !== "local" || !k.modelDigest ||
        k.attempts.some((a, i) => !a.question || a.questionVersion !== questionVersion(k, i, a.question)))
      learningFail("training_transfer_unavailable", 409);
    const input = trainingTransferInput(k.plan.goal, k.attempts, k.plan.transferFrom?.nextGoal);
    if (!input) learningFail("training_transfer_unavailable", 409);
    return input;
  }
  private async transferSource(ref: TrainingTransferRef, goal: string, career: TrainingCareerContext | undefined, access: CareerTaskAccess): Promise<TrainingTransferSource> {
    const parent = await this.read(ref.kitId, access);
    const decision = parent.transferDecision;
    if (parent.version !== ref.version || parent.plan.goal !== goal || JSON.stringify(parent.plan.career) !== JSON.stringify(career) ||
        !decision || decision.evidenceVersion !== ref.evidenceVersion) learningFail("training_transfer_source_changed", 409);
    const input = this.transferInput(parent);
    if (hash(input) !== ref.evidenceVersion) learningFail("training_transfer_source_changed", 409);
    const { direction, nextGoal, actions, reasons } = decision;
    return { kitId: parent.id, version: parent.version, evidenceVersion: decision.evidenceVersion, kitTitle: parent.design.title,
      direction, nextGoal, actions, reasons, citations: input.evidence.filter(e => reasons.some(r => r.evidenceId === e.id)),
      practiceVersion: input.practice.questionVersion, retestVersion: input.retest.questionVersion,
      retestIndependence: input.retest.independence, retestAids: input.retest.aids };
  }
  private async assertInputs(plan: Pick<TrainingPlan, "goal" | "career" | "followFrom" | "transferFrom">, access: CareerTaskAccess) {
    await this.assertCareer(plan.career, access);
    if (plan.transferFrom) {
      const current = await this.transferSource(plan.transferFrom, plan.goal, plan.career, access);
      if (JSON.stringify(current) !== JSON.stringify(plan.transferFrom)) learningFail("training_transfer_source_changed", 409);
    }
    if (plan.followFrom) {
      const current = await this.followSource(plan.followFrom, plan.goal, plan.career, access);
      if (JSON.stringify(current) !== JSON.stringify(plan.followFrom)) learningFail("training_follow_source_changed", 409);
    }
  }
  private purge() {
    const now = this.clock();
    for (const [id, v] of this.plans)
      if (v.expires <= now) this.plans.delete(id);
    for (const [id, v] of this.previews)
      if (v.expires <= now) this.previews.delete(id);
  }
  private async guarded<T>(
    key: string,
    access: Access,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    await this.prepare(access);
    this.purge();
    if (this.active.has(key) || this.active.size >= 3)
      learningFail("training_busy", 409);
    const stop = new AbortController(),
      signal = AbortSignal.any([
        stop.signal,
        AbortSignal.timeout(210_000),
        ...(access.signal ? [access.signal] : []),
      ]);
    signal.throwIfAborted();
    this.active.set(key, { session: access.session, stop });
    try {
      const result = await fn(signal);
      signal.throwIfAborted();
      await this.store.assert(access);
      return result;
    } finally {
      this.active.delete(key);
    }
  }
  private once(id: string, access: CareerTaskAccess) {
    return this.store.run(access, (db) => {
      if (
        !db
          .prepare("INSERT OR IGNORE INTO training_requests(id) VALUES(?)")
          .run(id).changes
      )
        learningFail("training_request_already_used", 409);
    });
  }
  async plan(raw: unknown, access: Access): Promise<TrainingPlan> {
    const input = TrainingStart.parse(raw);
    return this.guarded("author", access, async (signal) => {
      if (this.plans.size >= 24) learningFail("training_preview_limit", 429);
      const career = input.careerTarget ? await this.career(input.careerTarget, access) : undefined;
      if (career && input.goal !== career.competency) learningFail("training_career_target_changed", 409);
      if (input.followFrom && input.engine.type !== "local") learningFail("training_follow_source_changed", 409);
      if (input.transferFrom && (input.followFrom || input.engine.type !== "local" || input.evidence))
        learningFail("training_transfer_source_changed", 409);
      const transferFrom = input.transferFrom ? await this.transferSource(input.transferFrom, input.goal, career, access) : undefined;
      const followFrom = input.followFrom ? await this.followSource(input.followFrom, input.goal, career, access) : undefined;
      await this.once(input.requestId, access);
      let advice: TrainingAdvice, pin: string | undefined;
      if (input.engine.type === "local") {
        const model = input.engine.model;
        try {
          pin = await this.author.pin(model, signal);
          await this.store.assert(access);
          await this.assertInputs({ goal: input.goal, career, followFrom, transferFrom }, access);
          advice = transferFrom ? { route: "studio", practiceActions: transferFrom.actions,
            observation: transferFrom.reasons[0]!.reason, nextStep: transferFrom.nextGoal } : TrainingAdvice.parse(
            await this.author.diagnose(
              model,
              pin,
              input.goal,
              input.evidence,
              signal,
              career,
              followFrom,
            ),
          );
        } catch (error) {
          if (error instanceof Error && ["training_career_target_changed", "training_follow_source_changed", "training_transfer_source_changed", "training_kit_not_found"].includes(error.message)) throw error;
          return learningFail("training_local_diagnosis_failed", 422);
        }
      } else {
        const k = input.engine.example;
        advice = {
          route: k,
          observation:
            k === "canvas"
              ? "示例假设：汇报背景太长，没能说清要对方做什么。"
              : k === "rewrite"
                ? "示例假设：邮件过长，改短时易漏请求或日期。"
              : k === "concurrency"
                ? "示例假设：知道并发异常，但不确定重新读取后如何作业务决定。"
                : "示例假设：能估算单项耗时，但容易忽略并行和依赖。",
          nextStep:
            k === "canvas"
              ? "在两个情境中写下开场，再比较有没有交代下一步。"
              : k === "rewrite"
                ? "试着保留请求和日期，用一句话完成邮件。"
                : k === "concurrency"
                  ? "在余量不足和足够的两个模拟情境中判断冲突及扣减结果。"
                  : "先预测一个并行任务晚两天会不会影响交付。",
        };
      }
      await this.store.assert(access);
      await this.assertInputs({ goal: input.goal, career, followFrom, transferFrom }, access);
      signal.throwIfAborted();
      const plan: TrainingPlan = {
        id: randomUUID(),
        goal: input.goal,
        evidence: input.evidence,
        ...(career ? { career } : {}),
        ...(followFrom ? { followFrom } : {}),
        ...(transferFrom ? { transferFrom } : {}),
        advice,
        origin: input.engine.type,
        ...(input.engine.type === "local" ? { model: input.engine.model } : {}),
        modelCalls: input.engine.type === "local" && !transferFrom ? 1 : 0,
      };
      this.plans.set(plan.id, {
        plan,
        pin,
        session: access.session,
        expires: this.clock() + 2 * 60 * 60 * 1000,
        used: false,
      });
      return plan;
    });
  }
  async build(raw: unknown, access: Access) {
    const input = TrainingBuild.parse(raw);
    return this.guarded("author", access, async (signal) => {
      const draft = this.plans.get(input.planId);
      if (!draft || draft.session !== access.session)
        learningFail("training_plan_expired", 404);
      let plan = draft.plan;
      const { pin } = draft, kind = plan.advice.route;
      if (kind === "simple" || kind === "clarify")
        learningFail("training_no_app_needed", 422);
      if (input.actions && plan.transferFrom && JSON.stringify(input.actions) !== JSON.stringify(plan.transferFrom.actions))
        learningFail("training_transfer_actions_changed", 409);
      const actions = input.actions ?? plan.transferFrom?.actions;
      if (actions) {
        if (kind !== "studio" || plan.origin !== "local") learningFail("training_actions_unavailable", 422);
        const advice = { ...plan.advice, practiceActions: actions };
        if (!plan.advice.practiceActions?.includes("code") || !actions.includes("code")) delete advice.codeSignature;
        plan = { ...plan, advice };
      }
      if (draft.used) learningFail("training_plan_already_used", 409);
      if (this.previews.size >= 12) learningFail("training_preview_limit", 429);
      await this.assertInputs(plan, access);
      await this.once(input.requestId, access);
      draft.used = true;
      let d: TrainingDesign,
        source: string,
        checks = 0,
        calls = plan.modelCalls;
      if (plan.origin === "example") {
        if (kind === "studio") learningFail("training_design_invalid", 422);
        d = validateDesign(examples[kind], kind);
        source = exampleSource[kind];
        checks = await qualify(source, d, signal);
      } else {
        try {
          calls++;
          d = validateDesign(
            await this.author.design(plan, pin!, kind, signal, actions !== undefined),
            kind,
          );
          if (actions && d.kind === "studio") {
            if (!d.scenes.every(scene => scene.steps.length === actions.length &&
              scene.steps.every((step, index) => step.mode === actions[index]))) learningFail("training_design_invalid", 422);
          }
        } catch {
          return learningFail("training_design_invalid", 422);
        }
        await this.store.assert(access);
        await this.assertInputs(plan, access);
        signal.throwIfAborted();
        if (kind === "studio" || kind === "canvas") {
          source = kind === "studio" ? studioSource : exampleSource.canvas;
          checks = await qualify(source, d, signal);
        } else {
          let previous: { source: string; check: string } | undefined;
          source = "";
          for (let i = 0; i < 2; i++) {
            try {
              await this.assertInputs(plan, access);
              calls++;
              source = await this.author.program(
                plan,
                pin!,
                kind,
                signal,
                previous,
              );
              await this.store.assert(access);
              signal.throwIfAborted();
              checks = await qualify(source, d, signal);
              break;
            } catch (err) {
              if (err instanceof Error && err.message === "training_career_target_changed") throw err;
              if (i === 1 || !(err instanceof TrainingProgramMismatch))
                return learningFail("training_program_rejected", 422);
              previous = source
                ? {
                    source,
                    check:
                      err instanceof TrainingProgramMismatch
                        ? err.message
                        : "The function did not execute under its host contract.",
                  }
                : undefined;
            }
            signal.throwIfAborted();
            await this.store.assert(access);
          }
        }
      }
      await this.store.assert(access);
      await this.assertInputs(plan, access);
      signal.throwIfAborted();
      const questions: [TrainingScreen, TrainingScreen] = [makeScreen(d, 0), makeScreen(d, 1)];
      const k: Kit = {
        id: randomUUID(),
        ownerId: this.store.ownerId,
        plan,
        modelDigest: pin,
        source,
        design: d,
        version: signature({ design: d, source, plan, modelDigest: pin, questions }),
        questions,
        calls,
        checks,
        revision: 0,
        attempts: [],
        explored: [false, false],
        practiceReferenceViewed: false,
        saved: false,
      };
      this.previews.set(k.id, {
        kit: k,
        session: access.session,
        expires: this.clock() + 2 * 60 * 60 * 1000,
      });
      return this.view(k);
    });
  }
  private view(k: Kit): TrainingView {
    const phase = stage(k, this.clock());
    const index = phase === "retest" || phase === "complete" ? 1 : 0;
    const screen = screenFor(k, index);
    const hideHistory = referenceHidden(k, phase);
    return TrainingView.parse({
      id: k.id,
      ownerId: k.ownerId,
      title: k.design.title,
      goal: k.plan.goal,
      career: k.plan.career,
      followFrom: hideHistory ? undefined : k.plan.followFrom,
      transferFrom: hideHistory ? undefined : k.plan.transferFrom,
      transferDecision: k.transferDecision,
      retestAids: k.design.kind !== "studio" ? undefined : k.attempts[1] ? k.attempts[1].aids : k.practiceReferenceViewed !== undefined
        ? { preview: k.explored[1], practiceReference: k.practiceReferenceViewed } : undefined,
      focus: hideHistory ? screen.brief : k.plan.advice.observation,
      kind: k.design.kind,
      version: k.version,
      origin: k.plan.origin,
      model: k.plan.model,
      modelDigest: k.modelDigest,
      modelCalls: k.calls,
      verifiedCases: k.checks,
      saved: k.saved,
      revision: k.revision,
      stage: phase,
      dueAt: k.attempts[0]
        ? new Date(Date.parse(k.attempts[0].at) + DAY).toISOString()
        : undefined,
      attempts: hideHistory ? [] : k.attempts,
      screen,
      questionVersion: questionVersion(k, index, screen),
    });
  }
  private async read(id: string, access: CareerTaskAccess): Promise<Kit> {
    await this.prepare(access);
    this.purge();
    const p = this.previews.get(id);
    if (p?.session === access.session) return structuredClone(p.kit);
    return this.store.run(access, (db) => {
      const row = db
        .prepare("SELECT body FROM training_kits WHERE id=? AND active=1")
        .get(id);
      if (!row) learningFail("training_kit_not_found", 404);
      const k = JSON.parse(String(row.body)) as Kit;
      if (
        k.ownerId !== this.store.ownerId ||
        k.id !== id ||
        k.version !== signature(k)
      )
        learningFail("training_version_invalid", 409);
      return k;
    });
  }
  async get(id: string, access: CareerTaskAccess) {
    return this.view(await this.read(id, access));
  }
  async list(access: CareerTaskAccess) {
    await this.prepare(access);
    return this.store.run(access, (db) =>
      db
        .prepare(
          "SELECT body FROM training_kits WHERE active=1 ORDER BY rowid DESC LIMIT 25",
        )
        .all()
        .map((row) => {
          const k = JSON.parse(String(row.body)) as Kit;
          if (k.ownerId !== this.store.ownerId || signature(k) !== k.version)
            learningFail("training_version_invalid", 409);
          return {
            id: k.id,
            ownerId: k.ownerId,
            title: k.design.title,
            version: k.version,
            origin: k.plan.origin,
            stage: stage(k, this.clock()),
            career: k.plan.career,
          };
        }),
    );
  }
  private async persistRevision(k: Kit, revision: number, access: CareerTaskAccess, signal: AbortSignal) {
    await this.store.run(access, db => {
      signal.throwIfAborted();
      const updated = db.prepare("UPDATE training_kits SET body=? WHERE id=? AND active=1 AND json_extract(body,'$.revision')=?")
        .run(JSON.stringify(k), k.id, revision);
      if (!updated.changes) learningFail("training_revision_conflict", 409);
    });
  }
  private async writingCommand(k: Kit, c: WritingCommand, access: CareerTaskAccess, signal: AbortSignal) {
    const index = c.round === "practice" ? 0 : 1;
    const attempt = k.attempts.find(a => a.round === c.round);
    const field = attempt?.question?.fields.find(f => f.key === c.key);
    const original = attempt && "parts" in attempt.answer ? attempt.answer.parts[c.key] : undefined;
    const model = k.plan.model, pin = k.modelDigest;
    if (!k.saved || k.design.kind !== "studio" || k.plan.origin !== "local" || !model || !pin ||
        field?.control !== "write" || !attempt?.question || !original?.trim() ||
        attempt.questionVersion !== c.questionVersion || questionVersion(k, index, attempt.question) !== c.questionVersion ||
        !attempt.feedback.evidence?.some(item => item.key === c.key && item.status === "recorded"))
      learningFail("training_writing_unavailable", 409);
    if (c.round === "practice" && referenceHidden(k, stage(k, this.clock())))
      learningFail("training_practice_reference_required", 409);
    const previous = attempt.writingReviews?.find(item => item.key === c.key);
    if (c.action === "save-rewrite") {
      if (!previous || previous.questionVersion !== c.questionVersion) learningFail("training_writing_review_required", 409);
      if (previous.rewrite) learningFail("training_rewrite_exists", 409);
      if (c.answer === original) learningFail("training_rewrite_unchanged", 422);
      previous.rewrite = { answer: c.answer, at: new Date(this.clock()).toISOString() };
      if (c.round === "practice") delete k.transferDecision;
    } else {
      if (previous) learningFail("training_writing_already_reviewed", 409);
      if (!this.author.reviewWriting) learningFail("training_writing_unavailable", 422);
      await this.assertCareer(k.plan.career, access);
      await this.once(c.requestId, access);
      let livePin: string;
      try {
        livePin = await this.author.pin(model, signal);
      } catch {
        signal.throwIfAborted();
        return learningFail("training_writing_review_failed", 422);
      }
      if (livePin !== pin) learningFail("training_writing_model_changed", 409);
      await this.assertCareer(k.plan.career, access);
      const current = await this.read(k.id, access);
      if (current.revision !== c.revision || current.version !== k.version) learningFail("training_revision_conflict", 409);
      signal.throwIfAborted();
      const screen = attempt.question;
      let raw: unknown;
      try {
        raw = await this.author.reviewWriting(model, pin, {
          goal: k.plan.goal, material: [screen.brief, ...screen.notes.slice(0, 1)], question: field.label, answer: original,
        }, signal);
      } catch {
        signal.throwIfAborted();
        return learningFail("training_writing_review_failed", 422);
      }
      signal.throwIfAborted();
      await this.store.assert(access);
      await this.assertCareer(k.plan.career, access);
      const feedback = TrainingWritingFeedback.safeParse(raw);
      if (!feedback.success) learningFail("training_writing_review_failed", 422);
      if (!original.includes(feedback.data.quote)) learningFail("training_writing_quote_invalid", 422);
      attempt.writingReviews = [...(attempt.writingReviews ?? []), {
        ...feedback.data, key: c.key, questionVersion: c.questionVersion,
        model, modelDigest: pin, createdAt: new Date(this.clock()).toISOString(),
      }];
    }
    k.revision++;
    await this.persistRevision(k, c.revision, access, signal);
    return { kit: this.view(k) };
  }
  private async recommendTransfer(k: Kit, command: Extract<TrainingCommand, { action: "recommend-transfer" }>, access: Access, signal: AbortSignal) {
    const input = this.transferInput(k);
    const model = k.plan.model, pin = k.modelDigest;
    if (!this.author.recommendTransfer || !model || !pin) learningFail("training_transfer_unavailable", 409);
    if (k.transferDecision) learningFail("training_transfer_already_recommended", 409);
    await this.assertCareer(k.plan.career, access);
    await this.once(command.requestId, access);
    let livePin;
    try { livePin = await this.author.pin(model, signal); }
    catch { signal.throwIfAborted(); return learningFail("training_transfer_failed", 422); }
    if (livePin !== pin) learningFail("training_transfer_model_changed", 409);
    await this.assertCareer(k.plan.career, access);
    if ((await this.read(k.id, access)).revision !== command.revision) learningFail("training_revision_conflict", 409);
    signal.throwIfAborted();
    let raw: unknown;
    try { raw = await this.author.recommendTransfer(model, pin, input, signal); }
    catch { signal.throwIfAborted(); return learningFail("training_transfer_failed", 422); }
    signal.throwIfAborted();
    await this.store.assert(access);
    await this.assertCareer(k.plan.career, access);
    const parsed = TrainingTransferAdvice.safeParse(raw);
    if (!parsed.success) learningFail("training_transfer_invalid", 422);
    const advice = parsed.data;
    const refs = new Set(advice.reasons.map(r => r.evidenceId));
    const cited = input.evidence.filter(e => refs.has(e.id));
    if (cited.length !== advice.reasons.length || new Set(cited.map(e => e.phase)).size !== new Set(input.evidence.map(e => e.phase)).size ||
        (input.retest.independence !== "independent" && advice.direction !== "verify") ||
        (advice.direction === "extend" && input.evidence.some(e => e.phase === "retest" && e.status === "missed")))
      learningFail("training_transfer_invalid", 422);
    k.transferDecision = { ...advice, model, modelDigest: pin, evidenceVersion: hash(input), createdAt: new Date(this.clock()).toISOString() };
    k.revision++;
    await this.persistRevision(k, command.revision, access, signal);
    return { kit: this.view(k) };
  }
  async command(
    id: string,
    raw: unknown,
    access: Access,
  ): Promise<{ kit?: TrainingView; feedback?: TrainingFeedback }> {
    const c = TrainingCommand.parse(raw);
    // A slow model review does not prevent the owner discarding the kit or
    // submitting a retest. A changed revision invalidates the in-flight review.
    return this.guarded(c.action === "recommend-transfer" ? "transfer:" + id : c.action === "review-writing" ? "writing:" + id : id, access, async (signal) => {
      const k = await this.read(id, access);
      if (k.revision !== c.revision)
        learningFail("training_revision_conflict", 409);
      if (c.action === "recommend-transfer") return this.recommendTransfer(k, c, access, signal);
      if (c.action === "view-practice") {
        if (!k.saved || k.design.kind !== "studio" || stage(k, this.clock()) !== "retest") learningFail("training_round_changed", 409);
        if (!k.practiceReferenceViewed) {
          k.practiceReferenceViewed = true;
          k.revision++;
          await this.persistRevision(k, c.revision, access, signal);
        }
        return { kit: this.view(k) };
      }
      if (c.action === "review-writing" || c.action === "save-rewrite")
        return this.writingCommand(k, c, access, signal);
      if (k.design.kind !== "studio" && "answer" in c && "parts" in c.answer && !("codeKey" in c.answer)) {
        // Older kits checked and recorded trimmed selections. Studio keeps the
        // learner's exact writing, including line breaks, for the next exercise.
        c.answer.parts = Object.fromEntries(Object.entries(c.answer.parts).map(([key, value]) => [key, value.trim()]));
      }
      if (c.action === "discard") {
        if (k.saved)
          await this.store.run(access, db => {
            if (!db.prepare("DELETE FROM training_kits WHERE id=? AND json_extract(body,'$.revision')=?").run(id, c.revision).changes)
              learningFail("training_revision_conflict", 409);
          });
        this.previews.delete(id);
        return {};
      }
      let feedback: TrainingFeedback | undefined;
      if (c.action === "keep") {
        if (k.saved) learningFail("training_already_saved", 409);
        if (k.plan.transferFrom) await this.assertInputs(k.plan, access);
        k.saved = true;
        k.revision++;
        await this.store.run(access, (db) => {
          if (
            Number(
              db
                .prepare(
                  "SELECT count(*) AS n FROM training_kits WHERE active=1",
                )
                .get()?.n,
            ) >= 24
          )
            learningFail("training_shelf_limit", 429);
          db.prepare(
            "INSERT INTO training_kits(id,body,active) VALUES(?,?,1)",
          ).run(id, JSON.stringify(k));
        });
        this.previews.delete(id);
      } else if ("answer" in c) {
        const phase = stage(k, this.clock()),
          index = phase === "retest" || phase === "complete" ? 1 : 0;
        if (c.round !== (index ? "retest" : "practice"))
          learningFail("training_round_changed", 409);
        if (
          c.action === "submit" &&
          (phase === "waiting" || phase === "complete")
        )
          learningFail("training_round_closed", 409);
        feedback = await runAnswer(k.design, index, k.source, c.answer, signal);
        await this.store.assert(access);
        signal.throwIfAborted();
        if (c.action === "explore") k.explored[index] = true;
        else {
          const question = screenFor(k, index);
          k.attempts.push({
            round: index ? "retest" : "practice",
            at: new Date(this.clock()).toISOString(),
            answer: c.answer,
            feedback,
            usedPreview: k.explored[index] || (index === 1 && !!k.practiceReferenceViewed),
            ...(index === 1 && k.design.kind === "studio" && k.practiceReferenceViewed !== undefined
              ? { aids: { preview: k.explored[1], practiceReference: k.practiceReferenceViewed } } : {}),
            question,
            questionVersion: questionVersion(k, index, question),
          });
        }
        k.revision++;
        if (k.saved)
          await this.persistRevision(k, c.revision, access, signal);
        else {
          const preview = this.previews.get(id);
          if (!preview || preview.session !== access.session)
            learningFail("training_kit_not_found", 404);
          preview.kit = k;
        }
      }
      return { kit: this.view(k), feedback };
    });
  }
  invalidate(session: string) {
    for (const [id, p] of this.plans)
      if (p.session === session) this.plans.delete(id);
    for (const [id, p] of this.previews)
      if (p.session === session) this.previews.delete(id);
    for (const a of this.active.values())
      if (a.session === session) a.stop.abort();
  }
  close() {
    for (const a of this.active.values()) a.stop.abort();
    this.plans.clear();
    this.previews.clear();
  }
}
