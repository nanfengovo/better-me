import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AtlasActivityRail } from "../src/components/atlas/AtlasActivityRail";
import { AtlasViewControls } from "../src/components/atlas/AtlasViewControls";

Object.assign(globalThis, { React });

test("parallel activity lanes keep unknown, pending, source cards and mapped jobs distinct", () => {
  const markup = renderToStaticMarkup(React.createElement(AtlasActivityRail, {
    index: { state: "working", value: 64, detail: "已读 64 / 5000 · 可先浏览" },
    collection: { state: "working", value: 127, detail: "边采集边入库 · 可继续搜索" },
    enrichment: { state: "idle", detail: "连接后自动跟随入库" },
    map: { state: "ready", value: 16, detail: "仅展示来源真实坐标" },
  }));
  assert.equal((markup.match(/data-lane=/g) ?? []).length, 4);
  assert.match(markup, /<strong>64<\/strong>/);
  assert.match(markup, /<strong>127<\/strong><span>张卡片/);
  assert.match(markup, /<strong>—<\/strong>/);
  assert.match(markup, /<strong>16<\/strong><span>岗/);
  assert.doesNotMatch(markup, /progressbar|aria-live|\d+%|已完成.*127/);
});

test("attention and stopped states keep confirmed values rather than fabricate all-green completion", () => {
  const markup = renderToStaticMarkup(React.createElement(AtlasActivityRail, {
    index: { state: "ready", value: 5000, detail: "已收录，可即时筛选" },
    collection: { state: "attention", value: 90, detail: "部分未完成 · 查看采集详情" },
    enrichment: { state: "attention", value: 3, detail: "后台已停 · 任务保留" },
    map: { state: "attention", value: 1250, detail: "地图暂不可用 · 列表仍可用" },
  }));
  assert.equal((markup.match(/data-state="attention"/g) ?? []).length, 3);
  assert.match(markup, /5,000/);
  assert.match(markup, /部分未完成/);
  assert.match(markup, /任务保留/);
  assert.match(markup, /列表仍可用/);
});

test("view controls expose an exclusive pressed state and do not request animation for keyboard clicks", () => {
  const changes: unknown[] = [];
  const view = AtlasViewControls({ value: "spatial", onChange: (...args) => changes.push(args) });
  const buttons = React.Children.toArray(view.props.children) as React.ReactElement<{ "aria-pressed": boolean; onClick: (event: { detail: number }) => void }>[];
  assert.deepEqual(buttons.map(button => button.props["aria-pressed"]), [false, true]);
  buttons[0]!.props.onClick({ detail: 0 });
  buttons[1]!.props.onClick({ detail: 1 });
  assert.deepEqual(changes, [["flat", false], ["spatial", true]]);
  const markup = renderToStaticMarkup(view);
  assert.match(markup, /aria-label="地图呈现方式"/);
  assert.match(markup, /平面视角 2D/);
  assert.match(markup, /空间视角 3D/);
});

test("experience motion is scoped, interruptible, reduced-motion aware and keeps high-frequency targets still", () => {
  const css = readFileSync(new URL("../src/components/atlas/atlas-experience.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /transition:\s*all|@keyframes|animation:[^;]*infinite|will-change|backdrop-filter/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /hover:\s*hover.*pointer:\s*fine/);
  assert.match(css, /button:focus-visible/);
  assert.match(css, /outline: 2px solid var\(--color-accent\) !important/);
  assert.match(css, /\.atlas-experience button:active \{ transform: none/);
  assert.match(css, /\.atlas-experience \[hidden\] \{ display: none !important/);
  assert.match(css, /transform: scale\(\.98\)/);
  assert.match(css, /\.atlas-experience \.atlas-quick-filters \{ transition: none/);
  assert.doesNotMatch(css, /\.atlas-job-card[^}]*transition:[^}]*transform/s);
  assert.match(css, /\[data-pane-layout="narrow"\] \.atlas-main-grid \{[^}]*overflow: visible/);
  assert.match(css, /\[data-pane-layout="narrow"\] \.atlas-results \.atlas-job-list \{[^}]*overflow: visible/);
});
