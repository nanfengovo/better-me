import test from "node:test";
import assert from "node:assert/strict";
import { createDemoFactBase, createDefaultResumeView, projectResume, projectedResumeToRenderCvYaml, RENDERCV_EXPORT_TARGET, RENDERCV_TEMPLATE_THEMES, resolveRenderCvTheme } from "../dist/index.js";

function fixture() {
  const base = createDemoFactBase();
  const sample = base.experiences[0];
  base.profile.displayName = { zh: "中文姓名", en: "Sample Name" };
  base.profile.education = { zh: "专科 / 计算机应用", en: "Associate / Computer Applications" };
  base.profile.targetRoles = [{ zh: "后端方向", en: "Backend" }];
  base.profile.traits = ["可靠交付"];
  base.experiences = [
    { ...structuredClone(sample), id: "work", type: "work", org: { zh: "示例公司", en: "Sample Company" }, title: { zh: "后端工程师", en: "Backend Engineer" }, start: "2021-08", end: null, projectName: { zh: "调度项目" }, techStack: ["C#", "SQL"], claims: [
      { id: "fact", kind: "action", text: { zh: "完成任务迁移", en: "Migrated tasks" }, tags: [] },
      { id: "unverified", kind: "metric", text: { zh: "未核实数字77%" }, metric: { value: 77, unit: "%", confirmed: false }, tags: [] },
      { id: "confirmed", kind: "metric", text: { zh: "保留已核实原文15%" }, metric: { value: 999, unit: "irrelevant", confirmed: true }, tags: [] },
      { id: "interview", kind: "interview", text: { zh: "私有面试笔记" }, tags: [] },
    ] },
    { ...structuredClone(sample), id: "edu", type: "education", org: { zh: "示例学校" }, title: { zh: "计算机应用 / 专科（原文）" }, start: "2018-09", end: "2021-06", techStack: [], claims: [] },
    { ...structuredClone(sample), id: "project", type: "opensource", org: { zh: "开源组织" }, title: { zh: "贡献者" }, projectName: { zh: "示例工具" }, start: "2022-01", end: null, techStack: ["TypeScript"], url: "https://example.test/project?q=中文", claims: [{ id: "open", kind: "action", text: { zh: "维护解析器" }, tags: [] }] },
  ];
  return { base, view: createDefaultResumeView(base) };
}

test("all reviewed RenderCV web themes select their upstream theme without changing factual content", () => {
  const { base, view } = fixture();
  const baseline = projectedResumeToRenderCvYaml(projectResume(base, view)).document.cv;
  for (const [templateId, theme] of Object.entries(RENDERCV_TEMPLATE_THEMES)) {
    const result = projectedResumeToRenderCvYaml(projectResume(base, { ...view, templateId }));
    assert.equal(result.document.design.theme, theme);
    assert.deepEqual(result.document.cv, baseline);
    assert.match(result.yaml, new RegExp(`"theme": "${theme}"`));
    assert.ok(result.diagnostics.some(item => item.code === "renderer-design" && item.message.includes(theme)));
  }
  for (const id of ["newfuture", "jsonresume-kendall", "__proto__", "constructor", "rendercv-classic\nunsafe: true"]) {
    assert.equal(resolveRenderCvTheme(id), "classic");
    const result = projectedResumeToRenderCvYaml(projectResume(base, { ...view, templateId: id }));
    assert.equal(result.document.design.theme, "classic");
    assert.deepEqual(result.document.cv, baseline);
    assert.doesNotMatch(result.yaml, /unsafe: true/);
    assert.ok(result.diagnostics.some(item => item.message.includes("不是 RenderCV")));
  }
});

test("RenderCV maps the selected projection in section order without inventing degree or metrics", () => {
  const { base, view } = fixture();
  const result = projectedResumeToRenderCvYaml(projectResume(base, { ...view, sectionOrder: ["education", "projects", "skills", "experience", "summary"] }));
  assert.deepEqual(Object.keys(result.document.cv.sections), ["教育背景", "项目与作品经历", "专业技能", "工作经历", "目标方向", "核心优势与专长"]);
  const work = result.document.cv.sections["工作经历"][0];
  assert.equal(work.company, "示例公司");
  assert.equal(work.position, "后端工程师");
  assert.equal(work.start_date, "2021-08");
  assert.equal(work.end_date, "present");
  assert.deepEqual(work.highlights, ["完成任务迁移", "保留已核实原文15%"]);
  assert.doesNotMatch(result.yaml, /未核实|私有面试|999|irrelevant/);
  const edu = result.document.cv.sections["教育背景"][0];
  assert.equal(edu.name, "示例学校");
  assert.equal(edu.summary, "计算机应用 / 专科（原文）");
  assert.equal(edu.degree, undefined);
  assert.equal(edu.area, undefined);
  const project = result.document.cv.sections["项目与作品经历"][0];
  assert.equal(project.name, "示例工具");
  assert.match(project.summary, /贡献者\n开源组织/);
  assert.match(project.summary, /https:\/\/example.test\/project/);
  assert.equal(result.document.locale.language, "mandarin_chinese");
  assert.equal(result.document.design.typography.font_family, "Noto Sans");
  assert.equal(result.targetVersion, "2.8");
  assert.ok(result.yaml.startsWith(`# yaml-language-server: $schema=${RENDERCV_EXPORT_TARGET.schemaUrl}\n`));
});

test("hidden sections, profile fields, unselected experiences and claims stay out of RenderCV", () => {
  const { base, view } = fixture();
  base.profile.email = "private@example.test";
  base.profile.phone = "private-phone";
  base.profile.links = [{ label: "私有链接", url: "https://example.test/private" }];
  const selected = { ...view, experienceSelection: "selected", includedExperienceIds: ["work", "edu"], claimSelection: "selected", includedClaimIds: ["fact"], profileVisibility: { email: false, phone: false, links: false, headline: false, education: false }, sectionVisibility: { education: false, summary: false, skills: false } };
  const result = projectedResumeToRenderCvYaml(projectResume(base, selected));
  assert.deepEqual(Object.keys(result.document.cv.sections), ["工作经历"]);
  assert.deepEqual(result.document.cv.sections["工作经历"][0].highlights, ["完成任务迁移"]);
  assert.doesNotMatch(result.yaml, /私有链接|private|示例学校|示例工具|目标方向|可靠交付|15%|教育背景/);
  assert.equal(base.profile.email, "private@example.test");
});

test("RenderCV keeps empty selection empty and exports standalone education summary", () => {
  const { base, view } = fixture();
  const result = projectedResumeToRenderCvYaml(projectResume(base, { ...view, experienceSelection: "selected", includedExperienceIds: [] }));
  assert.deepEqual(result.document.cv.sections["教育背景"], ["专科 / 计算机应用"]);
  assert.equal(result.document.cv.sections["工作经历"], undefined);
  assert.equal(result.document.cv.sections["项目与作品经历"], undefined);
  assert.ok(!result.diagnostics.some((item) => item.code === "education-as-text"));
});

test("YAML scalars quote colon, newlines, controls and YAML-looking payloads as a single string", () => {
  const { base, view } = fixture();
  const value = '中文: "x"\n!!python/object: danger\n---\n&alias *alias\t\u0085\u2028\u2029 😀';
  base.profile.displayName = { zh: value };
  const { yaml, document } = projectedResumeToRenderCvYaml(projectResume(base, view));
  const nameLine = yaml.split("\n").find((line) => line.startsWith('  "name": '));
  assert.equal(JSON.parse(nameLine.slice('  "name": '.length)), document.cv.name);
  assert.ok(nameLine.includes("\\n"));
  assert.ok(nameLine.includes("\\u0085"));
  assert.ok(nameLine.includes("\\u2028"));
  assert.ok(nameLine.includes("😀"));
  assert.ok(!yaml.split("\n").some((line) => line.startsWith("!!python") || line === "---"));
});

test("literal text cannot become raw Markdown links, HTML, Typst commands or math", () => {
  const { base, view } = fixture();
  base.experiences[0].claims = [{ id: "danger", kind: "action", text: { zh: '#read("secret") $$x$$ [go](javascript:alert(1)) <img src=x> **bold** `code` &copy;' }, tags: [] }];
  const { document } = projectedResumeToRenderCvYaml(projectResume(base, view));
  const text = document.cv.sections["工作经历"][0].highlights[0];
  assert.doesNotMatch(text, /#[A-Za-z]|\$\$|<img|(?<!\\)\[go\]|(?<!\\)`code`/);
  assert.match(text, /#\u2060read/);
  assert.match(text, /\$\u2060x\$\u2060/);
  assert.ok(text.includes("&lt;img src=x&gt;"));
  assert.ok(text.includes("\\*\\*bold\\*\\*"));
  assert.ok(text.includes("&amp;copy;"));
});

test("RenderCV normalizes web URLs, keeps labels and local phones, and omits unsafe addresses", () => {
  const { base, view } = fixture();
  base.profile.phone = "010-12345678 转 2";
  base.profile.links = [
    { label: "作品", url: "HTTPS://EXAMPLE.TEST/中文?q=a(b)" },
    { label: "不执行", url: "javascript:alert(1)" },
    { label: "私密凭据", url: "https://user:password@example.test/" },
  ];
  base.experiences[0].url = "file:///private/local-file";
  const { document, yaml, diagnostics } = projectedResumeToRenderCvYaml(projectResume(base, { ...view, profileVisibility: { education: true } }));
  const connections = document.cv.custom_connections;
  assert.equal(document.cv.phone, undefined);
  assert.equal(connections[0].placeholder, "010-12345678 转 2");
  assert.equal(connections[1].placeholder, "专科 / 计算机应用");
  assert.ok(connections.every((connection) => connection.url === null));
  assert.ok(connections.some((connection) => connection.placeholder.startsWith("作品: https://example.test/%E4%B8%AD%E6%96%87")));
  assert.doesNotMatch(yaml, /javascript:|user:password|file:\/\/|private\/local/);
  assert.equal(diagnostics.filter((item) => item.code === "unsafe-link-omitted").length, 3);
});

test("unsupported formatting and photos are diagnosed while English is not translated", () => {
  const { base, view } = fixture();
  base.profile.avatarUrl = "data:image/png;base64,private-image";
  const source = projectResume(base, { ...view, locale: "en", textStyles: { "profile:displayName:en": [{ start: 0, end: 6, bold: true }] } });
  const { document, diagnostics, yaml } = projectedResumeToRenderCvYaml(source);
  assert.equal(document.cv.name, "Sample Name");
  assert.equal(document.locale.language, "english");
  assert.equal(document.design.typography, undefined);
  assert.ok(diagnostics.some((item) => item.code === "renderer-design"));
  assert.ok(diagnostics.some((item) => item.code === "photo-omitted"));
  assert.ok(diagnostics.some((item) => item.code === "text-styles-omitted"));
  assert.doesNotMatch(yaml, /private-image|base64|avatarUrl|metric:|confirmed:/);
  assert.equal(source.profile.avatarUrl, base.profile.avatarUrl, "the projection is never mutated");
});

test("export diagnoses invalid Unicode and blank name without inventing values", () => {
  const { base, view } = fixture();
  base.profile.displayName = { zh: "" };
  base.profile.headline = { zh: "原文\u0000\ud800\uffff" };
  const { document, diagnostics } = projectedResumeToRenderCvYaml(projectResume(base, view));
  assert.equal(document.cv.name, "");
  assert.equal(document.cv.headline, "原文���");
  assert.ok(diagnostics.some((item) => item.code === "blank-name"));
  assert.ok(diagnostics.some((item) => item.code === "unsupported-character"));
});
