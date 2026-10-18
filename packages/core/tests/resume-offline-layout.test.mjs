import test from "node:test";
import assert from "node:assert/strict";
import { parseResumeHeuristicallyWithDiagnostics } from "../dist/ai/resume-parser.js";

// Synthetic formats only: no real resume text, identity, dates, contact details or files.
const base = "姓名：示例甲\n工作经历\n2016.01 - 2018.02 示例公司 | 软件工程师\n负责示例服务。";

test("offline supports spaced section labels, spaced year digits, fullwidth date punctuation and repeated dashes", () => {
  const source = "姓 名 示例乙\n求职意向 测试工程师\n意向城市：示例城\n教育 背景\n20 12 ． 9 —— 2016.6 示例大学 计算机专业（本科）\n示例课程\n专业 技能\n技能甲\n工作经历 • 技能乙\n2018.03 - 至今｜示例公司｜测试工程师\n完成示例测试。";
  const result = parseResumeHeuristicallyWithDiagnostics(source);
  assert.equal(result.rawText, source);
  assert.equal(result.factBase.profile.displayName.zh, "示例乙");
  assert.deepEqual(result.factBase.profile.targetRoles, [{ zh: "测试工程师" }]);
  assert.equal(result.factBase.profile.location.zh, "示例城");
  assert.deepEqual(result.factBase.profile.traits, ["技能甲", "技能乙"]);
  assert.deepEqual(result.factBase.experiences.map((exp) => [exp.type, exp.start, exp.end]), [
    ["education", "2012-09", "2016-06"], ["work", "2018-03", null],
  ]);
  assert.equal(result.factBase.experiences[1].org.zh, "示例公司");
  assert.equal(result.factBase.experiences[1].title.zh, "测试工程师");
});

test("offline assembles explicit date, organization and role spread over adjacent PDF rows", () => {
  const result = parseResumeHeuristicallyWithDiagnostics("姓名：示例甲\n工作经历\n2016.03 — 2018.05\n示例公司\n高级软件工程师\n负责示例模块。");
  assert.equal(result.factBase.experiences.length, 1);
  const exp = result.factBase.experiences[0];
  assert.equal(exp.org.zh, "示例公司");
  assert.equal(exp.title.zh, "高级软件工程师");
  assert.deepEqual(exp.claims.map((claim) => claim.text.zh), ["负责示例模块。"]);
  assert.deepEqual(result.unparsedLines, []);
});

test("offline accepts organization and role before their date row without stealing the previous job's last claim", () => {
  const result = parseResumeHeuristicallyWithDiagnostics(`${base}\n最后一条正文\n下一示例公司\n后端开发\n2019.01–2020.05\n下一段正文`);
  assert.equal(result.factBase.experiences.length, 2);
  assert.deepEqual(result.factBase.experiences[0].claims.map((claim) => claim.text.zh), ["负责示例服务。", "最后一条正文"]);
  assert.equal(result.factBase.experiences[1].org.zh, "下一示例公司");
  assert.equal(result.factBase.experiences[1].title.zh, "后端开发");
});

test("offline reads role before organization and keeps a separate location out of job metadata", () => {
  const result = parseResumeHeuristicallyWithDiagnostics("姓名：示例甲\n工作经历\n算法实习生 示例公司\n示例城，中国 2016.07–2018.02\n完成示例算法。\n研究员 示例大学实验室\n示例城，澳大利亚 2014.08–2015.06\n完成示例研究。");
  assert.deepEqual(result.factBase.experiences.map((exp) => [exp.org.zh, exp.title.zh]), [
    ["示例公司", "算法实习生"], ["示例大学实验室", "研究员"],
  ]);
  assert.ok(result.factBase.experiences.every((exp) => exp.claims.length === 1));
});

test("offline can read an explicit project role before project name on an adjacent date row", () => {
  const result = parseResumeHeuristicallyWithDiagnostics(`${base}\n项目经历\n项目负责人 示例数据平台\n示例城，中国 2017.01–2017.06\n完成示例数据分析。`);
  const project = result.factBase.experiences[1];
  assert.equal(project.type, "other");
  assert.equal(project.org.zh, "示例数据平台");
  assert.equal(project.title.zh, "项目负责人");
  assert.equal(project.projectName.zh, "示例数据平台");
});

test("undated projects, year-only education and certificates retain their own review boundaries", () => {
  const source = `${base}\n项目实践\n项目一：示例平台\n技术栈：示例语言\n示例项目原文。\n教育经历\n示例大学 计算机专业 2010-2014\n示例教育原文。\n获得 证书\n◼ 示例资格证书\n■ 示例语言证书`;
  const result = parseResumeHeuristicallyWithDiagnostics(source);
  assert.equal(result.factBase.experiences.length, 1);
  assert.deepEqual(result.factBase.experiences[0].claims.map((claim) => claim.text.zh), ["负责示例服务。"]);
  assert.deepEqual(result.unparsedLines, [
    "项目一：示例平台", "技术栈：示例语言", "示例项目原文。", "示例大学 计算机专业 2010-2014", "示例教育原文。", "◼ 示例资格证书", "■ 示例语言证书",
  ]);
  assert.equal(result.rawText, source);
});

test("a missing adjacent role cannot be replaced by a responsibility", () => {
  const result = parseResumeHeuristicallyWithDiagnostics(`${base}\n2019.01 - 2020.01 下一示例公司\n负责开发示例平台。\n支持示例系统。`);
  assert.equal(result.factBase.experiences.length, 1);
  assert.equal(result.factBase.experiences[0].claims.length, 1);
  assert.deepEqual(result.unparsedLines, ["2019.01 - 2020.01 下一示例公司", "负责开发示例平台。", "支持示例系统。"]);
});

test("invalid split month stays unparsed and a factual empty project receives a review warning", () => {
  const result = parseResumeHeuristicallyWithDiagnostics(`${base}\n20 19．13 —— 2020.1 无效公司｜工程师\n无效日期后的内容\n项目经历\n2017.01 - 2018.01 示例项目 | 项目负责人\n示例子项目 | 2017 - 至今\n缺月份的项目原文。`);
  assert.equal(result.factBase.experiences.length, 2);
  assert.equal(result.factBase.experiences[1].claims.length, 0);
  assert.ok(result.warnings.some((warning) => warning.includes("未识别到可可靠归属的正文")));
  assert.ok(result.unparsedLines.includes("缺月份的项目原文。"));
  assert.equal(result.factBase.experiences[0].claims.length, 1);
});

test("offline retains a dated responsibility as body instead of starting an incomplete job", () => {
  const result = parseResumeHeuristicallyWithDiagnostics(`${base}\n在2017.04上线示例模块。\n继续维护。`);
  assert.deepEqual(result.factBase.experiences[0].claims.map((claim) => claim.text.zh), [
    "负责示例服务。", "在2017.04上线示例模块。", "继续维护。",
  ]);
  assert.deepEqual(result.unparsedLines, []);
});

test("offline handles country-only degree date rows and club roles after PDF columns are read in order", () => {
  const result = parseResumeHeuristicallyWithDiagnostics("示例甲\n个人信息\n技能\n教育经历\n2010.09 - 2014.07 澳大利亚\n示例大学 计算机科学硕士\n课程原文\n工作经历\n数据分析实习生 示例顾问企业\n示例城，中国 2014.08–2015.06\n完成分析原文\n项目经历\n社团负责人/导师 示例编程社团\n示例城，美国 2013.01–2014.06\n完成指导原文");
  assert.deepEqual(result.factBase.experiences.map((exp) => [exp.type, exp.org.zh, exp.title.zh]), [
    ["education", "示例大学", "计算机科学硕士"],
    ["work", "示例顾问企业", "数据分析实习生"],
    ["other", "示例编程社团", "社团负责人/导师"],
  ]);
  assert.ok(result.factBase.experiences.every((exp) => exp.claims.length === 1));
});
