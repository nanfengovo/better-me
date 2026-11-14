import { z } from "zod";
import { GrowthPracticeTaskSchema } from "./growth-practice.js";

export const LearningId = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/);
export const LearningHash = z.string().regex(/^[a-f0-9]{64}$/);
const prose = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((text) => text.trim().length > 0);
export const LearningBlockSchema = z
  .object({
    id: LearningId,
    text: prose(16000),
    hash: LearningHash,
    box: z
      .tuple([
        z.number().finite(),
        z.number().finite(),
        z.number().finite().nonnegative(),
        z.number().finite().nonnegative(),
      ])
      .optional(),
  })
  .strict();
export const LearningPageSchema = z
  .object({
    number: z.number().int().min(1).max(60),
    width: z.number().positive(),
    height: z.number().positive(),
    coordinateSystem: z.enum(["pdf_points_bottom_left", "text_lines_top_left"]),
    status: z.enum(["text", "needs_recognition", "needs_review"]),
    blocks: z.array(LearningBlockSchema).max(300),
    issue: z.string().max(200).optional(),
  })
  .strict();
export const LearningMaterialSchema = z
  .object({
    id: LearningId,
    ownerId: LearningId,
    name: prose(180),
    mediaType: z.enum(["application/pdf", "text/plain"]),
    hash: LearningHash,
    bytes: z
      .number()
      .int()
      .positive()
      .max(8 * 1024 * 1024),
    importedAt: z.string().datetime(),
    parser: z.string().max(120),
    pages: z.array(LearningPageSchema).max(60),
    revoked: z.boolean(),
    revision: z.number().int().positive(),
    modelConsent: z.literal(false),
  })
  .strict();
export type LearningMaterial = z.infer<typeof LearningMaterialSchema>;
export type LearningPage = z.infer<typeof LearningPageSchema>;
export const LearningImportSchema = z
  .object({
    requestId: LearningId,
    consent: z.literal(true),
    name: prose(180),
    mediaType: z.enum(["application/pdf", "text/plain"]),
    base64: z.string().min(4).max(11_184_812),
  })
  .strict();
export const LearningCitationSchema = z
  .object({
    materialId: LearningId,
    materialHash: LearningHash,
    materialRevision: z.number().int().positive(),
    page: z.number().int().min(1).max(60),
    blockId: LearningId,
    textHash: LearningHash,
  })
  .strict();
export type LearningCitation = z.infer<typeof LearningCitationSchema>;
export const LearningCreateSchema = z
  .object({
    requestId: LearningId,
    consent: z.literal(true),
    title: prose(1000),
    weeklyHours: z.number().int().min(1).max(40),
  })
  .strict();
const command = {
  requestId: LearningId,
  expectedRevision: z.number().int().positive(),
  consent: z.literal(true),
};
export const LearningQuestionIdSchema = z.enum([
  "receipt-present-v1",
  "receipt-missing-v1",
  "receipt-transfer-v1",
]);
export const LearningCommandSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...command,
      kind: z.literal("select_passage"),
      citation: LearningCitationSchema,
    })
    .strict(),
  z
    .object({
      ...command,
      kind: z.literal("start_attempt"),
      questionId: LearningQuestionIdSchema,
    })
    .strict(),
  z
    .object({
      ...command,
      kind: z.literal("reveal_hint"),
      attemptId: LearningId,
      draftAnswer: z.string().max(12000),
    })
    .strict(),
  z
    .object({
      ...command,
      kind: z.literal("submit_answer"),
      attemptId: LearningId,
      answer: prose(12000),
      explanation: prose(12000),
      sourceCode: prose(16000),
      decision: z.enum(["reuse_receipt", "reconcile_unknown", "retry_now"]),
      attribution: z.enum(["self_reported", "guided_example"]),
    })
    .strict(),
  z
    .object({
      ...command,
      kind: z.literal("step_attempt"),
      attemptId: LearningId,
      expectedTaskRevision: z.number().int().positive(),
    })
    .strict(),
  z.object({ ...command, kind: z.literal("propose_review") }).strict(),
  z
    .object({
      ...command,
      kind: z.literal("decide_review"),
      reviewId: LearningId,
      decision: z.enum(["accept", "reject"]),
    })
    .strict(),
  z
    .object({
      ...command,
      kind: z.literal("accept_project"),
      attemptId: LearningId,
      reportHash: LearningHash,
      runInstructions: prose(4000),
      sample: prose(4000),
      limitations: prose(4000),
      personalWork: prose(4000),
      toolWork: prose(4000),
    })
    .strict(),
]);
export type LearningCommand = z.infer<typeof LearningCommandSchema>;
export const LearningAttemptSchema = z
  .object({
    id: LearningId,
    questionId: LearningQuestionIdSchema,
    prompt: prose(4000),
    createdAt: z.string().datetime(),
    hints: z
      .array(
        z
          .object({
            at: z.string().datetime(),
            draftAnswer: z.string().max(12000),
            content: prose(4000),
          })
          .strict(),
      )
      .max(1),
    answer: z.string().max(12000).optional(),
    explanation: z.string().max(12000).optional(),
    decision: z
      .enum(["reuse_receipt", "reconcile_unknown", "retry_now"])
      .optional(),
    attribution: z.enum(["self_reported", "guided_example"]).optional(),
    submittedAt: z.string().datetime().optional(),
    decisionPassed: z.boolean().optional(),
    independent: z.boolean().optional(),
    taskId: LearningId.optional(),
    task: GrowthPracticeTaskSchema.optional(),
  })
  .strict();
export type LearningAttempt = z.infer<typeof LearningAttemptSchema>;
export const LearningReviewSchema = z
  .object({
    id: LearningId,
    createdAt: z.string().datetime(),
    evidenceAttemptIds: z.array(LearningId).min(2).max(8),
    reason: prose(4000),
    nextStep: z.enum(["supplement", "project"]),
    previousHours: z.number().int().min(1).max(40),
    proposedHours: z.number().int().min(1).max(40),
    status: z.enum(["proposed", "accepted", "rejected"]),
    decidedAt: z.string().datetime().optional(),
  })
  .strict();
export const LearningPathSchema = z
  .object({
    id: LearningId,
    ownerId: LearningId,
    revision: z.number().int().positive(),
    title: prose(1000),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    skill: z.literal("recoverable-agent"),
    citation: LearningCitationSchema.optional(),
    sourceRevoked: z.boolean(),
    stage: z.enum([
      "choose_source",
      "practice",
      "checkpoint_saved",
      "pending_retest",
      "retest_due",
      "review",
      "project",
      "completed",
      "outcome_unknown",
      "source_revoked",
    ]),
    next: z
      .object({
        title: prose(300),
        reason: prose(1000),
        minutes: z.number().int().min(0).max(60),
      })
      .strict(),
    dueAt: z.string().datetime().optional(),
    attempts: z.array(LearningAttemptSchema).max(8),
    plans: z
      .array(
        z
          .object({
            revision: z.number().int().positive(),
            weeklyHours: z.number().int().min(1).max(40),
            nextStep: z.enum(["practice", "supplement", "project"]),
            adoptedAt: z.string().datetime(),
            reviewId: LearningId.optional(),
          })
          .strict(),
      )
      .max(12),
    reviews: z.array(LearningReviewSchema).max(10),
    project: z
      .object({
        acceptedAt: z.string().datetime(),
        attemptId: LearningId,
        reportHash: LearningHash,
        runInstructions: prose(4000),
        sample: prose(4000),
        limitations: prose(4000),
        personalWork: prose(4000),
        toolWork: prose(4000),
        scope: z.literal("learning_project"),
        mastery: z.literal("observed_not_certified"),
      })
      .strict()
      .optional(),
    pendingCommand: LearningCommandSchema.optional(),
    usage: z
      .object({
        lookupCalls: z.number().int().nonnegative(),
        modelCalls: z.literal(0),
        toolCalls: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type LearningPath = z.infer<typeof LearningPathSchema>;
export type LearningCommandInput<T = LearningCommand> =
  T extends LearningCommand
    ? Omit<T, "requestId" | "expectedRevision" | "consent">
    : never;
