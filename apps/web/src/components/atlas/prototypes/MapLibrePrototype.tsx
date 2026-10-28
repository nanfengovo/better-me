import { useEffect, useMemo, useRef, useState } from "react";
import { MapPinned, X } from "lucide-react";
import { AttributionControl, Map, Marker, NavigationControl, ScaleControl, setWorkerUrl, type GeoJSONSource, type LayerSpecification, type SourceSpecification, type StyleSpecification } from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import "maplibre-gl/dist/maplibre-gl.css";
import "../map-focus.css";
import { activeMapFocus, createMapFocusMarker, mapFocusCameraOptions, mapFocusPrecisionLabel } from "../map-focus";
import { ATLAS_BASEMAPS, attributionHtml, DEFAULT_ATLAS_BASEMAP, parseAtlasBasemap } from "./basemaps";
import { canvasHostStyle, creditStyle, errorStyle, loadBoundary, NATURAL_EARTH_CREDIT, prototypeFrameStyle, regionSelection, type AtlasPrototypeProps, type BoundaryFeature, type PrototypeHandle } from "./types";
import { atlasBucketData, atlasCoordinateStacks, createAtlasHover, createAtlasMapUpdates, mapBucketPrecisionLabel, mappableOfficeBuckets, positionMapPickMenu, rankAtlasBucketHits } from "./map-performance";
import "../map-interactions.css";

const MAP_HIT_RADIUS_PX = 28;

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

/** Globe diameter at zoom z is 512·2^z / π. Fit the disk to the stage so the overview is a globe, not an empty ocean crop. */
function globeFillZoom(width: number, height: number) {
  const safeW = width > 40 ? width : 480;
  const safeH = height > 40 ? height : 420;
  const diameter = Math.min(safeW, safeH) * 0.98;
  const zoom = Math.log2((diameter * Math.PI) / 512);
  return Math.max(1.2, Math.min(1.9, zoom));
}

function wideGlobeBounds(target: [number, number, number, number]) {
  return Math.abs(target[2] - target[0]) > 50 || Math.abs(target[3] - target[1]) > 35;
}

/** One continuous WGS84 camera: dotted globe → countries → vector streets/buildings. */
export function MapLibrePrototype(props: AtlasPrototypeProps) {
  const host = useRef<HTMLDivElement>(null); const latest = useRef(props); latest.current = props;
  const handle = useRef<PrototypeHandle | null>(null);
  const firstPickRef = useRef<HTMLButtonElement>(null);
  const pickReturnFocusRef = useRef<HTMLElement | null>(null);
  const locationTriggerRef = useRef<HTMLButtonElement>(null);
  const locationSearchRef = useRef<HTMLInputElement>(null);
  const locationListRef = useRef<HTMLDivElement>(null);
  const locationWasOpen = useRef(false);
  const [failure, setFailure] = useState<string | null>(null); const [basemapWarning, setBasemapWarning] = useState("");
  const [pickMenu, setPickMenu] = useState<{ left: number; top: number; candidates: NonNullable<AtlasPrototypeProps["buckets"]>[number][] } | null>(null);
  const [hoverCard, setHoverCard] = useState<{ left: number; top: number; bucket: NonNullable<AtlasPrototypeProps["buckets"]>[number]; stack?: { locationCount: number; jobCount: number } } | null>(null);
  const [locationBrowserOpen, setLocationBrowserOpen] = useState(false);
  const [locationSearch, setLocationSearch] = useState("");
  const [locationCursor, setLocationCursor] = useState(0);
  const mode = props.mode; const light = props.visual?.theme === "light";
  const background = props.visual?.background ?? (light ? "#f5f6f4" : "#080f18");
  const maxDpr = Math.min(1.7, Math.max(1, props.visual?.maxDpr ?? 1.7));
  const entrance = props.visual?.entrance !== false;
  const basemap = props.basemap === null ? null : parseAtlasBasemap(props.basemap ?? (light ? ATLAS_BASEMAPS.find((item) => item.id === "openfreemap-positron") : DEFAULT_ATLAS_BASEMAP));
  const basemapKey = JSON.stringify(basemap);
  const officeBuckets = useMemo(() => {
    if (!props.geometry) return mappableOfficeBuckets(props.buckets);
    const byId = new globalThis.Map(props.buckets.map(bucket => [bucket.id, bucket]));
    return props.geometry.officeBucketIds.flatMap(id => byId.get(id) ? [byId.get(id)!] : []);
  }, [props.buckets, props.geometry]);
  const coordinateStacks = useMemo(() => props.geometry?.coordinateStacks ?? atlasCoordinateStacks(officeBuckets), [officeBuckets, props.geometry]);
  const coordinateStackByBucket = useRef(new globalThis.Map<string, { locationCount: number; jobCount: number }>());
  const stackIndex = useMemo(() => new globalThis.Map(coordinateStacks.flatMap(stack => stack.bucketIds.map(id => [id, stack] as const))), [coordinateStacks]);
  coordinateStackByBucket.current = stackIndex;
  const visibleOfficeBuckets = useMemo(() => {
    const query = locationSearch.trim().toLocaleLowerCase("zh-CN");
    if (!query) return officeBuckets;
    return officeBuckets.filter((bucket) => bucket.label.toLocaleLowerCase("zh-CN").includes(query));
  }, [locationSearch, officeBuckets]);
  const chooseOfficeBucket = (bucket: NonNullable<AtlasPrototypeProps["buckets"]>[number]) => {
    setLocationBrowserOpen(false);
    setLocationSearch("");
    latest.current.onPick?.(bucket);
    latest.current.onActivateBucket?.(bucket);
  };
  const focusLocationOption = (index: number) => {
    const next = Math.max(0, Math.min(visibleOfficeBuckets.length - 1, index));
    setLocationCursor(next);
    requestAnimationFrame(() => locationListRef.current?.querySelector<HTMLButtonElement>(`[data-location-index="${next}"]`)?.focus());
  };
  useEffect(() => {
    const element = host.current; if (!element) return;
    const openingFocus = latest.current.focus;
    const provider = basemapKey === "null" ? null : parseAtlasBasemap(JSON.parse(basemapKey));
    let stopped = false; let map: Map | undefined; let observer: ResizeObserver | undefined; let rotationFrame = 0;
    let rotationResume: ReturnType<typeof setTimeout> | undefined, interacting = false, userMoved = false; let cancelHover = () => {};
    let focusMarker: Marker | undefined; let markerSignature = "";
    const abort = new AbortController(); const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const report = (error: unknown) => { if (stopped || abort.signal.aborted) return; setFailure("三维地图暂不可用，仍可通过岗位列表浏览与选择。"); latest.current.onError?.(error instanceof Error ? error : new Error("Map renderer unavailable.")); };
    const warnTiles = () => { if (!stopped) setBasemapWarning("在线底图未完整加载，概略轮廓和岗位列表仍可使用。可切换底图或稍后重试。"); };
    const stopRotation = () => { if (rotationFrame) cancelAnimationFrame(rotationFrame); rotationFrame = 0; };
    const rotate = () => {
      stopRotation(); if (!map || stopped || interacting || document.hidden || motion.matches || latest.current.visual?.viewMode === "flat" || latest.current.visual?.autoRotate !== true || mode !== "global" || map.getZoom() >= 3.5 || map.isMoving()) return;
      let previous = performance.now();
      const tick = (now: number) => { if (stopped || interacting || document.hidden || motion.matches || latest.current.visual?.viewMode === "flat" || latest.current.visual?.autoRotate !== true || !map || map.getZoom() >= 3.5 || map.isMoving()) { rotationFrame = 0; return; } map.setCenter([map.getCenter().lng + Math.min(50, now - previous) * .0016, map.getCenter().lat]); previous = now; rotationFrame = requestAnimationFrame(tick); };
      rotationFrame = requestAnimationFrame(tick);
    };
    const visibility = () => { if (document.hidden) { stopRotation(); map?.stop(); } else rotate(); };
    const motionChange = () => { if (motion.matches) map?.stop(); rotate(); };
    document.addEventListener("visibilitychange", visibility); motion.addEventListener("change", motionChange); setFailure(null); setBasemapWarning("");
    void (async () => {
      const boundary = await loadBoundary(mode, abort.signal);
      const initialBuckets = latest.current.buckets, initialGeometry = latest.current.geometry, initialBucketData = initialGeometry?.data ?? atlasBucketData(initialBuckets);
      const initialAdminBoundary = latest.current.adminBoundary?.geoJson ?? { type: "FeatureCollection", features: [] };
      const sources: Record<string, SourceSpecification> = {
        boundaries: { type: "geojson", data: boundary },
        buckets: { type: "geojson", data: initialBucketData },
        "admin-highlight": { type: "geojson", data: initialAdminBoundary as any },
      };
      const remoteLayers: LayerSpecification[] = []; let remote: Partial<StyleSpecification> = {};
      if (provider?.type === "vector-style") {
        try {
          const response = await fetch(provider.styleUrl, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(8000)]), credentials: "omit" });
          if (!response.ok) throw new Error("Basemap style unavailable.");
          const style = await response.json() as StyleSpecification;
          if (style.version !== 8 || !style.sources || !Array.isArray(style.layers)) throw new Error("Invalid vector style.");
          remote = { ...(style.glyphs ? { glyphs: style.glyphs } : {}), ...(style.sprite ? { sprite: style.sprite } : {}) };
          Object.entries(style.sources).forEach(([id, source]) => { sources[`basemap:${id}`] = source; });
          const renderedBuildingLayers = new Set<string>();
          const buildingVisibilityFilters = new globalThis.Map<string, { filters: unknown[]; hasUnfilteredLayer: boolean }>();
          for (const layer of style.layers) {
            if (layer.type !== "fill" || !("source" in layer) || !("source-layer" in layer) || layer["source-layer"] !== "building") continue;
            const key = `basemap:${layer.source}\u0000${layer["source-layer"]}`;
            const entry = buildingVisibilityFilters.get(key) ?? { filters: [], hasUnfilteredLayer: false };
            if (layer.filter) entry.filters.push(layer.filter);
            else entry.hasUnfilteredLayer = true;
            buildingVisibilityFilters.set(key, entry);
          }
          style.layers.forEach((layer) => {
            if (layer.type === "background") return;
            const source = "source" in layer ? `basemap:${layer.source}` : undefined;
            const sourceLayer = "source-layer" in layer ? layer["source-layer"] : undefined;
            const minzoom = Math.max(layer.minzoom ?? 0, mode === "global" ? 2.4 : 0);
            remoteLayers.push({ ...layer, id: `basemap:${layer.id}`, minzoom, ...(source ? { source } : {}) } as LayerSpecification);
            const buildingKey = source && sourceLayer === "building" ? `${source}\u0000${sourceLayer}` : "";
            if (layer.type === "fill" && source && sourceLayer === "building" && !renderedBuildingLayers.has(buildingKey)) {
              renderedBuildingLayers.add(buildingKey);
              // Preserve the basemap's own building visibility rules and only extrude features with a source height attribute.
              const heightFilter = ["any", ["has", "render_height"], ["has", "height"]];
              const visibility = buildingVisibilityFilters.get(buildingKey);
              const styleFilter = visibility?.hasUnfilteredLayer || !visibility?.filters.length
                ? undefined
                : visibility.filters.length === 1 ? visibility.filters[0] : ["any", ...visibility.filters];
              const buildingFilter = styleFilter ? ["all", styleFilter, heightFilter] : heightFilter;
              remoteLayers.push({
                id: `basemap:${layer.id}:3d`, type: "fill-extrusion", source, "source-layer": sourceLayer,
                minzoom: Math.max(minzoom, 14), ...(layer.maxzoom !== undefined ? { maxzoom: layer.maxzoom } : {}),
                filter: buildingFilter as any,
                paint: {
                  "fill-extrusion-color": light ? "#8ca9a6" : "#82afbd",
                  "fill-extrusion-height": ["case", ["has", "render_height"], ["to-number", ["get", "render_height"], 0], ["to-number", ["get", "height"], 0]],
                  "fill-extrusion-base": ["case", ["has", "render_min_height"], ["to-number", ["get", "render_min_height"], 0], ["to-number", ["get", "min_height"], 0]],
                  "fill-extrusion-opacity": light ? .72 : .78,
                  "fill-extrusion-vertical-gradient": true,
                },
              } as LayerSpecification);
              // Fine footprint edges clarify the map's own height-backed building representation.
              remoteLayers.push({
                id: `basemap:${layer.id}:3d-edges`, type: "line", source, "source-layer": sourceLayer,
                minzoom: Math.max(minzoom, 14), ...(layer.maxzoom !== undefined ? { maxzoom: layer.maxzoom } : {}),
                filter: buildingFilter as any,
                layout: { "line-join": "round", "line-cap": "round" },
                paint: {
                  "line-color": light ? "#456c66" : "#c0dce5",
                  "line-width": ["interpolate", ["linear"], ["zoom"], 14, .35, 17, .72, 20, 1.05],
                  "line-opacity": light ? .38 : .42,
                },
              } as LayerSpecification);
            }
          });
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
          // Natural Earth province shapes are intentionally rendered as a low-relief overview, not fabricated terrain.
          { id: "regions", type: "fill-extrusion" as const, source: "boundaries", maxzoom: 6.6, paint: { "fill-extrusion-color": light ? "#829fa8" : "#153f57", "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 3, 12_000, 4.5, 12_000, 6.5, 0], "fill-extrusion-base": 0, "fill-extrusion-opacity": ["interpolate", ["linear"], ["zoom"], 3, .72, 4.5, .68, 6.5, 0], "fill-extrusion-vertical-gradient": true } } as LayerSpecification,
        ]),
        { id: "boundary-casing", type: "line", source: "boundaries", maxzoom: 7, layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": light ? "#f1f7f5" : "#071722", "line-width": ["interpolate", ["linear"], ["zoom"], 0, mode === "global" ? .8 : 1, 4.5, mode === "global" ? 1.45 : 1.85, 6.5, 1.05], "line-opacity": ["interpolate", ["linear"], ["zoom"], 0, mode === "global" ? .28 : .42, 4.5, .48, 6.5, .18] } },
        { id: "boundaries", type: "line", source: "boundaries", maxzoom: 7, layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": light ? "#497885" : "#8bd3dc", "line-width": ["interpolate", ["linear"], ["zoom"], 0, mode === "global" ? .4 : .5, 4.5, mode === "global" ? .78 : 1.02, 6.5, .62], "line-opacity": ["interpolate", ["linear"], ["zoom"], 0, mode === "global" ? .24 : .58, 4.5, mode === "global" ? .34 : .68, 6.5, 0] } },
        {
          id: "admin-highlight-fill",
          type: "fill",
          source: "admin-highlight",
          paint: {
            "fill-color": ["coalesce", ["get", "fillColor"], light ? "rgba(2,132,199,0.06)" : "rgba(0,240,255,0.08)"],
            "fill-opacity": 0.75,
          },
        },
        {
          id: "admin-highlight-casing",
          type: "line",
          source: "admin-highlight",
          layout: {
            "line-join": "round",
            "line-cap": "round",
          },
          paint: {
            "line-color": light ? "#f5fbfa" : "#06141d",
            "line-width": ["interpolate", ["linear"], ["zoom"], 4, 2.2, 8, 3.4, 12, 4.6],
            "line-opacity": 0.62,
          },
        },
        {
          id: "admin-highlight-glow",
          type: "line",
          source: "admin-highlight",
          layout: {
            "line-join": "round",
            "line-cap": "round",
          },
          paint: {
            "line-color": ["coalesce", ["get", "glowColor"], light ? "#38bdf8" : "#38bdf8"],
            "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1.25, 8, 2.2, 12, 3.1],
            "line-blur": ["interpolate", ["linear"], ["zoom"], 4, .7, 8, 1.15, 12, 1.7],
            "line-opacity": 0.38,
          },
        },
        {
          id: "admin-highlight-stroke",
          type: "line",
          source: "admin-highlight",
          layout: {
            "line-join": "round",
            "line-cap": "round",
          },
          paint: {
            "line-color": ["coalesce", ["get", "color"], light ? "#0284c7" : "#00f0ff"],
            "line-width": ["interpolate", ["linear"], ["zoom"], 4, .9, 8, 1.35, 12, 1.85],
            "line-opacity": 0.9,
          },
        },
        { id: "bucket-glow", type: "circle", source: "buckets", filter: ["==", ["get", "kind"], "core"], paint: { "circle-radius": ["+", ["get", "radius"], 5], "circle-color": ["get", "color"], "circle-blur": .72, "circle-opacity": light ? .15 : .25 } },
        { id: "bucket-selection", type: "circle", source: "buckets", filter: ["all", ["==", ["get", "kind"], "core"], ["==", ["get", "bucketId"], ""]], paint: { "circle-radius": ["+", ["get", "radius"], 7], "circle-color": light ? "#215b55" : "#d3ffed", "circle-opacity": .12, "circle-stroke-color": light ? "#215b55" : "#d3ffed", "circle-stroke-width": 1.25 } },
        { id: "bucket-rings", type: "circle", source: "buckets", filter: ["==", ["get", "kind"], "category"], paint: { "circle-radius": ["get", "radius"], "circle-color": "#ffffff", "circle-opacity": 0, "circle-stroke-color": ["get", "color"], "circle-stroke-width": 1.35, "circle-stroke-opacity": .92, "circle-pitch-alignment": "viewport" } },
        { id: "bucket-cores", type: "circle", source: "buckets", filter: ["==", ["get", "kind"], "core"], paint: { "circle-radius": ["max", 3.5, ["*", ["get", "radius"], .46]], "circle-color": ["get", "color"], "circle-stroke-color": ["match", ["get", "grade"], "building", light ? "#123c36" : "#f4fff9", light ? "#ffffff" : "#d4f4ec"], "circle-stroke-width": ["match", ["get", "grade"], "building", 1.8, "street", 1.35, "address", 1.1, 0.8], "circle-opacity": ["match", ["get", "grade"], "street", 0.82, 0.96] } },
        { id: "bucket-stack-glow", type: "circle", source: "buckets", filter: ["==", ["get", "kind"], "stack"], paint: { "circle-radius": ["+", ["get", "radius"], 7], "circle-color": ["get", "color"], "circle-blur": .78, "circle-opacity": light ? .16 : .3 } },
        { id: "bucket-stack-markers", type: "circle", source: "buckets", filter: ["==", ["get", "kind"], "stack"], paint: { "circle-radius": ["get", "radius"], "circle-color": light ? "#e5f4ef" : "#163f47", "circle-opacity": .94, "circle-stroke-color": light ? "#215b55" : "#d5f4e8", "circle-stroke-width": 2.2, "circle-pitch-alignment": "viewport" } },
        ...(remote.glyphs ? [{ id: "bucket-labels", type: "symbol" as const, source: "buckets", filter: ["all", ["==", ["get", "kind"], "core"], ["==", ["get", "labelVisible"], true]], layout: { "text-field": ["get", "label"], "text-size": 11, "text-font": ["Noto Sans Regular"], "text-offset": [0, 1.6], "text-anchor": "top", "text-padding": 8, "text-max-width": 10 }, paint: { "text-color": light ? "#263d42" : "#d9eaf0", "text-halo-color": background, "text-halo-width": 2 } } as LayerSpecification] : []),
        ...(remote.glyphs ? [{ id: "bucket-detail-labels", type: "symbol" as const, source: "buckets", minzoom: 11, filter: ["all", ["==", ["get", "kind"], "core"], ["match", ["get", "grade"], ["building", "street", "address"], true, false]], layout: { "text-field": ["get", "fullLabel"], "text-size": ["interpolate", ["linear"], ["zoom"], 11, 10, 17, 12], "text-font": ["Noto Sans Regular"], "text-offset": [0, 1.55], "text-anchor": "top", "text-padding": 5, "text-max-width": 14, "text-optional": true }, paint: { "text-color": light ? "#263d42" : "#d9eaf0", "text-halo-color": background, "text-halo-width": 2.4 } } as LayerSpecification] : []),
        ...(remote.glyphs ? [{ id: "bucket-stack-labels", type: "symbol" as const, source: "buckets", filter: ["==", ["get", "kind"], "stack"], layout: { "text-field": ["get", "stackLabel"], "text-size": 10, "text-font": ["Noto Sans Regular"], "text-anchor": "center", "text-padding": 4, "text-optional": true }, paint: { "text-color": light ? "#215b55" : "#d5f4e8", "text-halo-color": background, "text-halo-width": 2.2 } } as LayerSpecification] : []),
      ];
      const savedView = latest.current.initialView;
      const flatView = () => latest.current.visual?.viewMode === "flat";
      const projection = () => ({ type: mode === "global" && !flatView() ? "globe" as const : "mercator" as const });
      const perspective = (detail = false) => {
        if (flatView()) return { pitch: 0, bearing: 0 };
        if (mode === "domestic") return { pitch: 46, bearing: -12 };
        const streetView = (detail && latest.current.visual?.viewMode === "spatial") || (map?.getZoom() ?? 0) >= 3.5;
        return { pitch: streetView ? 48 : 0, bearing: 0 };
      };
      const reliefLayers = layers.filter(layer => layer.type === "fill-extrusion" && (layer.id === "regions" || layer.id.endsWith(":3d")) || layer.id.endsWith(":3d-edges"));
      if (flatView()) for (const layer of reliefLayers) layer.layout = { ...layer.layout, visibility: "none" };
      map = new Map({ container: element, center: mode === "global" ? [104, 26] : [104, 35], zoom: mode === "global" ? 1.65 : 3.1, pitch: mode === "domestic" ? 46 : 0, bearing: mode === "domestic" ? -12 : 0, ...savedView, ...(flatView() ? { pitch: 0, bearing: 0 } : {}),
        maxZoom: provider?.maxZoom ?? 22, minZoom: .1, maxPitch: 75, pixelRatio: Math.min(window.devicePixelRatio || 1, maxDpr), attributionControl: false, cancelPendingTileRequestsWhileZooming: true,
        style: { version: 8, ...remote, projection: projection(), sources, layers } });
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
        ownedMap.setProjection(projection());
        ownedMap.resize();
        ownedMap.setSky({ "sky-color": background, "horizon-color": light ? "#d5deda" : "#2b526d", "fog-color": light ? "#eef0ee" : "#080f18", "atmosphere-blend": mode === "global" ? .90 : 0 });
        ownedMap.setLight({ anchor: "viewport", color: light ? "#ffffff" : "#b9e7f1", intensity: .62, position: [1.5, 190, 45] });
        const frameWideGlobe = (target?: [number, number, number, number]) => {
          const zoom = globeFillZoom(element.clientWidth, element.clientHeight);
          const center: [number, number] = target
            ? [(target[0] + target[2]) / 2, Math.max(-46, Math.min(52, (target[1] + target[3]) / 2))]
            : [105, 28];
          ownedMap.stop();
          ownedMap.jumpTo({ center, zoom, pitch: 0, bearing: 0 });
        };
        let framedSearch: string | undefined;
        const fit = (bounds = latest.current.bounds) => {
          const search = latest.current.framingKey;
          if (search !== undefined && framedSearch === search) return;
          if (bounds) framedSearch = search;
          if (!bounds) {
            ownedMap.stop();
            if (mode === "domestic") ownedMap.jumpTo({ center: [104, 35], zoom: 3.1, ...perspective() });
            else frameWideGlobe();
            return;
          }
          const cap = Number.isFinite(latest.current.boundsMaxZoom) ? latest.current.boundsMaxZoom! : 16;
          const mutableBounds: [number, number, number, number] = [bounds[0], bounds[1], bounds[2], bounds[3]];
          if (mode === "global" && !flatView() && wideGlobeBounds(mutableBounds)) { frameWideGlobe(mutableBounds); return; }
          ownedMap.stop();
          ownedMap.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: { top: 62, bottom: 72, left: 42, right: 48 }, duration: motion.matches || !entrance ? 0 : 900, maxZoom: Math.min(16, Math.max(1, cap)), ...perspective(true) });
        };
        const focus = (target: NonNullable<AtlasPrototypeProps["focus"]>) => { const options = mapFocusCameraOptions(target, provider?.maxZoom ?? 22, motion.matches); if (!options) return; stopRotation(); ownedMap.stop(); ownedMap.flyTo({ ...options, ...(flatView() ? { pitch: 0, bearing: 0 } : {}) }); };
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
        }, initialGeometry?.signature);
        let rotating = latest.current.visual?.autoRotate === true;
        let viewMode = latest.current.visual?.viewMode ?? "spatial";
        let boundaryFilterSignature: string | null = null;
        let boundaryGeometry: unknown;
        const update = (current: AtlasPrototypeProps) => {
          updateFacts(current); highlight(current);
          const nextViewMode = current.visual?.viewMode ?? "spatial";
          if (nextViewMode !== viewMode) {
            viewMode = nextViewMode;
            stopRotation(); ownedMap.stop();
            ownedMap.setProjection(projection());
            for (const layer of reliefLayers) ownedMap.setLayoutProperty(layer.id, "visibility", flatView() ? "none" : "visible");
            ownedMap.easeTo({ ...perspective(), duration: motion.matches || current.visual?.animateViewChange !== true ? 0 : 240 });
          }
          const highlightSource = ownedMap.getSource("admin-highlight") as GeoJSONSource | undefined;
          const nextBoundaryGeometry = current.adminBoundary?.geoJson ?? null;
          if (highlightSource && boundaryGeometry !== nextBoundaryGeometry) {
            highlightSource.setData((nextBoundaryGeometry ?? { type: "FeatureCollection", features: [] }) as any);
            boundaryGeometry = nextBoundaryGeometry;
          }
          // When a finer-grained administrative boundary is active, suppress the coarse Natural Earth boundary and 3D extrusion
          // for the selected province so they do not overlap or cut across coastlines.
          const boundaryFilter = current.adminBoundary && current.selectedRegionId ? current.selectedRegionId : "";
          if (boundaryFilter !== boundaryFilterSignature) {
            const filter = boundaryFilter ? ["!=", ["get", "id"], boundaryFilter] : null;
            if (ownedMap.getLayer("boundaries")) ownedMap.setFilter("boundaries", filter as any);
            if (ownedMap.getLayer("boundary-casing")) ownedMap.setFilter("boundary-casing", filter as any);
            if (ownedMap.getLayer("regions")) ownedMap.setFilter("regions", filter as any);
            boundaryFilterSignature = boundaryFilter;
          }
          if (rotating !== (current.visual?.autoRotate === true)) { rotating = current.visual?.autoRotate === true; rotate(); }
        };
        handle.current = { fit, update, focus, dispose: () => { focusMarker?.remove(); ownedMap.getCanvas().removeEventListener("webglcontextlost", lost); ownedMap.getCanvas().removeEventListener("webglcontextrestored", restored); } };
        update(latest.current);
        if (latest.current.focus && latest.current.focus !== openingFocus) focus(latest.current.focus);
        else if (latest.current.bounds) fit();
        else if (savedView) ownedMap.jumpTo({ ...savedView, ...(flatView() ? { pitch: 0, bearing: 0 } : {}) });
        else if (latest.current.focus) focus(latest.current.focus);
        else fit();
        observer = new ResizeObserver(() => {
          ownedMap.resize();
          if (userMoved || mode !== "global") return;
          const target = latest.current.bounds;
          if (target && !wideGlobeBounds([target[0], target[1], target[2], target[3]])) return;
          const zoom = globeFillZoom(element.clientWidth, element.clientHeight);
          if (Math.abs(ownedMap.getZoom() - zoom) > 0.08) ownedMap.jumpTo({ center: ownedMap.getCenter().toArray() as [number, number], zoom });
        }); observer.observe(element);
        ownedMap.once("render", () => { if (!stopped) { latest.current.onReady?.(); viewChanged(); } }); rotate();
      });
      ownedMap.on("click", (event) => {
        if (!ownedMap.getLayer("bucket-cores")) return;
        setHoverCard(null);
        const { x, y } = event.point;
        const radius = MAP_HIT_RADIUS_PX;
        const box: [[number, number], [number, number]] = [[x - radius, y - radius], [x + radius, y + radius]];
        const hitLayers = ["bucket-cores", "bucket-rings", ...(ownedMap.getLayer("bucket-stack-markers") ? ["bucket-stack-markers"] : []), ...(ownedMap.getLayer("bucket-labels") ? ["bucket-labels"] : []), ...(ownedMap.getLayer("bucket-detail-labels") ? ["bucket-detail-labels"] : []), ...(ownedMap.getLayer("bucket-stack-labels") ? ["bucket-stack-labels"] : [])];
        const points = ownedMap.queryRenderedFeatures(box, { layers: hitLayers });
        const candidates = rankAtlasBucketHits(points, latest.current.buckets, event.point, bucket => ownedMap.project([bucket.longitude, bucket.latitude]));
        if (candidates.length === 1) { setPickMenu(null); latest.current.onPick?.(candidates[0]!); latest.current.onActivateBucket?.(candidates[0]!); return; }
        if (candidates.length > 1) {
          const canvas = ownedMap.getCanvas();
          if (canvas.tabIndex < 0) canvas.tabIndex = 0;
          pickReturnFocusRef.current = canvas;
          const position = positionMapPickMenu(event.point, { width: element.clientWidth, height: element.clientHeight });
          setPickMenu({
            ...position,
            candidates,
          });
          return;
        }
        setPickMenu(null);
        if (ownedMap.getZoom() > 6.5) return;
        const region = ownedMap.queryRenderedFeatures(event.point, { layers: ["regions", "overview-land"] })[0]; const feature = boundary.features.find((item) => item.id === String(region?.id ?? ""));
        if (feature) { latest.current.onCountry?.(regionSelection(feature)); const bounds = featureBounds(feature); stopRotation(); ownedMap.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: 65, maxZoom: 9, duration: motion.matches ? 0 : 1200, pitch: flatView() ? 0 : mode === "domestic" ? 40 : 15 }); }
      });
      const hover = createAtlasHover<Parameters<Map["queryRenderedFeatures"]>[0]>({ requestFrame: callback => requestAnimationFrame(callback), cancelFrame: id => cancelAnimationFrame(id),
        moving: () => stopped || ownedMap.isMoving() || !!rotationFrame,
        hit: point => {
          if (!ownedMap.getLayer("bucket-cores")) return;
          const { x, y } = point as { x: number; y: number };
          const hits = ownedMap.queryRenderedFeatures([[x - 18, y - 18], [x + 18, y + 18]], { layers: ["bucket-cores", "bucket-rings", ...(ownedMap.getLayer("bucket-stack-markers") ? ["bucket-stack-markers"] : []), ...(ownedMap.getLayer("bucket-labels") ? ["bucket-labels"] : []), ...(ownedMap.getLayer("bucket-detail-labels") ? ["bucket-detail-labels"] : []), ...(ownedMap.getLayer("bucket-stack-labels") ? ["bucket-stack-labels"] : []), ...(ownedMap.getZoom() <= 6.5 ? ["regions"] : [])] });
          const target = rankAtlasBucketHits(hits, latest.current.buckets, { x, y }, bucket => ownedMap.project([bucket.longitude, bucket.latitude]), MAP_HIT_RADIUS_PX, true)[0];
          const regionHit = hits.some(feature => feature.layer?.id === "regions");
          const cursor = target || regionHit ? "pointer" : "grab";
          if (ownedMap.getCanvas().style.cursor !== cursor) ownedMap.getCanvas().style.cursor = cursor;
          setHoverCard(current => {
            if (!target) return null;
            const stackHit = hits.some(feature => feature.layer?.id === "bucket-stack-markers" || feature.layer?.id === "bucket-stack-labels");
            const stack = stackHit ? coordinateStackByBucket.current.get(target.id) : undefined;
            if (current?.bucket.id === target.id && Boolean(current.stack) === Boolean(stack)) return current;
            const projected = ownedMap.project([target.longitude, target.latitude]);
            return { bucket: target, ...(stack ? { stack } : {}), left: Math.max(12, Math.min(projected.x + 14, element.clientWidth - 272)), top: Math.max(12, Math.min(projected.y + 12, element.clientHeight - 90)) };
          });
        },
      });
      cancelHover = hover.cancel;
      ownedMap.on("mousemove", event => hover.queue(event.point));
      const leave = () => { hover.cancel(); ownedMap.getCanvas().style.cursor = ""; setHoverCard(null); };
      ownedMap.getCanvas().addEventListener("mouseleave", leave);
      const pauseInteraction = () => { interacting = true; if (rotationResume) clearTimeout(rotationResume); rotationResume = undefined; stopRotation(); hover.cancel(); setHoverCard(null); ownedMap.getCanvas().style.cursor = "grabbing"; };
      const resumeInteraction = () => { if (rotationResume) clearTimeout(rotationResume); ownedMap.getCanvas().style.cursor = "grab"; rotationResume = setTimeout(() => { rotationResume = undefined; interacting = false; rotate(); }, 700); };
      ownedMap.on("dragstart", () => { userMoved = true; pauseInteraction(); }); ownedMap.on("wheel", () => { userMoved = true; }); ownedMap.on("dragend", resumeInteraction); ownedMap.on("zoomstart", pauseInteraction); ownedMap.on("zoomend", resumeInteraction);
      ownedMap.on("rotatestart", pauseInteraction); ownedMap.on("rotateend", resumeInteraction); ownedMap.on("pitchstart", pauseInteraction); ownedMap.on("pitchend", resumeInteraction);
      ownedMap.on("movestart", () => { setPickMenu(null); setHoverCard(null); });
      abort.signal.addEventListener("abort", () => ownedMap.getCanvas().removeEventListener("mouseleave", leave), { once: true });
    })().catch(report);
    return () => { stopped = true; abort.abort(); stopRotation(); if (rotationResume) clearTimeout(rotationResume); cancelHover(); observer?.disconnect(); document.removeEventListener("visibilitychange", visibility); motion.removeEventListener("change", motionChange); handle.current?.dispose(); handle.current = null; map?.remove(); };
  }, [mode, background, maxDpr, entrance, basemapKey, light]);
  useEffect(() => { handle.current?.update(latest.current); }, [props.buckets, props.selectedBucketId, props.selectedRegionId, props.focus, props.selectedJobId, props.visual?.autoRotate, props.visual?.viewMode, props.visual?.animateViewChange, props.adminBoundary]);
  useEffect(() => { handle.current?.fit(props.bounds); }, [props.bounds, props.boundsMaxZoom, props.framingKey]);
  useEffect(() => { if (props.focus) handle.current?.focus?.(props.focus); }, [props.focus]);
  useEffect(() => {
    if (pickMenu) {
      firstPickRef.current?.focus();
      return;
    }
    pickReturnFocusRef.current?.focus({ preventScroll: true });
    pickReturnFocusRef.current = null;
  }, [pickMenu]);
  useEffect(() => {
    if (locationBrowserOpen) {
      locationWasOpen.current = true;
      setLocationCursor(0);
      // The dialog is rendered in the same commit as this effect, so delaying
      // focus by an animation frame only competes with the map hover scheduler.
      locationSearchRef.current?.focus();
      return;
    }
    if (locationWasOpen.current) {
      locationWasOpen.current = false;
      locationTriggerRef.current?.focus({ preventScroll: true });
    }
  }, [locationBrowserOpen]);
  useEffect(() => {
    setLocationCursor((current) => Math.max(0, Math.min(current, visibleOfficeBuckets.length - 1)));
  }, [visibleOfficeBuckets.length]);
  useEffect(() => {
    if (!officeBuckets.length) setLocationBrowserOpen(false);
  }, [officeBuckets.length]);
  useEffect(() => { setPickMenu(null); }, [props.buckets, props.selectedBucketId]);
  useEffect(() => { setHoverCard(null); }, [props.buckets, props.selectedBucketId]);
  const visibleFocus = activeMapFocus(props.focus, props.selectedJobId);
  return <div className={props.className} data-atlas-renderer="maplibre" data-atlas-mode={mode} data-atlas-view={props.visual?.viewMode ?? "spatial"} data-atlas-basemap={basemap?.id ?? "offline"} data-atlas-office-controls={officeBuckets.length > 0} style={{ ...prototypeFrameStyle, background, ...props.style }}>
    <div ref={host} style={canvasHostStyle} aria-label={`${mode === "global" ? "全球岗位" : "国内岗位"}${props.visual?.viewMode === "flat" ? "平面地图" : mode === "global" ? "三维地球" : "三维省域地图"}，可连续缩放到街道，拖拽与方向键移动`} />
    {officeBuckets.length > 0 && <>
      <button
        ref={locationTriggerRef}
        type="button"
        className={`atlas-map-location-trigger${light ? " light" : ""}`}
        aria-expanded={locationBrowserOpen}
        aria-controls="atlas-map-location-browser"
        aria-label={`查看可点办公地址，共 ${officeBuckets.length} 个地点`}
        title="即使地图标签碰撞，也可以从这里选择真实来源地址"
        onClick={() => setLocationBrowserOpen((open) => !open)}
      >
        <MapPinned aria-hidden="true" size={15} strokeWidth={1.8} />
        <span>办公地址</span>
        <strong>{officeBuckets.length}</strong>
      </button>
      {locationBrowserOpen && <div id="atlas-map-location-browser" className={`atlas-map-location-browser${light ? " light" : ""}`} role="dialog" aria-label="选择可点办公地址">
        <div className="atlas-map-location-heading">
          <div>
            <strong>可点办公地址</strong>
            <small>{visibleOfficeBuckets.length} / {officeBuckets.length} 个地点 · 来源坐标</small>
          </div>
          <button type="button" aria-label="关闭办公地址列表" onClick={() => setLocationBrowserOpen(false)}><X aria-hidden="true" size={15} /></button>
        </div>
        <label className="atlas-map-location-search">
          <span>筛选地址</span>
          <input
            ref={locationSearchRef}
            value={locationSearch}
            onChange={(event) => { setLocationSearch(event.target.value); setLocationCursor(0); }}
            placeholder="输入街道、楼宇或园区"
            aria-label="筛选办公地址"
            onKeyDown={(event) => {
              if (event.key === "Escape") { event.preventDefault(); setLocationBrowserOpen(false); }
              if (event.key === "ArrowDown" && visibleOfficeBuckets.length > 0) { event.preventDefault(); focusLocationOption(0); }
            }}
          />
        </label>
        <div ref={locationListRef} className="atlas-map-location-list" role="listbox" aria-label="来源办公地址列表" aria-activedescendant={visibleOfficeBuckets[locationCursor] ? `atlas-map-location-${visibleOfficeBuckets[locationCursor]!.id}` : undefined}>
          {visibleOfficeBuckets.length > 0 ? visibleOfficeBuckets.map((candidate, index) => <button
            key={candidate.id}
            type="button"
            role="option"
            aria-selected={candidate.id === props.selectedBucketId}
            id={`atlas-map-location-${candidate.id}`}
            data-location-index={index}
            className={candidate.id === props.selectedBucketId ? "is-selected" : ""}
            title={candidate.label}
            aria-label={`${candidate.label}，${candidate.jobCount.toLocaleString()} 个岗位，${mapBucketPrecisionLabel(candidate)}`}
            onFocus={() => setLocationCursor(index)}
            onClick={() => chooseOfficeBucket(candidate)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") { event.preventDefault(); focusLocationOption(index + 1); }
              else if (event.key === "ArrowUp") { event.preventDefault(); focusLocationOption(index - 1); }
              else if (event.key === "Home") { event.preventDefault(); focusLocationOption(0); }
              else if (event.key === "End") { event.preventDefault(); focusLocationOption(visibleOfficeBuckets.length - 1); }
              else if (event.key === "Escape") { event.preventDefault(); setLocationBrowserOpen(false); }
            }}
          >
            <span className="atlas-map-location-main"><strong>{candidate.label}</strong><small>{candidate.jobCount.toLocaleString()} 个岗位</small></span>
            <span className="atlas-map-location-precision">{mapBucketPrecisionLabel(candidate)}</span>
          </button>) : <p className="atlas-map-location-empty">没有匹配的来源地址。试试街道名或楼宇名。</p>}
        </div>
        <p className="atlas-map-location-note">仅列出来源披露或本人核对的建筑、街道、地址坐标；城市级估算不会绘制成办公点。</p>
      </div>}
    </>}
    {hoverCard && !pickMenu && <div className={`atlas-map-hover-card${light ? " light" : ""}`} style={{ left: hoverCard.left, top: hoverCard.top }}>{hoverCard.stack ? <><strong>{hoverCard.stack.locationCount.toLocaleString()} 个来源地址共用此坐标</strong><span>{hoverCard.stack.jobCount.toLocaleString()} 个岗位 · 点击展开逐个选择</span></> : <><strong>{hoverCard.bucket.label}</strong><span>{hoverCard.bucket.jobCount.toLocaleString()} 个岗位 · {mapBucketPrecisionLabel(hoverCard.bucket)}</span></>}</div>}
    {pickMenu && <div className={`atlas-map-pick-menu${light ? " light" : ""}`} role="dialog" aria-label="选择附近地点" style={{ left: pickMenu.left, top: pickMenu.top }} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setPickMenu(null); } }}>
      <div className="atlas-map-pick-menu-heading"><div><strong>附近有 {pickMenu.candidates.length} 个地点</strong><small>选择要查看的岗位位置</small></div><button type="button" aria-label="关闭地点选择" onClick={() => setPickMenu(null)}><X aria-hidden="true" size={14} /></button></div>
      <div className="atlas-map-pick-menu-list">
        {pickMenu.candidates.map((candidate, index) => <button key={candidate.id} ref={index === 0 ? firstPickRef : undefined} type="button" title={candidate.label} aria-label={`${candidate.label}，${candidate.jobCount.toLocaleString()} 个岗位，${mapBucketPrecisionLabel(candidate)}`} onClick={() => { setPickMenu(null); latest.current.onPick?.(candidate); latest.current.onActivateBucket?.(candidate); }}>
          <span className="atlas-map-pick-main"><strong>{candidate.label}</strong><small>{candidate.jobCount.toLocaleString()} 个岗位</small></span>
          <span className="atlas-map-pick-precision">{mapBucketPrecisionLabel(candidate)}</span>
        </button>)}
      </div>
      <p>按来源地址区分位置；“本人核对”不代表招聘方或企业认证。</p>
    </div>}
    <a href={`${import.meta.env.BASE_URL}legal/geography/`} target="_blank" rel="noopener noreferrer" style={{ ...creditStyle, bottom: 34, color: light ? "#52665f" : "#9ab1bb", pointerEvents: "auto", textDecoration: "none" }}>{NATURAL_EARTH_CREDIT}</a>
    {props.adminBoundary && (
      <div
        className={`atlas-admin-boundary-badge${light ? " light" : ""}`}
        role="status"
        aria-live="polite"
        style={{
          position: "absolute",
          top: "var(--atlas-boundary-top, 14px)",
          left: "var(--atlas-boundary-left, 14px)",
          zIndex: 3,
          display: "inline-flex",
          alignItems: "center",
          gap: 7,
          padding: "var(--atlas-boundary-padding, 5px 12px)",
          borderRadius: "var(--atlas-boundary-radius, 9999px)",
          fontSize: "var(--atlas-boundary-font-size, 11px)",
          fontWeight: 600,
          letterSpacing: "0.02em",
          background: light ? "rgba(255, 255, 255, 0.94)" : "rgba(10, 20, 30, 0.90)",
          color: props.adminBoundary.color,
          border: `1.5px solid ${props.adminBoundary.color}`,
          boxShadow: `0 0 14px ${props.adminBoundary.glowColor}55`,
          backdropFilter: "blur(10px)",
          pointerEvents: "none",
        }}
      >
        <span
          style={{
            display: "inline-block",
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: props.adminBoundary.color,
            boxShadow: `0 0 8px ${props.adminBoundary.glowColor}`,
          }}
        />
        <span>{props.adminBoundary.levelLabel}：{props.adminBoundary.name}</span>
      </div>
    )}
    {visibleFocus && <div className={`atlas-focus-status${light ? " light" : ""}`} role="status" aria-live="polite">已定位{visibleFocus.label ? `：${visibleFocus.label} · ` : " · "}{mapFocusPrecisionLabel(visibleFocus)}</div>}
    {basemapWarning && <div className="atlas-map-basemap-warning" role="status" style={{ position: "absolute", left: "var(--atlas-warning-left, 14px)", top: "var(--atlas-warning-top, 14px)", right: "var(--atlas-warning-right, 58px)", bottom: "var(--atlas-warning-bottom, auto)", zIndex: 3, color: light ? "#725719" : "#ddcf9d", background: light ? "#fff9e9eb" : "#14232ae8", border: "1px solid #8b80504d", borderRadius: 8, padding: "9px 12px", font: "var(--atlas-warning-font, 11px/1.6 system-ui)" }}>{basemapWarning}</div>}
    {failure && <div role="alert" style={errorStyle}>{failure}</div>}
  </div>;
}
export default MapLibrePrototype;
