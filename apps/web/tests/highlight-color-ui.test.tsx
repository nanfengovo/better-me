import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Window } from "happy-dom";
import type { TextStyleRange } from "@better-me/core";

const dom = new Window({ url: "http://highlight-fixture.invalid" });
const React = await import("react");
const globals = { window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createElement: h, act } = React;
const { createRoot } = await import("react-dom/client");
const { TextFormattingField } = await import("../src/components/TextFormattingField.tsx");
const { RichResumeText } = await import("../src/components/RichResumeText.tsx");
const { UiPreferencesProvider } = await import("../src/lib/ui-preferences.tsx");
let root: ReturnType<typeof createRoot> | undefined;
let latest: TextStyleRange[] = [];
let writes: TextStyleRange[][] = [];
let uiLocale: "zh" | "en" = "zh";
let replaceSource: (value: string) => void;
const source = "甲乙丙丁戊己";

async function flush(action: () => void = () => {}) { await act(async () => { action(); await nextTurn(); await nextTurn(); }); }
async function mount(initial: TextStyleRange[] = [], locale: "zh" | "en" = "zh") {
  uiLocale = locale;
  writes = [];
  function Harness() {
    const [ranges, setRanges] = React.useState(initial);
    const [text, setText] = React.useState(source);
    replaceSource = setText;
    latest = ranges;
    return h(React.Fragment, null,
      h(TextFormattingField, { value: text, label: "Fixture", ranges, onChange: () => assert.fail("Color changes must not change factual text"), onStylesChange: (next: TextStyleRange[]) => { writes.push(structuredClone(next)); setRanges(next); } }),
      h("div", { id: "paper" }, h(RichResumeText, { text, ranges })),
      h("button", { id: "outside", type: "button" }, "Outside"),
    );
  }
  dom.document.body.innerHTML = '<main id="fixture"></main>';
  root = createRoot(dom.document.getElementById("fixture")!);
  await flush(() => root!.render(h(UiPreferencesProvider, { initialPreferences: { locale, theme: "dark" } }, h(Harness))));
}
async function select(start: number, end: number) {
  const textarea = dom.document.querySelector("textarea")!;
  await flush(() => { textarea.focus(); textarea.setSelectionRange(start, end); textarea.dispatchEvent(new dom.MouseEvent("mouseup", { bubbles: true })); dom.document.dispatchEvent(new dom.Event("selectionchange", { bubbles: true })); });
  return textarea;
}
function paletteToggle() { return dom.document.querySelector<HTMLButtonElement>(`button[aria-label="${uiLocale === "zh" ? "Fixture高亮颜色" : "Fixture highlight color"}"]`)!; }
function palette() { return dom.document.querySelector<HTMLElement>(`[role="dialog"][aria-label="${uiLocale === "zh" ? "高亮颜色" : "Highlight color"}"]`); }
async function openPalette() { await flush(() => { paletteToggle().focus(); paletteToggle().click(); }); assert.ok(palette()); }
function swatch(zh: string, en: string) { return palette()!.querySelector<HTMLButtonElement>(`button[aria-label="${uiLocale === "zh" ? zh : en}"]`)!; }
async function color(zh: string, en: string) { if (!palette()) await openPalette(); await flush(() => { swatch(zh, en).focus(); swatch(zh, en).click(); }); }
function preview() { return palette()!.querySelector<HTMLElement>('[data-testid="highlight-color-preview"]')!; }
function previewColor() { return [...preview().querySelectorAll<HTMLElement>("*")].find((item) => item.style.backgroundColor)?.style.backgroundColor; }
function inputByLabel(zh: string, en: string) {
  const name = uiLocale === "zh" ? zh : en;
  const direct = palette()!.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`);
  if (direct) return direct;
  const label = [...palette()!.querySelectorAll<HTMLLabelElement>("label")].find((item) => item.textContent?.trim() === name);
  const input = label?.htmlFor ? dom.document.getElementById(label.htmlFor) : label?.querySelector("input");
  assert.ok(input instanceof dom.HTMLInputElement, `Input labeled ${name} exists`);
  return input;
}
function customHex() { return inputByLabel("自定义高亮颜色", "Custom highlight color"); }
function nativeColor() { return inputByLabel("拾取高亮颜色", "Pick highlight color"); }
function applyColorButton() { return [...palette()!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === (uiLocale === "zh" ? "应用颜色" : "Apply color"))!; }
async function enterColor(input: HTMLInputElement, value: string) {
  await flush(() => {
    input.focus();
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new dom.Event("input", { bubbles: true }));
  });
}
async function escapePalette() {
  const target = dom.document.activeElement ?? palette()!;
  await flush(() => target.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(palette(), null);
}
function highlightButton() { return dom.document.querySelector<HTMLButtonElement>(".format-highlight-button")!; }

afterEach(async () => { if (root) await flush(() => root!.unmount()); root = undefined; dom.document.body.replaceChildren(); dom.localStorage.clear(); });
after(async () => { await dom.happyDOM.close(); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });

test("color requires a selection and changing it updates only the selected preview text", async () => {
  await mount([{ start: 0, end: 4, bold: true, highlight: true }]);
  assert.equal(paletteToggle().disabled, true);
  assert.equal(highlightButton().disabled, true);
  const textarea = await select(2, 4);
  await openPalette();
  assert.equal(swatch("黄色", "Yellow").getAttribute("aria-pressed"), "true");
  await color("蓝色", "Blue");
  assert.deepEqual(latest, [{ start: 0, end: 2, bold: true, highlight: true }, { start: 2, end: 4, bold: true, highlight: true, highlightColor: "#cce5ff" }]);
  assert.equal(textarea.value, source);
  assert.equal(textarea.selectionStart, 2); assert.equal(textarea.selectionEnd, 4);
  assert.ok(palette(), "A swatch commit keeps the palette open");
  assert.equal(swatch("蓝色", "Blue").getAttribute("aria-pressed"), "true");
  assert.equal(dom.document.activeElement, swatch("蓝色", "Blue"));
  const parts = [...dom.document.querySelectorAll<HTMLSpanElement>("#paper span")];
  assert.equal(parts[0]!.style.backgroundColor, "#fae6a1");
  assert.equal(parts[1]!.textContent, "丙丁"); assert.equal(parts[1]!.style.backgroundColor, "#cce5ff");
  assert.equal(parts[2]!.style.backgroundColor, "");
  assert.equal(dom.document.getElementById("paper")!.textContent, source);
});

test("toggle removes the color without removing bold and can reuse the last chosen color", async () => {
  await mount([{ start: 0, end: 6, bold: true }]); await select(1, 3); await color("粉色", "Pink"); await escapePalette();
  await flush(() => highlightButton().click());
  assert.deepEqual(latest, [{ start: 0, end: 6, bold: true }]);
  await flush(() => highlightButton().click());
  assert.deepEqual(latest, [
    { start: 0, end: 1, bold: true }, { start: 1, end: 3, bold: true, highlight: true, highlightColor: "#f8cddd" }, { start: 3, end: 6, bold: true },
  ]);
});

test("English dark UI exposes named colors and can unify a mixed selection", async () => {
  await mount([{ start: 0, end: 2, highlight: true, highlightColor: "#cce5ff" }, { start: 2, end: 4, highlight: true, highlightColor: "#f8cddd" }], "en");
  await select(0, 4);
  assert.equal(paletteToggle().getAttribute("aria-label"), "Fixture highlight color");
  assert.equal(paletteToggle().getAttribute("aria-expanded"), "false");
  await openPalette();
  assert.equal(paletteToggle().getAttribute("aria-expanded"), "true");
  for (const [zh, en] of [["黄色", "Yellow"], ["绿色", "Green"], ["蓝色", "Blue"], ["粉色", "Pink"], ["紫色", "Purple"], ["橙色", "Orange"]]) {
    assert.equal(swatch(zh!, en!).getAttribute("aria-label"), en);
    assert.equal(swatch(zh!, en!).getAttribute("aria-pressed"), "false", "A mixed selection does not claim a uniform color");
  }
  await color("紫色", "Purple");
  assert.deepEqual(latest, [{ start: 0, end: 4, highlight: true, highlightColor: "#e2d5f5" }]);
  assert.equal(dom.document.documentElement.dataset.theme, "dark");
  assert.equal(dom.document.getElementById("paper")!.textContent, source);
});

test("overlapping imported ranges cannot mark an unformatted gap as highlighted", async () => {
  await mount([{ start: 0, end: 2, highlight: true }, { start: 0, end: 2, highlight: true }]);
  await select(0, 4);
  assert.equal(highlightButton().getAttribute("aria-pressed"), "false");
  await flush(() => highlightButton().click());
  assert.deepEqual(latest, [{ start: 0, end: 4, highlight: true, highlightColor: "#fae6a1" }]);
});

test("yellow can be selected for plain text and an existing color survives toggling off and on", async () => {
  await mount([{ start: 0, end: 2, highlight: true, highlightColor: "#cce5ff" }]);
  await select(0, 2); await flush(() => highlightButton().click()); await flush(() => highlightButton().click());
  assert.equal(latest[0]!.highlightColor, "#cce5ff");
  await select(2, 4);
  await color("黄色", "Yellow");
  assert.deepEqual(latest, [{ start: 0, end: 2, highlight: true, highlightColor: "#cce5ff" }, { start: 2, end: 4, highlight: true, highlightColor: "#fae6a1" }]);
});

test("keyboard formatting after choosing a color uses the retained selection", async () => {
  await mount(); const textarea = await select(1, 3); await color("绿色", "Green"); await escapePalette();
  await flush(() => { textarea.focus(); textarea.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true })); });
  assert.deepEqual(latest, [{ start: 1, end: 3, bold: true, highlight: true, highlightColor: "#c7ebcf" }]);
  assert.equal(dom.document.activeElement, textarea);
  assert.equal(textarea.selectionStart, 1); assert.equal(textarea.selectionEnd, 3);
});

test("swatch hover and keyboard focus update only a local preview without writing styles", async () => {
  const initial = [{ start: 0, end: 2, highlight: true, highlightColor: "#cce5ff" }];
  await mount(initial); const textarea = await select(0, 2); await openPalette();
  await flush(() => swatch("橙色", "Orange").dispatchEvent(new dom.MouseEvent("mouseover", { bubbles: true })));
  assert.equal(previewColor(), "#ffdab9");
  assert.deepEqual(latest, initial); assert.equal(writes.length, 0);
  assert.equal(dom.document.querySelector<HTMLSpanElement>("#paper span")!.style.backgroundColor, "#cce5ff");
  await flush(() => swatch("紫色", "Purple").focus());
  assert.equal(previewColor(), "#e2d5f5");
  assert.deepEqual(latest, initial); assert.equal(writes.length, 0);
  assert.equal(dom.document.getElementById("paper")!.textContent, source);
  await escapePalette();
  assert.equal(dom.document.activeElement, textarea);
  assert.deepEqual(latest, initial); assert.equal(writes.length, 0);
});

test("custom hex previews locally and commits an arbitrary normalized color to the captured selection", async () => {
  await mount([{ start: 0, end: 6, bold: true }]);
  const textarea = await select(2, 4); await openPalette();
  await enterColor(customHex(), "#12AbCd");
  await flush(() => {
    customHex().setSelectionRange(0, customHex().value.length);
    customHex().dispatchEvent(new dom.MouseEvent("mouseup", { bubbles: true }));
    dom.document.dispatchEvent(new dom.Event("selectionchange", { bubbles: true }));
  });
  assert.equal(previewColor(), "#12abcd");
  assert.equal(applyColorButton().disabled, false);
  assert.equal(writes.length, 0);
  await flush(() => applyColorButton().click());
  assert.deepEqual(latest, [
    { start: 0, end: 2, bold: true }, { start: 2, end: 4, bold: true, highlight: true, highlightColor: "#12abcd" }, { start: 4, end: 6, bold: true },
  ]);
  assert.equal(writes.length, 1);
  assert.equal(textarea.value, source); assert.equal(textarea.selectionStart, 2); assert.equal(textarea.selectionEnd, 4);
  assert.equal(dom.document.getElementById("paper")!.textContent, source);
});

test("invalid custom colors disable apply, explain the error and never change stored styles", async () => {
  await mount(); await select(1, 3); await openPalette();
  for (const invalid of ["#123", "#12345678", "red", "url(https://invalid.example/color)", 'ffffff"']) {
    await enterColor(customHex(), invalid);
    assert.equal(applyColorButton().disabled, true, invalid);
    assert.match(palette()!.textContent!, /六位|6.*(?:hex|HEX)|#[0-9A-Fa-f]{6}/);
    await flush(() => applyColorButton().click());
    assert.deepEqual(latest, []); assert.equal(writes.length, 0);
    assert.doesNotMatch(preview().getAttribute("style") ?? "", /invalid\.example|url\(/);
  }
});

test("native color picker previews without committing until Apply color", async () => {
  await mount([], "en"); await select(1, 5); await openPalette();
  assert.equal(nativeColor().type, "color");
  await enterColor(nativeColor(), "#203040");
  assert.equal(customHex().value.toLowerCase(), "#203040");
  assert.equal(previewColor(), "#203040");
  assert.equal(writes.length, 0); assert.deepEqual(latest, []);
  await flush(() => applyColorButton().click());
  assert.deepEqual(latest, [{ start: 1, end: 5, highlight: true, highlightColor: "#203040" }]);
  assert.equal(dom.document.getElementById("paper")!.textContent, source);
});

test("Escape and an outside click discard uncommitted custom colors and preserve focus destinations", async () => {
  const initial = [{ start: 0, end: 2, highlight: true, highlightColor: "#cce5ff" }];
  await mount(initial); const textarea = await select(0, 2); await openPalette();
  await enterColor(customHex(), "#123456"); await escapePalette();
  assert.equal(dom.document.activeElement, textarea);
  assert.deepEqual(latest, initial); assert.equal(writes.length, 0);
  await openPalette();
  assert.equal(customHex().value.toLowerCase(), "#cce5ff", "An uncommitted custom color is not remembered as the current color");
  await enterColor(customHex(), "#654321");
  const outside = dom.document.getElementById("outside")!;
  await flush(() => { outside.focus(); outside.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true })); outside.click(); });
  assert.equal(palette(), null);
  assert.equal(dom.document.activeElement, outside);
  assert.deepEqual(latest, initial); assert.equal(writes.length, 0);
  assert.equal(textarea.selectionStart, 0); assert.equal(textarea.selectionEnd, 2);
});

test("a changed source closes the palette and prevents applying a captured range to different text", async () => {
  await mount(); await select(1, 3); await openPalette();
  assert.equal(preview().querySelector("mark")!.textContent, "乙丙");
  await enterColor(customHex(), "#123456");
  const staleApply = applyColorButton();
  const changed = "更改后的事实原文";
  await flush(() => replaceSource(changed));
  assert.equal(palette(), null);
  assert.equal(paletteToggle().getAttribute("aria-expanded"), "false");
  await flush(() => staleApply.click());
  assert.equal(writes.length, 0); assert.deepEqual(latest, []);
  assert.equal(dom.document.querySelector("textarea")!.value, changed);
  assert.equal(dom.document.getElementById("paper")!.textContent, changed);
});

test("Escape closes a palette opened by mouse while focus remains on the selected textarea", async () => {
  await mount(); const textarea = await select(2, 5);
  await flush(() => {
    paletteToggle().dispatchEvent(new dom.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    paletteToggle().dispatchEvent(new dom.MouseEvent("mouseup", { bubbles: true }));
    paletteToggle().click();
  });
  assert.ok(palette());
  assert.equal(dom.document.activeElement, textarea, "Opening by mouse preserves the textarea focus and selection");
  await flush(() => textarea.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  assert.equal(palette(), null);
  assert.equal(paletteToggle().getAttribute("aria-expanded"), "false");
  assert.equal(dom.document.activeElement, textarea);
  assert.equal(textarea.selectionStart, 2); assert.equal(textarea.selectionEnd, 5);
  assert.deepEqual(latest, []); assert.equal(writes.length, 0);
});

test("restoring the former source after an edit cannot resurrect an invalidated color selection", async () => {
  await mount(); await select(1, 4); await openPalette();
  await enterColor(customHex(), "#345678");
  await flush(() => replaceSource("临时改变的事实原文"));
  assert.equal(palette(), null);
  await flush(() => replaceSource(source));
  assert.equal(palette(), null, "Undoing a text edit still requires explicitly opening a new palette");
  assert.equal(paletteToggle().getAttribute("aria-expanded"), "false");
  assert.deepEqual(latest, []); assert.equal(writes.length, 0);
  assert.equal(dom.document.querySelector("textarea")!.value, source);
  assert.equal(dom.document.getElementById("paper")!.textContent, source);
});

test("keyboard selection changes close the captured palette and reopening applies only the new selection", async () => {
  await mount(); const textarea = await select(1, 3);
  await flush(() => {
    paletteToggle().dispatchEvent(new dom.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    paletteToggle().dispatchEvent(new dom.MouseEvent("mouseup", { bubbles: true }));
    paletteToggle().click();
  });
  assert.ok(palette());
  assert.equal(dom.document.activeElement, textarea);
  assert.equal(preview().querySelector("mark")!.textContent, "乙丙");
  await flush(() => {
    textarea.setSelectionRange(2, 5);
    textarea.dispatchEvent(new dom.KeyboardEvent("keyup", { key: "ArrowRight", shiftKey: true, bubbles: true }));
    dom.document.dispatchEvent(new dom.Event("selectionchange", { bubbles: true }));
  });
  assert.equal(palette(), null, "Changing the textarea selection invalidates the range captured by the open palette");
  assert.equal(paletteToggle().getAttribute("aria-expanded"), "false");
  assert.equal(dom.document.activeElement, textarea);
  assert.deepEqual(latest, []); assert.equal(writes.length, 0);
  await flush(() => {
    paletteToggle().dispatchEvent(new dom.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    paletteToggle().dispatchEvent(new dom.MouseEvent("mouseup", { bubbles: true }));
    paletteToggle().click();
  });
  assert.ok(palette());
  assert.equal(preview().querySelector("mark")!.textContent, "丙丁戊");
  await color("蓝色", "Blue");
  assert.deepEqual(latest, [{ start: 2, end: 5, highlight: true, highlightColor: "#cce5ff" }]);
  assert.equal(writes.length, 1);
  assert.equal(textarea.selectionStart, 2); assert.equal(textarea.selectionEnd, 5);
  assert.equal(textarea.value, source);
  assert.equal(dom.document.getElementById("paper")!.textContent, source);
});
