import { z } from "zod";

/** Theme files describe a fixed visual vocabulary; they never contain executable CSS. */
export const ResumeThemeIdSchema = z.string().min(1).max(80).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
export const ResumeThemeColorSchema = z.string().regex(/^#[\da-fA-F]{6}$/).transform((color) => color.toLowerCase());
export const ResumeThemeFontFamilySchema = z.enum(["sans", "serif", "mono"]);

export const ResumeThemeColorsSchema = z.object({
  paper: ResumeThemeColorSchema,
  text: ResumeThemeColorSchema,
  muted: ResumeThemeColorSchema,
  accent: ResumeThemeColorSchema,
  accentSoft: ResumeThemeColorSchema,
  rule: ResumeThemeColorSchema,
}).strict();

export const ResumeThemeTypographySchema = z.object({
  bodyFamily: ResumeThemeFontFamilySchema,
  headingFamily: ResumeThemeFontFamilySchema,
  nameFamily: ResumeThemeFontFamilySchema,
}).strict();

export const ResumeThemeDecorationSchema = z.object({
  sectionHeading: z.enum(["accent-rule", "underline", "plain", "soft-band", "side-rule"]),
  keywordStyle: z.enum(["plain", "soft-tag", "outlined"]),
  dividerStyle: z.enum(["solid", "dashed", "none"]),
}).strict();

export const ResumeThemeTokensSchema = z.object({
  colors: ResumeThemeColorsSchema,
  typography: ResumeThemeTypographySchema,
  decoration: ResumeThemeDecorationSchema,
}).strict();

const ThemeLocalizedTextSchema = z.object({
  zh: z.string().trim().min(1).max(240),
  en: z.string().trim().min(1).max(240),
}).strict();

export const ResumeThemeSchema = z.object({
  schemaVersion: z.literal(1),
  id: ResumeThemeIdSchema,
  name: ThemeLocalizedTextSchema,
  description: ThemeLocalizedTextSchema,
  tokens: ResumeThemeTokensSchema,
}).strict();

/** Per-resume visual edits only. Sizes, spacing and page margins stay in ResumeLayout. */
export const ResumeThemeOverridesSchema = z.object({
  colors: ResumeThemeColorsSchema.partial().optional(),
  typography: ResumeThemeTypographySchema.partial().optional(),
  decoration: ResumeThemeDecorationSchema.partial().optional(),
}).strict();

export const ResumeThemeCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  defaultThemeId: ResumeThemeIdSchema,
  themes: z.array(ResumeThemeIdSchema).min(1),
}).strict().superRefine((catalog, context) => {
  if (new Set(catalog.themes).size !== catalog.themes.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["themes"], message: "Theme IDs must be unique." });
  }
  if (!catalog.themes.includes(catalog.defaultThemeId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["defaultThemeId"], message: "The default theme must be registered." });
  }
});

export type ResumeTheme = z.infer<typeof ResumeThemeSchema>;
export type ResumeThemeTokens = z.infer<typeof ResumeThemeTokensSchema>;
export type ResumeThemeOverrides = z.infer<typeof ResumeThemeOverridesSchema>;
export type ResumeThemeFontFamily = z.infer<typeof ResumeThemeFontFamilySchema>;
