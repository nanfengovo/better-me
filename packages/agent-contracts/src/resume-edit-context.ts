import { z } from "zod";
/** Stable, allow-listed resume fields an Agent proposal may target. */
export const ResumeProposalTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("profile_headline"), locale: z.enum(["zh", "en"]) }),
  z.object({
    kind: z.literal("claim_text"),
    experienceId: z.string().min(1).max(160),
    claimId: z.string().min(1).max(160),
    locale: z.enum(["zh", "en"]),
  }),
]);
export type ResumeProposalTarget = z.infer<typeof ResumeProposalTargetSchema>;

const ResumeEditFieldSchema = z.object({
  targetRef: ResumeProposalTargetSchema,
  text: z.string().min(1).max(12_000),
});

/** Whitelisted, non-contact resume context shared only after an explicit user action. */
export const ResumeEditContextSchema = z.object({
  locale: z.enum(["zh", "en"]),
  profile: z.object({ headline: ResumeEditFieldSchema.optional(), skills: z.array(z.string().max(300)).max(200) }),
  experiences: z.array(z.object({
    id: z.string().min(1).max(160),
    type: z.enum(["work", "opensource", "education", "other"]),
    organization: z.string().max(500),
    title: z.string().max(500),
    claims: z.array(z.object({
      targetRef: ResumeProposalTargetSchema,
      kind: z.string().max(100),
      text: z.string().min(1).max(12_000),
      tags: z.array(z.string().max(120)).max(40),
    })).max(120),
  })).max(80),
}).superRefine((value, context) => {
  if (JSON.stringify(value).length > 80_000) {
    context.addIssue({ code: "custom", message: "resume edit context exceeds 80KB" });
  }
});
export type ResumeEditContext = z.infer<typeof ResumeEditContextSchema>;
