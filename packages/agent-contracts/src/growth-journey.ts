import { z } from "zod";
import { GrowthPracticeTaskSchema } from "./growth-practice.js";

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const GrowthSourceSchema = z.object({
  id: z.literal("checkpoint-note-v1"), version: id, title: z.string().min(1).max(300),
  text: z.string().min(1).max(12000), hash: sha, locator: z.string().min(1).max(300),
  provenance: z.literal("authored_synthetic"),
}).strict();
export type GrowthSource = z.infer<typeof GrowthSourceSchema>;
export const GrowthGoalInputSchema = z.object({
  title: z.string().min(1).max(1000).refine(v => v.trim().length > 0),
  targetWeeks: z.number().int().min(1).max(52), weeklyHours: z.number().int().min(1).max(40),
}).strict();
export const GrowthJourneyCreateSchema = z.object({
  mode: z.literal("synthetic"), goal: GrowthGoalInputSchema,
  idempotencyKey: id, consent: z.literal(true),
}).strict();
export type GrowthJourneyCreate = z.infer<typeof GrowthJourneyCreateSchema>;
const mutation = { expectedRevision: z.number().int().positive(), requestId: id, consent: z.literal(true) };
export const GrowthJourneyCommandSchema = z.discriminatedUnion("kind", [
  z.object({ ...mutation, kind: z.literal("select_source"), sourceVersion: id }).strict(),
  z.object({ ...mutation, kind: z.literal("submit_practice"), sourceCode: z.string().min(1).max(16000),
    answer: z.string().min(1).max(12000).refine(v => v.trim().length > 0),
    explanation: z.string().min(1).max(12000).refine(v => v.trim().length > 0),
    attribution: z.enum(["guided_example", "self_reported"]),
  }).strict(),
  z.object({ ...mutation, kind: z.literal("step_practice"), taskId: id, expectedTaskRevision: z.number().int().positive() }).strict(),
  z.object({ ...mutation, kind: z.literal("accept_project"), taskId: id, reportHash: sha }).strict(),
]);
export type GrowthJourneyCommand = z.infer<typeof GrowthJourneyCommandSchema>;
export const GrowthJourneySchema = z.object({
  id, ownerId: z.string().min(1).max(300), revision: z.number().int().positive(), mode: z.literal("synthetic"),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  goal: GrowthGoalInputSchema.extend({ id, revision: z.literal(1), successCriteria: z.string() }).strict(),
  stage: z.enum(["choose_source", "practice", "checkpoint_saved", "verification_failed", "ready_for_acceptance", "completed", "outcome_unknown"]),
  source: GrowthSourceSchema.optional(), taskIds: z.array(id).max(8),
  task: GrowthPracticeTaskSchema.optional(), reportHash: sha.optional(),
  attempts: z.array(GrowthPracticeTaskSchema).max(8).optional(),
  attemptAttributions: z.record(id, z.enum(["guided_example", "self_reported"])).refine(value => Object.keys(value).length <= 8).optional(),
  pendingCommand: GrowthJourneyCommandSchema.optional(),
  project: z.object({ id, revision: z.literal(1), taskId: id, sourceCodeHash: sha, reportHash: sha,
    acceptedAt: z.string().datetime(), attribution: z.enum(["guided_example", "self_reported"]),
    scope: z.literal("synthetic_practice"), mastery: z.literal("pending_retest"),
  }).strict().optional(),
  events: z.array(z.object({ sequence: z.number().int().positive(), kind: z.enum(["goal_created", "source_selected", "practice_submitted", "practice_advanced", "project_accepted"]), at: z.string().datetime(), detail: z.string() }).strict()).max(100),
}).strict();
export type GrowthJourney = z.infer<typeof GrowthJourneySchema>;
export type GrowthJourneySummary = Pick<GrowthJourney, "id" | "ownerId" | "revision" | "goal" | "stage" | "updatedAt">;
export const GrowthJourneySummarySchema = GrowthJourneySchema.pick({ id: true, ownerId: true, revision: true, goal: true, stage: true, updatedAt: true });
