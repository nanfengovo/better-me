import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_HIGHLIGHT_COLOR, getHighlightColor, TextStyleRangeSchema, ResumeViewSchema,
  createDemoFactBase, createDefaultResumeView, projectResume, projectedResumeToMarkdown, splitStyledText,
} from "../dist/index.js";

function fixture(text = "甲乙丙丁") {
  const base = createDemoFactBase("2000-01-01T00:00:00.000Z");
  base.profile.displayName = { zh: "合成姓名", en: "Synthetic name" };
  base.experiences = [{ id: "synthetic-experience", type: "work", org: { zh: "合成组织" }, title: { zh: "合成职位" }, start: "2020-01", end: null, techStack: [], claims: [{ id: "synthetic-entry", kind: "action", text: { zh: text }, tags: [] }] }];
  return { base, view: createDefaultResumeView(base, "2000-01-01T00:00:00.000Z") };
}

test("highlight metadata accepts six-digit colors without requiring a coupled highlight flag", () => {
  for (const color of ["#123456", "#ABCDEF", "#aBc123"]) {
    assert.equal(TextStyleRangeSchema.parse({ start: 0, end: 2, highlightColor: color }).highlightColor, color);
  }
  for (const color of ["", "#abc", "#12345678", "#gg0000", "red", "rgb(1,2,3)", "url(https://invalid.test)", '#123456" onmouseover="x']) {
    assert.equal(TextStyleRangeSchema.safeParse({ start: 0, end: 2, highlight: true, highlightColor: color }).success, false, color);
  }
  const { view } = fixture();
  const ranges = [{ start: 0, end: 2, highlight: true, highlightColor: "#A1B2C3" }];
  assert.deepEqual(ResumeViewSchema.parse({ ...view, textStyles: { "claim:synthetic-entry:zh": ranges } }).textStyles["claim:synthetic-entry:zh"], ranges);
});

test("runtime highlight resolution normalizes custom colors and safely handles invalid draft metadata", () => {
  assert.equal(DEFAULT_HIGHLIGHT_COLOR, "#fae6a1");
  assert.equal(getHighlightColor({ highlight: true }), DEFAULT_HIGHLIGHT_COLOR);
  assert.equal(getHighlightColor({ highlight: true, highlightColor: "#AbCdEf" }), "#abcdef");
  assert.equal(getHighlightColor({ highlight: false, highlightColor: "#123456" }), undefined);
  assert.equal(getHighlightColor({ highlightColor: "#123456" }), undefined);
  assert.equal(getHighlightColor({ highlight: "true", highlightColor: "#123456" }), undefined);
  for (const color of ["url(https://invalid.test)", "expression(alert(1))", "#abc", "#123456; color:red", 123, null]) {
    assert.equal(getHighlightColor({ highlight: true, highlightColor: color }), DEFAULT_HIGHLIGHT_COLOR);
  }
});

test("overlapping highlight colors retain exact text and last defined color per segment", () => {
  const ranges = [{ start: 0, end: 4, bold: true, highlight: true, highlightColor: "#112233" }, { start: 1, end: 3, highlightColor: "#ABCDEF" }, { start: 2, end: 3, highlight: false }];
  const before = structuredClone(ranges);
  const parts = splitStyledText("甲乙丙丁", ranges);
  assert.equal(parts.map(part => part.text).join(""), "甲乙丙丁");
  assert.deepEqual(parts.map(part => getHighlightColor(part.style)), ["#112233", "#abcdef", undefined, "#112233"]);
  assert.ok(parts.every(part => part.style.bold));
  assert.deepEqual(ranges, before);
});

test("projection carries colored formatting through locale fallback without changing facts", () => {
  const { base, view } = fixture();
  const original = structuredClone(base);
  const ranges = [{ start: 0, end: 4, highlight: true, highlightColor: "#AABBCC" }];
  view.locale = "en";
  view.textStyles = { "claim:synthetic-entry:zh": ranges };
  const projected = projectResume(base, view);
  assert.equal(projected.experiences[0].claims[0].text, "甲乙丙丁");
  assert.deepEqual(projected.textStyles["claim:synthetic-entry:en"], ranges);
  assert.match(projectedResumeToMarkdown(projected), /<mark style="background-color: #aabbcc">甲乙丙丁<\/mark>/);
  assert.deepEqual(base, original);
  base.experiences[0].claims[0].text.en = "ABCD";
  view.textStyles["claim:synthetic-entry:en"] = [{ start: 0, end: 4, highlight: true, highlightColor: "#223344" }];
  assert.match(projectedResumeToMarkdown(projectResume(base, view)), /<mark style="background-color: #223344">ABCD<\/mark>/);
});

test("Markdown preserves legacy marks and supports safe explicit colors with escaped content", () => {
  const { base, view } = fixture("<tag>&value");
  view.textStyles = { "claim:synthetic-entry:zh": [{ start: 0, end: 11, highlight: true }] };
  const legacy = projectedResumeToMarkdown(projectResume(base, view));
  assert.match(legacy, /<mark>&lt;tag&gt;&amp;value<\/mark>/);
  assert.doesNotMatch(legacy, /background-color:/);
  view.textStyles["claim:synthetic-entry:zh"][0].highlightColor = "#ABCDEF";
  const colored = projectedResumeToMarkdown(projectResume(base, view));
  assert.match(colored, /<mark style="background-color: #abcdef">&lt;tag&gt;&amp;value<\/mark>/);
  assert.equal(base.experiences[0].claims[0].text.zh, "<tag>&value");
  view.textStyles["claim:synthetic-entry:zh"][0].highlight = false;
  assert.doesNotMatch(projectedResumeToMarkdown(projectResume(base, view)), /<mark|background-color:/);
});

test("unsafe draft colors never enter Markdown attributes while valid text remains intact", () => {
  const { base, view } = fixture("合成正文");
  for (const color of ['#123456" onclick="bad', "url(https://invalid.test)", "expression(alert(1))"]) {
    view.textStyles = { "claim:synthetic-entry:zh": [{ start: 0, end: 4, highlight: true, highlightColor: color }] };
    const markdown = projectedResumeToMarkdown(projectResume(base, view));
    assert.match(markdown, /<mark>合成正文<\/mark>/);
    assert.doesNotMatch(markdown, /onclick|url\(|expression\(|background-color:/);
  }
});
