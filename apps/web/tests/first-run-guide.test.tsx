import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { registerHooks } from "node:module";
import { Window } from "happy-dom";
import { FIRST_RUN_GUIDE_KEY, GUIDE_STEPS, placeGuide, rememberGuide, shouldShowGuide } from "../src/lib/first-run-guide";

registerHooks({ load(url, context, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context); } });
const dom = new Window({ url: "http://tour-fixture.invalid" });
const React = await import("react");
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator,
  HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, ResizeObserver: dom.ResizeObserver,
  React, IS_REACT_ACT_ENVIRONMENT: true })) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { act, createElement: h } = React;
const { createRoot } = await import("react-dom/client");
const { FirstRunGuide } = await import("../src/components/FirstRunGuide");

test("first run, invalid preferences and future versions are safe; completed or skipped tours stay dismissed", () => {
  const values = new Map<string, string>();
  const store = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  assert.equal(shouldShowGuide(store), true);
  values.set(FIRST_RUN_GUIDE_KEY, "not json"); assert.equal(shouldShowGuide(store), true);
  values.set(FIRST_RUN_GUIDE_KEY, '{"version":2,"state":"completed"}'); assert.equal(shouldShowGuide(store), true);
  assert.equal(rememberGuide(store, "skipped"), true); assert.equal(shouldShowGuide(store), false);
  assert.equal(rememberGuide(store, "completed"), true); assert.equal(shouldShowGuide(store), false);
  assert.deepEqual([...values.keys()], [FIRST_RUN_GUIDE_KEY]);
});
test("blocked and full storage never throws", () => {
  const store = { getItem() { throw Error("blocked"); }, setItem() { throw Error("full"); } };
  assert.equal(shouldShowGuide(store), true); assert.equal(rememberGuide(store, "skipped"), false);
});
test("all eight steps have bilingual descriptions and only stable workspace anchors", () => {
  assert.equal(GUIDE_STEPS.length, 8); assert.equal(new Set(GUIDE_STEPS.map(step => step.id)).size, 8);
  for (const step of GUIDE_STEPS) for (const text of [step.label, step.title, step.description, step.hint]) assert.ok(text.every(Boolean));
  assert.equal(GUIDE_STEPS[0].target, null); assert.equal(GUIDE_STEPS.at(-1)?.target, null);
});
test("placement prefers available space and clamps long targets to desktop or mobile viewport", () => {
  const panel = { width: 440, height: 400 };
  assert.deepEqual(placeGuide({ x: 20, y: 20, width: 100, height: 100 }, { width: 1440, height: 900 }, panel), { x: 144, y: 20 });
  assert.deepEqual(placeGuide({ x: 1300, y: 800, width: 100, height: 70 }, { width: 1440, height: 900 }, panel), { x: 836, y: 484 });
  assert.deepEqual(placeGuide(null, { width: 1440, height: 900 }, panel), { x: 500, y: 250 });
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    for (const target of [null, { x: 100, y: 300, width: 900, height: 900 }]) {
      const point = placeGuide(target, viewport, panel);
      assert.ok(point.x >= 16 && point.y >= 16);
      assert.ok(point.x + Math.min(panel.width, viewport.width - 32) <= viewport.width - 16);
      assert.ok(point.y + Math.min(panel.height, viewport.height - 32) <= viewport.height - 16);
    }
  }
});

let root: ReturnType<typeof createRoot> | undefined;
let prepared = 0;
async function render(eligible = false) {
  if (!root) { const container = dom.document.createElement("main"); dom.document.body.append(container); root = createRoot(container as unknown as Element); }
  await act(async () => root!.render(h(FirstRunGuide, { eligible, onPrepare() { prepared++; } })));
}
async function click(label: string) {
  const button = [...dom.document.querySelectorAll("button")].find(node => node.getAttribute("aria-label") === label || node.textContent === label);
  assert.ok(button, `Missing button: ${label}`); await act(async () => button.click());
}
async function waitForAutoOpen() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 700)); }); }
function currentStep() { return dom.document.querySelector(".guide-panel")?.getAttribute("data-step"); }
afterEach(async () => { await act(async () => { root?.unmount(); root = undefined; }); dom.document.body.replaceChildren(); dom.localStorage.clear(); prepared = 0; });
after(() => { dom.happyDOM.abort(); for (const [key, value] of originals) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } });

test("eligible first visit opens automatically without preparing or mutating resume data", async () => {
  dom.localStorage.setItem("real-resume-fixture", '{"unchanged":true}');
  await render(true); await waitForAutoOpen();
  assert.equal(currentStep(), "welcome"); assert.equal(prepared, 0);
  await click("跳过引导");
  assert.equal(currentStep(), undefined); assert.equal(shouldShowGuide(dom.localStorage), false);
  assert.equal(dom.localStorage.getItem("real-resume-fixture"), '{"unchanged":true}');
  assert.equal(dom.localStorage.length, 2);
});
test("editing and another modal suppress automatic interruption", async () => {
  const input = dom.document.createElement("textarea"); dom.document.body.append(input); input.focus();
  await render(true); await waitForAutoOpen(); assert.equal(currentStep(), undefined);
  assert.equal(dom.document.activeElement, input);
});
test("an open dialog suppresses the welcome screen", async () => {
  const modal = dom.document.createElement("dialog"); dom.document.body.append(modal); modal.showModal();
  await render(true); await waitForAutoOpen(); assert.equal(currentStep(), undefined);
  modal.close();
});
test("dismissed visits remain quiet but replay, back, skip-step and finish still work", async () => {
  rememberGuide(dom.localStorage, "skipped");
  await render(true); await waitForAutoOpen(); assert.equal(currentStep(), undefined);
  await click("重新播放新手引导"); assert.equal(prepared, 1); assert.equal(currentStep(), "welcome");
  await click("带我逛逛"); assert.equal(currentStep(), "editor");
  await click("跳过本步"); assert.equal(currentStep(), "writing");
  await click("上一步"); assert.equal(currentStep(), "editor");
  await click("第 8 步：准备就绪"); assert.equal(currentStep(), "finish");
  await click("开始写我的故事");
  assert.deepEqual(JSON.parse(dom.localStorage.getItem(FIRST_RUN_GUIDE_KEY)!), { version: 1, state: "completed" });
  assert.equal(dom.document.activeElement?.getAttribute("aria-label"), "重新播放新手引导");
});
test("Escape cancellation restores focus; keyboard arrows navigate without touching the editor", async () => {
  await render(); await click("重新播放新手引导");
  const dialog = dom.document.querySelector("dialog")!;
  await act(async () => dialog.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  assert.equal(currentStep(), "editor");
  assert.ok(dom.document.querySelector(".guide-target-fallback"));
  await act(async () => dialog.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
  assert.equal(currentStep(), "welcome");
  await act(async () => dialog.dispatchEvent(new dom.Event("cancel", { cancelable: true })));
  assert.equal(currentStep(), undefined); assert.equal(shouldShowGuide(dom.localStorage), false);
});
test("effects can be turned off and a completed tour in another tab closes this one", async () => {
  await render(); await click("重新播放新手引导");
  assert.ok(dom.document.querySelector(".has-effects"));
  const checkbox = dom.document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await act(async () => checkbox.click()); assert.ok(dom.document.querySelector(".reduced-effects"));
  await act(async () => dom.dispatchEvent(new dom.StorageEvent("storage", { key: FIRST_RUN_GUIDE_KEY, newValue: '{"version":1,"state":"completed"}' })));
  assert.equal(currentStep(), undefined);
});
test("Tab and Shift+Tab wrap at the guide controls instead of reaching the editor", async () => {
  await render(); await click("重新播放新手引导");
  const dialog = dom.document.querySelector("dialog")!;
  const controls = [...dialog.querySelectorAll<HTMLElement>("button, input")];
  for (const control of controls) Object.defineProperty(control, "getClientRects", { value: () => [{}] });
  controls.at(-1)!.focus();
  await act(async () => dialog.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
  assert.equal(dom.document.activeElement, controls[0]);
  await act(async () => dialog.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })));
  assert.equal(dom.document.activeElement, controls.at(-1));
});
test("system reduced-motion preference takes precedence over immersive effects", async () => {
  const original = dom.matchMedia;
  dom.matchMedia = query => { const media = original.call(dom, query); Object.defineProperty(media, "matches", { value: true }); return media; };
  try {
    await render(); await click("重新播放新手引导");
    assert.ok(dom.document.querySelector(".reduced-effects"));
    const checkbox = dom.document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    assert.equal(checkbox.checked, false); assert.equal(checkbox.disabled, true);
    assert.match(dom.document.querySelector(".guide-utilities")?.textContent ?? "", /跟随系统/);
  } finally { dom.matchMedia = original; }
});
test("blocked localStorage accessor still allows opening and closing the guide", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(dom, "localStorage");
  Object.defineProperty(dom, "localStorage", { configurable: true, get() { throw Error("SecurityError"); } });
  try {
    await render(true); await waitForAutoOpen(); assert.equal(currentStep(), "welcome");
    await click("关闭并跳过引导"); assert.equal(currentStep(), undefined);
    assert.match(dom.document.querySelector('[role="status"]')?.textContent ?? "", /未保存偏好/);
  } finally { if (descriptor) Object.defineProperty(dom, "localStorage", descriptor); else Reflect.deleteProperty(dom, "localStorage"); }
});
