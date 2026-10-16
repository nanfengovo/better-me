import { z } from "zod";
import { LocaleSchema } from "./locale.js";

export const ResumeSectionIdSchema = z.enum([
  "summary",
  "experience",
  "projects",
  "skills",
  "education",
  "custom",
]);

export type ResumeSectionId = z.infer<typeof ResumeSectionIdSchema>;

/**
 * A resume is a *view* over FactBase — selection + ordering + template.
 * Never a second inventing source of truth.
 */
export const ResumeViewSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  locale: LocaleSchema.default("zh"),
  templateId: z.string().min(1).default("zh-classic"),
  /** Legacy views infer all from an empty list; explicit selected may be empty. */
  experienceSelection: z.enum(["all", "selected"]).optional(),
  includedExperienceIds: z.array(z.string()).default([]),
  /** Empty = all claims under included experiences. */
  claimSelection: z.enum(["all", "selected"]).optional(),
  includedClaimIds: z.array(z.string()).default([]),
  sectionOrder: z.array(ResumeSectionIdSchema).default([
    "summary",
    "experience",
    "projects",
    "skills",
    "education",
  ]),
  targetJdId: z.string().optional(),
  updatedAt: z.string().datetime(),
});

export type ResumeView = z.infer<typeof ResumeViewSchema>;

export const TemplateManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  locale: LocaleSchema.or(z.literal("both")),
  description: z.string().optional(),
  license: z.string().optional(),
});

export type TemplateManifest = z.infer<typeof TemplateManifestSchema>;
