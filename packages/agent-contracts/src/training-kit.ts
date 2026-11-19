import { z } from "zod";
import { TrainingCareerContextSchema, TrainingCareerRefSchema } from "./career-training.js";

import { StudioDesign, StudioEvidence } from "./training-studio.js";
export * from "./training-studio.js";
import { TrainingAction, TrainingRetestAids, TrainingTransferDecision, TrainingTransferRef, TrainingTransferSource } from "./training-transfer.js";
export * from "./training-transfer.js";

const prose = (max: number) => z.string().trim().min(1).max(max);
const id = z.string().uuid();
export const TrainingExampleKind = z.enum(["rewrite", "dependency", "canvas", "concurrency"]);
export type TrainingExampleKind = z.infer<typeof TrainingExampleKind>;
export const TrainingKind = z.enum([...TrainingExampleKind.options, "studio"]);
export type TrainingKind = z.infer<typeof TrainingKind>;
const practiceActions = z.array(TrainingAction).min(1).max(2);
export const TrainingAdvice = z
  .object({
    route: z.enum([...TrainingKind.options, "simple", "clarify"]),
    codeSignature: z.object({
      input: z.enum(["integer", "string", "boolean"]),
      output: z.enum(["integer", "string", "boolean"]),
    }).strict().optional(),
    practiceActions: practiceActions.optional(),
    observation: prose(500),
    nextStep: prose(400),
  })
  .strict();
export type TrainingAdvice = z.infer<typeof TrainingAdvice>;
export const trainingRewriteSourceDetail = "本人根据模型点评提交了改写，已保留改写原文。";
export const TrainingFollowRef = z.object({
  kitId: id,
  version: z.string().regex(/^[a-f0-9]{64}$/),
  round: z.enum(["practice", "retest"]),
  key: StudioEvidence.shape.key,
  useRewrite: z.literal(true).optional(),
}).strict();
export type TrainingFollowRef = z.infer<typeof TrainingFollowRef>;
export const TrainingFollowSource = TrainingFollowRef.extend({
  questionVersion: z.string().regex(/^[a-f0-9]{64}$/),
  kitTitle: prose(80),
  questionLabel: prose(120),
  answer: z.string().min(1).max(1600),
  usedPreview: z.boolean(),
  status: StudioEvidence.shape.status,
  detail: StudioEvidence.shape.detail,
  nextStep: StudioEvidence.shape.nextStep,
});
export type TrainingFollowSource = z.infer<typeof TrainingFollowSource>;
export const TrainingStart = z
  .object({
    requestId: id,
    goal: prose(600),
    evidence: z.string().trim().max(800).default(""),
    careerTarget: TrainingCareerRefSchema.optional(),
    followFrom: TrainingFollowRef.optional(),
    transferFrom: TrainingTransferRef.optional(),
    consent: z.literal(true),
    engine: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("local"),
          model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/),
        })
        .strict(),
      z.object({ type: z.literal("example"), example: TrainingExampleKind }).strict(),
    ]),
  })
  .strict();
export type TrainingStart = z.infer<typeof TrainingStart>;
export const TrainingPlan = z
  .object({
    id,
    goal: prose(600),
    evidence: z.string().trim().max(800),
    career: TrainingCareerContextSchema.optional(),
    followFrom: TrainingFollowSource.optional(),
    transferFrom: TrainingTransferSource.optional(),
    advice: TrainingAdvice,
    origin: z.enum(["example", "local"]),
    model: prose(128).optional(),
    modelCalls: z.number().int().min(0).max(1),
  })
  .strict();
export type TrainingPlan = z.infer<typeof TrainingPlan>;

// Model-authored data only. No HTML, URLs, network, storage keys or permission requests.
const key = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,11}$/);
export const RewriteScene = z
  .object({
    brief: prose(400),
    passage: prose(1000),
    maxWords: z.number().int().min(6).max(65),
    anchors: z
      .array(z.string().regex(/^[A-Za-z]{2,24}$/))
      .min(2)
      .max(4),
  })
  .strict();
export const DependencyScene = z
  .object({
    brief: prose(400),
    tasks: z
      .array(
        z
          .object({
            id: key,
            label: prose(64),
            days: z.number().int().min(1).max(20),
            after: z.array(key).max(4),
          })
          .strict(),
      )
      .min(3)
      .max(7),
    change: key,
  })
  .strict();
export const ConcurrencyScene = z.object({
  resource: z.enum(["库存商品", "生产工件", "维修备件", "预约名额", "生产耗材", "配送配额"]),
  initial: z.number().int().min(2).max(100),
  first: z.number().int().min(1).max(100),
  second: z.number().int().min(1).max(100),
}).strict();
// A pack may compose its own sequence of coaching blocks and branch on a real
// check. These are inert text, never model-authored markup or privileged callbacks.
const cards = z
  .array(
    z
      .object({
        when: z.enum(["before", "after_met", "after_missed"]),
        text: prose(140),
      })
      .strict(),
  )
  .min(1)
  .max(3);
const alternatives = z.array(prose(70)).min(2).max(4);
export const CanvasScene = z
  .object({
    brief: prose(100),
    situation: prose(480),
    steps: z
      .array(
        z.discriminatedUnion("mode", [
          z.object({ mode: z.literal("write"), prompt: prose(120) }).strict(),
          z
            .object({
              mode: z.literal("choose"),
              prompt: prose(120),
              options: alternatives,
            })
            .strict(),
          z.object({ mode: z.literal("rate"), prompt: prose(120) }).strict(),
        ]),
      )
      .min(2)
      .max(4),
  })
  .strict();
const partKey = z.enum(["part1", "part2", "part3", "part4"]);
export const TrainingDesign = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("rewrite"),
      title: prose(80),
      instruction: prose(300),
      answerLabel: prose(75),
      cards,
      scenes: z.array(RewriteScene).length(2),
    })
    .strict(),
  z
    .object({
      kind: z.literal("dependency"),
      title: prose(80),
      instruction: prose(300),
      answerLabel: prose(75),
      cards,
      scenes: z.array(DependencyScene).length(2),
    })
    .strict(),
  z
    .object({
      kind: z.literal("canvas"),
      title: prose(80),
      cards,
      scenes: z.array(CanvasScene).length(2),
    })
    .strict(),
  z.object({
    kind: z.literal("concurrency"),
    title: prose(80),
    cards,
    scenes: z.array(ConcurrencyScene).length(2),
  }).strict(),
  StudioDesign,
]);
export type TrainingDesign = z.infer<typeof TrainingDesign>;
const field = z.discriminatedUnion("control", [
  z.object({
    control: z.literal("order"), key: partKey, label: prose(120),
    options: z.array(prose(36)).min(2).max(6),
  }).strict(),
  z.object({ control: z.literal("code"), key: partKey, label: prose(120) }).strict(),
  z.object({ control: z.literal("quantity"), key: partKey, label: prose(120) }).strict(),
  z
    .object({
      control: z.literal("text"),
      key: z.literal("answer"),
      label: prose(75),
    })
    .strict(),
  z
    .object({
      control: z.enum(["range", "number"]),
      key: z.enum(["delay", "prediction", "part3"]),
      label: prose(100),
      min: z.number().int(),
      max: z.number().int(),
      initial: z.number().int(),
    })
    .strict(),
  z
    .object({ control: z.literal("write"), key: partKey, label: prose(120) })
    .strict(),
  z
    .object({
      control: z.enum(["choose", "rate"]),
      key: partKey,
      label: prose(120),
      options: alternatives.or(z.array(prose(70)).length(5)),
    })
    .strict(),
]);
export const TrainingAnswer = z.union([
  z.object({ answer: prose(1600) }).strict(),
  z
    .object({
      delay: z.number().int().min(0).max(10),
      prediction: z.number().int().min(1).max(150),
    })
    .strict(),
  z
    .object({
      parts: z.record(
        z.string().regex(/^part[1-4]$/),
        z.string().max(400),
      ),
    })
    .strict(),
  z.object({
    parts: z.record(z.string().regex(/^part[1-4]$/), z.string().max(1600)),
    codeKey: partKey,
  }).strict().superRefine((answer, ctx) => {
    if (!answer.parts[answer.codeKey]?.trim()) {
      ctx.addIssue({ code: "custom", path: ["parts", answer.codeKey], message: "Missing function source" });
    }
    for (const [key, value] of Object.entries(answer.parts)) {
      if (key !== answer.codeKey && value.length > 400) {
        ctx.addIssue({ code: "custom", path: ["parts", key], message: "Answer exceeds 400 characters" });
      }
    }
  }),
]);
export type TrainingAnswer = z.infer<typeof TrainingAnswer>;
export const TrainingFeedback = z
  .object({
    met: z.boolean(),
    detail: prose(500),
    cues: z.array(prose(140)).max(3).optional(),
    evidence: z.array(StudioEvidence).min(1).max(4).optional(),
  })
  .strict();
export type TrainingFeedback = z.infer<typeof TrainingFeedback>;
export const TrainingScreen = z.object({
  instruction: prose(300),
  brief: prose(400),
  notes: z.array(prose(1050)).max(12),
  fields: z.array(field).min(1).max(4),
}).strict();
export type TrainingScreen = z.infer<typeof TrainingScreen>;
const rawWriting = z.string().min(1).max(400).refine(value => value.trim().length > 0);
export type TrainingWritingInput = { goal: string; material: string[]; question: string; answer: string };
export const TrainingWritingFeedback = z.object({
  quote: rawWriting,
  comment: prose(400),
  revisionPrompt: prose(140),
}).strict();
export type TrainingWritingFeedback = z.infer<typeof TrainingWritingFeedback>;
export const TrainingWritingReview = TrainingWritingFeedback.extend({
  key: StudioEvidence.shape.key,
  questionVersion: z.string().regex(/^[a-f0-9]{64}$/),
  model: prose(128),
  modelDigest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
  rewrite: z.object({ answer: rawWriting, at: z.string().datetime() }).strict().optional(),
});
export type TrainingWritingReview = z.infer<typeof TrainingWritingReview>;
export const TrainingAttempt = z
  .object({
    round: z.enum(["practice", "retest"]),
    at: z.string().datetime(),
    answer: TrainingAnswer,
    feedback: TrainingFeedback,
    usedPreview: z.boolean(),
    questionVersion: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    question: TrainingScreen.optional(),
    aids: TrainingRetestAids.optional(),
    writingReviews: z.array(TrainingWritingReview).max(4).optional(),
  })
  .strict();
export type TrainingAttempt = z.infer<typeof TrainingAttempt>;
export const TrainingView = z
  .object({
    id,
    ownerId: prose(160),
    title: prose(80),
    goal: prose(600),
    career: TrainingCareerContextSchema.optional(),
    followFrom: TrainingFollowSource.optional(),
    transferFrom: TrainingTransferSource.optional(),
    focus: prose(500),
    kind: TrainingKind,
    version: z.string().regex(/^[a-f0-9]{64}$/),
    origin: z.enum(["example", "local"]),
    model: prose(128).optional(),
    modelDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    modelCalls: z.number().int().min(0).max(4),
    verifiedCases: z.number().int().min(1),
    saved: z.boolean(),
    revision: z.number().int().nonnegative(),
    stage: z.enum(["practice", "waiting", "retest", "complete"]),
    dueAt: z.string().datetime().optional(),
    attempts: z.array(TrainingAttempt).max(2),
    transferDecision: TrainingTransferDecision.optional(),
    retestAids: TrainingRetestAids.optional(),
    screen: TrainingScreen,
    questionVersion: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  })
  .strict();
export type TrainingView = z.infer<typeof TrainingView>;
export const TrainingSummary = TrainingView.pick({
  id: true,
  ownerId: true,
  title: true,
  version: true,
  origin: true,
  stage: true,
  career: true,
});
export type TrainingSummary = z.infer<typeof TrainingSummary>;
export const TrainingBuild = z
  .object({ planId: id, requestId: id, consent: z.literal(true),
    actions: practiceActions.refine(items => new Set(items).size === items.length, "Choose distinct actions").optional(),
  })
  .strict();
export const TrainingCommand = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("recommend-transfer"), revision: z.number().int().nonnegative(), requestId: id, consent: z.literal(true),
  }).strict(),
  z.object({
    action: z.literal("review-writing"),
    revision: z.number().int().nonnegative(), round: z.enum(["practice", "retest"]),
    key: StudioEvidence.shape.key, questionVersion: z.string().regex(/^[a-f0-9]{64}$/),
    consent: z.literal(true), requestId: id,
  }).strict(),
  z.object({
    action: z.literal("save-rewrite"),
    revision: z.number().int().nonnegative(), round: z.enum(["practice", "retest"]),
    key: StudioEvidence.shape.key, questionVersion: z.string().regex(/^[a-f0-9]{64}$/),
    answer: rawWriting,
  }).strict(),
  z
    .object({
      action: z.enum(["explore", "submit"]),
      revision: z.number().int().nonnegative(),
      round: z.enum(["practice", "retest"]),
      answer: TrainingAnswer,
    })
    .strict(),
  z
    .object({
      action: z.enum(["keep", "discard", "view-practice"]),
      revision: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type TrainingCommand = z.infer<typeof TrainingCommand>;
