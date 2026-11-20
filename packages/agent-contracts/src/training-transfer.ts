import { z } from "zod";
import type { TrainingAttempt } from "./training-kit.js";
import { StudioEvidence } from "./training-studio.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const text = (max: number) => z.string().trim().min(1).max(max);
const evidenceId = z.string().regex(/^(practice|rewrite|retest)\.part[1-4]$/);
export const TrainingAction = z.enum(["order", "quantity", "code", "write"]);
export type TrainingAction = z.infer<typeof TrainingAction>;
export const TrainingTransferEvidence = z.object({
  id: evidenceId, phase: z.enum(["practice", "rewrite", "retest"]), key: StudioEvidence.shape.key, control: TrainingAction,
  question: text(120), answer: z.string().min(1).max(1600), usedPreview: z.boolean(),
  status: StudioEvidence.shape.status, detail: text(500),
  reviewedQuote: z.string().min(1).max(400).optional(),
  rewriteTiming: z.enum(["before-retest", "after-retest", "unknown"]).optional(),
}).strict();
export type TrainingTransferEvidence = z.infer<typeof TrainingTransferEvidence>;

export const TrainingRetestAids = z.object({ preview: z.boolean(), practiceReference: z.boolean() }).strict();
export const TrainingRetestChange = z.object({
  key: StudioEvidence.shape.key, before: text(1050), after: text(1050), criterion: text(300),
}).strict();
export type TrainingRetestChange = z.infer<typeof TrainingRetestChange>;
const independence = z.enum(["independent", "assisted", "untracked"]);
const round = z.object({ questionVersion: digest, brief: text(400), material: z.array(text(1050)).max(12), usedPreview: z.boolean() }).strict();
export const TrainingTransferInput = z.object({
  goal: text(600), overallGoal: text(600).optional(), practice: round, retest: round.extend({
    independence, aids: TrainingRetestAids.optional(), change: TrainingRetestChange.optional(),
  }), evidence: z.array(TrainingTransferEvidence).min(2).max(12),
}).strict();
export type TrainingTransferInput = z.infer<typeof TrainingTransferInput>;

export const TrainingTransferAdvice = z.object({
  direction: z.enum(["reinforce", "verify", "extend"]), nextGoal: text(400),
  actions: z.array(TrainingAction).min(1).max(2).refine(items => new Set(items).size === items.length),
  reasons: z.array(z.object({ evidenceId, reason: text(300), answerQuote: text(1600).optional() }).strict()).min(2).max(12),
}).strict();
export type TrainingTransferAdvice = z.infer<typeof TrainingTransferAdvice>;
export const TrainingTransferDecision = TrainingTransferAdvice.extend({
  evidenceVersion: digest, model: text(128), modelDigest: digest, createdAt: z.string().datetime(),
});
export type TrainingTransferDecision = z.infer<typeof TrainingTransferDecision>;
export const TrainingTransferRef = z.object({ kitId: z.string().uuid(), version: digest, evidenceVersion: digest }).strict();
export type TrainingTransferRef = z.infer<typeof TrainingTransferRef>;
export const TrainingTransferSource = TrainingTransferRef.extend({
  kitTitle: text(80), ...TrainingTransferAdvice.shape,
  citations: z.array(TrainingTransferEvidence).min(2).max(12), practiceVersion: digest, retestVersion: digest,
  retestIndependence: independence, retestAids: TrainingRetestAids.optional(), retestChange: TrainingRetestChange.optional(),
});
export type TrainingTransferSource = z.infer<typeof TrainingTransferSource>;

/** Both the consent screen and model get the same projection of the frozen submissions. */
export function trainingTransferInput(overallGoal: string, attempts: readonly TrainingAttempt[], practiceGoal?: string): TrainingTransferInput | undefined {
  const [practice, retest] = attempts;
  if (attempts.length !== 2 || practice?.round !== "practice" || retest?.round !== "retest" ||
      !practice.questionVersion || !retest.questionVersion || !practice.question || !retest.question ||
      practice.questionVersion === retest.questionVersion) return;
  const retestUsedHelp = retest.usedPreview || !!(retest.aids?.preview || retest.aids?.practiceReference);
  const evidence: TrainingTransferEvidence[] = [];
  for (const a of [practice, retest]) {
    if (!a.question || !("parts" in a.answer)) return;
    for (const field of a.question.fields) {
      const control = TrainingAction.safeParse(field.control);
      const result = a.feedback.evidence?.find(item => item.key === field.key);
      const answer = a.answer.parts[field.key];
      if (!control.success || !result || !answer) return;
      const item: TrainingTransferEvidence = { id: a.round + "." + field.key, phase: a.round, key: result.key,
        control: control.data, question: field.label, answer, usedPreview: a.round === "retest" ? retestUsedHelp : a.usedPreview, status: result.status, detail: result.detail };
      const review = a.round === "practice" && a.writingReviews?.find(r => r.key === field.key && r.questionVersion === a.questionVersion);
      const reviewedQuote = review && review.rewrite && field.control === "write" && answer.includes(review.quote)
        ? review.quote : undefined;
      evidence.push(reviewedQuote ? { ...item, reviewedQuote } : item);
      if (review && review.rewrite && field.control === "write") {
        const delta = Date.parse(review.rewrite.at) - Date.parse(retest.at);
        evidence.push({ ...item, id: "rewrite." + field.key, phase: "rewrite", usedPreview: true, answer: review.rewrite.answer,
          status: "recorded", detail: review.revisionPrompt, rewriteTiming: delta < 0 ? "before-retest" : delta > 0 ? "after-retest" : "unknown" });
      }
    }
  }
  const input = TrainingTransferInput.safeParse({ goal: practiceGoal ?? overallGoal,
    ...(practiceGoal && practiceGoal !== overallGoal ? { overallGoal } : {}), evidence,
    practice: { questionVersion: practice.questionVersion, brief: practice.question.brief, material: practice.question.notes, usedPreview: practice.usedPreview },
    retest: { questionVersion: retest.questionVersion, brief: retest.question.brief, material: retest.question.notes, usedPreview: retestUsedHelp,
      independence: retestUsedHelp ? "assisted" : retest.aids ? "independent" : "untracked", aids: retest.aids, change: retest.retestChange } });
  return input.success ? input.data : undefined;
}
