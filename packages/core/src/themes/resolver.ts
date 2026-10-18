import { ResumeThemeCatalogSchema, ResumeThemeOverridesSchema, ResumeThemeSchema, type ResumeTheme, type ResumeThemeFontFamily, type ResumeThemeTokens } from "../schema/resume-theme.js";
import { getResumeLayout, ResumeLayoutSchema, type ResumeLayout, type ResumeView } from "../schema/resume.js";
import type { Locale } from "../schema/locale.js";
import catalogJson from "./catalog.json" with { type: "json" };
import corporateNavy from "./corporate-navy.json" with { type: "json" };
import editorialWarm from "./editorial-warm.json" with { type: "json" };
import monoMinimal from "./mono-minimal.json" with { type: "json" };
import techTeal from "./tech-teal.json" with { type: "json" };
import forestProfessional from "./forest-professional.json" with { type: "json" };
import burgundyElegant from "./burgundy-elegant.json" with { type: "json" };
import graphite from "./graphite.json" with { type: "json" };
import nordicGray from "./nordic-gray.json" with { type: "json" };
import slateBlue from "./slate-blue.json" with { type: "json" };
import sandstone from "./sandstone.json" with { type: "json" };

const catalog = ResumeThemeCatalogSchema.parse(catalogJson);
const themeFiles = [corporateNavy, editorialWarm, monoMinimal, techTeal, forestProfessional, burgundyElegant, graphite, nordicGray, slateBlue, sandstone].map((theme) => ResumeThemeSchema.parse(theme));
const themesById = new Map(themeFiles.map((theme) => [theme.id, theme]));
if (themesById.size !== themeFiles.length || themesById.size !== catalog.themes.length || catalog.themes.some((id) => !themesById.has(id))) {
  throw new Error("Resume theme catalog and registered theme files must match exactly.");
}

/** Freeze the shared library so changing one resume cannot change another resume's defaults. */
function freezeTheme(theme: ResumeTheme): ResumeTheme {
  Object.freeze(theme.name);
  Object.freeze(theme.description);
  Object.freeze(theme.tokens.colors);
  Object.freeze(theme.tokens.typography);
  Object.freeze(theme.tokens.decoration);
  Object.freeze(theme.tokens);
  return Object.freeze(theme);
}

export const DEFAULT_RESUME_THEME_ID = catalog.defaultThemeId;
export const RESUME_THEMES: readonly ResumeTheme[] = Object.freeze(catalog.themes.map((id) => freezeTheme(themesById.get(id)!)));

/** Unknown IDs fall back for rendering; this never rewrites the ID stored in a view. */
export function getResumeTheme(id?: string): ResumeTheme {
  return themesById.get(id ?? DEFAULT_RESUME_THEME_ID) ?? themesById.get(DEFAULT_RESUME_THEME_ID)!;
}

export type ResumeThemeSource = Pick<ResumeView, "themeId" | "themeOverrides" | "layout"> & { locale?: Locale };
export type ResolvedResumeTheme = { id: string; tokens: ResumeThemeTokens; layout: Required<ResumeLayout> };

/** Theme defaults → per-resume visual overrides → explicit layout accent/font overrides. */
export function resolveResumeTheme(view: ResumeThemeSource): ResolvedResumeTheme {
  const theme = getResumeTheme(view.themeId);
  // Drafts may temporarily bypass the document schema. Never turn unchecked values into CSS.
  const checkedOverrides = ResumeThemeOverridesSchema.safeParse(view.themeOverrides);
  const overrides = checkedOverrides.success ? checkedOverrides.data : undefined;
  const checkedLayout = ResumeLayoutSchema.safeParse(view.layout);
  const explicitLayout = checkedLayout.success ? checkedLayout.data : undefined;
  const tokens: ResumeThemeTokens = {
    colors: { ...theme.tokens.colors, ...overrides?.colors },
    typography: { ...theme.tokens.typography, ...overrides?.typography },
    decoration: { ...theme.tokens.decoration, ...overrides?.decoration },
  };
  if (explicitLayout?.accentColor) tokens.colors.accent = explicitLayout.accentColor.toLowerCase();
  if (explicitLayout?.fontFamily) {
    tokens.typography = {
      bodyFamily: explicitLayout.fontFamily,
      headingFamily: explicitLayout.fontFamily,
      nameFamily: explicitLayout.fontFamily,
    };
  }
  const layout = getResumeLayout({
    ...explicitLayout,
    accentColor: tokens.colors.accent,
    fontFamily: tokens.typography.bodyFamily,
  });
  return { id: theme.id, tokens, layout };
}

/** System-only font stacks: themes never fetch fonts or inject arbitrary font-family strings. */
export function getResumeThemeFontStack(family: ResumeThemeFontFamily, locale: Locale = "zh"): string {
  const stacks = locale === "en" ? {
    sans: '"Segoe UI", "Microsoft YaHei", Arial, sans-serif',
    serif: 'Georgia, "Times New Roman", "Noto Serif SC", "SimSun", serif',
    mono: 'Consolas, "Courier New", "Microsoft YaHei", monospace',
  } : {
    sans: '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", "Segoe UI", sans-serif',
    serif: '"Noto Serif SC", "Source Han Serif SC", "SimSun", Georgia, serif',
    mono: 'Consolas, "Courier New", "Microsoft YaHei", monospace',
  };
  return stacks[family];
}

/** Apply only to the resume paper. The workbench's light/dark appearance is independent. */
export function getResumeThemeCssVariables(view: ResumeThemeSource, locale: Locale = view.locale ?? "zh"): Record<`--resume-${string}`, string> {
  const { tokens, layout } = resolveResumeTheme(view);
  const bodyFont = getResumeThemeFontStack(tokens.typography.bodyFamily, locale);
  return {
    "--resume-paper": tokens.colors.paper,
    "--resume-text": tokens.colors.text,
    "--resume-muted": tokens.colors.muted,
    "--resume-accent": tokens.colors.accent,
    "--resume-accent-soft": tokens.colors.accentSoft,
    "--resume-rule": tokens.colors.rule,
    "--resume-body-font": bodyFont,
    "--resume-heading-font": getResumeThemeFontStack(tokens.typography.headingFamily, locale),
    "--resume-name-font": getResumeThemeFontStack(tokens.typography.nameFamily, locale),
    "--resume-font-family": bodyFont,
    "--resume-section-heading": tokens.decoration.sectionHeading,
    "--resume-keyword-style": tokens.decoration.keywordStyle,
    "--resume-divider-style": tokens.decoration.dividerStyle,
    "--resume-body-size": `${layout.bodyFontSize}pt`,
    "--resume-name-size": `${layout.nameFontSize}pt`,
    "--resume-heading-size": `${layout.headingFontSize}pt`,
    "--resume-line-height": String(layout.lineHeight),
    "--resume-section-spacing": `${layout.sectionSpacing}px`,
    "--resume-margin": `${layout.pageMargin}mm`,
  };
}
