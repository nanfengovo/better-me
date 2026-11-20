import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max);
const label = text(36);
const instruction = {
  prompt: text(120),
  followUp: text(140).describe("A specific smaller action to try after a miss, or a new angle to reflect on after a written response."),
  extend: text(140).describe("A concrete changed condition or follow-up action for someone who already met the stated constraint."),
};

export const StudioScalar = z.union([
  z.string().max(60), z.number().int().min(-10000).max(10000), z.boolean(),
]);
export type StudioScalar = z.infer<typeof StudioScalar>;

export const StudioStep = z.discriminatedUnion("mode", [
  z.object({
    ...instruction,
    mode: z.literal("order"),
    constraints: z.array(z.object({ before: label, after: label }).strict()).min(1).max(6)
      .describe("Visible precedence facts about two to six short, distinct item labels. A pair says before must precede after."),
  }).strict(),
  z.object({
    ...instruction,
    mode: z.literal("quantity"),
    operation: z.enum(["sum", "difference", "minimum", "maximum"]),
    values: z.array(z.number().int().min(-10000).max(10000)).min(2).max(8)
      .describe("Visible quantities in their original order. Difference means first minus all remaining quantities."),
  }).strict(),
  z.object({
    ...instruction,
    mode: z.literal("code"),
    cases: z.array(z.object({ input: StudioScalar, expected: StudioScalar }).strict()).min(1).max(4)
      .refine(cases => cases.length >= 2 || typeof cases[0]?.input === "boolean", "Only a binary input domain can use one visible example.")
      .describe("Visible example pairs for a single-argument JavaScript function. A Boolean-only input domain can reserve the other possible input for transfer."),
  }).strict(),
  z.object({ ...instruction, mode: z.literal("write") }).strict(),
]);
export type StudioStep = z.infer<typeof StudioStep>;

export const StudioScene = z.object({
  brief: text(100),
  situation: text(960).describe("The concrete task, including the material needed for the learner to act."),
  steps: z.array(StudioStep).min(1).max(4),
}).strict();
export type StudioScene = z.infer<typeof StudioScene>;

// Both writing prompts ask about the same decision under opposing conditions.
export const StudioDecisionCondition = z.object({
  subject: text(90).describe("A resource, permission, or fact that affects the decision in BOTH tasks. Name the same concrete item without its status."),
  firstState: z.enum(["available", "unavailable", "confirmed", "unconfirmed", "permitted", "prohibited"]),
}).strict();
export type StudioDecisionCondition = z.infer<typeof StudioDecisionCondition>;

export const StudioDesign = z.object({
  kind: z.literal("studio"),
  title: text(80),
  scenes: z.array(StudioScene).length(2),
  decisionCondition: StudioDecisionCondition.optional(),
}).strict();
export type StudioDesign = z.infer<typeof StudioDesign>;

export const StudioEvidence = z.object({
  key: z.enum(["part1", "part2", "part3", "part4"]),
  status: z.enum(["met", "missed", "recorded"]),
  detail: text(300),
  nextStep: text(140),
}).strict();
export type StudioEvidence = z.infer<typeof StudioEvidence>;
