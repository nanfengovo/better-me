import assert from "node:assert/strict";
import test from "node:test";
import { createDemoFactBase, scanClaim, type ClaimIssue } from "@better-me/core";
import { createIssueNavigation } from "../src/lib/issue-navigation";

test("问题定位用经历和要点的完整ID，不修改事实或核实状态", () => {
  const base = createDemoFactBase();
  const experience = base.experiences[0]!;
  const claim = experience.claims.find((item) => item.metric)!;
  experience.id = '经历:带"引号]';
  claim.id = 'claim:带"引号]';
  claim.metric!.confirmed = false;
  const issue = scanClaim(claim, experience.id).find((item) => item.code === "metric_unconfirmed")!;
  const original = structuredClone(base);
  const first = createIssueNavigation(base, issue, 1)!;
  const repeated = createIssueNavigation(base, issue, 2)!;
  assert.equal(first.field, "confirmation");
  assert.equal(first.issue.experienceId, experience.id);
  assert.equal(first.issue.claimId, claim.id);
  assert.notEqual(first.requestId, repeated.requestId);
  assert.deepEqual(base, original);
  assert.equal(createIssueNavigation(base, { ...issue, experienceId: "其他经历" }, 3), undefined);
  experience.claims = experience.claims.filter((item) => item.id !== claim.id);
  assert.equal(createIssueNavigation(base, issue, 4), undefined);
});

test("英文空洞措辞定位英文，已有具体中文内容不会被误选", () => {
  const base = createDemoFactBase();
  const experience = base.experiences[0]!;
  const claim = experience.claims[0]!;
  claim.text = { zh: "实现任务队列状态校验并交付回归用例", en: "Responsible for various tasks" };
  const issue = scanClaim(claim, experience.id).find((item) => item.code === "hollow_phrase")!;
  assert.equal(createIssueNavigation(base, issue, 1)?.field, "text-en");
  claim.text.zh = "负责相关工作";
  assert.equal(createIssueNavigation(base, issue, 2)?.field, "text-zh");
});

test("不完整量化草稿先定位可编辑数值或单位，不聚焦禁用核实框", () => {
  const base = createDemoFactBase();
  const experience = base.experiences[0]!;
  const claim = experience.claims.find((item) => item.metric)!;
  const issue: ClaimIssue = { claimId: claim.id, experienceId: experience.id, code: "metric_unconfirmed", message: "待核实" };
  claim.metric!.confirmed = false;
  claim.metric!.value = Number.NaN;
  assert.equal(createIssueNavigation(base, issue, 1)?.field, "value");
  claim.metric!.value = 60;
  claim.metric!.unit = " ";
  assert.equal(createIssueNavigation(base, issue, 2)?.field, "unit");
  claim.metric!.unit = "%";
  assert.equal(createIssueNavigation(base, issue, 3)?.field, "confirmation");
  assert.equal(claim.metric!.confirmed, false);
});

test("补比较依据或因果说明会清除对应提醒，核实仍由用户另行确认", () => {
  const base = createDemoFactBase();
  const experience = base.experiences[0]!;
  const claim = experience.claims.find((item) => item.metric)!;
  claim.metric = { value: 60, unit: "%", confirmed: false };
  const issue = scanClaim(claim, experience.id).find((item) => item.code === "metric_missing_baseline")!;
  assert.equal(createIssueNavigation(base, issue, 1)?.field, "baseline");
  claim.metric.causal = "依据相同负载回放记录核对缓存改造前后延迟，已保留测量记录";
  const remaining = scanClaim(claim, experience.id);
  assert.equal(remaining.some((item) => item.code === "metric_missing_baseline"), false);
  assert.equal(remaining.some((item) => item.code === "metric_unconfirmed"), true);
});
