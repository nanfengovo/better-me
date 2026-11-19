import { decomposeJdText } from "@better-me/core";
import hash from "hash.js";
import { z } from "zod";
import type { TrainingAttempt } from "./training-kit.js";

const identifier = z.string().min(1).max(100);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const competency = z.string().trim().min(1).max(600);
const jobSnapshot = z.object({
  id: z.string().max(400).optional(),
  title: z.string().max(1000),
  company: z.string().max(1000),
  sourcePlatform: z.string().max(400).optional(),
  sourceUrl: z.string().max(4000).optional(),
  description: z.string().min(1).max(30_000),
}).strict();
export type CareerTrainingJob = z.infer<typeof jobSnapshot>;

/** The user chooses a requirement, a plan task and one of its acceptance criteria. */
export const CoachTrainingTargetSchema = z.object({
  id: z.string().uuid(),
  goalId: identifier,
  planId: identifier,
  taskId: identifier,
  job: jobSnapshot,
  itemId: identifier,
  quote: z.string().min(1).max(2000),
  competency,
  criterionIndex: z.number().int().min(0).max(5),
  createdAt: z.string().datetime(),
}).strict();
export type CoachTrainingTarget = z.infer<typeof CoachTrainingTargetSchema>;

export const TrainingCareerRefSchema = z.object({
  workspaceKey: z.string().min(1).max(400),
  targetId: z.string().uuid(),
}).strict();
export type TrainingCareerRef = z.infer<typeof TrainingCareerRefSchema>;

/** Immutable, bounded projection of an adopted target, resolved by the Host. */
export const TrainingCareerContextSchema = TrainingCareerRefSchema.extend({
  goalId: identifier,
  goal: z.string().min(1).max(4000),
  planId: identifier,
  planTitle: z.string().min(1).max(400),
  taskId: identifier,
  taskTitle: z.string().min(1).max(400),
  competency,
  criterion: z.string().min(1).max(4000),
  requirement: z.object({
    jobId: z.string().max(400).optional(),
    title: z.string().max(1000),
    company: z.string().max(1000),
    sourcePlatform: z.string().max(400).optional(),
    sourceUrl: z.string().max(4000).optional(),
    snapshotVersion: digest,
    itemId: identifier,
    quote: z.string().min(1).max(2000),
  }).strict(),
}).strict();
export type TrainingCareerContext = z.infer<typeof TrainingCareerContextSchema>;
export const CoachTrainingEvidenceRefSchema = z.object({
  targetId: z.string().uuid(),
  kitId: z.string().uuid(),
  version: digest,
  round: z.enum(["practice", "retest"]),
  questionVersion: digest,
  writingVersion: digest.optional(),
  transferEvidenceVersion: digest.optional(),
}).strict();
export type CoachTrainingEvidenceRef = z.infer<typeof CoachTrainingEvidenceRefSchema>;

/** Re-saving a round creates another career submission only when the written feedback changed. */
export function careerWritingEvidenceVersion(attempts: readonly TrainingAttempt[]): string | undefined {
  const entries = attempts.flatMap(attempt => [...(attempt.writingReviews ?? [])]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(review => [
      attempt.round, review.questionVersion, review.key, review.quote, review.comment, review.revisionPrompt,
      review.model, review.modelDigest, review.createdAt, review.rewrite?.answer ?? null, review.rewrite?.at ?? null,
    ]));
  return entries.length ? hash.sha256().update(JSON.stringify(entries)).digest("hex") : undefined;
}

export function careerTrainingRequirements(job: CareerTrainingJob) {
  const parsed = decomposeJdText(job.description, job);
  return [...parsed.hardRequirements, ...parsed.responsibilities, ...parsed.preferredQualifications]
    .filter(item => item.originalQuote.length <= 2000 && !/^(?:https?:\/\/|www\.)/i.test(item.originalQuote));
}

export function careerJobSnapshotVersion(job: CareerTrainingJob) {
  return hash.sha256().update(JSON.stringify([job.id ?? null, job.title, job.company, job.description, job.sourcePlatform ?? null, job.sourceUrl ?? null])).digest("hex");
}
