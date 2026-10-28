import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { AtlasViewControls, type AtlasViewMode } from "../src/components/atlas/AtlasViewControls";

const dom = new Window({ url: "http://synthetic-spatial-controls.invalid" });
const globals = {
  React, window: dom, document: dom.document, navigator: dom.navigator,
  HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
after(() => {
  dom.happyDOM.abort();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test("physical view selector changes the exclusive state once and only permits pointer motion", async () => {
  const host = dom.document.createElement("div"); dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLDivElement);
  const changes: Array<[AtlasViewMode, boolean]> = [];
  function Harness() {
    const [value, setValue] = React.useState<AtlasViewMode>("flat");
    return <AtlasViewControls value={value} onChange={(mode, animate) => { changes.push([mode, animate]); setValue(mode); }} />;
  }
  try {
    await React.act(async () => { root.render(<Harness />); });
    const selector = host.querySelector(".atlas-spatial-controls")!;
    const flat = host.querySelector<HTMLButtonElement>('[aria-label="平面视角 2D"]')!;
    const spatial = host.querySelector<HTMLButtonElement>('[aria-label="空间视角 3D"]')!;
    assert.equal(selector.getAttribute("data-motion"), "instant");
    assert.equal(selector.getAttribute("data-view"), "flat");
    assert.equal(host.querySelectorAll("button").length, 2, "decoration adds no focusable duplicate controls");
    assert.equal(host.querySelectorAll('.atlas-view-spatial-glyph[aria-hidden="true"] i').length, 3);

    await React.act(async () => { spatial.dispatchEvent(new dom.MouseEvent("click", { detail: 0, bubbles: true })); });
    assert.deepEqual(changes, [["spatial", false]]);
    assert.equal(selector.getAttribute("data-motion"), "instant");
    assert.equal(selector.getAttribute("data-view"), "spatial");
    assert.equal(spatial.getAttribute("aria-pressed"), "true");
    assert.equal(flat.getAttribute("aria-pressed"), "false");

    await React.act(async () => { flat.dispatchEvent(new dom.MouseEvent("click", { detail: 1, bubbles: true })); });
    assert.deepEqual(changes.at(-1), ["flat", true]);
    assert.equal(selector.getAttribute("data-motion"), "pointer");
    assert.equal(selector.getAttribute("data-view"), "flat");
    assert.equal(flat.getAttribute("aria-pressed"), "true");

    await React.act(async () => { spatial.dispatchEvent(new dom.MouseEvent("click", { detail: 0, bubbles: true })); });
    assert.deepEqual(changes, [["spatial", false], ["flat", true], ["spatial", false]]);
    assert.equal(selector.getAttribute("data-motion"), "instant", "assistive/keyboard clicks clear previous pointer animation intent");
    assert.equal(host.querySelectorAll('[aria-pressed="true"]').length, 1);
  } finally { await React.act(async () => { root.unmount(); }); host.remove(); }
});

test("spatial selector only moves small transforms, has touch targets and stops for keyboard or reduced motion", () => {
  const css = readFileSync(new URL("../src/components/atlas/atlas-spatial.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /@keyframes|animation:|transition:\s*all|will-change|backdrop-filter/);
  assert.match(css, /transition: transform 200ms var\(--atelier-ease/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /transition: none !important/);
  assert.match(css, /:has\(button:focus-visible\)/);
  assert.match(css, /hover:\s*hover.*pointer:\s*fine/);
  assert.match(css, /@media \(pointer: coarse\)[\s\S]*min-height: 44px/);
  assert.match(css, /transform-style: preserve-3d/);
});
