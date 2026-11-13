import assert from "node:assert/strict";
import test from "node:test";
import { parseWritingReply, type WritingSource } from "../src/lib/resume-copilot";

function propose(original: string, answer: string, quotes: string[], candidate: string) {
  const source: WritingSource = { targetRef: { kind: "claim_text", experienceId: "synthetic", claimId: "test", locale: "zh" }, text: original, label: "Synthetic check" };
  return parseWritingReply(JSON.stringify({ questions: [], rationale: "synthetic", evidenceQuotes: quotes, proposedText: candidate }), source, answer).proposedText;
}
const reviewed = "我负责校验记录。";

test("a quoted quantity must cover a whole source token, not a suffix or two stitched clips", () => {
  const original = "实测平均延迟降低了１５％。";
  assert.throws(() => propose(original, reviewed, ["５％"], "延迟降低了5%。"), /数字/);
  assert.throws(() => propose(original, reviewed, ["１", "５％"], "延迟降低了15%。"), /数字/);
  assert.equal(propose(original, reviewed, ["１５％"], "延迟降低了15%。"), "延迟降低了15%。");
  assert.throws(() => propose("记录为15台；5台是另一组数据。", reviewed, ["为15台"], "记录为5台。"), /数字/);
  assert.equal(propose("两批分别为15台、5台。", reviewed, ["5台"], "第二批为5台。"), "第二批为5台。");
});

test("common English and Chinese durations, magnitude and count units do not authorize one another", () => {
  for (const [supported, invented] of [["6 months", "6 million invoices"], ["6 months", "6 years"], ["6 万台", "6 万人"], ["20 milliseconds", "20 seconds"], ["10 users", "10 orders"]]) {
    assert.throws(() => propose(supported!, reviewed, [supported!], invented!), /数字/);
  }
  assert.equal(propose("Median was 20 milliseconds.", reviewed, ["20 milliseconds"], "中位耗时20ms。"), "中位耗时20ms。");
  assert.equal(propose("共处理1,200条记录。", reviewed, ["1,200条"], "处理1200条记录。"), "处理1200条记录。");
});

test("a cited team lead or launch is not proof of individual ownership, including a cropped verb", () => {
  const original = "团队主导上线，我只负责接口联调。";
  for (const q of ["团队主导上线", "主导上线"]) assert.equal(propose(original, reviewed, [q], "我主导上线。"), undefined);
  assert.equal(propose(original, reviewed, ["团队主导上线", "我只负责接口联调"], "团队主导上线；我只负责接口联调。"), "团队主导上线；我只负责接口联调。");
  assert.equal(propose("The team led the migration.", "I checked the logs.", ["led the migration"], "I led the migration."), undefined);
  assert.equal(propose("我牵头接口联调。", reviewed, ["我牵头接口联调"], "主导接口联调。"), "主导接口联调。");
  assert.equal(propose("我牵头接口联调。", reviewed, ["我牵头接口联调"], "独立完成接口联调。"), undefined);
});

test("unknown, negative and confirmed release stages remain distinct; punctuation does not erase reservations", () => {
  for (const original of ["是否上线尚不清楚。", "项目上线状态待确认。", "尚未上线。"]) {
    assert.equal(propose(original, reviewed, ["上线"], "项目已上线。"), undefined);
  }
  assert.equal(propose("上线情况未知。", reviewed, ["上线情况未知"], "尚未上线。"), undefined);
  assert.equal(propose("I don't know whether it went live.", reviewed, ["went live"], "It went live."), undefined);
  assert.equal(propose("团队计划上线。", reviewed, ["上线"], "团队已按计划上线。"), undefined);
  assert.equal(propose("我按既定计划上线。", reviewed, ["上线"], "我已上线。"), "我已上线。");
  assert.equal(propose("我已经上线了该模块。", reviewed, ["上线了该模块"], "将该模块上线。"), "将该模块上线。");
});

test("a design-only boundary permits faithfully stated uncertainty or a supported negative, not an implementation", () => {
  const onlyDesign = "个人贡献口径：设计方案，未声明已实现或上线。";
  const original = "设计了重试接口。";
  assert.equal(propose(original, onlyDesign, [original], "实现并上线重试接口。"), undefined);
  assert.equal(propose(original, onlyDesign, [original], "The retry API runs in production."), undefined);
  assert.equal(propose(original, onlyDesign, [original], "设计重试接口，尚未上线。"), undefined, "the design marker alone is not a verified negative");
  assert.equal(propose(original, onlyDesign + "模块尚未上线。", [original, "尚未上线"], "设计重试接口，尚未上线。"), "设计重试接口，尚未上线。");
  assert.equal(propose(original, onlyDesign, [original], "设计重试接口，上线情况待确认。"), "设计重试接口，上线情况待确认。");
  assert.equal(propose(original, onlyDesign + "我仅设计了上线方案。", ["我仅设计了上线方案"], "设计上线方案。"), "设计上线方案。");
});
