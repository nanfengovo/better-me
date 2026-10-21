import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test, { after } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import ts from "typescript";
import { Window } from "happy-dom";
import type { AtlasPrototypeProps } from "../src/components/atlas/prototypes/types.ts";
import type { AtlasMapFocus } from "../src/components/atlas/map-focus.ts";

// Exercise the actual renderer's React effects and event subscriptions; only GPU/network APIs are synthetic.
const dom = new Window({ url: "http://synthetic-map-performance.invalid" });
const frames = new Map<number, FrameRequestCallback>(); let frameId = 0, reduced = false;
const instances: SyntheticMap[] = [], markerEvents: string[] = [];
class SyntheticMap {
  handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  canvas = dom.document.createElement("canvas"); moving = false; removed = false; zoom = 1.65;
  uploads = 0; queries = 0; paints = 0; filters: Array<{ id: string; filter: unknown }> = []; flights: unknown[] = []; projection: unknown;
  hits: Array<{ properties: { bucketId: string } }> = [{ properties: { bucketId: "synthetic-0" } }];
  addedSources: Array<{ id: string; source: unknown }> = []; addedLayers: Array<{ id: string; before?: string }> = []; glyphs: unknown; sprite: unknown;
  throwOnLayer = "";
  constructor(readonly options: Record<string, unknown>) { instances.push(this); }
  on(name: string, callback: (...args: unknown[]) => void) { this.handlers.set(name, [...(this.handlers.get(name) ?? []), callback]); return this; }
  once(name: string, callback: (...args: unknown[]) => void) { const once = (...args: unknown[]) => { this.handlers.set(name, this.handlers.get(name)!.filter(entry => entry !== once)); callback(...args); }; return this.on(name, once); }
  emit(name: string, event: unknown = {}) { for (const handler of [...(this.handlers.get(name) ?? [])]) handler(event); }
  addControl() {} getCanvas() { return this.canvas; } getZoom() { return this.zoom; } getPitch() { return 0; } getBearing() { return 0; }
  getCenter() { return { lng: 104, lat: 26 }; } getBounds() { return { getWest: () => 100, getEast: () => 110, getSouth: () => 20, getNorth: () => 30 }; }
  isMoving() { return this.moving; } stop() { this.moving = false; } setCenter() {} resize() {} triggerRepaint() {}
  getLayer(id: string) { return ((this.options.style as { layers: Array<{ id: string }> }).layers).some(layer => layer.id === id); }
  getSource() { return { setData: () => { this.uploads++; } }; }
  addSource(id: string, source: unknown) { this.addedSources.push({ id, source }); }
  addLayer(layer: { id: string }, before?: string) { if (this.throwOnLayer === layer.id) throw new Error("Synthetic provider layer rejected"); this.addedLayers.push({ id: layer.id, before }); ((this.options.style as { layers: Array<{ id: string }> }).layers).push(layer); }
  removeLayer(id: string) { const style = this.options.style as { layers: Array<{ id: string }> }; style.layers = style.layers.filter(layer => layer.id !== id); }
  removeSource(id: string) { this.addedSources = this.addedSources.filter(source => source.id !== id); }
  setGlyphs(value: unknown) { this.glyphs = value; } setSprite(value: unknown) { this.sprite = value; }
  addSprite(id: string, url: string) { this.sprite = [...(Array.isArray(this.sprite) ? this.sprite : []), { id, url }]; }
  setProjection(value: unknown) { this.projection = value; } setSky() {} setLight() {}
  setFilter(id: string, filter: unknown) { this.filters.push({ id, filter }); }
  setPaintProperty() { this.paints++; } queryRenderedFeatures() { this.queries++; return this.hits; }
  fitBounds() {} jumpTo() {} flyTo(options: unknown) { this.flights.push(options); } remove() { this.removed = true; }
}
class SyntheticMarker {
  constructor() { markerEvents.push("create"); } setLngLat() { return this; } addTo() { return this; } remove() { markerEvents.push("remove"); }
}
const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node,
  ResizeObserver: class { observe() {} disconnect() {} }, requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; }, cancelAnimationFrame: (id: number) => { frames.delete(id); },
  IS_REACT_ACT_ENVIRONMENT: true, __atlasPerformanceMap: SyntheticMap, __atlasPerformanceMarker: SyntheticMarker };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
Object.defineProperty(dom, "matchMedia", { configurable: true, value: () => ({ get matches() { return reduced; }, addEventListener() {}, removeEventListener() {} }) });
const realFetch = globalThis.fetch;
globalThis.fetch = async input => new Response(JSON.stringify(String(input).endsWith("style.json") ? { version: 8, sources: {}, layers: [], glyphs: "https://synthetic.invalid/{fontstack}/{range}.pbf" } : { type: "FeatureCollection", features: [] }), { headers: { "content-type": "application/json" } });
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "maplibre-gl") return { url: "data:text/javascript,export const Map=globalThis.__atlasPerformanceMap,Marker=globalThis.__atlasPerformanceMarker;export class AttributionControl{};export class NavigationControl{};export class ScaleControl{};export const setWorkerUrl=()=>{};", shortCircuit: true };
    if (specifier.endsWith("?url")) return { url: "data:text/javascript,export default '/synthetic-local-map-asset';", shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) return { source: "export {};", format: "module", shortCircuit: true };
    if (url.endsWith("/MapLibrePrototype.tsx")) return { source: ts.transpileModule(readFileSync(new URL(url), "utf8").replaceAll("import.meta.env.BASE_URL", "'/'"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, format: "module", shortCircuit: true };
    return nextLoad(url, context);
  },
});

const React = await import("react"), { createRoot } = await import("react-dom/client");
const { MapLibrePrototype } = await import("../src/components/atlas/prototypes/MapLibrePrototype.tsx");
const { createElement: h, act } = React;
after(() => { hooks.deregister(); globalThis.fetch = realFetch; dom.happyDOM.abort(); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });

test("bucket clicks retain the exact query bucket, navigate once to the next scale, and remain selectable at maximum zoom", async () => {
  const host = dom.document.createElement("div"); dom.document.body.append(host); const root = createRoot(host as unknown as HTMLDivElement);
  const bucket: AtlasPrototypeProps["buckets"][number] = { id: "synthetic-city", label: "Synthetic city", longitude: 121, latitude: 31,
    jobIds: ["synthetic-one", "synthetic-two"], locationIds: ["office-one", "office-two"], jobCount: 2, pinCount: 2, categories: [] };
  const picks: typeof bucket[] = [], views: number[] = [];
  let props: AtlasPrototypeProps = { mode: "global", basemap: null, buckets: [bucket], bucketLevel: "city", onPick: value => picks.push(value), onViewChange: view => views.push(view.zoom) };
  const render = async (next: Partial<AtlasPrototypeProps> = {}) => { props = { ...props, ...next }; await act(async () => { root.render(h(MapLibrePrototype, props)); for (let i = 0; i < 4; i++) await nextTurn(); }); };
  try {
    await render(); const map = instances.at(-1)!; await act(async () => { map.emit("load"); map.emit("render"); }); map.hits = [{ properties: { bucketId: bucket.id } }];
    map.emit("click", { point: { x: 10, y: 10 } }); map.emit("click", { point: { x: 10, y: 10 } });
    assert.equal(picks.length, 2); assert.equal(picks[0], bucket); assert.equal(map.flights.length, 1);
    assert.deepEqual((map.flights[0] as { center: number[] }).center, [121, 31]); assert.equal((map.flights[0] as { zoom: number }).zoom, 10.5);
    assert.equal(views.length, 1, "clicks do not issue synthetic view/query callbacks before camera movement finishes");
    await render({ selectedBucketId: bucket.id }); assert.equal(map.flights.length, 1, "selection effects do not repeat the flight");
    map.zoom = 10.5; map.emit("moveend"); map.emit("click", { point: { x: 10, y: 10 } }); assert.equal(picks.length, 3); assert.equal(map.flights.length, 1);
    map.zoom = 22; map.emit("click", { point: { x: 10, y: 10 } }); assert.equal(picks.length, 4); assert.equal(map.flights.length, 1);
    reduced = true; map.zoom = 1; map.emit("moveend"); await render({ bucketLevel: "country" }); map.emit("click", { point: { x: 10, y: 10 } });
    assert.equal((map.flights.at(-1) as { zoom: number }).zoom, 4.5); assert.equal((map.flights.at(-1) as { duration: number }).duration, 0);
  } finally { await act(async () => root.unmount()); host.remove(); reduced = false; }
});

test("real map effects keep one renderer and unchanged worker data across camera/UI updates, while selection, point changes and office focus remain live", async () => {
  const host = dom.document.createElement("div"); dom.document.body.append(host); const root = createRoot(host as unknown as HTMLDivElement);
  const basemap = { id: "synthetic", name: "Synthetic", maxZoom: 22, type: "vector-style" as const, styleUrl: "http://127.0.0.1/style.json", attributions: [{ label: "Synthetic", url: "https://synthetic.invalid" }] };
  const buckets = Array.from({ length: 100 }, (_, i) => ({ id: `synthetic-${i}`, label: `Synthetic ${i}`, latitude: 31, longitude: 121, jobCount: i + 1, categories: [{ color: "#123456", jobCount: i + 1 }] })) as AtlasPrototypeProps["buckets"];
  let views = 0;
  let props: AtlasPrototypeProps = { mode: "global", buckets, basemap, visual: { autoRotate: false }, onViewChange: () => { views++; } };
  const render = async (next: Partial<AtlasPrototypeProps> = {}) => { props = { ...props, ...next }; await act(async () => { root.render(h(MapLibrePrototype, props)); for (let i = 0; i < 4; i++) await nextTurn(); }); };
  try {
    await render(); const map = instances.at(-1)!; assert.ok(map); await act(async () => { map.emit("load"); map.emit("render"); });
    assert.deepEqual(map.projection, { type: "globe" }); assert.equal(map.options.maxZoom, 22); assert.equal(map.uploads, 0);
    const mounted = instances.length;
    for (let i = 0; i < 30; i++) await render({ initialView: { zoom: 2 + i / 10, center: [104, 26], pitch: 0, bearing: 0 }, visual: { autoRotate: false }, onViewChange: () => { views++; } });
    assert.equal(instances.length, mounted); assert.equal(map.uploads, 0); assert.equal(map.paints, 0); assert.equal(map.filters.length, 0);
    await render({ selectedBucketId: "synthetic-0", selectedRegionId: "CN" });
    assert.equal(map.uploads, 0); assert.equal(map.paints, 1); assert.equal(map.filters.length, 2);
    assert.match(JSON.stringify(map.filters.find(entry => entry.id === "bucket-labels")!.filter), /synthetic-0/);
    const focus: AtlasMapFocus = { jobId: "synthetic-job", locationId: "synthetic-office", longitude: 121.123456, latitude: 31.234567, precision: "address", zoom: 16.5, requestId: "focus-one" };
    await render({ selectedJobId: "synthetic-job", focus });
    assert.equal(markerEvents.filter(value => value === "create").length, 1); assert.equal(map.flights.length, 1); assert.equal((map.flights[0] as { zoom: number }).zoom, 16.5);
    for (let i = 0; i < 10; i++) await render({ onViewChange: () => { views++; } });
    assert.equal(markerEvents.filter(value => value === "create").length, 1); assert.equal(map.uploads, 0); assert.equal(map.flights.length, 1);
    await render({ selectedJobId: "another-job" }); assert.equal(markerEvents.at(-1), "remove");
    await render({ buckets: buckets.map((bucket, index) => index ? bucket : { ...bucket, longitude: 120 }) }); assert.equal(map.uploads, 1);
    for (let i = 0; i < 100; i++) map.emit("mousemove", { point: { x: i, y: i } });
    assert.equal(frames.size, 1); const queued = [...frames.values()]; frames.clear(); queued.forEach(callback => callback(performance.now())); assert.equal(map.queries, 1);
    map.moving = true; map.emit("zoomstart"); for (let i = 0; i < 100; i++) map.emit("mousemove", { point: { x: i, y: i } }); assert.equal(frames.size, 0); assert.equal(map.queries, 1);
    map.zoom = 12; map.moving = false; map.emit("zoomend"); map.emit("moveend"); assert.equal(views, 2);
    reduced = true; await render({ selectedJobId: "synthetic-job", focus: { ...focus, requestId: "focus-two" } });
    assert.equal((map.flights.at(-1) as { duration: number }).duration, 0); assert.equal(map.uploads, 1);
  } finally { await act(async () => root.unmount()); host.remove(); reduced = false; }
  assert.equal(instances.at(-1)!.removed, true); assert.equal(frames.size, 0);
});

test("a delayed street style cannot block local readiness, picking or point updates and installs into the same scene without resetting the camera", async () => {
  const pending = Promise.withResolvers<Response>(), savedFetch = globalThis.fetch;
  const basemap = { id: "synthetic-delayed", name: "Synthetic delayed", maxZoom: 22, type: "vector-style" as const, styleUrl: "http://127.0.0.1/delayed-style.json", attributions: [{ label: "Synthetic", url: "https://synthetic.invalid" }] };
  globalThis.fetch = async (input, init) => String(input) === basemap.styleUrl ? pending.promise : savedFetch(input, init);
  const host = dom.document.createElement("div"); dom.document.body.append(host); const root = createRoot(host as unknown as HTMLDivElement);
  const bucket: AtlasPrototypeProps["buckets"][number] = { id: "synthetic-delayed-bucket", label: "Synthetic city", longitude: 121, latitude: 31, jobIds: ["job"], locationIds: ["location"], jobCount: 1, pinCount: 1, categories: [] };
  let ready = 0; const picks: string[] = [], errors: Error[] = [];
  let props: AtlasPrototypeProps = { mode: "global", buckets: [bucket], basemap, onReady: () => { ready++; }, onPick: value => picks.push(value.id), onError: error => errors.push(error) };
  const settle = async () => { for (let i = 0; i < 4; i++) await nextTurn(); };
  const render = async (next: Partial<AtlasPrototypeProps> = {}) => { props = { ...props, ...next }; await act(async () => { root.render(h(MapLibrePrototype, props)); await settle(); }); };
  try {
    await render(); const map = instances.at(-1)!, count = instances.length;
    assert.ok(map, "local renderer exists before the optional style responds"); assert.equal(map.addedLayers.length, 0);
    await act(async () => { map.emit("load"); map.emit("render"); }); assert.equal(ready, 1);
    assert.match(host.textContent ?? "", /正在加载街道底图/); assert.equal(map.addedSources.length, 0);
    map.hits = [{ properties: { bucketId: bucket.id } }]; map.emit("click", { point: { x: 1, y: 1 } }); assert.deepEqual(picks, [bucket.id]);
    await render({ selectedBucketId: bucket.id, buckets: [{ ...bucket, longitude: 120 }] }); assert.equal(map.uploads, 1);
    map.zoom = 12; map.emit("moveend"); const flights = map.flights.length, filters = map.filters.length;
    await act(async () => { pending.resolve(new Response(JSON.stringify({ version: 8, sources: { detail: { type: "geojson", data: { type: "FeatureCollection", features: [] } } },
      layers: [{ id: "detail-fill", type: "fill", source: "detail" }], glyphs: "https://synthetic.invalid/{fontstack}/{range}.pbf" }))); await settle(); });
    assert.equal(instances.length, count); assert.equal(map.zoom, 12); assert.equal(map.flights.length, flights); assert.equal(map.uploads, 1); assert.equal(map.filters.length, filters);
    assert.deepEqual(map.addedSources.map(source => source.id), ["basemap:detail"]);
    assert.deepEqual(map.addedLayers.map(layer => [layer.id, layer.before]), [["basemap:detail-fill", "land-dots"], ["bucket-labels", undefined]]);
    const label = (map.options.style as { layers: Array<{ id: string; filter?: unknown }> }).layers.find(layer => layer.id === "bucket-labels")!;
    assert.match(JSON.stringify(label.filter), /synthetic-delayed-bucket/, "late labels retain selection made while the provider was pending");
    assert.equal(host.querySelector(".atlas-basemap-progress"), null); assert.equal(ready, 1); assert.deepEqual(errors, []);
  } finally { await act(async () => root.unmount()); host.remove(); globalThis.fetch = savedFetch; pending.resolve(new Response("{}")); }
});

test("failed or invalid optional street styles leave the local scene and query buckets usable without a fatal renderer error", async () => {
  const savedFetch = globalThis.fetch;
  for (const response of [() => Promise.reject(new Error("Synthetic provider unavailable")), async () => new Response(JSON.stringify({ version: 7, sources: {}, layers: [] }))]) {
    const host = dom.document.createElement("div"); dom.document.body.append(host); const root = createRoot(host as unknown as HTMLDivElement);
    globalThis.fetch = async (input, init) => String(input).endsWith("style.json") ? response() : savedFetch(input, init);
    let ready = 0; const errors: Error[] = [];
    try {
      await act(async () => { root.render(h(MapLibrePrototype, { mode: "domestic", buckets: [], basemap: { id: "synthetic-failed", name: "Synthetic", maxZoom: 22, type: "vector-style", styleUrl: "http://127.0.0.1/style.json", attributions: [{ label: "Synthetic", url: "https://synthetic.invalid" }] }, onReady: () => { ready++; }, onError: error => errors.push(error) })); for (let i = 0; i < 4; i++) await nextTurn(); });
      const map = instances.at(-1)!; await act(async () => { map.emit("load"); map.emit("render"); });
      assert.equal(ready, 1); assert.equal(map.removed, false); assert.deepEqual(map.projection, { type: "mercator" });
      assert.equal(map.getLayer("overview-land"), true); assert.equal(map.getLayer("bucket-cores"), true); assert.equal(map.addedSources.length, 0);
      assert.match(host.textContent ?? "", /在线底图未完整加载/); assert.equal(host.querySelector(".atlas-basemap-progress"), null); assert.deepEqual(errors, []);
    } finally { await act(async () => root.unmount()); host.remove(); }
  }
  globalThis.fetch = savedFetch;
});

test("late provider responses are isolated after mode changes and unmount even if the fetch transport ignores abort", async () => {
  const savedFetch = globalThis.fetch, pending = [Promise.withResolvers<Response>(), Promise.withResolvers<Response>()]; let requests = 0;
  const signals: AbortSignal[] = [];
  const basemap = { id: "synthetic-late", name: "Synthetic late", maxZoom: 22, type: "vector-style" as const, styleUrl: "http://127.0.0.1/late-style.json", attributions: [{ label: "Synthetic", url: "https://synthetic.invalid" }] };
  globalThis.fetch = async (input, init) => { if (String(input) !== basemap.styleUrl) return savedFetch(input, init); if (init?.signal) signals.push(init.signal); return pending[requests++]!.promise; };
  const host = dom.document.createElement("div"); dom.document.body.append(host); const root = createRoot(host as unknown as HTMLDivElement);
  const render = async (mode: "global" | "domestic") => { await act(async () => { root.render(h(MapLibrePrototype, { mode, buckets: [], basemap })); for (let i = 0; i < 4; i++) await nextTurn(); }); };
  const style = () => new Response(JSON.stringify({ version: 8, sources: { late: { type: "geojson", data: { type: "FeatureCollection", features: [] } } }, layers: [{ id: "late", type: "fill", source: "late" }] }));
  try {
    await render("global"); const first = instances.at(-1)!; await act(async () => { first.emit("load"); first.emit("render"); });
    await render("domestic"); const second = instances.at(-1)!; assert.equal(first.removed, true); assert.notEqual(first, second); assert.equal(signals[0]!.aborted, true);
    await act(async () => { second.emit("load"); second.emit("render"); pending[0]!.resolve(style()); for (let i = 0; i < 4; i++) await nextTurn(); });
    assert.equal(first.addedSources.length, 0); assert.equal(second.addedSources.length, 0); assert.match(host.textContent ?? "", /正在加载街道底图/);
    await act(async () => root.unmount()); assert.equal(signals[1]!.aborted, true);
    await act(async () => { pending[1]!.resolve(style()); for (let i = 0; i < 4; i++) await nextTurn(); }); assert.equal(second.removed, true); assert.equal(second.addedLayers.length, 0);
  } finally { if (!instances.at(-1)!.removed) await act(async () => root.unmount()); host.remove(); globalThis.fetch = savedFetch; pending.forEach(entry => entry.resolve(new Response("{}"))); }
});

test("context recovery clears failure and reports readiness only after a current restored render, without recreating the scene", async () => {
  const host = dom.document.createElement("div"); dom.document.body.append(host); const root = createRoot(host as unknown as HTMLDivElement);
  let ready = 0; const errors: Error[] = [];
  try {
    await act(async () => { root.render(h(MapLibrePrototype, { mode: "global", buckets: [], basemap: null, onReady: () => { ready++; }, onError: error => errors.push(error) })); for (let i = 0; i < 4; i++) await nextTurn(); });
    const map = instances.at(-1)!, count = instances.length;
    await act(async () => { map.emit("load"); map.emit("render"); }); assert.equal(ready, 1);
    const dispatch = (name: string) => map.canvas.dispatchEvent(new dom.Event(name, { cancelable: true }));
    await act(async () => { dispatch("webglcontextlost"); }); assert.equal(errors.length, 1); assert.ok(host.querySelector('[role="alert"]'));
    await act(async () => { dispatch("webglcontextrestored"); }); assert.equal(ready, 1); assert.ok(host.querySelector('[role="alert"]'));
    await act(async () => { dispatch("webglcontextlost"); map.emit("render"); }); assert.equal(ready, 1, "an obsolete restore cannot clear a newer loss"); assert.ok(host.querySelector('[role="alert"]'));
    await act(async () => { dispatch("webglcontextrestored"); map.emit("render"); }); assert.equal(ready, 2); assert.equal(host.querySelector('[role="alert"]'), null);
    assert.equal(instances.length, count); assert.equal(map.uploads, 0); assert.equal(map.removed, false);
    await act(async () => { dispatch("webglcontextlost"); dispatch("webglcontextrestored"); root.unmount(); map.emit("render"); }); assert.equal(ready, 2, "an unmounted renderer cannot report recovery");
  } finally { if (!instances.at(-1)!.removed) await act(async () => root.unmount()); host.remove(); }
});

test("raster detail is attached only after the packaged scene's first ready render", async () => {
  const host = dom.document.createElement("div"); dom.document.body.append(host); const root = createRoot(host as unknown as HTMLDivElement); let sourcesAtReady = -1;
  try {
    await act(async () => { root.render(h(MapLibrePrototype, { mode: "domestic", buckets: [], basemap: { id: "synthetic-raster", name: "Synthetic raster", maxZoom: 22, type: "raster", tiles: ["https://synthetic.invalid/{z}/{x}/{y}.png"], tileSize: 256, maxNativeZoom: 19, attributions: [{ label: "Synthetic", url: "https://synthetic.invalid" }] }, onReady: () => { sourcesAtReady = instances.at(-1)!.addedSources.length; } })); for (let i = 0; i < 4; i++) await nextTurn(); });
    const map = instances.at(-1)!; assert.equal(map.addedSources.length, 0);
    await act(async () => { map.emit("load"); map.emit("render"); });
    assert.equal(sourcesAtReady, 0); assert.deepEqual(map.addedSources.map(source => source.id), ["basemap:raster"]); assert.deepEqual(map.addedLayers, [{ id: "basemap:raster", before: "regions" }]);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test("a street-layer installation failure rolls back its own additions and keeps the local scene and selection", async () => {
  const pending = Promise.withResolvers<Response>(), savedFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => String(input).endsWith("rollback-style.json") ? pending.promise : savedFetch(input, init);
  const host = dom.document.createElement("div"); dom.document.body.append(host); const root = createRoot(host as unknown as HTMLDivElement); const errors: Error[] = [];
  try {
    await act(async () => { root.render(h(MapLibrePrototype, { mode: "global", buckets: [], selectedBucketId: "keep-this-selection", basemap: { id: "synthetic-rollback", name: "Synthetic rollback", maxZoom: 22, type: "vector-style", styleUrl: "http://127.0.0.1/rollback-style.json", attributions: [{ label: "Synthetic", url: "https://synthetic.invalid" }] }, onError: error => errors.push(error) })); for (let i = 0; i < 4; i++) await nextTurn(); });
    const map = instances.at(-1)!; map.throwOnLayer = "basemap:bad";
    await act(async () => { map.emit("load"); map.emit("render"); pending.resolve(new Response(JSON.stringify({ version: 8, sources: { detail: { type: "geojson", data: { type: "FeatureCollection", features: [] } } }, layers: [{ id: "first", type: "fill", source: "detail" }, { id: "bad", type: "fill", source: "detail" }], sprite: [{ id: "synthetic", url: "https://synthetic.invalid/sprite" }] }))); for (let i = 0; i < 4; i++) await nextTurn(); });
    assert.equal(map.getLayer("basemap:first"), false); assert.equal(map.getLayer("bucket-cores"), true); assert.equal(map.getLayer("overview-land"), true); assert.equal(map.addedSources.length, 0);
    assert.match(JSON.stringify(map.filters), /keep-this-selection/); assert.match(host.textContent ?? "", /在线底图未完整加载/); assert.deepEqual(errors, []);
    assert.deepEqual(map.sprite, [{ id: "synthetic", url: "https://synthetic.invalid/sprite" }]);
  } finally { await act(async () => root.unmount()); host.remove(); globalThis.fetch = savedFetch; pending.resolve(new Response("{}")); }
});
