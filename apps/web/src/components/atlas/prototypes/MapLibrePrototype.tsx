import { useEffect, useRef, useState } from "react";
import { AttributionControl, Map, Marker, NavigationControl, ScaleControl, setWorkerUrl, type GeoJSONSource, type LayerSpecification, type SourceSpecification, type StyleSpecification } from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import "maplibre-gl/dist/maplibre-gl.css";
import "../map-focus.css";
import { activeMapFocus, createMapFocusMarker, mapFocusCameraOptions, mapFocusPrecisionLabel } from "../map-focus";
import { ATLAS_BASEMAPS, attributionHtml, DEFAULT_ATLAS_BASEMAP, parseAtlasBasemap } from "./basemaps";
import { canvasHostStyle, CHINA_BOUNDS, creditStyle, errorStyle, loadBoundary, NATURAL_EARTH_CREDIT, prototypeFrameStyle, regionSelection, type AtlasPrototypeProps, type BoundaryFeature, type PrototypeHandle } from "./types";
import { atlasBucketData, createAtlasHover, createAtlasMapUpdates } from "./map-performance";

// Vite's optimized module URL does not preserve the upstream worker's sibling path.
setWorkerUrl(maplibreWorkerUrl);

function featureBounds(feature: BoundaryFeature): [number, number, number, number] {
  const positions = feature.geometry.type === "Polygon" ? feature.geometry.coordinates.flat() : feature.geometry.coordinates.flat(2);
  const longitudes = [...new Set(positions.map((point) => (point[0] + 360) % 360))].sort((a, b) => a - b);
  let start = 0; let largestGap = -1;
  longitudes.forEach((longitude, index) => { const gap = (longitudes[(index + 1) % longitudes.length]! + (index === longitudes.length - 1 ? 360 : 0)) - longitude; if (gap > largestGap) { largestGap = gap; start = (index + 1) % longitudes.length; } });
  const west = longitudes[start]!; const east = west + 360 - largestGap;
  return [west > 180 ? west - 360 : west, Math.min(...positions.map((point) => point[1])), east > 180 && west > 180 ? east - 360 : east, Math.max(...positions.map((point) => point[1]))];
}

/** One continuous WGS84 camera: dotted globe → countries → vector streets/buildings. */
export function MapLibrePrototype(props: AtlasPrototypeProps) {
  const host = useRef<HTMLDivElement>(null); const latest = useRef(props); latest.current = props;
  const handle = useRef<PrototypeHandle | null>(null);
  const [failure, setFailure] = useState<string | null>(null); const [basemapWarning, setBasemapWarning] = useState("");
  const mode = props.mode; const light = props.visual?.theme === "light";
  const background = props.visual?.background ?? (light ? "#f5f6f4" : "#080f18");
  const maxDpr = Math.min(1.7, Math.max(1, props.visual?.maxDpr ?? 1.7));
  const entrance = props.visual?.entrance !== false;
  const basemap = props.basemap === null ? null : parseAtlasBasemap(props.basemap ?? (light ? ATLAS_BASEMAPS.find((item) => item.id === "openfreemap-positron") : DEFAULT_ATLAS_BASEMAP));
  const basemapKey = JSON.stringify(basemap);
  useEffect(() => {
    const element = host.current; if (!element) return;
    const openingFocus = latest.current.focus;
    const provider = basemapKey === "null" ? null : parseAtlasBasemap(JSON.parse(basemapKey));
    let stopped = false; let map: Map | undefined; let observer: ResizeObserver | undefined; let rotationFrame = 0;
    let rotationResume: ReturnType<typeof setTimeout> | undefined, interacting = false; let cancelHover = () => {};
    let focusMarker: Marker | undefined; let markerSignature = "";
    const abort = new AbortController(); const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const report = (error: unknown) => { if (stopped || abort.signal.aborted) return; setFailure("三维地图暂不可用，仍可通过岗位列表浏览与选择。"); latest.current.onError?.(error instanceof Error ? error : new Error("Map renderer unavailable.")); };
    const warnTiles = () => { if (!stopped) setBasemapWarning("在线底图未完整加载，概略轮廓和岗位列表仍可使用。可切换底图或稍后重试。"); };
    const stopRotation = () => { if (rotationFrame) cancelAnimationFrame(rotationFrame); rotationFrame = 0; };
    const rotate = () => {
      stopRotation(); if (!map || stopped || interacting || document.hidden || motion.matches || latest.current.visual?.autoRotate !== true || mode !== "global" || map.getZoom() >= 3.5 || map.isMoving()) return;
      let previous = performance.now();
      const tick = (now: number) => { if (stopped || interacting || document.hidden || motion.matches || latest.current.visual?.autoRotate !== true || !map || map.getZoom() >= 3.5 || map.isMoving()) { rotationFrame = 0; return; } map.setCenter([map.getCenter().lng + Math.min(50, now - previous) * .0016, map.getCenter().lat]); previous = now; rotationFrame = requestAnimationFrame(tick); };
      rotationFrame = requestAnimationFrame(tick);
    };
    const visibility = () => { if (document.hidden) { stopRotation(); map?.stop(); } else rotate(); };
    const motionChange = () => { if (motion.matches) map?.stop(); rotate(); };
    document.addEventListener("visibilitychange", visibility); motion.addEventListener("change", motionChange); setFailure(null); setBasemapWarning("");
    void (async () => {
      const boundary = await loadBoundary(mode, abort.signal);
      const initialBuckets = latest.current.buckets, initialBucketData = atlasBucketData(initialBuckets);
      const sources: Record<string, SourceSpecification> = { boundaries: { type: "geojson", data: boundary }, buckets: { type: "geojson", data: initialBucketData } };
      const remoteLayers: LayerSpecification[] = []; let remote: Partial<StyleSpecification> = {};
      if (provider?.type === "vector-style") {
        try {
          const response = await fetch(provider.styleUrl, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(8000)]), credentials: "omit" });
          if (!response.ok) throw new Error("Basemap style unavailable.");
          const style = await response.json() as StyleSpecification;
          if (style.version !== 8 || !style.sources || !Array.isArray(style.layers)) throw new Error("Invalid vector style.");
          remote = { ...(style.glyphs ? { glyphs: style.glyphs } : {}), ...(style.sprite ? { sprite: style.sprite } : {}) };
          Object.entries(style.sources).forEach(([id, source]) => { sources[`basemap:${id}`] = source; });
          style.layers.forEach((layer) => { if (layer.type !== "background") remoteLayers.push({ ...layer, id: `basemap:${layer.id}`, minzoom: Math.max(layer.minzoom ?? 0, mode === "global" ? 2.4 : 0), ...("source" in layer ? { source: `basemap:${layer.source}` } : {}) } as LayerSpecification); });
        } catch (error) { if (abort.signal.aborted) throw error; warnTiles(); }
      } else if (provider?.type === "raster") {
        sources["basemap:raster"] = { type: "raster", tiles: provider.tiles, tileSize: provider.tileSize, maxzoom: provider.maxNativeZoom, attribution: attributionHtml(provider) };
        remoteLayers.push({ id: "basemap:raster", type: "raster", source: "basemap:raster", minzoom: mode === "global" ? 2.4 : 0, paint: { "raster-fade-duration": 180 } });
      }
      if (mode === "global") { const dots = await import("../geo/world-land-dots.geojson?url"); sources["land-dots"] = { type: "geojson", data: dots.default }; }
      if (stopped) return;
      const layers: LayerSpecification[] = [
        { id: "ocean", type: "background", paint: { "background-color": background } },
        { id: "overview-land", type: "fill", source: "boundaries", ...(remoteLayers.length ? { maxzoom: 7 } : {}), paint: { "fill-color": mode === "global" ? light ? "#b7c1c0" : "#527184" : light ? "#b8cace" : "#173a50", "fill-opacity": mode === "global" ? .15 : .85 } },
        ...remoteLayers,
        ...(mode === "global" ? [{ id: "land-dots", type: "circle" as const, source: "land-dots", maxzoom: 3.7, paint: { "circle-color": light ? "#455459" : "#bed6e0", "circle-radius": ["interpolate", ["linear"], ["zoom"], 0, .65, 3, 1.15], "circle-opacity": ["interpolate", ["linear"], ["zoom"], 0, .8, 2.7, .8, 3.6, 0], "circle-pitch-alignment": "map" } } as LayerSpecification] : []),
        ...(mode === "global" ? [{ id: "regions", type: "fill" as const, source: "boundaries", paint: { "fill-color": light ? "#769696" : "#6b9aad", "fill-opacity": ["interpolate", ["linear"], ["zoom"], 0, .03, 3, .06, 6, 0] } } as LayerSpecification] : [
          { id: "regions", type: "fill-extrusion" as const, source: "boundaries", maxzoom: 6.6, paint: { "fill-extrusion-color": light ? "#829fa8" : "#153f57", "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 3, 24_000, 4.5, 24_000, 6.5, 0], "fill-extrusion-base": 0, "fill-extrusion-opacity": ["interpolate", ["linear"], ["zoom"], 3, .9, 4.5, .85, 6.5, 0], "fill-extrusion-vertical-gradient": true } } as LayerSpecification,
        ]),
        { id: "boundaries", type: "line", source: "boundaries", maxzoom: 7, paint: { "line-color": light ? "#497885" : "#7ec2d0", "line-width": mode === "global" ? .45 : .85, "line-opacity": ["interpolate", ["linear"], ["zoom"], 0, mode === "global" ? .15 : .8, 4.5, mode === "global" ? .25 : .65, 6.5, 0] } },
        { id: "bucket-glow", type: "circle", source: "buckets", filter: ["==", ["get", "kind"], "core"], paint: { "circle-radius": ["+", ["get", "radius"], 7], "circle-color": ["get", "color"], "circle-blur": .8, "circle-opacity": light ? .22 : .35 } },
        { id: "bucket-selection", type: "circle", source: "buckets", filter: ["all", ["==", ["get", "kind"], "core"], ["==", ["get", "bucketId"], ""]], paint: { "circle-radius": ["+", ["get", "radius"], 8], "circle-color": light ? "#215b55" : "#d3ffed", "circle-opacity": .10, "circle-stroke-color": light ? "#215b55" : "#d3ffed", "circle-stroke-width": 1.4 } },
        { id: "bucket-rings", type: "circle", source: "buckets", filter: ["==", ["get", "kind"], "category"], paint: { "circle-radius": ["get", "radius"], "circle-color": "#ffffff", "circle-opacity": 0, "circle-stroke-color": ["get", "color"], "circle-stroke-width": 1.6, "circle-stroke-opacity": .96, "circle-pitch-alignment": "viewport" } },
        { id: "bucket-cores", type: "circle", source: "buckets", filter: ["==", ["get", "kind"], "core"], paint: { "circle-radius": ["get", "radius"], "circle-color": ["get", "color"], "circle-stroke-color": light ? "#ffffff" : "#d4f4ec", "circle-stroke-width": .65, "circle-opacity": .96 } },
        ...(remote.glyphs ? [{ id: "bucket-labels", type: "symbol" as const, source: "buckets", filter: ["all", ["==", ["get", "kind"], "core"], ["==", ["get", "labelVisible"], true]], layout: { "text-field": ["get", "label"], "text-size": 11, "text-font": ["Noto Sans Regular"], "text-offset": [0, 1.9], "text-anchor": "top", "text-padding": 6, "text-max-width": 16 }, paint: { "text-color": light ? "#263d42" : "#d9eaf0", "text-halo-color": background, "text-halo-width": 2 } } as LayerSpecification] : []),
      ];
      const savedView = latest.current.initialView;
      map = new Map({ container: element, center: mode === "global" ? [104, 26] : [104, 35], zoom: mode === "global" ? 1.65 : 3.1, pitch: mode === "domestic" ? 46 : 0, bearing: mode === "domestic" ? -12 : 0, ...savedView,
        maxZoom: provider?.maxZoom ?? 22, minZoom: .1, maxPitch: 75, pixelRatio: Math.min(window.devicePixelRatio || 1, maxDpr), attributionControl: false, cancelPendingTileRequestsWhileZooming: true,
        style: { version: 8, ...remote, sources, layers } });
      const ownedMap = map;
      ownedMap.addControl(new NavigationControl({ visualizePitch: true }), "top-right"); ownedMap.addControl(new ScaleControl({ maxWidth: 100, unit: "metric" }), "bottom-left");
      if (provider) ownedMap.addControl(new AttributionControl({ compact: false, customAttribution: attributionHtml(provider) }), "bottom-right");
      const lost = (event: Event) => { event.preventDefault(); stopRotation(); report(new Error("MapLibre WebGL context lost.")); };
      const restored = () => { if (!stopped) { setFailure(null); ownedMap.triggerRepaint(); rotate(); } };
      ownedMap.getCanvas().addEventListener("webglcontextlost", lost); ownedMap.getCanvas().addEventListener("webglcontextrestored", restored);
      ownedMap.on("error", (event) => { if ((event as { sourceId?: string }).sourceId?.startsWith("basemap:") || /(?:tile|glyph|sprite|fetch|network|status|AJAX|HTTP)/i.test(event.error.message)) warnTiles(); else report(event.error); });
      const viewChanged = () => { if (rotationFrame && ownedMap.getZoom() < 3.5) return; const center = ownedMap.getCenter(); const bounds = ownedMap.getBounds(); latest.current.onViewChange?.({ zoom: ownedMap.getZoom(), center: [center.lng, center.lat], pitch: ownedMap.getPitch(), bearing: ownedMap.getBearing(), bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()] }); };
      ownedMap.on("moveend", viewChanged);
      ownedMap.on("load", () => {
        if (stopped) return;
        ownedMap.setProjection({ type: mode === "global" ? "globe" : "mercator" });
        ownedMap.setSky({ "sky-color": background, "horizon-color": light ? "#d5deda" : "#2b526d", "fog-color": light ? "#eef0ee" : "#080f18", "atmosphere-blend": mode === "global" ? .90 : 0 });
        ownedMap.setLight({ anchor: "viewport", color: light ? "#ffffff" : "#b9e7f1", intensity: .62, position: [1.5, 190, 45] });
        const fit = (bounds = latest.current.bounds) => { const target = bounds ?? (mode === "domestic" ? CHINA_BOUNDS : undefined); if (target) ownedMap.fitBounds([[target[0], target[1]], [target[2], target[3]]], { padding: { top: 62, bottom: 72, left: 42, right: 48 }, duration: motion.matches || !entrance ? 0 : 900, maxZoom: 16, pitch: mode === "domestic" ? 46 : 0, bearing: mode === "domestic" ? -12 : 0 }); };
        const focus = (target: NonNullable<AtlasPrototypeProps["focus"]>) => { const options = mapFocusCameraOptions(target, provider?.maxZoom ?? 22, motion.matches); if (!options) return; stopRotation(); ownedMap.stop(); ownedMap.flyTo(options); };
        const highlight = (current: AtlasPrototypeProps) => {
          const target = activeMapFocus(current.focus, current.selectedJobId);
          const signature = target ? JSON.stringify(target) : "";
          if (signature === markerSignature) return;
          focusMarker?.remove(); focusMarker = undefined; markerSignature = signature;
          if (target) focusMarker = new Marker({ element: createMapFocusMarker(document, target, light), anchor: "center", pitchAlignment: "viewport", rotationAlignment: "viewport" })
            .setLngLat([target.longitude, target.latitude]).addTo(ownedMap);
        };
        const updateFacts = createAtlasMapUpdates(initialBuckets, initialBucketData, {
          buckets: data => (ownedMap.getSource("buckets") as GeoJSONSource).setData(data),
          bucketSelection: id => {
            ownedMap.setFilter("bucket-selection", ["all", ["==", ["get", "kind"], "core"], ["==", ["get", "bucketId"], id]]);
            if (ownedMap.getLayer("bucket-labels")) ownedMap.setFilter("bucket-labels", ["all", ["==", ["get", "kind"], "core"], ["any", ["==", ["get", "labelVisible"], true], ["==", ["get", "bucketId"], id]]]);
          },
          regionSelection: id => {
            const color: ["case", ["==", ["get", "id"], string], string, string] = ["case", ["==", ["get", "id"], id], light ? "#5d929b" : "#4d97ac", mode === "global" ? light ? "#769696" : "#6b9aad" : light ? "#829fa8" : "#153f57"];
            ownedMap.setPaintProperty("regions", mode === "global" ? "fill-color" : "fill-extrusion-color", color);
          },
        });
        let rotating = latest.current.visual?.autoRotate === true;
        const update = (current: AtlasPrototypeProps) => {
          updateFacts(current); highlight(current);
          if (rotating !== (current.visual?.autoRotate === true)) { rotating = current.visual?.autoRotate === true; rotate(); }
        };
        handle.current = { fit, update, focus, dispose: () => { focusMarker?.remove(); ownedMap.getCanvas().removeEventListener("webglcontextlost", lost); ownedMap.getCanvas().removeEventListener("webglcontextrestored", restored); } };
        update(latest.current);
        if (latest.current.focus && latest.current.focus !== openingFocus) focus(latest.current.focus);
        else if (savedView) ownedMap.jumpTo(savedView);
        else if (latest.current.focus) focus(latest.current.focus);
        else fit();
        observer = new ResizeObserver(() => { ownedMap.resize(); }); observer.observe(element);
        ownedMap.once("render", () => { if (!stopped) { latest.current.onReady?.(); viewChanged(); } }); rotate();
      });
      ownedMap.on("click", (event) => {
        if (!ownedMap.getLayer("bucket-cores")) return;
        const points = ownedMap.queryRenderedFeatures(event.point, { layers: ["bucket-cores", "bucket-rings"] }); const identifier = points[0]?.properties.bucketId;
        if (identifier) { const bucket = latest.current.buckets.find((item) => item.id === identifier); if (bucket) latest.current.onPick?.(bucket); return; }
        if (ownedMap.getZoom() > 6.5) return;
        const region = ownedMap.queryRenderedFeatures(event.point, { layers: ["regions", "overview-land"] })[0]; const feature = boundary.features.find((item) => item.id === String(region?.id ?? ""));
        if (feature) { latest.current.onCountry?.(regionSelection(feature)); const bounds = featureBounds(feature); stopRotation(); ownedMap.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: 65, maxZoom: 9, duration: motion.matches ? 0 : 1200, pitch: mode === "domestic" ? 40 : 15 }); }
      });
      const hover = createAtlasHover<Parameters<Map["queryRenderedFeatures"]>[0]>({ requestFrame: callback => requestAnimationFrame(callback), cancelFrame: id => cancelAnimationFrame(id),
        moving: () => stopped || ownedMap.isMoving() || !!rotationFrame,
        hit: point => { if (!ownedMap.getLayer("bucket-cores")) return; const hits = ownedMap.queryRenderedFeatures(point, { layers: ["bucket-cores", "bucket-rings", ...(ownedMap.getZoom() <= 6.5 ? ["regions"] : [])] }); const cursor = hits.length ? "pointer" : "grab"; if (ownedMap.getCanvas().style.cursor !== cursor) ownedMap.getCanvas().style.cursor = cursor; },
      });
      cancelHover = hover.cancel;
      ownedMap.on("mousemove", event => hover.queue(event.point));
      const leave = () => { hover.cancel(); ownedMap.getCanvas().style.cursor = ""; };
      ownedMap.getCanvas().addEventListener("mouseleave", leave);
      const pauseInteraction = () => { interacting = true; if (rotationResume) clearTimeout(rotationResume); rotationResume = undefined; stopRotation(); hover.cancel(); ownedMap.getCanvas().style.cursor = "grabbing"; };
      const resumeInteraction = () => { if (rotationResume) clearTimeout(rotationResume); ownedMap.getCanvas().style.cursor = "grab"; rotationResume = setTimeout(() => { rotationResume = undefined; interacting = false; rotate(); }, 700); };
      ownedMap.on("dragstart", pauseInteraction); ownedMap.on("dragend", resumeInteraction); ownedMap.on("zoomstart", pauseInteraction); ownedMap.on("zoomend", resumeInteraction);
      ownedMap.on("rotatestart", pauseInteraction); ownedMap.on("rotateend", resumeInteraction); ownedMap.on("pitchstart", pauseInteraction); ownedMap.on("pitchend", resumeInteraction);
      abort.signal.addEventListener("abort", () => ownedMap.getCanvas().removeEventListener("mouseleave", leave), { once: true });
    })().catch(report);
    return () => { stopped = true; abort.abort(); stopRotation(); if (rotationResume) clearTimeout(rotationResume); cancelHover(); observer?.disconnect(); document.removeEventListener("visibilitychange", visibility); motion.removeEventListener("change", motionChange); handle.current?.dispose(); handle.current = null; map?.remove(); };
  }, [mode, background, maxDpr, entrance, basemapKey, light]);
  useEffect(() => { handle.current?.update(latest.current); }, [props.buckets, props.selectedBucketId, props.selectedRegionId, props.focus, props.selectedJobId, props.visual?.autoRotate]);
  useEffect(() => { handle.current?.fit(props.bounds); }, [props.bounds]);
  useEffect(() => { if (props.focus) handle.current?.focus?.(props.focus); }, [props.focus]);
  const visibleFocus = activeMapFocus(props.focus, props.selectedJobId);
  return <div className={props.className} data-atlas-renderer="maplibre" data-atlas-mode={mode} data-atlas-basemap={basemap?.id ?? "offline"} style={{ ...prototypeFrameStyle, background, ...props.style }}>
    <div ref={host} style={canvasHostStyle} aria-label={mode === "global" ? "全球岗位三维地球，可连续缩放到街道，拖拽与方向键移动" : "国内岗位三维省域地图，可连续缩放到街道，拖拽与方向键移动"} />
    <a href={`${import.meta.env.BASE_URL}legal/geography/`} target="_blank" rel="noopener noreferrer" style={{ ...creditStyle, bottom: 34, color: light ? "#52665f" : "#9ab1bb", pointerEvents: "auto", textDecoration: "none" }}>{NATURAL_EARTH_CREDIT}</a>
    {visibleFocus && <div className={`atlas-focus-status${light ? " light" : ""}`} role="status" aria-live="polite">已定位{visibleFocus.label ? `：${visibleFocus.label} · ` : " · "}{mapFocusPrecisionLabel(visibleFocus)}</div>}
    {basemapWarning && <div role="status" style={{ position: "absolute", left: 14, top: 14, right: 58, zIndex: 3, color: light ? "#725719" : "#ddcf9d", background: light ? "#fff9e9eb" : "#14232ae8", border: "1px solid #8b80504d", borderRadius: 8, padding: "9px 12px", font: "11px/1.6 system-ui" }}>{basemapWarning}</div>}
    {failure && <div role="alert" style={errorStyle}>{failure}</div>}
  </div>;
}
export default MapLibrePrototype;
