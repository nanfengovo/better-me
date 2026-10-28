import assert from "node:assert/strict";
import test, { after } from "node:test";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { AtlasMapToolbar } from "../src/components/atlas/AtlasMapToolbar";
import type { AtlasViewMode } from "../src/components/atlas/AtlasViewControls";

const dom = new Window({ url: "http://synthetic-map-toolbar.invalid" });
const globals = { React, window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
after(() => {
  dom.happyDOM.abort();
  for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
});

test("map toolbar preserves scope/view/reset handlers and disables rotation outside global 3D", async () => {
  const host = dom.document.createElement("div"); dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLDivElement);
  const changes: Array<[AtlasViewMode, boolean]> = [];
  const scopes: string[] = [];
  let resets = 0;
  function Harness() {
    const [mode, setMode] = React.useState<"global" | "domestic">("domestic");
    const [viewMode, setViewMode] = React.useState<AtlasViewMode>("spatial");
    const [rotating, setRotating] = React.useState(false);
    return <AtlasMapToolbar mode={mode} onModeChange={next => { scopes.push(next); setMode(next); }} viewMode={viewMode}
      onViewChange={(next, animate) => { changes.push([next, animate]); setViewMode(next); setRotating(false); }}
      rotating={rotating} onToggleRotation={() => setRotating(value => !value)} onReset={() => { resets++; }} />;
  }
  const click = async (button: Element, detail = 0) => { await React.act(async () => { button.dispatchEvent(new dom.MouseEvent("click", { detail, bubbles: true })); }); };
  try {
    await React.act(async () => { root.render(<Harness />); });
    const scopeButtons = host.querySelectorAll<HTMLButtonElement>(".atlas-mode-switch button");
    const rotate = host.querySelector<HTMLButtonElement>(".atlas-map-camera-controls button:last-child")!;
    const reset = host.querySelector<HTMLButtonElement>('[aria-label="重置地图视角"]')!;
    const flat = host.querySelector<HTMLButtonElement>('[aria-label="平面视角 2D"]')!;
    const spatial = host.querySelector<HTMLButtonElement>('[aria-label="空间视角 3D"]')!;
    assert.equal(host.querySelectorAll("button").length, 6, "each control appears once, without a duplicate caption");
    assert.equal(host.querySelector('[aria-label="地图工具栏"]')?.getAttribute("role"), "group");
    assert.equal(rotate.disabled, true);
    await click(rotate);
    assert.equal(rotate.getAttribute("aria-pressed"), "false", "domestic mode does not rotate via its disabled control");
    await click(scopeButtons[0]!);
    assert.deepEqual(scopes, ["global"]);
    assert.equal(scopeButtons[0]!.getAttribute("aria-pressed"), "true");
    assert.equal(scopeButtons[1]!.getAttribute("aria-pressed"), "false");
    assert.equal(rotate.disabled, false);
    await click(rotate);
    assert.equal(rotate.getAttribute("aria-pressed"), "true");
    assert.equal(rotate.textContent?.trim(), "暂停旋转");
    await click(flat);
    assert.deepEqual(changes, [["flat", false]], "keyboard/assistive activation stays instant");
    assert.equal(rotate.disabled, true);
    assert.equal(rotate.getAttribute("aria-pressed"), "false");
    await click(spatial, 1);
    assert.deepEqual(changes.at(-1), ["spatial", true], "pointer activation keeps the existing view transition");
    assert.equal(rotate.disabled, false);
    await click(reset);
    assert.equal(resets, 1);
    await click(scopeButtons[1]!);
    assert.deepEqual(scopes, ["global", "domestic"]);
    assert.equal(rotate.disabled, true);
    assert.ok(Array.from(host.querySelectorAll("button")).every(button => button.type === "button"), "toolbar buttons cannot submit an enclosing form");
  } finally { await React.act(async () => { root.unmount(); }); host.remove(); }
});
