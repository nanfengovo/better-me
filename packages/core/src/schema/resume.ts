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

export const ResumeProfileFieldSchema = z.enum([
  "photo", "headline", "education", "location", "email", "phone", "links", "targetRoles", "traits",
]);
export type ResumeProfileField = z.infer<typeof ResumeProfileFieldSchema>;

export const ResumeLayoutSchema = z.object({
  accentColor: z.string().regex(/^#[\da-fA-F]{6}$/).optional(),
  bodyFontSize: z.number().min(8).max(14).optional(),
  nameFontSize: z.number().min(20).max(40).optional(),
  headingFontSize: z.number().min(10).max(17).optional(),
  lineHeight: z.number().min(1.2).max(2).optional(),
  sectionSpacing: z.number().min(12).max(36).optional(),
  pageMargin: z.number().min(12).max(28).optional(),
  fontFamily: z.enum(["sans", "serif", "mono"]).optional(),
});
export type ResumeLayout = z.infer<typeof ResumeLayoutSchema>;

/** UTF-16 offsets match textarea selectionStart / selectionEnd. Styling never alters factual text. */
export const TextStyleRangeSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  highlight: z.boolean().optional(),
  highlightColor: z.string().regex(/^#[\da-fA-F]{6}$/).optional(),
  fontScale: z.number().min(0.8).max(1.8).optional(),
}).refine((range) => range.end > range.start, { message: "格式范围的结束位置必须大于开始位置。" });
export type TextStyleRange = z.infer<typeof TextStyleRangeSchema>;
export type ResumeTextStyle = Omit<TextStyleRange, "start" | "end">;

export const DEFAULT_HIGHLIGHT_COLOR = "#fae6a1";

/** Drafts may temporarily bypass string validation; never emit an unchecked CSS color. */
export function getHighlightColor(style: Pick<ResumeTextStyle, "highlight" | "highlightColor">): string | undefined {
  if (style.highlight !== true) return undefined;
  return typeof style.highlightColor === "string" && /^#[\da-fA-F]{6}$/.test(style.highlightColor)
    ? style.highlightColor.toLowerCase() : DEFAULT_HIGHLIGHT_COLOR;
}

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
  sectionVisibility: z.record(ResumeSectionIdSchema, z.boolean()).optional(),
  profileVisibility: z.record(ResumeProfileFieldSchema, z.boolean()).optional(),
  layout: ResumeLayoutSchema.optional(),
  textStyles: z.record(z.array(TextStyleRangeSchema)).optional(),
  targetJdId: z.string().optional(),
  updatedAt: z.string().datetime(),
});

export type ResumeView = z.infer<typeof ResumeViewSchema>;

export const DEFAULT_RESUME_LAYOUT: Required<ResumeLayout> = {
  accentColor: "#1b5147", bodyFontSize: 10, nameFontSize: 28, headingFontSize: 11,
  lineHeight: 1.6, sectionSpacing: 22, pageMargin: 16, fontFamily: "sans",
};

export function getResumeLayout(layout?: ResumeLayout): Required<ResumeLayout> {
  return { ...DEFAULT_RESUME_LAYOUT, ...layout };
}

/** Append omitted sections so older backups keep all facts; duplicates never render twice. */
export function getResumeSectionOrder(order?: ResumeSectionId[]): ResumeSectionId[] {
  return [...new Set([...(order ?? []), ...ResumeSectionIdSchema.options])];
}

export function isResumeSectionVisible(view: Pick<ResumeView, "sectionVisibility">, section: ResumeSectionId): boolean {
  return view.sectionVisibility?.[section] !== false;
}

export function isResumeProfileVisible(view: Pick<ResumeView, "profileVisibility">, field: ResumeProfileField): boolean {
  return view.profileVisibility?.[field] !== false;
}

/** Resolve overlapping ranges into safe plain-text segments shared by HTML and Markdown. */
export function splitStyledText(text: string, ranges: TextStyleRange[] = []): { text: string; style: ResumeTextStyle }[] {
  const validRanges = ranges.filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
    .map((range) => ({ ...range, start: Math.max(0, Math.min(text.length, Math.floor(range.start))), end: Math.max(0, Math.min(text.length, Math.floor(range.end))) }))
    .filter((range) => range.end > range.start);
  const boundaries = [...new Set([0, text.length, ...validRanges.flatMap((range) => [range.start, range.end])])].sort((a, b) => a - b);
  return boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1]!;
    const style: ResumeTextStyle = {};
    for (const range of validRanges) {
      if (range.start <= start && range.end >= end) {
        for (const key of ["bold", "italic", "underline", "highlight", "highlightColor", "fontScale"] as const) {
          if (range[key] !== undefined) Object.assign(style, { [key]: range[key] });
        }
      }
    }
    return { text: text.slice(start, end), style };
  });
}

export const TemplateManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  locale: LocaleSchema.or(z.literal("both")),
  description: z.string().optional(),
  license: z.string().optional(),
});

export type TemplateManifest = z.infer<typeof TemplateManifestSchema>;
