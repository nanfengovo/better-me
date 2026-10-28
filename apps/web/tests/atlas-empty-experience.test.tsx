import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test, { after, afterEach } from "node:test";
import { Window, type HTMLButtonElement } from "happy-dom";
import * as React from "react";

const dom = new Window({ url: "http://atlas-empty-fixture.invalid" });
let hidden = false;
let reduced = false;
let finePointer = true;
let frameId = 0;
const frames = new Map<number, FrameRequestCallback>();
const mediaListeners = new Set<() => void>();
const documentListeners = new Map<string, Set<unknown>>([["visibilitychange", new Set()], ["keydown", new Set()]]);
const chromeCalls: { kind: "one" | "many"; urls: string[] }[] = [];
const openedUrls: string[] = [];
const addDocumentListener = dom.document.addEventListener.bind(dom.document);
const removeDocumentListener = dom.document.removeEventListener.bind(dom.document);
Object.defineProperty(dom.document, "addEventListener", { configurable: true, value: (...args: Parameters<typeof addDocumentListener>) => {
  documentListeners.get(args[0])?.add(args[1]);
  return addDocumentListener(...args);
} });
Object.defineProperty(dom.document, "removeEventListener", { configurable: true, value: (...args: Parameters<typeof removeDocumentListener>) => {
  documentListeners.get(args[0])?.delete(args[1]);
  return removeDocumentListener(...args);
} });
Object.defineProperty(dom.document, "hidden", { configurable: true, get: () => hidden });
Object.defineProperty(dom, "matchMedia", { configurable: true, value: (query: string) => ({
  get matches() { return query.includes("no-preference") ? !reduced && finePointer : reduced; },
  addEventListener: (_type: string, callback: () => void) => mediaListeners.add(callback),
  removeEventListener: (_type: string, callback: () => void) => mediaListeners.delete(callback),
}) });
Object.defineProperty(dom, "open", { configurable: true, value: (url: string) => { openedUrls.push(url); return null; } });
const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement,
  Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; },
  cancelAnimationFrame: (id: number) => { frames.delete(id); },
  __atlasEmptyChrome: {
    openOne: async (url: string) => { chromeCalls.push({ kind: "one", urls: [url] }); return true; },
    openMany: async (urls: string[]) => { chromeCalls.push({ kind: "many", urls }); return true; },
  },
};
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith("/real-chrome-client")) return { shortCircuit: true, url: "data:text/javascript,export const openUrlInRealChrome=(...args)=>globalThis.__atlasEmptyChrome.openOne(...args);export const openUrlsInRealChrome=(...args)=>globalThis.__atlasEmptyChrome.openMany(...args)" };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) return { shortCircuit: true, format: "module", source: "export {};" };
    return nextLoad(url, context);
  },
});
const { createRoot } = await import("react-dom/client");
const { AtlasIllustration } = await import("../src/components/atlas/AtlasIllustration");
const { AtlasLivePlatformQuickSearch } = await import("../src/components/atlas/AtlasLivePlatformQuickSearch");
let root: ReturnType<typeof createRoot> | undefined;

async function render(node: React.ReactNode) {
  if (!root) {
    dom.document.body.innerHTML = "<main></main>";
    root = createRoot(dom.document.querySelector("main")! as unknown as Element);
  }
  await React.act(async () => { root!.render(node); });
}
function artwork() {
  const surface = dom.document.querySelector(".atlas-illustration")!;
  let boundsReads = 0;
  Object.defineProperty(surface, "getBoundingClientRect", { configurable: true, value: () => {
    boundsReads++;
    return { x: 10, y: 20, left: 10, top: 20, width: 240, height: 160, right: 250, bottom: 180 };
  } });
  return { surface, image: surface.querySelector("img")!, boundsReads: () => boundsReads };
}
function move(surface: ReturnType<typeof artwork>["surface"], pointerType = "mouse", x = 250, y = 20) {
  surface.dispatchEvent(new dom.PointerEvent("pointermove", { bubbles: true, pointerType, clientX: x, clientY: y }));
}
function flushFrames() {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(performance.now());
}
function button(label: string) {
  const found = [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === label);
  assert.ok(found, `Missing button: ${label}`);
  return found;
}
function quickProps() {
  const called = { reset: 0, capture: 0, aggregator: 0, domestic: 0, global: 0, resume: 0 };
  return { called, props: {
    keyword: "TypeScript", regionText: "上海", countryCode: "CN",
    onResetFilters: () => { called.reset++; },
    onLiveCaptureNow: () => { called.capture++; },
    onOpenAggregator: () => { called.aggregator++; },
    broaderMatches: { domesticCount: 12, globalCount: 34,
      onExpandDomestic: () => { called.domestic++; }, onExpandGlobal: () => { called.global++; } },
    resumePrefill: { hasResumeData: true, summaryLabel: "仅在确认后填入", apply: () => { called.resume++; } },
  } };
}

afterEach(async () => {
  await React.act(async () => { root?.unmount(); });
  root = undefined;
  dom.document.body.replaceChildren();
  assert.equal(frames.size, 0, "unmount cancels owned animation frames");
  assert.equal(mediaListeners.size, 0, "unmount removes media-query listeners");
  for (const [type, listeners] of documentListeners) assert.equal(listeners.size, 0, `unmount removes ${type} listeners`);
  hidden = false; reduced = false; finePointer = true;
  chromeCalls.length = 0; openedUrls.length = 0;
});
after(async () => {
  hooks.deregister();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
});

test("illustrations reserve intrinsic size, load lazily and stay outside the accessibility tree", async () => {
  await render(React.createElement(AtlasIllustration, { kind: "search" }));
  const { surface, image } = artwork();
  assert.equal(surface.getAttribute("aria-hidden"), "true");
  assert.equal(image.getAttribute("width"), "384");
  assert.equal(image.getAttribute("height"), "256");
  assert.equal(image.getAttribute("loading"), "lazy");
  assert.equal(image.getAttribute("decoding"), "async");
  assert.equal(image.getAttribute("alt"), "");
  assert.equal(image.getAttribute("draggable"), "false");
  assert.match(image.getAttribute("src")!, /atlas-art\/search-384\.webp$/);
  assert.match(image.getAttribute("srcset")!, /search-384\.webp 384w, .*search-768\.webp 768w/);
  assert.match(image.getAttribute("sizes")!, /180px, 240px/);
  assert.equal(surface.querySelectorAll("button, a, [tabindex]").length, 0);
  move(surface);
  assert.equal(frames.size, 1);
  await React.act(async () => { image.dispatchEvent(new dom.Event("error")); });
  assert.equal(frames.size, 0, "failed decorative artwork cancels pending work");
  assert.equal(surface.querySelector("img"), null);
  assert.ok(surface.querySelector(".atlas-illustration-fallback svg"));
  assert.equal(surface.getAttribute("aria-hidden"), "true");
});

test("pointer tilt coalesces frames, bounds the transform and never rerenders the workspace", async () => {
  let renders = 0;
  let commits = 0;
  function WorkspaceProbe() { renders++; return React.createElement(AtlasIllustration); }
  await render(React.createElement(React.Profiler, { id: "empty", onRender: () => { commits++; } }, React.createElement(WorkspaceProbe)));
  const { surface, image, boundsReads } = artwork();
  const initial = { renders, commits };
  for (let index = 0; index < 20; index++) move(surface, "mouse", 1000 + index, -500);
  assert.equal(frames.size, 1);
  assert.equal(boundsReads(), 1);
  flushFrames();
  assert.equal(image.style.transform, "rotateX(5deg) rotateY(7deg)");
  assert.deepEqual({ renders, commits }, initial);
  assert.equal(frames.size, 0, "there is no idle animation loop");
  surface.dispatchEvent(new dom.PointerEvent("pointercancel", { bubbles: true, pointerType: "mouse" }));
  assert.equal(image.style.transform, "");
  move(surface);
  assert.equal(boundsReads(), 2, "a new interaction remeasures bounds once");
});

test("touch, coarse pointer, keyboard-only, reduced-motion and hidden modes do not request tilt", async () => {
  await render(React.createElement(AtlasIllustration));
  const { surface, image } = artwork();
  move(surface, "touch");
  move(surface, "pen");
  surface.dispatchEvent(new dom.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
  assert.equal(frames.size, 0);
  reduced = true;
  move(surface);
  assert.equal(frames.size, 0);
  reduced = false; finePointer = false;
  move(surface);
  assert.equal(frames.size, 0);
  finePointer = true; hidden = true;
  move(surface);
  assert.equal(frames.size, 0);
  assert.equal(image.style.transform, "");
});

test("visibility and reduced-motion changes cancel pending and applied decorative tilt", async () => {
  await render(React.createElement(AtlasIllustration));
  const { surface, image } = artwork();
  move(surface);
  assert.equal(frames.size, 1);
  hidden = true;
  dom.document.dispatchEvent(new dom.Event("visibilitychange"));
  assert.equal(frames.size, 0);
  hidden = false;
  move(surface); flushFrames();
  assert.notEqual(image.style.transform, "");
  reduced = true;
  for (const listener of mediaListeners) listener();
  assert.equal(image.style.transform, "");
  assert.equal(frames.size, 0);
});

test("keyboard navigation interrupts a queued or applied pointer tilt", async () => {
  await render(React.createElement(AtlasIllustration));
  const { surface, image } = artwork();
  move(surface);
  dom.document.dispatchEvent(new dom.KeyboardEvent("keydown", { bubbles: true, key: "Tab" }));
  assert.equal(frames.size, 0, "keyboard navigation cancels a queued decorative frame");
  move(surface); flushFrames();
  dom.document.dispatchEvent(new dom.KeyboardEvent("keydown", { bubbles: true, key: "Tab" }));
  assert.equal(image.style.transform, "");
});

test("compact or noninteractive artwork cancels an active tilt and stops listening", async () => {
  await render(React.createElement(AtlasIllustration));
  const { surface, image } = artwork();
  move(surface); flushFrames();
  move(surface);
  await render(React.createElement(AtlasIllustration, { compact: true }));
  assert.equal(frames.size, 0);
  assert.equal(image.style.transform, "");
  assert.equal(image.getAttribute("sizes"), "96px");
  assert.equal(mediaListeners.size, 0);
  move(surface);
  assert.equal(frames.size, 0);
  await render(React.createElement(AtlasIllustration));
  move(surface);
  await render(React.createElement(AtlasIllustration, { interactive: false }));
  assert.equal(frames.size, 0);
  assert.equal(mediaListeners.size, 0);
  move(surface);
  assert.equal(frames.size, 0);
});

test("empty state keeps platform options disclosed, truthfully scopes zero results and never auto-captures", async () => {
  const { props, called } = quickProps();
  await render(React.createElement(AtlasLivePlatformQuickSearch, props));
  const disclosure = dom.document.querySelector(".atlas-live-platform-disclosure")!;
  assert.equal(disclosure.tagName, "DETAILS");
  assert.equal(disclosure.hasAttribute("open"), false);
  assert.equal(disclosure.querySelector("summary")?.textContent, "选择招聘平台与采集方式");
  assert.match(dom.document.body.textContent, /已收录数据中没有/);
  assert.match(dom.document.body.textContent, /未读取的来源不代表没有岗位/);
  assert.match(disclosure.textContent, /可能要求登录、验证码，或限制可读取的页数/);
  assert.doesNotMatch(dom.document.body.textContent, /极速|强风控|综合龙头|商业大厂|复用.*指纹|指纹.*复用|绕过.*验证|完整采集|永久复用/);
  assert.deepEqual(called, { reset: 0, capture: 0, aggregator: 0, domestic: 0, global: 0, resume: 0 });
  assert.equal(chromeCalls.length, 0);
  assert.equal(openedUrls.length, 0);
  await render(React.createElement(AtlasLivePlatformQuickSearch, { ...props, keyword: "React" }));
  assert.equal(called.capture, 0, "changing the query does not trigger acquisition");
  assert.equal(chromeCalls.length, 0);
  await React.act(async () => { button("清除当前筛选").click(); });
  assert.equal(called.reset, 1);
  assert.equal(called.capture, 0);
  await React.act(async () => { disclosure.querySelector("summary")!.click(); });
  assert.equal(disclosure.hasAttribute("open"), true);
  assert.equal(called.capture, 0);
  assert.equal(chromeCalls.length, 0);
  await React.act(async () => { disclosure.querySelector("summary")!.click(); });
  assert.equal(disclosure.hasAttribute("open"), false);
  await React.act(async () => { disclosure.querySelector("summary")!.click(); });
  await React.act(async () => { button("打开采集面板，按平台读取").click(); });
  assert.equal(called.aggregator, 1);
  assert.equal(called.capture, 0);
});

test("broader results, resume prefill and capture remain separate explicit actions", async () => {
  const { props, called } = quickProps();
  await render(React.createElement(AtlasLivePlatformQuickSearch, props));
  await React.act(async () => { button("查看全国「TypeScript」岗位（12 岗）").click(); });
  await React.act(async () => { button("查看全球「TypeScript」岗位（34 岗）").click(); });
  await React.act(async () => { button("参考当前简历自动填入（仅在确认后填入）").click(); });
  assert.deepEqual(called, { reset: 0, capture: 0, aggregator: 0, domestic: 1, global: 1, resume: 1 });
  await React.act(async () => { button("继续从来源获取").click(); });
  assert.equal(called.capture, 1);
  await render(React.createElement(AtlasLivePlatformQuickSearch, { ...props, liveCapturing: true }));
  assert.equal(button("正在读取来源…").disabled, true);
  await React.act(async () => { button("正在读取来源…").click(); });
  assert.equal(called.capture, 1);
  assert.equal(chromeCalls.length, 0);
});

test("artwork CSS gates pointer motion and preserves a stable aspect ratio", () => {
  const css = readFileSync(new URL("../src/components/atlas/atlas-art.css", import.meta.url), "utf8");
  assert.match(css, /aspect-ratio:\s*3\s*\/\s*2/);
  assert.match(css, /hover:\s*hover.*pointer:\s*fine.*prefers-reduced-motion:\s*no-preference/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.doesNotMatch(css, /@keyframes|animation:[^;]*infinite|transition:\s*all|will-change|backdrop-filter/);
});
