import assert from "node:assert/strict";
import test from "node:test";
import { collectCesiumAssets, cesiumAssetsPlugin, cesiumContentType } from "../server/cesium-assets";
test("Cesium SDK assets include workers, WASM, widgets and license with explicit MIME", async () => {
  const files = await collectCesiumAssets();
  assert.ok(files.has("Widgets/widgets.css")); assert.ok(files.has("LICENSE.md")); assert.ok(files.has("ThirdParty.json")); assert.ok(files.has("ThirdParty.extra.json"));
  for (const prefix of ["Workers/", "Assets/", "ThirdParty/", "Widgets/"]) assert.ok([...files.keys()].some(key => key.startsWith(prefix)));
  const wasm = [...files.keys()].find(key => key.endsWith(".wasm")); assert.ok(wasm); assert.equal(cesiumContentType(wasm!), "application/wasm");
  assert.equal(cesiumContentType("Workers/worker.js"), "text/javascript"); assert.equal(cesiumContentType("Assets/data.json"), "application/json");
  assert.ok(!files.has("../../package.json")); assert.ok(!files.has("Source/Cesium.js"));
});
test("Cesium resource base follows production subpath rather than hardcoding root", () => {
  const config = cesiumAssetsPlugin().config as (value: { base: string }) => { define: { CESIUM_BASE_URL: string } };
  assert.equal(JSON.parse(config({ base: "/better-me/" }).define.CESIUM_BASE_URL), "/better-me/cesium/");
  assert.equal(JSON.parse(config({ base: "/" }).define.CESIUM_BASE_URL), "/cesium/");
});
