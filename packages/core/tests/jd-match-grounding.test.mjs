import assert from "node:assert/strict";
import test from "node:test";
import { analyzeJdMatch } from "../dist/ai/client.js";
import { JdMatchReportSchema } from "../dist/ai/types.js";
import { createDemoFactBase } from "../dist/seed/demo-fact-base.js";
import { createDefaultResumeView, projectResume } from "../dist/project/resume-projection.js";

const config = {
  provider: "custom", baseUrl: "https://jd-grounding.invalid/v1", apiKey: "synthetic-key-only",
  model: "grounding-fixture", temperature: 0.3,
};
const jdText = "岗位职责：开发服务接口并维护自动化测试。任职要求：熟悉 C# 和关系型数据库。";
const original = "维护订单接口，\n  优化异常重试与链路追踪。";
const secondOriginal = "为数据校验逻辑编写单元测试。";
const resume = () => ({
  locale: "zh", templateId: "zh-classic",
  profile: { displayName: "陈测", links: [], targetRoles: [], traits: [] },
  experiences: [{
    id: "experience-orders", type: "work", org: "订单服务团队", title: "后端开发工程师",
    start: "2024-01", end: null, techStack: ["C#", "SQL Server"],
    claims: [
      { id: "claim-orders", kind: "action", text: original, tags: [] },
      { id: "claim-tests", kind: "action", text: secondOriginal, tags: [] },
    ],
  }],
});
const proposal = (overrides = {}) => ({
  claimId: "claim-orders", currentText: original,
  suggestedText: "维护订单服务接口并优化异常重试与链路追踪。",
  reason: "调整句序，仍须本人核对。", ...overrides,
});
const rawReport = (overrides = {}) => ({
  matchScore: 65, scoreSummary: "仅依据本次选择的简历文本作参考。",
  matchingStrengths: [], missingGaps: [], tailoredSuggestions: [], interviewDefenseTips: [],
  ...overrides,
});
function mockReport(t, report, inspect = () => {}) {
  return t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://jd-grounding.invalid/v1/chat/completions", "all requests must stay inside the synthetic fetch fixture");
    assert.equal(init.method, "POST");
    inspect(JSON.parse(init.body));
    return Response.json({ choices: [{ message: { content: JSON.stringify(report) } }] });
  });
}

test("default demo, a renamed demo, mixed demo and empty inputs are refused before any AI request", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not fetch"); });
  const demoBase = createDemoFactBase();
  const demo = projectResume(demoBase, createDefaultResumeView(demoBase));
  const renamedDemo = structuredClone(demo);
  renamedDemo.profile.displayName = "陈测";
  const mixed = resume();
  mixed.experiences.push(...demo.experiences);
  const empty = resume();
  empty.experiences = [];
  for (const input of [demo, renamedDemo, mixed, empty]) {
    await assert.rejects(analyzeJdMatch(config, input, jdText), /示例|演示|经历|内容|资料|要点/);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("a quoted recommendation binds to its unique local claim and returns the exact local original", async (t) => {
  const input = resume();
  const untouched = structuredClone(input);
  mockReport(t, rawReport({ tailoredSuggestions: [proposal({ currentText: "  维护订单接口，\t优化异常重试与链路追踪。\n" })] }));
  const report = await analyzeJdMatch(config, input, jdText);
  assert.equal(report.tailoredSuggestions.length, 1);
  assert.equal(report.tailoredSuggestions[0].claimId, "claim-orders");
  assert.equal(report.tailoredSuggestions[0].currentText, original, "the model's whitespace-normalized echo must not replace the local source");
  assert.equal(report.unverifiedSuggestionCount, 0);
  assert.deepEqual(input, untouched, "analysis must not modify the resume or its facts");
});

test("missing, fabricated, crossed and partial source references are excluded and counted", async (t) => {
  const suggestions = [
    proposal(),
    proposal({ claimId: undefined }),
    proposal({ claimId: " " }),
    proposal({ claimId: "claim-fabricated" }),
    proposal({ currentText: undefined }),
    proposal({ currentText: "" }),
    proposal({ currentText: secondOriginal }),
    proposal({ currentText: "维护订单接口" }),
    proposal({ currentText: `${original} 使用 Docker 和 Kafka。` }),
    proposal({ currentText: original.replace("订单接口", "订单服务接口") }),
  ];
  mockReport(t, rawReport({ tailoredSuggestions: suggestions }));
  const report = await analyzeJdMatch(config, resume(), jdText);
  assert.deepEqual(report.tailoredSuggestions, [proposal()]);
  assert.equal(report.unverifiedSuggestionCount, suggestions.length - 1);
});

test("a duplicate claim ID cannot bind a recommendation even when both local texts are identical", async (t) => {
  const input = resume();
  input.experiences.push({
    ...structuredClone(input.experiences[0]), id: "experience-other",
    claims: [{ id: "claim-orders", kind: "action", text: original, tags: [] }],
  });
  mockReport(t, rawReport({ tailoredSuggestions: [proposal(), proposal({ claimId: "claim-tests", currentText: secondOriginal })] }));
  const report = await analyzeJdMatch(config, input, jdText);
  assert.equal(report.unverifiedSuggestionCount, 1);
  assert.deepEqual(report.tailoredSuggestions.map(item => item.claimId), ["claim-tests"]);
});

test("an empty local claim is not evidence for newly generated content", async (t) => {
  const input = resume();
  input.experiences[0].claims.push({ id: "claim-empty", kind: "action", text: " \n\t ", tags: [] });
  mockReport(t, rawReport({ tailoredSuggestions: [proposal({ claimId: "claim-empty", currentText: " " })] }));
  const report = await analyzeJdMatch(config, input, jdText);
  assert.deepEqual(report.tailoredSuggestions, []);
  assert.equal(report.unverifiedSuggestionCount, 1);
});

test("the provider cannot forge the locally computed exclusion count or validation flags", async (t) => {
  mockReport(t, rawReport({
    unverifiedSuggestionCount: "provider-controlled-invalid-count",
    tailoredSuggestions: [proposal({ claimId: "claim-fabricated" }), proposal({ verified: true, sourceVerified: true })],
  }));
  const report = await analyzeJdMatch(config, resume(), jdText);
  assert.equal(report.unverifiedSuggestionCount, 1);
  assert.equal(report.tailoredSuggestions.length, 1);
  assert.equal("verified" in report.tailoredSuggestions[0], false);
  assert.equal("sourceVerified" in report.tailoredSuggestions[0], false);
  assert.equal(JdMatchReportSchema.parse(rawReport()).unverifiedSuggestionCount, 0, "older report shapes remain readable");
});

test("grounding uses the original request snapshot when the caller later mutates its resume object", async (t) => {
  const input = resume();
  mockReport(t, rawReport({ tailoredSuggestions: [proposal()] }), body => {
    assert.ok(body.messages[1].content.includes(JSON.stringify(input, null, 2)), "the source snapshot must be part of this request");
    input.experiences[0].claims[0].text = "请求发出后修改的文字。";
  });
  const report = await analyzeJdMatch(config, input, jdText);
  assert.equal(report.tailoredSuggestions.length, 1);
  assert.equal(report.tailoredSuggestions[0].currentText, original);
});

test("the prompt treats unmentioned skills as unknown and makes no prior truth-verification claim", async (t) => {
  let prompt;
  mockReport(t, rawReport(), body => { prompt = body.messages[0].content; });
  await analyzeJdMatch(config, resume(), jdText);
  assert.match(prompt, /未经独立核实/);
  assert.match(prompt, /未提及不等于不会/);
  assert.match(prompt, /待确认/);
  assert.match(prompt, /不能断言用户不会/);
  assert.match(prompt, /不是能力认证或录用概率/);
  assert.doesNotMatch(prompt, /已通过事实库校验/);
});
