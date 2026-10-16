import test from "node:test";
import assert from "node:assert/strict";
import {
  parseResumeHeuristically,
  parseResumeHeuristicallyWithDiagnostics,
  parseResumeWithAi,
  parseResumeWithVisionAi,
} from "../dist/ai/resume-parser.js";

const config = {
  provider: "custom", baseUrl: "https://model.invalid/v1", apiKey: "test-only",
  model: "test", temperature: 0.3,
};
const work = (lines) => `姓名：李明\n工作经历\n2021.01 - 2024.12 示例公司 | 软件工程师\n${lines.join("\n")}`;
function aiFact() {
  return {
    schemaVersion: 1, updatedAt: "2026-10-16T00:00:00.000Z",
    profile: { displayName: { zh: "李明" }, links: [], traits: [], targetRoles: [], constraints: [] },
    experiences: [{
      id: "exp-1", type: "work", org: { zh: "示例公司" }, title: { zh: "软件工程师" },
      start: "2021-01", end: "2024-12", techStack: [], claims: [],
    }],
  };
}
function respond(t, fact) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: typeof fact === "string" ? fact : JSON.stringify(fact) } }] }));
  });
  return requests;
}

test("offline imports real metrics as unconfirmed and preserves all original numbers", () => {
  const result = parseResumeHeuristically(work([
    "- 延迟降低 37.5%", "- 处理 1,250 条消息", "- 响应时间达到 80ms", "- 从80ms降至20ms",
  ]));
  const claims = result.experiences[0].claims;
  assert.deepEqual(claims.map((c) => c.metric), [
    { value: 37.5, unit: "%", confirmed: false },
    { value: 1250, unit: "条", confirmed: false },
    { value: 80, unit: "ms", confirmed: false },
    { value: 80, unit: "ms", confirmed: false },
  ]);
  assert.equal(claims[3].text.zh, "从80ms降至20ms");
});

test("years, versions and framework names do not become metrics", () => {
  const claims = parseResumeHeuristically(work([
    "使用 React 18 和 Node.js 20", "在 2024 年升级 v1.2.3", "负责 K8s 集群迁移",
  ])).experiences[0].claims;
  assert.ok(claims.every((c) => c.kind === "action" && c.metric === undefined));
});

test("offline diagnostics retain long and short lines, all traits, raw source and unknown sections", () => {
  const source = `${work(Array.from({ length: 15 }, (_, i) => `要点${i}`))}\n项目经历\n缺少日期的项目内容\n专业技能\n${Array.from({ length: 12 }, (_, i) => `${i}：${"技能说明".repeat(35)}`).join("\n")}`;
  const result = parseResumeHeuristicallyWithDiagnostics(source);
  assert.equal(result.rawText, source);
  assert.equal(result.factBase.experiences[0].claims.length, 15);
  assert.equal(result.factBase.profile.traits.length, 12);
  assert.ok(result.unparsedLines.includes("缺少日期的项目内容"));
  assert.ok(result.warnings.some((warning) => warning.includes("未结构化")));
  assert.equal(result.factBase.profile.headline, undefined);
  assert.deepEqual(result.factBase.profile.targetRoles, []);
});

test("offline parser never fabricates an experience, date or job title", () => {
  for (const source of [
    "", "李明\n负责系统开发", "工作经历\n示例公司 软件工程师\n开发平台",
    "工作经历\n2021.01 - 2023.01 示例公司\n负责开发",
    "工作经历\n2021.01 示例公司 软件工程师\n负责开发",
    "工作经历\n2021.13 - 2023.01 示例公司 软件工程师\n负责开发",
  ]) assert.throws(() => parseResumeHeuristically(source));
});

test("an incomplete second job stays unparsed rather than attaching to the first", () => {
  const result = parseResumeHeuristicallyWithDiagnostics(`${work(["第一段行动"])}\n2025.01 第二公司\n第二段行动`);
  assert.equal(result.factBase.experiences.length, 1);
  assert.equal(result.factBase.experiences[0].claims.length, 1);
  assert.deepEqual(result.unparsedLines, ["2025.01 第二公司", "第二段行动"]);
});

test("explicit present dates, English organizations and globally unique claim IDs survive", () => {
  const source = "姓名：李明\n工作经历\n2021.1 至今 Acme Corporation | Senior Engineer\n行动甲\n项目经历\n2022.01 - 2023.02 My Project | Technical Lead\n行动乙";
  const result = parseResumeHeuristically(source);
  assert.equal(result.experiences[0].org.zh, "Acme Corporation");
  assert.equal(result.experiences[0].title.zh, "Senior Engineer");
  assert.equal(result.experiences[0].end, null);
  const ids = result.experiences.flatMap((exp) => exp.claims.map((c) => c.id));
  assert.equal(new Set(ids).size, ids.length);
});

test("AI sees the entire long input and cannot grant confirmation", async (t) => {
  const fact = aiFact();
  fact.profile.avatarBbox = null;
  fact.profile.avatarUrl = "https://untrusted.invalid/photo.jpg";
  fact.experiences[0].claims = [{
    id: "c-1", kind: "metric", text: { zh: "延迟降低37.5%" }, tags: [],
    metric: { value: 37.5, unit: "%", confirmed: true },
  }];
  const requests = respond(t, fact);
  const source = "简历正文".repeat(6000) + "正文最后一个项目";
  const result = await parseResumeWithAi(config, source);
  assert.ok(requests[0].messages[1].content.endsWith(source));
  assert.equal(result.experiences[0].claims[0].metric.confirmed, false);
  assert.equal(result.profile.avatarBbox, undefined);
  assert.equal(result.profile.avatarUrl, undefined);
});

test("AI action containing an explicit metric is also held for confirmation", async (t) => {
  const fact = aiFact();
  fact.experiences[0].claims = [{ id: "c-1", kind: "action", text: { zh: "优化响应到80ms" }, tags: [] }];
  respond(t, fact);
  const result = await parseResumeWithAi(config, "优化响应到80ms");
  assert.deepEqual(result.experiences[0].claims[0].metric, { value: 80, unit: "ms", confirmed: false });
});

test("bad JSON or unparsed AI content is an explicit failure without fallback", async (t) => {
  const mock = respond(t, "not-json");
  await assert.rejects(parseResumeWithAi(config, work(["行动"])), /不是有效 JSON/);
  assert.equal(mock.length, 1);
});

test("AI cannot quietly discard unparsed content", async (t) => {
  const fact = aiFact();
  fact.unparsedLines = ["缺少日期的项目"];
  respond(t, fact);
  await assert.rejects(parseResumeWithAi(config, "原文"), /未能结构化/);
});

test("AI invalid month and reversed dates cannot become valid facts", async (t) => {
  const fact = aiFact();
  fact.experiences[0].start = "2021-13";
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(fact) } }],
  })));
  await assert.rejects(parseResumeWithAi(config, "原文"), /日期无效/);
  fact.experiences[0].start = "2025-01";
  await assert.rejects(parseResumeWithAi(config, "原文"), /日期无效/);
  assert.equal(fetchMock.mock.callCount(), 2);
});

test("AI duplicate IDs fail and only caller-supplied avatar URLs are retained", async (t) => {
  const fact = aiFact();
  fact.experiences.push({ ...fact.experiences[0] });
  respond(t, fact);
  await assert.rejects(parseResumeWithAi(config, "原文"), /重复经历 ID/);
});

test("a caller-supplied local avatar and null vision coordinates remain compatible", async (t) => {
  const fact = aiFact();
  fact.profile.avatarBbox = null;
  respond(t, fact);
  const result = await parseResumeWithVisionAi(config, ["page"], "", "data:image/png;base64,local");
  assert.equal(result.profile.avatarUrl, "data:image/png;base64,local");
  assert.equal(result.profile.avatarBbox, undefined);
});

test("vision sends all pages, the full schema and auxiliary text", async (t) => {
  const fact = aiFact();
  fact.profile.avatarBbox = [40, 720, 220, 910];
  const requests = respond(t, fact);
  const pages = Array.from({ length: 7 }, (_, i) => `data:image/jpeg;base64,page-${i}`);
  const result = await parseResumeWithVisionAi(config, pages, "辅助正文末尾");
  const content = requests[0].messages[1].content;
  assert.equal(content.filter((part) => part.type === "image_url").length, 7);
  assert.ok(content[0].text.includes("辅助正文末尾"));
  assert.ok(requests[0].messages[0].content.includes("experiences"));
  assert.deepEqual(result.profile.avatarBbox, [40, 720, 220, 910]);
});

test("vision rejects invalid boxes and request errors instead of inventing a scan resume", async (t) => {
  const fact = aiFact();
  fact.profile.avatarBbox = [900, 200, 40, 1001];
  respond(t, fact);
  await assert.rejects(parseResumeWithVisionAi(config, ["page"]), /头像坐标无效/);
});

test("transport failure remains visible for the user to choose a retry or offline mode", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("model unreachable"); });
  await assert.rejects(parseResumeWithAi(config, work(["行动"])), /model unreachable/);
  await assert.rejects(parseResumeWithVisionAi(config, ["page"], work(["行动"])), /未自动生成离线简历/);
});
