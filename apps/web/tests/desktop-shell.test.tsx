import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
const css = registerHooks({ load(url, context, nextLoad) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : nextLoad(url, context); } });
import test, { after, afterEach } from "node:test";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { Window } from "happy-dom";
import "fake-indexeddb/auto";

const dom = new Window({ url: "http://desktop-fixture.invalid", width: 1280, height: 900 });
const defaultDesktopPreferences = {
  dockPosition: "bottom", dockSize: 48, dockMagnification: true, dockMagScale: 1.45,
  dockOpacity: 0.85, dockBlur: 24, dockAutoHide: true, menuBarAutoHide: false, wallpaperOpacity: 1,
  wallpaperBlur: 0, windowOpacity: 0.92, windowBlur: 24, menuOpacity: 0.9,
};
const React = await import("react");
const globals = { window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage, HTMLElement: dom.HTMLElement, Element: dom.Element, React, IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom) };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createElement: h, act } = React;
const { createRoot } = await import("react-dom/client");
const { DesktopShell } = await import("../src/components/desktop/DesktopShell.tsx");
const { UiPreferencesProvider, UI_PREFERENCES_KEY, parseUiPreferences } = await import("../src/lib/ui-preferences.tsx");

test("window focus counters are isolated below the shell navigation", async () => {
  const styles = await readFile(new URL("../src/components/desktop/desktop.css", import.meta.url), "utf8");
  assert.match(styles, /\.os-stage\s*\{[^}]*z-index:\s*0\s*;[^}]*isolation:\s*isolate\s*;/);
});
let root: ReturnType<typeof createRoot> | undefined;
let aiOpens = 0, networkOpens = 0;
async function flush(fn: () => void = () => {}) { await act(async () => { fn(); await nextTurn(); await nextTurn(); }); }
function button(label: string) {
  const element = [...dom.document.querySelectorAll("button")].find(node => (node.getAttribute("aria-label") ?? node.textContent?.trim()) === label);
  assert.ok(element, `Missing button: ${label}`); return element;
}
async function click(label: string) { await flush(() => button(label).click()); }
function mockWindowRect(win: HTMLElement, left: number, top: number, width: number, height: number) {
  let measured = false;
  Object.defineProperty(win, "getBoundingClientRect", { configurable: true, value: () => {
    if (!measured || win.dataset.snapMode !== "custom") {
      measured = true;
      return new dom.DOMRect(left, top, width, height);
    }
    const stage = win.parentElement!.getBoundingClientRect();
    return new dom.DOMRect(stage.left + Number.parseFloat(win.style.getPropertyValue("--window-x")), stage.top + Number.parseFloat(win.style.getPropertyValue("--window-y")), Number.parseFloat(win.style.getPropertyValue("--window-width")), Number.parseFloat(win.style.getPropertyValue("--window-height")));
  } });
}
function mockPointerCapture(element: HTMLElement) {
  const captured = new Set<number>();
  Object.defineProperties(element, {
    setPointerCapture: { configurable: true, value: (id: number) => captured.add(id) },
    hasPointerCapture: { configurable: true, value: (id: number) => captured.has(id) },
    releasePointerCapture: { configurable: true, value: (id: number) => captured.delete(id) },
  });
  return captured;
}
async function mount() {
  function Harness() {
    const [page, setPage] = React.useState<"resume" | "agent" | "opportunities" | "resources" | "atlas" | "autopilot">("resume");
    const [draft, setDraft] = React.useState("合成草稿");
    React.useLayoutEffect(() => {
      const stage = dom.document.querySelector<HTMLElement>(".os-stage")!;
      Object.defineProperty(stage, "getBoundingClientRect", { configurable: true, value: () => new dom.DOMRect(0, 34, dom.innerWidth, dom.innerHeight - 34) });
    }, []);
    return h(DesktopShell, { page, onNavigate: setPage, onDesign() {}, onHistory() {}, onAiConfig() { aiOpens++; }, onNetwork() { networkOpens++; } },
      h("textarea", { "aria-label": "合成编辑器", value: draft, onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value) }), h("output", null, page));
  }
  const host = dom.document.createElement("div"); dom.document.body.append(host); root = createRoot(host);
  await flush(() => root!.render(h(UiPreferencesProvider, null, h(Harness))));
}
afterEach(async () => { if (root) await flush(() => root!.unmount()); root = undefined; dom.document.body.replaceChildren(); dom.localStorage.clear(); dom.happyDOM.setWindowSize({ width: 1280, height: 900 }); aiOpens = 0; networkOpens = 0; });
after(() => { css.deregister(); dom.happyDOM.abort(); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });

test("atlas and jobs share the app menu and have independent Dock entries without resume actions", async () => {
  await mount();
  const mark = dom.document.querySelector<HTMLImageElement>(".os-system-brand .betterme-product-mark");
  assert.equal(mark?.getAttribute("src"), "/brand/betterme-icon.png");
  assert.equal(mark?.getAttribute("alt"), "", "the adjacent product label supplies the accessible name");
  const menuBar = dom.document.querySelector(".os-menubar")!;
  assert.equal(menuBar.querySelectorAll(":scope > .os-menubar-glass").length, 2);
  assert.ok(menuBar.querySelector(".os-menubar-apps > .os-system-brand"));
  assert.ok(menuBar.querySelector(".os-menubar-apps > .os-app-menu"));
  assert.ok(menuBar.querySelector(".os-menubar-status > .os-menu-shortcuts"));
  assert.ok(menuBar.querySelector(".os-menubar-status > time"));
  const editor = dom.document.querySelector("textarea");
  await flush(() => dom.document.querySelector<HTMLButtonElement>('[data-dock-app="atlas"]')!.click());
  assert.equal(dom.document.querySelector("output")!.textContent, "atlas");
  assert.doesNotMatch(dom.document.querySelector(".os-window-actions")!.textContent!, /排版设计|版本/);
  assert.ok(dom.document.querySelector('.os-app-menu [aria-current="page"]')!.textContent!.includes("岗位地图"));
  await click("最小化岗位地图");
  assert.equal(dom.document.activeElement?.getAttribute("data-dock-app"), "atlas");
  await flush(() => dom.document.querySelector<HTMLButtonElement>('[data-dock-app="atlas"]')!.click());
  await flush(() => dom.document.querySelectorAll<HTMLButtonElement>(".os-app-menu nav button")[2]!.click());
  assert.equal(dom.document.querySelector("output")!.textContent, "opportunities");
  assert.equal(dom.document.querySelector("textarea"), editor);
  assert.equal(dom.document.querySelector<HTMLDetailsElement>(".os-app-menu")!.open, false);
  assert.doesNotMatch(dom.document.querySelector(".os-window-actions")!.textContent!, /排版设计|版本/);
});

test("apps initially open maximized while settings use the centered nonmodal layout", async () => {
  await mount();
  const win = dom.document.querySelector(".os-business-window")!;
  assert.ok(win.classList.contains("is-maximized"));
  for (const app of ["Agent", "简历"]) {
    await click(app);
    assert.ok(win.classList.contains("is-maximized"));
  }
  await click("打开系统设置");
  const settings = dom.document.querySelector<HTMLElement>(".os-settings-window")!;
  assert.equal(settings.dataset.snapMode, "centered");
  assert.equal(settings.classList.contains("is-maximized"), false);
  assert.equal(settings.hasAttribute("inert"), false);
  assert.equal(win.querySelectorAll(".os-resize-handle").length, 8);
  assert.equal(settings.querySelectorAll(".os-resize-handle").length, 8);
  assert.equal(dom.document.activeElement, settings.querySelector(".os-traffic button"));
});

test("synthetic resize events detach maximized Agent geometry without losing its draft", async () => {
  await mount(); await click("Agent");
  const win = dom.document.querySelector<HTMLElement>(".os-business-window")!;
  const editor = dom.document.querySelector("textarea");
  assert.equal(win.querySelectorAll(".os-resize-handle").length, 8);
  mockWindowRect(win, 8, 44, 840, 792);
  const handle = win.querySelector<HTMLElement>(".os-resize-se")!;
  const capture = mockPointerCapture(handle);
  await flush(() => handle.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientX: 838, clientY: 824 })));
  await flush(() => handle.dispatchEvent(new dom.PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 638, clientY: 624 })));
  assert.equal(win.classList.contains("is-maximized"), false);
  assert.equal(win.style.getPropertyValue("--window-width"), "640px");
  assert.equal(win.style.getPropertyValue("--window-height"), "592px");
  await flush(() => handle.dispatchEvent(new dom.PointerEvent("pointerup", { bubbles: true, pointerId: 1 })));
  assert.equal(win.dataset.resizing, "false");
  assert.equal(capture.size, 0);
  await click("最大化窗口");
  assert.ok(win.classList.contains("is-maximized"));
  assert.equal(dom.document.querySelector("textarea"), editor);
});

test("task links open one settings window at the requested section without altering the editor", async () => {
  await mount();
  const editor = dom.document.querySelector('textarea');
  await flush(() => dom.dispatchEvent(new dom.CustomEvent('betterme:open-settings', { detail: 'research' })));
  assert.equal(dom.document.querySelector('.os-settings-window')?.getAttribute('data-hidden'), 'false');
  assert.equal(dom.document.querySelector('.os-settings-content h1')?.textContent, '联网与外部协作');
  await click('外观');
  await flush(() => dom.dispatchEvent(new dom.CustomEvent('betterme:open-settings', { detail: 'research' })));
  assert.equal(dom.document.querySelector('.os-settings-content h1')?.textContent, '联网与外部协作');
  assert.equal(dom.document.querySelectorAll('.os-settings-window').length, 1);
  assert.equal(dom.document.querySelector('textarea'), editor);
  assert.equal(aiOpens, 0); assert.equal(networkOpens, 0);
});

test("desktop preferences reject invalid flags and resolve wallpaper tokens only as local assets", async () => {
  assert.deepEqual(parseUiPreferences('{"locale":"en","theme":"dark"}'), { locale: "en", theme: "dark" });
  assert.deepEqual(parseUiPreferences('{"dockAutoHide":false,"reduceMotion":true,"wallpaper":"midnight"}'), { locale: "zh", theme: "light", dockAutoHide: false, reduceMotion: true, wallpaper: "midnight" });
  assert.deepEqual(parseUiPreferences('{"dockAutoHide":"false","reduceMotion":1,"wallpaper":42,"apiKey":"ignored"}'), { locale: "zh", theme: "light" });
  const raw = '{"dockAutoHide":"false","reduceMotion":1,"wallpaper":"javascript:alert(1)"}';
  assert.deepEqual(parseUiPreferences(raw), { locale: "zh", theme: "light", wallpaper: "javascript:alert(1)" });
  dom.localStorage.setItem(UI_PREFERENCES_KEY, raw);
  await mount();
  const image = dom.document.querySelector<HTMLImageElement>(".os-wallpaper img")!;
  assert.equal(image.getAttribute("src"), "/wallpapers/javascript:alert(1).jpg");
  assert.equal(new URL(image.src).origin, "http://desktop-fixture.invalid");
  assert.equal(new URL(image.src).protocol, "http:");
});
const menuBarMedia = "(hover: hover) and (pointer: fine) and (min-width: 601px)";
async function withFineMenuBar(run: () => Promise<void>) {
  const original = dom.matchMedia.bind(dom);
  dom.matchMedia = ((query: string) => {
    const result = original(query);
    if (query === menuBarMedia) Object.defineProperty(result, "matches", { value: true });
    return result;
  }) as typeof dom.matchMedia;
  try { await run(); } finally { dom.matchMedia = original; }
}
async function openMenuBarContext() {
  const bar = dom.document.querySelector<HTMLElement>(".os-menubar")!;
  const event = new dom.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 1200, clientY: 25 });
  await flush(() => bar.dispatchEvent(event));
  assert.equal(event.defaultPrevented, true);
  assert.equal(dom.document.activeElement?.getAttribute("role"), "menuitemcheckbox");
}
test("menu bar hiding is an explicit boolean desktop preference", () => {
  assert.equal(parseUiPreferences(null).menuBarAutoHide, false);
  assert.equal(parseUiPreferences('{"menuBarAutoHide":true}').menuBarAutoHide, true);
  assert.equal(parseUiPreferences('{"menuBarAutoHide":"true"}').menuBarAutoHide, undefined);
});
test("menu-bar context toggle reclaims the shared stage without remounting any app or draft", async () => withFineMenuBar(async () => {
  await mount(); const editor = dom.document.querySelector("textarea")!;
  await flush(() => editor.focus());
  await openMenuBarContext();
  await click("自动隐藏菜单栏");
  const system = dom.document.querySelector<HTMLElement>(".os-menubar-system")!;
  assert.equal(system.dataset.autoHide, "true");
  assert.equal(JSON.parse(dom.localStorage.getItem(UI_PREFERENCES_KEY)!).menuBarAutoHide, true);
  assert.equal(dom.document.activeElement, editor);
  await act(async () => { await delay(260); });
  assert.equal(system.dataset.visible, "false");
  for (const page of ["Agent", "岗位地图", "资料", "简历"]) { await click(page); assert.equal(system.dataset.autoHide, "true"); }
  assert.equal(dom.document.querySelector("textarea"), editor);
  assert.equal(editor.value, "合成草稿");
  await flush(() => root!.unmount()); root = undefined; dom.document.body.replaceChildren(); await mount();
  assert.equal(dom.document.querySelector<HTMLElement>(".os-menubar-system")!.dataset.autoHide, "true");
}));
test("menu edge reveals on hover, cancels leave during crossing, and waits for keyboard focus", async () => withFineMenuBar(async () => {
  dom.localStorage.setItem(UI_PREFERENCES_KEY, '{"menuBarAutoHide":true}'); await mount();
  const system = dom.document.querySelector<HTMLElement>(".os-menubar-system")!;
  const edge = dom.document.querySelector<HTMLElement>(".os-menubar-edge")!;
  await flush(() => edge.dispatchEvent(new dom.PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" })));
  assert.equal(system.dataset.visible, "true");
  await flush(() => edge.dispatchEvent(new dom.PointerEvent("pointerout", { bubbles: true, pointerType: "mouse" })));
  await flush(() => dom.document.querySelector(".os-menubar")!.dispatchEvent(new dom.PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" })));
  await act(async () => { await delay(260); });
  assert.equal(system.dataset.visible, "true");
  await flush(() => button("返回简历工作室").focus());
  await flush(() => system.dispatchEvent(new dom.PointerEvent("pointerout", { bubbles: true, pointerType: "mouse" })));
  await act(async () => { await delay(260); });
  assert.equal(system.dataset.visible, "true");
  await flush(() => dom.document.querySelector<HTMLElement>("textarea")!.focus());
  await act(async () => { await delay(260); });
  assert.equal(system.dataset.visible, "false");
}));
test("menu settings and cross-window updates share the same preference, never a business write", async () => withFineMenuBar(async () => {
  await mount(); const editor = dom.document.querySelector("textarea");
  await click("打开系统设置"); await click("桌面与 Dock"); await click("自动隐藏菜单栏");
  assert.equal(dom.document.querySelector<HTMLElement>(".os-menubar-system")!.dataset.autoHide, "true");
  dom.localStorage.setItem(UI_PREFERENCES_KEY, '{"menuBarAutoHide":false}');
  await flush(() => dom.dispatchEvent(new dom.StorageEvent("storage", { key: UI_PREFERENCES_KEY })));
  assert.equal(dom.document.querySelector<HTMLElement>(".os-menubar-system")!.dataset.autoHide, "false");
  assert.equal(dom.document.querySelector("textarea"), editor);
}));
test("keyboard context menu cancels with Escape, and coarse/narrow input remains permanently visible", async () => {
  dom.localStorage.setItem(UI_PREFERENCES_KEY, '{"menuBarAutoHide":true}');
  dom.happyDOM.setWindowSize({ width: 390, height: 800 }); await mount();
  const system = dom.document.querySelector<HTMLElement>(".os-menubar-system")!;
  assert.equal(system.dataset.autoHide, "false");
  assert.equal(system.dataset.visible, "true");
  const brand = button("返回简历工作室");
  await flush(() => brand.focus());
  await flush(() => brand.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true })));
  assert.ok(dom.document.querySelector('[role="menuitemcheckbox"]'));
  await flush(() => dom.document.activeElement!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  assert.equal(dom.document.querySelector('[role="menuitemcheckbox"]'), null);
  assert.equal(dom.document.activeElement, brand);
  assert.equal(JSON.parse(dom.localStorage.getItem(UI_PREFERENCES_KEY)!).menuBarAutoHide, true);
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
test("clicking the active Dock app minimizes it and clicking again restores it", async () => {
  await mount();
  await click("简历");
  assert.equal(dom.document.querySelector(".os-business-window")!.getAttribute("data-hidden"), "true");
  await click("简历");
  assert.equal(dom.document.querySelector(".os-business-window")!.getAttribute("data-hidden"), "false");
  await click("系统设置");
  assert.equal(dom.document.querySelector(".os-settings-window")!.getAttribute("data-hidden"), "false");
  await click("系统设置");
  assert.equal(dom.document.querySelector(".os-settings-window")!.getAttribute("data-hidden"), "true");
});
test("settings manage real preferences and restore focus without unmounting business content", async () => {
  await mount();
  const editor = dom.document.querySelector("textarea");
  await click("打开系统设置");
  assert.equal(dom.document.querySelector(".os-business-window")!.hasAttribute("inert"), false);
  assert.equal(dom.document.activeElement, dom.document.querySelector(".os-settings-window .os-traffic button"));
  await click("深色"); await click("桌面与 Dock"); await click("自动隐藏 Dock");
  const midnight = [...dom.document.querySelectorAll(".os-wallpaper-card-title")].find(title => title.textContent === "原厂 · 暮色");
  assert.ok(midnight, "the classic Midnight wallpaper must remain selectable");
  await flush(() => midnight.closest<HTMLButtonElement>("button")!.click());
  await click("辅助功能"); await click("减少动态效果");
  assert.deepEqual(JSON.parse(dom.localStorage.getItem(UI_PREFERENCES_KEY)!), { ...defaultDesktopPreferences, locale: "zh", theme: "dark", dockAutoHide: false, wallpaper: "midnight", reduceMotion: true });
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
test("crossing the Dock edge cancels the pending hide and focused controls stay revealed", async () => {
  await mount();
  const edge = dom.document.querySelector(".os-dock-edge")!;
  const dock = dom.document.querySelector(".os-dock")!;
  const system = dom.document.querySelector(".os-dock-system")!;
  await flush(() => edge.dispatchEvent(new dom.PointerEvent("pointerover", { bubbles: true })));
  await flush(() => edge.dispatchEvent(new dom.PointerEvent("pointerout", { bubbles: true })));
  await flush(() => dock.dispatchEvent(new dom.PointerEvent("pointerover", { bubbles: true })));
  await act(async () => { await delay(240); });
  assert.equal(system.getAttribute("data-visible"), "true");
  await flush(() => button("简历").focus());
  await flush(() => dock.dispatchEvent(new dom.PointerEvent("pointerout", { bubbles: true })));
  await act(async () => { await delay(240); });
  assert.equal(system.getAttribute("data-visible"), "true");
  await flush(() => button("返回简历工作室").focus());
  await act(async () => { await delay(240); });
  assert.equal(system.getAttribute("data-visible"), "false");
});
test("moving keyboard focus away does not hide a hovered Dock", async () => {
  await mount();
  const dock = dom.document.querySelector(".os-dock")!;
  await flush(() => dock.dispatchEvent(new dom.PointerEvent("pointerover", { bubbles: true })));
  await flush(() => button("简历").focus());
  await flush(() => button("返回简历工作室").focus());
  await act(async () => { await delay(240); });
  assert.equal(dom.document.querySelector(".os-dock-system")!.getAttribute("data-visible"), "true");
});
test("Escape closes settings and returns focus without replacing the draft", async () => {
  await mount(); const editor = dom.document.querySelector("textarea");
  await click("打开系统设置");
  await flush(() => dom.document.activeElement!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(dom.document.querySelector(".os-settings-window")!.getAttribute("data-hidden"), "true");
  assert.equal(dom.document.activeElement, button("系统设置"));
  assert.equal(dom.document.querySelector("textarea"), editor);
});
test("narrow windows support titlebar maximization", async () => {
  const matchMedia = dom.matchMedia.bind(dom);
  dom.matchMedia = ((query: string) => {
    const result = matchMedia(query);
    if (query === "(max-width: 940px)") Object.defineProperty(result, "matches", { value: true });
    return result;
  }) as typeof dom.matchMedia;
  try {
    await mount();
    await flush(() => dom.document.querySelector(".os-business-window .os-window-toolbar")!.dispatchEvent(new dom.MouseEvent("dblclick", { bubbles: true })));
    assert.equal(dom.document.querySelector(".os-business-window")!.classList.contains("is-maximized"), false);
  } finally { dom.matchMedia = matchMedia; }
});
test("window maximize and restore do not replace the editor", async () => {
  await mount(); const editor = dom.document.querySelector("textarea");
  const control = dom.document.querySelector<HTMLButtonElement>(".os-business-window .os-traffic button:nth-child(3)")!;
  await flush(() => control.click());
  assert.equal(dom.document.querySelector(".os-business-window")!.classList.contains("is-maximized"), false);
  await flush(() => control.click());
  assert.equal(dom.document.querySelector(".os-business-window")!.classList.contains("is-maximized"), true);
  assert.equal(dom.document.querySelector("textarea"), editor);
});
test("dragging stays inside viewport bounds and owned gestures stop on release, cancel, blur and viewport resize", async () => {
  await mount();
  await click("还原窗口大小");
  const window = dom.document.querySelector<HTMLElement>(".os-business-window")!;
  const toolbar = window.querySelector<HTMLElement>(".os-window-toolbar")!;
  mockWindowRect(window, 24, 56, 800, 600);
  const capture = mockPointerCapture(toolbar);
  await flush(() => toolbar.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 7, clientX: 400, clientY: 70 })));
  await flush(() => toolbar.dispatchEvent(new dom.PointerEvent("pointermove", { bubbles: true, pointerId: 8, clientX: 4000, clientY: 4000 })));
  await flush(() => toolbar.dispatchEvent(new dom.PointerEvent("pointercancel", { bubbles: true, pointerId: 8 })));
  assert.equal(window.dataset.dragging, "true");
  assert.equal(window.dataset.snapMode, "centered");
  await flush(() => toolbar.dispatchEvent(new dom.PointerEvent("pointermove", { bubbles: true, pointerId: 7, clientX: 4000, clientY: 4000 })));
  assert.equal(window.style.getPropertyValue("--window-x"), "350px");
  assert.equal(window.style.getPropertyValue("--window-y"), "226px");
  assert.equal(window.style.getPropertyValue("--window-width"), "922px");
  assert.equal(window.style.getPropertyValue("--window-height"), "640px");
  await flush(() => toolbar.dispatchEvent(new dom.PointerEvent("pointerup", { bubbles: true, pointerId: 7 })));
  assert.equal(capture.size, 0);
  await flush(() => toolbar.dispatchEvent(new dom.PointerEvent("pointermove", { bubbles: true, pointerId: 7, clientX: -4000, clientY: -4000 })));
  assert.equal(window.style.getPropertyValue("--window-x"), "350px");
  const maximize = window.querySelector<HTMLButtonElement>(".os-traffic button:nth-child(3)")!;
  await flush(() => maximize.click());
  await flush(() => maximize.click());
  assert.equal(window.dataset.snapMode, "custom");
  assert.equal(window.style.getPropertyValue("--window-x"), "350px");
  assert.equal(window.style.getPropertyValue("--window-y"), "226px");
  await flush(() => toolbar.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 7, clientX: 400, clientY: 270 })));
  assert.equal(window.dataset.dragging, "true");
  await flush(() => dom.dispatchEvent(new dom.Event("blur")));
  assert.equal(window.dataset.dragging, "false");
  assert.equal(capture.size, 0);
  await flush(() => toolbar.dispatchEvent(new dom.PointerEvent("pointermove", { bubbles: true, pointerId: 7, clientX: -4000, clientY: -4000 })));
  assert.equal(window.style.getPropertyValue("--window-x"), "350px");
  await flush(() => toolbar.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 7, clientX: 400, clientY: 270 })));
  await flush(() => toolbar.dispatchEvent(new dom.PointerEvent("pointermove", { bubbles: true, pointerId: 7, clientX: -4000, clientY: 270 })));
  assert.ok(dom.document.querySelector(".os-snap-guide.is-left"));
  await flush(() => toolbar.dispatchEvent(new dom.PointerEvent("pointercancel", { bubbles: true, pointerId: 7 })));
  assert.equal(window.dataset.snapMode, "custom", "cancellation must not adopt the snap preview");
  assert.equal(dom.document.querySelector(".os-snap-guide"), null);
  await flush(() => toolbar.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 7, clientX: 400, clientY: 270 })));
  await flush(() => { dom.happyDOM.setWindowSize({ width: 640, height: 500 }); dom.dispatchEvent(new dom.Event("resize")); });
  assert.equal(window.dataset.dragging, "false");
  assert.equal(capture.size, 0);
  assert.equal(window.style.getPropertyValue("--window-x"), "8px");
  assert.equal(window.style.getPropertyValue("--window-y"), "4px");
  assert.equal(window.style.getPropertyValue("--window-width"), "624px");
  assert.equal(window.style.getPropertyValue("--window-height"), "462px");
  await flush(() => toolbar.dispatchEvent(new dom.PointerEvent("pointermove", { bubbles: true, pointerId: 7, clientX: 4000, clientY: 4000 })));
  assert.equal(window.style.getPropertyValue("--window-x"), "8px");
});
test("restored windows expose eight resize handles and preserve dimensions across maximize", async () => {
  await mount();
  await flush(() => dom.document.querySelector<HTMLButtonElement>(".os-business-window .os-traffic button:nth-child(3)")!.click());
  const win = dom.document.querySelector<HTMLElement>(".os-business-window")!;
  const editor = dom.document.querySelector("textarea");
  mockWindowRect(win, 40, 60, 600, 500);
  assert.equal(win.querySelectorAll(".os-resize-handle").length, 8);
  assert.equal(dom.document.querySelectorAll(".os-settings-window .os-resize-handle").length, 8);
  const handle = win.querySelector<HTMLElement>(".os-resize-se")!;
  mockPointerCapture(handle);
  await flush(() => handle.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientX: 640, clientY: 560 })));
  await flush(() => handle.dispatchEvent(new dom.PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 540, clientY: 460 })));
  assert.equal(win.style.getPropertyValue("--window-width"), "500px");
  assert.equal(win.style.getPropertyValue("--window-height"), "400px");
  await flush(() => handle.dispatchEvent(new dom.PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: -4000, clientY: -4000 })));
  assert.equal(win.style.getPropertyValue("--window-width"), "420px");
  assert.equal(win.style.getPropertyValue("--window-height"), "300px");
  await flush(() => handle.dispatchEvent(new dom.PointerEvent("pointercancel", { bubbles: true, pointerId: 1 })));
  assert.equal(win.dataset.resizing, "false");
  const maximize = win.querySelector<HTMLButtonElement>(".os-traffic button:nth-child(3)")!;
  await flush(() => maximize.click());
  assert.equal(win.dataset.snapMode, "maximized");
  assert.equal(win.querySelectorAll(".os-resize-handle").length, 8, "handles remain mounted; CSS controls maximized visibility");
  await flush(() => maximize.click());
  assert.equal(win.style.getPropertyValue("--window-width"), "420px");
  assert.equal(dom.document.querySelector("textarea"), editor);
  await click("Agent");
  assert.equal(win.dataset.sized, "false");
  await click("简历");
  assert.equal(win.style.getPropertyValue("--window-width"), "420px");
  const key = new dom.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowLeft" });
  await flush(() => win.querySelector(".os-resize-nw")!.dispatchEvent(key));
  assert.equal(key.defaultPrevented, true);
  assert.equal(win.style.getPropertyValue("--window-width"), "430px");
  assert.equal(win.style.getPropertyValue("--window-x"), "30px");
  await flush(() => handle.dispatchEvent(new dom.KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight", shiftKey: true })));
  assert.equal(win.style.getPropertyValue("--window-width"), "470px");
  const unrelatedKey = new dom.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" });
  await flush(() => handle.dispatchEvent(unrelatedKey));
  assert.equal(unrelatedKey.defaultPrevented, false);
  await flush(() => dom.dispatchEvent(new dom.Event("resize")));
  assert.equal(win.dataset.sized, "true");
  assert.equal(win.dataset.snapMode, "custom");
  assert.equal(win.style.getPropertyValue("--window-width"), "470px");
});

test("bottom resize handles can grow into Dock clearance and stop flush with the screen edge", async () => {
  await mount();
  await click("还原窗口大小");
  for (const edge of ["s", "se", "sw"]) {
    const win = dom.document.querySelector<HTMLElement>(".os-business-window")!;
    const bottom = dom.innerHeight - 92;
    mockWindowRect(win, 40, 60, 600, bottom - 60);
    const handle = win.querySelector<HTMLElement>(`.os-resize-${edge}`)!;
    mockPointerCapture(handle);
    await flush(() => handle.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 3, clientX: 640, clientY: bottom })));
    await flush(() => handle.dispatchEvent(new dom.PointerEvent("pointermove", { bubbles: true, pointerId: 3, clientX: 640, clientY: bottom + 40 })));
    assert.equal(win.style.getPropertyValue("--window-height"), `${bottom + 40 - 60}px`, `${edge} must grow beyond the old Dock boundary`);
    assert.equal(win.style.getPropertyValue("--window-y"), "26px", "position is relative to the stage below the 34px menu bar");
    await flush(() => handle.dispatchEvent(new dom.PointerEvent("pointermove", { bubbles: true, pointerId: 3, clientX: 640, clientY: dom.innerHeight + 1000 })));
    assert.equal(win.style.getPropertyValue("--window-height"), `${dom.innerHeight - 60}px`, `${edge} must reach the screen bottom without a gap or overflow`);
    await flush(() => handle.dispatchEvent(new dom.PointerEvent("pointerup", { bubbles: true, pointerId: 3 })));
    assert.equal(win.dataset.resizing, "false");
    await flush(() => handle.dispatchEvent(new dom.KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp", shiftKey: true })));
    assert.equal(win.style.getPropertyValue("--window-height"), `${dom.innerHeight - 100}px`, "Shift keyboard resizing uses a 40px step");
    await flush(() => handle.dispatchEvent(new dom.KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown", shiftKey: true })));
    assert.equal(win.style.getPropertyValue("--window-height"), `${dom.innerHeight - 60}px`, "Keyboard resizing uses the same screen-bottom boundary");
  }
});

test("resize ownership survives wrong pointers and stops on lost capture, app changes, hiding and unmount", async () => {
  await mount(); await click("还原窗口大小");
  const win = dom.document.querySelector<HTMLElement>(".os-business-window")!;
  const editor = dom.document.querySelector("textarea");
  mockWindowRect(win, 40, 60, 600, 500);
  const handle = win.querySelector<HTMLElement>(".os-resize-se")!;
  const capture = mockPointerCapture(handle);
  const pointer = (type: string, id: number, x = 640, y = 560) => handle.dispatchEvent(new dom.PointerEvent(type, { bubbles: true, button: 0, pointerId: id, clientX: x, clientY: y }));
  await flush(() => pointer("pointerdown", 71));
  await flush(() => pointer("pointermove", 71, 740, 610));
  const resized = dom.localStorage.getItem("betterme.window.layouts.v2");
  await flush(() => pointer("pointercancel", 72));
  await flush(() => pointer("pointermove", 72, -4000, -4000));
  assert.equal(win.dataset.resizing, "true");
  assert.equal(capture.has(71), true);
  assert.equal(dom.localStorage.getItem("betterme.window.layouts.v2"), resized);
  await flush(() => pointer("lostpointercapture", 71));
  assert.equal(win.dataset.resizing, "false");
  assert.equal(capture.size, 0);
  await flush(() => pointer("pointermove", 71, 4000, 4000));
  assert.equal(dom.localStorage.getItem("betterme.window.layouts.v2"), resized);

  await flush(() => pointer("pointerdown", 73, 740, 610));
  await flush(() => pointer("pointermove", 73, 760, 630));
  await click("Agent");
  assert.equal(win.dataset.layoutKey, "agent");
  assert.equal(win.dataset.snapMode, "maximized");
  assert.equal(win.dataset.resizing, "false");
  assert.equal(capture.size, 0);
  await flush(() => pointer("pointermove", 73, 4000, 4000));
  assert.equal(win.style.getPropertyValue("--window-width"), "1000px");
  assert.equal(JSON.parse(dom.localStorage.getItem("betterme.window.layouts.v2")!).agent, undefined);
  await click("简历");
  assert.equal(win.style.getPropertyValue("--window-width"), "720px");
  assert.equal(dom.document.querySelector("textarea"), editor);

  await flush(() => pointer("pointerdown", 74, 760, 630));
  await click("最小化简历工作室");
  const hidden = dom.localStorage.getItem("betterme.window.layouts.v2");
  assert.equal(win.dataset.hidden, "true");
  assert.equal(win.dataset.resizing, "false");
  assert.equal(capture.size, 0);
  await flush(() => pointer("pointermove", 74, 4000, 4000));
  assert.equal(dom.localStorage.getItem("betterme.window.layouts.v2"), hidden);
  await click("简历");
  assert.equal(dom.document.querySelector("textarea"), editor);
  assert.equal(editor!.value, "合成草稿");

  await flush(() => pointer("pointerdown", 75, 760, 630));
  const beforeUnmount = dom.localStorage.getItem("betterme.window.layouts.v2");
  await flush(() => root!.unmount()); root = undefined;
  assert.equal(capture.size, 0);
  await flush(() => pointer("pointermove", 75, 4000, 4000));
  assert.equal(dom.localStorage.getItem("betterme.window.layouts.v2"), beforeUnmount);
});

test("viewport clamping fits narrow screens without negative sizes and cancels an active resize", async () => {
  await mount(); await click("还原窗口大小");
  const win = dom.document.querySelector<HTMLElement>(".os-business-window")!;
  mockWindowRect(win, 40, 60, 600, 500);
  const handle = win.querySelector<HTMLElement>(".os-resize-se")!;
  const capture = mockPointerCapture(handle);
  await flush(() => handle.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 5, clientX: 640, clientY: 560 })));
  await flush(() => { dom.happyDOM.setWindowSize({ width: 300, height: 260 }); dom.dispatchEvent(new dom.Event("resize")); });
  assert.equal(win.dataset.snapMode, "custom");
  assert.equal(win.dataset.resizing, "false");
  assert.equal(capture.size, 0);
  assert.equal(win.style.getPropertyValue("--window-x"), "8px");
  assert.equal(win.style.getPropertyValue("--window-y"), "4px");
  assert.equal(win.style.getPropertyValue("--window-width"), "284px");
  assert.equal(win.style.getPropertyValue("--window-height"), "222px");
  await flush(() => handle.dispatchEvent(new dom.PointerEvent("pointermove", { bubbles: true, pointerId: 5, clientX: 4000, clientY: 4000 })));
  assert.equal(win.style.getPropertyValue("--window-width"), "284px");
  await flush(() => handle.dispatchEvent(new dom.KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft", shiftKey: true })));
  assert.equal(win.style.getPropertyValue("--window-width"), "284px", "the minimum width adapts to the available viewport");
});

test("viewport persistence never writes another window key from a stale layout snapshot", async () => {
  dom.localStorage.setItem("betterme.window.layouts.v2", JSON.stringify({ resume: { snapMode: "custom", position: { x: 40, y: 26 }, size: { width: 600, height: 500 } } }));
  await mount();
  const win = dom.document.querySelector<HTMLElement>(".os-business-window")!;
  mockWindowRect(win, 40, 60, 600, 500);
  const handle = win.querySelector<HTMLElement>(".os-resize-se")!;
  mockPointerCapture(handle);
  await flush(() => handle.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 6, clientX: 640, clientY: 560 })));
  await flush(() => handle.dispatchEvent(new dom.PointerEvent("pointermove", { bubbles: true, pointerId: 6, clientX: 720, clientY: 600 })));
  await flush(() => handle.dispatchEvent(new dom.PointerEvent("pointerup", { bubbles: true, pointerId: 6 })));
  assert.deepEqual(JSON.parse(dom.localStorage.getItem("betterme.window.layouts.v2")!).resume.size, { width: 680, height: 540 });
  await flush(() => { dom.happyDOM.setWindowSize({ width: 600, height: 800 }); dom.dispatchEvent(new dom.Event("resize")); });
  assert.deepEqual(JSON.parse(dom.localStorage.getItem("betterme.window.layouts.v2")!).resume.size, { width: 584, height: 540 });
  assert.equal(win.style.getPropertyValue("--window-width"), "584px");
  assert.equal(win.style.getPropertyValue("--window-height"), "540px");
  assert.equal(dom.document.querySelector<HTMLElement>(".os-settings-window")!.dataset.snapMode, "centered");
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
  await mount(); await click("打开系统设置"); await click("模型与推理");
  assert.equal(aiOpens + networkOpens, 0);
  await click("模型与 AI 配置"); await click("网络与代理");
  assert.equal(aiOpens, 1); assert.equal(networkOpens, 1);
});
test("autopilot studio Dock item navigates to autopilot and pinned micro-apps open in null-origin sandbox host", async () => {
  const { installMicroApp, createOfferBackcheckRadarApp } = await import("../src/lib/micro-app-registry.ts");
  await mount();
  await flush(() => dom.document.querySelector<HTMLButtonElement>('[data-dock-app="autopilot"]')!.click());
  assert.equal(dom.document.querySelector("output")!.textContent, "autopilot");
  assert.ok(dom.document.querySelector('.os-app-menu [aria-current="page"]')!.textContent!.includes("自动化工坊"));
  await flush(() => { installMicroApp(createOfferBackcheckRadarApp()); });
  const microBtn = dom.document.querySelector<HTMLButtonElement>('[data-dock-microapp="offer-backcheck-radar"]');
  assert.ok(microBtn, "Expected pinned micro-app button in Dock");
  await flush(() => microBtn!.click());
  const iframe = dom.document.querySelector<HTMLIFrameElement>('[data-testid="sandboxed-microapp-iframe"]');
  assert.ok(iframe, "Expected sandboxed iframe to render");
  assert.equal(iframe!.getAttribute("sandbox"), "allow-scripts", "Iframe must not have allow-same-origin");
});
