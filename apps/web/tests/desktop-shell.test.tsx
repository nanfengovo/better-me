import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://desktop-fixture.invalid" });
const React = await import("react");
const globals = { window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage, HTMLElement: dom.HTMLElement, Element: dom.Element, React, IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom) };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createElement: h, act } = React;
const { createRoot } = await import("react-dom/client");
const { DesktopShell } = await import("../src/components/desktop/DesktopShell.tsx");
const { UiPreferencesProvider, UI_PREFERENCES_KEY, parseUiPreferences } = await import("../src/lib/ui-preferences.tsx");
let root: ReturnType<typeof createRoot> | undefined;
let aiOpens = 0, networkOpens = 0;
async function flush(fn: () => void = () => {}) { await act(async () => { fn(); await nextTurn(); await nextTurn(); }); }
function button(label: string) {
  const element = [...dom.document.querySelectorAll("button")].find(node => (node.getAttribute("aria-label") ?? node.textContent?.trim()) === label);
  assert.ok(element, `Missing button: ${label}`); return element;
}
async function click(label: string) { await flush(() => button(label).click()); }
async function mount() {
  function Harness() {
    const [page, setPage] = React.useState<"resume" | "agent" | "opportunities" | "resources" | "atlas">("resume");
    const [draft, setDraft] = React.useState("合成草稿");
    return h(DesktopShell, { page, onNavigate: setPage, onDesign() {}, onHistory() {}, onAiConfig() { aiOpens++; }, onNetwork() { networkOpens++; } },
      h("textarea", { "aria-label": "合成编辑器", value: draft, onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value) }), h("output", null, page));
  }
  const host = dom.document.createElement("div"); dom.document.body.append(host); root = createRoot(host);
  await flush(() => root!.render(h(UiPreferencesProvider, null, h(Harness))));
}
afterEach(async () => { if (root) await flush(() => root!.unmount()); root = undefined; dom.document.body.replaceChildren(); dom.localStorage.clear(); aiOpens = 0; networkOpens = 0; });
after(() => { dom.happyDOM.abort(); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });

test("desktop preferences accept only supported values and preserve legacy defaults", () => {
  assert.deepEqual(parseUiPreferences('{"locale":"en","theme":"dark"}'), { locale: "en", theme: "dark" });
  assert.deepEqual(parseUiPreferences('{"dockAutoHide":false,"reduceMotion":true,"wallpaper":"midnight"}'), { locale: "zh", theme: "light", dockAutoHide: false, reduceMotion: true, wallpaper: "midnight" });
  assert.deepEqual(parseUiPreferences('{"dockAutoHide":"false","reduceMotion":1,"wallpaper":"javascript:alert(1)"}'), { locale: "zh", theme: "light" });
});
test("minimizing, restoring and navigating keep the same mounted editor node", async () => {
  await mount();
  const editor = dom.document.querySelector("textarea")!;
  await click("最小化简历工作室");
  assert.equal(dom.document.querySelector(".os-business-window")!.getAttribute("data-hidden"), "true");
  assert.equal(dom.document.querySelector(".os-business-window")!.hasAttribute("inert"), true);
  await click("简历");
  assert.equal(dom.document.querySelector(".os-business-window")!.getAttribute("data-hidden"), "false");
  await click("Agent");
  assert.equal(dom.document.querySelector("output")!.textContent, "agent");
  await click("简历");
  assert.equal(dom.document.querySelector("textarea"), editor);
  assert.equal(editor.value, "合成草稿");
});
test("settings manage real preferences and restore focus without unmounting business content", async () => {
  await mount();
  const editor = dom.document.querySelector("textarea");
  await click("打开系统设置");
  assert.equal(dom.document.querySelector(".os-business-window")!.hasAttribute("inert"), true);
  await click("深色"); await click("桌面与 Dock"); await click("自动隐藏 Dock"); await click("暮色");
  await click("辅助功能"); await click("减少动态效果");
  assert.deepEqual(JSON.parse(dom.localStorage.getItem(UI_PREFERENCES_KEY)!), { locale: "zh", theme: "dark", dockAutoHide: false, wallpaper: "midnight", reduceMotion: true });
  assert.equal(dom.document.querySelector(".os-desktop")!.getAttribute("data-reduced-motion"), "true");
  await click("关闭系统设置窗口");
  assert.equal(dom.document.querySelector(".os-business-window")!.hasAttribute("inert"), false);
  assert.equal(dom.document.activeElement, button("系统设置"));
  assert.equal(dom.document.querySelector("textarea"), editor);
  await flush(() => root!.unmount()); root = undefined; dom.document.body.replaceChildren(); await mount();
  assert.equal(dom.document.querySelector(".os-desktop")!.getAttribute("data-wallpaper"), "midnight");
  assert.equal(dom.document.querySelector(".os-dock-system")!.getAttribute("data-auto-hide"), "false");
});
test("desktop-only storage changes propagate across windows without changing business data", async () => {
  await mount();
  const editor = dom.document.querySelector("textarea");
  dom.localStorage.setItem(UI_PREFERENCES_KEY, '{"locale":"zh","theme":"light","wallpaper":"warm","reduceMotion":true,"dockAutoHide":false}');
  await flush(() => dom.dispatchEvent(new dom.StorageEvent("storage", { key: UI_PREFERENCES_KEY })));
  assert.equal(dom.document.querySelector(".os-desktop")!.getAttribute("data-wallpaper"), "warm");
  assert.equal(dom.document.querySelector(".os-dock-system")!.getAttribute("data-auto-hide"), "false");
  assert.equal(dom.document.querySelector("textarea"), editor);
});
test("Dock reveals at the edge and hides after the leave delay", async () => {
  dom.localStorage.setItem(UI_PREFERENCES_KEY, '{"reduceMotion":true}'); await mount();
  const edge = dom.document.querySelector(".os-dock-edge")!;
  const system = dom.document.querySelector(".os-dock-system")!;
  assert.equal(system.getAttribute("data-visible"), "false");
  await flush(() => edge.dispatchEvent(new dom.PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" })));
  assert.equal(system.getAttribute("data-visible"), "true");
  await flush(() => edge.dispatchEvent(new dom.PointerEvent("pointerout", { bubbles: true, pointerType: "mouse" })));
  assert.equal(system.getAttribute("data-visible"), "true");
  await act(async () => { await delay(240); });
  assert.equal(system.getAttribute("data-visible"), "false");
});
test("window maximize and restore do not replace the editor", async () => {
  await mount(); const editor = dom.document.querySelector("textarea");
  const control = dom.document.querySelector<HTMLButtonElement>(".os-business-window .os-traffic button:nth-child(3)")!;
  await flush(() => control.click());
  assert.equal(dom.document.querySelector(".os-business-window")!.classList.contains("is-maximized"), true);
  await flush(() => control.click());
  assert.equal(dom.document.querySelector(".os-business-window")!.classList.contains("is-maximized"), false);
  assert.equal(dom.document.querySelector("textarea"), editor);
});
test("reduced motion skips pointer animation and Dock buttons remain keyboard focusable", async () => {
  dom.localStorage.setItem(UI_PREFERENCES_KEY, '{"reduceMotion":true}'); await mount();
  const dock = dom.document.querySelector(".os-dock")!;
  await flush(() => dock.dispatchEvent(new dom.PointerEvent("pointermove", { bubbles: true, pointerType: "mouse", clientX: 200 })));
  const target = button("简历");
  assert.equal(target.style.transform, "");
  await flush(() => target.focus());
  assert.equal(dom.document.activeElement, target);
  assert.equal(target.tabIndex, 0);
});
test("failed preference writes apply in-session and show the existing warning", async () => {
  await mount(); await click("打开系统设置"); await click("桌面与 Dock");
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => dom.localStorage.getItem(key), setItem() { throw new Error("blocked"); } } });
  try {
    await click("自动隐藏 Dock");
    assert.equal(dom.document.querySelector(".os-dock-system")!.getAttribute("data-auto-hide"), "false");
    assert.match(dom.document.querySelector(".os-preference-error")!.textContent!, /未能保存/);
  } finally { Object.defineProperty(globalThis, "localStorage", original); }
});
test("model and network buttons invoke existing callbacks only after explicit clicks", async () => {
  await mount(); await click("打开系统设置"); await click("模型与网络");
  assert.equal(aiOpens + networkOpens, 0);
  await click("模型与 AI 配置"); await click("网络与代理");
  assert.equal(aiOpens, 1); assert.equal(networkOpens, 1);
});
