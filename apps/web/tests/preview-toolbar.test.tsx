import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, afterEach } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Window } from "happy-dom";
import { createDemoFactBase, createDefaultResumeView, projectResume, type ProjectedResume, type ResumeView } from "@better-me/core";

// Exercise the real toolbar in a DOM, independently of its visual stylesheet.
const css = registerHooks({ load(url, context, nextLoad) {
  return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : nextLoad(url, context);
} });
const dom = new Window({ url: "http://preview-toolbar-fixture.invalid" });
const ownAnimate = Object.getOwnPropertyDescriptor(dom.HTMLElement.prototype, "animate");
const nativeAnimate = dom.HTMLElement.prototype.animate;
const nativeMatchMedia = dom.matchMedia.bind(dom);
const React = await import("react");
const globals = {
  window: dom, document: dom.document, navigator: dom.navigator,
  localStorage: dom.localStorage, HTMLElement: dom.HTMLElement, Element: dom.Element,
  Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
};
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createElement: h, act } = React;
const { createRoot } = await import("react-dom/client");
const { UiPreferencesProvider } = await import("../src/lib/ui-preferences.tsx");
const { ResumePreview } = await import("../src/components/ResumePreview.tsx");
let root: ReturnType<typeof createRoot> | undefined;

async function flush(action: () => void = () => {}) {
  await act(async () => { action(); await nextTurn(); await nextTurn(); });
}
async function renderResume(resume: ProjectedResume, view: ResumeView, locale: "zh" | "en" = "en") {
  await flush(() => root!.render(h(UiPreferencesProvider, { initialPreferences: { locale, theme: "light" } }, h(ResumePreview, { resume, view }))));
}
async function mount(locale: "zh" | "en" = "en") {
  const factBase = createDemoFactBase("2000-01-01T00:00:00.000Z");
  factBase.profile.displayName = { zh: "合成姓名", en: "Fixture Name" };
  const view = createDefaultResumeView(factBase);
  const resume = projectResume(factBase, view);
  dom.document.body.innerHTML = '<main id="fixture"></main><button id="outside">Outside</button>';
  root = createRoot(dom.document.getElementById("fixture")!);
  await renderResume(resume, view, locale);
  return { factBase, view, resume };
}
function button(label: string) {
  const found = [...dom.document.querySelectorAll("button")].find(item => (item.getAttribute("aria-label") ?? item.textContent?.trim()) === label);
  assert.ok(found, `missing button: ${label}`);
  return found;
}
function menu() { return dom.document.querySelector('[role="menu"]'); }
function items() { return [...dom.document.querySelectorAll('[role="menuitem"]')]; }
async function key(target: Element, value: string) {
  await flush(() => target.dispatchEvent(new dom.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })));
}
async function pointerClick(target: Element) {
  await flush(() => {
    target.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true }));
    (target as HTMLElement).focus();
    (target as HTMLElement).click();
  });
}
function expectActive(target: Element | undefined) { assert.ok(dom.document.activeElement === target, `expected focus on ${target?.getAttribute("aria-label") ?? target?.textContent?.trim()}; received ${dom.document.activeElement?.getAttribute("aria-label") ?? dom.document.activeElement?.textContent?.trim().slice(0, 100)}`); }

afterEach(async () => {
  if (root) await flush(() => root!.unmount());
  root = undefined;
  if (ownAnimate) Object.defineProperty(dom.HTMLElement.prototype, "animate", ownAnimate);
  else Reflect.deleteProperty(dom.HTMLElement.prototype, "animate");
  dom.matchMedia = nativeMatchMedia;
  dom.document.body.replaceChildren(); dom.localStorage.clear();
});
after(async () => {
  css.deregister(); await dom.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test("export menu opens from either arrow key and supports cyclic navigation, Home and End", async () => {
  await mount();
  const trigger = button("More export formats");
  assert.equal(trigger.getAttribute("aria-haspopup"), "menu");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(menu(), null);
  await flush(() => trigger.focus());
  await key(trigger, "ArrowDown");
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  assert.equal(menu()?.id, trigger.getAttribute("aria-controls"));
  const options = items();
  assert.equal(options.length, 4);
  expectActive(options[0]);
  await key(options[0]!, "ArrowUp"); expectActive(options[3]);
  await key(options[3]!, "ArrowDown"); expectActive(options[0]);
  await key(options[0]!, "End"); expectActive(options[3]);
  await key(options[3]!, "Home"); expectActive(options[0]);
  await key(options[0]!, "ArrowDown"); expectActive(options[1]);
  await key(options[1]!, "Escape");
  assert.equal(menu(), null); expectActive(trigger);
  await key(trigger, "ArrowUp"); expectActive(items()[3]);
});

test("keyboard navigation also enters a menu that was already opened by pointer", async () => {
  await mount();
  const trigger = button("More export formats");
  await pointerClick(trigger);
  assert.ok(menu()); expectActive(trigger);
  await key(trigger, "ArrowDown"); expectActive(items()[0]);
  await key(items()[0]!, "Escape");
  await pointerClick(trigger);
  await key(trigger, "ArrowUp"); expectActive(items()[3]);
});

test("Escape returns menu focus while outside pointer and focus changes preserve the new destination", async () => {
  await mount();
  const trigger = button("More export formats");
  const outside = dom.document.getElementById("outside")!;
  await key(trigger, "ArrowDown");
  await key(items()[0]!, "Escape");
  assert.equal(menu(), null); expectActive(trigger);

  await key(trigger, "ArrowDown");
  await flush(() => menu()!.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true })));
  assert.ok(menu(), "a pointer press within the menu must not dismiss it");
  await flush(() => outside.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true })));
  assert.equal(menu(), null);
  await flush(() => outside.focus()); expectActive(outside);

  await key(trigger, "ArrowDown");
  await flush(() => outside.focus());
  assert.equal(menu(), null); expectActive(outside);
});

test("help is operable by click, describes export differences and dismisses without stealing focus", async () => {
  await mount();
  const help = button("Preview and export information");
  const outside = dom.document.getElementById("outside")!;
  assert.equal(help.getAttribute("aria-expanded"), "false");
  await pointerClick(help);
  const panel = dom.document.getElementById(help.getAttribute("aria-controls")!);
  assert.ok(panel); assert.equal(panel.getAttribute("role"), "region");
  assert.match(panel.textContent!, /DOCX is editable single-column content without photos; PDF keeps the selected template/);
  assert.equal(help.getAttribute("aria-expanded"), "true");
  await key(help, "Escape");
  assert.equal(dom.document.getElementById(panel.id), null); expectActive(help);
  await pointerClick(help);
  await pointerClick(outside);
  assert.equal(help.getAttribute("aria-expanded"), "false"); expectActive(outside);
  await pointerClick(help);
  await flush(() => outside.focus());
  assert.equal(help.getAttribute("aria-expanded"), "false"); expectActive(outside);
});

test("help and export surfaces are mutually exclusive and keep Chinese accessible names", async () => {
  const original = await mount("zh");
  const before = structuredClone(original);
  const help = button("预览与导出说明");
  const trigger = button("更多导出格式");
  await pointerClick(help);
  assert.equal(help.getAttribute("aria-expanded"), "true");
  await pointerClick(trigger);
  assert.ok(menu()); assert.equal(help.getAttribute("aria-expanded"), "false");
  await pointerClick(help);
  assert.equal(menu(), null); assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(help.getAttribute("aria-expanded"), "true");
  assert.deepEqual(original, before, "toolbar surfaces must not write facts or view settings");
});

test("the primary PDF control remains a direct print action with no export menu", async () => {
  await mount();
  let prints = 0;
  Object.defineProperty(dom, "print", { configurable: true, value: () => { prints += 1; } });
  await pointerClick(button("Export PDF / Print"));
  assert.equal(prints, 1); assert.equal(menu(), null);
});

test("only template changes animate; rapid changes safely cancel real unfinished animations", async () => {
  const animations: ReturnType<typeof dom.HTMLElement.prototype.animate>[] = [];
  Object.defineProperty(dom.HTMLElement.prototype, "animate", { configurable: true, value: function (this: HTMLElement, ...args: unknown[]) {
    const animation = nativeAnimate.apply(this, args);
    animations.push(animation);
    return animation;
  } });
  const { resume, view } = await mount();
  assert.equal(animations.length, 0, "initial mounting must not animate");
  const edited = { ...resume, profile: { ...resume.profile, displayName: "Edited synthetic name" } };
  await renderResume(edited, view);
  await pointerClick(button("Zoom in"));
  assert.equal(animations.length, 0, "typing and zooming must not restart a paper animation");
  await renderResume({ ...edited, templateId: "editorial" }, view);
  assert.equal(animations.length, 1);
  await renderResume({ ...edited, templateId: "clean-modern" }, view);
  assert.equal(animations.length, 2);
  assert.equal(animations[0]!.playState, "idle", "a new template must cancel the interrupted transition");
  assert.match(dom.document.querySelector(".resume-document")!.textContent!, /Edited synthetic name/);
  // afterEach unmounts while the second real animation is still unfinished.
  // Any unhandled cancellation rejection fails this test through node:test.
});

test("reduced motion suppresses paper transitions while a template change still renders", async () => {
  let animations = 0;
  Object.defineProperty(dom.HTMLElement.prototype, "animate", { configurable: true, value: function (this: HTMLElement, ...args: unknown[]) {
    animations += 1;
    return nativeAnimate.apply(this, args);
  } });
  dom.matchMedia = query => {
    const media = nativeMatchMedia(query);
    if (query === "(prefers-reduced-motion: reduce)") Object.defineProperty(media, "matches", { value: true });
    return media;
  };
  const { resume, view } = await mount();
  await renderResume({ ...resume, templateId: "editorial" }, view);
  assert.equal(animations, 0);
  assert.equal(dom.document.querySelector(".resume-document")?.getAttribute("data-template"), "editorial");
});
