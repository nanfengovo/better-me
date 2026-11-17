import { randomUUID, createHash } from "node:crypto";
import {
  TrainingAdvice,
  TrainingBuild,
  TrainingCommand,
  TrainingStart,
  TrainingView,
  type TrainingPlan,
  type TrainingDesign,
  type TrainingAttempt,
  type TrainingFeedback,
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
  saved: boolean;
};
type Preview = { kit: Kit; session: string; expires: number };
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const signature = (
  k: Pick<Kit, "design" | "source" | "plan" | "modelDigest">,
) =>
  hash([
    "training-kit-v1",
    k.plan.origin,
    k.plan.model ?? null,
    k.modelDigest ?? null,
    k.design,
    k.source,
  ]);
const stage = (k: Kit, now: number): TrainingView["stage"] =>
  !k.attempts[0]
    ? "practice"
    : k.attempts.length > 1
      ? "complete"
      : now >= Date.parse(k.attempts[0].at) + DAY
        ? "retest"
        : "waiting";

/** One owner. Anonymous/other owners never get this store. Drafts never survive session
 * revocation or restart. Only explicit keep writes content; a request tombstone prevents
 * automatic inference replay even when the host dies before delivering its response. */
export class TrainingKits {
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
  ) {}
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
    await this.store.assert(access);
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
      await this.once(input.requestId, access);
      let advice: TrainingAdvice, pin: string | undefined;
      if (input.engine.type === "local") {
        const model = input.engine.model;
        try {
          pin = await this.author.pin(model, signal);
          await this.store.assert(access);
          advice = TrainingAdvice.parse(
            await this.author.diagnose(
              model,
              pin,
              input.goal,
              input.evidence,
              signal,
            ),
          );
        } catch {
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
                : "示例假设：能估算单项耗时，但容易忽略并行和依赖。",
          nextStep:
            k === "canvas"
              ? "在两个情境中写下开场，再比较有没有交代下一步。"
              : k === "rewrite"
                ? "试着保留请求和日期，用一句话完成邮件。"
                : "先预测一个并行任务晚两天会不会影响交付。",
        };
      }
      await this.store.assert(access);
      signal.throwIfAborted();
      const plan: TrainingPlan = {
        id: randomUUID(),
        goal: input.goal,
        evidence: input.evidence,
        advice,
        origin: input.engine.type,
        ...(input.engine.type === "local" ? { model: input.engine.model } : {}),
        modelCalls: input.engine.type === "local" ? 1 : 0,
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
      const { plan, pin } = draft,
        kind = plan.advice.route;
      if (kind !== "rewrite" && kind !== "dependency" && kind !== "canvas")
        learningFail("training_no_app_needed", 422);
      if (draft.used) learningFail("training_plan_already_used", 409);
      if (this.previews.size >= 12) learningFail("training_preview_limit", 429);
      await this.once(input.requestId, access);
      draft.used = true;
      let d: TrainingDesign,
        source: string,
        checks = 0,
        calls = plan.modelCalls;
      if (plan.origin === "example") {
        d = validateDesign(examples[kind], kind);
        source = exampleSource[kind];
        checks = await qualify(source, d, signal);
      } else {
        try {
          calls++;
          d = validateDesign(
            await this.author.design(plan, pin!, kind, signal),
            kind,
          );
        } catch {
          return learningFail("training_design_invalid", 422);
        }
        await this.store.assert(access);
        signal.throwIfAborted();
        if (kind === "canvas") {
          source = exampleSource.canvas;
          checks = await qualify(source, d, signal);
        } else {
          let previous: { source: string; check: string } | undefined;
          source = "";
          for (let i = 0; i < 2; i++) {
            try {
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
      signal.throwIfAborted();
      const k: Kit = {
        id: randomUUID(),
        ownerId: this.store.ownerId,
        plan,
        modelDigest: pin,
        source,
        design: d,
        version: signature({ design: d, source, plan, modelDigest: pin }),
        calls,
        checks,
        revision: 0,
        attempts: [],
        explored: [false, false],
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
    return TrainingView.parse({
      id: k.id,
      ownerId: k.ownerId,
      title: k.design.title,
      goal: k.plan.goal,
      focus: k.plan.advice.observation,
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
      attempts: k.attempts,
      screen: makeScreen(
        k.design,
        phase === "retest" || phase === "complete" ? 1 : 0,
      ),
    });
  }
  private async read(id: string, access: CareerTaskAccess): Promise<Kit> {
    await this.store.assert(access);
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
          };
        }),
    );
  }
  async command(
    id: string,
    raw: unknown,
    access: CareerTaskAccess,
  ): Promise<{ kit?: TrainingView; feedback?: TrainingFeedback }> {
    const c = TrainingCommand.parse(raw);
    return this.guarded(id, access, async (signal) => {
      const k = await this.read(id, access);
      if (k.revision !== c.revision)
        learningFail("training_revision_conflict", 409);
      if (c.action === "discard") {
        if (k.saved)
          await this.store.run(access, (db) =>
            db.prepare("DELETE FROM training_kits WHERE id=?").run(id),
          );
        this.previews.delete(id);
        return {};
      }
      let feedback: TrainingFeedback | undefined;
      if (c.action === "keep") {
        if (k.saved) learningFail("training_already_saved", 409);
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
        else
          k.attempts.push({
            round: index ? "retest" : "practice",
            at: new Date(this.clock()).toISOString(),
            answer: c.answer,
            feedback,
            usedPreview: k.explored[index],
          });
        k.revision++;
        if (k.saved)
          await this.store.run(access, (db) =>
            db
              .prepare(
                "UPDATE training_kits SET body=? WHERE id=? AND active=1",
              )
              .run(JSON.stringify(k), id),
          );
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
