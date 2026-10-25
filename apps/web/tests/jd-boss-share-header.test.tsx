import assert from "node:assert/strict";
import test from "node:test";
import { extractPublicJobHtml } from "../server/jd-extractor.ts";
import { parseJobTextHeuristics } from "../src/lib/jd-link-parser.ts";

const mobile = "https://m.zhipin.com/mpa/html/weijd/weijd-job/syntheticShareJob?date8=20261021&openWeapp=1&fromSource=2";
const description = "岗位职责：负责设备通信服务开发与维护，参与需求分析和项目交付。任职要求：熟悉 C#、SQL Server 与面向对象设计，具备三年以上应用开发经验。";
const validated = { requireVisibleDescription: true, allowValidatedBossShareDescription: true } as const;

const sharePage = (header = true) => `<title>BOSS直聘</title><div class="share-position body-bg"><div class="boss-info">
  <div class="boss-message"><h2 class="name"><p>合成招聘者</p></h2><div class="info-labels"><span>HRBP · 合成品牌</span></div></div>
  <div class="rec-position">
    ${header ? `<div class="job-cotent"><h2><p>c# 软件开发工程师</p><span class="job-brandComInfo">合成品牌 不需要融资</span><span>上海·3-5年·本科</span></h2><div>12-20K·13薪</div></div>` : ""}
    <div class="content"><div class="text"><h3 class="title">职位详情</h3></div></div>
    <div class="rec-detail"><div class="detail-text show-switch">${description}</div></div>
    <div class="content"><div class="text"><h3 class="title">工作地点</h3></div><p class="detail-text address">上海静安区合成大厦1栋1楼</p></div>
    <div class="content"><div class="brandComInfo"><div class="brandComBaseInfo"><span>合成技术（上海）有限公司</span><p>不需要融资·1000-9999人</p></div></div></div>
  </div></div>
  <div class="reqular-box"><ul class="postion-list"><li><a><h4><span class="salary">25-40K·13薪</span></h4></a></li></ul></div>
</div>`;

test("BOSS移动分享页从可见头部读取职位、公司、薪资和工作地点，而不是用文档标题“BOSS直聘”", () => {
  const result = extractPublicJobHtml(sharePage(), "BOSS直聘", mobile, validated);
  assert.equal(result.title, "c# 软件开发工程师");
  assert.match(result.text, /^c# 软件开发工程师\n合成技术（上海）有限公司\n12-20K·13薪 · 上海·3-5年·本科\n工作地点：上海静安区合成大厦1栋1楼\n\n职位描述\n/);
  assert.ok(result.text.includes(description));
  assert.ok(!result.text.includes("25-40K"), "其他职位列表的薪资不能混入");

  const parsed = parseJobTextHeuristics(mobile, result.text, { kind: "link", platform: "BOSS直聘", url: mobile, observedAt: "2026-10-21T14:00:00Z", title: result.title });
  assert.equal(parsed.title, "c# 软件开发工程师");
  assert.equal(parsed.company, "合成技术（上海）有限公司");
  assert.equal(parsed.salary, "12-20K·13薪");
  assert.equal(parsed.location, "上海静安区合成大厦1栋1楼");
});

test("没有可见岗位头部时保持原有输出", () => {
  const result = extractPublicJobHtml(sharePage(false), "BOSS直聘", mobile, validated);
  assert.equal(result.title, "BOSS直聘");
  assert.ok(result.text.startsWith("BOSS直聘\n\n"));
});
