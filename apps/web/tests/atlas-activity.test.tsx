import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after, afterEach } from "node:test";
import { Window } from "happy-dom";
import * as React from "react";
import { AtlasActivityRail, type AtlasActivity } from "../src/components/atlas/AtlasActivityRail";

const dom = new Window({ url: "http://atlas-activity-fixture.invalid" });
let hidden = false;
let reduced = false;
const motionListeners = new Set<() => void>();
Object.defineProperty(dom.document, "hidden", { configurable: true, get: () => hidden });
Object.defineProperty(dom, "matchMedia", { configurable: true, value: () => ({
  get matches() { return reduced; },
  addEventListener: (_type: string, callback: () => void) => motionListeners.add(callback),
  removeEventListener: (_type: string, callback: () => void) => motionListeners.delete(callback),
}) });

class VisibilityProbe {
  static current: VisibilityProbe;
  target: unknown;
  disconnected = false;
  constructor(readonly callback: (entries: { target: unknown; isIntersecting: boolean }[]) => void) { VisibilityProbe.current = this; }
  observe(target: unknown) { this.target = target; }
  disconnect() { this.disconnected = true; }
  show(isIntersecting: boolean) { this.callback([{ target: this.target, isIntersecting }]); }
}
const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement,
  Element: dom.Element, Node: dom.Node, IntersectionObserver: VisibilityProbe, React, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import("react-dom/client");
let root: ReturnType<typeof createRoot> | undefined;

function activities(state: AtlasActivity["state"] = "idle", value?: number): React.ComponentProps<typeof AtlasActivityRail> {
  return {
    index: { state, value, detail: "逐批读取，保留已到达的岗位" },
    collection: { state: "attention", value: 64, detail: "部分未完成 · 详见回执" },
    enrichment: { state: "working", value: 12, detail: "后台自动补全" },
    map: { state: "ready", value: 0, detail: "暂无来源真实坐标" },
  };
}

function stylesheet(url: URL): string {
  return readFileSync(url, "utf8").replace(/@import\s+["'](.+?)["'];/g, (_match, imported: string) => stylesheet(new URL(imported, url)));
}

async function render(props = activities()) {
  if (!root) {
    dom.document.body.innerHTML = "<main></main>";
    root = createRoot(dom.document.querySelector("main")! as unknown as Element);
  }
  await React.act(async () => { root!.render(React.createElement(AtlasActivityRail, props)); });
  return dom.document.querySelector(".atlas-activity-rail")!;
}

afterEach(async () => {
  await React.act(async () => { root?.unmount(); });
  root = undefined;
  hidden = false;
  reduced = false;
});
after(async () => {
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
});

test("activity state is explicit without turning confirmed counts into completion claims", async () => {
  const rail = await render();
  assert.equal(rail.querySelectorAll("[data-lane]").length, 4);
  assert.deepEqual([...rail.querySelectorAll(".atlas-activity-state")].map(item => item.textContent), ["待命", "需关注", "处理中", "可用"]);
  assert.deepEqual([...rail.querySelectorAll("strong")].map(item => item.textContent), ["—", "64", "12", "0"]);
  assert.equal(rail.querySelectorAll('[role="progressbar"], [aria-live], [role="status"]').length, 0);
  assert.match(rail.textContent, /部分未完成/);
  assert.match(rail.textContent, /暂无来源真实坐标/);
});

test("compact lanes distinguish unknown counts from confirmed zero without hiding long diagnostic details", async () => {
  const detail = "部分页面没有返回最终回执；已收到的来源卡片仍保留。" + "https://example.invalid/" + "unconfirmed/".repeat(20);
  const props = activities("ready", 15000);
  props.collection = { state: "attention", detail };
  const rail = await render(props);
  assert.ok(rail.classList.contains("atlas-activity-rail--compact"));
  const unknown = rail.querySelector('[data-lane="collection"]')!;
  const zero = rail.querySelector('[data-lane="map"]')!;
  assert.equal(unknown.getAttribute("data-has-value"), "false");
  assert.equal(unknown.querySelector('.atlas-activity-value[role="group"]')!.getAttribute("aria-label"), "数量尚未确认");
  assert.equal(unknown.querySelector("p")!.textContent, detail);
  assert.equal(unknown.querySelector("p")!.closest("[hidden], details"), null);
  assert.equal(zero.getAttribute("data-has-value"), "true");
  assert.equal(zero.querySelector('.atlas-activity-value[role="group"]')!.getAttribute("aria-label"), "已确认 0 岗");
  assert.equal(rail.querySelector('[data-lane="index"] .atlas-activity-value')!.getAttribute("aria-label"), "已确认 15,000 岗");
});

test("mobile disclosure starts closed, names attention lanes and preserves their independent receipts when toggled", async () => {
  const rail = await render();
  const overview = rail.parentElement!;
  const button = overview.querySelector("button")!;
  const lanes = [...rail.querySelectorAll("[data-lane]")];
  assert.equal(button.getAttribute("aria-expanded"), "false");
  assert.equal(overview.getAttribute("data-expanded"), "false");
  assert.equal(button.getAttribute("aria-controls"), rail.id);
  assert.match(button.textContent, /索引未读取/);
  assert.match(button.textContent, /1 项需关注/);
  assert.match(button.getAttribute("aria-label")!, /来源采集/);

  await React.act(async () => button.click());
  assert.equal(button.getAttribute("aria-expanded"), "true");
  assert.equal(overview.getAttribute("data-expanded"), "true");
  assert.match(button.getAttribute("aria-label")!, /收起状态详情/);
  const next = activities("ready", 15000);
  next.map = { state: "attention", value: 0, detail: "尚未取得来源真实坐标" };
  await render(next);
  assert.match(button.textContent, /索引 15,000 岗/);
  assert.match(button.textContent, /2 项需关注/);
  assert.match(button.getAttribute("aria-label")!, /来源采集、地图落点/);
  assert.equal(button.getAttribute("aria-expanded"), "true", "receipt updates do not discard the user's disclosure choice");
  assert.deepEqual([...rail.querySelectorAll("[data-lane]")], lanes);
  assert.deepEqual([...rail.querySelectorAll("strong")].map(item => item.textContent), ["15,000", "64", "12", "0"]);
  assert.match(rail.textContent, /尚未取得来源真实坐标/);

  await React.act(async () => button.click());
  assert.equal(button.getAttribute("aria-expanded"), "false");
  assert.equal(overview.getAttribute("data-expanded"), "false");
  assert.match(button.getAttribute("aria-label")!, /展开状态详情/);
  assert.deepEqual([...rail.querySelectorAll("[data-lane]")], lanes, "collapsing preserves the detail DOM and its verified counts");
});

test("mobile summary distinguishes zero from unknown and never invents overall completion", async () => {
  const props = activities("ready", 0);
  props.collection = { state: "idle", detail: "等待用户采集" };
  const rail = await render(props);
  const button = rail.parentElement!.querySelector("button")!;
  assert.match(button.textContent, /索引 0 岗/);
  assert.match(button.textContent, /状态详情/);
  assert.doesNotMatch(button.textContent, /未读取|需关注|全部|完成|正常/);
  assert.equal(rail.parentElement!.getAttribute("data-attention"), "false");
  await render({ ...props, index: { state: "working", detail: "等待本机索引回执" } });
  assert.match(button.textContent, /索引读取中/);
  assert.doesNotMatch(button.textContent, /索引 0 岗/);
});

for (const [width, layout] of [[1600, "wide"], [900, "medium"], [1600, "narrow"], [390, "narrow"]] as const) {
  test(`status disclosure follows measured ${layout} workspace at ${width}px without hiding desktop lanes`, async () => {
    const rail = await render();
    const viewport = new Window({ width, height: 900 });
    try {
      const style = viewport.document.createElement("style");
      style.textContent = ["atlas.css", "atlas-experience.css", "atlas-command-center.css"]
        .map(name => stylesheet(new URL(`../src/components/atlas/${name}`, import.meta.url))).join("\n");
      viewport.document.head.append(style);
      viewport.document.body.innerHTML = `<main class="atlas-workspace atlas-experience atlas-command-center" data-pane-layout="${layout}">${rail.parentElement!.outerHTML}</main>`;
      const overview = viewport.document.querySelector(".atlas-activity-overview")!;
      const css = (selector: string) => viewport.getComputedStyle(viewport.document.querySelector(selector)!);
      assert.equal(css(".atlas-activity-summary").display, layout === "narrow" ? "flex" : "none");
      assert.equal(css(".atlas-activity-rail").display, layout === "narrow" ? "none" : "grid");
      assert.ok(Number.parseFloat(css(".atlas-activity-summary").minHeight) >= 44);
      assert.equal(css(".atlas-activity-summary").transition, "none");
      overview.setAttribute("data-expanded", "true");
      assert.equal(css(".atlas-activity-rail").display, "grid");
      assert.equal(css(".atlas-activity-summary").display, layout === "narrow" ? "flex" : "none");
      assert.equal(overview.querySelectorAll("[data-lane]").length, 4);
    } finally { await viewport.happyDOM.close(); }
  });
}

for (const [width, layout, columns] of [
  [1600, "wide", "repeat(4, minmax(0, 1fr))"],
  [900, "wide", "repeat(2, minmax(0, 1fr))"],
  [1600, "medium", "repeat(2, minmax(0, 1fr))"],
  [390, "narrow", "repeat(2, minmax(0, 1fr))"],
  [320, "narrow", "minmax(0, 1fr)"],
] as const) {
  test(`compact rail keeps readable full evidence after the stylesheet cascade at ${width}px / ${layout}`, async () => {
    const rail = await render(activities("ready", 15000));
    const viewport = new Window({ width, height: 900 });
    try {
      const style = viewport.document.createElement("style");
      style.textContent = ["atlas.css", "atlas-experience.css"]
        .map(name => stylesheet(new URL(`../src/components/atlas/${name}`, import.meta.url))).join("\n");
      viewport.document.head.append(style);
      viewport.document.body.innerHTML = `<main class="atlas-workspace atlas-experience" data-pane-layout="${layout}">${rail.outerHTML}</main>`;
      const css = (selector: string) => viewport.getComputedStyle(viewport.document.querySelector(selector)!);
      assert.equal(css(".atlas-activity-rail").gridTemplateColumns, columns);
      assert.equal(css(".atlas-activity-rail > li").minHeight, "64px");
      assert.equal(css(".atlas-activity-rail > li").paddingTop, "8px");
      assert.ok(Number.parseFloat(css(".atlas-activity-label").fontSize) >= 13);
      assert.ok(Number.parseFloat(css(".atlas-activity-state").fontSize) >= 12);
      assert.ok(Number.parseFloat(css(".atlas-activity-value strong").fontSize) >= 22);
      assert.ok(Number.parseFloat(css(".atlas-activity-content p").fontSize) >= 12);
      assert.equal(css(".atlas-activity-content p").overflowWrap, "anywhere");
      assert.notEqual(css(".atlas-activity-content p").display, "none");
      assert.notEqual(css(".atlas-activity-content p").overflow, "hidden");
      assert.notEqual(css(".atlas-activity-content p").whiteSpace, "nowrap");
      if (layout === "narrow") assert.equal(css(".atlas-activity-icon").display, "none");
    } finally { await viewport.happyDOM.close(); }
  });
}

test("initial mount and streaming counters preserve stable DOM and never restart motion", async () => {
  const rail = await render(activities("working", 5000));
  const lane = rail.querySelector('[data-lane="index"]')!;
  const value = lane.querySelector("strong");
  const signals = [...lane.querySelectorAll("[data-signal]")];
  assert.equal(rail.getAttribute("data-motion"), "off", "initial entry is not animated");
  VisibilityProbe.current.show(true);
  assert.equal(rail.getAttribute("data-motion"), "on");
  await render(activities("working", 15000));
  assert.equal(lane.querySelector("strong"), value);
  assert.equal(value!.textContent, "15,000");
  assert.deepEqual([...lane.querySelectorAll("[data-signal]")], signals);
  assert.equal(rail.getAttribute("data-motion"), "on");
  await render(activities("ready", 15000));
  assert.equal(lane.getAttribute("data-state"), "ready");
  assert.equal(lane.querySelector(".atlas-activity-state")!.textContent, "可用");
  assert.deepEqual([...lane.querySelectorAll("[data-signal]")], signals, "only CSS target state changes");
});

test("hidden, offscreen, reduced-motion and keyboard updates settle immediately", async () => {
  const rail = await render();
  VisibilityProbe.current.show(true);
  assert.equal(rail.getAttribute("data-motion"), "on");
  hidden = true;
  dom.document.dispatchEvent(new dom.Event("visibilitychange"));
  assert.equal(rail.getAttribute("data-motion"), "off");
  hidden = false;
  dom.document.dispatchEvent(new dom.Event("visibilitychange"));
  assert.equal(rail.getAttribute("data-motion"), "on");
  VisibilityProbe.current.show(false);
  assert.equal(rail.getAttribute("data-motion"), "off");
  VisibilityProbe.current.show(true);
  reduced = true;
  for (const callback of motionListeners) callback();
  assert.equal(rail.getAttribute("data-motion"), "off");
  reduced = false;
  for (const callback of motionListeners) callback();
  assert.equal(rail.getAttribute("data-motion"), "on");
  dom.document.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  assert.equal(rail.getAttribute("data-motion"), "off");
  dom.document.dispatchEvent(new dom.PointerEvent("pointerdown", { pointerType: "mouse", bubbles: true }));
  assert.equal(rail.getAttribute("data-motion"), "on");
  const observer = VisibilityProbe.current;
  await React.act(async () => { root!.unmount(); });
  root = undefined;
  assert.equal(observer.disconnected, true);
  assert.equal(motionListeners.size, 0);
  assert.equal(rail.getAttribute("data-motion"), "off");
});

test("activity feedback is finite, transform-opacity only and gated by visibility", () => {
  const css = readFileSync(new URL("../src/components/atlas/atlas-activity.css", import.meta.url), "utf8");
  assert.match(css, /data-motion="on"/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /opacity 180ms/);
  assert.match(css, /transform 180ms/);
  assert.doesNotMatch(css, /@keyframes|transition:\s*all|animation:[^;]*infinite|will-change|backdrop-filter/);
  assert.doesNotMatch(css, /transition:[^;]*(?:width|height|padding|margin|left|top|color|filter)/);
});
