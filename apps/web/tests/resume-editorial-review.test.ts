import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultResumeView, projectResume, type FactBase, type ProjectedResume } from "@better-me/core";
import { reviewResumeEdition } from "../src/lib/resume-editorial-review";
import { inspectWriting, newWritingNote, writingProposal, type WritingSource } from "../src/lib/resume-copilot";

// All people, organizations and work entries here are synthetic.
function fixture(): FactBase {
  return {
    schemaVersion: 1, updatedAt: "2026-10-01T00:00:00.000Z", profile: {
      displayName: { zh: "测试候选人" }, email: "private-marker@example.invalid", constraints: [], links: [],
      traits: [
        "熟悉 SQL、API 和设备运营工具，参与终端异常反馈及诊断过程，使用记录复核工单。",
        "熟悉 API 集成以及 SQL 查询，使用接口和数据表核对任务清单与设备记录。",
        "具备 RAG 原型开发经验，熟悉 AI 模型在知识查询场景中的应用，能够对接业务模块。",
        "掌握 SQL、API 和数据交换接口，熟悉设备运维过程中多个环节的工具与信息来源。",
      ], targetRoles: [{ zh: "开发工程师" }],
    },
    experiences: [{ id: "work", type: "work", org: { zh: "测试组织" }, title: { zh: "全栈工程师" }, start: "2022-01", end: "2025-10",
      techStack: ["SQL", "API"], claims: [{ id: "api", kind: "action", text: { zh: "编写异常记录查询接口。" }, tags: [] }] }],
  };
}
function edition(base = fixture()) { return projectResume(base, createDefaultResumeView(base)); }
const kinds = (r: ProjectedResume) => reviewResumeEdition(r).map(f => f.kind);
const source = (text: string, locale: "zh" | "en" = "zh"): WritingSource => ({ targetRef: { kind: "claim_text", experienceId: "work", claimId: "abc", locale }, text, label: "synthetic" });

test("an experienced edition with a repeated opening, unanchored claims and missing education gets four separate reviews", () => {
  const r = edition(), before = structuredClone(r);
  const result = reviewResumeEdition(r);
  assert.deepEqual(result.map(f => f.kind), ["opening", "full-stack", "ai-evidence", "education"]);
  assert.deepEqual(result.map(f => f.previewAnchor), ["profile:traits", "experience:work", "profile:traits", undefined]);
  assert.match(result.at(-1)!.advice, /当前可见.*并不代表你没有/);
  assert.deepEqual(r, before);
  assert.doesNotMatch(JSON.stringify(result), /private-marker|测试候选人|测试组织/);
});
test("work-first is not prescribed for students, already reordered sections, or short nonrepeating summaries", () => {
  const r = edition();
  r.experiences[0]!.title = "开发实习生";
  assert.ok(!kinds(r).includes("opening"));
  r.experiences[0]!.title = "工程师"; r.profile.targetRoles = ["Software Engineering Internship"];
  assert.ok(!kinds(r).includes("opening"));
  r.profile.targetRoles = []; r.sectionOrder = ["experience", "summary"];
  assert.ok(!kinds(r).includes("opening"));
  r.sectionOrder = ["summary", "experience"]; r.profile.traits = ["用接口核验流水和工单。"];
  assert.ok(!kinds(r).includes("opening"));
});
test("a full-stack role needs examples in that role, not just another job's front-end work", () => {
  const r = edition(); const job = r.experiences[0]!;
  const ui = { id: "ui", text: "设计设备异常处理页面。", kind: "action", tags: [] };
  r.experiences.push({ ...job, id: "other", title: "前端开发", claims: [ui] });
  assert.equal(reviewResumeEdition(r).find(f => f.kind === "full-stack")?.previewAnchor, "experience:work");
  job.claims.push(ui);
  assert.ok(!kinds(r).includes("full-stack"));
});
test("stack tags, background, team output and future or negated work do not validate personal AI delivery", () => {
  const r = edition(); const job = r.experiences[0]!;
  job.techStack.push("RAG", "AI");
  for (const text of ["项目背景：团队为现场开发 RAG 检索服务。", "团队实现了 AI 助手。", "计划接入 RAG 检索。", "我没有实现 RAG 工具。"]) {
    job.claims = [{ ...job.claims[0]!, text }];
    assert.ok(kinds(r).includes("ai-evidence"), text);
  }
  r.experiences.push({ ...job, id: "personal", type: "opensource", claims: [{ ...job.claims[0]!, text: "测试 RAG 召回原型，手动核对漏检条目。" }] });
  assert.ok(!kinds(r).includes("ai-evidence"));
});
test("goals and learning aren't claimed project delivery; explicit English actions support role and education", () => {
  const r = edition(); r.locale = "en"; r.profile.traits = ["Learning RAG", "AI 感兴趣"]; r.profile.headline = "Engineer";
  r.profile.targetRoles = ["Full-stack AI Developer"];
  const job = r.experiences[0]!; job.title = "Full-stack engineer"; job.claims = [
    { id: "en1", text: "Built a web console for dispatchers.", kind: "action", tags: [] },
    { id: "en2", text: "Implemented an API to fetch the audit trail.", kind: "action", tags: [] },
  ];
  r.educationSummary = "BSc, synthetic institute.";
  assert.deepEqual(kinds(r), []);
  r.profile.traits = ["I develop RAG applications."];
  assert.match(reviewResumeEdition(r).find(f => f.kind === "ai-evidence")!.advice, /personal project/);
});
test("an unrelated AI action or a personal prototype does not support a specific production claim", () => {
  const r = edition(), c = r.experiences[0]!.claims[0]!;
  r.profile.headline = "熟悉 AI 应用。"; r.profile.traits = ["在生产环境实现了 RAG 检索服务。"];
  c.text = "测试 AI 分类器，复核异常标签。";
  assert.equal(reviewResumeEdition(r).find(f => f.kind === "ai-evidence")?.previewAnchor, "profile:traits");
  c.text = "设计和测试 RAG 检索原型。";
  assert.equal(reviewResumeEdition(r).find(f => f.kind === "ai-evidence")?.previewAnchor, "profile:traits");
  c.text = "在生产环境实现 RAG 检索服务。";
  assert.ok(!kinds(r).includes("ai-evidence"));
});
test("education can appear in a header, movable education section or a visible custom entry; a hidden section is respected", () => {
  const b = fixture(); b.profile.education = { zh: "测试专业，本科" };
  const view = createDefaultResumeView(b);
  assert.equal(view.profileVisibility?.education, false);
  assert.ok(!kinds(projectResume(b, view)).includes("education"));
  const r = edition(); r.profile.education = "BSc"; assert.ok(!kinds(r).includes("education"));
  r.profile.education = ""; const custom = { ...r.experiences[0]!, type: "other" as const, title: "教育经历", id: "custom" };
  r.experiences.push(custom); assert.ok(!kinds(r).includes("education"));
  r.experiences.pop(); r.sectionVisibility = { education: false }; assert.ok(!kinds(r).includes("education"));
});
test("hidden evidence and other resume editions cannot satisfy the findings", () => {
  const b = fixture();
  b.experiences.push({ ...b.experiences[0]!, id: "hidden", type: "opensource", title: { zh: "个人原型" },
    claims: [{ id: "rag", kind: "action", tags: [], text: { zh: "实现 RAG 检索工具，输出原文段落。" } }] });
  const v = createDefaultResumeView(b);
  assert.ok(!kinds(projectResume(b, v)).includes("ai-evidence"));
  const hidden = projectResume(b, { ...v, sectionVisibility: { projects: false } });
  assert.ok(kinds(hidden).includes("ai-evidence"));
  assert.ok(kinds(projectResume(b, { ...v, isolatedFactBase: fixture() })).includes("ai-evidence"));
});
test("an empty edition is not asked for education or a meaningless score", () => {
  const r = edition(); r.profile.traits = []; r.experiences = [];
  assert.deepEqual(reviewResumeEdition(r), []);
});
test("an ungrounded benefit yields a question only; an observable behavior does not need a number", () => {
  const s = source("构建统一的审核框架，提高系统维护效率。");
  const issue = inspectWriting(s, [s])!;
  assert.equal(issue.kind, "mechanism"); assert.match(issue.question, /哪个对象.*没有记录.*不必补数字/);
  assert.equal(writingProposal(newWritingNote(s, issue)), undefined);
  assert.equal(inspectWriting(source("负责退出保护，存在运行任务时禁止退出。"), []), undefined);
  assert.equal(inspectWriting(source("加入二次确认，大幅降低误操作风险。"), [])?.kind, "magnitude");
  assert.equal(inspectWriting(source("Improved maintenance efficiency.", "en"), [])?.kind, "mechanism");
  assert.equal(inspectWriting(source("Prevented duplicate runs by validating idempotency keys.", "en"), []), undefined);
  assert.equal(inspectWriting(source("核心项目：示例质量审核工具"), []), undefined);
  assert.equal(inspectWriting(source("项目背景：开发审核平台，提高运维效率。"), []), undefined);
});
test("a bilingual copy of the same field isn't a duplicate work entry", () => {
  const s = source("编写审核记录查询接口，并把未确认的状态保留在异常列表中，供接班时核对。");
  assert.notEqual(inspectWriting(s, [s, source(s.text, "en")])?.kind, "duplicate");
});
