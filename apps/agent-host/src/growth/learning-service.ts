import type { CareerTaskAccess, AgentTaskKernel } from "../kernel/service.js";
import {
  LearningId,
  LearningCreateSchema,
  LearningCommandSchema,
  LearningPathSchema,
  GROWTH_PRACTICE_BUDGET,
  GROWTH_PRACTICE_RUNTIME,
  type LearningPath,
} from "@better-me/agent-contracts";
import type { DatabaseSync } from "node:sqlite";
import { LearningStore, learningFail } from "./learning-store.js";
import {
  documentRecord,
  importLearningMaterial,
  learningFingerprint,
  materialBytes,
  materialView,
  selectedPassage,
} from "./learning-materials.js";
import {
  LEARNING_WEEK_MS,
  learningQuestions,
  pathPresentation,
} from "./learning-path-state.js";
import { LearningTranslations, type LearningTranslationEngine } from "./learning-translations.js";

export class LearningPaths {
  private readonly store: LearningStore;
  readonly translations: LearningTranslations;
  private time() {
    return this.options.clock?.() ?? Date.now();
  }
  private date() {
    return new Date(this.time()).toISOString();
  }
  constructor(
    private readonly options: {
      ownerId: string;
      directory: string;
      kernel: AgentTaskKernel;
      clock?: () => number;
      translationEngine?: LearningTranslationEngine;
    },
  ) {
    this.store = new LearningStore(options.ownerId, options.directory);
    this.translations = new LearningTranslations(this.store, options.translationEngine);
  }
  importMaterial(input: unknown, access: CareerTaskAccess) {
    return this.store.run(access, (database) =>
      importLearningMaterial(database, this.options.ownerId, input),
    );
  }
  materials(access: CareerTaskAccess) {
    return this.store.run(access, (database) =>
      database
        .prepare("SELECT id FROM documents ORDER BY rowid DESC")
        .all()
        .map((row) => materialView(documentRecord(database, String(row.id)))),
    );
  }
  material(id: string, access: CareerTaskAccess) {
    return this.store.run(access, (database) =>
      materialView(documentRecord(database, id)),
    );
  }
  bytes(id: string, access: CareerTaskAccess) {
    return this.store.run(access, (database) => materialBytes(database, id));
  }
  passage(id: string, page: number, blockId: string, access: CareerTaskAccess) {
    return this.store.run(access, (database) => {
      const material = documentRecord(database, id),
        block = material.pages
          .find((item) => item.number === page)
          ?.blocks.find((item) => item.id === blockId);
      if (!block) learningFail("learning_passage_not_found", 404);
      const citation = {
        materialId: id,
        materialHash: material.hash,
        materialRevision: material.revision,
        page,
        blockId,
        textHash: block.hash,
      };
      selectedPassage(database, citation);
      return { ownerId: this.options.ownerId, citation, block };
    });
  }
  private load(database: DatabaseSync, id: string) {
    const row = database.prepare("SELECT body FROM paths WHERE id=?").get(id);
    if (!row) learningFail("learning_path_not_found", 404);
    const record = LearningPathSchema.parse(JSON.parse(String(row.body)));
    if (record.ownerId !== this.options.ownerId || record.id !== id)
      learningFail("learning_owner_mismatch", 403);
    return record;
  }
  private save(database: DatabaseSync, record: LearningPath) {
    const stored = {
      ...record,
      attempts: record.attempts.map(({ task: _task, ...attempt }) => attempt),
    };
    database
      .prepare(
        "INSERT INTO paths VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(record.id, JSON.stringify(LearningPathSchema.parse(stored)));
  }
  private async view(
    database: DatabaseSync,
    value: LearningPath,
    access: CareerTaskAccess,
  ) {
    const record = structuredClone(value);
    record.sourceRevoked =
      !!record.citation &&
      documentRecord(database, record.citation.materialId).revoked;
    record.usage = { lookupCalls: 0, toolCalls: 0, modelCalls: 0 };
    {
      const passage =
        record.citation && !record.sourceRevoked
          ? selectedPassage(database, record.citation)
          : undefined;
      for (const attempt of record.attempts)
        if (attempt.taskId) {
          let task;
          try {
            task = await this.options.kernel.readTask(attempt.taskId);
          } catch (error) {
            if (
              record.pendingCommand?.kind === "submit_answer" &&
              record.pendingCommand.attemptId === attempt.id &&
              (error as { code?: string }).code === "task_not_found"
            )
              continue;
            throw error;
          }
          if (
            task.kind !== "growth_practice" ||
            task.ownerId !== record.ownerId ||
            task.workspaceKey !== record.id ||
            task.rootScopeKey !== `learning:${record.id}` ||
            !record.citation ||
            task.request.sourceHash !== record.citation.textHash ||
            (passage && task.request.sourceText !== passage.block.text) ||
            task.request.sourceId !==
              `ls_${learningFingerprint(record.citation)}` ||
            (task.request.scenario === "lost_receipt") !==
              (attempt.questionId !== "receipt-present-v1") ||
            (task.request.scenarioCase === "new_operation") !==
              (attempt.questionId === "receipt-transfer-v1") ||
            task.request.answer !== attempt.answer ||
            task.request.explanation !== attempt.explanation
          )
            learningFail("learning_attempt_binding_changed", 503);
          if (!record.sourceRevoked) attempt.task = task;
          record.usage.lookupCalls +=
            task.practice.checkpoint?.lookupCalls ?? 0;
          record.usage.toolCalls += task.usage.toolCalls;
        }
    }
    if (record.project) {
      const attempt = record.attempts.find(
        (item) => item.id === record.project!.attemptId,
      );
      const review = record.reviews.find(
        (item) => item.id === record.plans.at(-1)?.reviewId,
      );
      if (
        !attempt ||
        !review ||
        review.status !== "accepted" ||
        review.nextStep !== "project" ||
        !attempt.independent ||
        !attempt.decisionPassed ||
        (!record.sourceRevoked &&
          (attempt.task?.practice.phase !== "verified" ||
            attempt.task.practice.verificationHash !==
              record.project.reportHash))
      )
        learningFail("learning_project_binding_changed", 503);
    }
    await this.store.assert(access);
    Object.assign(record, pathPresentation(record, this.time()));
    return LearningPathSchema.parse(record);
  }
  create(raw: unknown, access: CareerTaskAccess) {
    const input = LearningCreateSchema.parse(raw);
    return this.store.run(access, async (database) => {
      const key = `create:${input.requestId}`,
        fingerprint = learningFingerprint(input),
        id = `lp_${learningFingerprint([this.options.ownerId, input.requestId]).slice(0, 32)}`;
      const previous = database
        .prepare("SELECT fingerprint FROM operations WHERE id=?")
        .get(key);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          learningFail("learning_idempotency_conflict");
        return this.view(database, this.load(database, id), access);
      }
      if (
        Number(database.prepare("SELECT count(*) AS n FROM paths").get()!.n) >=
        64
      )
        learningFail("learning_path_capacity", 413);
      const record = LearningPathSchema.parse({
        id,
        ownerId: this.options.ownerId,
        revision: 1,
        title: input.title,
        createdAt: this.date(),
        updatedAt: this.date(),
        skill: "recoverable-agent",
        sourceRevoked: false,
        stage: "choose_source",
        next: { title: "选择资料", reason: "不自动扫描本机资料。", minutes: 5 },
        attempts: [],
        plans: [
          {
            revision: 1,
            weeklyHours: input.weeklyHours,
            nextStep: "practice",
            adoptedAt: this.date(),
          },
        ],
        reviews: [],
        usage: { lookupCalls: 0, modelCalls: 0, toolCalls: 0 },
      });
      database.exec("BEGIN IMMEDIATE");
      try {
        this.save(database, record);
        database
          .prepare("INSERT INTO operations VALUES(?,?,?)")
          .run(key, fingerprint, id);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return this.view(database, record, access);
    });
  }
  get(id: string, access: CareerTaskAccess) {
    return this.store.run(access, (database) =>
      this.view(database, this.load(database, id), access),
    );
  }
  list(access: CareerTaskAccess) {
    return this.store.run(access, async (database) => {
      const records: LearningPath[] = [];
      for (const row of database
        .prepare("SELECT id FROM paths ORDER BY rowid DESC")
        .all())
        records.push(
          await this.view(
            database,
            this.load(database, String(row.id)),
            access,
          ),
        );
      return records;
    });
  }
  command(id: string, raw: unknown, access: CareerTaskAccess) {
    const input = LearningCommandSchema.parse(raw);
    return this.store.run(access, async (database) => {
      const key = `command:${id}:${input.requestId}`,
        fingerprint = learningFingerprint(input);
      const previous = database
        .prepare("SELECT fingerprint,result FROM operations WHERE id=?")
        .get(key);
      const record = this.load(database, id);
      if (previous && previous.fingerprint !== fingerprint)
        learningFail("learning_idempotency_conflict");
      if (previous?.result === "done")
        return this.view(database, record, access);
      if (!previous && record.pendingCommand)
        learningFail("learning_pending_command");
      if (!previous && record.revision !== input.expectedRevision)
        learningFail("learning_revision_conflict");
      if (
        Number(
          database.prepare("SELECT count(*) AS n FROM operations").get()!.n,
        ) >= 2048
      )
        learningFail("learning_command_capacity", 413);
      const current = await this.view(database, record, access);
      if (current.sourceRevoked) learningFail("learning_material_revoked", 403);
      const attemptFor = (attemptId: string) => {
        const attempt = record.attempts.at(-1);
        if (!attempt || attempt.id !== attemptId)
          learningFail("learning_attempt_not_current");
        return attempt;
      };
      const prepareDispatch = () => {
        if (previous) return;
        record.pendingCommand = input;
        record.revision++;
        record.updatedAt = this.date();
        database.exec("BEGIN IMMEDIATE");
        try {
          this.save(database, record);
          database
            .prepare("INSERT INTO operations VALUES(?,?,?)")
            .run(key, fingerprint, "pending");
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      };
      if (input.kind === "select_passage") {
        if (record.attempts.length || record.project)
          learningFail("learning_source_frozen");
        selectedPassage(database, input.citation);
        record.citation = input.citation;
      } else if (input.kind === "start_attempt") {
        if (!record.citation) learningFail("learning_source_required", 422);
        if (record.project || record.attempts.length >= 8)
          learningFail("learning_attempt_capacity", 413);
        const last = current.attempts.at(-1);
        if (
          last &&
          (!last.task ||
            !["verified", "failed"].includes(last.task.practice.phase))
        )
          learningFail("learning_finish_current_attempt");
        if (last?.task?.status === "budget_exhausted")
          learningFail("learning_budget_exhausted");
        if (
          !record.attempts.length &&
          input.questionId !== "receipt-present-v1"
        )
          learningFail("learning_first_question_required");
        const question = record.attempts.some(
          (item) => item.questionId === "receipt-missing-v1",
        )
          ? "receipt-transfer-v1"
          : "receipt-missing-v1";
        if (
          record.attempts.length &&
          (input.questionId !== question ||
            !record.dueAt ||
            this.time() < Date.parse(record.dueAt))
        )
          learningFail("learning_retest_not_due");
        const supplementReview = record.reviews.at(-1);
        if (
          record.attempts.length >= 2 &&
          (record.plans.at(-1)?.nextStep !== "supplement" ||
            record.plans.at(-1)?.reviewId !== supplementReview?.id ||
            supplementReview?.status !== "accepted" ||
            supplementReview.evidenceAttemptIds.at(-1) !== last?.id)
        )
          learningFail("learning_review_required");
        record.attempts.push({
          id: `la_${learningFingerprint([id, input.requestId]).slice(0, 32)}`,
          questionId: input.questionId,
          prompt: learningQuestions[input.questionId].prompt,
          createdAt: this.date(),
          hints: [],
        });
      } else if (input.kind === "reveal_hint") {
        const attempt = attemptFor(input.attemptId);
        if (attempt.submittedAt || attempt.hints.length)
          learningFail("learning_hint_already_recorded");
        attempt.hints.push({
          at: this.date(),
          draftAnswer: input.draftAnswer,
          content: learningQuestions[attempt.questionId].hint,
        });
      } else if (input.kind === "submit_answer") {
        const attempt = attemptFor(input.attemptId);
        if (attempt.submittedAt && !previous)
          learningFail("learning_answer_frozen");
        if (!record.citation) learningFail("learning_source_required", 422);
        const passage = selectedPassage(database, record.citation);
        const taskKey = `learning-${learningFingerprint([id, attempt.id])}`;
        Object.assign(attempt, {
          answer: input.answer,
          explanation: input.explanation,
          decision: input.decision,
          attribution: input.attribution,
          independent:
            attempt.hints.length === 0 &&
            input.attribution === "self_reported" &&
            !record.attempts
              .slice(0, -1)
              .some((item) => item.questionId === attempt.questionId),
          decisionPassed:
            input.decision ===
            (attempt.questionId === "receipt-present-v1"
              ? "reuse_receipt"
              : "reconcile_unknown"),
          submittedAt: attempt.submittedAt ?? this.date(),
          taskId: `ct_${learningFingerprint([this.options.ownerId, taskKey]).slice(0, 32)}`,
        });
        prepareDispatch();
        const task = await this.options.kernel.createTask(
          {
            kind: "growth_practice",
            workspaceKey: id,
            rootScopeKey: `learning:${id}`,
            objective: attempt.prompt,
            runtimeBinding: GROWTH_PRACTICE_RUNTIME,
            budget: GROWTH_PRACTICE_BUDGET,
            consent: true,
            idempotencyKey: taskKey,
            request: {
              sourceId: `ls_${learningFingerprint(record.citation)}`,
              sourceHash: passage.block.hash,
              sourceText: passage.block.text,
              sourceCode: input.sourceCode,
              answer: input.answer,
              explanation: input.explanation,
              ...(attempt.questionId !== "receipt-present-v1"
                ? { scenario: "lost_receipt" as const }
                : {}),
              ...(attempt.questionId === "receipt-transfer-v1"
                ? { scenarioCase: "new_operation" as const }
                : {}),
            },
          },
          this.passageAccess(database, record, access),
        );
        if (task.id !== attempt.taskId)
          learningFail("learning_attempt_binding_changed", 503);
      } else if (input.kind === "step_attempt") {
        const attempt = attemptFor(input.attemptId),
          actual = current.attempts.at(-1)?.task;
        if (!actual || !attempt.taskId)
          learningFail("learning_answer_required", 422);
        if (!previous && actual.revision !== input.expectedTaskRevision)
          learningFail("learning_task_revision_conflict");
        if (
          !previous &&
          !["ready", "lookup_saved"].includes(actual.practice.phase)
        )
          learningFail("learning_task_not_runnable");
        prepareDispatch();
        const result =
          actual.revision === input.expectedTaskRevision
            ? await this.options.kernel.stepGrowthPractice(
                attempt.taskId,
                {
                  expectedRevision: actual.revision,
                  sourceFingerprint: actual.sourceFingerprint,
                  consent: true,
                },
                this.passageAccess(database, record, access),
              )
            : actual;
        if (result.kind !== "growth_practice")
          learningFail("learning_attempt_binding_changed", 503);
        if (
          ["verified", "failed"].includes(result.practice.phase) &&
          !record.dueAt
        )
          record.dueAt = new Date(this.time() + LEARNING_WEEK_MS).toISOString();
      } else if (input.kind === "propose_review") {
        if (
          current.attempts.length < 2 ||
          current.attempts.some(
            (item) =>
              !item.task ||
              !["verified", "failed"].includes(item.task.practice.phase),
          )
        )
          learningFail("learning_two_finished_attempts_required", 422);
        if (
          record.reviews.length >= 10 ||
          record.reviews.at(-1)?.status === "proposed"
        )
          learningFail("learning_review_already_pending");
        const first = current.attempts[0]!,
          last = current.attempts.at(-1)!;
        const ready =
          last.decisionPassed &&
          last.independent &&
          last.task?.practice.phase === "verified";
        const hours = record.plans.at(-1)!.weeklyHours;
        record.reviews.push({
          id: `lr_${learningFingerprint([id, input.requestId]).slice(0, 32)}`,
          createdAt: this.date(),
          evidenceAttemptIds: current.attempts.map((attempt) => attempt.id),
          previousHours: hours,
          proposedHours: ready ? hours : Math.max(1, hours - 1),
          nextStep: ready ? "project" : "supplement",
          reason: `${first.id}：首次情境${first.decisionPassed ? "决策正确" : "决策未通过"}，${first.independent ? "自述无提示" : "使用过辅助"}；${last.id}：换题${last.decisionPassed ? "决策正确" : "决策未通过"}，代码${last.task?.practice.phase === "verified" ? "通过指定检查" : "未通过指定检查"}。${ready ? "建议进入可复核项目。" : "建议先补练回执丢失情境并降低本周负担。"}原解释未自动语义评分，需本人复盘。`,
          status: "proposed",
        });
      } else if (input.kind === "decide_review") {
        const review = record.reviews.find(
          (item) => item.id === input.reviewId,
        );
        if (!review || review.status !== "proposed")
          learningFail("learning_review_not_pending");
        if (
          review.evidenceAttemptIds.join(",") !==
          record.attempts.map((item) => item.id).join(",")
        )
          learningFail("learning_review_evidence_changed");
        review.status = input.decision === "accept" ? "accepted" : "rejected";
        review.decidedAt = this.date();
        if (input.decision === "accept")
          record.plans.push({
            revision: record.plans.length + 1,
            weeklyHours: review.proposedHours,
            nextStep: review.nextStep,
            adoptedAt: this.date(),
            reviewId: review.id,
          });
      } else if (input.kind === "accept_project") {
        const attempt = attemptFor(input.attemptId),
          actual = current.attempts.at(-1)?.task;
        if (
          record.project ||
          current.stage !== "project" ||
          !actual ||
          actual.practice.phase !== "verified" ||
          actual.practice.verificationHash !== input.reportHash
        )
          learningFail("learning_project_not_ready", 422);
        record.project = {
          acceptedAt: this.date(),
          attemptId: attempt.id,
          reportHash: input.reportHash,
          runInstructions: input.runInstructions,
          sample: input.sample,
          limitations: input.limitations,
          personalWork: input.personalWork,
          toolWork: input.toolWork,
          scope: "learning_project",
          mastery: "observed_not_certified",
        };
      }
      delete record.pendingCommand;
      record.revision++;
      record.updatedAt = this.date();
      database.exec("BEGIN IMMEDIATE");
      try {
        this.save(database, record);
        database
          .prepare(
            "INSERT INTO operations VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET result=excluded.result",
          )
          .run(key, fingerprint, "done");
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return this.view(database, record, access);
    });
  }
  private passageAccess(
    database: DatabaseSync,
    record: LearningPath,
    access: CareerTaskAccess,
  ): CareerTaskAccess {
    return {
      session: access.session,
      valid: async () => {
        if (!(await access.valid())) return false;
        try {
          if (!record.citation) return false;
          selectedPassage(database, record.citation);
          return true;
        } catch {
          return false;
        }
      },
    };
  }
  async revoke(id: string, requestId: string, access: CareerTaskAccess) {
    LearningId.parse(requestId);
    const material = await this.store.run(access, (database) => {
      const material = documentRecord(database, id),
        key = `revoke:${requestId}`,
        fingerprint = learningFingerprint({ id });
      const previous = database
        .prepare("SELECT fingerprint FROM operations WHERE id=?")
        .get(key);
      if (previous && previous.fingerprint !== fingerprint)
        learningFail("learning_idempotency_conflict");
      if (!material.revoked) {
        material.revoked = true;
        material.revision++;
        database.exec("BEGIN IMMEDIATE");
        try {
          database
            .prepare("UPDATE documents SET body=? WHERE id=?")
            .run(JSON.stringify(material), id);
          database
            .prepare("INSERT INTO operations VALUES(?,?,?)")
            .run(key, fingerprint, id);
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      }
      return materialView(material);
    });
    this.translations.stopMaterial(id);
    return material;
  }
  invalidateSession(session: string) {
    this.translations.invalidate(session);
    this.store.invalidate(session);
  }
  async close() {
    await this.translations.close();
    await this.store.close();
  }
}
