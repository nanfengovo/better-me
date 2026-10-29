import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { Window } from "happy-dom";

const directory = resolve(import.meta.dirname, "../src/components/atlas");
function stylesheet(name: string): string {
  const path = resolve(directory, name);
  return readFileSync(path, "utf8").replace(/@import\s+["'](.+?)["'];/g,
    (_match, imported: string) => stylesheet(resolve(dirname(path), imported)));
}

test("map settings take a side column rather than consuming the map's height, with bounded desktop typography", async () => {
  const dom = new Window({ width: 1451, height: 900 });
  try {
    const style = dom.document.createElement("style");
    style.textContent = ["atlas.css", "atlas-experience.css", "map3d/map3d.css"].map(stylesheet).join("\n");
    dom.document.head.append(style);
    dom.document.body.innerHTML = `<main class="atlas-workspace atlas-experience" data-pane-layout="wide">
      <div class="atlas-map-viewport" data-settings-open="true">
        <div class="atlas-scene-sourcebar"><button>实景 3D</button></div>
        <section class="atlas-scene-config"><header><strong>实景数据与画质</strong><button>关闭</button></header>
          <label>三维画质<select><option>均衡</option></select></label><p>计费与覆盖说明</p>
        </section><div class="atlas-scene-stage"></div><div class="atlas-scene-caption">数据来源</div>
      </div></main>`;
    const css = (selector: string) => dom.getComputedStyle(dom.document.querySelector(selector)!);
    assert.equal(css(".atlas-map-viewport").display, "grid");
    assert.equal(css(".atlas-scene-config").gridColumn, "2", "settings must not insert another row above the map");
    assert.equal(css(".atlas-scene-config").gridRow, "2");
    assert.equal(css(".atlas-scene-stage").gridRow, "2", "settings and canvas share the full remaining height");
    assert.equal(Number.parseFloat(css(".atlas-scene-stage").minHeight), 0);
    assert.equal(css(".atlas-scene-config").overflow, "auto", "long permission/help text scrolls inside settings");
    assert.equal(css(".atlas-scene-sourcebar button").fontSize, "13px", "global button font inheritance must not enlarge map controls");
    assert.equal(css(".atlas-scene-sourcebar button").minHeight, "32px");
    assert.equal(css(".atlas-scene-config select").minHeight, "32px");
    assert.equal(css(".atlas-scene-config header strong").fontSize, "14px");
    assert.equal(css(".atlas-scene-config p").fontSize, "12px");
    const touch = new Window({ width: 390, height: 900, settings: { navigator: { maxTouchPoints: 5 } } });
    try {
      touch.document.head.innerHTML = dom.document.head.innerHTML;
      touch.document.body.innerHTML = dom.document.body.innerHTML;
      const touchCss = (selector: string) => touch.getComputedStyle(touch.document.querySelector(selector)!);
      assert.equal(touch.matchMedia("(pointer: coarse)").matches, true);
      assert.equal(touchCss(".atlas-scene-sourcebar button").minHeight, "44px", "touch controls retain comfortable hit areas");
      assert.equal(touchCss(".atlas-scene-config select").minHeight, "44px");
    } finally { await touch.happyDOM.close(); }
  } finally { await dom.happyDOM.close(); }
});
