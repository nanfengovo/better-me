import test from "node:test";
import assert from "node:assert/strict";
import { createDemoFactBase, createDefaultResumeView, syncResumeViewsWithFactBase, projectResume, projectedResumeToMarkdown, ResumeViewSchema, splitStyledText, getResumeSectionOrder } from "../dist/index.js";

function fixture() {
  const base = createDemoFactBase();
  const seed = base.experiences[0];
  base.experiences = ["a", "b"].map((id) => ({ ...structuredClone(seed), id }));
  const added = { ...structuredClone(seed), id: "new" };
  return { base, added, view: createDefaultResumeView(base) };
}

test("default and legacy complete views follow newly added experiences", () => {
  const { base, added, view } = fixture();
  const next = { ...base, experiences: [...base.experiences, added] };
  const legacy = { ...view, id: "legacy", experienceSelection: undefined, includedExperienceIds: ["a", "b"] };
  const synced = syncResumeViewsWithFactBase(base, next, [view, legacy], view.id);
  for (const item of synced) assert.deepEqual(projectResume(next, item).experiences.map((e) => e.id), ["a", "b", "new"]);
});

test("active selected view adds new experience and keeps previously hidden ones hidden", () => {
  const { base, added, view } = fixture();
  const selected = { ...view, experienceSelection: "selected", includedExperienceIds: ["a"] };
  const other = { ...selected, id: "other" };
  const next = { ...base, experiences: [...base.experiences, added] };
  const synced = syncResumeViewsWithFactBase(base, next, [selected, other], selected.id);
  assert.deepEqual(projectResume(next, synced[0]).experiences.map((e) => e.id), ["a", "new"]);
  assert.deepEqual(projectResume(next, synced[1]).experiences.map((e) => e.id), ["a"]);
});

test("deleting the last selected experience does not expose excluded experiences", () => {
  const { base, view } = fixture();
  const selected = { ...view, experienceSelection: "selected", includedExperienceIds: ["a"] };
  const next = { ...base, experiences: base.experiences.filter((e) => e.id === "b") };
  const [synced] = syncResumeViewsWithFactBase(base, next, [selected], selected.id);
  assert.deepEqual(synced.includedExperienceIds, []);
  assert.deepEqual(projectResume(next, synced).experiences, []);
});

test("unverified metrics stay out of output until user confirmation", () => {
  const { base, view } = fixture();
  base.experiences[0].claims = [{ id: "metric", kind: "metric", text: { zh: "降低延迟37%" }, metric: { value: 37, unit: "%", confirmed: false }, tags: [] }];
  assert.equal(projectResume(base, view).experiences[0].claims.length, 0);
  base.experiences[0].claims[0].metric.confirmed = true;
  assert.equal(projectResume(base, view).experiences[0].claims[0].text, "降低延迟37%");
});

test("selected claim views follow new claims without exposing old exclusions or deleted selections", () => {
  const { base, view } = fixture();
  base.experiences[0].claims = ["a", "b"].map((id) => ({ id, kind: "action", text: { zh: id }, tags: [] }));
  const selected = { ...view, claimSelection: "selected", includedClaimIds: ["a"] };
  const next = structuredClone(base);
  next.experiences[0].claims = [next.experiences[0].claims[1], { id: "new", kind: "action", text: { zh: "new" }, tags: [] }];
  const [synced] = syncResumeViewsWithFactBase(base, next, [selected], selected.id);
  assert.deepEqual(synced.includedClaimIds, ["new"]);
  assert.deepEqual(projectResume(next, synced).experiences[0].claims.map((claim) => claim.id), ["new"]);
  const last = structuredClone(next);
  last.experiences[0].claims = [next.experiences[0].claims[0]];
  const [empty] = syncResumeViewsWithFactBase(next, last, [synced], synced.id);
  assert.deepEqual(projectResume(last, empty).experiences[0].claims, []);
});

test("new views keep education in its own section while old backups retain header display", () => {
  const { base, view } = fixture();
  base.profile.education = { zh: "学历事实" };
  assert.equal(projectResume(base, view).profile.education, undefined);
  assert.equal(projectResume(base, view).educationSummary, "学历事实");
  const legacy = { ...view };
  delete legacy.profileVisibility;
  delete legacy.layout;
  delete legacy.textStyles;
  const restored = ResumeViewSchema.parse(legacy);
  assert.equal(projectResume(base, restored).profile.education, "学历事实");
  const hidden = projectResume(base, { ...view, sectionVisibility: { education: false } });
  assert.equal(hidden.educationSummary, undefined);
  assert.doesNotMatch(projectedResumeToMarkdown(hidden), /学历事实|教育背景/);
});

test("visibility removes selected profile fields and experiences from every export", () => {
  const { base, view } = fixture();
  base.profile = { ...base.profile, headline: { zh: "隐藏定位" }, avatarUrl: "https://example.test/avatar.png", email: "hidden@example.test", phone: "hidden-phone", location: { zh: "隐藏城市" }, links: [{ label: "hidden-link", url: "https://example.test/private" }], targetRoles: [{ zh: "隐藏方向" }], traits: ["隐藏优势"] };
  const projected = projectResume(base, { ...view, profileVisibility: { photo: false, headline: false, email: false, phone: false, location: false, links: false, targetRoles: false, traits: false }, sectionVisibility: { experience: false, skills: false } });
  assert.deepEqual(projected.experiences, []);
  assert.deepEqual(projected.skills, []);
  const markdown = projectedResumeToMarkdown(projected);
  assert.doesNotMatch(markdown, /隐藏|hidden|avatar.png|工作经历|专业技能/);
  assert.equal(base.profile.email, "hidden@example.test", "display settings never mutate factual data");
});

test("section ordering and duplicate normalization carry through Markdown", () => {
  const { base, view } = fixture();
  base.profile.education = { zh: "教育事实" };
  base.profile.targetRoles = [{ zh: "测试目标" }];
  base.experiences[0].techStack = ["测试技术"];
  const projected = projectResume(base, { ...view, sectionOrder: ["education", "skills", "experience", "summary", "experience"] });
  assert.deepEqual(getResumeSectionOrder(projected.sectionOrder), ["education", "skills", "experience", "summary", "projects", "custom"]);
  const markdown = projectedResumeToMarkdown(projected);
  assert.ok(markdown.indexOf("## 教育背景") < markdown.indexOf("## 专业技能"));
  assert.ok(markdown.indexOf("## 专业技能") < markdown.indexOf("## 工作经历"));
  assert.ok(markdown.indexOf("## 工作经历") < markdown.indexOf("## 目标方向"));
  assert.equal(markdown.match(/## 工作经历/g).length, 1);
});

test("styling follows fallback locale and overlap flags without changing fact text", () => {
  const { base, view } = fixture();
  base.experiences[0].claims = [{ id: "styled", kind: "action", text: { zh: "甲乙丙丁" }, tags: [] }];
  const ranges = [{ start: 0, end: 4, bold: true }, { start: 1, end: 3, bold: false, highlight: true }];
  const projected = projectResume(base, { ...view, locale: "en", textStyles: { "claim:styled:zh": ranges } });
  assert.deepEqual(projected.textStyles["claim:styled:en"], ranges);
  assert.equal(projected.experiences[0].claims[0].text, "甲乙丙丁");
  assert.match(projectedResumeToMarkdown(projected), /\*\*甲\*\*<mark>乙丙<\/mark>\*\*丁\*\*/);
  assert.equal(splitStyledText("甲乙丙丁", ranges).map((segment) => segment.text).join(""), "甲乙丙丁");
  base.experiences[0].claims[0].text.en = "ABCD";
  assert.equal(projectResume(base, { ...view, locale: "en", textStyles: { "claim:styled:zh": ranges } }).textStyles["claim:styled:en"], undefined);
});

test("style range normalization handles stale offsets and schemas reject unsafe appearance metadata", () => {
  assert.equal(splitStyledText("abc", [{ start: 0, end: 100, bold: true }, { start: 50, end: 90, italic: true }]).map((part) => part.text).join(""), "abc");
  const { view } = fixture();
  for (const patch of [{ layout: { accentColor: "red; background:url(x)" } }, { layout: { bodyFontSize: 999 } }, { textStyles: { "claim:example:zh": [{ start: 2, end: 1, bold: true }] } }]) {
    assert.equal(ResumeViewSchema.safeParse({ ...view, ...patch }).success, false);
  }
  assert.equal(projectResume(fixture().base, { ...view, templateId: "en-ats", profileVisibility: { photo: true } }).profile.avatarUrl, undefined);
});

test("Markdown emphasis preserves selected whitespace while using valid delimiters", () => {
  const { base, view } = fixture();
  base.experiences[0].claims = [{ id: "spaces", kind: "action", text: { zh: " 前后留白 " }, tags: [] }];
  const projected = projectResume(base, { ...view, textStyles: { "claim:spaces:zh": [{ start: 0, end: 6, bold: true }] } });
  assert.match(projectedResumeToMarkdown(projected), /-  \*\*前后留白\*\* \n/);
});
