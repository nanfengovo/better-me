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
  constructor(readonly options: Record<string, unknown>) { instances.push(this); }
  on(name: string, callback: (...args: unknown[]) => void) { this.handlers.set(name, [...(this.handlers.get(name) ?? []), callback]); return this; }
  once(name: string, callback: (...args: unknown[]) => void) { const once = (...args: unknown[]) => { this.handlers.set(name, this.handlers.get(name)!.filter(entry => entry !== once)); callback(...args); }; return this.on(name, once); }
  emit(name: string, event: unknown = {}) { for (const handler of [...(this.handlers.get(name) ?? [])]) handler(event); }
  addControl() {} getCanvas() { return this.canvas; } getZoom() { return this.zoom; } getPitch() { return 0; } getBearing() { return 0; }
  getCenter() { return { lng: 104, lat: 26 }; } getBounds() { return { getWest: () => 100, getEast: () => 110, getSouth: () => 20, getNorth: () => 30 }; }
  isMoving() { return this.moving; } stop() { this.moving = false; } setCenter() {} resize() {} triggerRepaint() {}
  getLayer(id: string) { return ((this.options.style as { layers: Array<{ id: string }> }).layers).some(layer => layer.id === id); }
  getSource() { return { setData: () => { this.uploads++; } }; }
  setProjection(value: unknown) { this.projection = value; } setSky() {} setLight() {}
  setFilter(id: string, filter: unknown) { this.filters.push({ id, filter }); }
  setPaintProperty() { this.paints++; } queryRenderedFeatures() { this.queries++; return [{ properties: { bucketId: "synthetic-0" } }]; }
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
