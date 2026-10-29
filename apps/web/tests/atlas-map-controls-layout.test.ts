import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test, { after } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import { AtlasMapToolbar } from "../src/components/atlas/AtlasMapToolbar";

const reactDescriptor = Object.getOwnPropertyDescriptor(globalThis, "React");
Object.defineProperty(globalThis, "React", { configurable: true, writable: true, value: React });
after(() => { if (reactDescriptor) Object.defineProperty(globalThis, "React", reactDescriptor); else Reflect.deleteProperty(globalThis, "React"); });

const stylesDirectory = resolve(import.meta.dirname, "../src/components/atlas");
function stylesheet(name: string): string {
  const path = resolve(stylesDirectory, name);
  return readFileSync(path, "utf8").replace(/@import\s+["'](.+?)["'];/g, (_match, imported: string) =>
    stylesheet(resolve(dirname(path), imported)));
}

// Render the actual toolbar and the wrapper/renderer seam. Pixel-level overlap
// requires a browser; this exercises the complete style cascade, not CSS text.
const toolbar = renderToStaticMarkup(React.createElement(AtlasMapToolbar, {
  mode: "domestic", onModeChange: () => {}, viewMode: "spatial", onViewChange: () => {},
  rotating: false, onToggleRotation: () => {}, onReset: () => {},
}));
const fixture = `<main class="atlas-workspace atlas-experience" data-pane-layout="wide">
  <div class="atlas-map-card light">
    ${toolbar}
    <div class="atlas-scene"><div data-atlas-renderer="maplibre" data-atlas-office-controls="true">
      <div class="atlas-admin-boundary-badge" style="position:absolute;top:var(--atlas-boundary-top,14px);left:var(--atlas-boundary-left,14px);font-size:var(--atlas-boundary-font-size,11px)">全市：上海市</div>
      <button class="atlas-map-location-trigger">办公地址 10</button>
      <div class="maplibregl-ctrl-top-right"><div class="maplibregl-ctrl-group"><button>+</button><button>−</button></div></div>
      <div class="atlas-map-location-browser"><div class="atlas-map-location-heading"><button>关闭办公地址列表</button></div></div>
    </div></div>
  </div>
</main>`;

function setup(width: number, layout: "wide" | "medium" | "narrow", touch = false) {
  const dom = new Window({ width, height: 900, settings: { navigator: { maxTouchPoints: touch ? 5 : 0 } } });
  const style = dom.document.createElement("style");
  style.textContent = ["atlas.css", "atlas-experience.css", "map-interactions.css"].map(stylesheet).join("\n");
  dom.document.head.append(style);
  dom.document.body.innerHTML = fixture;
  dom.document.querySelector("main")!.setAttribute("data-pane-layout", layout);
  return { dom, css: (selector: string) => dom.getComputedStyle(dom.document.querySelector(selector)!) };
}

for (const [width, layout] of [[1451, "wide"], [1024, "medium"], [390, "narrow"]] as const) {
  test(`${layout} map controls reserve their own flow row rather than covering the renderer boundary badge`, async () => {
    const { dom, css } = setup(width, layout);
    try {
      assert.notEqual(css(".atlas-map-top").position, "absolute", "range/view controls must reserve height above the independently positioned boundary badge");
      assert.notEqual(css(".atlas-map-top").position, "fixed");
      assert.equal(css(".atlas-map-top").flexShrink, "0", "the reserved toolbar row cannot collapse when the scene grows");
      assert.equal(css(".atlas-map-top").flexWrap, "wrap", "narrow cards wrap complete control groups instead of overlapping");
      assert.equal(css(".atlas-mode-switch button").minHeight, "32px", "desktop scope switches leave height for the map");
      assert.equal(css(".atlas-view-controls button").minHeight, "32px", "desktop 2D/3D controls use compact sizing");
      assert.equal(css(".atlas-map-camera-controls button").minHeight, "32px", "desktop camera actions use the same density");
      assert.equal(css(".atlas-scene").position, "relative");
      assert.equal(css(".atlas-map-location-trigger").top, "12px");
      assert.equal(css(".atlas-map-location-trigger").minHeight, "44px");
      assert.equal(css(".maplibregl-ctrl-top-right").top, "68px", "native navigation has a separate lane below the address entry");
      assert.equal(css(".maplibregl-ctrl-group button").height, "44px");
      assert.equal(css(".atlas-map-location-browser").top, "68px", "address drawer starts below its entry button");
      assert.equal(css(".atlas-map-location-browser").right, "68px", "address drawer leaves the native navigation column available");
      assert.equal(css(".atlas-map-location-heading > button").height, "44px");
      assert.equal(css(".atlas-admin-boundary-badge").maxWidth, "calc(100% - 180px)", "long boundary names reserve the address control lane");
      assert.equal(css(".atlas-admin-boundary-badge").fontSize, "13px");
    } finally { await dom.happyDOM.close(); }
  });
}

test("touchscreen map controls retain 44px targets despite desktop density", async () => {
  const { dom, css } = setup(390, "narrow", true);
  try {
    assert.equal(dom.matchMedia("(pointer: coarse)").matches, true);
    for (const selector of [".atlas-mode-switch button", ".atlas-view-controls button", ".atlas-map-camera-controls button"])
      assert.equal(css(selector).minHeight, "44px");
  } finally { await dom.happyDOM.close(); }
});

test("without office locations the boundary badge uses available width while navigation remains reachable", async () => {
  const { dom, css } = setup(390, "narrow");
  try {
    dom.document.querySelector('[data-atlas-renderer="maplibre"]')!.setAttribute("data-atlas-office-controls", "false");
    dom.document.querySelector(".atlas-map-location-trigger")!.remove();
    assert.equal(css(".atlas-admin-boundary-badge").maxWidth, "calc(100% - 84px)");
    assert.equal(css(".maplibregl-ctrl-top-right").top, "12px");
    assert.equal(css(".maplibregl-ctrl-group button").height, "44px");
  } finally { await dom.happyDOM.close(); }
});
