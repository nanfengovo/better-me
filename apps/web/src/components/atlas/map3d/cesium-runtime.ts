import * as C from "cesium";
import type { AtlasPrototypeProps } from "../prototypes/types";
import { loadBoundary } from "../prototypes/types";
import { activeMapFocus } from "../map-focus";
import { createSceneReconciler, type SceneMarker } from "./scene-model";
import { boundaryRings } from "./boundary-lines";
import { SCENE_QUALITY, describeSceneFailure, heightToZoom, validateSceneSource, zoomToHeight, type SceneFailure, type SceneQuality, type SceneSource } from "./config";

export type NativeSceneCamera = { position: C.Cartesian3; heading: number; pitch: number; roll: number };
export type SceneStatus = { phase: "loading" | "ready" | "error"; rootRequests: number; failure?: SceneFailure };
export type CesiumAtlasHandle = { update: (props: AtlasPrototypeProps) => void; source: (source: SceneSource) => void; quality: (quality: SceneQuality) => void; navigate: (action: "in" | "out" | "north") => void; dispose: () => void };
type Callbacks = { status: (status: SceneStatus) => void; pick: (ids: string[]) => void; camera: (view: NativeSceneCamera) => void; initialCamera?: NativeSceneCamera };
const markerImage = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="13" fill="white" fill-opacity=".95"/><circle cx="16" cy="16" r="9" fill="white"/><circle cx="16" cy="16" r="3" fill="#123c32"/></svg>')}`;

/** One Viewer owns the scene. Source, quality, data and theme updates never reconstruct it. */
export function createCesiumAtlas(element: HTMLElement, initial: AtlasPrototypeProps, callbacks: Callbacks): CesiumAtlasHandle {
  const viewer = new C.Viewer(element, {
    baseLayer: false, terrainProvider: new C.EllipsoidTerrainProvider(), baseLayerPicker: false,
    geocoder: false, homeButton: false, sceneModePicker: false, navigationHelpButton: false,
    fullscreenButton: false, animation: false, timeline: false, infoBox: false, selectionIndicator: false,
    scene3DOnly: true, requestRenderMode: true, maximumRenderTimeChange: Infinity,
    shouldAnimate: false, shadows: false, skyBox: false, showRenderLoopErrors: false,
  });
  const { scene, camera } = viewer;
  const cleanup: Array<() => void> = [];
  try {
  scene.globe.baseColor = C.Color.fromCssColorString("#173e42");
  scene.globe.enableLighting = false;
  scene.backgroundColor = C.Color.fromCssColorString("#101e29");
  scene.screenSpaceCameraController.minimumZoomDistance = 40;
  scene.screenSpaceCameraController.maximumZoomDistance = 30_000_000;
  // Keep SDK copyright and dynamic tileset credits in the normal, visible credit area.
  const sourceCredit = new C.Credit("BetterMe · Natural Earth 概略边界 · 岗位坐标来自独立来源", true);
  viewer.creditDisplay.addStaticCredit(sourceCredit);
  const billboards = scene.primitives.add(new C.BillboardCollection({ scene })) as C.BillboardCollection;
  const points = new Map<string, C.Billboard>();
  let props = initial, disposed = false, renderFailed = false, quality: SceneQuality = "balanced";
  let currentSource: SceneSource = { kind: "globe" };
  let tileset: C.Cesium3DTileset | undefined;
  let boundary: C.GeoJsonDataSource | undefined, highlight: C.GeoJsonDataSource | undefined;
  let highlightInput: AtlasPrototypeProps["adminBoundary"];
  let highlightGeneration = 0, sourceGeneration = 0, rootRequests = 0;
  let customCredit: C.Credit | undefined;
  let framed: string | undefined, hasFramed = false, focusId: string | undefined;
  let pickedMarker: string | undefined;
  let lastTheme: string | undefined;
  let resetRevision = initial.resetRevision;
  let boundaryMode: string | undefined;
  let boundaryAbort: AbortController | undefined;
  let sourceCleanup: (() => void) | undefined;
  const nativeView = callbacks.initialCamera;
  let restored = Boolean(nativeView || initial.initialView);
  const requestRender = () => { if (!disposed) scene.requestRender(); };
  const status = (phase: SceneStatus["phase"], failure?: SceneFailure) => { if (!disposed && (!renderFailed || phase === "error")) callbacks.status({ phase, rootRequests, ...(failure ? { failure } : {}) }); };

  function setSelected(id?: string) {
    if (pickedMarker && points.has(pickedMarker)) { points.get(pickedMarker)!.scale = 1; }
    if (id && points.has(id)) points.get(id)!.scale = 1.45;
    pickedMarker = id;
  }
  const reconcile = createSceneReconciler({
    upsert(marker: SceneMarker) {
      let point = points.get(marker.id);
      if (!point) {
        point = billboards.add({ id: { atlasMarker: marker.id }, image: markerImage,
          position: C.Cartesian3.fromDegrees(marker.longitude, marker.latitude),
          heightReference: C.HeightReference.CLAMP_TO_GROUND, width: 22, height: 22,
          scaleByDistance: new C.NearFarScalar(150, 1.2, 100_000, .35),
          pixelOffset: new C.Cartesian2(0, -5), verticalOrigin: C.VerticalOrigin.BOTTOM,
        });
        points.set(marker.id, point);
      }
      point.color = C.Color.fromCssColorString(marker.color);
    },
    remove(id) { const point = points.get(id); if (point) billboards.remove(point); points.delete(id); },
    select: setSelected, render: requestRender,
  });
  let markers = new Map<string, SceneMarker>();
  // SDK-bundled Natural Earth imagery is local and needs neither ion nor Google.
  // Avoid tessellating every country's filled polygon just to draw an overview.
  void C.TileMapServiceImageryProvider.fromUrl(C.buildModuleUrl("Assets/Textures/NaturalEarthII")).then(provider => {
    if (!disposed) { viewer.imageryLayers.addImageryProvider(provider); requestRender(); }
  }).catch(() => { /* Local outline/point navigation remains usable if an overview image is absent. */ });

  function look(longitude: number, latitude: number, zoom: number, animate = false) {
    const target = C.Cartesian3.fromDegrees(longitude, latitude);
    const offset = new C.HeadingPitchRange(0, C.Math.toRadians(-65), zoomToHeight(zoom, latitude));
    if (animate && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) camera.flyToBoundingSphere(new C.BoundingSphere(target, 1), { offset, duration: .65 });
    else { camera.lookAt(target, offset); camera.lookAtTransform(C.Matrix4.IDENTITY); }
    requestRender();
  }
  if (nativeView) camera.setView({ destination: nativeView.position, orientation: nativeView });
  else if (initial.initialView) look(...initial.initialView.center, initial.initialView.zoom);
  else look(initial.mode === "domestic" ? 104 : 105, initial.mode === "domestic" ? 35 : 28, initial.mode === "domestic" ? 3.1 : 1.65);

  const input = new C.ScreenSpaceEventHandler(scene.canvas);
  cleanup.push(() => input.destroy());
  input.setInputAction((event: { position: C.Cartesian2 }) => {
    const hits = scene.drillPick(event.position, 20, 44, 44) as Array<{ id?: { atlasMarker?: string; properties?: C.PropertyBag; id?: string } }>;
    const ids = [...new Set(hits.flatMap(hit => hit.id?.atlasMarker ? markers.get(hit.id.atlasMarker)?.bucketIds ?? [] : []))];
    if (ids.length) callbacks.pick(ids);
    else {
      const region = hits.find(hit => hit.id?.properties)?.id;
      const properties = region?.properties?.getValue(viewer.clock.currentTime);
      if (properties?.id && (properties.countryCode || props.mode === "domestic")) props.onCountry?.({ id: String(properties.id), name: String(properties.nameZh || properties.name || properties.id), ...(properties.countryCode ? { countryCode: String(properties.countryCode) } : {}) });
    }
  }, C.ScreenSpaceEventType.LEFT_CLICK);
  // Disable Cesium's default double-click tracking; the application owns job selection/focus.
  viewer.screenSpaceEventHandler.removeInputAction(C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  let rotationFrame = 0, previousFrame = 0, rotationActive = false, interactionUntil = 0;
  let orbit: { target: C.Cartesian3; heading: number; pitch: number; range: number } | undefined;
  const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  function rotate(now: number) {
    rotationFrame = 0;
    if (!rotationActive || disposed) return;
    const elapsed = previousFrame ? Math.min(50, now - previousFrame) : 0; previousFrame = now;
    if (now >= interactionUntil) {
      if (!orbit) {
        const ray = camera.getPickRay(new C.Cartesian2(element.clientWidth / 2, element.clientHeight / 2));
        const target = ray && scene.globe.pick(ray, scene);
        if (target) orbit = { target, heading: camera.heading, pitch: camera.pitch, range: C.Cartesian3.distance(camera.positionWC, target) };
      }
      if (orbit) { orbit.heading += elapsed * .000025; camera.lookAt(orbit.target, new C.HeadingPitchRange(orbit.heading, orbit.pitch, orbit.range)); camera.lookAtTransform(C.Matrix4.IDENTITY); requestRender(); }
    }
    rotationFrame = requestAnimationFrame(rotate);
  }
  function syncRotation() {
    const enabled = Boolean(props.visual?.autoRotate && !motion?.matches && document.visibilityState === "visible");
    if (rotationActive === enabled) return;
    rotationActive = enabled; cancelAnimationFrame(rotationFrame); rotationFrame = 0; orbit = undefined; previousFrame = 0;
    if (enabled) rotationFrame = requestAnimationFrame(rotate);
  }
  const interacted = () => { framed = props.framingKey; hasFramed = true; restored = false; interactionUntil = performance.now() + 2000; orbit = undefined; };
  scene.canvas.addEventListener("pointerdown", interacted);
  scene.canvas.addEventListener("pointermove", interacted);
  scene.canvas.addEventListener("wheel", interacted, { passive: true });
  document.addEventListener("visibilitychange", syncRotation); motion?.addEventListener("change", syncRotation);
  cleanup.push(() => { rotationActive = false; cancelAnimationFrame(rotationFrame); document.removeEventListener("visibilitychange", syncRotation); motion?.removeEventListener("change", syncRotation); scene.canvas.removeEventListener("pointerdown", interacted); scene.canvas.removeEventListener("pointermove", interacted); scene.canvas.removeEventListener("wheel", interacted); });
  const moveEnd = camera.moveEnd.addEventListener(() => {
    if (disposed) return;
    callbacks.camera({ position: C.Cartesian3.clone(camera.positionWC), heading: camera.heading, pitch: camera.pitch, roll: camera.roll });
    const rectangle = camera.computeViewRectangle();
    const carto = camera.positionCartographic;
    const centerRay = camera.getPickRay(new C.Cartesian2(element.clientWidth / 2, element.clientHeight / 2));
    const centerPoint = centerRay && scene.globe.pick(centerRay, scene);
    const center = centerPoint ? C.Cartographic.fromCartesian(centerPoint) : carto;
    const longitude = C.Math.toDegrees(center.longitude), latitude = C.Math.toDegrees(center.latitude);
    props.onViewChange?.({ center: [longitude, latitude], zoom: heightToZoom(carto.height, latitude), pitch: 90 + C.Math.toDegrees(camera.pitch), bearing: C.Math.toDegrees(camera.heading),
      bounds: rectangle ? [rectangle.west, rectangle.south, rectangle.east, rectangle.north].map(C.Math.toDegrees) as [number, number, number, number] : [-180, -90, 180, 90] });
  });
  cleanup.push(moveEnd);
  const lost = (event: Event) => { event.preventDefault(); renderFailed = true; status("error", describeSceneFailure("WebGL context lost")); };
  scene.canvas.addEventListener("webglcontextlost", lost);
  cleanup.push(() => scene.canvas.removeEventListener("webglcontextlost", lost));
  const renderError = scene.renderError.addEventListener((_scene: C.Scene, error: unknown) => { renderFailed = true; status("error", describeSceneFailure(error)); });
  cleanup.push(renderError);
  const observer = new ResizeObserver(() => { if (!disposed) { viewer.resize(); requestRender(); } });
  observer.observe(element);
  cleanup.push(() => observer.disconnect());

  async function localBoundary(mode: AtlasPrototypeProps["mode"]) {
    if (boundaryMode === mode) return;
    boundaryMode = mode;
    boundaryAbort?.abort(); const abort = new AbortController(); boundaryAbort = abort;
    try {
      const data = await loadBoundary(mode, abort.signal);
      if (disposed || abort.signal.aborted) return;
      const lines = { type: "FeatureCollection", features: data.features.map(feature => ({type:"Feature", id:feature.id, properties:feature.properties,
        geometry:{type:"MultiLineString",coordinates:boundaryRings(feature).map(ring => Array.from({length:ring.length / 2},(_,i)=>[ring[i*2],ring[i*2+1]]))} })) };
      const loaded = await C.GeoJsonDataSource.load(lines, { stroke: C.Color.fromCssColorString("#80aaa7"), strokeWidth: 1, clampToGround: false });
      if (disposed || abort.signal.aborted) return;
      for (const entity of loaded.entities.values) if (entity.polyline) entity.polyline.arcType = new C.ConstantProperty(C.ArcType.GEODESIC);
      if (boundary) viewer.dataSources.remove(boundary, true);
      boundary = loaded; boundary.show = currentSource.kind === "globe";
      await viewer.dataSources.add(loaded); requestRender();
    } catch { /* Boundaries are a local overview aid, never a prerequisite for job points. */ }
  }
  function addGroundOutlines(data: C.GeoJsonDataSource, geoJson: unknown, color: string, width: number) {
    // Cesium polygon outlines cannot be ground-clamped. Explicit ground polylines
    // keep the original rings visible on both the ellipsoid and 3D Tiles surfaces.
    for (const entity of data.entities.values) {
      if (entity.polygon) { entity.polygon.fill = new C.ConstantProperty(false); entity.polygon.outline = new C.ConstantProperty(false); entity.polygon.arcType = new C.ConstantProperty(C.ArcType.GEODESIC); }
      if (entity.polyline) entity.polyline.arcType = new C.ConstantProperty(C.ArcType.GEODESIC);
    }
    for (const positions of boundaryRings(geoJson)) data.entities.add({ polyline: { positions: C.Cartesian3.fromDegreesArray(positions), clampToGround: true, width, material: C.Color.fromCssColorString(color) } });
  }
  async function updateHighlight(next: AtlasPrototypeProps["adminBoundary"]) {
    if (highlightInput === next) return;
    highlightInput = next; const generation = ++highlightGeneration;
    if (highlight) viewer.dataSources.remove(highlight, true); highlight = undefined;
    if (!next) { requestRender(); return; }
    try {
      const loaded = await C.GeoJsonDataSource.load(next.geoJson, { stroke: C.Color.fromCssColorString(next.color), fill: C.Color.TRANSPARENT, strokeWidth: 2, clampToGround: true });
      if (disposed || generation !== highlightGeneration) return;
      addGroundOutlines(loaded, next.geoJson, next.color, 2);
      highlight = loaded; await viewer.dataSources.add(loaded); requestRender();
    } catch { /* Never replace verified point coordinates to compensate for a boundary failure. */ }
  }
  function update(next: AtlasPrototypeProps) {
    if (disposed) return;
    props = next;
    syncRotation();
    if (resetRevision !== next.resetRevision) { resetRevision = next.resetRevision; hasFramed = false; framed = undefined; restored = false; focusId = undefined; if (!next.bounds) look(next.mode === "domestic" ? 104 : 105, next.mode === "domestic" ? 35 : 28, next.mode === "domestic" ? 3.1 : 1.65); }
    markers = reconcile(next.buckets, next.selectedBucketId);
    void localBoundary(next.mode); void updateHighlight(next.adminBoundary);
    if (lastTheme !== next.visual?.theme) {
      lastTheme = next.visual?.theme;
      scene.backgroundColor = C.Color.fromCssColorString(lastTheme === "light" ? "#dae5e4" : "#101e29"); requestRender();
    }
    const focus = activeMapFocus(next.focus, next.selectedJobId);
    const identity = focus ? `${focus.requestId ?? ""}:${focus.jobId ?? ""}:${focus.longitude}:${focus.latitude}:${focus.zoom}` : undefined;
    if (focus && identity !== focusId) { focusId = identity; restored = false; hasFramed = true; framed = next.framingKey; look(focus.longitude, focus.latitude, focus.zoom ?? 14, next.visual?.animateViewChange); }
    else if (!focus) focusId = undefined;
    if (!focus && next.bounds && (!hasFramed || next.framingKey !== framed)) {
      hasFramed = true; framed = next.framingKey;
      if (restored) { restored = false; return; }
      const [west, south, east, north] = next.bounds;
      if ([west, south, east, north].every(Number.isFinite) && east > west && north > south) {
        const rectangle = C.Rectangle.fromDegrees(west, south, east, north);
        const fitted = camera.getRectangleCameraCoordinates(rectangle);
        if (fitted) {
          const location = C.Cartographic.fromCartesian(fitted);
          location.height = Math.max(location.height, zoomToHeight(next.boundsMaxZoom ?? 22, C.Math.toDegrees(location.latitude)));
          camera.setView({ destination: C.Cartographic.toCartesian(location), orientation: {heading:0,pitch:-C.Math.PI_OVER_TWO,roll:0} });
        }
        requestRender();
      }
    }
  }
  function setQuality(next: SceneQuality) {
    quality = next;
    const profile = SCENE_QUALITY[next];
    viewer.resolutionScale = Math.min(window.devicePixelRatio || 1, profile.maxDpr) / (window.devicePixelRatio || 1);
    viewer.useBrowserRecommendedResolution = false;
    if (tileset) { tileset.maximumScreenSpaceError = profile.maximumScreenSpaceError; tileset.cacheBytes = profile.cacheBytes; tileset.maximumCacheOverflowBytes = profile.maximumCacheOverflowBytes; }
    requestRender();
  }
  function setSource(raw: SceneSource) {
    if (disposed) return;
    const source = validateSceneSource(raw);
    if (JSON.stringify(source) === JSON.stringify(currentSource)) return;
    currentSource = source; const generation = ++sourceGeneration;
    sourceCleanup?.(); sourceCleanup = undefined;
    if (tileset) scene.primitives.remove(tileset); tileset = undefined;
    if (customCredit) viewer.creditDisplay.removeStaticCredit(customCredit); customCredit = undefined;
    scene.globe.show = true;
    if (boundary) boundary.show = source.kind === "globe";
    if (source.kind === "globe") { status("ready"); requestRender(); return; }
    rootRequests++; status("loading");
    const profile = SCENE_QUALITY[quality];
    const options = { maximumScreenSpaceError: profile.maximumScreenSpaceError, cacheBytes: profile.cacheBytes, maximumCacheOverflowBytes: profile.maximumCacheOverflowBytes, showCreditsOnScreen: true, enableCollision: true };
    const pending = source.kind === "google"
      ? C.createGooglePhotorealistic3DTileset({ key: source.apiKey }, options)
      : C.Cesium3DTileset.fromUrl(source.url, options);
    // Watchdog reports a slow request, but never labels a city as unsupported.
    const timer = setTimeout(() => { if (!disposed && generation === sourceGeneration) status("error", describeSceneFailure("network timeout")); }, 25_000);
    sourceCleanup = () => clearTimeout(timer);
    pending.then(loaded => {
      clearTimeout(timer);
      if (disposed || generation !== sourceGeneration) { loaded.destroy(); return; }
      tileset = loaded; scene.primitives.add(loaded); scene.globe.show = false;
      if (source.kind === "tileset") { customCredit = new C.Credit(source.attribution.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!), true); viewer.creditDisplay.addStaticCredit(customCredit); }
      const failed = loaded.tileFailed.addEventListener((error: unknown) => status("error", describeSceneFailure(error)));
      sourceCleanup = failed;
      setQuality(quality); status("ready"); requestRender();
    }).catch(error => { clearTimeout(timer); if (!disposed && generation === sourceGeneration) { scene.globe.show = true; status("error", describeSceneFailure(error)); requestRender(); } });
  }
  setQuality(quality); update(initial); status("ready"); initial.onReady?.();
  return { update, source: setSource, quality: setQuality, navigate(action) {
    if (disposed) return;
    interacted();
    if (action === "north") camera.setView({ orientation: { heading: 0, pitch: camera.pitch, roll: 0 } });
    else if (action === "in") camera.zoomIn(Math.max(20, camera.positionCartographic.height * .4));
    else camera.zoomOut(Math.max(20, camera.positionCartographic.height * .6));
    requestRender();
  }, dispose() {
    if (disposed) return;
    callbacks.camera({ position: C.Cartesian3.clone(camera.positionWC), heading: camera.heading, pitch: camera.pitch, roll: camera.roll });
    disposed = true; sourceGeneration++; highlightGeneration++; boundaryAbort?.abort(); sourceCleanup?.();
    cleanup.reverse().forEach(dispose => dispose()); viewer.destroy();
  } };
  } catch (error) {
    cleanup.reverse().forEach(dispose => dispose());
    if (!viewer.isDestroyed()) viewer.destroy();
    throw error;
  }
}
