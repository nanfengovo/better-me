import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanPlatformTitle,
  parseJobTextHeuristics,
  extractAndParseJobLink,
  type ParsedJobInfo,
} from "../src/lib/jd-link-parser";

test("cleanPlatformTitle strips platform suffixes and extracts delimiters", () => {
  const cases = [
    {
      input: "资深前端架构师_阿里巴巴招聘-BOSS直聘",
      expectedTitle: "资深前端架构师",
      expectedCompany: "阿里巴巴",
    },
    {
      input: "【北京】高级算法专家_字节跳动招聘_猎聘",
      expectedTitle: "高级算法专家",
      expectedCompany: "字节跳动",
      expectedLocation: "北京",
    },
    {
      input: "全栈工程师 - 腾讯科技 - 51JOB",
      expectedTitle: "全栈工程师",
      expectedCompany: "腾讯科技",
    },
    {
      input: "【某知名外资企业】招聘 技术总监",
      expectedTitle: "技术总监",
      expectedCompany: "某知名外资企业",
    },
  ];

  for (const c of cases) {
    const res = cleanPlatformTitle(c.input);
    assert.equal(res.title, c.expectedTitle);
    if (c.expectedCompany) {
      assert.equal(res.company, c.expectedCompany);
    }
    if (c.expectedLocation) {
      assert.equal(res.location, c.expectedLocation);
    }
  }
});

test("parseJobTextHeuristics extracts title, company, salary, location from structured text", () => {
  const sampleText = `资深前端开发专家

某互联网高科技集团

薪资范围：35k-50k · 16薪
工作地点：上海 · 浦东新区

岗位职责：
1. 负责微前端平台搭建与核心框架研发；
2. 优化首屏加载与性能指标。

任职要求：
1. 本科以上，5年以上相关经验；
2. 熟练掌握 React、TypeScript。`;

  const res = parseJobTextHeuristics(
    "",
    sampleText,
    {
      kind: "link",
      observedAt: new Date().toISOString(),
      url: "https://www.zhipin.com/job_detail/123.html",
      platform: "BOSS直聘",
    }
  );

  assert.equal(res.title, "资深前端开发专家");
  assert.equal(res.company, "某互联网高科技集团");
  assert.equal(res.salary, "35k-50k · 16薪");
  assert.ok(res.location.includes("上海"));
  assert.ok(res.description.includes("微前端"));
  assert.equal(res.sourcePlatform, "BOSS直聘");
});

test("parseJobTextHeuristics extracts from mobile share text", () => {
  const shareText = `【杭州·架构师】某头部电商科技公司诚聘全栈架构师！40k-60k·16薪，负责核心交易中台建设：https://www.zhipin.com/job_detail/abc.html`;

  const res = parseJobTextHeuristics(
    shareText,
    shareText,
    null
  );

  assert.ok(res.company.includes("电商科技公司") || res.company.includes("头部"));
  assert.ok(res.salary.includes("40k-60k"));
  assert.ok(res.location.includes("杭州"));
});

test("extractAndParseJobLink parses fallback share text without calling remote service if plain text", async () => {
  const shareText = `【北京】资深工程经理 某智能硬件科技有限公司
薪资：50k-70k · 14薪
工作地点：北京海淀区
岗位职责：主导机器人嵌入式研发`;

  const res = await extractAndParseJobLink(shareText, {
    signal: new AbortController().signal,
  });

  assert.equal(res.title, "资深工程经理");
  assert.ok(res.company.includes("智能硬件科技有限公司"));
  assert.ok(res.salary.includes("50k-70k"));
  assert.ok(res.location.includes("北京"));
});
