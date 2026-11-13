import * as C from "cesium";
import { SCENE_QUALITY, describeSceneFailure } from "../../components/atlas/map3d/config";
import { constellationArc, skillConstellationFingerprint, type SkillConstellationModel } from "./model";
import type { SkillConstellationSceneFactory, SkillConstellationSceneHandle } from "./types";

let sceneSequence = 0;

/** Same installed Cesium/runtime assets as Job Atlas. No ion/Google credentials,
 * external imagery, city geocoding or model calls. A shared Viewer keeps its
 * owner's configuration and is never destroyed by this overlay. */
export const createSkillConstellationScene: SkillConstellationSceneFactory = async (host, initial, callbacks, options) => {
  options.signal.throwIfAborted();
  if (!options.isCurrent() || initial.status !== "ready") throw new Error("授权版本已变化或没有可上图连线。");
  const shared = options.sharedViewer;
  if (shared?.isDestroyed()) throw new Error("WebGL shared viewer is unavailable");
  const bounds = (shared?.scene.canvas ?? host).getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) throw new Error("WebGL host has no observable dimensions");
  const viewer = shared ?? new C.Viewer(host, {
    baseLayer: false, terrainProvider: new C.EllipsoidTerrainProvider(), baseLayerPicker: false,
    geocoder: false, homeButton: false, sceneModePicker: false, navigationHelpButton: false,
    fullscreenButton: false, animation: false, timeline: false, infoBox: false, selectionIndicator: false,
    scene3DOnly: true, requestRenderMode: true, maximumRenderTimeChange: Infinity,
    shouldAnimate: false, shadows: false, skyBox: false, showRenderLoopErrors: false,
  });
  const { scene, camera } = viewer, prefix = `betterme-constellation-${++sceneSequence}`;
  const cleanup: Array<() => void> = [];
  const overlay = new C.CustomDataSource(prefix);
  let disposed = false, failed = false, observedFrame = false, model = initial, selected: string | undefined;
  let modelKey = "", dataAttached = false;
  const entityJobs = new Map<string, string>();
  let badgeEntityId = "";
  const active = () => !disposed && !options.signal.aborted && !viewer.isDestroyed() && options.isCurrent();
  const render = () => { if (active() && !failed) scene.requestRender(); };
  const status = (phase: "loading" | "ready" | "error", error?: unknown) => {
    if (active()) callbacks.status({ phase, renderedFrame: observedFrame, ...(error ? { failure: describeSceneFailure(error) } : {}) });
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const remove of cleanup.splice(0).reverse()) { try { remove(); } catch { /* Best effort; still release remaining owned resources. */ } }
    if (!viewer.isDestroyed()) {
      if (dataAttached) viewer.dataSources.remove(overlay, true);
      if (!shared) viewer.destroy();
      else scene.requestRender();
    }
    entityJobs.clear();
  };
  try {
    if (!shared) {
      scene.globe.baseColor = C.Color.fromCssColorString("#173e42"); scene.globe.enableLighting = false;
      scene.backgroundColor = C.Color.fromCssColorString("#101e29");
      scene.screenSpaceCameraController.minimumZoomDistance = 100;
      scene.screenSpaceCameraController.maximumZoomDistance = 40_000_000;
      viewer.resolutionScale = Math.min(window.devicePixelRatio || 1, SCENE_QUALITY.balanced.maxDpr) / (window.devicePixelRatio || 1);
      viewer.useBrowserRecommendedResolution = false;
      viewer.creditDisplay.addStaticCredit(new C.Credit("BetterMe · 技能证据交集 · 虚拟节点不是地理地址", true));
      // This is the SDK-bundled, local Natural Earth asset, not a network map
      // provider. Losing it never fabricates positions or removes the DOM list.
      void C.TileMapServiceImageryProvider.fromUrl(C.buildModuleUrl("Assets/Textures/NaturalEarthII")).then(provider => {
        if (active()) { viewer.imageryLayers.addImageryProvider(provider); render(); }
      }).catch(() => { /* An untextured ellipsoid still truthfully locates supplied offices. */ });
    }
    status("loading");
    const abort = () => dispose(); options.signal.addEventListener("abort", abort, { once: true });
    cleanup.push(() => options.signal.removeEventListener("abort", abort));
    await viewer.dataSources.add(overlay); dataAttached = true;
    if (!active()) {
      // An aborted shared-viewer add may settle after dispose() already ran.
      if (!viewer.isDestroyed()) viewer.dataSources.remove(overlay, true);
      dispose(); throw new Error("场景初始化已取消或授权版本已变化。");
    }
    const fail = (error: unknown) => { if (!active() || failed) return; failed = true; status("error", error); };
    const lost = (event: Event) => { event.preventDefault(); fail(new Error("WebGL context lost")); };
    scene.canvas.addEventListener("webglcontextlost", lost); cleanup.push(() => scene.canvas.removeEventListener("webglcontextlost", lost));
    cleanup.push(scene.renderError.addEventListener((_scene: C.Scene, error: unknown) => fail(error)));
    cleanup.push(scene.postRender.addEventListener(() => {
      if (!active() || failed || observedFrame) return;
      observedFrame = true; clearTimeout(frameDeadline); status("ready");
    }));
    const frameDeadline = setTimeout(() => fail(new Error("WebGL first rendered frame timeout")), 8000);
    cleanup.push(() => clearTimeout(frameDeadline));
    const picker = new C.ScreenSpaceEventHandler(scene.canvas); cleanup.push(() => { if (!picker.isDestroyed()) picker.destroy(); });
    picker.setInputAction((event: { position: C.Cartesian2 }) => {
      if (!active() || failed) return;
      const hits = scene.drillPick(event.position, 80, 32, 32) as Array<{ id?: C.Entity }>;
      const ids = [...new Set(hits.flatMap(hit => hit.id?.id && entityJobs.has(hit.id.id) ? [entityJobs.get(hit.id.id)!] : []))];
      if (ids.length) callbacks.pick(ids);
      else if (hits.some(hit => hit.id?.id === badgeEntityId)) callbacks.inspectBadge();
    }, C.ScreenSpaceEventType.LEFT_CLICK);
    const resize = () => { if (active()) { if (!shared) viewer.resize(); render(); } };
    if (typeof ResizeObserver !== "undefined") { const observer = new ResizeObserver(resize); observer.observe(shared?.container ?? host); cleanup.push(() => observer.disconnect()); }
    else { window.addEventListener("resize", resize); cleanup.push(() => window.removeEventListener("resize", resize)); }

    function point(vector: readonly [number, number, number]): C.Cartesian3 {
      const radius = Math.hypot(...vector), longitude = Math.atan2(vector[1], vector[0]) * 180 / Math.PI;
      const latitude = Math.asin(Math.max(-1, Math.min(1, vector[2] / radius))) * 180 / Math.PI;
      return C.Cartesian3.fromDegrees(longitude, latitude, (radius - 1) * C.Ellipsoid.WGS84.maximumRadius);
    }
    function reset() {
      if (!active() || failed) return;
      const vector = model.virtualNode.position, radius = Math.hypot(...vector);
      const longitude = Math.atan2(vector[1], vector[0]) * 180 / Math.PI, latitude = Math.asin(vector[2] / radius) * 180 / Math.PI;
      camera.setView({ destination: C.Cartesian3.fromDegrees(longitude, latitude, C.Ellipsoid.WGS84.maximumRadius * 2.9), orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 } }); render();
    }
    function update(next: SkillConstellationModel, selectedJobId?: string) {
      if (!active() || failed || next.status === "invalid") return;
      const fingerprint = skillConstellationFingerprint(next);
      if (modelKey === fingerprint && selected === selectedJobId) return;
      model = next; modelKey = fingerprint; selected = selectedJobId;
      overlay.entities.suspendEvents();
      try {
        overlay.entities.removeAll(); entityJobs.clear();
        badgeEntityId = `${prefix}-virtual-badge`;
        overlay.entities.add({ id: badgeEntityId, position: point(next.virtualNode.position),
          point: { pixelSize: 21, color: C.Color.fromCssColorString("#98e2cb"), outlineColor: C.Color.fromCssColorString("#153d37"), outlineWidth: 3 },
          label: { text: "技能证据 · 虚拟节点", font: "13px system-ui", fillColor: C.Color.WHITE, showBackground: true,
            backgroundColor: C.Color.fromCssColorString("#17362e"), pixelOffset: new C.Cartesian2(0, -28), verticalOrigin: C.VerticalOrigin.BOTTOM },
        });
        next.entries.forEach((entry, index) => {
          const selected = entry.jobId === selectedJobId, color = C.Color.fromCssColorString(selected ? "#fff1b8" : "#92d7c3");
          const jobId = `${prefix}-office-${index}`, arcId = `${prefix}-arc-${index}`;
          const path = constellationArc(entry, next.virtualNode).map(point);
          // Exact source office endpoint, never the spherical approximation used
          // by the intermediate presentation path.
          path[path.length - 1] = C.Cartesian3.fromDegrees(entry.longitude, entry.latitude);
          entityJobs.set(jobId, entry.jobId); entityJobs.set(arcId, entry.jobId);
          overlay.entities.add({ id: jobId, position: C.Cartesian3.fromDegrees(entry.longitude, entry.latitude),
            point: { pixelSize: selected ? 13 : 7, color, outlineColor: C.Color.fromCssColorString("#173e42"), outlineWidth: 2 },
            label: { show: selected, text: entry.label.slice(0, 36), font: "13px system-ui", fillColor: C.Color.WHITE, showBackground: true,
              backgroundColor: C.Color.fromCssColorString("#17362e"), pixelOffset: new C.Cartesian2(0, -16), verticalOrigin: C.VerticalOrigin.BOTTOM },
          });
          overlay.entities.add({ id: arcId, polyline: { positions: path, arcType: C.ArcType.NONE, width: selected ? 4 : 1 + entry.strength * 2.5,
            material: color.withAlpha(selected ? .95 : .55) } });
        });
      } finally { overlay.entities.resumeEvents(); }
      render();
    }
    const handle: SkillConstellationSceneHandle = {
      update,
      focus(jobId) {
        if (!active() || failed) return;
        const entry = model.entries.find(item => item.jobId === jobId); if (!entry) return;
        const target = C.Cartesian3.fromDegrees(entry.longitude, entry.latitude);
        camera.lookAt(target, new C.HeadingPitchRange(0, C.Math.toRadians(-65), 180_000)); camera.lookAtTransform(C.Matrix4.IDENTITY); render();
      },
      navigate(action) {
        if (!active() || failed) return;
        if (action === "reset") { reset(); return; }
        const height = Math.max(100, camera.positionCartographic.height);
        if (action === "in") camera.zoomIn(Math.max(0, Math.min(height * .35, height - 100)));
        else camera.zoomOut(Math.min(10_000_000, Math.max(200, height * .5)));
        render();
      },
      dispose,
    };
    update(initial);
    if (!shared) reset();
    return handle;
  } catch (error) { dispose(); throw error; }
};
