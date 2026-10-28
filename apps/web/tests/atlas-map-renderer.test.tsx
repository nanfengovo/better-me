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
  uploads = 0; boundaryUploads = 0; fits = 0; queries = 0; paints = 0; filters: Array<{ id: string; filter: unknown }> = []; flights: unknown[] = []; eases: Array<{ pitch: number; bearing: number; duration: number }> = []; visibility: Array<[string, string, unknown]> = []; projection: unknown;
  queryResults: unknown[] = [{ properties: { bucketId: "synthetic-0" } }]; queryArguments: unknown[] = [];
  constructor(readonly options: Record<string, unknown>) { this.canvas.tabIndex = 0; (options.container as HTMLElement).append(this.canvas); instances.push(this); }
  on(name: string, callback: (...args: unknown[]) => void) { this.handlers.set(name, [...(this.handlers.get(name) ?? []), callback]); return this; }
  once(name: string, callback: (...args: unknown[]) => void) { const once = (...args: unknown[]) => { this.handlers.set(name, this.handlers.get(name)!.filter(entry => entry !== once)); callback(...args); }; return this.on(name, once); }
  emit(name: string, event: unknown = {}) { for (const handler of [...(this.handlers.get(name) ?? [])]) handler(event); }
  addControl() {} getCanvas() { return this.canvas; } getZoom() { return this.zoom; } getPitch() { return 0; } getBearing() { return 0; }
  getCenter() { return { lng: 104, lat: 26 }; } getBounds() { return { getWest: () => 100, getEast: () => 110, getSouth: () => 20, getNorth: () => 30 }; }
  isMoving() { return this.moving; } stop() { this.moving = false; } setCenter() {} resize() {} triggerRepaint() {}
  getLayer(id: string) { return ((this.options.style as { layers: Array<{ id: string }> }).layers).some(layer => layer.id === id); }
  getSource(id?: string) { return { setData: () => { if (id === "buckets") this.uploads++; if (id === "admin-highlight") this.boundaryUploads++; } }; }
  setProjection(value: unknown) { this.projection = value; } setSky() {} setLight() {}
  setLayoutProperty(id: string, name: string, value: unknown) { this.visibility.push([id, name, value]); }
  easeTo(options: { pitch: number; bearing: number; duration: number }) { this.eases.push(options); }
  setFilter(id: string, filter: unknown) { this.filters.push({ id, filter }); }
  setPaintProperty() { this.paints++; } queryRenderedFeatures(...args: unknown[]) { this.queries++; this.queryArguments.push(args); return this.queryResults; }
  project(coordinates: [number, number]) { return { x: coordinates[0], y: coordinates[1] }; }
  fitBounds() { this.fits++; } jumpTo() {} flyTo(options: unknown) { this.flights.push(options); } remove() { this.removed = true; }
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
globalThis.fetch = async input => new Response(JSON.stringify(String(input).endsWith("style.json") ? {
  version: 8, sources: { openmaptiles: { type: "vector", url: "https://synthetic.invalid/planet" } },
  layers: [
    { id: "building", type: "fill", source: "openmaptiles", "source-layer": "building", minzoom: 12, filter: ["==", ["get", "class"], "building"], paint: { "fill-color": "#123456" } },
    { id: "building-secondary", type: "fill", source: "openmaptiles", "source-layer": "building", minzoom: 13, filter: ["==", ["get", "class"], "building-part"], paint: { "fill-color": "#654321" } },
  ],
  glyphs: "https://synthetic.invalid/{fontstack}/{range}.pbf",
} : { type: "FeatureCollection", features: [] }), { headers: { "content-type": "application/json" } });
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
  const buckets = Array.from({ length: 100 }, (_, i) => ({ id: `synthetic-${i}`, label: `Synthetic ${i}`, latitude: i < 2 ? 31 : i < 4 ? 80 : 85, longitude: 121, jobCount: i + 1, displayGrade: "address", categories: [{ color: "#123456", jobCount: i + 1 }] })) as AtlasPrototypeProps["buckets"];
  let views = 0;
  let picked: string | undefined;
  let props: AtlasPrototypeProps = { mode: "global", buckets, basemap, visual: { autoRotate: false }, onViewChange: () => { views++; }, onPick: bucket => { picked = bucket.id; } };
  const render = async (next: Partial<AtlasPrototypeProps> = {}) => { props = { ...props, ...next }; await act(async () => { root.render(h(MapLibrePrototype, props)); for (let i = 0; i < 4; i++) await nextTurn(); }); };
  try {
    await render(); const map = instances.at(-1)!; assert.ok(map); await act(async () => { map.emit("load"); map.emit("render"); });
    assert.deepEqual(map.projection, { type: "globe" }); assert.equal(map.options.maxZoom, 22); assert.equal(map.uploads, 0);
    const building3d = (map.options.style as { layers: Array<Record<string, unknown>> }).layers.find(layer => layer.id === "basemap:building:3d");
    assert.ok(building3d, `vector OSM building footprints receive a 3D extrusion layer; got: ${JSON.stringify(((map.options.style as { layers: Array<Record<string, unknown>> }).layers).map(layer => layer.id))}; UI: ${host.textContent}`);
    assert.equal(building3d!.type, "fill-extrusion"); assert.equal(building3d!.source, "basemap:openmaptiles");
    assert.deepEqual(building3d!.filter, ["all", ["any", ["==", ["get", "class"], "building"], ["==", ["get", "class"], "building-part"]], ["any", ["has", "render_height"], ["has", "height"]]], "extruded buildings retain base-style visibility and require a height attribute");
    assert.deepEqual(building3d!.paint && (building3d!.paint as Record<string, unknown>)["fill-extrusion-height"], ["case", ["has", "render_height"], ["to-number", ["get", "render_height"], 0], ["to-number", ["get", "height"], 0]], "rendered height remains tied to the source's actual height field");
    const styleLayers = (map.options.style as { layers: Array<{ id: string }> }).layers;
    const buildingEdges = styleLayers.find(layer => layer.id === "basemap:building:3d-edges");
    assert.ok(buildingEdges, "height-backed building extrusions have a fine footprint edge layer");
    assert.deepEqual(buildingEdges!.filter, building3d!.filter, "the same basemap and height filters apply to footprint edges");
    assert.equal(styleLayers.filter(layer => /:3d(?:-edges)?$/.test(layer.id)).length, 2, "duplicate fill styles for one building source do not duplicate 3D volumes");
    assert.ok(styleLayers.findIndex(layer => layer.id === "basemap:building:3d") < styleLayers.findIndex(layer => layer.id === "basemap:building:3d-edges"), "footprint edges render above the building volume");
    const detailedLabels = styleLayers.find(layer => layer.id === "bucket-detail-labels");
    assert.equal(detailedLabels!.minzoom, 11, "complete address labels appear at neighborhood scale rather than crowding the world view");
    assert.deepEqual((detailedLabels!.layout as Record<string, unknown>)["text-field"], ["get", "fullLabel"]);
    const stackLayer = styleLayers.find(layer => layer.id === "bucket-stack-markers");
    assert.ok(stackLayer, "exactly co-located source addresses receive one visible aggregate marker");
    const initialBucketData = (map.options.style as any).sources.buckets.data;
    const stack = initialBucketData.features.find(feature => feature.properties.kind === "stack" && feature.geometry.coordinates[1] === 31);
    assert.deepEqual(stack?.geometry.coordinates, [121, 31]);
    assert.equal(stack?.properties.stackLocationCount, 2);
    assert.equal(stack?.properties.stackJobCount, 3);
    assert.ok(styleLayers.findIndex(layer => layer.id === "admin-highlight-fill") < styleLayers.findIndex(layer => layer.id === "admin-highlight-casing"));
    assert.ok(styleLayers.findIndex(layer => layer.id === "admin-highlight-casing") < styleLayers.findIndex(layer => layer.id === "admin-highlight-stroke"));
    assert.match(host.textContent ?? "", /办公地址100/, "source-backed office points have an explicit address browser even when map labels collide");
    const locationTrigger = host.querySelector<HTMLButtonElement>("[aria-label='查看可点办公地址，共 100 个地点']");
    assert.ok(locationTrigger);
    await act(async () => { locationTrigger!.click(); await nextTurn(); });
    const locationOptions = [...host.querySelectorAll<HTMLButtonElement>(".atlas-map-location-list button")];
    assert.equal(locationOptions.length, 100, "the address browser keeps every mappable office location selectable");
    assert.equal(locationOptions[0]!.title, "Synthetic 99", "address options are ordered by job count for quick scanning");
    await act(async () => { locationOptions[0]!.click(); await nextTurn(); });
    assert.equal(picked, "synthetic-99", "address browser selection reaches the same onPick callback as a map click");
    const mounted = instances.length;
    const boundaryUploads = map.boundaryUploads;
    for (let i = 0; i < 30; i++) await render({ initialView: { zoom: 2 + i / 10, center: [104, 26], pitch: 0, bearing: 0 }, visual: { autoRotate: false }, onViewChange: () => { views++; } });
    assert.equal(instances.length, mounted); assert.equal(map.uploads, 0); assert.equal(map.paints, 0); assert.equal(map.filters.length, 3, "initial boundary filters are initialized once");
    assert.equal(map.boundaryUploads, boundaryUploads, "camera/UI progress does not retransmit unchanged administrative geometry");
    await render({ selectedBucketId: "synthetic-0", selectedRegionId: "CN" });
    assert.equal(map.uploads, 0); assert.equal(map.paints, 1); assert.equal(map.filters.length, 5);
    assert.equal(map.boundaryUploads, boundaryUploads, "changing a selected job or region only changes highlights, not the unchanged boundary source");
    assert.match(JSON.stringify(map.filters.find(entry => entry.id === "bucket-labels")!.filter), /synthetic-0/);
    const focus: AtlasMapFocus = { jobId: "synthetic-job", locationId: "synthetic-office", longitude: 121.123456, latitude: 31.234567, precision: "address", zoom: 16.5, requestId: "focus-one" };
    await render({ selectedJobId: "synthetic-job", focus });
    assert.equal(markerEvents.filter(value => value === "create").length, 1); assert.equal(map.flights.length, 1); assert.equal((map.flights[0] as { zoom: number }).zoom, 16.5);
    for (let i = 0; i < 10; i++) await render({ onViewChange: () => { views++; } });
    assert.equal(markerEvents.filter(value => value === "create").length, 1); assert.equal(map.uploads, 0); assert.equal(map.flights.length, 1); assert.equal(map.filters.length, 5, "camera/UI rerenders do not rewrite boundary filters");
    await render({ selectedJobId: "another-job" }); assert.equal(markerEvents.at(-1), "remove");
    await render({ buckets: buckets.map((bucket, index) => index ? bucket : { ...bucket, longitude: 120 }) }); assert.equal(map.uploads, 1);
    map.queryResults = [{ properties: { bucketId: "synthetic-0" } }];
    await act(async () => { map.emit("click", { point: { x: 136, y: 31 } }); await nextTurn(); });
    assert.match(host.textContent ?? "", /附近有 2 个地点/, "exactly co-located offices can be opened as an explicit choice");
    assert.deepEqual(map.queryArguments.at(-1)?.[0], [[108, 3], [164, 59]], "click hit test queries a 56px screen-space region for touch-friendly office selection");
    assert.ok((map.queryArguments.at(-1)?.[1] as { layers: string[] }).layers.includes("bucket-stack-markers"), "the aggregate marker itself participates in click hit tests");
    const firstStackChoice = [...host.querySelectorAll<HTMLButtonElement>(".atlas-map-pick-menu-list button")].find(button => button.title === "Synthetic 0"); assert.ok(firstStackChoice);
    await act(async () => { firstStackChoice!.click(); await nextTurn(); });
    assert.equal(picked, "synthetic-0", "an exact-coordinate stack still selects an individual source office");
    picked = undefined;
    map.queryResults = [{ properties: { bucketId: "synthetic-99" }, layer: { id: "bucket-detail-labels" } }];
    await act(async () => { map.emit("click", { point: { x: 400, y: 300 } }); await nextTurn(); });
    assert.equal(picked, "synthetic-99", "a visible address label is clickable even though it is offset from its marker");
    assert.ok((map.queryArguments.at(-1)?.[1] as { layers: string[] }).layers.includes("bucket-detail-labels"), "click queries complete address labels as well as the marker layers");
    picked = undefined;
    map.queryResults = [{ properties: { bucketId: "synthetic-0" } }, { properties: { bucketId: "synthetic-1" } }, { properties: { bucketId: "synthetic-1" } }];
    await act(async () => { map.emit("click", { point: { x: 141, y: 31 } }); await nextTurn(); });
    assert.match(host.textContent ?? "", /附近有 2 个地点/, "overlapping buckets are offered as explicit choices");
    const choices = [...host.querySelectorAll<HTMLButtonElement>(".atlas-map-pick-menu-list button")];
    assert.equal(choices.length, 2, "core and ring features for one location are deduplicated");
    assert.equal(choices[0]!.title, "Synthetic 1", "the full location remains available when a visible address is clamped");
    assert.match(choices[0]!.getAttribute("aria-label")!, /Synthetic 1.*岗位.*坐标/);
    assert.equal(dom.document.activeElement, choices[0], "opening the overlapping-location picker moves keyboard focus to its first choice");
    await act(async () => { choices[0]!.click(); await nextTurn(); });
    assert.equal(picked, "synthetic-1", "the chosen overlapping location reaches the caller");
    assert.equal(dom.document.activeElement, map.canvas, "choosing a location returns keyboard focus to the map");
    map.queries = 0;
    map.queryResults = [{ properties: { bucketId: "synthetic-99" }, layer: { id: "bucket-labels" } }];
    for (let i = 0; i < 100; i++) map.emit("mousemove", { point: { x: i, y: i } });
    assert.equal(frames.size, 1);
    const queued = [...frames.values()]; frames.clear(); act(() => queued.forEach(callback => callback(performance.now()))); assert.equal(map.queries, 1);
    assert.ok((map.queryArguments.at(-1)?.[1] as { layers: string[] }).layers.includes("bucket-labels"), "hover cursor detects the visible label layer");
    assert.match(host.textContent ?? "", /Synthetic 99/);
    assert.match(host.textContent ?? "", /100 个岗位/);
    assert.match(host.textContent ?? "", /地址级来源坐标/);
    map.queryResults = [{ properties: { bucketId: "synthetic-99" }, layer: { id: "bucket-stack-labels" } }];
    map.emit("mousemove", { point: { x: 121, y: 85 } });
    const stackHover = [...frames.values()]; frames.clear(); act(() => stackHover.forEach(callback => callback(performance.now())));
    assert.match(host.textContent ?? "", /96 个来源地址共用此坐标/);
    assert.match(host.textContent ?? "", /5,040 个岗位 · 点击展开逐个选择/);
    map.moving = true; act(() => map.emit("zoomstart")); for (let i = 0; i < 100; i++) map.emit("mousemove", { point: { x: i, y: i } }); assert.equal(frames.size, 0); assert.equal(map.queries, 2);
    map.zoom = 12; map.moving = false; act(() => { map.emit("zoomend"); map.emit("moveend"); }); assert.equal(views, 2);
    reduced = true; await render({ selectedJobId: "synthetic-job", focus: { ...focus, requestId: "focus-two" } });
    assert.equal((map.flights.at(-1) as { duration: number }).duration, 0); assert.equal(map.uploads, 1);
    await render({ bounds: [120, 30, 122, 32], framingKey: "same-search" });
    const fits = map.fits;
    await render({ bounds: [119, 29, 123, 33], framingKey: "same-search" });
    assert.equal(map.fits, fits, "streaming points in the same search do not commandeer the camera");
    await render({ framingKey: "new-search" });
    assert.equal(map.fits, fits + 1, "a genuinely new search can frame its results");
    reduced = false;
    const beforeToggle = { mounts: instances.length, uploads: map.uploads, boundaryUploads: map.boundaryUploads, fits: map.fits };
    await render({ visual: { viewMode: "flat", animateViewChange: true } });
    assert.equal(host.querySelector("[data-atlas-renderer]")!.getAttribute("data-atlas-view"), "flat");
    assert.ok(host.querySelector('[aria-label^="全球岗位平面地图"]'), "2D is described as a flat map rather than a 3D globe");
    assert.deepEqual(map.projection, { type: "mercator" });
    assert.deepEqual(map.eases.at(-1), { pitch: 0, bearing: 0, duration: 240 });
    assert.ok(map.visibility.some(([id, , value]) => id.endsWith(":3d") && value === "none"), "2D disables height-backed building layers");
    await render({ visual: { viewMode: "spatial", animateViewChange: false } });
    assert.equal(host.querySelector("[data-atlas-renderer]")!.getAttribute("data-atlas-view"), "spatial");
    assert.ok(host.querySelector('[aria-label^="全球岗位三维地球"]'));
    assert.deepEqual(map.projection, { type: "globe" });
    assert.equal(map.eases.at(-1)!.pitch, 48);
    assert.equal(map.eases.at(-1)!.duration, 0, "keyboard activation has no camera tween");
    assert.ok(map.visibility.some(([id, , value]) => id.endsWith(":3d") && value === "visible"));
    reduced = true;
    await render({ visual: { viewMode: "flat", animateViewChange: true } });
    assert.equal(map.eases.at(-1)!.duration, 0, "reduced motion overrides pointer animation requests");
    const easeCount = map.eases.length;
    for (let index = 0; index < 10; index++) await render({ visual: { viewMode: "flat", animateViewChange: true } });
    assert.equal(map.eases.length, easeCount, "progress renders do not restart a view transition");
    assert.deepEqual({ mounts: instances.length, uploads: map.uploads, boundaryUploads: map.boundaryUploads, fits: map.fits }, beforeToggle, "presentation switching reuses the GPU instance and never retransmits or reframes job data");
  } finally { act(() => root.unmount()); host.remove(); reduced = false; }
  assert.equal(instances.at(-1)!.removed, true); assert.equal(frames.size, 0);
});

test("opening in 2D ignores saved tilt and never starts an automatic rotation loop", async () => {
  const host = dom.document.createElement("div"); dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLDivElement);
  try {
    await act(async () => {
      root.render(h(MapLibrePrototype, { mode: "global", buckets: [], basemap: null, initialView: { center: [121, 31], zoom: 2, pitch: 48, bearing: 12 }, visual: { viewMode: "flat", autoRotate: true } }));
      for (let index = 0; index < 4; index++) await nextTurn();
    });
    const map = instances.at(-1)!;
    assert.equal(map.options.pitch, 0);
    assert.equal(map.options.bearing, 0);
    await act(async () => { map.emit("load"); map.emit("render"); });
    assert.deepEqual(map.projection, { type: "mercator" });
    assert.equal(frames.size, 0, "a flat map never consumes background animation frames");
  } finally { act(() => root.unmount()); host.remove(); }
});
