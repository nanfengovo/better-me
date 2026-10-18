import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Window } from "happy-dom";
import { createDemoFactBase, createDefaultResumeView, projectResume } from "@better-me/core";

const dom = new Window({ url: "http://ui-fixture.invalid" });
const React = await import("react");
const globals = { window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage, HTMLElement: dom.HTMLElement, Element: dom.Element, React, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createElement: h, act } = React;
const { createRoot } = await import("react-dom/client");
const { UiPreferencesProvider, UI_PREFERENCES_KEY, parseUiPreferences, initializeUiAppearance, useUiPreferences } = await import("../src/lib/ui-preferences.tsx");
const { WorkspacePreferences } = await import("../src/components/WorkspacePreferences.tsx");
const { ResumeTemplate } = await import("../src/components/ResumeTemplate.tsx");
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("No network permitted in UI preference tests"); };
let root: ReturnType<typeof createRoot> | undefined;

async function flush(action: () => void = () => {}) { await act(async () => { action(); await nextTurn(); await nextTurn(); }); }
async function mount(children: React.ReactNode = h(WorkspacePreferences)) {
  const host = dom.document.createElement("div"); dom.document.body.append(host);
  root = createRoot(host);
  await flush(() => root!.render(h(UiPreferencesProvider, null, children)));
}
function button(label: string) {
  const target = [...dom.document.querySelectorAll("button")].find(item => (item.getAttribute("aria-label") ?? item.textContent?.trim()) === label);
  assert.ok(target, `missing ${label}`); return target;
}
async function click(label: string) { await flush(() => button(label).click()); }
afterEach(async () => {
  if (root) await flush(() => root!.unmount()); root = undefined;
  dom.document.body.replaceChildren(); dom.localStorage.clear();
});
after(() => {
  globalThis.fetch = originalFetch; dom.happyDOM.abort();
  for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
});

test("invalid preference data recovers each setting without accepting extra values", () => {
  for (const raw of [null, "broken", "[]", "null", '{"locale":"fr","theme":"auto"}']) assert.deepEqual(parseUiPreferences(raw), { locale: "zh", theme: "light" });
  assert.deepEqual(parseUiPreferences('{"locale":"en","theme":"dark","apiKey":"ignored"}'), { locale: "en", theme: "dark" });
  assert.deepEqual(parseUiPreferences('{"locale":"zh","theme":"dark"}'), { locale: "zh", theme: "dark" });
});

test("saved appearance is applied before React mount and survives remount", async () => {
  dom.localStorage.setItem(UI_PREFERENCES_KEY, '{"locale":"en","theme":"dark"}');
  assert.deepEqual(initializeUiAppearance(), { locale: "en", theme: "dark" });
  assert.equal(dom.document.documentElement.lang, "en");
  assert.equal(dom.document.documentElement.dataset.theme, "dark");
  await mount();
  assert.equal(button("English").getAttribute("aria-pressed"), "true");
  assert.equal(button("Dark theme").getAttribute("aria-pressed"), "true");
});

test("global controls change only browser preferences while Chinese resume content stays intact", async () => {
  const factBase = createDemoFactBase("2000-01-01T00:00:00.000Z");
  const view = createDefaultResumeView(factBase); view.locale = "zh";
  const before = structuredClone({ factBase, view });
  dom.localStorage.setItem("betterme.official.fixture", "unchanged resume");
  dom.localStorage.setItem("betterme.draft.fixture", "unchanged draft");
  await mount(h(React.Fragment, null, h(WorkspacePreferences), h(ResumeTemplate, { resume: projectResume(factBase, view), templateId: "zh-classic" })));
  const paperBefore = dom.document.querySelector(".resume-document")!.textContent;
  await click("English"); await click("Dark theme");
  assert.equal(dom.document.documentElement.lang, "en");
  assert.equal(dom.document.documentElement.dataset.theme, "dark");
  assert.equal(dom.document.querySelector(".resume-document")!.textContent, paperBefore);
  assert.deepEqual({ factBase, view }, before);
  assert.equal(dom.localStorage.getItem("betterme.official.fixture"), "unchanged resume");
  assert.equal(dom.localStorage.getItem("betterme.draft.fixture"), "unchanged draft");
  assert.deepEqual(JSON.parse(dom.localStorage.getItem(UI_PREFERENCES_KEY)!), { locale: "en", theme: "dark" });
  await click("中文");
  assert.equal(button("深色主题").getAttribute("aria-pressed"), "true");
  await click("浅色主题");
  assert.equal(button("中文").getAttribute("aria-pressed"), "true");
});

test("resume output can change without changing the English dark workspace", async () => {
  function Harness() {
    const [locale, setLocale] = React.useState<"zh" | "en">("zh");
    const preferences = useUiPreferences();
    const factBase = createDemoFactBase("2000-01-01T00:00:00.000Z");
    const view = { ...createDefaultResumeView(factBase), locale };
    return h(React.Fragment, null, h(WorkspacePreferences), h("button", { onClick: () => setLocale("en") }, "English resume"), h("output", null, preferences.locale + "/" + preferences.theme), h(ResumeTemplate, { resume: projectResume(factBase, view), templateId: "zh-classic" }));
  }
  dom.localStorage.setItem(UI_PREFERENCES_KEY, '{"locale":"en","theme":"dark"}');
  await mount(h(Harness));
  assert.match(dom.document.querySelector(".resume-document")!.textContent!, /工作经历/);
  await click("English resume");
  assert.match(dom.document.querySelector(".resume-document")!.textContent!, /Experience/);
  assert.equal(dom.document.querySelector("output")!.textContent, "en/dark");
  assert.equal(button("Dark theme").getAttribute("aria-pressed"), "true");
});

test("another window updates appearance without consuming unrelated resume storage events", async () => {
  await mount();
  await flush(() => dom.dispatchEvent(new dom.StorageEvent("storage", { key: "better-me:document", newValue: '{"locale":"en","theme":"dark"}' })));
  assert.equal(button("中文").getAttribute("aria-pressed"), "true");
  dom.localStorage.setItem(UI_PREFERENCES_KEY, '{"locale":"en","theme":"dark"}');
  await flush(() => dom.dispatchEvent(new dom.StorageEvent("storage", { key: UI_PREFERENCES_KEY, newValue: '{"locale":"en","theme":"dark"}' })));
  assert.equal(button("English").getAttribute("aria-pressed"), "true");
  assert.equal(button("Dark theme").getAttribute("aria-pressed"), "true");
});

test("queued older preference events cannot overwrite the latest stored choice or echo writes", async () => {
  await mount();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
  let writes = 0;
  const proxy = { getItem: (key: string) => dom.localStorage.getItem(key), setItem: () => { writes += 1; throw new Error("Remote changes must not be written back"); } };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: proxy });
  try {
    dom.localStorage.setItem(UI_PREFERENCES_KEY, '{"locale":"en","theme":"light"}');
    await flush(() => dom.dispatchEvent(new dom.StorageEvent("storage", { key: UI_PREFERENCES_KEY, newValue: '{"locale":"zh","theme":"dark"}' })));
    assert.equal(button("English").getAttribute("aria-pressed"), "true");
    assert.equal(button("Light theme").getAttribute("aria-pressed"), "true");
    assert.equal(writes, 0);
    assert.deepEqual(JSON.parse(dom.localStorage.getItem(UI_PREFERENCES_KEY)!), { locale: "en", theme: "light" });
  } finally { Object.defineProperty(globalThis, "localStorage", original); }
});

test("blocked storage still allows switching and explains the persistence limitation", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("storage blocked"); } });
  try {
    await mount(); await click("English"); await click("Dark theme");
    assert.equal(dom.document.documentElement.lang, "en");
    assert.equal(dom.document.documentElement.dataset.theme, "dark");
    assert.match(dom.document.body.textContent!, /preferences could not be saved/);
  } finally { Object.defineProperty(globalThis, "localStorage", original); }
});
