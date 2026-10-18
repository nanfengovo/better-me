import { z } from "zod";
import { LocalizedStringSchema } from "./locale.js";

/** Quantified claim — AI must not invent numbers; user confirms. */
export const MetricSchema = z.object({
  value: z.number().finite(),
  unit: z.string().min(1),
  /** What was measured against (required for non-hollow STAR). */
  baseline: z.string().optional(),
  /** Causal chain: how the action produced the metric. */
  causal: z.string().optional(),
  confirmed: z.boolean().default(false),
});

export type Metric = z.infer<typeof MetricSchema>;

export const FactClaimSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["action", "metric", "note", "pitfall", "interview"]),
  text: LocalizedStringSchema,
  metric: MetricSchema.optional(),
  /** Capability tags for future skill-gap matrix. */
  tags: z.array(z.string()).default([]),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});

export type FactClaim = z.infer<typeof FactClaimSchema>;

export const ExperienceSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["work", "opensource", "education", "other"]),
  org: LocalizedStringSchema,
  title: LocalizedStringSchema,
  /** YYYY-MM */
  start: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "日期无效：请填写 YYYY-MM 月份。"),
  /** YYYY-MM or null = present */
  end: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "日期无效：请填写 YYYY-MM 月份。")
    .nullable(),
  projectName: LocalizedStringSchema.optional(),
  url: z.string().url().optional(),
  techStack: z.array(z.string()).default([]),
  claims: z.array(FactClaimSchema).default([]),
}).refine((experience) => experience.end === null || experience.end >= experience.start, {
  message: "日期无效：结束月份不能早于起始月份。", path: ["end"],
});

export type Experience = z.infer<typeof ExperienceSchema>;

export const ProfileSchema = z.object({
  displayName: LocalizedStringSchema,
  headline: LocalizedStringSchema.optional(),
  avatarUrl: z.string().optional(),
  avatarBbox: z.array(z.number()).optional(),
  yearsOfExperience: z.number().nonnegative().optional(),
  education: LocalizedStringSchema.optional(),
  location: LocalizedStringSchema.optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  links: z
    .array(
      z.object({
        label: z.string(),
        url: z.string().url(),
      }),
    )
    .default([]),
  /** Soft signals for later coach — not hard truths. */
  traits: z.array(z.string()).default([]),
  targetRoles: z.array(LocalizedStringSchema).default([]),
  constraints: z.array(z.string()).default([]),
  salaryRange: z
    .object({
      minK: z.number(),
      maxK: z.number(),
      currency: z.string().default("CNY"),
    })
    .optional(),
});

export type Profile = z.infer<typeof ProfileSchema>;

/** Import evidence for review; excluded from the projected resume. */
export const ResumeImportSourceSchema = z.object({
  fileName: z.string().min(1),
  importedAt: z.string().datetime(),
  rawText: z.string(),
  /** Model transcription is a review aid, not ground truth from the original image. */
  ocrText: z.string().optional(),
  unparsedLines: z.array(z.string()),
});

export type ResumeImportSource = z.infer<typeof ResumeImportSourceSchema>;

export const FactBaseSchema = z.object({
  schemaVersion: z.literal(1),
  updatedAt: z.string().datetime(),
  profile: ProfileSchema,
  experiences: z.array(ExperienceSchema).default([]),
  importSource: ResumeImportSourceSchema.optional(),
});

export type FactBase = z.infer<typeof FactBaseSchema>;

export function parseFactBase(data: unknown): FactBase {
  return FactBaseSchema.parse(data);
}

export function safeParseFactBase(data: unknown) {
  return FactBaseSchema.safeParse(data);
}
