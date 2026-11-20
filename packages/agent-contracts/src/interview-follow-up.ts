import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max);
const timestamp = z.string().datetime();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const InterviewPlanSchema = z.object({
  path: z.enum(["facts", "practice", "defer"]),
  standard: text(600), nextAction: text(400), dueAt: timestamp,
}).strict();
export type InterviewPlan = z.infer<typeof InterviewPlanSchema>;
export const InterviewDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plan"), plan: InterviewPlanSchema }).strict(),
  z.object({ kind: z.literal("observe"), observation: text(1200) }).strict(),
  z.object({ kind: z.literal("training"), kitId: z.string().uuid(), kitVersion: hash }).strict(),
  z.object({ kind: z.literal("assess"), assessment: z.enum(["met", "retry"]), observation: text(1200), nextAction: text(400) }).strict(),
  z.object({ kind: z.literal("interview"), observation: text(1200) }).strict(),
]);
export type InterviewDecision = z.infer<typeof InterviewDecisionSchema>;
const RoundSchema = z.object({
  plan: InterviewPlanSchema.nullable(),
  observation: z.string(), kitId: z.string().uuid().nullable(), kitVersion: hash.nullable(),
  retestDueAt: timestamp.nullable(), retestAt: timestamp.nullable(),
  independent: z.boolean().nullable(),
  assessment: z.enum(["met", "retry"]).nullable(), nextAfterAssessment: z.string(),
});
export const InterviewFollowUpStateSchema = RoundSchema.extend({
  interviewObservation: z.string(), revision: z.number().int().nonnegative(),
  history: z.array(z.object({ at: timestamp, detail: z.string(), previousRound: RoundSchema.optional(), decisionHash: hash.optional() })).max(100),
});
export type InterviewFollowUpState = z.infer<typeof InterviewFollowUpStateSchema>;
export const InterviewFollowUpSchema = InterviewFollowUpStateSchema.extend({
  id: hash, feedbackId: text(160), noteId: text(240), segmentId: text(240), quote: text(8000),
  versionId: text(240), applicationId: z.string().nullable(), happenedAt: timestamp,
});
export type InterviewFollowUp = z.infer<typeof InterviewFollowUpSchema>;
export const InterviewFollowUpListSchema = z.object({ items: z.array(InterviewFollowUpSchema), hasMore: z.boolean() });
