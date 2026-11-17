import { z } from "zod";

const prose = (max: number) => z.string().trim().min(1).max(max);
const id = z.string().uuid();
export const TrainingKind = z.enum(["rewrite", "dependency", "canvas"]);
export type TrainingKind = z.infer<typeof TrainingKind>;
export const TrainingAdvice = z
  .object({
    route: z.enum(["rewrite", "dependency", "canvas", "simple", "clarify"]),
    observation: prose(500),
    nextStep: prose(400),
  })
  .strict();
export type TrainingAdvice = z.infer<typeof TrainingAdvice>;
export const TrainingStart = z
  .object({
    requestId: id,
    goal: prose(600),
    evidence: prose(800),
    consent: z.literal(true),
    engine: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("local"),
          model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/),
        })
        .strict(),
      z.object({ type: z.literal("example"), example: TrainingKind }).strict(),
    ]),
  })
  .strict();
export type TrainingStart = z.infer<typeof TrainingStart>;
export const TrainingPlan = z
  .object({
    id,
    goal: prose(600),
    evidence: prose(800),
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
]);
export type TrainingDesign = z.infer<typeof TrainingDesign>;
const field = z.discriminatedUnion("control", [
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
      key: z.enum(["delay", "prediction"]),
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
        z.string().trim().max(400),
      ),
    })
    .strict(),
]);
export type TrainingAnswer = z.infer<typeof TrainingAnswer>;
export const TrainingFeedback = z
  .object({
    met: z.boolean(),
    detail: prose(500),
    cues: z.array(prose(140)).max(3).optional(),
  })
  .strict();
export type TrainingFeedback = z.infer<typeof TrainingFeedback>;
export const TrainingAttempt = z
  .object({
    round: z.enum(["practice", "retest"]),
    at: z.string().datetime(),
    answer: TrainingAnswer,
    feedback: TrainingFeedback,
    usedPreview: z.boolean(),
  })
  .strict();
export type TrainingAttempt = z.infer<typeof TrainingAttempt>;
export const TrainingView = z
  .object({
    id,
    ownerId: prose(160),
    title: prose(80),
    goal: prose(600),
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
    screen: z
      .object({
        instruction: prose(300),
        brief: prose(400),
        notes: z.array(prose(1050)).max(12),
        fields: z.array(field).min(1).max(4),
      })
      .strict(),
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
});
export type TrainingSummary = z.infer<typeof TrainingSummary>;
export const TrainingBuild = z
  .object({ planId: id, requestId: id, consent: z.literal(true) })
  .strict();
export const TrainingCommand = z.discriminatedUnion("action", [
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
      action: z.enum(["keep", "discard"]),
      revision: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type TrainingCommand = z.infer<typeof TrainingCommand>;
