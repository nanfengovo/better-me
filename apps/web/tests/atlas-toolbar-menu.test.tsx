import assert from "node:assert/strict";
import test, { after, afterEach, mock } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { AtlasToolbarMenu } from "../src/components/atlas/AtlasToolbarMenu";

const dom = new Window({ url: "http://atlas-toolbar-menu.invalid" });
const globals = { React, window: dom, document: dom.document, navigator: dom.navigator,
  HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
let root: ReturnType<typeof createRoot> | undefined;

async function flush(action: () => void) {
  await React.act(async () => { action(); await nextTurn(); });
}
async function mount() {
  const host = dom.document.createElement("main"); dom.document.body.append(host); root = createRoot(host);
  let actions = 0;
  await flush(() => { root!.render(<>
    <AtlasToolbarMenu label="获取方式" className="atlas-fetch-options">
      <label>来源<input defaultValue="原始来源" /></label>
      <label>读取范围<select defaultValue="standard"><option value="standard">标准</option><option value="quick">快速</option></select></label>
      <button type="button">保持展开</button>
      <button type="button" data-close-menu onClick={() => { actions++; }}><span>打开设置</span></button>
    </AtlasToolbarMenu>
    <button type="button" data-outside>其他操作</button>
  </>); });
  const details = host.querySelector("details")!, summary = details.querySelector("summary")!;
  return { host, details, summary, input: details.querySelector("input")!, select: details.querySelector("select")!,
    action: details.querySelector("button[data-close-menu]")!, ordinary: details.querySelector("button:not([data-close-menu])")!,
    outside: host.querySelector("button[data-outside]")!, actions: () => actions };
}

afterEach(async () => {
  if (root) await flush(() => { root!.unmount(); });
  root = undefined; dom.document.body.replaceChildren();
});
after(() => {
  dom.happyDOM.abort();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test("native summary toggles the disclosure without assigning menu roles to form fields", async () => {
  const { details, summary } = await mount();
  assert.equal(details.open, false);
  assert.ok(details.classList.contains("atlas-fetch-options"));
  assert.equal(details.querySelector('[role="menu"], [role="menuitem"]'), null);
  await flush(() => { summary.click(); });
  assert.equal(details.open, true);
  await flush(() => { summary.click(); });
  assert.equal(details.open, false);
});

test("Escape returns focus to the summary and never reaches the workbench", async () => {
  const { details, summary, input } = await mount();
  await flush(() => { summary.click(); }); input.focus();
  let workbenchEscapes = 0;
  const onKey = (event: { key?: string }) => { if (event.key === "Escape") workbenchEscapes++; };
  dom.document.addEventListener("keydown", onKey);
  try {
    const event = new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await flush(() => { input.dispatchEvent(event); });
    assert.equal(event.defaultPrevented, true);
    assert.equal(details.open, false);
    assert.equal(dom.document.activeElement, summary);
    assert.equal(workbenchEscapes, 0);
  } finally { dom.document.removeEventListener("keydown", onKey); }
});

test("IME Escape and clicks within input, select, or ordinary action preserve the disclosure", async () => {
  const { details, summary, input, select, ordinary } = await mount();
  await flush(() => { summary.click(); });
  await flush(() => {
    input.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true })); input.click(); input.focus(); input.value = "尚未提交";
    input.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, cancelable: true }));
    select.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true })); select.click(); select.value = "quick";
    select.dispatchEvent(new dom.Event("change", { bubbles: true })); ordinary.click();
  });
  assert.equal(details.open, true);
  assert.equal(input.value, "尚未提交");
  assert.equal(select.value, "quick");
});

test("outside pointer dismisses without reclaiming focus from the destination", async () => {
  const { details, summary, outside } = await mount();
  await flush(() => { summary.click(); }); outside.focus();
  await flush(() => { outside.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true })); });
  assert.equal(details.open, false);
  assert.equal(dom.document.activeElement, outside);
  // Reopening must reattach outside dismissal after the preceding close.
  await flush(() => { summary.click(); });
  assert.equal(details.open, true);
  await flush(() => { outside.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true })); });
  assert.equal(details.open, false);
});

test("a nested close-action target invokes its action once, closes, and restores summary focus", async () => {
  const { details, summary, action, actions } = await mount();
  await flush(() => { summary.click(); }); action.focus();
  await flush(() => { action.querySelector("span")!.click(); });
  assert.equal(actions(), 1);
  assert.equal(details.open, false);
  assert.equal(dom.document.activeElement, summary);
});

test("outside handlers are removed on unmount and closed disclosure ignores Escape", async () => {
  const added = mock.method(dom.document, "addEventListener");
  const removed = mock.method(dom.document, "removeEventListener");
  try {
    const { details, summary, outside } = await mount();
    const escape = new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await flush(() => { summary.dispatchEvent(escape); });
    assert.equal(escape.defaultPrevented, false);
    assert.equal(details.open, false);
    await flush(() => { summary.click(); });
    const outsideListeners = added.mock.calls.filter(call => call.arguments[0] === "pointerdown").map(call => call.arguments[1]);
    assert.equal(outsideListeners.length, 1);
    await flush(() => { root!.unmount(); }); root = undefined;
    const removedListeners = removed.mock.calls.filter(call => call.arguments[0] === "pointerdown").map(call => call.arguments[1]);
    assert.deepEqual(removedListeners, outsideListeners);
    // Detached outside button no longer reaches document; use the document itself.
    assert.doesNotThrow(() => { dom.document.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true })); });
    assert.equal(outside.isConnected, false);
  } finally { added.mock.restore(); removed.mock.restore(); }
});
