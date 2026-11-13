import { z } from "zod";

const text=z.string().min(1);
/** A selected defense point is untrusted interview material, never candidate evidence. */
export const MockInterviewFocusSchema=z.object({
  question:text.max(12000),gapItem:text.max(12000),corePoints:z.array(text).max(30),
}).strict();
const citations=z.array(z.string().min(1));
export const MockInterviewReceiptSchema=z.object({
  summary:text,
  answers:z.array(z.object({
    answerId:text,quote:text,assessment:z.enum(["clear","partial","unsupported"]),
    gap:text,improvedExpression:text,evidenceIds:citations,
  }).strict()),
  nextSteps:z.array(text),
}).strict();
export const MockInterviewDecisionSchema=z.discriminatedUnion("kind",[
  z.object({kind:z.literal("read_evidence"),handle:text,offset:z.number().int().nonnegative(),length:z.number().int().positive().max(4000)}).strict(),
  z.object({kind:z.literal("question"),content:text,evidenceIds:citations}).strict(),
  z.object({kind:z.literal("receipt"),receipt:MockInterviewReceiptSchema}).strict(),
]);
export type MockInterviewFocus=z.infer<typeof MockInterviewFocusSchema>;
export type MockInterviewReceipt=z.infer<typeof MockInterviewReceiptSchema>;
