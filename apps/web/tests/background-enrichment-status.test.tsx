import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AtlasBackgroundEnrichmentStatus } from "../src/components/atlas/AtlasBackgroundEnrichmentStatus";
import type { BackgroundEnrichmentState } from "../src/components/atlas/use-background-enrichment";

Object.assign(globalThis, { React });
const render = (state: BackgroundEnrichmentState) => renderToStaticMarkup(React.createElement(AtlasBackgroundEnrichmentStatus, { state }));

test("background status shows task counts separately and never claims generated coordinates", () => {
  const markup = render({ loading: false, refreshingSnapshot: false,
    status: { revision: 4, pending: 2, running: 1, completed: 7, failed: 3, workerState: "running" },
  });
  assert.match(markup, /地区\/企业后台补全/);
  assert.match(markup, /待处理<\/dt><dd>3/);
  assert.match(markup, /已完成<\/dt><dd>7/);
  assert.match(markup, /异常<\/dt><dd>3/);
  assert.match(markup, /任务项，不是岗位总数/);
  assert.match(markup, /无来源真实坐标，不生成办公点/);
  assert.doesNotMatch(markup, /<button|animation|spinner/);
});

test("unknown loading counts are not fabricated and disabled state has no panel", () => {
  assert.equal(render({ loading: false, refreshingSnapshot: false }), "");
  const markup = render({ loading: true, refreshingSnapshot: false });
  assert.match(markup, /正在读取后台状态/);
  assert.doesNotMatch(markup, /<dd>0/);
});

test("worker and refresh failures retain confirmed counters but never echo raw worker diagnostics", () => {
  const markup = render({ loading: false, refreshingSnapshot: false, error: "连接暂不可用，将自动重试。",
    status: { revision: 4, pending: 2, running: 0, completed: 7, failed: 3, workerState: "error", workerError: "/private/local-database" },
  });
  assert.match(markup, /最近一次状态/);
  assert.match(markup, /连接暂不可用，将自动重试/);
  assert.match(markup, /已完成<\/dt><dd>7/);
  assert.doesNotMatch(markup, /private|local-database/);
});

test("exhausted failures are attention items, not promises that every task will automatically retry", () => {
  const state: BackgroundEnrichmentState = { loading: false, refreshingSnapshot: false,
    status: { revision: 4, pending: 0, running: 0, completed: 7, failed: 3, workerState: "idle" } };
  const exhausted = render(state);
  assert.match(exhausted, /异常<\/dt><dd>3/);
  assert.match(exhausted, /有异常任务需关注/);
  assert.doesNotMatch(exhausted, /自动重试|待重试/);
  const scheduled = render({ ...state, status: { ...state.status!, nextRetryAt: "2026-10-28T00:00:00Z" } });
  assert.match(scheduled, /部分任务等待自动重试/);
});
