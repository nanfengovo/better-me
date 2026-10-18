import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import test from "node:test";
import mammoth from "mammoth";
import { createDefaultResumeView, getResumeTheme, projectResume, resolveResumeTheme, type FactBase, type ProjectedResume, type ResumeThemeOverrides } from "@better-me/core";
import { projectedResumeToDocx } from "../src/lib/docx-export";

function readXml(buffer: Buffer, filename: string): string {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "Export must be a real DOCX ZIP");
  let entry = buffer.readUInt32LE(end + 16);
  for (let count = 0; count < buffer.readUInt16LE(end + 10); count++) {
    assert.equal(buffer.readUInt32LE(entry), 0x02014b50);
    const nameLength = buffer.readUInt16LE(entry + 28);
    const name = buffer.subarray(entry + 46, entry + 46 + nameLength).toString();
    if (name === filename) {
      const local = buffer.readUInt32LE(entry + 42);
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const compressed = buffer.subarray(start, start + buffer.readUInt32LE(entry + 20));
      return (buffer.readUInt16LE(entry + 10) === 8 ? inflateRawSync(compressed) : compressed).toString("utf8");
    }
    entry += 46 + nameLength + buffer.readUInt16LE(entry + 30) + buffer.readUInt16LE(entry + 32);
  }
  throw new Error(`Missing DOCX part ${filename}`);
}

function fixture(): ProjectedResume {
  return {
    locale: "en", templateId: "editorial", themeId: "forest-professional", layout: { bodyFontSize: 11, pageMargin: 18 },
    profile: { displayName: "Synthetic Name", headline: "Software Engineer", location: "Synthetic City", email: "synthetic@example.com", links: [{ label: "Portfolio", url: "https://example.com" }], targetRoles: [], traits: [] },
    experiences: [{ id: "work", type: "work", org: "Example Company", title: "Engineer", start: "2024-01", end: null, techStack: ["TypeScript"], claims: [{ id: "claim", kind: "action", text: "Implemented synthetic example.", tags: [] }] }],
    skills: ["TypeScript", "SQL"],
  };
}
async function unpack(resume: ProjectedResume) {
  const output = await projectedResumeToDocx(resume);
  const buffer = Buffer.from(await output.blob.arrayBuffer());
  return { ...output, document: readXml(buffer, "word/document.xml"), styles: readXml(buffer, "word/styles.xml"), text: (await mammoth.extractRawText({ buffer })).value };
}
function runWith(xml: string, text: string): string {
  const runs = (xml.match(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g) ?? []).filter((run) => run.includes(`>${text}</w:t>`));
  assert.equal(runs.length, 1, `Exactly one exported run for ${text}`);
  return runs[0]!;
}
const hex = (color: string) => color.slice(1).toUpperCase();

test("DOCX maps paper, text, muted, accent and separate body/name/heading fonts to actual OOXML", async () => {
  const resume = fixture(), output = await unpack(resume), theme = getResumeTheme(resume.themeId);
  assert.match(output.document, new RegExp(`<w:background w:color="${hex(theme.tokens.colors.paper)}"`));
  assert.match(runWith(output.document, "Implemented synthetic example."), /w:ascii="Calibri"/);
  assert.match(runWith(output.document, "Implemented synthetic example."), new RegExp(`w:color w:val="${hex(theme.tokens.colors.text)}"`));
  for (const text of ["Synthetic Name", "Work Experience", "Technical Skills"]) {
    const run = runWith(output.document, text);
    assert.match(run, /w:ascii="Cambria"/);
    assert.match(run, /w:eastAsia="SimSun"/);
    assert.match(run, new RegExp(`w:color w:val="${hex(theme.tokens.colors.accent)}"`));
  }
  assert.match(runWith(output.document, "Synthetic City | synthetic@example.com"), new RegExp(`w:color w:val="${hex(theme.tokens.colors.muted)}"`));
  assert.match(runWith(output.document, "Portfolio"), new RegExp(`w:color w:val="${hex(theme.tokens.colors.accent)}"`));
  assert.match(output.styles, /w:styleId="Heading1"[\s\S]*?w:ascii="Cambria"/);
  assert.match(output.styles, /w:color w:val="26352F"/);
  assert.match(output.document, /w:pgMar w:top="1020"[^>]*w:bottom="1020"/);
  assert.match(runWith(output.document, "Implemented synthetic example."), /w:sz w:val="22"/);
  assert.ok(output.diagnostics.some((line) => line.includes("Word 的打印背景设置")));
  assert.ok(!output.document.includes("<w:tbl>"), "Editable single-column semantics remain intact");
});

test("DOCX uses the same theme override priority as preview while preserving user layout", async () => {
  const resume = fixture();
  resume.themeOverrides = { colors: { paper: "#fafafa", text: "#121314", accent: "#aabbcc", muted: "#456789" }, typography: { bodyFamily: "serif", headingFamily: "sans", nameFamily: "serif" } };
  resume.layout = { accentColor: "#13579b", fontFamily: "mono", bodyFontSize: 12, nameFontSize: 32, headingFontSize: 13, lineHeight: 1.8, pageMargin: 22 };
  const before = structuredClone(resume), output = await unpack(resume);
  for (const text of ["Synthetic Name", "Work Experience", "Implemented synthetic example."]) assert.match(runWith(output.document, text), /w:ascii="Consolas"/);
  assert.match(runWith(output.document, "Synthetic Name"), /w:color w:val="13579B"/);
  assert.match(runWith(output.document, "Synthetic Name"), /w:sz w:val="64"/);
  assert.match(runWith(output.document, "Work Experience"), /w:sz w:val="26"/);
  assert.match(runWith(output.document, "Implemented synthetic example."), /w:color w:val="121314"/);
  assert.match(runWith(output.document, "Implemented synthetic example."), /w:sz w:val="24"/);
  assert.match(output.document, /w:background w:color="FAFAFA"/);
  assert.match(output.styles, /w:line="432"/);
  assert.deepEqual(resume, before, "Export never writes resolved defaults back to the view");
});

test("DOCX maps supported section and keyword decoration without layout tables", async () => {
  const cases: { section: NonNullable<ResumeThemeOverrides["decoration"]>["sectionHeading"]; divider: "solid" | "dashed" | "none"; expected?: RegExp; absentBorder?: boolean }[] = [
    { section: "accent-rule", divider: "solid", expected: /w:bottom[^>]*w:val="single"[^>]*w:color="1B5147"/ },
    { section: "underline", divider: "dashed", expected: /w:bottom[^>]*w:val="dashed"[^>]*w:color="D0DDD4"/ },
    { section: "side-rule", divider: "solid", expected: /w:left[^>]*w:val="single"[^>]*w:color="1B5147"/ },
    { section: "soft-band", divider: "none", expected: /<w:shd[^>]*w:fill="EAF1EC"/ },
    { section: "plain", divider: "none", absentBorder: true },
  ];
  for (const item of cases) {
    const resume = fixture();
    resume.themeOverrides = { decoration: { sectionHeading: item.section, dividerStyle: item.divider, keywordStyle: "plain" } };
    const output = await unpack(resume);
    if (item.expected) assert.match(output.document, item.expected);
    if (item.absentBorder) assert.ok(!output.document.includes("<w:pBdr>"));
    assert.match(output.text, /TypeScript · SQL/);
    assert.ok(!output.document.includes("<w:tbl>"));
  }
  for (const keywordStyle of ["soft-tag", "outlined"] as const) {
    const resume = fixture();
    resume.themeOverrides = { decoration: { sectionHeading: "plain", dividerStyle: "none", keywordStyle } };
    const output = await unpack(resume), skill = runWith(output.document, "SQL");
    assert.match(skill, keywordStyle === "soft-tag" ? /<w:shd[^>]*w:fill="EAF1EC"/ : /<w:bdr[^>]*w:color="D0DDD4"/);
  }
});

test("theme switching preserves projected content, ordering and visibility in the Word archive", async () => {
  const now = "2026-10-18T00:00:00.000Z";
  const facts: FactBase = { schemaVersion: 1, updatedAt: now,
    profile: { displayName: { zh: "合成主题示例" }, email: "HIDDEN_EMAIL@example.com", targetRoles: [], traits: [], links: [], constraints: [] },
    experiences: [
      { id: "visible", type: "work", org: { zh: "VISIBLE_WORK" }, title: { zh: "示例职位" }, start: "2024-01", end: null, techStack: ["TypeScript"], claims: [{ id: "claim", kind: "action", text: { zh: "VISIBLE_CLAIM" }, tags: [] }] },
      { id: "hidden", type: "work", org: { zh: "HIDDEN_WORK" }, title: { zh: "隐藏" }, start: "2022-01", end: "2023-01", techStack: ["HIDDEN_SKILL"], claims: [] },
    ] };
  const view = createDefaultResumeView(facts, now);
  view.experienceSelection = "selected";
  view.includedExperienceIds = ["visible"];
  view.profileVisibility = { email: false };
  view.sectionOrder = ["skills", "experience"];
  view.themeId = "editorial-warm";
  const before = structuredClone(facts);
  const warm = await unpack(projectResume(facts, view));
  view.themeId = "tech-teal";
  const teal = await unpack(projectResume(facts, view));
  assert.equal(warm.text, teal.text);
  assert.match(teal.text, /VISIBLE_WORK/);
  assert.match(teal.text, /VISIBLE_CLAIM/);
  assert.ok(teal.text.indexOf("TypeScript") < teal.text.indexOf("VISIBLE_WORK"));
  for (const hidden of ["HIDDEN_EMAIL", "HIDDEN_WORK", "HIDDEN_SKILL"]) assert.ok(!teal.text.includes(hidden));
  assert.notEqual(warm.document, teal.document);
  assert.deepEqual(facts, before);
});

test("unvalidated drafts cannot inject colors, fonts or XML into themed DOCX attributes", async () => {
  const resume = fixture();
  resume.themeId = "unknown-theme-safe-fallback";
  resume.themeOverrides = {
    colors: { paper: '"/><w:injected/>' }, typography: { bodyFamily: 'InjectedFont" bad="true' }, decoration: { sectionHeading: "background:url(https://unsafe.invalid)" },
  } as unknown as ResumeThemeOverrides;
  resume.layout = { fontFamily: 'InjectedFont"' } as ProjectedResume["layout"];
  const resolved = resolveResumeTheme(resume), output = await unpack(resume);
  assert.match(output.document, new RegExp(`<w:background w:color="${hex(resolved.tokens.colors.paper)}"`));
  for (const forbidden of ["w:injected", "InjectedFont", "unsafe.invalid", "background:url"]) {
    assert.ok(!output.document.includes(forbidden));
    assert.ok(!output.styles.includes(forbidden));
  }
  assert.match(runWith(output.document, "Implemented synthetic example."), /w:ascii="Calibri"/);
});

test("legacy DOCX retains black text and layout fonts until an explicit resume theme is selected", async () => {
  const resume = fixture();
  delete resume.themeId;
  resume.layout = { accentColor: "#123456", fontFamily: "mono" };
  resume.themeOverrides = { colors: { text: "#654321", paper: "#fafafa" }, typography: { nameFamily: "serif" } };
  const output = await unpack(resume);
  assert.ok(!output.document.includes("<w:background"));
  for (const text of ["Synthetic Name", "Work Experience", "Implemented synthetic example."]) {
    assert.match(runWith(output.document, text), /w:ascii="Consolas"/);
    assert.match(runWith(output.document, text), /w:color w:val="000000"/);
  }
  assert.ok(!output.document.includes("654321"));
  assert.ok(!output.document.includes("<w:pBdr>"));
  assert.ok(!output.document.includes("<w:tbl>"));
});
