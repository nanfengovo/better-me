import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { AtlasSettingsDialog } from "../src/components/atlas/AtlasSettingsDialog";

const dom = new Window({ url: "http://atlas-settings-dialog.invalid" });
const globals = { React, window: dom, document: dom.document, navigator: dom.navigator,
  HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
let root: ReturnType<typeof createRoot> | undefined;
let closes = 0;
let keepMounted = false;

async function mount() {
  const opener = dom.document.createElement("button"); opener.textContent = "地图服务";
  const host = dom.document.createElement("main"); dom.document.body.append(opener, host); opener.focus();
  root = createRoot(host);
  function Harness() {
    const [open, setOpen] = React.useState(true);
    return open ? <AtlasSettingsDialog title="地图与街道底图" onClose={() => { closes++; if (!keepMounted) setOpen(false); }}>
      <label>底图来源<input defaultValue="合成底图" /></label>
    </AtlasSettingsDialog> : null;
  }
  await React.act(async () => { root!.render(<Harness />); });
  const dialog = host.querySelector("dialog")!;
  Object.defineProperty(dialog, "getBoundingClientRect", { value: () => ({ left: 100, right: 500, top: 100, bottom: 500 }) });
  return { opener, host, dialog, close: dialog.querySelector("button")!, input: dialog.querySelector("input")! };
}

afterEach(async () => {
  if (root) await React.act(async () => { root!.unmount(); });
  root = undefined; closes = 0; keepMounted = false; dom.document.body.replaceChildren();
});
after(() => {
  dom.happyDOM.abort();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test("opens a labelled native modal, focuses its close action, and restores its opener", async () => {
  const { opener, dialog, close, host } = await mount();
  assert.equal(dialog.open, true);
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.equal(dom.document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent, "地图与街道底图");
  assert.equal(dom.document.activeElement, close);
  await React.act(async () => { close.click(); });
  assert.equal(closes, 1);
  assert.equal(host.querySelector("dialog"), null);
  assert.equal(dom.document.activeElement, opener);
});

test("Escape closes settings without bubbling into the map or issuing a second native cancel", async () => {
  const { input, host } = await mount();
  let mapEscape = 0;
  const listen = (event: { key?: string }) => { if (event.key === "Escape") mapEscape++; };
  dom.document.addEventListener("keydown", listen);
  try {
    input.focus();
    const escape = new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await React.act(async () => { input.dispatchEvent(escape); });
    assert.equal(escape.defaultPrevented, true);
    assert.equal(closes, 1);
    assert.equal(mapEscape, 0);
    assert.equal(host.querySelector("dialog"), null);
  } finally { dom.document.removeEventListener("keydown", listen); }
});

test("native cancel requests close and composition Escape keeps the current form", async () => {
  keepMounted = true;
  const { dialog, input } = await mount();
  await React.act(async () => { input.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, cancelable: true })); });
  assert.equal(closes, 0);
  const cancel = new dom.Event("cancel", { cancelable: true });
  await React.act(async () => { dialog.dispatchEvent(cancel); });
  assert.equal(cancel.defaultPrevented, true);
  assert.equal(closes, 1);
  assert.equal(dialog.open, true, "controlled parent owns the settings lifetime");
});

test("only a primary pointer beginning and ending on the backdrop dismisses settings", async () => {
  keepMounted = true;
  const { dialog, input } = await mount();
  function pointer(target: typeof dialog | typeof input, type: string, x: number, y: number, options = {}) {
    target.dispatchEvent(new dom.PointerEvent(type, { pointerId: 1, button: 0, isPrimary: true, bubbles: true, clientX: x, clientY: y, ...options }));
  }
  await React.act(async () => {
    pointer(dialog, "pointerdown", 120, 120); pointer(dialog, "pointerup", 120, 120);
    pointer(input, "pointerdown", 150, 150); pointer(dialog, "pointerup", 50, 50);
    pointer(dialog, "pointerdown", 50, 50); pointer(input, "pointerup", 150, 150);
    pointer(dialog, "pointerdown", 50, 50, { button: 2 }); pointer(dialog, "pointerup", 50, 50);
    pointer(dialog, "pointerdown", 50, 50); pointer(dialog, "pointercancel", 50, 50); pointer(dialog, "pointerup", 50, 50);
    pointer(dialog, "pointerdown", 50, 50); pointer(dialog, "pointerup", 50, 50, { pointerId: 2 });
  });
  assert.equal(closes, 0, "padding, drags, right clicks, cancelled and mismatched pointers remain open");
  await React.act(async () => { pointer(dialog, "pointerdown", 50, 50); pointer(dialog, "pointerup", 50, 50); });
  assert.equal(closes, 1);
});

test("rerendering a title or callback preserves the same dialog and unsaved fields", async () => {
  const { host } = await mount();
  // Mount the component directly to test its stable effect across prop changes.
  await React.act(async () => { root!.render(<AtlasSettingsDialog title="地图" onClose={() => {}}><input defaultValue="原值" /></AtlasSettingsDialog>); });
  const dialog = host.querySelector("dialog")!;
  const input = dialog.querySelector("input")!;
  input.value = "尚未保存"; input.focus();
  await React.act(async () => { root!.render(<AtlasSettingsDialog title="地图设置" onClose={() => { closes++; }}><input defaultValue="原值" /></AtlasSettingsDialog>); });
  assert.equal(host.querySelector("dialog"), dialog);
  assert.equal(dialog.open, true);
  assert.equal(dialog.querySelector("input"), input);
  assert.equal(input.value, "尚未保存");
  assert.equal(dom.document.activeElement, input);
});

test("unmounting does not reclaim focus from another open modal", async () => {
  await mount();
  const next = dom.document.createElement("dialog"), nextInput = dom.document.createElement("input");
  next.append(nextInput); dom.document.body.append(next); next.showModal(); nextInput.focus();
  await React.act(async () => { root!.unmount(); }); root = undefined;
  assert.equal(dom.document.activeElement, nextInput);
  assert.equal(next.open, true);
});

test("unmounting does not restore focus to a hidden or detached opener", async () => {
  const { opener } = await mount();
  opener.hidden = true;
  await React.act(async () => { root!.unmount(); }); root = undefined;
  assert.notEqual(dom.document.activeElement, opener);
});
