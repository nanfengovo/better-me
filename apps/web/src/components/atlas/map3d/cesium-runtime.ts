import * as C from "cesium";
import type { AtlasPrototypeProps } from "../prototypes/types";
import { loadBoundary } from "../prototypes/types";
import { ATLAS_BASEMAPS, attributionHtml } from "../prototypes/basemaps";
import { haversineDistanceMeters } from "../prototypes/user-location";
import { activeMapFocus } from "../map-focus";
import { createSceneReconciler, isSceneOffice, sceneDetailForZoom, type SceneDetail, type SceneMarker } from "./scene-model";
import { boundaryRings } from "./boundary-lines";
import { SCENE_QUALITY, describeSceneFailure, heightToZoom, validateSceneSource, zoomToHeight, type SceneFailure, type SceneQuality, type SceneSource, type SceneSurface, type SceneSurfaceStatus } from "./config";

export type NativeSceneCamera = { position: C.Cartesian3; heading: number; pitch: number; roll: number };
export type SceneStatus = { phase: "loading" | "ready" | "error"; rootRequests: number; failure?: SceneFailure; tiles?: { pending: number; processing: number; visible: boolean } };
export type SceneStats = { detail: SceneDetail; markers: number; coordinates: number; nearby: number; canScan: boolean };
export type CesiumAtlasHandle = { update: (props: AtlasPrototypeProps) => void; source: (source: SceneSource) => void; surface: (surface: SceneSurface) => void; quality: (quality: SceneQuality) => void; navigate: (action: "in" | "out" | "north" | "overhead" | "tilt") => void; fitBuckets: (ids: readonly string[]) => void; scanViewport: () => void; dispose: () => void };
type Callbacks = { status: (status: SceneStatus) => void; pick: (ids: string[]) => void; camera: (view: NativeSceneCamera) => void; stats?: (stats: SceneStats) => void; surfaceStatus?: (status: SceneSurfaceStatus) => void; initialCamera?: NativeSceneCamera };
const markerImage = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="13" fill="white" fill-opacity=".95"/><circle cx="16" cy="16" r="9" fill="white"/><circle cx="16" cy="16" r="3" fill="#123c32"/></svg>')}`;
const nearbyImage = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36"><path d="M18 2 34 18 18 34 2 18Z" fill="white" stroke="#f4e7be" stroke-width="2"/><path d="M12 24V12h12v12ZM16 15v3m4-3v3m-4 3v2m4-2v2" stroke="#4a391b" stroke-width="1.5" fill="none"/></svg>')}`;
const radarImage = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36"><circle cx="18" cy="18" r="15" stroke="#c3e8ff" stroke-width="2" fill="#307aa340"/><circle cx="18" cy="18" r="8" stroke="#c3e8ff" stroke-width="2" fill="#307aa3"/><circle cx="18" cy="18" r="2" fill="white"/></svg>')}`;
function validPosition(latitude: number, longitude: number) {
  return Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
}
function countMarkerImage(count: number) {
  const label = count > 999 ? "999+" : String(count);
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="29" fill="#163f38" fill-opacity=".94" stroke="#d2f4e9" stroke-width="3"/><circle cx="32" cy="32" r="24" fill="none" stroke="#77c3ae" stroke-opacity=".65" stroke-width="1.5"/><text x="32" y="34" dominant-baseline="middle" text-anchor="middle" font-family="Arial,sans-serif" font-weight="700" font-size="${label.length > 3 ? 19 : 24}" fill="white">${label}</text></svg>`)}`;
}

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
  const nearbyPoints = new Map<string, C.Billboard>();
  let props = initial, disposed = false, renderFailed = false, quality: SceneQuality = "balanced", moving = false;
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
  let tilesProgress: SceneStatus["tiles"];
  let surface: SceneSurface = "local";
  let streetLayer: C.ImageryLayer | undefined, streetCleanup: (() => void) | undefined, streetFailed = false;
  const nativeView = callbacks.initialCamera;
  let restored = Boolean(nativeView || initial.initialView);
  const requestRender = () => { if (!disposed) scene.requestRender(); };
  const status = (phase: SceneStatus["phase"], failure?: SceneFailure) => { if (!disposed && (!renderFailed || phase === "error")) callbacks.status({ phase, rootRequests, ...(failure ? { failure } : {}), ...(tilesProgress ? { tiles: { ...tilesProgress } } : {}) }); };

  function setSelected(id?: string) {
    if (pickedMarker && points.has(pickedMarker)) { points.get(pickedMarker)!.scale = 1; }
    if (id && points.has(id)) points.get(id)!.scale = 1.45;
    pickedMarker = id;
  }
  const reconcile = createSceneReconciler({
    upsert(marker: SceneMarker) {
      const counted = marker.coordinateCount > 1 || marker.jobCount > 1;
      const image = counted ? countMarkerImage(marker.jobCount) : markerImage;
      const size = counted ? 37 : 23;
      let point = points.get(marker.id);
      if (!point) {
        point = billboards.add({ id: { atlasMarker: marker.id }, image,
          position: C.Cartesian3.fromDegrees(marker.longitude, marker.latitude),
          heightReference: C.HeightReference.CLAMP_TO_GROUND, width: size, height: size,
          scaleByDistance: new C.NearFarScalar(150, 1.12, 24_000_000, .82),
          pixelOffset: new C.Cartesian2(0, -4), verticalOrigin: C.VerticalOrigin.BOTTOM,
        });
        points.set(marker.id, point);
      } else {
        point.position = C.Cartesian3.fromDegrees(marker.longitude, marker.latitude);
        point.image = image; point.width = size; point.height = size;
      }
      point.color = counted ? C.Color.WHITE : C.Color.fromCssColorString(marker.color);
    },
    remove(id) { const point = points.get(id); if (point) billboards.remove(point); points.delete(id); },
    select: setSelected, render: requestRender,
  });
  let markers = new Map<string, SceneMarker>();
  let detail: SceneDetail | undefined;
  let nearbyInput: AtlasPrototypeProps["nearbyCompanies"];
  let radarKey: string | undefined;
  let nearbySelection: string | undefined;
  let radarVisible = false, radarPoint: C.Billboard | undefined, canScan = false;
  let nearbyFocusId: string | undefined;
  let stats: SceneStats | undefined;
  function syncNearby() {
    const visible = detail === "exact" || (typeof detail === "number" && detail >= 10);
    const radarInput = props.radarCenter;
    const nextRadarKey = radarInput ? `${radarInput.longitude},${radarInput.latitude}` : undefined;
    if (visible === radarVisible && nearbyInput === props.nearbyCompanies && radarKey === nextRadarKey && nearbySelection === props.selectedNearbyCompanyId) return;
    radarVisible = visible; nearbyInput = props.nearbyCompanies; radarKey = nextRadarKey; nearbySelection = props.selectedNearbyCompanyId;
    const companies = visible ? (nearbyInput ?? []).filter(company => validPosition(company.latitude, company.longitude)) : [];
    const nextIds = new Set(companies.map(company => company.id));
    for (const [id, point] of nearbyPoints) if (!nextIds.has(id)) { billboards.remove(point); nearbyPoints.delete(id); }
    for (const company of companies) {
      let point = nearbyPoints.get(company.id);
      const position = C.Cartesian3.fromDegrees(company.longitude, company.latitude);
      if (!point) {
        point = billboards.add({ id: { atlasNearbyCompany: company.id }, image: nearbyImage, position,
          heightReference: C.HeightReference.CLAMP_TO_GROUND, width: 25, height: 25,
          verticalOrigin: C.VerticalOrigin.BOTTOM, pixelOffset: new C.Cartesian2(0, -3) });
        nearbyPoints.set(company.id, point);
      } else if (!C.Cartesian3.equals(point.position, position)) point.position = position;
      point.color = C.Color.fromCssColorString(/^#[a-f\d]{6}$/i.test(company.ownershipColor) ? company.ownershipColor : "#d5ad65");
      point.scale = company.id === nearbySelection ? 1.45 : 1;
    }
    if (visible && radarInput && validPosition(radarInput.latitude, radarInput.longitude)) {
      const position = C.Cartesian3.fromDegrees(radarInput.longitude, radarInput.latitude);
      if (!radarPoint) radarPoint = billboards.add({ image: radarImage, position, width: 29, height: 29, heightReference: C.HeightReference.CLAMP_TO_GROUND });
      else radarPoint.position = position;
    } else if (radarPoint) { billboards.remove(radarPoint); radarPoint = undefined; }
    requestRender();
  }
  function syncMarkers(zoom?: number) {
    const nextDetail = zoom === undefined && detail !== undefined ? detail : sceneDetailForZoom(zoom ?? projectedCamera().zoom, detail);
    const next = reconcile(props.buckets, props.selectedBucketId, nextDetail);
    const coordinates = next !== markers ? [...next.values()].reduce((sum, marker) => sum + marker.coordinateCount, 0) : stats?.coordinates ?? 0;
    markers = next; detail = nextDetail;
    const nextRadarKey = props.radarCenter ? `${props.radarCenter.longitude},${props.radarCenter.latitude}` : undefined;
    if (zoom !== undefined || !stats || radarKey !== nextRadarKey) {
      canScan = Boolean(scanTarget());
    }
    syncNearby();
    const current = { detail, markers: markers.size, coordinates, nearby: nearbyPoints.size, canScan };
    if (!stats || stats.detail !== current.detail || stats.markers !== current.markers || stats.coordinates !== current.coordinates || stats.nearby !== current.nearby || stats.canScan !== current.canScan) {
      stats = current; callbacks.stats?.(current);
    }
  }
  // SDK-bundled Natural Earth imagery is local and needs neither ion nor Google.
  // Avoid tessellating every country's filled polygon just to draw an overview.
  void C.TileMapServiceImageryProvider.fromUrl(C.buildModuleUrl("Assets/Textures/NaturalEarthII")).then(provider => {
    if (!disposed) { viewer.imageryLayers.addImageryProvider(provider, 0); requestRender(); }
  }).catch(() => { /* Local outline/point navigation remains usable if an overview image is absent. */ });

  function removeStreetLayer() {
    streetCleanup?.(); streetCleanup = undefined;
    if (streetLayer) viewer.imageryLayers.remove(streetLayer, true);
    streetLayer = undefined;
  }
  function updateSurface() {
    if (surface !== "streets" || currentSource.kind === "google" || props.basemap === null) {
      removeStreetLayer(); callbacks.surfaceStatus?.("local"); requestRender(); return;
    }
    if (streetFailed || streetLayer) return;
    const provider = props.basemap?.type === "raster" ? props.basemap : ATLAS_BASEMAPS.find(item => item.id === "osm-standard");
    if (!provider || provider.type !== "raster") return;
    // Use the existing licensed raster catalog. This layer is explicitly
    // enabled by the viewer and only requests the standard interactive tiles.
    const imagery = new C.UrlTemplateImageryProvider({
      url: provider.tiles[0]!, maximumLevel: provider.maxNativeZoom,
      tilingScheme: new C.WebMercatorTilingScheme(), credit: new C.Credit(attributionHtml(provider), true),
    });
    streetLayer = viewer.imageryLayers.addImageryProvider(imagery);
    streetCleanup = imagery.errorEvent.addEventListener(error => {
      if (disposed || !streetLayer) return;
      error.retry = false; streetFailed = true;
      removeStreetLayer(); callbacks.surfaceStatus?.("unavailable"); requestRender();
    });
    callbacks.surfaceStatus?.("streets"); requestRender();
  }
  function setSurface(next: SceneSurface) {
    if (next === surface) return;
    surface = next; streetFailed = false; updateSurface();
  }

  function centerTarget() {
    const center = new C.Cartesian2(element.clientWidth / 2, element.clientHeight / 2);
    const ray = camera.getPickRay(center);
    return (ray && scene.globe.pick(ray, scene)) || camera.pickEllipsoid(center);
  }
  function projectedCamera() {
    const carto = camera.positionCartographic;
    const target = centerTarget();
    const center = target ? C.Cartographic.fromCartesian(target) : carto;
    const longitude = C.Math.toDegrees(center.longitude), latitude = C.Math.toDegrees(center.latitude);
    const range = target ? C.Cartesian3.distance(camera.positionWC, target) : carto.height;
    return { center: [longitude, latitude] as [number, number], zoom: heightToZoom(range, latitude), pitch: 90 + C.Math.toDegrees(camera.pitch), bearing: C.Math.toDegrees(camera.heading) };
  }
  function scanTarget() {
    if (!props.onScanViewportArea) return;
    const target = centerTarget();
    if (!target) return;
    const center = C.Cartographic.fromCartesian(target);
    const longitude = C.Math.toDegrees(center.longitude), latitude = C.Math.toDegrees(center.latitude);
    const zoom = heightToZoom(C.Cartesian3.distance(camera.positionWC, target), latitude);
    if (!validPosition(latitude, longitude) || zoom < 10.8) return;
    const coordinates = { longitude, latitude };
    if (props.radarCenter && (haversineDistanceMeters(coordinates, props.radarCenter) ?? 999) <= (zoom >= 14 ? 260 : 600)) return;
    return coordinates;
  }
  function look(longitude: number, latitude: number, zoom: number, animate = false, bearing = 0, pitch = 25) {
    const target = C.Cartesian3.fromDegrees(longitude, latitude);
    const offset = new C.HeadingPitchRange(C.Math.toRadians(bearing), C.Math.toRadians(Math.min(80, Math.max(0, pitch)) - 90), zoomToHeight(zoom, latitude));
    if (animate && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) camera.flyToBoundingSphere(new C.BoundingSphere(target, 1), { offset, duration: .65 });
    else { camera.lookAt(target, offset); camera.lookAtTransform(C.Matrix4.IDENTITY); }
    requestRender();
  }
  if (nativeView) camera.setView({ destination: nativeView.position, orientation: nativeView });
  else if (initial.initialView) look(...initial.initialView.center, initial.initialView.zoom, false, initial.initialView.bearing, initial.initialView.pitch);
  else look(initial.mode === "domestic" ? 104 : 105, initial.mode === "domestic" ? 35 : 28, initial.mode === "domestic" ? 3.1 : 1.65);

  const input = new C.ScreenSpaceEventHandler(scene.canvas);
  cleanup.push(() => input.destroy());
  input.setInputAction((event: { position: C.Cartesian2 }) => {
    const hits = scene.drillPick(event.position, 20, 44, 44) as Array<{ id?: { atlasMarker?: string; atlasNearbyCompany?: string; properties?: C.PropertyBag; id?: string } }>;
    const closest = hits.find(hit => hit.id?.atlasMarker || hit.id?.atlasNearbyCompany);
    if (closest?.id?.atlasNearbyCompany) {
      const company = props.nearbyCompanies?.find(item => item.id === closest.id?.atlasNearbyCompany);
      if (company && nearbyPoints.has(company.id)) props.onSelectNearbyCompany?.(company);
      return;
    }
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
        const target = centerTarget();
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
  const drag = (event: PointerEvent) => { if (event.buttons) interacted(); };
  scene.canvas.addEventListener("pointermove", drag);
  scene.canvas.addEventListener("wheel", interacted, { passive: true });
  document.addEventListener("visibilitychange", syncRotation); motion?.addEventListener("change", syncRotation);
  cleanup.push(() => { rotationActive = false; cancelAnimationFrame(rotationFrame); document.removeEventListener("visibilitychange", syncRotation); motion?.removeEventListener("change", syncRotation); scene.canvas.removeEventListener("pointerdown", interacted); scene.canvas.removeEventListener("pointermove", drag); scene.canvas.removeEventListener("wheel", interacted); });
  cleanup.push(camera.moveStart.addEventListener(() => {
    if (!disposed && !moving) { moving = true; applyQuality(); }
  }));
  const moveEnd = camera.moveEnd.addEventListener(() => {
    if (disposed) return;
    if (moving) { moving = false; applyQuality(); }
    callbacks.camera({ position: C.Cartesian3.clone(camera.positionWC), heading: camera.heading, pitch: camera.pitch, roll: camera.roll });
    const rectangle = camera.computeViewRectangle();
    const view = projectedCamera();
    syncMarkers(view.zoom);
    props.onViewChange?.({ ...view,
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
    const oldBasemap = props.basemap;
    props = next;
    if (oldBasemap?.id !== next.basemap?.id || (oldBasemap === null) !== (next.basemap === null)) {
      removeStreetLayer(); streetFailed = false; updateSurface();
    }
    let cameraChanged = false;
    syncRotation();
    if (resetRevision !== next.resetRevision) { resetRevision = next.resetRevision; hasFramed = false; framed = undefined; restored = false; focusId = undefined; if (!next.bounds) { look(next.mode === "domestic" ? 104 : 105, next.mode === "domestic" ? 35 : 28, next.mode === "domestic" ? 3.1 : 1.65); cameraChanged = true; } }
    void localBoundary(next.mode); void updateHighlight(next.adminBoundary);
    if (lastTheme !== next.visual?.theme) {
      lastTheme = next.visual?.theme;
      scene.backgroundColor = C.Color.fromCssColorString(lastTheme === "light" ? "#dae5e4" : "#101e29"); requestRender();
    }
    const focus = activeMapFocus(next.focus, next.selectedJobId);
    const identity = focus ? `${focus.requestId ?? ""}:${focus.jobId ?? ""}:${focus.longitude}:${focus.latitude}:${focus.zoom}` : undefined;
    if (focus && identity !== focusId) { focusId = identity; restored = false; hasFramed = true; framed = next.framingKey; look(focus.longitude, focus.latitude, focus.zoom ?? 14, next.visual?.animateViewChange); cameraChanged = true; }
    else if (!focus) focusId = undefined;
    if (!focus && next.bounds && (!hasFramed || next.framingKey !== framed)) {
      hasFramed = true; framed = next.framingKey;
      if (restored) { restored = false; syncMarkers(); return; }
      const [west, south, east, north] = next.bounds;
      if ([west, south, east, north].every(Number.isFinite) && east > west && north > south) {
        const rectangle = C.Rectangle.fromDegrees(west, south, east, north);
        const fitted = camera.getRectangleCameraCoordinates(rectangle);
        if (fitted) {
          const location = C.Cartographic.fromCartesian(fitted);
          location.height = Math.max(location.height, zoomToHeight(next.boundsMaxZoom ?? 22, C.Math.toDegrees(location.latitude)));
          camera.setView({ destination: C.Cartographic.toCartesian(location), orientation: {heading:0,pitch:-C.Math.PI_OVER_TWO,roll:0} });
          cameraChanged = true;
        }
        requestRender();
      }
    }
    const nearbyFocus = next.focusNearbyCompany;
    if (nearbyFocus && nearbyFocus.requestId !== nearbyFocusId && validPosition(nearbyFocus.latitude, nearbyFocus.longitude)) {
      nearbyFocusId = nearbyFocus.requestId; hasFramed = true; framed = next.framingKey;
      look(nearbyFocus.longitude, nearbyFocus.latitude, 16, next.visual?.animateViewChange); cameraChanged = true;
    } else if (!nearbyFocus) nearbyFocusId = undefined;
    syncMarkers(cameraChanged ? projectedCamera().zoom : undefined);
  }
  function applyQuality() {
    const profile = SCENE_QUALITY[quality];
    const nativeDpr = window.devicePixelRatio || 1;
    const dpr = Math.min(nativeDpr, moving ? Math.min(1.25, profile.maxDpr) : profile.maxDpr);
    viewer.useBrowserRecommendedResolution = false;
    if (viewer.resolutionScale !== dpr / nativeDpr) viewer.resolutionScale = dpr / nativeDpr;
    if (tileset) {
      tileset.maximumScreenSpaceError = profile.maximumScreenSpaceError * (moving ? 1.5 : 1);
      tileset.cacheBytes = profile.cacheBytes;
      tileset.maximumCacheOverflowBytes = profile.maximumCacheOverflowBytes;
    }
    requestRender();
  }
  function setQuality(next: SceneQuality) { quality = next; applyQuality(); }
  function setSource(raw: SceneSource) {
    if (disposed) return;
    const source = validateSceneSource(raw);
    if (JSON.stringify(source) === JSON.stringify(currentSource)) return;
    currentSource = source; const generation = ++sourceGeneration;
    updateSurface();
    sourceCleanup?.(); sourceCleanup = undefined;
    if (tileset) scene.primitives.remove(tileset); tileset = undefined;
    if (customCredit) viewer.creditDisplay.removeStaticCredit(customCredit); customCredit = undefined;
    tilesProgress = undefined;
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
      tileset = loaded; scene.primitives.add(loaded);
      tilesProgress = { pending: 0, processing: 0, visible: false };
      if (source.kind === "tileset") { customCredit = new C.Credit(source.attribution.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!), true); viewer.creditDisplay.addStaticCredit(customCredit); }
      let failure: SceneFailure | undefined;
      const active = () => !disposed && generation === sourceGeneration;
      const reportTiles = () => status(failure ? "error" : "ready", failure);
      const failed = loaded.tileFailed.addEventListener((error: unknown) => {
        if (!active()) return;
        failure = describeSceneFailure(error);
        scene.globe.show = true;
        reportTiles(); requestRender();
      });
      const progress = loaded.loadProgress.addEventListener((pending: number, processing: number) => {
        if (!active() || !tilesProgress || (pending === tilesProgress.pending && processing === tilesProgress.processing)) return;
        tilesProgress = { ...tilesProgress, pending, processing }; reportTiles();
      });
      const visible = loaded.tileVisible.addEventListener(() => {
        if (!active() || !tilesProgress || tilesProgress.visible) return;
        tilesProgress = { ...tilesProgress, visible: true };
        // Keep the ellipsoid as context for local/regional datasets. Google's
        // world mesh replaces it only after the renderer has observed a tile.
        if (source.kind === "google" && !failure) scene.globe.show = false;
        reportTiles(); requestRender();
      });
      sourceCleanup = () => { failed(); progress(); visible(); };
      setQuality(quality); status("ready"); requestRender();
    }).catch(error => { clearTimeout(timer); if (!disposed && generation === sourceGeneration) { scene.globe.show = true; status("error", describeSceneFailure(error)); requestRender(); } });
  }
  setQuality(quality); update(initial); status("ready"); callbacks.surfaceStatus?.("local"); initial.onReady?.();
  return { update, source: setSource, surface: setSurface, quality: setQuality, scanViewport() {
    if (disposed) return;
    const target = scanTarget();
    if (target) props.onScanViewportArea?.(target);
  }, fitBuckets(ids) {
    if (disposed || !ids.length) return;
    const requested = new Set(ids);
    const coordinates = props.buckets.filter(bucket => requested.has(bucket.id) && isSceneOffice(bucket));
    if (!coordinates.length) return;
    interacted();
    if (coordinates.every(bucket => bucket.longitude === coordinates[0]!.longitude && bucket.latitude === coordinates[0]!.latitude)) {
      look(coordinates[0]!.longitude, coordinates[0]!.latitude, 16, props.visual?.animateViewChange);
      return;
    }
    const rectangle = C.Rectangle.fromCartographicArray(coordinates.map(bucket => C.Cartographic.fromDegrees(bucket.longitude, bucket.latitude)));
    const fitted = camera.getRectangleCameraCoordinates(rectangle);
    if (fitted) {
      const location = C.Cartographic.fromCartesian(fitted);
      location.height = Math.max(location.height, zoomToHeight(17, C.Math.toDegrees(location.latitude)));
      camera.setView({ destination: C.Cartographic.toCartesian(location), orientation: {heading:0,pitch:-C.Math.PI_OVER_TWO,roll:0} });
      requestRender();
    }
  }, navigate(action) {
    if (disposed) return;
    interacted();
    if (action === "in") camera.zoomIn(Math.max(20, camera.positionCartographic.height * .4));
    else if (action === "out") camera.zoomOut(Math.max(20, camera.positionCartographic.height * .6));
    else {
      const heading = action === "north" ? 0 : camera.heading;
      const pitch = action === "overhead" ? -C.Math.PI_OVER_TWO : action === "tilt" ? C.Math.toRadians(-45) : camera.pitch;
      const target = centerTarget();
      if (target) {
        camera.lookAt(target, new C.HeadingPitchRange(heading, pitch, C.Cartesian3.distance(camera.positionWC, target)));
        camera.lookAtTransform(C.Matrix4.IDENTITY);
      } else camera.setView({ orientation: { heading, pitch, roll: 0 } });
    }
    requestRender();
  }, dispose() {
    if (disposed) return;
    callbacks.camera({ position: C.Cartesian3.clone(camera.positionWC), heading: camera.heading, pitch: camera.pitch, roll: camera.roll });
    disposed = true; sourceGeneration++; highlightGeneration++; boundaryAbort?.abort(); sourceCleanup?.();
    removeStreetLayer();
    cleanup.reverse().forEach(dispose => dispose()); viewer.destroy();
  } };
  } catch (error) {
    cleanup.reverse().forEach(dispose => dispose());
    if (!viewer.isDestroyed()) viewer.destroy();
    throw error;
  }
}
