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
  uploads = 0; queries = 0; paints = 0; filters: Array<{ id: string; filter: unknown }> = []; flights: unknown[] = []; projection: unknown; terrain: unknown[] = [];
  hits: Array<{ properties: { bucketId: string } }> = [{ properties: { bucketId: "synthetic-0" } }];
  addedSources: Array<{ id: string; source: unknown }> = []; addedLayers: Array<{ id: string; before?: string }> = []; layerSpecs: Array<{ id: string; [key: string]: unknown }> = []; glyphs: unknown; sprite: unknown;
  throwOnLayer = ""; throwOnSource = "";
  constructor(readonly options: Record<string, unknown>) { instances.push(this); this.canvas.tabIndex = 0; (options.container as typeof this.canvas.parentElement)?.appendChild(this.canvas); }
  on(name: string, callback: (...args: unknown[]) => void) { this.handlers.set(name, [...(this.handlers.get(name) ?? []), callback]); return this; }
  once(name: string, callback: (...args: unknown[]) => void) { const once = (...args: unknown[]) => { this.handlers.set(name, this.handlers.get(name)!.filter(entry => entry !== once)); callback(...args); }; return this.on(name, once); }
  emit(name: string, event: unknown = {}) { for (const handler of [...(this.handlers.get(name) ?? [])]) handler(event); }
  addControl() {} getCanvas() { return this.canvas; } getZoom() { return this.zoom; } getPitch() { return 0; } getBearing() { return 0; }
  getCenter() { return { lng: 104, lat: 26 }; } getBounds() { return { getWest: () => 100, getEast: () => 110, getSouth: () => 20, getNorth: () => 30 }; }
  isMoving() { return this.moving; } stop() { this.moving = false; } setCenter() {} resize() {} triggerRepaint() {}
  getLayer(id: string) { return ((this.options.style as { layers: Array<{ id: string }> }).layers).some(layer => layer.id === id); }
  getSource(id: string) { return id === "buckets" || id === "boundaries" || this.addedSources.some(source => source.id === id) ? { setData: () => { this.uploads++; } } : undefined; }
  addSource(id: string, source: unknown) { if (this.throwOnSource === id) throw new Error("Synthetic source rejected"); this.addedSources.push({ id, source }); }
  addLayer(layer: { id: string; [key: string]: unknown }, before?: string) { if (this.throwOnLayer === layer.id) throw new Error("Synthetic provider layer rejected"); this.addedLayers.push({ id: layer.id, before }); this.layerSpecs.push(layer); ((this.options.style as { layers: Array<{ id: string }> }).layers).push(layer); }
  removeLayer(id: string) { const style = this.options.style as { layers: Array<{ id: string }> }; style.layers = style.layers.filter(layer => layer.id !== id); }
  removeSource(id: string) { this.addedSources = this.addedSources.filter(source => source.id !== id); }
  setTerrain(value: unknown) { this.terrain.push(value); return this; }
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
    if (url.endsWith("/MapLibrePrototype.tsx") || url.endsWith("/AtlasBucketChoices.tsx")) return { source: ts.transpileModule(readFileSync(new URL(url), "utf8").replaceAll("import.meta.env.BASE_URL", "'/'"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, format: "module", shortCircuit: true };
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

test("overlapping hits expose each original bucket or all jobs without choosing the top point or inventing a camera target", async () => {
  const host = dom.document.createElement("div"); dom.document.body.append(host); const root = createRoot(host as unknown as HTMLDivElement);
  const make = (id: string, jobIds: string[]): AtlasPrototypeProps["buckets"][number] => ({ id, jobIds, label: `Synthetic ${id}`, longitude: 121, latitude: 31,
    locationIds: [`office-${id}`], jobCount: jobIds.length, pinCount: jobIds.length, categories: [] });
  const a = make("A", ["one", "shared"]), b = { ...make("B", ["shared", "two"]), positionBasis: "city-reference" as const, precision: "city" as const, estimated: true as const };
  const picks: typeof a[] = [], all: Array<readonly typeof a[]> = [];
  let props: AtlasPrototypeProps = { mode: "global", buckets: [a, b], bucketLevel: "location", basemap: null, onPick: bucket => picks.push(bucket), onPickMany: buckets => all.push(buckets) };
  const render = async (next: Partial<AtlasPrototypeProps> = {}) => { props = { ...props, ...next }; await act(async () => { root.render(h(MapLibrePrototype, props)); for (let i = 0; i < 4; i++) await nextTurn(); }); };
  const panel = () => host.querySelector('[aria-label="选择重叠地图标记"]');
  const clickText = async (text: string) => { const button = [...panel()!.querySelectorAll("button")].find(node => node.textContent!.includes(text))!; assert.ok(button); await act(async () => button.click()); };
  try {
    await render(); const map = instances.at(-1)!; await act(async () => { map.emit("load"); map.emit("render"); }); map.zoom = 22;
    map.hits = ["A", "B", "A", "retired"].map(bucketId => ({ properties: { bucketId } }));
    const open = async () => { await act(async () => map.emit("click", { point: { x: 10, y: 10 } })); };
    await open(); assert.ok(panel()); assert.equal(panel()!.querySelectorAll("button").length, 4); assert.match(panel()!.textContent!, /查看全部 3 个岗位/);
    assert.match(panel()!.textContent!, /城市分布参考 · 估算/); assert.match(panel()!.textContent!, /不代表同一办公室/);
    assert.equal(picks.length, 0); assert.equal(all.length, 0); assert.equal(map.flights.length, 0);
    assert.equal(dom.document.activeElement, panel()!.querySelector("button"));
    await clickText("Synthetic B"); assert.equal(picks[0], b); assert.equal(panel(), null); assert.equal(map.flights.length, 0); assert.equal(dom.document.activeElement, map.canvas);
    await open(); await clickText("查看全部"); assert.deepEqual(all, [[a, b]]); assert.equal(picks.length, 1); assert.equal(map.flights.length, 0); assert.equal(map.uploads, 0);
    await render({ selectedBucketIds: ["B", "A"] }); assert.match(JSON.stringify(map.filters.at(-1)), /A/); assert.match(JSON.stringify(map.filters.at(-1)), /B/);
    const filters = map.filters.length; await render({ selectedBucketIds: ["A", "B", "A"] }); assert.equal(map.filters.length, filters); assert.equal(map.uploads, 0);
    await open(); await act(async () => panel()!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }))); assert.equal(panel(), null); assert.equal(dom.document.activeElement, map.canvas);
    await open(); await act(async () => map.emit("movestart")); assert.equal(panel(), null);
    await open(); await render({ buckets: [a, { ...b, jobIds: ["changed", "shared"] }] }); assert.equal(panel(), null, "job identity changes retire the overlay even when geometry is unchanged"); assert.equal(map.uploads, 0);
    map.hits = [{ properties: { bucketId: "B" } }]; await open(); assert.equal(picks.at(-1), props.buckets[1], "later picks resolve current domain objects");
    await render({ bucketLevel: "city" }); map.hits = ["A", "B"].map(bucketId => ({ properties: { bucketId } })); await open();
    await render({ bucketLevel: "location" }); assert.equal(panel(), null, "aggregation changes retire the old overlay");
    await render({ bucketLevel: "city" }); assert.equal(panel(), null, "returning to an earlier level cannot revive its old choices");
    await open(); await render({ basemap: { id: "synthetic-rebuild", name: "Synthetic", type: "vector-style", maxZoom: 22, styleUrl: "http://127.0.0.1/style.json", attributions: [{ label: "Synthetic", url: "https://synthetic.invalid" }] } });
    assert.equal(panel(), null, "a new map generation cannot leave choices bound to the retired renderer");
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test("opening overlapping markers cancels pending automatic rotation after every camera interaction", async t => {
  const host = dom.document.createElement("div"); dom.document.body.append(host); const root = createRoot(host as unknown as HTMLDivElement);
  const bucket: AtlasPrototypeProps["buckets"][number] = { id: "rotation-a", label: "Synthetic A", longitude: 121, latitude: 31,
    jobIds: ["rotation-job-a"], locationIds: ["rotation-location-a"], jobCount: 1, pinCount: 1, categories: [] };
  const buckets = [bucket, { ...bucket, id: "rotation-b", jobIds: ["rotation-job-b"], locationIds: ["rotation-location-b"] }];
  const panel = () => host.querySelector('[aria-label="选择重叠地图标记"]');
  try {
    await act(async () => { root.render(h(MapLibrePrototype, { mode: "global", buckets, basemap: null, visual: { autoRotate: true } })); for (let i = 0; i < 4; i++) await nextTurn(); });
    const map = instances.at(-1)!; await act(async () => { map.emit("load"); map.emit("render"); });
    assert.equal(map.zoom, 1.65); assert.equal(frames.size, 1, "overview starts with automatic rotation enabled");
    map.hits = buckets.map(value => ({ properties: { bucketId: value.id } }));
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const interaction of ["drag", "zoom", "rotate", "pitch"]) {
      map.stop = () => { map.moving = false; map.emit(`${interaction}end`); };
      await act(async () => { map.emit(`${interaction}start`); map.emit(`${interaction}end`); });
      assert.equal(frames.size, 0);
      await act(async () => t.mock.timers.tick(300));
      await act(async () => map.emit("click", { point: { x: 10, y: 10 } })); assert.ok(panel());
      await act(async () => t.mock.timers.tick(701));
      assert.equal(frames.size, 0, `${interaction} resume cannot restart rotation while the marker choices are open`);
      assert.ok(panel(), `${interaction} resume keeps the marker choices available`);
      assert.equal(map.flights.length, 0); assert.equal(map.uploads, 0);
      await act(async () => { map.emit(`${interaction}start`); map.emit(`${interaction}end`); });
      assert.equal(panel(), null, "a new deliberate camera interaction closes the choices");
      await act(async () => t.mock.timers.tick(701));
      assert.equal(frames.size, 1, "automatic rotation can resume after a subsequent deliberate interaction");
    }
  } finally { await act(async () => root.unmount()); host.remove(); t.mock.timers.reset(); }
  assert.equal(frames.size, 0);
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
    assert.equal(map.getLayer("bucket-precision-ring"), true, "markers expose source precision with a visible status ring");
    assert.equal(map.getLayer("bucket-estimate-ring"), true, "estimated city points receive an outer status ring");
    const precisionLayer = (map.options.style as { layers: Array<{ id: string; paint?: Record<string, unknown> }> }).layers.find(layer => layer.id === "bucket-precision-ring");
    assert.deepEqual(precisionLayer?.paint?.["circle-stroke-color"], ["get", "precisionColor"]);
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
  const second = { ...bucket, id: "synthetic-delayed-second", jobIds: ["second-job"], locationIds: ["second-location"] };
  let ready = 0; const picks: string[] = [], errors: Error[] = [];
  let props: AtlasPrototypeProps = { mode: "global", buckets: [bucket, second], basemap, onReady: () => { ready++; }, onPick: value => picks.push(value.id), onError: error => errors.push(error) };
  const settle = async () => { for (let i = 0; i < 4; i++) await nextTurn(); };
  const render = async (next: Partial<AtlasPrototypeProps> = {}) => { props = { ...props, ...next }; await act(async () => { root.render(h(MapLibrePrototype, props)); await settle(); }); };
  try {
    await render(); const map = instances.at(-1)!, count = instances.length;
    assert.ok(map, "local renderer exists before the optional style responds"); assert.equal(map.addedLayers.length, 0);
    await act(async () => { map.emit("load"); map.emit("render"); }); assert.equal(ready, 1);
    assert.match(host.textContent ?? "", /正在加载街道底图/); assert.equal(map.addedSources.length, 0);
    map.hits = [{ properties: { bucketId: bucket.id } }]; await act(async () => map.emit("click", { point: { x: 1, y: 1 } })); assert.deepEqual(picks, [bucket.id]);
    await render({ selectedBucketId: bucket.id, selectedBucketIds: [second.id], buckets: [{ ...bucket, longitude: 120 }, second] }); assert.equal(map.uploads, 1);
    map.zoom = 12; map.emit("moveend"); const flights = map.flights.length, filters = map.filters.length;
    await act(async () => { pending.resolve(new Response(JSON.stringify({ version: 8, sources: { detail: { type: "geojson", data: { type: "FeatureCollection", features: [] } } },
      layers: [{ id: "detail-fill", type: "fill", source: "detail" }], glyphs: "https://synthetic.invalid/{fontstack}/{range}.pbf" }))); await settle(); });
    assert.equal(instances.length, count); assert.equal(map.zoom, 12); assert.equal(map.flights.length, flights); assert.equal(map.uploads, 1); assert.equal(map.filters.length, filters);
    assert.deepEqual(map.addedSources.map(source => source.id), ["basemap:detail"]);
    assert.deepEqual(map.addedLayers.map(layer => [layer.id, layer.before]), [["basemap:detail-fill", "land-dots"], ["bucket-labels", undefined]]);
    const label = (map.options.style as { layers: Array<{ id: string; filter?: unknown }> }).layers.find(layer => layer.id === "bucket-labels")!;
    assert.match(JSON.stringify(label.filter), /synthetic-delayed-bucket/, "late labels retain selection made while the provider was pending");
    assert.match(JSON.stringify(label.filter), /synthetic-delayed-second/, "late labels include every selected overlap member");
    assert.equal(host.querySelector(".atlas-basemap-progress"), null); assert.equal(ready, 1); assert.deepEqual(errors, []);
  } finally { await act(async () => root.unmount()); host.remove(); globalThis.fetch = savedFetch; pending.resolve(new Response("{}")); }
});

test("OpenFreeMap close-range buildings and house numbers are capability-gated below job markers and retain source precision", async () => {
  const savedFetch = globalThis.fetch;
  const styleUrl = "https://tiles.openfreemap.org/styles/dark", tileJsonUrl = "https://tiles.openfreemap.org/planet";
  const basemap = { id: "openfreemap-dark", name: "OpenFreeMap", maxZoom: 22, type: "vector-style" as const, styleUrl, attributions: [{ label: "OpenFreeMap", url: "https://openfreemap.org/" }] };
  const style = { version: 8, sources: { openmaptiles: { type: "vector", url: tileJsonUrl } }, layers: [
    { id: "building", type: "fill", source: "openmaptiles", "source-layer": "building", minzoom: 12 },
    { id: "place-labels", type: "symbol", source: "openmaptiles", "source-layer": "place", minzoom: 4 },
  ], glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf" };
  const tileJson = { vector_layers: [
    { id: "building", minzoom: 13, maxzoom: 14, fields: { render_height: "Number", render_min_height: "Number" } },
    { id: "housenumber", minzoom: 14, maxzoom: 14, fields: { housenumber: "String" } },
  ] };
  const fetches: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input); fetches.push(url);
    if (url === styleUrl) return new Response(JSON.stringify(style));
    if (url === tileJsonUrl) return new Response(JSON.stringify(tileJson));
    return savedFetch(input, init);
  };
  const host = dom.document.createElement("div"); dom.document.body.append(host); const root = createRoot(host as unknown as HTMLDivElement);
  const focus: AtlasMapFocus = { jobId: "exact-job", locationId: "verified-office", longitude: 121.1234, latitude: 31.2345, precision: "address", verification: "verified", zoom: 16.5, requestId: "exact-focus" };
  try {
    await act(async () => { root.render(h(MapLibrePrototype, { mode: "domestic", buckets: [], focus, selectedJobId: "exact-job", basemap })); for (let i = 0; i < 6; i++) await nextTurn(); });
    const map = instances.at(-1)!;
    await act(async () => { map.emit("load"); map.emit("render"); for (let i = 0; i < 6; i++) await nextTurn(); });
    assert.deepEqual(fetches.filter(url => url === styleUrl || url === tileJsonUrl), [styleUrl, tileJsonUrl]);
    assert.deepEqual(map.addedLayers.filter(layer => layer.id.startsWith("atlas-" )).map(layer => [layer.id, layer.before]), [
      ["atlas-buildings-3d", "basemap:place-labels"], ["atlas-house-numbers", "basemap:place-labels"],
    ]);
    assert.deepEqual(map.flights.map(value => (value as { zoom: number }).zoom), [16.5]);
    const building = map.layerSpecs.find(layer => layer.id === "atlas-buildings-3d") as { paint: Record<string, unknown> };
    const labels = map.layerSpecs.find(layer => layer.id === "atlas-house-numbers") as { layout: Record<string, unknown> };
    assert.equal(building.paint["fill-extrusion-color"], "#23566a");
    assert.deepEqual(building.paint["fill-extrusion-height"], ["coalesce", ["get", "render_height"], 0]);
    assert.deepEqual(labels.layout["text-field"], ["get", "housenumber"]);
    assert.match(host.textContent ?? "", /地址级坐标/);
    assert.equal(map.getLayer("bucket-cores"), true, "job markers remain in the map style above provider detail");
  } finally { await act(async () => root.unmount()); host.remove(); globalThis.fetch = savedFetch; }
});

test("missing OpenFreeMap TileJSON fields leaves the provider's original street layers unchanged", async () => {
  const savedFetch = globalThis.fetch;
  const styleUrl = "https://tiles.openfreemap.org/styles/positron", tileJsonUrl = "https://tiles.openfreemap.org/planet";
  const basemap = { id: "openfreemap-positron", name: "OpenFreeMap", maxZoom: 22, type: "vector-style" as const, styleUrl, attributions: [{ label: "OpenFreeMap", url: "https://openfreemap.org/" }] };
  const style = { version: 8, sources: { openmaptiles: { type: "vector", url: tileJsonUrl } }, layers: [
    { id: "building", type: "fill", source: "openmaptiles", "source-layer": "building", minzoom: 12 },
  ] };
  globalThis.fetch = async (input, init) => String(input) === styleUrl ? new Response(JSON.stringify(style))
    : String(input) === tileJsonUrl ? new Response(JSON.stringify({ vector_layers: [{ id: "building", fields: { render_height: "String" } }, { id: "housenumber", fields: { housenumber: "Number" } }] }))
      : savedFetch(input, init);
  const host = dom.document.createElement("div"); dom.document.body.append(host); const root = createRoot(host as unknown as HTMLDivElement);
  try {
    await act(async () => { root.render(h(MapLibrePrototype, { mode: "global", buckets: [], basemap })); for (let i = 0; i < 6; i++) await nextTurn(); });
    const map = instances.at(-1)!;
    await act(async () => { map.emit("load"); map.emit("render"); for (let i = 0; i < 6; i++) await nextTurn(); });
    assert.deepEqual(map.addedLayers.map(layer => layer.id), ["basemap:building"]);
    assert.equal(map.getLayer("bucket-cores"), true); assert.equal(host.querySelector('[role="alert"]'), null);
  } finally { await act(async () => root.unmount()); host.remove(); globalThis.fetch = savedFetch; }
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

test("domestic local readiness does not wait for or request DEM terrain unless the user opts in", async () => {
  const host = dom.document.createElement("div"); dom.document.body.append(host); const root = createRoot(host as unknown as HTMLDivElement);
  let ready = 0, sourcesAtReady = -1;
  try {
    await act(async () => { root.render(h(MapLibrePrototype, { mode: "domestic", buckets: [], basemap: null, onReady: () => { ready++; sourcesAtReady = instances.at(-1)!.addedSources.length; } })); for (let i = 0; i < 4; i++) await nextTurn(); });
    const map = instances.at(-1)!, button = host.querySelector("button");
    assert.ok(button); assert.equal(button.textContent, "开启真实地形"); assert.equal(map.addedSources.length, 0);
    await act(async () => { map.emit("load"); map.emit("render"); });
    assert.equal(ready, 1); assert.equal(sourcesAtReady, 0, "the packaged scene reports ready before any remote DEM source exists");
    assert.equal(map.addedSources.length, 0); assert.deepEqual(map.terrain, []);
    assert.equal(map.getLayer("overview-land"), true); assert.equal(map.getLayer("bucket-cores"), true);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test("domestic DEM opt-in uses Terrarium settings and toggles terrain in the same map instance", async () => {
  const host = dom.document.createElement("div"); dom.document.body.append(host); const root = createRoot(host as unknown as HTMLDivElement);
  const render = async () => { await act(async () => { root.render(h(MapLibrePrototype, { mode: "domestic", buckets: [], basemap: null })); for (let i = 0; i < 4; i++) await nextTurn(); }); };
  try {
    await render(); const map = instances.at(-1)!, count = instances.length;
    await act(async () => { map.emit("load"); map.emit("render"); });
    const button = host.querySelector("button")!;
    await act(async () => button.click());
    assert.equal(button.textContent, "关闭地形"); assert.equal(button.getAttribute("aria-pressed"), "true");
    assert.ok(host.querySelector('a[href="https://registry.opendata.aws/terrain-tiles/"]'), "the active terrain shows a visible linked dataset credit");
    assert.equal(instances.length, count); assert.equal(map.addedSources.length, 1);
    const source = map.addedSources[0]!;
    assert.equal(source.id, "atlas-terrain-dem");
    assert.deepEqual(source.source, {
      type: "raster-dem", tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 15,
      bounds: [73.602256, 15.775377, 134.772579, 53.569444], encoding: "terrarium",
      attribution: '<a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener noreferrer">Mapzen Terrain Tiles on AWS Open Data</a> · <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener noreferrer">underlying elevation data credits</a>',
    });
    assert.deepEqual(map.terrain, [{ source: "atlas-terrain-dem", exaggeration: 1.25 }]);
    map.zoom = 11; await act(async () => button.click());
    assert.equal(button.textContent, "开启真实地形"); assert.equal(map.terrain.at(-1), null); assert.equal(map.getSource("atlas-terrain-dem"), undefined);
    assert.equal(host.querySelector('a[href="https://registry.opendata.aws/terrain-tiles/"]'), null);
    await act(async () => button.click());
    assert.equal(instances.length, count); assert.equal(map.zoom, 11, "terrain toggling preserves the camera and renderer");
    assert.equal(map.addedSources.length, 1); assert.equal(map.terrain.length, 3); assert.equal((map.terrain.at(-1) as { source: string }).source, "atlas-terrain-dem");
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test("a DEM tile failure rolls terrain back while preserving the domestic scene, focus marker and retry control", async () => {
  const host = dom.document.createElement("div"); dom.document.body.append(host); const root = createRoot(host as unknown as HTMLDivElement);
  const focus: AtlasMapFocus = { jobId: "dem-job", locationId: "dem-office", longitude: 121.1, latitude: 31.2, precision: "address", zoom: 16, requestId: "dem-focus" };
  const render = async () => { await act(async () => { root.render(h(MapLibrePrototype, { mode: "domestic", buckets: [], basemap: null, focus, selectedJobId: focus.jobId })); for (let i = 0; i < 4; i++) await nextTurn(); }); };
  try {
    const markerEventStart = markerEvents.length;
    await render(); const map = instances.at(-1)!, count = instances.length;
    await act(async () => { map.emit("load"); map.emit("render"); });
    assert.ok(markerEvents.slice(markerEventStart).includes("create"), "the selected office marker is present before enabling terrain");
    const button = host.querySelector("button")!; await act(async () => button.click());
    await act(async () => map.emit("error", { sourceId: "atlas-terrain-dem", error: new Error("DEM tile HTTP 503") }));
    assert.equal(button.textContent, "开启真实地形"); assert.equal(button.getAttribute("aria-pressed"), "false");
    assert.equal(map.terrain.at(-1), null); assert.equal(map.getSource("atlas-terrain-dem"), undefined);
    assert.equal(instances.length, count); assert.equal(map.removed, false);
    assert.equal(map.getLayer("overview-land"), true); assert.equal(map.getLayer("bucket-cores"), true);
    assert.ok(markerEvents.slice(markerEventStart).includes("create")); assert.equal(markerEvents.slice(markerEventStart).includes("remove"), false);
    assert.match(host.textContent ?? "", /真实地形瓦片暂不可用/); assert.equal(host.querySelector('[role="alert"]'), null);
    await act(async () => button.click());
    assert.equal(map.addedSources.length, 1, "the user can explicitly retry after the failed source was rolled back");
    assert.equal(host.textContent?.includes("真实地形瓦片暂不可用"), false);
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
