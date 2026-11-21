import assert from "node:assert/strict";
import test from "node:test";
import { checkRewriteFactPreservation, extractNumericClaims } from "../src/validation/rewrite-preservation.js";

test("checkRewriteFactPreservation passes when candidate preserves or reformats equivalent numeric claims", () => {
  const report = checkRewriteFactPreservation({
    sourceText: "Built dispatch console for 1,500 devices, reducing latency by 40 percent (2023-05 ~ 2025-04).",
    candidateText: "Designed event-driven dispatch console serving 1.5k devices and cutting latency by 40% during 2023-05 ~ 2025-04.",
  });
  assert.equal(report.ok, true);
  assert.deepEqual(report.novelNumbers, []);
});

test("checkRewriteFactPreservation normalizes Chinese and English scale units equivalently", () => {
  const report = checkRewriteFactPreservation({
    sourceText: "优化核心检索链路，日均支撑 2万 次请求，吞吐提升 3倍。",
    candidateText: "重构检索服务，稳定承接 20k 日请求并实现 3x 吞吐提升。",
  });
  assert.equal(report.ok, true);
  assert.deepEqual(report.novelNumbers, []);
});

test("checkRewriteFactPreservation flags fabricated metrics introduced by AI rewrites", () => {
  const report = checkRewriteFactPreservation({
    sourceText: "负责订单服务重构与数据库索引优化，提升接口响应速度。",
    candidateText: "主导订单服务重构，将 P99 响应延迟降低 65%，系统可用性达到 99.99%，节约成本 30万。",
  });
  assert.equal(report.ok, false);
  assert.ok(report.novelNumbers.includes("65%"));
  assert.ok(report.novelNumbers.includes("99.99%"));
  assert.ok(report.novelNumbers.includes("30万"));
  assert.equal(report.novelNumbers.includes("99"), false); // P99 is a percentile identifier, not a fabricated count
});

test("checkRewriteFactPreservation ignores version numbers and date ranges without false positives", () => {
  const report = checkRewriteFactPreservation({
    sourceText: "Migrated backend service from legacy stack.",
    candidateText: "Migrated backend service to Node 24, Python 3, React 19, and .NET 8 in Jan 2025.",
  });
  assert.equal(report.ok, true);
  assert.deepEqual(report.novelNumbers, []);
});

test("checkRewriteFactPreservation accepts numbers grounded in additionalFactTexts (user supplement)", () => {
  const report = checkRewriteFactPreservation({
    sourceText: "优化工业调度平台接口性能。",
    additionalFactTexts: ["实测把平均耗时从 420ms 降到 95ms。"],
    candidateText: "重构调度查询链路，将平均接口耗时由 420ms 降至 95ms。",
  });
  assert.equal(report.ok, true);
  assert.deepEqual(report.novelNumbers, []);

  // Still catches an ungrounded extra number even when supplement is present
  const hallucinated = checkRewriteFactPreservation({
    sourceText: "优化工业调度平台接口性能。",
    additionalFactTexts: ["实测把平均耗时从 420ms 降到 95ms。"],
    candidateText: "重构调度查询链路，将平均接口耗时由 420ms 降至 95ms，节省服务器预算 50%。",
  });
  assert.equal(hallucinated.ok, false);
  assert.deepEqual(hallucinated.novelNumbers, ["50%"]);
});

test("extractNumericClaims handles repeated counts so duplicating a metric is detected", () => {
  const claims = extractNumericClaims("Reduced latency by 30% and cost by 30%.");
  assert.equal(claims.length, 2);
  const report = checkRewriteFactPreservation({
    sourceText: "Reduced latency by 30%.",
    candidateText: "Reduced latency by 30% and lowered cloud spend by 30%.",
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.novelNumbers, ["30%"]);
});
