import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AtlasHarvestProgress } from "../src/components/atlas/AtlasHarvestProgress";
import { AtlasBackgroundEnrichmentStatus } from "../src/components/atlas/AtlasBackgroundEnrichmentStatus";

Object.assign(globalThis, { React });

test("a known failure category is visible and its exact diagnostic remains available in details", () => {
  const markup = renderToStaticMarkup(React.createElement(AtlasHarvestProgress, {
    progress: { stage: "completed", stageIndex: 5, totalStages: 5, message: "采集已结束", stats: {
      queryTermError: "51JOB：页面加载超时", failedPlatforms: 1,
      committedCards: 1122, pendingCards: 0, failedCards: 15,
    } }, busy: false, failed: true, discoveredCards: 1220,
  }));
  const summary = markup.slice(0, markup.indexOf("<details"));
  assert.match(summary, /检索遇到异常/, "the failure category must remain visible");
  assert.match(markup, /51JOB：页面加载超时/, "the exact reported diagnostic must remain accessible");
  assert.doesNotMatch(summary, /读取失败、登录验证拦截或达到采集预算/, "do not guess a bundle of unrelated causes");
});

test("missing failure diagnostics are admitted explicitly instead of guessed", () => {
  const markup = renderToStaticMarkup(React.createElement(AtlasHarvestProgress, {
    progress: { stage: "completed", stageIndex: 5, totalStages: 5, message: "平台读取已结束", stats: { failedPlatforms: 1 } },
    busy: false, failed: true,
  }));
  const summary = markup.slice(0, markup.indexOf("<details"));
  assert.match(summary, /未返回.*原因|原因.*未返回/, "unknown cause needs a truthful and visible fallback");
  assert.doesNotMatch(markup, /本轮有平台读取失败、登录验证拦截或达到采集预算/);
});

test("receipt-confirmed import errors are visible without guessing source failure", () => {
  const markup = renderToStaticMarkup(React.createElement(AtlasHarvestProgress, {
    progress: { stage: "completed", stageIndex: 5, totalStages: 5, message: "平台读取结束", stats: { committedCards: 1122, pendingCards: 0, failedCards: 15 } },
    importFailures: [{ platform: "51JOB", pageUrl: "https://example.invalid", cards: 15, error: "岗位服务响应超时" }],
    providers: [], busy: false, failed: true,
  }));
  const summary = markup.slice(0, markup.indexOf("<details"));
  assert.match(summary, /入库回执尚未确认/);
  assert.match(markup, /岗位服务响应超时/);
  assert.match(summary, /1122/);
  const visibleReasons = [...summary.matchAll(/<p class="atlas-harvest-issue-reason">(.*?)<\/p>/g)].map(match => match[1]).join(" ");
  assert.doesNotMatch(visibleReasons, /验证码|登录验证/);
  assert.match(summary, /不会自动重试平台、登录、处理验证码/, "a safety disclaimer is not a diagnosed failure cause");
  assert.doesNotMatch(markup, /<details[^>]+open/);
});

test("settled counters and background metrics stay available but do not compete with the cause", () => {
  const markup = renderToStaticMarkup(React.createElement(AtlasHarvestProgress, {
    progress: { stage: "completed", stageIndex: 5, totalStages: 5, message: "读取结束", stats: { committedCards: 1122, pendingCards: 0, totalAdded: 2, totalUpdated: 243 } },
    busy: false, discoveredCards: 1220,
  }));
  assert.doesNotMatch(markup.slice(0, markup.indexOf("<details")), /待处理|新增入库|更新入库/);
  assert.match(markup, /新增入库<\/dt><dd>2/);
  assert.match(markup, /更新入库<\/dt><dd>243/);
  const background = renderToStaticMarkup(React.createElement(AtlasBackgroundEnrichmentStatus, { state: { loading: false, refreshingSnapshot: false,
    status: { revision: 4, pending: 0, running: 0, completed: 1633, failed: 0, workerState: "idle" },
  } }));
  assert.match(background, /^<details/);
  assert.doesNotMatch(background, /<details[^>]+open/);
  assert.doesNotMatch(background.slice(0, background.indexOf("</summary>")), /1633|按地区\/企业任务项/);
  assert.match(background, /1633/);
});
