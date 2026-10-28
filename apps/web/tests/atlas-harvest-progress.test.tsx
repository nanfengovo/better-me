import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AtlasHarvestProgress } from "../src/components/atlas/AtlasHarvestProgress";
import { mergeLiveCommitTotals, toHarvestProgressState, type HarvestProgressState } from "../src/components/atlas/harvest-progress-presentation";

Object.assign(globalThis, { React });

const stage: HarvestProgressState = {
  stage: "platform-harvest",
  stageIndex: 2,
  totalStages: 5,
  message: "正在实时检索技术词 2/4：.NET",
  stats: {
    queryTermIndex: 2,
    queryTermTotal: 4,
    queryTerm: ".NET",
    queryTermStatus: "running",
    completedQueryTerms: 1,
    failedQueryTerms: 1,
    cardsFetched: 38,
  },
};

test("an idle scope preparation does not masquerade as an ended harvest", () => {
  const progress: HarvestProgressState = { stage: "intent-expansion", stageIndex: 1, totalStages: 5, message: "准备本轮实时搜索请求" };
  const props = { progress, busy: false };
  assert.equal(renderToStaticMarkup(createElement(AtlasHarvestProgress, props)), "");
  assert.match(renderToStaticMarkup(createElement(AtlasHarvestProgress, { ...props, busy: true })), /data-state="running"/);
  assert.match(renderToStaticMarkup(createElement(AtlasHarvestProgress, { ...props, failed: true })), /data-state="attention"/);
  assert.match(renderToStaticMarkup(createElement(AtlasHarvestProgress, { ...props, cancelled: true })), /data-state="stopped"/);
});

test("source progress preserves confirmed commit counters from the same run without retaining prior query errors", () => {
  const previous: HarvestProgressState = { ...stage, stage: "cas-ingestion", stageIndex: 3, stats: {
    committedCards: 12, pendingCards: 5, pendingBatches: 1, failedCards: 2, cancelledCards: 0,
    totalAdded: 8, totalUpdated: 3, totalUnchanged: 1,
    queryTerm: "Java", queryTermIndex: 1, queryTermError: "old query failed", queryTermStatus: "failed",
  } };
  const next = toHarvestProgressState({ ...stage, stats: { queryTermIndex: 2, queryTermTotal: 3, queryTerm: "Kotlin", queryTermStatus: "running", cardsFetched: 20 } }, previous);
  assert.equal(next.stats?.committedCards, 12);
  assert.equal(next.stats?.pendingCards, 5);
  assert.equal(next.stats?.totalAdded, 8);
  assert.equal(next.stats?.totalUnchanged, 1);
  assert.equal(next.stats?.queryTerm, "Kotlin");
  assert.equal(next.stats?.queryTermError, undefined);
  assert.equal(previous.stats?.queryTermError, "old query failed", "the previous state remains immutable");
});

test("new queue gauges replace previous values including zero, while a new run discards prior counters", () => {
  const previous: HarvestProgressState = { ...stage, stats: { committedCards: 12, pendingCards: 5, pendingBatches: 1, failedCards: 2 } };
  const drained = toHarvestProgressState({ ...stage, stage: "cas-ingestion", stageIndex: 3, stats: { committedCards: 17, pendingCards: 0, pendingBatches: 0 } }, previous);
  assert.equal(drained.stats?.pendingCards, 0);
  assert.equal(drained.stats?.committedCards, 17);
  assert.equal(drained.stats?.failedCards, 2);
  const restarted = toHarvestProgressState({ stage: "intent-expansion", stageIndex: 1, totalStages: 5, message: "new run" }, drained);
  assert.equal(restarted.stats, undefined);
});

test("older snapshot totals cannot replace newer receipt totals, and an undefined previous state starts a new run", () => {
  const previous = { totalAdded: 8, totalUpdated: 9 };
  assert.deepEqual(mergeLiveCommitTotals(previous, { totalAdded: 3, totalUpdated: 4 }), previous);
  assert.deepEqual(mergeLiveCommitTotals(previous, { totalAdded: 10, totalUpdated: 7 }), { totalAdded: 10, totalUpdated: 9 });
  assert.deepEqual(previous, { totalAdded: 8, totalUpdated: 9 });
  assert.deepEqual(mergeLiveCommitTotals(undefined, { totalAdded: 3, totalUpdated: 4 }), { totalAdded: 3, totalUpdated: 4 });
});

test("harvest progress communicates pipeline stages and measured query/card counts without a fake percentage", () => {
  const markup = renderToStaticMarkup(createElement(AtlasHarvestProgress, { progress: stage, busy: true }));

  assert.match(markup, /正在读取招聘平台原站页面/);
  assert.match(markup, /原站采集/);
  assert.match(markup, /data-state="current"/);
  assert.match(markup, /<dt>检索词<\/dt><dd>2 \/ 4：\.NET<\/dd>/);
  assert.match(markup, /<dt>失败检索词<\/dt><dd>1<\/dd>/);
  assert.match(markup, /<dt>已抓取卡片<\/dt><dd>38<\/dd>/);
  assert.doesNotMatch(markup, /role="progressbar"/);
  assert.doesNotMatch(markup, /%/);
});

test("commit progress reports saving without claiming concurrent source collection has ended", () => {
  const markup = renderToStaticMarkup(createElement(AtlasHarvestProgress, {
    progress: { ...stage, stage: "cas-ingestion", stageIndex: 3, message: "已提交新增 12 岗，更新 7 岗", stats: { totalAdded: 12, totalUpdated: 7 } },
    busy: true,
  }));

  assert.match(markup, /正在保存已核验岗位/);
  assert.doesNotMatch(markup, /平台页面读取已结束/);
  assert.match(markup, /<dt>新增入库<\/dt><dd>12<\/dd>/);
  assert.match(markup, /<dt>更新入库<\/dt><dd>7<\/dd>/);
  assert.match(markup, /原站采集/);
  assert.match(markup, /data-state="complete"/);
  assert.match(markup, /data-state="current"/);
});

test("compact task bar keeps discovered, receipt-confirmed and queued cards distinct with details collapsed", () => {
  const markup = renderToStaticMarkup(createElement(AtlasHarvestProgress, {
    progress: { ...stage, stage: "cas-ingestion", stageIndex: 3, stats: {
      cardsFetched: 30, committedCards: 23, pendingCards: 4, failedCards: 2,
      totalAdded: 12, totalUpdated: 7, totalUnchanged: 3,
    } },
    busy: true,
    discoveredCards: 38,
  }));
  const compactBar = markup.slice(0, markup.indexOf("<details"));
  assert.match(compactBar, /<dt>发现<\/dt><dd>38<\/dd>/);
  assert.match(compactBar, /<dt>已保存<\/dt><dd>23<\/dd>/);
  assert.match(compactBar, /<dt>待处理<\/dt><dd>4<\/dd>/);
  assert.match(markup, /<details class="atlas-harvest-progress-details">/);
  assert.doesNotMatch(markup, /<details[^>]+open/);
  assert.match(markup, /<dt>未变入库<\/dt><dd>3<\/dd>/);
  assert.match(markup, /<dt>失败 \/ 未确认<\/dt><dd>2<\/dd>/);
  assert.match(markup, /data-state="current"[^>]*>.*?原站采集/);
});

test("missing save and queue receipts remain unknown instead of inferred from discovered cards", () => {
  const markup = renderToStaticMarkup(createElement(AtlasHarvestProgress, { progress: stage, busy: true }));
  assert.match(markup, /<dt>已保存<\/dt><dd>—<\/dd>/);
  assert.match(markup, /<dt>待处理<\/dt><dd>—<\/dd>/);
});

test("cancel state says stop was requested and keeps already received results", () => {
  const markup = renderToStaticMarkup(createElement(AtlasHarvestProgress, { progress: stage, busy: false, cancelled: true }));

  assert.match(markup, /已请求停止/);
  assert.match(markup, /保留本轮已收到的实时岗位和入库结果/);
  assert.doesNotMatch(markup, /仍在读取招聘平台/);
});

test("cancelled queue cards remain visible as unconfirmed rather than disappearing when pending reaches zero", () => {
  const markup = renderToStaticMarkup(createElement(AtlasHarvestProgress, {
    progress: { ...stage, stats: { committedCards: 10, pendingCards: 0, cancelledCards: 2, failedCards: 1 } },
    busy: false,
    cancelled: true,
  }));
  assert.match(markup, /<dt>取消 \/ 未确认<\/dt><dd>2<\/dd>/);
  assert.match(markup, /提交结果仍需核对/);
  assert.match(markup, /不会在刷新后自动恢复/);
});

test("platform failures, verification gates and limited coverage remain distinct after the pipeline ends", () => {
  const markup = renderToStaticMarkup(createElement(AtlasHarvestProgress, {
    progress: { ...stage, stage: "completed", stageIndex: 5, message: "本轮平台读取已结束（部分覆盖）", stats: {
      failedPlatforms: 2, blockedPlatforms: 1, partialPlatforms: 3, totalAdded: 18, totalUpdated: 4,
    } },
    busy: false,
    failed: true,
  }));

  assert.match(markup, /本轮采集未完整完成/);
  assert.match(markup, /平台失败<\/dt><dd>2/);
  assert.match(markup, /需登录 \/ 验证<\/dt><dd>1/);
  assert.match(markup, /部分覆盖平台<\/dt><dd>3/);
  assert.match(markup, /新增入库<\/dt><dd>18/);
  assert.match(markup, /未返回的平台或页面不计作已覆盖/);
  assert.doesNotMatch(markup, /全网抓取完成/);
});

test("completed runs label skipped enrichment as optional without a completed checkmark", () => {
  const markup = renderToStaticMarkup(createElement(AtlasHarvestProgress, {
    progress: { ...stage, stage: "completed", stageIndex: 5, stats: { enrichmentSkipped: 1, committedCards: 12 } },
    busy: false,
  }));
  const steps = [...markup.matchAll(/<li data-state="[^"]+">[\s\S]*?<\/li>/g)].map(match => match[0]);
  assert.match(steps[3] ?? "", /data-state="skipped"/);
  assert.match(steps[3] ?? "", /地区与企业（可补全）/);
  assert.doesNotMatch(steps[3] ?? "", /lucide-check/);
  assert.match(steps[2] ?? "", /data-state="complete"/);
});

test("completed runs that performed enrichment retain the normal completed step", () => {
  const markup = renderToStaticMarkup(createElement(AtlasHarvestProgress, {
    progress: { ...stage, stage: "completed", stageIndex: 5, stats: { committedCards: 12 } },
    busy: false,
  }));
  const steps = [...markup.matchAll(/<li data-state="[^"]+">[\s\S]*?<\/li>/g)].map(match => match[0]);
  assert.match(steps[3] ?? "", /data-state="complete"/);
  assert.match(steps[3] ?? "", /lucide-check/);
  assert.doesNotMatch(steps[3] ?? "", /可补全/);
});

test("server-owned background enrichment is labelled background without a false completion check", () => {
  const markup = renderToStaticMarkup(createElement(AtlasHarvestProgress, {
    progress: { ...stage, stage: "completed", stageIndex: 5, stats: { enrichmentSkipped: 1, enrichmentBackground: 1 } },
    busy: false,
  }));
  const steps = [...markup.matchAll(/<li data-state="[^"]+">[\s\S]*?<\/li>/g)].map(match => match[0]);
  assert.match(steps[3] ?? "", /地区与企业（后台）/);
  assert.match(steps[3] ?? "", /data-state="skipped"/);
  assert.doesNotMatch(steps[3] ?? "", /lucide-check|可补全/);
});
