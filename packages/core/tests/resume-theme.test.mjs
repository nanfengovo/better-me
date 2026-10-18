import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RESUME_LAYOUT, DEFAULT_RESUME_THEME_ID, RESUME_THEMES,
  ResumeThemeCatalogSchema, ResumeThemeOverridesSchema, ResumeThemeSchema, ResumeViewSchema,
  createDefaultResumeView, createDemoFactBase, getResumeTheme, getResumeThemeCssVariables,
  projectResume, resolveResumeTheme,
} from "../dist/index.js";

test("the built-in catalog has ten independent versioned themes with bilingual metadata", () => {
  assert.equal(RESUME_THEMES.length, 10);
  assert.equal(new Set(RESUME_THEMES.map((theme) => theme.id)).size, 10);
  assert.equal(new Set(RESUME_THEMES.map((theme) => JSON.stringify(theme.tokens))).size, 10);
  for (const theme of RESUME_THEMES) {
    assert.deepEqual(ResumeThemeSchema.parse(JSON.parse(JSON.stringify(theme))), theme);
    assert.ok(theme.name.zh && theme.name.en && theme.description.zh && theme.description.en);
  }
  assert.equal(DEFAULT_RESUME_THEME_ID, "forest-professional");
  assert.equal(getResumeTheme().id, DEFAULT_RESUME_THEME_ID);
});

test("every built-in paper palette keeps normal text and small metadata at readable contrast", () => {
  const luminance = (hex) => {
    const channels = [1, 3, 5].map((start) => {
      const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
      return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
    });
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  };
  const contrast = (foreground, background) => {
    const values = [luminance(foreground), luminance(background)].sort((first, second) => second - first);
    return (values[0] + .05) / (values[1] + .05);
  };
  for (const theme of RESUME_THEMES) {
    for (const foreground of ["text", "muted", "accent"]) {
      assert.ok(contrast(theme.tokens.colors[foreground], theme.tokens.colors.paper) >= 4.5, `${theme.id}: ${foreground} on paper`);
    }
    assert.ok(contrast(theme.tokens.colors.accent, theme.tokens.colors.accentSoft) >= 4.5, `${theme.id}: accent on soft tag`);
  }
});

test("themes reject CSS injection, external fonts, unknown token fields and unsupported versions", () => {
  const theme = getResumeTheme("editorial-warm");
  for (const modify of [
    (value) => { value.schemaVersion = 2; },
    (value) => { value.tokens.colors.accent = "red; background:url(https://example.test/a)"; },
    (value) => { value.tokens.colors.paper = "var(--workbench-background)"; },
    (value) => { value.tokens.typography.bodyFamily = "url(https://example.test/font)"; },
    (value) => { value.tokens.decoration.sectionHeading = "custom-css"; },
    (value) => { value.tokens.colors.extra = "#ffffff"; },
    (value) => { value.css = "body { display: none }"; },
    (value) => { value.tokens.typography.bodyFontSize = 10; },
  ]) {
    const candidate = structuredClone(theme);
    modify(candidate);
    assert.equal(ResumeThemeSchema.safeParse(candidate).success, false);
  }
});

test("catalog validation catches duplicate IDs and an unregistered default", () => {
  assert.equal(ResumeThemeCatalogSchema.safeParse({ schemaVersion: 1, defaultThemeId: "graphite", themes: ["graphite", "graphite"] }).success, false);
  assert.equal(ResumeThemeCatalogSchema.safeParse({ schemaVersion: 1, defaultThemeId: "graphite", themes: ["sandstone"] }).success, false);
});

test("legacy views keep their original defaults and do not silently acquire a theme", () => {
  const base = createDemoFactBase();
  const view = createDefaultResumeView(base);
  assert.deepEqual(view.layout, {}, "new views persist only explicit layout overrides");
  const legacy = ResumeViewSchema.parse(JSON.parse(JSON.stringify(view)));
  assert.equal(legacy.themeId, undefined);
  const projected = projectResume(base, legacy);
  assert.equal(projected.themeId, undefined);
  assert.deepEqual(projected.layout, DEFAULT_RESUME_LAYOUT);
  assert.equal(legacy.themeId, undefined, "projection does not migrate the source view");
});

test("themed projections keep layout sparse so body defaults cannot overwrite heading fonts", () => {
  const base = createDemoFactBase();
  const view = { ...createDefaultResumeView(base), themeId: "forest-professional", layout: { pageMargin: 23 } };
  const projected = projectResume(base, view);
  assert.equal(projected.themeId, "forest-professional");
  assert.deepEqual(projected.layout, { pageMargin: 23 });
  const resolved = resolveResumeTheme(projected);
  assert.equal(resolved.layout.pageMargin, 23);
  assert.equal(resolved.tokens.typography.bodyFamily, "sans");
  assert.equal(resolved.tokens.typography.headingFamily, "serif");
  assert.equal(resolved.tokens.typography.nameFamily, "serif");
});

test("theme choice and safe overrides survive a JSON backup and projection without touching facts", () => {
  const base = createDemoFactBase();
  const beforeFacts = structuredClone(base);
  const view = {
    ...createDefaultResumeView(base), themeId: "editorial-warm",
    themeOverrides: { colors: { paper: "#fffff9" }, typography: { nameFamily: "mono" }, decoration: { keywordStyle: "outlined" } },
    layout: { bodyFontSize: 10.5, lineHeight: 1.7, pageMargin: 20 },
  };
  const restored = ResumeViewSchema.parse(JSON.parse(JSON.stringify(view)));
  const projected = projectResume(base, restored);
  assert.equal(restored.themeId, view.themeId);
  assert.deepEqual(restored.themeOverrides, view.themeOverrides);
  assert.deepEqual(projected.themeOverrides, view.themeOverrides);
  assert.deepEqual(resolveResumeTheme(projected), resolveResumeTheme(restored));
  assert.deepEqual(base, beforeFacts);
});

test("unknown future theme IDs deterministically render the default while remaining recoverable", () => {
  const base = createDemoFactBase();
  const view = ResumeViewSchema.parse({ ...createDefaultResumeView(base), themeId: "future-paper-v2", layout: { bodyFontSize: 11.5 } });
  assert.equal(getResumeTheme(view.themeId).id, "forest-professional");
  assert.equal(resolveResumeTheme(view).id, "forest-professional");
  const projected = projectResume(base, view);
  assert.equal(projected.themeId, "future-paper-v2");
  assert.equal(ResumeViewSchema.parse(JSON.parse(JSON.stringify(view))).themeId, "future-paper-v2");
  assert.equal(resolveResumeTheme(projected).layout.bodyFontSize, 11.5);
});

test("manual accent and font overrides take precedence without resetting user spacing", () => {
  const view = {
    themeId: "editorial-warm",
    themeOverrides: { colors: { accent: "#112233" }, typography: { headingFamily: "serif" } },
    layout: { accentColor: "#AABBCC", fontFamily: "mono", bodyFontSize: 10.5, pageMargin: 24, sectionSpacing: 30, lineHeight: 1.8 },
  };
  const resolved = resolveResumeTheme(view);
  assert.equal(resolved.tokens.colors.accent, "#aabbcc");
  assert.equal(resolved.layout.accentColor, "#aabbcc");
  assert.deepEqual(resolved.tokens.typography, { bodyFamily: "mono", headingFamily: "mono", nameFamily: "mono" });
  assert.equal(resolved.layout.fontFamily, "mono");
  assert.equal(resolved.layout.bodyFontSize, 10.5);
  assert.equal(resolved.layout.pageMargin, 24);
  assert.equal(resolved.layout.sectionSpacing, 30);
  assert.equal(resolved.layout.lineHeight, 1.8);
});

test("theme switching keeps layout values and each theme's independent typography defaults", () => {
  const base = createDemoFactBase();
  const original = { ...createDefaultResumeView(base), themeId: "corporate-navy", layout: { bodyFontSize: 11, headingFontSize: 13, nameFontSize: 31, lineHeight: 1.5, sectionSpacing: 24, pageMargin: 18 } };
  const switched = { ...original, themeId: "editorial-warm" };
  const changedTemplate = { ...switched, templateId: "en-ats" };
  assert.deepEqual(resolveResumeTheme(switched).layout, { ...resolveResumeTheme(original).layout, accentColor: "#985743", fontFamily: "serif" });
  assert.deepEqual(resolveResumeTheme(changedTemplate), resolveResumeTheme(switched));
  assert.deepEqual(projectResume(base, switched).experiences, projectResume(base, original).experiences);
  assert.deepEqual(switched.sectionOrder, original.sectionOrder);
});

test("theme overrides forbid layout duplication and unchecked draft values cannot reach CSS", () => {
  assert.equal(ResumeThemeOverridesSchema.safeParse({ pageMargin: 18 }).success, false);
  assert.equal(ResumeThemeOverridesSchema.safeParse({ colors: { text: "currentColor" } }).success, false);
  assert.equal(ResumeThemeOverridesSchema.safeParse({ typography: { fontSize: 12 } }).success, false);
  assert.equal(ResumeViewSchema.safeParse({ ...createDefaultResumeView(createDemoFactBase()), themeOverrides: { css: "@import url(test)" } }).success, false);
  const variables = getResumeThemeCssVariables({
    themeId: "tech-teal",
    themeOverrides: { colors: { accent: "red;background:url(test)" } },
    layout: { accentColor: "red;background:url(test)", fontFamily: "injected" },
  });
  assert.equal(variables["--resume-accent"], "#126779");
  assert.equal(Object.values(variables).some((value) => /url\(|injected|background:/.test(value)), false);
});

test("resolved objects are isolated from the shared catalog and from other resumes", () => {
  const first = resolveResumeTheme({ themeId: "sandstone" });
  first.tokens.colors.paper = "#000000";
  first.tokens.typography.bodyFamily = "mono";
  const next = resolveResumeTheme({ themeId: "sandstone" });
  assert.equal(next.tokens.colors.paper, "#fffcf6");
  assert.equal(next.tokens.typography.bodyFamily, "sans");
  assert.throws(() => { getResumeTheme("sandstone").tokens.colors.paper = "#000000"; }, TypeError);
});

test("CSS variables contain the same safe paper, typography and layout tokens for preview and print", () => {
  const source = { themeId: "forest-professional", layout: { bodyFontSize: 11, pageMargin: 19, lineHeight: 1.4 } };
  const zh = getResumeThemeCssVariables(source, "zh");
  const en = getResumeThemeCssVariables(source, "en");
  assert.equal(zh["--resume-paper"], "#fffefb");
  assert.equal(zh["--resume-body-size"], "11pt");
  assert.equal(zh["--resume-margin"], "19mm");
  assert.equal(zh["--resume-line-height"], "1.4");
  assert.match(zh["--resume-heading-font"], /SimSun/);
  assert.match(en["--resume-heading-font"], /^Georgia/);
  assert.notEqual(zh["--resume-heading-font"], zh["--resume-body-font"]);
  assert.equal(zh["--resume-paper"], en["--resume-paper"]);
  assert.equal(Object.keys(zh).some((key) => /workbench|app-theme/.test(key)), false);
});
