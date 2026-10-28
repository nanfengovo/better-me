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
