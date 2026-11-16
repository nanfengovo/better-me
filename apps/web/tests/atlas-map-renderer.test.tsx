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
const instances: SyntheticMap[] = [], markerEvents: string[] = [], markers: SyntheticMarker[] = [], workerCounts: number[] = [];
class SyntheticMap {
  handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  canvas = dom.document.createElement("canvas"); moving = false; removed = false; zoom = 1.65;
  scrollRates: number[] = []; wheelRates: number[] = [];
  scrollZoom = { setZoomRate: (r: number) => this.scrollRates.push(r), setWheelZoomRate: (r: number) => this.wheelRates.push(r) };
  uploads = 0; boundaryUploads = 0; userLocationData: unknown[] = []; nearbyCompaniesData: unknown[] = []; fits = 0; queries = 0; paints = 0; filters: Array<{ id: string; filter: unknown }> = []; flights: unknown[] = []; jumps: unknown[] = []; eases: Array<{ pitch: number; bearing: number; duration: number }> = []; visibility: Array<[string, string, unknown]> = []; projection: unknown;
  addedSources: string[] = []; addedLayers: Array<{ id: string }> = []; terrain: unknown = null; terrainSets: unknown[] = [];
  lights: unknown[] = []; skies: unknown[] = [];
  paintProps: Array<{ id: string; name: string; value: unknown }> = [];
  featureStates: Array<{ target: { source: string; id: string | number }; state: Record<string, unknown> }> = [];
  queryResults: unknown[] = [{ properties: { bucketId: "synthetic-0" } }]; queryArguments: unknown[] = [];
  projectedPoint: { x: number; y: number } | null = null;
  constructor(readonly options: Record<string, unknown>) { this.canvas.tabIndex = 0; (options.container as HTMLElement).append(this.canvas); instances.push(this); }
  on(name: string, callback: (...args: unknown[]) => void) { this.handlers.set(name, [...(this.handlers.get(name) ?? []), callback]); return this; }
  once(name: string, callback: (...args: unknown[]) => void) { const once = (...args: unknown[]) => { this.handlers.set(name, this.handlers.get(name)!.filter(entry => entry !== once)); callback(...args); }; return this.on(name, once); }
  emit(name: string, event: unknown = {}) { for (const handler of [...(this.handlers.get(name) ?? [])]) handler(event); }
  addControl() {} getCanvas() { return this.canvas; } getZoom() { return this.zoom; } getPitch() { return 0; } getBearing() { return 0; }
  center = { lng: 104, lat: 26 };
  getCenter() { return this.center; } getBounds() { return { getWest: () => 100, getEast: () => 110, getSouth: () => 20, getNorth: () => 30 }; }
  resizes = 0;
  isMoving() { return this.moving; } stop() { this.moving = false; } setCenter() {} resize() { this.resizes++; } triggerRepaint() {}
  getStyle() { return this.options.style as { layers: Array<{ id: string }>; sources?: Record<string, unknown> }; }
  getLayer(id: string) { return this.getStyle().layers.some(layer => layer.id === id) || this.addedLayers.some(layer => layer.id === id); }
  getSource(id?: string) {
    const sources = this.getStyle().sources ?? {};
    if (id && !Object.prototype.hasOwnProperty.call(sources, id) && !this.addedSources.includes(id)) return undefined;
    return { setData: (data: unknown) => { if (id === "buckets") this.uploads++; if (id === "admin-highlight") this.boundaryUploads++; if (id === "user-location") this.userLocationData.push(data); if (id === "nearby-companies") this.nearbyCompaniesData.push(data); } };
  }
  addSource(id: string) { this.addedSources.push(id); }
  addLayer(layer: { id: string }) { this.addedLayers.push(layer); }
  setTerrain(value: unknown) { this.terrain = value; this.terrainSets.push(value); }
  getTerrain() { return this.terrain; }
  setProjection(value: unknown) { this.projection = value; }
  setSky(value: unknown) { this.skies.push(value); }
  setLight(value: unknown) { this.lights.push(value); }
  setFeatureState(target: { source: string; id: string | number }, state: Record<string, unknown>) { this.featureStates.push({ target, state }); }
  setLayoutProperty(id: string, name: string, value: unknown) { this.visibility.push([id, name, value]); }
  easeTo(options: { pitch: number; bearing: number; duration: number }) { this.eases.push(options); }
  setFilter(id: string, filter: unknown) { this.filters.push({ id, filter }); }
  setPaintProperty(id: string, name: string, value: unknown) { this.paints++; this.paintProps.push({ id, name, value }); }
  queryRenderedFeatures(...args: unknown[]) { this.queries++; this.queryArguments.push(args); return this.queryResults; }
  project(coordinates: [number, number]) { return this.projectedPoint ?? { x: coordinates[0], y: coordinates[1] }; }
  fitBounds() { this.fits++; }
  jumpTo(options: { zoom?: number }) { if (typeof options.zoom === "number") this.zoom = options.zoom; this.jumps.push(options); }
  flyTo(options: unknown) { this.flights.push(options); } remove() { this.removed = true; }
}
class SyntheticMarker {
  element?: HTMLElement; lngLat?: { lng: number; lat: number };
  constructor(options?: { element?: HTMLElement }) { markerEvents.push("create"); this.element = options?.element; markers.push(this); }
  setLngLat(coords: [number, number]) { this.lngLat = { lng: coords[0], lat: coords[1] }; return this; }
  addTo() { return this; }
  getElement() { return this.element; }
  getLngLat() { return this.lngLat; }
  remove() { markerEvents.push("remove"); }
}
const resizeObservers: Array<{ notify: () => void; disconnected: boolean }> = [];
const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node,
  ResizeObserver: class { disconnected = false; constructor(readonly notify: () => void) { resizeObservers.push(this); } observe() {} disconnect() { this.disconnected = true; } }, requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; }, cancelAnimationFrame: (id: number) => { frames.delete(id); },
  IS_REACT_ACT_ENVIRONMENT: true, __atlasPerformanceMap: SyntheticMap, __atlasPerformanceMarker: SyntheticMarker, __atlasSetWorkerCount: (count: number) => workerCounts.push(count) };
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
    if (specifier === "maplibre-gl") return { url: "data:text/javascript,export const Map=globalThis.__atlasPerformanceMap,Marker=globalThis.__atlasPerformanceMarker;export class AttributionControl{};export class NavigationControl{};export class ScaleControl{};export const setWorkerUrl=()=>{};export const setWorkerCount=globalThis.__atlasSetWorkerCount;export const prewarm=()=>{};", shortCircuit: true };
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

test("window resizing is frame-coalesced, skips hidden geometry and cancels on unmount", async () => {
  const host = dom.document.createElement("div"); dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const flushFrames = () => { const queued = [...frames.values()]; frames.clear(); queued.forEach(callback => callback(16)); };
  try {
    await act(async () => { root.render(h(MapLibrePrototype, { mode: "domestic", buckets: [], basemap: null, visual: { autoRotate: false } })); for (let i = 0; i < 4; i++) await nextTurn(); });
    const map = instances.at(-1)!;
    await act(async () => map.emit("load"));
    const observer = resizeObservers.at(-1)!;
    const element = map.options.container as HTMLElement;
    let width = 700;
    Object.defineProperties(element, { clientWidth: { configurable: true, get: () => width }, clientHeight: { configurable: true, get: () => 500 } });
    const initialResizes = map.resizes;
    observer.notify(); observer.notify(); observer.notify();
    assert.equal(map.resizes, initialResizes, "observer delivery must not synchronously write layout");
    assert.equal(frames.size, 1);
    await act(async () => flushFrames()); assert.equal(map.resizes, initialResizes + 1);
    width = 0; observer.notify(); await act(async () => flushFrames()); assert.equal(map.resizes, initialResizes + 1);
    width = 700; observer.notify(); await act(async () => flushFrames()); assert.equal(map.resizes, initialResizes + 2);
    observer.notify(); await act(async () => root.unmount());
    assert.equal(frames.size, 0); assert.equal(observer.disconnected, true); assert.equal(map.removed, true);
  } finally { if (!instances.at(-1)?.removed) await act(async () => root.unmount()); host.remove(); }
});

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

test("continuous zooming causes zero React re-renders or style-layer storms, defaults to sharp crisp dark vector map, and updates DOM telemetry directly", async () => {
  const host = dom.document.createElement("div"); dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLDivElement);
  const originalDpr = Object.getOwnPropertyDescriptor(dom, "devicePixelRatio");
  Object.defineProperty(dom, "devicePixelRatio", { configurable: true, value: 2 });
  let parentRenders = 0;
  const basemap = {
    id: "openfreemap-liberty",
    name: "OpenFreeMap Liberty",
    maxZoom: 22,
    type: "vector-style" as const,
    styleUrl: "http://127.0.0.1/style.json",
    attributions: [{ label: "OpenFreeMap", url: "https://openfreemap.org" }],
  };
  const focus: AtlasMapFocus = {
    requestId: "edge-focus",
    bucketId: "b1",
    jobId: "j1",
    label: "中关村软件园",
    coordinates: [116.29, 40.05],
    longitude: 116.29,
    latitude: 40.05,
    precision: "building",
    estimated: false,
    addressLine: "东北旺西路 8 号",
  };
  function Harness() {
    parentRenders++;
    return h(MapLibrePrototype, {
      mode: "global",
      buckets: [],
      basemap,
      focus,
      selectedJobId: "j1",
      visual: { theme: "dark", autoRotate: false },
    });
  }
  const flushFrames = () => { const queued = [...frames.values()]; frames.clear(); queued.forEach(cb => cb(16)); };
  try {
    await act(async () => { root.render(h(Harness)); for (let i = 0; i < 6; i++) await nextTurn(); });
    const map = instances.at(-1)!;
    assert.ok((workerCounts[0] ?? 0) >= 2, "configures >=2 MapLibre web workers so vector/glyph decoding is parallelized outside Safari");
    assert.equal(map.options.pixelRatio, 2, "default maxDpr supports 2x Retina backing sharpness instead of 1.5x downscaling");
    assert.equal(map.options.cancelPendingTileRequestsWhileZooming, false, "keeps intermediate zoom tiles streaming instead of cancelling on every wheel tick");
    assert.equal(map.options.crossSourceCollisions, false, "disables expensive cross-source collision detection across basemap and job layers");
    assert.equal(map.options.fadeDuration, 1, "eliminates slow 100ms label fade lag while preserving MapLibre's 2ms PauseablePlacement budget");
    assert.equal(map.options.maxTileCacheZoomLevels, 12, "retains visited zoom levels in tile cache across overview-to-street roundtrips");
    assert.equal(map.options.refreshExpiredTiles, false, "avoids mid-zoom expired tile revalidation stalls");
    assert.ok(map.scrollRates.length > 0 && map.wheelRates.length > 0, "tunes trackpad and mouse wheel zoom rates on MapLibre scrollZoom");
    assert.deepEqual(map.options.canvasContextAttributes, { antialias: true, powerPreference: "high-performance" }, "WebGL antialiasing is enabled explicitly");
    const styleSourcesObj = (map.options.style as { sources: Record<string, Record<string, unknown>> }).sources;
    const styleSources = Object.keys(styleSourcesObj);
    assert.equal(styleSources.includes("basemap:satellite"), false, "default dark theme does not eagerly mount satellite raster tiles");
    assert.equal(styleSources.includes("basemap:terrain"), false, "default dark theme does not eagerly mount AWS terrain DEM tiles");
    assert.equal(styleSourcesObj.boundaries?.maxzoom, 7, "bounds static country/province GeoJSON tiling to overview zooms");
    assert.equal(styleSourcesObj["land-dots"]?.maxzoom, 4, "bounds global dot GeoJSON tiling to globe overview zoom");
    assert.equal(styleSourcesObj.buckets?.maxzoom, 15, "bounds office bucket GeoJSON tiling so deep street zoom scales GPU points without extra tiling");
    await act(async () => { map.emit("load"); });
    const rendersAfterLoad = parentRenders;
    const writesAfterLoad = { paints: map.paints, visibility: map.visibility.length, terrainSets: map.terrainSets.length };

    map.projectedPoint = { x: 400, y: 80 };
    const lastMarker = markers.at(-1);
    assert.ok(lastMarker, "focus marker exists");
    const focusMarkerEl = lastMarker.getElement();
    assert.ok(focusMarkerEl, "focus marker is mounted");
    assert.equal(focusMarkerEl.classList.contains("atlas-focus-marker"), true, "marker uses atlas-focus-marker class");

    for (const z of [2.4, 4.8, 8.9, 12.1, 14.5, 16.4, 17.1]) {
      map.zoom = z;
      map.emit("zoom");
      // Verify 0-frame synchronous HUD + focus-flip update BEFORE flushFrames() runs.
      assert.equal(host.querySelector(".atlas-zoom-telemetry small")?.textContent, `z${z.toFixed(1)}`, "zoom HUD updates synchronously in MapLibre zoom frame without 1-frame rAF delay");
      assert.equal(focusMarkerEl.classList.contains("is-below"), true, "focus label flips synchronously on zoom near top edge without waiting for zoomend");
    }
    map.emit("zoomend");
    flushFrames();
    await nextTurn();

    assert.equal(parentRenders, rendersAfterLoad, "continuous zoom frames must not re-render React");
    assert.equal(map.paints, writesAfterLoad.paints, "zoom and zoomend must not re-paint all style layers");
    assert.equal(map.visibility.length, writesAfterLoad.visibility, "zoom and zoomend must not toggle all layer visibilities");
    assert.equal(map.terrainSets.length, writesAfterLoad.terrainSets, "dark mode must never churn terrain state during zoom");
    assert.equal(host.querySelector(".atlas-zoom-telemetry strong")?.textContent, "楼宇", "zoom HUD updates tier directly in DOM");
    assert.equal(host.querySelector(".atlas-zoom-telemetry small")?.textContent, "z17.1", "zoom HUD updates numeric zoom directly in DOM");
    assert.equal(focusMarkerEl.classList.contains("is-below"), true, "focus popup stays flipped below pin near the top viewport edge");

    map.projectedPoint = { x: 400, y: 260 };
    map.emit("move");
    assert.equal(focusMarkerEl.classList.contains("is-below"), false, "focus popup restores immediately on move before moveend");

    const slider = host.querySelector<HTMLInputElement>(".atlas-zoom-slider")!;
    const setSliderValue = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!;
    map.jumps.length = 0;
    for (const nextValue of ["4.2", "9.4", "14.5"]) {
      setSliderValue.call(slider, nextValue);
      slider.dispatchEvent(new dom.Event("input", { bubbles: true }));
    }
    assert.equal(map.jumps.length, 0, "rapid slider drag does not invoke synchronous jumpTo per event");
    flushFrames();
    assert.deepEqual(map.jumps, [{ zoom: 14.5 }], "rapid slider ticks coalesce into one jumpTo per animation frame");
    assert.equal(host.querySelector(".atlas-zoom-telemetry strong")?.textContent, "街道");

    const satButton = [...host.querySelectorAll<HTMLButtonElement>(".atlas-map-layer-switcher button")].find(b => b.textContent?.includes("卫星实景"))!;
    await act(async () => { satButton.click(); await nextTurn(); });
    assert.equal(map.addedSources.includes("basemap:satellite"), true, "satellite raster source mounts lazily only when switched on");
    assert.equal(map.addedSources.includes("basemap:terrain"), true, "terrain DEM mounts lazily only when switched to satellite");
  } finally {
    if (originalDpr) Object.defineProperty(dom, "devicePixelRatio", originalDpr);
    else Reflect.deleteProperty(dom, "devicePixelRatio");
    await act(async () => root.unmount());
    host.remove();
  }
});

test("bilingual label deduplication strips semicolon repeats and map overlays avoid blurry backdrop-filter haze", () => {
  const mapProtoSource = readFileSync(new URL("../src/components/atlas/prototypes/MapLibrePrototype.tsx", import.meta.url), "utf8");
  assert.match(mapProtoSource, /\["in", ";", nonLatinRaw\]/, "bilingual label builder guards against semicolon-joined repeats like 菲律賓;菲律賓");
  assert.match(mapProtoSource, /\["in", "\/", nonLatinRaw\]/, "bilingual label builder guards against slash-joined repeats like 印度尼西亞 / 印度尼西亞");
  assert.match(mapProtoSource, /\["in", ";", latinName\]/, "bilingual label builder guards against semicolon-joined latin suffixes");

  const focusCss = readFileSync(new URL("../src/components/atlas/map-focus.css", import.meta.url), "utf8");
  const interactCss = readFileSync(new URL("../src/components/atlas/map-interactions.css", import.meta.url), "utf8");
  const controlsCss = readFileSync(new URL("../src/components/atlas/atlas-map-controls.css", import.meta.url), "utf8");
  const atlasCss = readFileSync(new URL("../src/components/atlas/atlas.css", import.meta.url), "utf8");
  const desktopCss = readFileSync(new URL("../src/components/desktop/desktop.css", import.meta.url), "utf8");

  assert.equal(/backdrop-filter/i.test(focusCss), false, "focus popup avoids translucent backdrop-filter blur over WebGL canvas");
  assert.equal(/backdrop-filter/i.test(interactCss), false, "zoom HUD and map overlays avoid translucent backdrop-filter blur");
  assert.equal(/backdrop-filter/i.test(controlsCss), false, "map navigation/scale/attribution controls avoid blurry backdrop-filter");
  assert.equal(/\.atlas-map-controls button[^}]*backdrop-filter/i.test(atlasCss), false, "top bar map buttons stay crisp without backdrop-filter");
  assert.match(desktopCss, /\.os-desktop\[data-page="atlas"\] \.os-business-window[^}]*backdrop-filter:\s*none\s*!important/, "atlas desktop window disables window-level wallpaper blur");
  assert.match(focusCss, /\.atlas-focus-label\{[^}]*animation:\s*none/, "focus popup displays without 220ms fade-in lag");
  assert.match(interactCss, /\.atlas-map-hover-card\s*\{[^}]*transition:\s*none/, "hover card appears instantaneously without 140ms transition lag");
  assert.match(interactCss, /\.atlas-map-zoom-hud\s*\{[^}]*contain:\s*layout style[^}]*transition:\s*none/, "zoom HUD isolates layout/style invalidation and updates instantaneously");
  assert.match(interactCss, /\.atlas-zoom-slider::-webkit-slider-thumb\s*\{[^}]*transition:\s*none/, "zoom slider thumb tracks zoom directly without transition lag");
});

test("3D buildings sit between roads and labels with height-graded color, street ground blends #9ecae6->#f3f1ec, and focus suppresses duplicate canvas labels", async () => {
  const prevFetch = globalThis.fetch;
  const host = dom.document.createElement("div"); dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const before = instances.length;

  globalThis.fetch = async input => new Response(JSON.stringify(String(input).endsWith("style.json") ? {
    version: 8, sources: { openmaptiles: { type: "vector", url: "https://synthetic.invalid/planet" } },
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#0e1726" } },
      { id: "road_major", type: "line", source: "openmaptiles", "source-layer": "transportation", paint: { "line-color": "#334155" } },
      { id: "building", type: "fill", source: "openmaptiles", "source-layer": "building", minzoom: 12, filter: ["==", ["get", "class"], "building"], paint: { "fill-color": "#123456" } },
      { id: "road_label", type: "symbol", source: "openmaptiles", "source-layer": "transportation_name", layout: { "text-field": ["get", "name"] } },
    ],
    glyphs: "https://synthetic.invalid/{fontstack}/{range}.pbf",
  } : { type: "FeatureCollection", features: [] }), { headers: { "content-type": "application/json" } });

  const basemap = {
    id: "openfreemap-synthetic",
    name: "Synthetic",
    maxZoom: 22,
    type: "vector-style" as const,
    styleUrl: "http://127.0.0.1/style.json",
    attributions: [{ label: "Synthetic", url: "https://synthetic.invalid" }],
  };
  const buckets = [{
    id: "tencent-hq",
    label: "北京市海淀区西北旺东路10号院西区9号楼腾讯北京总部大楼",
    longitude: 116.28,
    latitude: 40.05,
    jobCount: 8,
    jobIds: ["job-tx"],
    locationIds: ["tencent-hq"],
    pinCount: 8,
    displayGrade: "building",
    categories: [{ id: "eng", label: "Eng", color: "#38bdf8", jobCount: 8 }],
  }] as unknown as NonNullable<AtlasPrototypeProps["buckets"]>;
  const focus: AtlasMapFocus = {
    jobId: "job-tx",
    locationId: "tencent-hq",
    label: "腾讯地图-Agent工程师",
    locationLabel: "北京市海淀区西北旺东路10号院西区9号楼腾讯北京总部大楼",
    longitude: 116.28,
    latitude: 40.05,
    precision: "address",
    estimated: false,
  };

  try {
    await act(async () => {
      root.render(h(MapLibrePrototype, {
        mode: "domestic",
        view: "3d",
        basemap,
        buckets,
        selectedBucketId: "tencent-hq",
        selectedJobId: "job-tx",
        focus,
        visual: { autoRotate: false },
      }));
    });
    for (let turn = 0; turn < 6 && instances.length === before; turn++) await nextTurn();
    const map = instances.at(-1)!;
    assert.ok(map);
    await act(async () => { map.emit("load"); await nextTurn(); });

    const style = map.getStyle() as {
      layers: Array<{ id: string; type?: string; paint?: Record<string, unknown>; layout?: Record<string, unknown> }>;
      sources?: Record<string, { promoteId?: string }>;
    };
    assert.equal(style.sources?.buckets?.promoteId, "featureId");

    const roadIdx = style.layers.findIndex(layer => layer.id === "basemap:road_major");
    const extrudeIdx = style.layers.findIndex(layer => layer.id === "basemap:building:3d");
    const edgesIdx = style.layers.findIndex(layer => layer.id === "basemap:building:3d-edges");
    const labelIdx = style.layers.findIndex(layer => layer.id === "basemap:road_label");
    assert.ok(roadIdx >= 0 && extrudeIdx > roadIdx, "3D buildings render above surface roads");
    assert.ok(edgesIdx > extrudeIdx, "3D edge lines render above extrusion fill");
    assert.ok(labelIdx > edgesIdx, "street/place symbols render above 3D buildings");

    const extrudeLayer = style.layers[extrudeIdx]!;
    const colorExpr = JSON.stringify(extrudeLayer.paint?.["fill-extrusion-color"]);
    assert.match(colorExpr, /interpolate.*render_height.*height/, "3D buildings use height-interpolated tonal ramp");

    const overviewLabels = style.layers.find(layer => layer.id === "bucket-labels")!;
    const detailLabels = style.layers.find(layer => layer.id === "bucket-detail-labels")!;
    assert.equal((overviewLabels.paint?.["text-opacity"] as unknown[])[0], "interpolate", "bucket-labels keeps zoom interpolate at expression top level");
    assert.equal((detailLabels.paint?.["text-opacity"] as unknown[])[0], "interpolate", "bucket-detail-labels keeps zoom interpolate at expression top level");
    assert.match(JSON.stringify(detailLabels.paint?.["text-opacity"]), /feature-state.*focused/, "focused bucket suppresses duplicate canvas label");
    assert.ok(
      map.featureStates.some(entry => entry.target.source === "buckets" && entry.target.id === "core:tencent-hq" && entry.state.focused === true),
      "focus sets feature-state focused=true on buckets source",
    );

    const status = host.querySelector(".atlas-focus-status");
    assert.ok(status);
    assert.match(status.textContent!, /腾讯北京总部大楼 · 地址坐标 · 待核实$/);

    const locationTrigger = host.querySelector<HTMLButtonElement>(".atlas-map-location-trigger");
    assert.ok(locationTrigger);
    await act(async () => { locationTrigger.click(); });
    const locationBtn = host.querySelector<HTMLButtonElement>(".atlas-map-location-list button");
    assert.ok(locationBtn);
    assert.equal(locationBtn.title, "北京市海淀区西北旺东路10号院西区9号楼腾讯北京总部大楼");
    assert.equal(locationBtn.querySelector(".atlas-map-location-main strong")?.textContent, "腾讯北京总部大楼");
    assert.equal(locationBtn.querySelector(".atlas-map-location-sub")?.textContent, "北京市海淀区 · 西北旺东路10号院西区9号楼");

    assert.ok(map.lights.length >= 1 && map.skies.length >= 1, "initial load configures camera lighting and sky/fog blend");

    const streetBtn = [...host.querySelectorAll<HTMLButtonElement>(".atlas-map-layer-switcher button")].find(btn => /高清街区/.test(btn.textContent ?? ""));
    assert.ok(streetBtn);
    await act(async () => { streetBtn.click(); await nextTurn(); });
    const oceanBgPaint = [...map.paintProps].reverse().find(entry => entry.id === "ocean" && entry.name === "background-color");
    assert.deepEqual(oceanBgPaint?.value, ["interpolate", ["linear"], ["zoom"], 6.4, "#9ecae6", 7.8, "#f3f1ec"]);
    assert.ok(map.lights.length >= 2 && map.skies.length >= 2, "switching to street mode updates directional light and sky fog");

    // Clearing focus restores canvas label via feature-state focused=false.
    await act(async () => {
      root.render(h(MapLibrePrototype, {
        mode: "domestic",
        view: "3d",
        basemap,
        buckets,
        focus: undefined,
        visual: { autoRotate: false },
      }));
      await nextTurn();
    });
    assert.ok(
      map.featureStates.some(entry => entry.target.source === "buckets" && entry.target.id === "core:tencent-hq" && entry.state.focused === false),
      "clearing focus restores feature-state focused=false",
    );

    // Tile warning offsets focus status instead of overlapping it, ignores aborted tile fetches, and clears when basemap loads.
    await act(async () => {
      root.render(h(MapLibrePrototype, {
        mode: "domestic",
        view: "3d",
        basemap,
        buckets,
        selectedBucketId: "tencent-hq",
        selectedJobId: "job-tx",
        focus,
        visual: { autoRotate: false },
      }));
      await nextTurn();
    });
    await act(async () => {
      map.emit("error", { error: Object.assign(new Error("The operation was aborted"), { name: "AbortError" }), sourceId: "basemap:openmaptiles" });
      await nextTurn();
    });
    assert.equal(host.querySelector(".atlas-map-basemap-warning"), null, "aborted in-flight tile fetches do not trigger offline warnings");
    await act(async () => {
      map.emit("error", { error: new Error("Failed to fetch tile"), sourceId: "basemap:openmaptiles" });
      await nextTurn();
    });
    assert.ok(host.querySelector(".atlas-map-basemap-warning"));
    assert.equal(host.querySelector(".atlas-focus-status")?.classList.contains("has-warning"), true);
    await act(async () => {
      map.emit("sourcedata", { sourceId: "basemap:openmaptiles", isSourceLoaded: true });
      await nextTurn();
    });
    assert.equal(host.querySelector(".atlas-map-basemap-warning"), null, "recovering basemap tiles clears stale offline warnings");
    assert.equal(host.querySelector(".atlas-focus-status")?.classList.contains("has-warning"), false);
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    globalThis.fetch = prevFetch;
  }
});

test("map detail clarity enhancements remove low maxzoom caps, keep crisp halos/road casings in order, and support honest browser geolocation", async () => {
  const prevFetch = globalThis.fetch;
  const host = dom.document.createElement("div"); dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const beforeInstances = instances.length;
  const beforeMarkers = markers.length;

  globalThis.fetch = async (input) => new Response(JSON.stringify(String(input).endsWith("style.json") ? {
    version: 8,
    sources: { openmaptiles: { type: "vector", url: "https://synthetic.invalid/planet" } },
    glyphs: "https://synthetic.invalid/{fontstack}/{range}.pbf",
    sprite: "https://synthetic.invalid/sprite",
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#000000" } },
      { id: "landuse_residential", type: "fill", source: "openmaptiles", "source-layer": "landuse", maxzoom: 9, filter: ["==", ["get", "class"], "residential"], paint: { "fill-color": "#0d0d0d" } },
      { id: "landcover_wood", type: "fill", source: "openmaptiles", "source-layer": "landcover", minzoom: 10, paint: { "fill-color": "rgb(32,32,32)", "fill-pattern": "wood-pattern" } },
      { id: "waterway", type: "line", source: "openmaptiles", "source-layer": "waterway", paint: { "line-color": "#1b1b1d" } },
      { id: "water_name", type: "symbol", source: "openmaptiles", "source-layer": "water_name", layout: { "text-field": ["get", "name"] }, paint: { "text-color": "hsla(0,0%,0%,0.7)" } },
      { id: "highway_minor", type: "line", source: "openmaptiles", "source-layer": "transportation", minzoom: 8, paint: { "line-color": "#181818" } },
      { id: "railway_transit", type: "line", source: "openmaptiles", "source-layer": "transportation", minzoom: 16, paint: { "line-color": "#222" } },
      { id: "building", type: "fill", source: "openmaptiles", "source-layer": "building", minzoom: 12, filter: ["==", ["get", "class"], "building"], paint: { "fill-color": "#0a0a0a" } },
      { id: "highway_name_other", type: "symbol", source: "openmaptiles", "source-layer": "transportation_name", layout: { "text-field": ["get", "name"], "text-transform": "uppercase", "text-size": 10 }, paint: { "text-halo-blur": 1 } },
      { id: "place_suburb", type: "symbol", source: "openmaptiles", "source-layer": "place", maxzoom: 15, layout: { "text-field": ["get", "name"], "text-transform": "uppercase" }, paint: { "text-halo-blur": 1 } },
    ],
  } : { type: "FeatureCollection", features: [] }), { headers: { "content-type": "application/json" } });

  const basemap = {
    id: "openfreemap-dark",
    name: "Synthetic OpenFreeMap",
    maxZoom: 22,
    type: "vector-style" as const,
    styleUrl: "http://127.0.0.1/style.json",
    attributions: [{ label: "Synthetic", url: "https://synthetic.invalid" }],
  };
  const focus: AtlasMapFocus = {
    jobId: "j-geo",
    locationId: "loc-geo",
    label: "外滩办公点",
    longitude: 121.4900,
    latitude: 31.2397,
    precision: "address",
    estimated: false,
  };

  const geoDescriptor = Object.getOwnPropertyDescriptor(dom.navigator, "geolocation");
  const clearWatchCalls: number[] = [];
  let onGeoSuccess: ((pos: any) => void) | undefined;
  let onGeoError: ((err: any) => void) | undefined;

  const coLocatedBuckets = [
    { id: "stack-a", label: "外滩办公点 A", latitude: 31.2397, longitude: 121.4900, jobCount: 4, displayGrade: "address", locationIds: ["loc-geo"], categories: [{ color: "#123456", jobCount: 4 }] },
    { id: "stack-b", label: "外滩办公点 B", latitude: 31.2397, longitude: 121.4900, jobCount: 2, displayGrade: "address", locationIds: ["loc-geo-2"], categories: [{ color: "#654321", jobCount: 2 }] },
  ] as AtlasPrototypeProps["buckets"];

  try {
    await act(async () => {
      root.render(h(MapLibrePrototype, {
        mode: "domestic",
        basemap,
        buckets: coLocatedBuckets,
        selectedJobId: "j-geo",
        focus,
        visual: { theme: "dark", autoRotate: false },
      }));
    });
    for (let i = 0; i < 6 && instances.length === beforeInstances; i++) await nextTurn();
    const map = instances.at(-1)!;
    await act(async () => { map.emit("load"); await nextTurn(); });

    const styleLayers = (map.getStyle() as { layers: Array<Record<string, any>> }).layers;
    const byId = (id: string) => styleLayers.find((layer) => layer.id === id);

    // 1. Verify clarity upgrades on refined + supplemented layers.
    assert.equal(byId("basemap:landuse_residential")?.maxzoom, 24, "lifts z9 residential maxzoom cutoff");
    assert.equal(byId("basemap:landcover_wood")?.paint?.["fill-pattern"], undefined, "strips missing wood-pattern sprite so dark forest/hill fill paints cleanly");
    assert.equal(byId("basemap:landcover_wood")?.paint?.["fill-color"], "#0f2e24");
    assert.ok(map.featureStates.some((entry) => String(entry.target.id).startsWith("stack:") && entry.state.focused === true), "marks co-located stack focused so its badge yields to active focus marker");
    assert.ok(JSON.stringify(byId("bucket-stack-labels")?.paint?.["text-opacity"]).includes('"focused"'));
    assert.ok(Array.isArray(byId("basemap:waterway")?.paint?.["line-width"]), "scales river/canal widths across zoom");
    assert.equal(byId("basemap:highway_name_other")?.paint?.["text-halo-blur"], 0, "removes blurry halo smear on street names");
    assert.equal(byId("basemap:highway_name_other")?.layout?.["text-transform"], "none", "preserves mixed-script road capitalization");
    assert.equal(byId("basemap:water_name")?.paint?.["text-color"], "#67e8f9", "fixes black water_name text on dark water");
    assert.ok((byId("basemap:place_suburb")?.maxzoom ?? 0) >= 17.5, "keeps neighborhood/district labels visible at street zoom");
    assert.ok(byId("basemap:inject:highway-minor-casing"), "adds minor road casing so crossing side streets pop");
    assert.ok(byId("basemap:inject:metro-rail"), "surfaces metro corridors from z11 instead of z16");
    assert.ok(byId("basemap:inject:landuse-residential"), "retains residential urban blocks at high zoom");
    assert.equal(byId("basemap:inject:housenumber")?.minzoom, 15.2, "reveals house numbers at street detail zoom");
    assert.equal(byId("basemap:highway_minor:street-accent")?.minzoom, 13.2, "defers highway street accent overlay until urban road zoom");

    // 2. Verify layer ordering invariants.
    const idx = (id: string) => styleLayers.findIndex((layer) => layer.id === id);
    assert.ok(idx("basemap:inject:highway-minor-casing") < idx("basemap:highway_minor"), "minor road casing renders underneath minor road fill");
    assert.ok(idx("basemap:highway_minor") < idx("basemap:inject:metro-rail"), "metro rail renders above minor surface roads");
    assert.ok(idx("basemap:inject:metro-rail") < idx("basemap:building:3d"), "3D buildings render above metro/road layers");
    assert.ok(idx("user-location-accuracy-fill") < idx("user-location-accuracy-stroke"));
    assert.ok(idx("user-location-accuracy-stroke") < idx("bucket-cores"), "user accuracy circle sits beneath office pins");

    // 3. Unsupported browser geolocation displays honest message instead of fabricating coordinates.
    Object.defineProperty(dom.navigator, "geolocation", { configurable: true, value: undefined });
    const geoBtn = host.querySelector<HTMLButtonElement>(".atlas-map-geolocate-btn")!;
    assert.ok(geoBtn);
    await act(async () => { geoBtn.click(); await nextTurn(); });
    assert.match(host.textContent ?? "", /不支持定位/);
    const dismissBtn = host.querySelector<HTMLButtonElement>(".atlas-geolocate-dismiss")!;
    await act(async () => { dismissBtn.click(); await nextTurn(); });
    assert.doesNotMatch(host.textContent ?? "", /不支持定位/);

    // 4. Active browser geolocation updates GeoJSON source, marker, distance label, and flyTo camera.
    Object.defineProperty(dom.navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition(success: (pos: any) => void, err: (e: any) => void) {
          onGeoSuccess = success;
          onGeoError = err;
        },
        watchPosition(_success: (pos: any) => void) {
          return 42;
        },
        clearWatch(id: number) {
          clearWatchCalls.push(id);
        },
      },
    });
    const flightsBefore = map.flights.length;
    await act(async () => { geoBtn.click(); await nextTurn(); });
    assert.match(geoBtn.textContent ?? "", /定位中/);
    await act(async () => {
      onGeoSuccess?.({
        coords: { longitude: 121.4737, latitude: 31.2304, accuracy: 24, heading: 90, speed: 0 },
        timestamp: Date.now(),
      });
      await nextTurn();
    });
    assert.ok(map.flights.length > flightsBefore, "centers map on user fix after requesting location");
    const lastFlight = map.flights.at(-1) as { center: [number, number]; zoom: number };
    assert.deepEqual(lastFlight.center, [121.4737, 31.2304]);
    assert.ok(lastFlight.zoom >= 15.6);
    assert.ok(map.userLocationData.length >= 1);
    const uploaded = map.userLocationData.at(-1) as { features: Array<{ geometry: { type: string } }> };
    assert.equal(uploaded.features[0]?.geometry.type, "Polygon");
    assert.equal(uploaded.features[1]?.geometry.type, "Point");
    assert.ok(markers.length > beforeMarkers);
    assert.match(geoBtn.textContent ?? "", /我的位置 · 距此/);

    // 5. Permission denial revokes marker and shows honest feedback.
    const hideBtn = host.querySelector<HTMLButtonElement>(".atlas-map-geolocate-clear")!;
    await act(async () => { hideBtn.click(); await nextTurn(); });
    assert.deepEqual(clearWatchCalls, [42]);
    await act(async () => { geoBtn.click(); await nextTurn(); });
    await act(async () => { onGeoError?.({ code: 1, message: "User denied Geolocation" }); await nextTurn(); });
    assert.match(host.textContent ?? "", /未授权位置权限/);

    // 6. Browser geolocation timeouts fall back to standard accuracy, then offer manual map picking instead of dead-ending.
    await act(async () => { hideBtn.click(); await nextTurn(); });
    const geoCalls: Array<{ high: boolean; ok: (pos: any) => void; err: (e: any) => void }> = [];
    Object.defineProperty(dom.navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition(ok: (pos: any) => void, err: (e: any) => void, opts?: PositionOptions) {
          geoCalls.push({ high: Boolean(opts?.enableHighAccuracy), ok, err });
        },
        watchPosition() { return 77; },
        clearWatch(id: number) { clearWatchCalls.push(id); },
      },
    });
    await act(async () => { geoBtn.click(); await nextTurn(); });
    assert.equal(geoCalls.length, 1);
    assert.equal(geoCalls[0]?.high, true);
    await act(async () => { geoCalls[0]?.err({ code: 3, message: "High-accuracy timeout" }); await nextTurn(); });
    assert.equal(geoCalls.length, 2);
    assert.equal(geoCalls[1]?.high, false);
    assert.match(geoBtn.textContent ?? "", /定位中/, "remains locating during standard-accuracy fallback");
    await act(async () => { geoCalls[1]?.err({ code: 3, message: "Standard-accuracy timeout" }); await nextTurn(); });
    assert.match(host.textContent ?? "", /获取当前定位超时/);

    const pickBtn = host.querySelector<HTMLButtonElement>(".atlas-geolocate-pick-btn")!;
    assert.ok(pickBtn, "surfaces 地图点选 recovery button when browser geolocation times out");
    await act(async () => { pickBtn.click(); await nextTurn(); });
    assert.match(host.textContent ?? "", /请在地图上点击你的当前位置/);
    assert.equal(map.getCanvas().style.cursor, "crosshair");

    // Pressing Escape exits manual pick cleanly back to idle.
    await act(async () => {
      dom.window.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape" }) as unknown as Event);
      await nextTurn();
    });
    assert.doesNotMatch(host.textContent ?? "", /请在地图上点击你的当前位置/);

    // Re-enter map pick after retry timeout and click on map to place manual beacon.
    await act(async () => { geoBtn.click(); await nextTurn(); });
    await act(async () => { geoCalls.at(-1)?.err({ code: 3, message: "Timeout" }); await nextTurn(); });
    await act(async () => { geoCalls.at(-1)?.err({ code: 3, message: "Timeout" }); await nextTurn(); });
    await act(async () => { host.querySelector<HTMLButtonElement>(".atlas-geolocate-pick-btn")!.click(); await nextTurn(); });
    const manualFlightsBefore = map.flights.length;
    await act(async () => {
      map.emit("click", { point: { x: 10, y: 10 }, lngLat: { lng: 121.482, lat: 31.235 } });
      await nextTurn();
    });
    assert.ok(map.flights.length > manualFlightsBefore, "flies to manually picked user location");
    const manualUploaded = map.userLocationData.at(-1) as { features: Array<{ geometry: { type: string }; properties?: { label?: string } }> };
    assert.equal(manualUploaded.features.length, 1, "manual pin omits fabricated GPS uncertainty circle");
    assert.equal(manualUploaded.features[0]?.geometry.type, "Point");
    assert.equal(manualUploaded.features[0]?.properties?.label, "我的位置 · 手动标点");
    assert.match(geoBtn.textContent ?? "", /我的位置 · 距此/);
  } finally {
    if (geoDescriptor) Object.defineProperty(dom.navigator, "geolocation", geoDescriptor);
    else Reflect.deleteProperty(dom.navigator, "geolocation");
    await act(async () => { root.unmount(); });
    host.remove();
    globalThis.fetch = prevFetch;
  }
});


test("browser timeout automatically recovers via /api/network/geolocate, plots IP fix with city zoom and 地图点选 refine prompt", async () => {
  const prevFetch = globalThis.fetch;
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const beforeInstances = instances.length;

  let geolocateFetches = 0;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    if (url.includes("/api/network/geolocate")) {
      geolocateFetches += 1;
      return new Response(
        JSON.stringify({
          ok: true,
          source: "ip",
          provider: "bilibili-ip",
          longitude: 121.476753,
          latitude: 31.224349,
          accuracyMeters: 5000,
          cityLabel: "上海",
          countryCode: "CN",
          timestamp: 1763218000000,
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("style.json")) {
      return new Response(
        JSON.stringify({
          version: 8,
          sources: { openmaptiles: { type: "vector", url: "https://synthetic.invalid/planet" } },
          layers: [{ id: "background", type: "background", paint: { "background-color": "#000000" } }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ type: "FeatureCollection", features: [] }), {
      headers: { "content-type": "application/json" },
    });
  };

  const geoDescriptor = Object.getOwnPropertyDescriptor(dom.navigator, "geolocation");
  const geoCalls: Array<{ high: boolean; err: (e: { code: number; message: string }) => void }> = [];
  Object.defineProperty(dom.navigator, "geolocation", {
    value: {
      getCurrentPosition(_ok: PositionCallback, err?: PositionErrorCallback | null, opts?: PositionOptions) {
        geoCalls.push({
          high: Boolean(opts?.enableHighAccuracy),
          err: (e) => err?.(e as unknown as GeolocationPositionError),
        });
      },
      watchPosition: () => 1,
      clearWatch: () => {},
    },
    configurable: true,
  });

  try {
    await act(async () => {
      root.render(h(MapLibrePrototype, {
        mode: "domestic",
        basemap: {
          id: "openfreemap-dark",
          name: "Synthetic OpenFreeMap",
          maxZoom: 22,
          type: "vector-style",
          styleUrl: "http://127.0.0.1/style.json",
          attributions: [{ label: "Synthetic", url: "https://synthetic.invalid" }],
        },
        buckets: [
          {
            id: "pt-sh",
            label: "静安办公点",
            latitude: 31.23,
            longitude: 121.45,
            jobCount: 1,
            displayGrade: "address",
            locationIds: ["loc-sh"],
            categories: [{ color: "#123456", jobCount: 1 }],
          },
        ] as AtlasPrototypeProps["buckets"],
        selectedJobId: null,
        focus: null,
        visual: { theme: "dark", autoRotate: false },
      }));
    });
    for (let i = 0; i < 6 && instances.length === beforeInstances; i++) await nextTurn();
    const map = instances.at(-1)!;
    await act(async () => { map.emit("load"); await nextTurn(); });

    const geoBtn = host.querySelector<HTMLButtonElement>(".atlas-map-geolocate-btn");
    assert.ok(geoBtn, "geolocate button should be rendered");

    const callsBeforeClick = geoCalls.length;
    await act(async () => { geoBtn.click(); await nextTurn(); });
    assert.equal(geoCalls.length, callsBeforeClick + 1);
    assert.equal(geoCalls.at(-1)?.high, true);

    // Exhaust high-accuracy then standard-accuracy browser geolocation with timeouts (code: 3).
    await act(async () => { geoCalls.at(-1)?.err({ code: 3, message: "High-accuracy timeout" }); await nextTurn(); });
    assert.equal(geoCalls.length, callsBeforeClick + 2);
    assert.equal(geoCalls.at(-1)?.high, false);

    await act(async () => {
      geoCalls.at(-1)?.err({ code: 3, message: "Standard-accuracy timeout" });
      await nextTurn();
      await nextTurn();
    });

    assert.equal(geolocateFetches, 1, "falls back cleanly to /api/network/geolocate after browser timeouts");
    assert.match(geoBtn.textContent ?? "", /我的位置 · 网络定位 · 上海 · ±5\.0km/);
    assert.match(host.textContent ?? "", /上海网络定位（城市级），可微调位置/);
    assert.ok(
      host.querySelector(".atlas-user-location-notice.is-approximate .atlas-geolocate-pick-btn"),
      "surfaces 地图点选 refine button next to city-level IP notice",
    );

    const lastFlight = map.flights.at(-1) as { zoom?: number; center?: [number, number] } | undefined;
    assert.ok(lastFlight && typeof lastFlight.zoom === "number", "flies to IP geolocation fix");
    assert.ok(lastFlight.zoom >= 11.5 && lastFlight.zoom <= 12.8, `expected city zoom ~11.8, got ${lastFlight.zoom}`);

    const uploaded = map.userLocationData.at(-1) as {
      features: Array<{ geometry: { type: string }; properties?: { label?: string } }>;
    };
    assert.equal(uploaded.features.length, 2);
    assert.equal(uploaded.features[0]?.geometry.type, "Polygon");
    assert.equal(uploaded.features[1]?.geometry.type, "Point");
    assert.equal(uploaded.features[1]?.properties?.label, "我的位置 · 网络定位 · 上海 · ±5.0km");

    const dismissBtn = host.querySelector<HTMLButtonElement>(".atlas-user-location-notice.is-approximate .atlas-geolocate-dismiss");
    assert.ok(dismissBtn);
    await act(async () => { dismissBtn.click(); await nextTurn(); });
    assert.doesNotMatch(host.textContent ?? "", /上海网络定位（城市级）/);
  } finally {
    if (geoDescriptor) Object.defineProperty(dom.navigator, "geolocation", geoDescriptor);
    else Reflect.deleteProperty(dom.navigator, "geolocation");
    await act(async () => { root.unmount(); });
    host.remove();
    globalThis.fetch = prevFetch;
  }
});

test("supports macOS CoreLocation street fix, inline street search refinement, and reverse-geocoded manual pins", async () => {
  const prevFetch = globalThis.fetch;
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const beforeInstances = instances.length;

  let geolocateCall = 0;
  const requestedUrls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    requestedUrls.push(url);
    if (url.includes("/api/network/geolocate")) {
      geolocateCall += 1;
      if (geolocateCall === 1) {
        return new Response(
          JSON.stringify({
            ok: true,
            source: "macos",
            provider: "corelocation",
            longitude: 121.4542,
            latitude: 31.2288,
            accuracyMeters: 25,
            cityLabel: "上海市 · 静安区",
            streetLabel: "静安区 · 南京西路街道 · 南京西路 1266号",
            countryCode: "CN",
            coreLocationStatus: "authorized",
            timestamp: 1763218000000,
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          ok: true,
          source: "ip",
          provider: "bilibili-ip",
          longitude: 121.476753,
          latitude: 31.224349,
          accuracyMeters: 5000,
          cityLabel: "上海",
          countryCode: "CN",
          coreLocationStatus: "denied",
          timestamp: 1763218005000,
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith("/api/network/search-location")) {
      return new Response(
        JSON.stringify({
          ok: true,
          candidates: [
            {
              id: "nom-1",
              label: "静安区 · 南京西路街道 · 南京西路（上海市静安区）",
              streetLabel: "静安区 · 南京西路街道 · 南京西路",
              cityLabel: "上海市 · 静安区",
              longitude: 121.454,
              latitude: 31.229,
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith("/api/network/reverse-geocode")) {
      return new Response(
        JSON.stringify({
          ok: true,
          cityLabel: "上海市 · 黄浦区",
          streetLabel: "黄浦区 · 延安东路街道 · 延安东路",
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("style.json")) {
      return new Response(
        JSON.stringify({
          version: 8,
          sources: { openmaptiles: { type: "vector", url: "https://synthetic.invalid/planet" } },
          layers: [{ id: "background", type: "background", paint: { "background-color": "#000000" } }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ type: "FeatureCollection", features: [] }), {
      headers: { "content-type": "application/json" },
    });
  };

  const geoDescriptor = Object.getOwnPropertyDescriptor(dom.navigator, "geolocation");
  Object.defineProperty(dom.navigator, "geolocation", {
    value: undefined,
    configurable: true,
  });

  try {
    await act(async () => {
      root.render(h(MapLibrePrototype, {
        mode: "domestic",
        basemap: {
          id: "openfreemap-dark",
          name: "Synthetic OpenFreeMap",
          maxZoom: 22,
          type: "vector-style",
          styleUrl: "http://127.0.0.1/style.json",
          attributions: [{ label: "Synthetic", url: "https://synthetic.invalid" }],
        },
        buckets: [] as AtlasPrototypeProps["buckets"],
        selectedJobId: null,
        focus: null,
        visual: { theme: "dark", autoRotate: false },
      }));
    });
    for (let i = 0; i < 6 && instances.length === beforeInstances; i++) await nextTurn();
    const map = instances.at(-1)!;
    await act(async () => { map.emit("load"); await nextTurn(); });

    // 1. macOS CoreLocation auto street fix zooms to z16 and skips IP banner
    const geoBtn = host.querySelector<HTMLButtonElement>(".atlas-map-geolocate-btn")!;
    await act(async () => { geoBtn.click(); await nextTurn(); await nextTurn(); });
    assert.ok(requestedUrls.some((url) => url === "/api/network/geolocate?authorize=1"));
    assert.match(geoBtn.textContent ?? "", /静安区 · 南京西路街道 · 南京西路 1266号/);
    assert.equal(host.querySelector(".atlas-user-location-notice.is-approximate"), null);
    const macFlight = map.flights.at(-1) as { zoom?: number } | undefined;
    assert.ok(macFlight && (macFlight.zoom ?? 0) >= 16, `expected street zoom >= 16, got ${macFlight?.zoom}`);

    // 2. Clear and trigger IP fallback (CoreLocation denied), then refine via inline street search
    const clearBtn = host.querySelector<HTMLButtonElement>(".atlas-map-geolocate-clear")!;
    await act(async () => { clearBtn.click(); await nextTurn(); });
    await act(async () => { geoBtn.click(); await nextTurn(); await nextTurn(); });
    assert.match(host.textContent ?? "", /系统定位未授权/);

    const searchInput = host.querySelector<HTMLInputElement>(".atlas-street-search-input")!;
    const searchForm = host.querySelector<HTMLFormElement>(".atlas-street-search-form")!;
    assert.ok(searchInput && searchForm, "renders inline street search form inside IP notice");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(searchInput, "南京西路");
      searchInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await nextTurn();
    });
    await act(async () => {
      searchForm.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
      await nextTurn();
      await nextTurn();
    });
    assert.ok(requestedUrls.some((url) => url.startsWith("/api/network/search-location?q=")));
    const candidateBtn = host.querySelector<HTMLButtonElement>(".atlas-street-candidate-btn")!;
    assert.ok(candidateBtn, "shows street candidates");
    await act(async () => { candidateBtn.click(); await nextTurn(); });
    assert.match(geoBtn.textContent ?? "", /静安区 · 南京西路街道 · 南京西路 · 街道定位/);
    const searchFlight = map.flights.at(-1) as { zoom?: number } | undefined;
    assert.ok(searchFlight && (searchFlight.zoom ?? 0) >= 16, `expected street zoom >= 16, got ${searchFlight?.zoom}`);

    // 3. Switching to manual pick automatically reverse-geocodes clicked pin to street name
    await act(async () => { host.querySelector<HTMLButtonElement>(".atlas-map-geolocate-clear")?.click(); await nextTurn(); });
    await act(async () => { geoBtn.click(); await nextTurn(); });
    const pickBtn = host.querySelector<HTMLButtonElement>(".atlas-geolocate-pick-btn")!;
    await act(async () => { pickBtn.click(); await nextTurn(); });
    await act(async () => {
      map.emit("click", { point: { x: 20, y: 20 }, lngLat: { lng: 121.48, lat: 31.23 } });
      await nextTurn();
      await nextTurn();
    });
    assert.ok(requestedUrls.some((url) => url.startsWith("/api/network/reverse-geocode?lon=121.48&lat=31.23")));
    assert.match(geoBtn.textContent ?? "", /黄浦区 · 延安东路街道 · 延安东路 · 手动标点/);
  } finally {
    if (geoDescriptor) Object.defineProperty(dom.navigator, "geolocation", geoDescriptor);
    else Reflect.deleteProperty(dom.navigator, "geolocation");
    await act(async () => { root.unmount(); });
    host.remove();
    globalThis.fetch = prevFetch;
  }
});

test("renders surrounding job-seeking companies on the map, supports click selection, and triggers company job search actions", async () => {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const beforeInstances = instances.length;

  const nearbyCompanies = [
    {
      id: "way-519940304",
      name: "英特尔亚太研发有限公司",
      shortName: "英特尔亚太研发",
      searchKeyword: "英特尔",
      kind: "company" as const,
      longitude: 121.4506,
      latitude: 31.0238,
      distanceMeters: 563,
      streetAddress: "闵行区 · 紫星路",
      ownershipLabel: "外资 / 跨国分支（待核实）",
      ownershipColor: "#76BD8A",
      indexedJobCount: 3,
    },
    {
      id: "way-131633574",
      name: "微软",
      shortName: "微软",
      searchKeyword: "微软",
      kind: "company" as const,
      longitude: 121.4463,
      latitude: 31.0209,
      distanceMeters: 1078,
      ownershipLabel: "企业实体（控股待核）",
      ownershipColor: "#38BDF8",
    },
  ];

  const selectedCalls: Array<string | null> = [];
  const searchCalls: string[] = [];

  try {
    await act(async () => {
      root.render(h(MapLibrePrototype, {
        mode: "domestic",
        basemap: null,
        buckets: [] as AtlasPrototypeProps["buckets"],
        nearbyCompanies,
        selectedNearbyCompanyId: "way-519940304",
        onSelectNearbyCompany: (c) => selectedCalls.push(c?.id ?? null),
        onSearchNearbyCompanyJobs: (c) => searchCalls.push(c.searchKeyword),
        visual: { theme: "dark", autoRotate: false },
      }));
    });
    for (let i = 0; i < 6 && instances.length === beforeInstances; i++) await nextTurn();
    const map = instances.at(-1)!;
    await act(async () => { map.emit("load"); await nextTurn(); });

    assert.ok(map.nearbyCompaniesData.length >= 1, "uploads nearby companies GeoJSON");
    const lastGeoJson = map.nearbyCompaniesData.at(-1) as { features: Array<{ properties: { mapLabel: string; selected: boolean } }> };
    assert.equal(lastGeoJson.features.length, 2);
    assert.equal(lastGeoJson.features[0]?.properties.mapLabel, "英特尔亚太研发 · 3岗 · 563m");
    assert.equal(lastGeoJson.features[0]?.properties.selected, true);

    const card = host.querySelector(".atlas-nearby-selected-card");
    assert.ok(card, "renders interactive selected nearby company card on the map");
    assert.match(card.textContent ?? "", /英特尔亚太研发有限公司/);
    assert.match(card.textContent ?? "", /查看库内 3 个在招岗/);

    const primaryBtn = card.querySelector<HTMLButtonElement>(".atlas-nearby-primary-action")!;
    await act(async () => { primaryBtn.click(); await nextTurn(); });
    assert.deepEqual(searchCalls, ["英特尔"]);

    const filterCalls: string[] = [];
    const scannedAreas: Array<{ longitude: number; latitude: number }> = [];
    await act(async () => {
      root.render(h(MapLibrePrototype, {
        mode: "domestic",
        basemap: null,
        buckets: [] as AtlasPrototypeProps["buckets"],
        nearbyCompanies,
        selectedNearbyCompanyId: "way-519940304",
        onSelectNearbyCompany: (c) => selectedCalls.push(c?.id ?? null),
        onFilterNearbyCompanyJobs: (c) => filterCalls.push(c.searchKeyword),
        onSearchNearbyCompanyJobs: (c) => searchCalls.push(c.searchKeyword),
        onScanViewportArea: (area) => scannedAreas.push(area),
        visual: { theme: "dark", autoRotate: false },
      }));
    });
    const secondaryBtn = host.querySelector<HTMLButtonElement>(".atlas-nearby-secondary-action")!;
    assert.ok(secondaryBtn, "exposes full-network secondary harvest button even when indexed jobs exist");
    await act(async () => { secondaryBtn.click(); await nextTurn(); });
    assert.deepEqual(filterCalls, ["英特尔"]);

    // Viewport scan button appears at z >= 11.5 when radarCenter is unset or distant
    map.zoom = 13.4;
    map.center = { lng: 121.4585, lat: 31.0205 };
    await act(async () => { map.emit("moveend"); await nextTurn(); });
    const scanBtn = host.querySelector<HTMLButtonElement>(".atlas-map-scan-area-btn")!;
    assert.ok(scanBtn, "shows viewport nearby company scan pill on street/district zoom");
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false }), { status: 200 })) as typeof fetch;
    try {
      await act(async () => { scanBtn.click(); await nextTurn(); await nextTurn(); });
    } finally {
      globalThis.fetch = prevFetch;
    }
    assert.equal(scannedAreas.length, 1);
    assert.equal(scannedAreas[0]?.longitude, 121.4585);
    assert.equal(scannedAreas[0]?.latitude, 31.0205);

    // Clicking a rendered nearby-company point emits onSelectNearbyCompany
    map.queryResults = [{ properties: { companyId: "way-131633574" } }];
    await act(async () => {
      map.emit("click", { point: { x: 40, y: 40 }, lngLat: { lng: 121.4463, lat: 31.0209 } });
      await nextTurn();
    });
    assert.equal(selectedCalls.at(-1), "way-131633574");
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
  }
});
