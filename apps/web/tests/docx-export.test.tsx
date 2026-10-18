import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import test from "node:test";
import mammoth from "mammoth";
import { projectResume, createDefaultResumeView, type FactBase, type ProjectedResume } from "@better-me/core";
import { projectedResumeToDocx, resumeDocxFilename } from "../src/lib/docx-export";

/** Read the generated ZIP's central directory rather than assuming stored entries. */
function readDocxXml(buffer: Buffer, filename: string): string {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "The export is a real DOCX ZIP archive");
  let entry = buffer.readUInt32LE(end + 16);
  for (let count = 0; count < buffer.readUInt16LE(end + 10); count++) {
    assert.equal(buffer.readUInt32LE(entry), 0x02014b50);
    const nameLength = buffer.readUInt16LE(entry + 28);
    const name = buffer.subarray(entry + 46, entry + 46 + nameLength).toString();
    if (name === filename) {
      const local = buffer.readUInt32LE(entry + 42);
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const data = buffer.subarray(start, start + buffer.readUInt32LE(entry + 20));
      return (buffer.readUInt16LE(entry + 10) === 8 ? inflateRawSync(data) : data).toString("utf8");
    }
    entry += 46 + nameLength + buffer.readUInt16LE(entry + 30) + buffer.readUInt16LE(entry + 32);
  }
  throw new Error(`Missing DOCX part: ${filename}`);
}

function resume(locale: "zh" | "en" = "zh"): ProjectedResume {
  return {
    locale, templateId: "sidebar", sectionOrder: ["projects", "experience", "skills", "education", "summary"],
    profile: { displayName: locale === "zh" ? "匿名示例" : "Anonymous Example", headline: "Software Engineer", links: [{ label: "Portfolio", url: "https://example.com/work?a=1&b=2" }], targetRoles: ["Backend Developer"], traits: [] },
    educationSummary: locale === "zh" ? "示例学院" : "Example College", skills: ["TypeScript", "PostgreSQL"],
    experiences: [
      { id: "job", type: "work", org: "Example Company", title: "Engineer", start: "2023-01", end: null, techStack: ["TypeScript"], claims: [{ id: "action", kind: "action", text: "设计接口并维护发布流程\nDocumented deployment steps.", tags: [] }] },
      { id: "project", type: "opensource", org: "Example Community", projectName: "Visible Project", title: "Contributor", start: "2024-02", end: "2025-01", techStack: [], claims: [{ id: "project-action", kind: "action", text: "Reviewed public documentation.", tags: [] }] },
    ],
  };
}

async function unpack(value: ProjectedResume) {
  const result = await projectedResumeToDocx(value);
  const buffer = Buffer.from(await result.blob.arrayBuffer());
  const text = (await mammoth.extractRawText({ buffer })).value;
  return { ...result, buffer, text, xml: readDocxXml(buffer, "word/document.xml") };
}

function runWithText(xml: string, text: string): string {
  const runs = (xml.match(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g) ?? [])
    .filter((run) => run.includes(`>${text}</w:t>`));
  assert.equal(runs.length, 1, `Expected one exported text run for ${text}`);
  return runs[0]!;
}

test("real Chinese and English DOCX exports preserve selected text, section order, links and editable A4 structure", async () => {
  for (const locale of ["zh", "en"] as const) {
    const output = await unpack(resume(locale));
    assert.match(output.blob.type, /wordprocessingml/);
    assert.ok(output.text.includes(locale === "zh" ? "匿名示例" : "Anonymous Example"));
    assert.ok(output.text.indexOf("Visible Project") < output.text.indexOf("Example Company"));
    // Mammoth raw-text mode ignores soft breaks; its HTML reader must retain them.
    const html = (await mammoth.convertToHtml({ buffer: output.buffer })).value;
    assert.match(html, /设计接口并维护发布流程<br\s*\/>Documented deployment steps\./);
    assert.match(output.xml, /w:pgSz w:w="11906" w:h="16838"/);
    assert.match(output.xml, /w:pStyle w:val="Heading1"/);
    assert.match(readDocxXml(output.buffer, "word/_rels/document.xml.rels"), /https:\/\/example\.com\/work\?a=1&amp;b=2/);
    assert.ok(!output.xml.includes("<w:tbl>"), "Main text remains in reading order without layout tables");
  }
});

test("hidden facts and contact fields remain absent after actual DOCX extraction", async () => {
  const now = "2026-10-17T00:00:00.000Z";
  const base: FactBase = {
    schemaVersion: 1, updatedAt: now,
    profile: { displayName: { zh: "匿名" }, email: "hidden@example.com", education: { zh: "HIDDEN_EDUCATION" }, links: [], traits: [], targetRoles: [], constraints: [] },
    experiences: [
      { id: "visible", type: "work", org: { zh: "VISIBLE_ORG" }, title: { zh: "开发" }, start: "2024-01", end: null, techStack: [], claims: [
        { id: "yes", kind: "action", text: { zh: "VISIBLE_ACTION" }, tags: [] },
        { id: "hidden", kind: "action", text: { zh: "HIDDEN_ACTION" }, tags: [] },
        { id: "metric", kind: "metric", text: { zh: "UNCONFIRMED_METRIC" }, metric: { value: 90, unit: "%", confirmed: false }, tags: [] },
      ] },
      { id: "hidden-org", type: "work", org: { zh: "HIDDEN_ORG" }, title: { zh: "开发" }, start: "2020-01", end: "2021-01", techStack: [], claims: [] },
    ],
  };
  const view = { ...createDefaultResumeView(base, now), experienceSelection: "selected" as const, includedExperienceIds: ["visible"], claimSelection: "selected" as const, includedClaimIds: ["yes", "metric"], profileVisibility: { email: false, education: false }, sectionVisibility: { education: false } };
  const output = await unpack(projectResume(base, view));
  assert.match(output.text, /VISIBLE_ORG/);
  assert.match(output.text, /VISIBLE_ACTION/);
  for (const hidden of ["HIDDEN_EDUCATION", "HIDDEN_ACTION", "HIDDEN_ORG", "UNCONFIRMED_METRIC", "hidden@example.com"]) assert.ok(!output.text.includes(hidden), hidden);
});

test("DOCX defensively drops private claims and invalid links without fetching or inventing data", async () => {
  const value = resume();
  value.profile.avatarUrl = "https://private.invalid/photo.jpg";
  value.profile.links.push({ label: "UNSAFE_LINK", url: "javascript:alert(1)" }, { label: "PASSWORD_LINK", url: "https://user:secret@example.com" });
  value.experiences[0]!.claims.push(
    { id: "metric", kind: "metric", text: "UNCONFIRMED_PRIVATE", metric: { value: 88, unit: "%", confirmed: false }, tags: [] },
    { id: "interview", kind: "interview", text: "INTERVIEW_PRIVATE", tags: [] },
    { id: "pitfall", kind: "pitfall", text: "PITFALL_PRIVATE", tags: [] },
  );
  value.experiences[0]!.url = "file:///private-path";
  const output = await unpack(value);
  for (const secret of ["UNCONFIRMED_PRIVATE", "INTERVIEW_PRIVATE", "PITFALL_PRIVATE", "UNSAFE_LINK", "PASSWORD_LINK", "private.invalid", "file://"]) assert.ok(!output.text.includes(secret) && !output.xml.includes(secret), secret);
  const rels = readDocxXml(output.buffer, "word/_rels/document.xml.rels");
  assert.ok(!rels.includes("secret") && !rels.includes("private.invalid") && !rels.includes("javascript:"));
  assert.ok(output.diagnostics.some((line) => line.includes("3 个不安全")));
  assert.ok(output.diagnostics.some((line) => line.includes("3 条未核实")));
});

test("overlapping text styles and layout settings survive as actual OOXML formatting", async () => {
  const value = resume();
  value.layout = { bodyFontSize: 11, nameFontSize: 30, headingFontSize: 13, pageMargin: 20, lineHeight: 1.5, fontFamily: "serif" };
  value.textStyles = { "claim:action:zh": [{ start: 0, end: 4, bold: true }, { start: 2, end: 8, italic: true, underline: true, highlight: true, fontScale: 1.2 }] };
  const output = await unpack(value);
  for (const format of ["<w:b", "<w:i", '<w:u w:val="single"', '<w:highlight w:val="yellow"', '<w:sz w:val="26"']) assert.ok(output.xml.includes(format), format);
  const styles = readDocxXml(output.buffer, "word/styles.xml");
  assert.match(styles, /w:line="360"/);
  assert.match(styles, /w:eastAsia="SimSun"/);
  assert.match(output.xml, /w:pgMar w:top="1134"/);
});

test("custom highlight exports its exact RGB shading without a competing yellow highlight", async () => {
  const value = resume();
  const text = "PLAIN CUSTOM_COLOR TAIL";
  value.experiences[0]!.claims[0]!.text = text;
  value.textStyles = { "claim:action:zh": [
    { start: 0, end: text.length, bold: true, underline: true, fontScale: 1.2 },
    { start: 6, end: 18, highlight: true, highlightColor: "#Aa33Ff" },
  ] };
  const before = structuredClone(value);
  const output = await unpack(value);
  const customRun = runWithText(output.xml, "CUSTOM_COLOR");
  assert.match(customRun, /<w:shd\b[^>]*\bw:fill="aa33ff"/i);
  assert.match(customRun, /<w:shd\b[^>]*\bw:val="clear"/);
  assert.doesNotMatch(customRun, /<w:highlight\b/);
  for (const format of ["<w:b", '<w:u w:val="single"', '<w:sz w:val="24"']) assert.ok(customRun.includes(format), format);
  for (const plain of ["PLAIN ", " TAIL"]) assert.doesNotMatch(runWithText(output.xml, plain), /<w:(?:shd|highlight)\b/);
  assert.equal((output.xml.match(/<w:shd\b/g) ?? []).length, 1, "Only the selected characters receive a background");
  assert.ok(output.text.includes(text));
  assert.deepEqual(value, before, "Export does not alter the selected text, ranges or unrelated resume fields");
});

test("legacy highlight without a color keeps Word's named yellow highlight", async () => {
  const value = resume();
  value.profile.headline = "LEGACY_HIGHLIGHT";
  value.textStyles = { "profile:headline:zh": [{ start: 0, end: value.profile.headline.length, highlight: true }] };
  const output = await unpack(value);
  const run = runWithText(output.xml, "LEGACY_HIGHLIGHT");
  assert.match(run, /<w:highlight w:val="yellow"/);
  assert.doesNotMatch(run, /<w:shd\b/);
  assert.ok(output.text.includes("LEGACY_HIGHLIGHT"));
});

test("disabled or color-only styles export no highlight or shading", async () => {
  const value = resume();
  value.profile.displayName = "COLOR_ONLY";
  value.profile.headline = "DISABLED_HIGHLIGHT";
  value.textStyles = {
    "profile:displayName:zh": [{ start: 0, end: value.profile.displayName.length, highlightColor: "#12ABcd" }],
    "profile:headline:zh": [{ start: 0, end: value.profile.headline.length, highlight: false, highlightColor: "#12ABcd", italic: true }],
  };
  const output = await unpack(value);
  assert.doesNotMatch(output.xml, /<w:(?:shd|highlight)\b/);
  assert.match(runWithText(output.xml, "DISABLED_HIGHLIGHT"), /<w:i\b/);
  for (const text of ["COLOR_ONLY", "DISABLED_HIGHLIGHT"]) assert.ok(output.text.includes(text));
});

test("invalid draft colors cannot enter OOXML shading and safely retain legacy yellow", async () => {
  const value = resume();
  const invalidColors: unknown[] = ["#123", "#12345678", "url(https://invalid.example/color)", 'ffffff" w:fill="BAD', "expression(alert(1))", 123456, { color: "#abcdef" }];
  value.experiences[0]!.claims = invalidColors.map((_, index) => ({ id: `invalid-${index}`, kind: "action", text: `INVALID_COLOR_${index}`, tags: [] }));
  value.textStyles = Object.fromEntries(invalidColors.map((color, index) => [`claim:invalid-${index}:zh`, [{ start: 0, end: `INVALID_COLOR_${index}`.length, highlight: true, highlightColor: color as string }]]));
  const before = structuredClone(value);
  const output = await unpack(value);
  assert.doesNotMatch(output.xml, /<w:shd\b|invalid\.example|expression\(|w:fill="BAD"/);
  for (let index = 0; index < invalidColors.length; index++) {
    assert.match(runWithText(output.xml, `INVALID_COLOR_${index}`), /<w:highlight w:val="yellow"/);
    assert.ok(output.text.includes(`INVALID_COLOR_${index}`));
  }
  assert.deepEqual(value, before, "Export validates draft colors without rewriting source data");
});

test("long multi-page source is not truncated and hidden sections do not leak into the archive", async () => {
  const value = resume("en");
  value.sectionVisibility = { education: false, summary: false };
  value.experiences[0]!.claims = Array.from({ length: 90 }, (_, index) => ({ id: `long-${index}`, kind: "action" as const, text: `Evidence ${index + 1}: Documented the deployment process and reviewed regression coverage with the team. 中文内容保持完整。`, tags: [] }));
  value.experiences[0]!.claims.push({ id: "tail", kind: "action", text: "TAIL_SENTINEL_完整末尾", tags: [] });
  const output = await unpack(value);
  assert.match(output.text, /Evidence 90:/);
  assert.match(output.text, /TAIL_SENTINEL_完整末尾/);
  assert.ok(!output.text.includes("Example College"));
  assert.ok(!output.text.includes("Backend Developer"));
  assert.equal((output.text.match(/Evidence \d+:/g) ?? []).length, 90);
  assert.ok(output.xml.includes("<w:widowControl"), "Word can paginate paragraphs without an unbreakable experience wrapper");
});

test("download names preserve bilingual names and cannot escape the download folder", () => {
  const value = resume();
  value.profile.displayName = '../简历<>:"/\\|?*\u0000. ';
  const filename = resumeDocxFilename(value);
  assert.ok(filename.includes("简历"));
  assert.ok(!/[<>:"/\\|?*\u0000]/.test(filename));
  assert.ok(filename.endsWith(".docx"));
  value.profile.displayName = " ";
  assert.equal(resumeDocxFilename(value), "resume-zh-untitled.docx");
});
