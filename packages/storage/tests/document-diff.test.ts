import test from "node:test";
import assert from "node:assert/strict";
import { getResumeLayout } from "@better-me/core";
import { createInitialDocument, getDocumentFieldChanges } from "../src/index.ts";

test("detailed diff compares experience IDs across reorder and reports correct changed fields", () => {
  const before = createInitialDocument();
  const second = structuredClone(before.factBase.experiences[0]!);
  second.id = "second-experience";
  second.org = { zh: "第二家公司" };
  second.claims = [];
  before.factBase.experiences.push(second);
  const after = structuredClone(before);
  after.factBase.experiences.reverse();
  after.factBase.experiences.find((item) => item.id === second.id)!.title.zh = "高级工程师";
  const changes = getDocumentFieldChanges(before, after);
  const title = changes.find((item) => item.label.includes("第二家公司") && item.label.endsWith("职位 / 专业（中文）"));
  assert.ok(title);
  assert.equal(title.before, second.title.zh);
  assert.equal(title.after, "高级工程师");
  assert.ok(changes.some((item) => item.label === "经历排列顺序"));
  assert.ok(changes.every((item) => item.kind === "changed"));
  assert.ok(!JSON.stringify(changes).includes("second-experience"));
});

test("claim diff matches canonical IDs and exposes text, metric, and confirmation changes", () => {
  const before = createInitialDocument();
  const experience = before.factBase.experiences[0]!;
  const claim = experience.claims[0]!;
  claim.metric = { value: 10, unit: "%", baseline: "原始延迟", causal: "优化索引", confirmed: true };
  const nextClaim = structuredClone(claim);
  nextClaim.id = "stable-other-claim";
  nextClaim.text = { zh: "另一项工作" };
  experience.claims.push(nextClaim);
  const after = structuredClone(before);
  after.factBase.experiences[0]!.claims.reverse();
  const changed = after.factBase.experiences[0]!.claims.find((item) => item.id === claim.id)!;
  changed.text.zh = "优化后降低系统延迟";
  changed.metric = { value: Number.NaN, unit: "ms", baseline: "待补充对照", causal: "新增缓存", confirmed: false };
  const changes = getDocumentFieldChanges(before, after);
  const body = changes.find((item) => item.label.endsWith("正文（中文）") && item.after === changed.text.zh);
  assert.equal(body?.before, claim.text.zh);
  const metric = changes.find((item) => item.label.endsWith("量化指标"));
  assert.match(metric!.before, /10 %；已核实/);
  assert.match(metric!.after, /未完成 ms；待核实/);
  assert.match(metric!.after, /新增缓存/);
  assert.ok(changes.every((item) => item.kind === "changed"));
});

test("added and removed experiences and claims retain readable full content", () => {
  const before = createInitialDocument();
  const after = structuredClone(before);
  const removed = after.factBase.experiences.shift()!;
  const added = structuredClone(removed);
  added.id = "brand-new-experience";
  added.org = { zh: "新的团队" };
  added.claims = [{ id: "brand-new-claim", kind: "note", text: { zh: "完整的新经历要点", en: "Full new claim" }, tags: ["React"] }];
  after.factBase.experiences.push(added);
  const changes = getDocumentFieldChanges(before, after);
  assert.ok(changes.some((item) => item.label.startsWith("删除经历") && item.kind === "removed"));
  assert.ok(changes.some((item) => item.label.startsWith("新增经历") && item.after.includes("新的团队")));
  assert.ok(changes.some((item) => item.label.startsWith("删除要点")));
  assert.ok(changes.some((item) => item.label.startsWith("新增要点") && item.after.includes("完整的新经历要点 / Full new claim")));
});

test("resume differences have human labels for template order visibility typography and rich text", () => {
  const before = createInitialDocument();
  const after = structuredClone(before);
  const view = after.resumeViews[0]!;
  view.name = "海外前端岗位";
  view.templateId = "en-ats";
  view.locale = "en";
  view.sectionOrder = ["skills", "experience", "education", "summary", "projects"];
  view.profileVisibility = { photo: false, education: false };
  view.sectionVisibility = { education: false };
  view.layout = { bodyFontSize: 12, accentColor: "#123456", fontFamily: "serif" };
  view.experienceSelection = "selected";
  view.includedExperienceIds = [];
  view.claimSelection = "selected";
  view.includedClaimIds = [];
  view.textStyles = { "profile:displayName:zh": [{ start: 0, end: 2, bold: true, highlight: true }] };
  const changes = getDocumentFieldChanges(before, after);
  assert.equal(changes.find((item) => item.label.endsWith("模板"))?.after, "极简单栏");
  assert.match(changes.find((item) => item.label.endsWith("区块顺序"))!.after, /^技能 → 工作经历 → 教育背景/);
  assert.equal(changes.find((item) => item.label.endsWith("照片展示"))?.after, "隐藏");
  assert.equal(changes.find((item) => item.label.endsWith("正文字号"))?.after, "12 pt");
  assert.equal(changes.find((item) => item.label.endsWith("所选经历"))?.after, "不展示任何经历");
  assert.equal(changes.find((item) => item.label.endsWith("所选要点"))?.after, "不展示任何要点");
  assert.match(changes.find((item) => item.label.includes("文字格式"))!.after, /加粗、高亮/);
  assert.ok(!JSON.stringify(changes).includes("profile:displayName:zh"));
});

test("timestamps and equivalent default presentation settings produce no detailed noise", () => {
  const before = createInitialDocument();
  const after = structuredClone(before);
  after.factBase.updatedAt = "2026-10-17T12:00:00.000Z";
  after.resumeViews[0]!.updatedAt = "2026-10-17T12:00:00.000Z";
  after.resumeViews[0]!.layout = getResumeLayout();
  after.resumeViews[0]!.profileVisibility = { ...before.resumeViews[0]!.profileVisibility, photo: true };
  after.resumeViews[0]!.sectionVisibility = { education: true };
  after.factBase.experiences[0]!.claims[0]!.createdAt = "2026-10-17T12:00:00.000Z";
  assert.deepEqual(getDocumentFieldChanges(before, after), []);
});

test("text edits do not fabricate reorder or selection changes, and avatars never expose data URLs", () => {
  const before = createInitialDocument();
  before.resumeViews[0]!.experienceSelection = "selected";
  before.resumeViews[0]!.includedExperienceIds = [before.factBase.experiences[0]!.id];
  const after = structuredClone(before);
  after.factBase.experiences[0]!.org.zh = "修改后的单位";
  after.factBase.experiences[0]!.claims[0]!.text.zh = "更新事实正文";
  after.factBase.profile.avatarUrl = "data:image/png;base64,private-image-data";
  const changes = getDocumentFieldChanges(before, after);
  assert.ok(changes.every((item) => !item.label.includes("顺序") && !item.label.endsWith("所选经历")));
  assert.ok(changes.some((item) => item.label === "个人照片"));
  assert.ok(!JSON.stringify(changes).includes("private-image-data"));
});

test("large diffs retain all changed claims rather than silently limiting the result", () => {
  const before = createInitialDocument();
  before.factBase.experiences[0]!.claims = Array.from({ length: 45 }, (_, index) => ({ id: `claim-${index}`, kind: "note", text: { zh: `原始要点 ${index}` }, tags: [] }));
  const after = structuredClone(before);
  for (const claim of after.factBase.experiences[0]!.claims) claim.text.zh = `完整更新 ${claim.text.zh}`;
  const changes = getDocumentFieldChanges(before, after);
  assert.equal(changes.filter((item) => item.label.endsWith("正文（中文）")).length, 45);
  assert.ok(changes.some((item) => item.after === "完整更新 原始要点 44"));
});
