import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { Compass, LoaderCircle, LocateFixed, MapPinned, Moon, Satellite, Sun, X } from "lucide-react";
import { AttributionControl, Map, Marker, NavigationControl, prewarm, ScaleControl, setWorkerCount, setWorkerUrl, type ExpressionSpecification, type FilterSpecification, type GeoJSONSource, type LayerSpecification, type SourceSpecification, type StyleSpecification } from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import "maplibre-gl/dist/maplibre-gl.css";
import { formatAtlasAddress, splitAtlasAddressDisplay } from "../address-format";
import "../map-focus.css";
import { activeMapFocus, createMapFocusMarker, mapFocusCameraOptions, mapFocusCompactPrecisionLabel } from "../map-focus";
import { ATLAS_BASEMAPS, attributionHtml, DEFAULT_ATLAS_BASEMAP, parseAtlasBasemap } from "./basemaps";
import { createBuilding3DController, type Building3DController } from "./building-3d-scene";
import {
  buildNearbyCompaniesGeoJson,
  buildUserLocationGeoJson,
  createUserLocationMarker,
  describeGeolocationError,
  EMPTY_NEARBY_COMPANIES_GEOJSON,
  EMPTY_USER_LOCATION_GEOJSON,
  formatDistanceLabel,
  formatFixPrecisionLabel,
  haversineDistanceMeters,
  isValidLngLat,
  normalizeGeolocationPosition,
  requestBrowserGeolocation,
  requestNetworkFallbackGeolocation,
  requestReverseGeocode,
  requestSearchLocation,
  UNSUPPORTED_GEOLOCATION_MESSAGE,
  type NearbyCompanyHit,
  type StreetSearchHit,
  type UserGeolocationFix,
  type UserLocationState,
} from "./user-location";
import { canvasHostStyle, creditStyle, errorStyle, loadBoundary, NATURAL_EARTH_CREDIT, prototypeFrameStyle, regionSelection, type AtlasPrototypeProps, type BoundaryFeature, type PrototypeHandle } from "./types";
import { atlasBucketData, atlasCoordinateStacks, createAtlasHover, createAtlasMapUpdates, mapBucketPrecisionLabel, mappableOfficeBuckets, positionMapPickMenu, rankAtlasBucketHits } from "./map-performance";
import "../map-interactions.css";

const MAP_HIT_RADIUS_PX = 28;

// Vite's optimized module URL does not preserve the upstream worker's sibling path.
setWorkerUrl(maplibreWorkerUrl);
// MapLibre defaults to a single worker outside Safari, serializing vector tile & glyph decoding on zoom.
setWorkerCount?.(typeof navigator !== "undefined"
  ? Math.min(4, Math.max(2, Math.floor((navigator.hardwareConcurrency || 4) / 2)))
  : 2);
if (typeof window !== "undefined") prewarm?.();

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

/** Normalize OpenMapTiles multilingual fields and strip concatenated semicolon/slash duplicates (e.g. "菲律賓;菲律賓"). */
function bilingualTextField(inline = false): ExpressionSpecification {
  const nonLatinRaw: unknown = ["coalesce", ["get", "name:nonlatin"], ""];
  const latinName: unknown = ["coalesce", ["get", "name:en"], ["get", "name:latin"], ["get", "name"], ""];
  const zhName: unknown = [
    "case",
    ["all", ["has", "name:zh-Hans"], ["!=", ["get", "name:zh-Hans"], ""]], ["get", "name:zh-Hans"],
    ["all", ["has", "name:zh"], ["!=", ["get", "name:zh"], ""]], ["get", "name:zh"],
    "",
  ];
  const hasCleanNonLatin: unknown = [
    "all",
    ["!=", nonLatinRaw, ""],
    ["!", ["in", ";", nonLatinRaw]],
    ["!", ["in", "/", nonLatinRaw]],
  ];
  const hasCleanLatin: unknown = [
    "all",
    ["!=", latinName, ""],
    ["!", ["in", ";", latinName]],
  ];
  const primary: unknown = [
    "case",
    ["!=", zhName, ""], zhName,
    hasCleanNonLatin, nonLatinRaw,
    latinName,
  ];
  if (!inline) return primary as unknown as ExpressionSpecification;
  return [
    "case",
    ["all", ["!=", primary, ""], hasCleanLatin, ["!=", primary, latinName]],
    ["concat", primary, " ", latinName],
    primary,
  ] as unknown as ExpressionSpecification;
}

import {
  ZOOM_PRESET_SPECS,
  resolveZoomTelemetry,
  type MapLayerMode,
  SATELLITE_IMAGERY_TILES,
  TERRAIN_DEM_TILES,
  buildPoiColorExpr,
  BUILDING_HEIGHT_EXPR,
  buildBuildingColorExpr,
  buildBuildingEdgePaint,
  buildStreetBackgroundPaint,
  buildCivicLanduseColorExpr,
  applyCameraLightAndSky,
  STREET_FILL_COLORS,
  WATERWAY_WIDTH_EXPR,
  MINOR_ROAD_CASING_WIDTH_EXPR,
  SATELLITE_ROAD_PAINTS,
  STREET_ROAD_PAINTS,
} from "./maplibre-styles";

function ensureSatelliteAndTerrain(
  ownedMap: Map,
  nextMode: MapLayerMode,
  terrainBlocked: boolean,
  satelliteBlocked: boolean,
) {
  if (nextMode !== "satellite") return;
  try {
    if (!satelliteBlocked && !ownedMap.getSource?.("basemap:satellite")) {
      ownedMap.addSource?.("basemap:satellite", {
        type: "raster",
        tiles: SATELLITE_IMAGERY_TILES,
        tileSize: 256,
        maxzoom: 18,
        attribution: "© Esri",
      });
    }
    if (!terrainBlocked && !ownedMap.getSource?.("basemap:terrain")) {
      ownedMap.addSource?.("basemap:terrain", {
        type: "raster-dem",
        tiles: TERRAIN_DEM_TILES,
        tileSize: 256,
        maxzoom: 15,
        encoding: "terrarium",
        attribution: "© Mapzen",
      });
    }
    const layers = ownedMap.getStyle?.()?.layers ?? [];
    const beforeId = layers.find((layer) => layer.id !== "ocean" && layer.id !== "overview-land")?.id;
    if (!satelliteBlocked && ownedMap.getSource?.("basemap:satellite") && !ownedMap.getLayer?.("basemap:satellite-layer")) {
      ownedMap.addLayer?.({
        id: "basemap:satellite-layer",
        type: "raster",
        source: "basemap:satellite",
        layout: { visibility: "visible" },
        paint: { "raster-fade-duration": 120, "raster-resampling": "linear", "raster-contrast": 0.12, "raster-saturation": 0.1, "raster-brightness-min": 0.02 },
      }, beforeId);
    }
    if (!terrainBlocked && ownedMap.getSource?.("basemap:terrain") && !ownedMap.getLayer?.("basemap:hillshade-layer")) {
      ownedMap.addLayer?.({
        id: "basemap:hillshade-layer",
        type: "hillshade",
        source: "basemap:terrain",
        minzoom: 5,
        maxzoom: 16,
        layout: { visibility: "visible" },
        paint: { "hillshade-exaggeration": 0.42, "hillshade-shadow-color": "#0b1929", "hillshade-highlight-color": "#ffffff", "hillshade-accent-color": "#1e3a5f", "hillshade-illumination-anchor": "map" },
      }, beforeId);
    }
  } catch { /* Graceful no-op on synthetic test stubs */ }
}

function syncTerrainForLayerState(
  ownedMap: Map,
  nextMode: MapLayerMode,
  flat: boolean,
  terrainBlocked: boolean,
) {
  const zoom = ownedMap.getZoom?.() ?? 0;
  // Only enable raster DEM terrain in satellite mode and within regional scales.
  const shouldEnableTerrain = !terrainBlocked && !flat && nextMode === "satellite" && zoom >= 6.5 && zoom < 15.8;
  try {
    if (ownedMap.getSource?.("basemap:terrain")) {
      const hasTerrain = Boolean(ownedMap.getTerrain?.());
      if (shouldEnableTerrain && !hasTerrain) ownedMap.setTerrain?.({ source: "basemap:terrain", exaggeration: 1.25 });
      else if (!shouldEnableTerrain && hasTerrain) ownedMap.setTerrain?.(null);
    }
  } catch { /* Graceful no-op on synthetic test stubs */ }
}

function syncNative3dExtrusionLayers(
  ownedMap: Map,
  effectiveMode: MapLayerMode,
  flat: boolean,
  custom3dActive: boolean,
) {
  const showSat = effectiveMode === "satellite";
  const street = effectiveMode === "street";
  const hideNative = flat || custom3dActive;
  const edgePaint = buildBuildingEdgePaint(effectiveMode);
  const styleLayers = ownedMap.getStyle?.()?.layers ?? [];
  for (const layer of styleLayers) {
    const id = layer.id;
    if (id.endsWith(":3d")) {
      if (ownedMap.getLayer?.(id)) {
        ownedMap.setLayoutProperty(id, "visibility", hideNative ? "none" : "visible");
        ownedMap.setPaintProperty(id, "fill-extrusion-opacity", (hideNative
          ? 0
          : ["interpolate", ["linear"], ["zoom"], 13.0, 0, 14.0, showSat ? 0.56 : street ? 0.94 : 0.96]) as ExpressionSpecification | number);
      }
    } else if (id.endsWith(":3d-edges")) {
      if (ownedMap.getLayer?.(id)) {
        ownedMap.setLayoutProperty(id, "visibility", hideNative ? "none" : "visible");
        ownedMap.setPaintProperty(id, "line-opacity", (hideNative
          ? 0
          : ["interpolate", ["linear"], ["zoom"], 13.0, 0, 14.0, edgePaint.opacity]) as ExpressionSpecification | number);
      }
    }
  }
}

function applyMapLayerMode(
  ownedMap: Map,
  nextMode: MapLayerMode,
  scopeMode: "global" | "domestic",
  flat: boolean,
  terrainBlocked: boolean,
  satelliteBlocked: boolean,
  custom3dActive = false,
) {
  ensureSatelliteAndTerrain(ownedMap, nextMode, terrainBlocked, satelliteBlocked);
  const showSat = nextMode === "satellite" && !satelliteBlocked;
  const street = nextMode === "street";
  const setVis = (id: string, visible: boolean) => {
    if (ownedMap.getLayer?.(id)) ownedMap.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
  };
  const setPaint = (id: string, prop: string, value: unknown) => {
    if (ownedMap.getLayer?.(id)) ownedMap.setPaintProperty(id, prop as Parameters<Map["setPaintProperty"]>[1], value as Parameters<Map["setPaintProperty"]>[2]);
  };

  setVis("basemap:satellite-layer", showSat);
  setVis("basemap:hillshade-layer", !terrainBlocked && showSat);
  setPaint("ocean", "background-color", buildStreetBackgroundPaint(showSat ? "satellite" : street ? "street" : "dark"));
  setVis("overview-land", !showSat);
  if (!showSat) {
    setPaint("overview-land", "fill-color", street ? "#f2efe8" : scopeMode === "global" ? "#3a5b6e" : "#173a50");
    setPaint("overview-land", "fill-opacity", street ? 0.94 : scopeMode === "global" ? 0.24 : 0.85);
  }
  setVis("land-dots", !showSat && !street);
  if (scopeMode === "domestic") {
    setVis("regions", !showSat && !flat);
    if (!showSat && !flat) {
      setPaint("regions", "fill-extrusion-color", street ? "#dfd9cb" : "#153f57");
      setPaint("regions", "fill-extrusion-opacity", street
        ? ["interpolate", ["linear"], ["zoom"], 3, 0.35, 6.5, 0]
        : ["interpolate", ["linear"], ["zoom"], 3, 0.72, 4.5, 0.68, 6.5, 0]);
    }
  } else {
    setPaint("regions", "fill-color", street ? "#e4dfd3" : showSat ? "#38bdf8" : "#6b9aad");
    setPaint("regions", "fill-opacity", showSat
      ? ["interpolate", ["linear"], ["zoom"], 0, 0.015, 3, 0.03, 6, 0]
      : street
        ? ["interpolate", ["linear"], ["zoom"], 0, 0.08, 3, 0.12, 6, 0]
        : ["interpolate", ["linear"], ["zoom"], 0, 0.03, 3, 0.06, 6, 0]);
  }
  setPaint("boundaries", "line-color", street ? "#64748b" : showSat ? "#38bdf8" : "#7dd3fc");
  setPaint("boundary-casing", "line-color", street ? "#f8fafc" : "#06131c");

  const effectiveMode: MapLayerMode = showSat ? "satellite" : street ? "street" : "dark";
  const buildingColorExpr = buildBuildingColorExpr(effectiveMode);
  const edgePaint = buildBuildingEdgePaint(effectiveMode);
  const halo = street ? "rgba(255,255,255,0.96)" : showSat ? "rgba(4,9,16,0.98)" : "rgba(6,13,22,0.96)";
  const styleLayers = ownedMap.getStyle?.()?.layers ?? [];
  for (const layer of styleLayers) {
    const id = layer.id;
    if (id.endsWith(":3d")) {
      setVis(id, !flat && !custom3dActive);
      setPaint(id, "fill-extrusion-color", buildingColorExpr);
      setPaint(id, "fill-extrusion-opacity", flat || custom3dActive
        ? 0
        : ["interpolate", ["linear"], ["zoom"], 13.0, 0, 14.0, showSat ? 0.56 : street ? 0.94 : 0.96]);
      continue;
    }
    if (id.endsWith(":3d-edges")) {
      setVis(id, !flat && !custom3dActive);
      setPaint(id, "line-color", edgePaint.color);
      setPaint(id, "line-opacity", flat || custom3dActive
        ? 0
        : ["interpolate", ["linear"], ["zoom"], 13.0, 0, 14.0, edgePaint.opacity]);
      continue;
    }
    if (id.endsWith(":street-accent")) {
      setPaint(id, "line-color", street ? "#0284c7" : "#38bdf8");
      setPaint(id, "line-opacity", ["interpolate", ["linear"], ["zoom"], 13.2, 0, 15.2, showSat ? 0.14 : street ? 0.07 : 0.14, 18, showSat ? 0.22 : street ? 0.11 : 0.2]);
      continue;
    }
    if (id === "user-location-accuracy-fill") {
      setPaint(id, "fill-color", street ? "#2563eb" : "#38bdf8");
      setPaint(id, "fill-opacity", showSat ? 0.18 : street ? 0.12 : 0.15);
      continue;
    }
    if (id === "user-location-accuracy-stroke") {
      setPaint(id, "line-color", street ? "#1d4ed8" : "#7dd3fc");
      continue;
    }
    if (id === "nearby-company-labels") {
      setPaint(id, "text-color", street ? "#0f172a" : "#e2f3ff");
      setPaint(id, "text-halo-color", street ? "#ffffff" : "#07131e");
      continue;
    }
    if (!id.startsWith("basemap:") || id === "basemap:satellite-layer" || id === "basemap:hillshade-layer") continue;
    const rawId = id.slice("basemap:".length);
    if (layer.type === "fill") {
      setVis(id, !showSat);
      if (!showSat) {
        if (street) {
          if (rawId === "building") {
            setPaint(id, "fill-color", "#e7e3da");
            setPaint(id, "fill-outline-color", "#c3bdb0");
            setPaint(id, "fill-opacity", 0.88);
          } else if (rawId === "inject:park") {
            setPaint(id, "fill-color", "#c6e5b5");
            setPaint(id, "fill-opacity", 0.8);
          } else if (rawId === "inject:landcover-grass") {
            setPaint(id, "fill-color", "#cfe8bd");
            setPaint(id, "fill-opacity", 0.72);
          } else if (rawId === "inject:landuse-residential") {
            setPaint(id, "fill-color", "#eae6dc");
            setPaint(id, "fill-opacity", 0.65);
          } else if (rawId === "inject:pedestrian-plaza") {
            setPaint(id, "fill-color", "#e3ddd1");
            setPaint(id, "fill-opacity", 0.84);
          } else if (rawId === "inject:landuse-civic") {
            setPaint(id, "fill-color", buildCivicLanduseColorExpr(true));
            setPaint(id, "fill-opacity", 0.68);
          } else if (STREET_FILL_COLORS[rawId]) {
            setPaint(id, "fill-color", STREET_FILL_COLORS[rawId]);
          }
        } else {
          if (rawId === "building") {
            setPaint(id, "fill-color", "#152538");
            setPaint(id, "fill-outline-color", "#2b4b6e");
            setPaint(id, "fill-opacity", 0.92);
          } else if (rawId === "inject:park") {
            setPaint(id, "fill-color", "#0e332a");
            setPaint(id, "fill-opacity", 0.82);
          } else if (rawId === "inject:landcover-grass") {
            setPaint(id, "fill-color", "#0c2b22");
            setPaint(id, "fill-opacity", 0.68);
          } else if (rawId === "inject:landuse-residential") {
            setPaint(id, "fill-color", "#122030");
            setPaint(id, "fill-opacity", 0.66);
          } else if (rawId === "inject:pedestrian-plaza") {
            setPaint(id, "fill-color", "#17293c");
            setPaint(id, "fill-opacity", 0.82);
          } else if (rawId === "inject:landuse-civic") {
            setPaint(id, "fill-color", buildCivicLanduseColorExpr(false));
            setPaint(id, "fill-opacity", 0.88);
          } else if (DARK_BASEMAP_PAINT[rawId]) {
            Object.entries(DARK_BASEMAP_PAINT[rawId]!).forEach(([k, v]) => setPaint(id, k, v));
          }
        }
      }
      continue;
    }
    if (layer.type === "line") {
      if (rawId === "inject:park-outline") {
        setVis(id, !showSat);
        setPaint(id, "line-color", street ? "#84bd7f" : "#1f5e4d");
        continue;
      }
      if (rawId === "inject:highway-minor-casing") {
        setPaint(id, "line-color", showSat ? "rgba(4,9,16,0.72)" : street ? "#b4c1cf" : "#050b12");
        continue;
      }
      if (rawId === "inject:road-pedestrian") {
        setPaint(id, "line-color", showSat ? "rgba(241,245,249,0.52)" : street ? "#cbd5e1" : "#355a7d");
        continue;
      }
      if (rawId === "inject:metro-rail") {
        setPaint(id, "line-color", showSat ? "#38bdf8" : street ? "#0284c7" : "#22d3ee");
        setPaint(id, "line-opacity", showSat ? 0.82 : street ? 0.72 : 0.74);
        continue;
      }
      const roadMap = showSat ? SATELLITE_ROAD_PAINTS[rawId] : street ? STREET_ROAD_PAINTS[rawId] : DARK_BASEMAP_PAINT[rawId];
      if (roadMap) Object.entries(roadMap).forEach(([k, v]) => setPaint(id, k, v));
      continue;
    }
    if (layer.type === "symbol") {
      setPaint(id, "text-halo-color", halo);
      setPaint(id, "text-halo-blur", 0);
      setPaint(id, "text-halo-width", showSat ? 2.1 : 1.9);
      if (rawId === "inject:poi-major" || rawId === "inject:poi-local") {
        setPaint(id, "text-color", buildPoiColorExpr(street && !showSat));
      } else if (rawId === "inject:poi-transit") {
        setPaint(id, "text-color", street ? "#0369a1" : "#67e8f9");
      } else if (rawId === "inject:waterway-label" || rawId.startsWith("water_name")) {
        setPaint(id, "text-color", street ? "#0369a1" : "#67e8f9");
      } else if (rawId === "inject:airport") {
        setPaint(id, "text-color", street ? "#0f766e" : "#7dd3fc");
      } else if (rawId === "inject:housenumber") {
        setPaint(id, "text-color", street ? "#334155" : "#bae6fd");
      } else if (rawId.includes("motorway")) {
        setPaint(id, "text-color", street ? "#92400e" : "#fde68a");
      } else if (rawId.includes("state")) {
        setPaint(id, "text-color", street ? "#475569" : "#7dd3fc");
      } else {
        setPaint(id, "text-color", street ? "#0f172a" : "#f1f5f9");
      }
    }
  }

  for (const bucketLabelId of ["bucket-labels", "bucket-detail-labels", "bucket-stack-labels"]) {
    setPaint(bucketLabelId, "text-color", street ? "#0f172a" : bucketLabelId === "bucket-stack-labels" ? "#e6fff9" : "#f0f7fa");
    setPaint(bucketLabelId, "text-halo-color", street ? "#f5f6f4" : "#08111b");
  }

  applyCameraLightAndSky(ownedMap, effectiveMode, scopeMode);

  syncTerrainForLayerState(ownedMap, nextMode, flat, terrainBlocked);
}

const DARK_BASEMAP_PAINT: Record<string, Record<string, unknown>> = {
  water: { "fill-color": "#0a2f4f" },
  waterway: { "line-color": "#1d6fa3", "line-width": WATERWAY_WIDTH_EXPR },
  landuse_park: { "fill-color": "#0e332a", "fill-opacity": 0.82 },
  landcover_wood: { "fill-color": "#0f2e24", "fill-opacity": 0.72 },
  landuse_residential: { "fill-color": "#122030", "fill-opacity": 0.66 },
  building: { "fill-color": "#152538", "fill-outline-color": "#2b4b6e", "fill-opacity": 0.92 },
  "aeroway-area": { "fill-color": "#152436" },
  "aeroway-runway": { "line-color": "#4b7499", "line-opacity": 0.9 },
  highway_path: { "line-color": "#335678", "line-opacity": 0.92, "line-width": ["interpolate", ["exponential", 1.2], ["zoom"], 13, 1.25, 16, 2.4, 20, 6.5] },
  highway_minor: { "line-color": "#2c4b6b", "line-opacity": 0.98 },
  highway_major_subtle: { "line-color": "#34597d" },
  highway_major_casing: { "line-color": "#050b12" },
  highway_major_inner: { "line-color": "#3e6c96" },
  highway_motorway_subtle: { "line-color": "#3f75a6" },
  highway_motorway_casing: { "line-color": "#07101b" },
  highway_motorway_inner: { "line-color": "#4f92c9" },
  railway: { "line-color": "#38bdf8", "line-opacity": 0.65 },
  railway_dashline: { "line-color": "#bae6fd", "line-opacity": 0.56 },
  railway_transit: { "line-color": "#22d3ee", "line-opacity": 0.74 },
  boundary_state: { "line-color": "#446c8f", "line-opacity": 0.85 },
  "boundary_country_z0-4": { "line-color": "#4e7fa8", "line-opacity": 0.9 },
  "boundary_country_z5-": { "line-color": "#4e7fa8", "line-opacity": 0.9 },
};

function refineBasemapLayer(layer: LayerSpecification, minzoom: number, source: string | undefined, light: boolean): LayerSpecification {
  const sourceLayer = "source-layer" in layer ? layer["source-layer"] : undefined;
  const effectiveMinzoom = layer.type === "symbol" && (sourceLayer === "place" || sourceLayer === "water_name")
    ? (layer.minzoom ?? 0)
    : layer.id === "railway_transit" || layer.id === "railway_transit_dashline"
      ? Math.min(layer.minzoom ?? 16, 12)
      : minzoom;
  const effectiveMaxzoom = layer.id === "landuse_residential"
    ? 24
    : layer.id === "place_suburb"
      ? Math.max(layer.maxzoom ?? 15, 17.5)
      : layer.id === "place_town"
        ? Math.max(layer.maxzoom ?? 15, 16.8)
        : layer.id === "place_village" || layer.id === "place_other"
          ? Math.max(layer.maxzoom ?? 14, 16.5)
          : layer.maxzoom;
  const base = {
    ...layer,
    id: `basemap:${layer.id}`,
    minzoom: effectiveMinzoom,
    ...(effectiveMaxzoom !== undefined ? { maxzoom: effectiveMaxzoom } : {}),
    ...(source ? { source } : {}),
  } as LayerSpecification;

  if (layer.type === "symbol" && sourceLayer === "transportation_name") {
    const isMotorway = layer.id.includes("motorway") || layer.id.includes("shield");
    return {
      ...base,
      layout: {
        ...layer.layout,
        "text-field": isMotorway ? layer.layout?.["text-field"] : bilingualTextField(true),
        "text-transform": "none",
        "symbol-spacing": 240,
        "text-max-angle": 42,
        "text-padding": 3,
        ...(isMotorway
          ? { "text-size": ["interpolate", ["linear"], ["zoom"], 10, 11, 16, 13] }
          : { "text-size": ["interpolate", ["linear"], ["zoom"], 12.2, 11, 15.5, 13, 18.5, 14.5] }),
      },
      paint: {
        ...layer.paint,
        ...(light
          ? { "text-color": isMotorway ? "#92400e" : "#0f172a" }
          : { "text-color": isMotorway ? "#fde68a" : "#e2eef8" }),
        "text-halo-color": light ? "rgba(255,255,255,0.96)" : "rgba(6,14,22,0.96)",
        "text-halo-width": 2.0,
        "text-halo-blur": 0,
      },
    } as LayerSpecification;
  }

  if (layer.type === "symbol" && (sourceLayer === "place" || sourceLayer === "water_name")) {
    const rawIcon = layer.layout && "icon-image" in layer.layout ? layer.layout["icon-image"] : undefined;
    const fixedIcon = Array.isArray(rawIcon)
      ? rawIcon.map((item) => (item === "circle-11" ? "circle_11" : item))
      : rawIcon === "circle-11" ? "circle_11" : rawIcon;
    const darkTextColor = sourceLayer === "water_name"
      ? "#67e8f9"
      : layer.id === "place_country_major" || layer.id === "place_city_large"
        ? "#f8fafc"
        : layer.id === "place_state"
          ? "#7dd3fc"
          : layer.id === "place_city" || layer.id === "place_country_minor"
            ? "#f1f5f9"
            : layer.id === "place_suburb"
              ? "#bae6fd"
              : "#e2e8f0";
    const lightTextColor = sourceLayer === "water_name"
      ? "#0369a1"
      : layer.id === "place_suburb" || layer.id === "place_town"
        ? "#1e293b"
        : undefined;
    const placeTextSize = layer.id === "place_suburb"
      ? ["interpolate", ["linear"], ["zoom"], 10, 11, 14, 13, 17, 14]
      : layer.id === "place_town" || layer.id === "place_village"
        ? ["interpolate", ["linear"], ["zoom"], 9, 10.5, 13, 12, 16, 13]
        : sourceLayer === "water_name"
          ? ["interpolate", ["linear"], ["zoom"], 9, 11.5, 15, 13.5]
          : undefined;
    return {
      ...base,
      layout: {
        ...layer.layout,
        ...(fixedIcon !== undefined ? { "icon-image": fixedIcon } : {}),
        "text-field": bilingualTextField(sourceLayer === "water_name"),
        "text-transform": "none",
        ...(placeTextSize ? { "text-size": placeTextSize } : {}),
      },
      paint: {
        ...layer.paint,
        ...(light ? (lightTextColor ? { "text-color": lightTextColor } : {}) : { "text-color": darkTextColor }),
        "text-halo-color": light ? "rgba(255,255,255,0.96)" : "rgba(6,14,22,0.95)",
        "text-halo-width": 1.9,
        "text-halo-blur": 0,
      },
    } as LayerSpecification;
  }

  if (light && layer.type === "line" && layer.id === "waterway") {
    return {
      ...base,
      paint: { ...(layer.paint ?? {}), "line-color": "#6cb6e8", "line-width": WATERWAY_WIDTH_EXPR },
    } as LayerSpecification;
  }

  const darkOverride = !light ? DARK_BASEMAP_PAINT[layer.id] : undefined;
  if (darkOverride) {
    const nextPaint: Record<string, unknown> = { ...(layer.paint ?? {}), ...darkOverride };
    if (layer.id === "landcover_wood") delete nextPaint["fill-pattern"];
    return { ...base, paint: nextPaint } as LayerSpecification;
  }
  if (layer.id === "landcover_wood" && layer.paint && "fill-pattern" in layer.paint) {
    const nextPaint: Record<string, unknown> = { ...layer.paint };
    delete nextPaint["fill-pattern"];
    return { ...base, paint: nextPaint } as LayerSpecification;
  }
  return base;
}

function buildOpenMapTilesSupplements(source: string, existingLayers: LayerSpecification[], hasGlyphs: boolean, hasSprite: boolean, light: boolean) {
  const hasLayer = (id: string, sourceLayer?: string) => existingLayers.some((layer) => layer.id === id || (sourceLayer && "source-layer" in layer && layer["source-layer"] === sourceLayer));
  const underlayLayers: LayerSpecification[] = [];
  const minorRoadCasingLayers: LayerSpecification[] = [];
  const transitLayers: LayerSpecification[] = [];
  const overlaySymbolLayers: LayerSpecification[] = [];
  const haloColor = light ? "rgba(255,255,255,0.96)" : "rgba(6,14,22,0.96)";

  const existingRes = existingLayers.find((layer) => layer.id === "landuse_residential");
  if (!existingRes || (existingRes.maxzoom !== undefined && existingRes.maxzoom <= 12)) {
    underlayLayers.push({
      id: "basemap:inject:landuse-residential",
      type: "fill",
      source,
      "source-layer": "landuse",
      minzoom: 9,
      filter: ["all", ["match", ["geometry-type"], ["MultiPolygon", "Polygon"], true, false], ["==", ["get", "class"], "residential"]],
      paint: {
        "fill-color": light ? "#eae6dc" : "#122030",
        "fill-opacity": light ? 0.65 : 0.66,
      },
    } as LayerSpecification);
  }

  if (!hasLayer("landcover_grass")) {
    underlayLayers.push({
      id: "basemap:inject:landcover-grass",
      type: "fill",
      source,
      "source-layer": "landcover",
      minzoom: 10.2,
      filter: ["all", ["match", ["geometry-type"], ["MultiPolygon", "Polygon"], true, false], ["match", ["get", "class"], ["grass", "meadow", "wetland"], true, false]],
      paint: {
        "fill-color": light ? "#cfe8bd" : "#0c2b22",
        "fill-opacity": light ? 0.72 : 0.68,
      },
    } as LayerSpecification);
  }

  if (!hasLayer("landuse_school", undefined) && !hasLayer("landuse_hospital", undefined)) {
    underlayLayers.push({
      id: "basemap:inject:landuse-civic",
      type: "fill",
      source,
      "source-layer": "landuse",
      minzoom: 10.8,
      filter: ["match", ["get", "class"], ["school", "university", "college", "hospital", "commercial", "retail", "industrial", "parking", "recreation_ground", "pitch", "stadium", "cemetery"], true, false],
      paint: {
        "fill-color": buildCivicLanduseColorExpr(light),
        "fill-opacity": light ? 0.68 : 0.88,
      },
    } as LayerSpecification);
  }

  if (!hasLayer("park", "park")) {
    underlayLayers.push({
      id: "basemap:inject:park",
      type: "fill",
      source,
      "source-layer": "park",
      minzoom: 8,
      filter: ["match", ["geometry-type"], ["MultiPolygon", "Polygon"], true, false],
      paint: {
        "fill-color": light ? "#c6e5b5" : "#0e332a",
        "fill-opacity": light ? 0.8 : 0.82,
      },
    } as LayerSpecification);
  }

  if (!hasLayer("park_outline")) {
    underlayLayers.push({
      id: "basemap:inject:park-outline",
      type: "line",
      source,
      "source-layer": "park",
      minzoom: 10.5,
      filter: ["match", ["geometry-type"], ["MultiPolygon", "Polygon"], true, false],
      paint: {
        "line-color": light ? "#84bd7f" : "#1f5e4d",
        "line-width": ["interpolate", ["linear"], ["zoom"], 10.5, 0.6, 15, 1.3],
        "line-opacity": 0.72,
      },
    } as LayerSpecification);
  }

  if (!hasLayer("road_area_pattern")) {
    underlayLayers.push({
      id: "basemap:inject:pedestrian-plaza",
      type: "fill",
      source,
      "source-layer": "transportation",
      minzoom: 13.5,
      filter: ["all", ["match", ["geometry-type"], ["MultiPolygon", "Polygon"], true, false], ["match", ["get", "class"], ["pedestrian", "path", "minor"], true, false]],
      paint: {
        "fill-color": light ? "#e3ddd1" : "#17293c",
        "fill-opacity": light ? 0.84 : 0.82,
      },
    } as LayerSpecification);
  }

  if (!hasLayer("road_minor_casing")) {
    minorRoadCasingLayers.push({
      id: "basemap:inject:highway-minor-casing",
      type: "line",
      source,
      "source-layer": "transportation",
      minzoom: 12.2,
      filter: ["all", ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false], ["match", ["get", "class"], ["minor", "service", "track"], true, false]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": light ? "#b4c1cf" : "#050b12",
        "line-width": MINOR_ROAD_CASING_WIDTH_EXPR,
        "line-opacity": 0.9,
      },
    } as LayerSpecification);
  }

  if (!hasLayer("road_path_pedestrian")) {
    minorRoadCasingLayers.push({
      id: "basemap:inject:road-pedestrian",
      type: "line",
      source,
      "source-layer": "transportation",
      minzoom: 13.5,
      filter: ["all", ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false], ["match", ["get", "class"], ["pedestrian", "footway", "cycleway", "steps"], true, false]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": light ? "#cbd5e1" : "#355a7d",
        "line-dasharray": [2, 1.5],
        "line-width": ["interpolate", ["linear"], ["zoom"], 13.5, 0.9, 16, 1.9, 19, 3.8],
        "line-opacity": 0.9,
      },
    } as LayerSpecification);
  }

  const existingTransit = existingLayers.find((layer) => layer.id === "railway_transit");
  if (!existingTransit || (existingTransit.minzoom ?? 0) > 13) {
    transitLayers.push({
      id: "basemap:inject:metro-rail",
      type: "line",
      source,
      "source-layer": "transportation",
      minzoom: 11,
      maxzoom: existingTransit?.minzoom ?? 16,
      filter: ["all", ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false], ["match", ["get", "class"], ["transit", "subway", "light_rail"], true, false]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": light ? "#0284c7" : "#22d3ee",
        "line-dasharray": [3, 2],
        "line-width": ["interpolate", ["linear"], ["zoom"], 11, 1.1, 14, 2.0, 16, 2.8],
        "line-opacity": light ? 0.72 : 0.74,
      },
    } as LayerSpecification);
  }

  if (!hasGlyphs) return { underlayLayers, minorRoadCasingLayers, transitLayers, overlaySymbolLayers };

  if (!hasLayer("waterway_line_label")) {
    overlaySymbolLayers.push({
      id: "basemap:inject:waterway-label",
      type: "symbol",
      source,
      "source-layer": "waterway",
      minzoom: 10.5,
      filter: ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false],
      layout: {
        "symbol-placement": "line",
        "symbol-spacing": 260,
        "text-field": bilingualTextField(true),
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 10.5, 11, 16, 13.5],
        "text-max-width": 8,
      },
      paint: {
        "text-color": light ? "#0369a1" : "#67e8f9",
        "text-halo-color": haloColor,
        "text-halo-width": 1.9,
        "text-halo-blur": 0,
      },
    } as LayerSpecification);
  }

  if (hasSprite && !hasLayer("airport", "aerodrome_label")) {
    overlaySymbolLayers.push({
      id: "basemap:inject:airport",
      type: "symbol",
      source,
      "source-layer": "aerodrome_label",
      minzoom: 9.5,
      filter: ["has", "iata"],
      layout: {
        "icon-image": "airport_11",
        "icon-size": 1.05,
        "text-anchor": "top",
        "text-offset": [0, 0.55],
        "text-field": bilingualTextField(false),
        "text-font": ["Noto Sans Regular"],
        "text-size": 12,
        "text-optional": true,
        "text-padding": 3,
      },
      paint: {
        "text-color": light ? "#0f766e" : "#7dd3fc",
        "text-halo-color": haloColor,
        "text-halo-width": 1.9,
        "text-halo-blur": 0,
      },
    } as LayerSpecification);
  }

  if (!hasLayer("poi_transit") && !hasLayer("poi_r1")) {
    const transitIconLayout = hasSprite
      ? {
          "icon-image": [
            "match",
            ["coalesce", ["get", "subclass"], ["get", "class"]],
            ["subway", "metro"], "railway_metro",
            ["tram", "light_rail"], "railway_light",
            ["bus", "bus_station", "bus_stop"], "bus",
            ["ferry", "ferry_terminal"], "ferry",
            ["airport", "aerodrome"], "airport_11",
            "railway",
          ],
          "icon-size": 1.0,
          "text-anchor": "left",
          "text-offset": [0.75, 0],
        }
      : { "text-anchor": "center" };

    overlaySymbolLayers.push({
      id: "basemap:inject:poi-transit",
      type: "symbol",
      source,
      "source-layer": "poi",
      minzoom: 11,
      filter: ["match", ["get", "class"], ["airport", "bus", "rail", "subway", "railway", "ferry"], true, false],
      layout: {
        ...transitIconLayout,
        "text-field": bilingualTextField(false),
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 11, 11, 15.5, 13],
        "text-max-width": 9,
        "text-padding": 3,
      },
      paint: {
        "text-color": light ? "#0369a1" : "#67e8f9",
        "text-halo-color": haloColor,
        "text-halo-width": 1.9,
        "text-halo-blur": 0,
      },
    } as LayerSpecification);

    const poiColorExpr = buildPoiColorExpr(light);
    const poiIconLayout = hasSprite
      ? {
          "icon-image": [
            "match",
            ["coalesce", ["get", "subclass"], ["get", "class"]],
            ["university", "college"], "college",
            "school", "school",
            ["hospital", "clinic"], "hospital",
            "library", "library",
            ["museum", "gallery"], "museum",
            ["park", "national_park", "reserve"], "park",
            "garden", "garden",
            ["cafe", "coffee"], "cafe",
            ["restaurant", "food_court"], "restaurant",
            "fast_food", "fast_food",
            ["hotel", "motel", "hostel", "lodging"], "lodging",
            ["bank", "atm"], "bank",
            ["townhall", "town_hall", "government"], "town_hall",
            ["shop", "mall", "supermarket", "department_store"], "shop",
            ["parking", "underground"], "parking",
            ["commercial", "office"], "building",
            "circle_11",
          ],
          "icon-size": 0.9,
          "text-anchor": "top",
          "text-offset": [0, 0.55],
        }
      : { "text-anchor": "center" };

    overlaySymbolLayers.push({
      id: "basemap:inject:poi-major",
      type: "symbol",
      source,
      "source-layer": "poi",
      minzoom: 12.5,
      filter: [
        "all",
        ["match", ["geometry-type"], ["MultiPoint", "Point"], true, false],
        ["!", ["match", ["get", "class"], ["airport", "bus", "rail", "subway", "railway", "ferry"], true, false]],
        ["<", ["coalesce", ["get", "rank"], 99], 8],
      ],
      layout: {
        ...poiIconLayout,
        "text-field": bilingualTextField(false),
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 12.5, 11, 16.5, 13],
        "text-max-width": 9,
        "text-padding": 3.5,
      },
      paint: {
        "text-color": poiColorExpr,
        "text-halo-color": haloColor,
        "text-halo-width": 1.9,
        "text-halo-blur": 0,
      },
    } as LayerSpecification);

    overlaySymbolLayers.push({
      id: "basemap:inject:poi-local",
      type: "symbol",
      source,
      "source-layer": "poi",
      minzoom: 14.2,
      filter: [
        "all",
        ["match", ["geometry-type"], ["MultiPoint", "Point"], true, false],
        ["!", ["match", ["get", "class"], ["airport", "bus", "rail", "subway", "railway", "ferry"], true, false]],
        [">=", ["coalesce", ["get", "rank"], 99], 8],
      ],
      layout: {
        ...poiIconLayout,
        "text-field": bilingualTextField(false),
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 14.2, 10.5, 17, 12.2],
        "text-max-width": 8.5,
        "text-padding": 4,
      },
      paint: {
        "text-color": poiColorExpr,
        "text-halo-color": haloColor,
        "text-halo-width": 1.8,
        "text-halo-blur": 0,
      },
    } as LayerSpecification);
  }

  if (!hasLayer("housenumber", "housenumber")) {
    overlaySymbolLayers.push({
      id: "basemap:inject:housenumber",
      type: "symbol",
      source,
      "source-layer": "housenumber",
      minzoom: 15.2,
      layout: {
        "text-field": ["to-string", ["get", "housenumber"]],
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 15.2, 10.5, 18.5, 12.5],
        "text-padding": 3,
      },
      paint: {
        "text-color": light ? "#334155" : "#bae6fd",
        "text-halo-color": haloColor,
        "text-halo-width": 1.8,
        "text-halo-blur": 0,
      },
    } as LayerSpecification);
  }

  return { underlayLayers, minorRoadCasingLayers, transitLayers, overlaySymbolLayers };
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
  const [hoverNearbyCard, setHoverNearbyCard] = useState<{ left: number; top: number; company: NearbyCompanyHit } | null>(null);
  const [locationBrowserOpen, setLocationBrowserOpen] = useState(false);
  const [locationSearch, setLocationSearch] = useState("");
  const [locationCursor, setLocationCursor] = useState(0);
  const [userLocation, setUserLocation] = useState<UserLocationState>({ phase: "idle" });
  const [ipRefineNoticeDismissed, setIpRefineNoticeDismissed] = useState(false);
  const [streetQuery, setStreetQuery] = useState("");
  const [streetCandidates, setStreetCandidates] = useState<StreetSearchHit[]>([]);
  const [streetSearching, setStreetSearching] = useState(false);
  const [streetSearchedEmpty, setStreetSearchedEmpty] = useState(false);
  const [viewportScanCenter, setViewportScanCenter] = useState<{ longitude: number; latitude: number; zoom: number } | null>(null);
  const [scanningViewportArea, setScanningViewportArea] = useState(false);
  const mapInstanceRef = useRef<Map | null>(null);
  const building3dRef = useRef<Building3DController | null>(null);
  const userFixRef = useRef<UserGeolocationFix | null>(null);
  const userLocationMarkerRef = useRef<Marker | null>(null);
  const geoWatchIdRef = useRef<number | null>(null);
  const geoCancelRef = useRef<(() => void) | null>(null);
  const revGeocodeSeqRef = useRef(0);
  const revGeocodeAbortRef = useRef<AbortController | null>(null);
  const revGeocodeInFlightRef = useRef<{ longitude: number; latitude: number } | null>(null);
  const lastRevGeocodeRef = useRef<{ longitude: number; latitude: number; streetLabel: string; cityLabel: string } | null>(null);
  const streetSearchSeqRef = useRef(0);
  const streetSearchAbortRef = useRef<AbortController | null>(null);
  const lastFocusedCompanyReqRef = useRef<string | null>(null);
  const pickUserLocationRef = useRef(false);
  const flyOnNextFixRef = useRef(false);
  const mode = props.mode; const light = props.visual?.theme === "light";
  const background = props.visual?.background ?? (light ? "#f5f6f4" : "#080f18");
  const maxDpr = Math.min(3, Math.max(1, props.visual?.maxDpr ?? 2.5));
  const entrance = props.visual?.entrance !== false;
  const basemap = props.basemap === null ? null : parseAtlasBasemap(props.basemap ?? (light ? ATLAS_BASEMAPS.find((item) => item.id === "openfreemap-positron") : DEFAULT_ATLAS_BASEMAP));
  const basemapKey = JSON.stringify(basemap);
  const supportsRealImagery = basemap?.type === "vector-style" && basemap.id.startsWith("openfreemap");
  const initialZoomValue = props.initialView?.zoom ?? (mode === "global" ? 1.65 : 3.1);
  const flatViewMode = props.visual?.viewMode === "flat";
  const initialPitchValue = flatViewMode ? 0 : (props.initialView?.pitch ?? (mode === "domestic" ? 46 : 0));
  const minSliderZoom = 1.2;
  const maxSliderZoom = Math.min(18.5, basemap?.maxZoom ?? 18.5);
  const zoomStateRef = useRef({ zoom: initialZoomValue, pitch: initialPitchValue, zooming: false });
  const zoomHudElRef = useRef<HTMLDivElement>(null);
  const zoomTierRef = useRef<HTMLElement>(null);
  const zoomValueRef = useRef<HTMLElement>(null);
  const zoomDetailRef = useRef<HTMLSpanElement>(null);
  const zoomPitchBtnRef = useRef<HTMLButtonElement>(null);
  const zoomSliderRef = useRef<HTMLInputElement>(null);
  const zoomPresetsRef = useRef<HTMLDivElement>(null);
  const scrubbingRef = useRef(false);
  const scrubTargetRef = useRef<number | null>(null);
  const scrubFrameRef = useRef(0);
  const scrubSettleTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastHudCacheRef = useRef({
    zooming: false,
    tier: "",
    zoomText: "",
    hint: "",
    clampedStr: "",
    progressPct: "",
    tilted: false,
    pitchText: "",
    presetIndex: -1,
  });
  const syncZoomHudDomRef = useRef<(zoom: number, pitch: number, zooming: boolean) => void>(() => {});
  syncZoomHudDomRef.current = (zoom: number, pitch: number, zooming: boolean) => {
    zoomStateRef.current = { zoom, pitch, zooming };
    const { tier, hint, clamped, progress, presetIndex } = resolveZoomTelemetry(zoom, minSliderZoom, maxSliderZoom);
    const cache = lastHudCacheRef.current;
    if (zoomHudElRef.current && cache.zooming !== zooming) {
      cache.zooming = zooming;
      zoomHudElRef.current.classList.toggle("is-zooming", zooming);
    }
    if (zoomTierRef.current && cache.tier !== tier) {
      cache.tier = tier;
      zoomTierRef.current.textContent = tier;
    }
    const zoomText = `z${zoom.toFixed(1)}`;
    if (zoomValueRef.current && cache.zoomText !== zoomText) {
      cache.zoomText = zoomText;
      zoomValueRef.current.textContent = zoomText;
    }
    if (zoomDetailRef.current && cache.hint !== hint) {
      cache.hint = hint;
      zoomDetailRef.current.textContent = hint;
    }
    if (zoomSliderRef.current) {
      const clampedStr = String(clamped);
      if (!scrubbingRef.current && cache.clampedStr !== clampedStr) {
        cache.clampedStr = clampedStr;
        zoomSliderRef.current.value = clampedStr;
      }
      const progressPct = `${progress.toFixed(1)}%`;
      if (cache.progressPct !== progressPct) {
        cache.progressPct = progressPct;
        zoomSliderRef.current.style.setProperty("--zoom-progress", progressPct);
      }
    }
    const isFlat = latest.current.visual?.viewMode === "flat";
    if (zoomPitchBtnRef.current) {
      const tilted = !isFlat && pitch > 12;
      if (cache.tilted !== tilted) {
        cache.tilted = tilted;
        zoomPitchBtnRef.current.classList.toggle("is-tilted", tilted);
        zoomPitchBtnRef.current.setAttribute("aria-pressed", String(tilted));
      }
      const pitchText = isFlat ? "平面" : tilted ? `2.5D · ${Math.round(pitch)}°` : "俯视";
      if (cache.pitchText !== pitchText) {
        cache.pitchText = pitchText;
        zoomPitchBtnRef.current.textContent = pitchText;
      }
    }
    if (zoomPresetsRef.current && cache.presetIndex !== presetIndex) {
      cache.presetIndex = presetIndex;
      const buttons = zoomPresetsRef.current.children;
      for (let i = 0; i < buttons.length; i++) buttons[i]?.classList.toggle("is-active", i === presetIndex);
    }
  };
  const [layerMode, setLayerMode] = useState<MapLayerMode>(light ? "street" : "dark");
  const layerModeRef = useRef<MapLayerMode>(layerMode);
  layerModeRef.current = layerMode;
  const terrainBlockedRef = useRef(false);
  const satelliteBlockedRef = useRef(false);
  const mapLoadedRef = useRef(false);
  const syncUserLocationOnMap = (
    ownedMap: Map | null,
    fix: UserGeolocationFix | null,
    targetFocus: ReturnType<typeof activeMapFocus>,
  ) => {
    if (!ownedMap) return;
    try {
      const geoSource = ownedMap.getSource?.("user-location") as GeoJSONSource | undefined;
      geoSource?.setData(buildUserLocationGeoJson(fix) as Parameters<GeoJSONSource["setData"]>[0]);
    } catch { /* Ignore before map style ready */ }
    userLocationMarkerRef.current?.remove();
    userLocationMarkerRef.current = null;
    if (!fix) return;
    const isLightSurface = supportsRealImagery ? layerModeRef.current === "street" : light;
    const distanceMeters = targetFocus
      ? haversineDistanceMeters(fix, { longitude: targetFocus.longitude, latitude: targetFocus.latitude })
      : null;
    userLocationMarkerRef.current = new Marker({
      element: createUserLocationMarker(document, fix, isLightSurface, distanceMeters),
      anchor: "center",
      pitchAlignment: "viewport",
      rotationAlignment: "viewport",
    })
      .setLngLat([fix.longitude, fix.latitude])
      .addTo(ownedMap);
  };
  const flyToUserLocation = (ownedMap: Map, fix: UserGeolocationFix) => {
    const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const maxZoom = basemap?.maxZoom ?? 22;
    const minTargetZoom = fix.source === "ip" ? 11.8 : 16.0;
    const targetZoom = Math.min(maxZoom, Math.max(ownedMap.getZoom?.() ?? 0, minTargetZoom));
    const isFlat = latest.current.visual?.viewMode === "flat";
    ownedMap.stop();
    ownedMap.flyTo({
      center: [fix.longitude, fix.latitude],
      zoom: targetZoom,
      pitch: isFlat ? 0 : 42,
      curve: 1.35,
      duration: reduced ? 0 : 850,
    });
  };
  const cancelStreetAssist = () => {
    revGeocodeSeqRef.current += 1;
    revGeocodeAbortRef.current?.abort();
    revGeocodeAbortRef.current = null;
    revGeocodeInFlightRef.current = null;
    streetSearchSeqRef.current += 1;
    streetSearchAbortRef.current?.abort();
    streetSearchAbortRef.current = null;
  };
  const resetStreetSearchUi = () => {
    streetSearchSeqRef.current += 1;
    streetSearchAbortRef.current?.abort();
    streetSearchAbortRef.current = null;
    setStreetSearching(false);
    setStreetCandidates([]);
    setStreetSearchedEmpty(false);
  };
  const stopGeolocationTracking = () => {
    geoCancelRef.current?.();
    geoCancelRef.current = null;
    if (geoWatchIdRef.current !== null && typeof navigator !== "undefined" && navigator.geolocation?.clearWatch) {
      navigator.geolocation.clearWatch(geoWatchIdRef.current);
      geoWatchIdRef.current = null;
    }
  };
  const applyUserLocationFix = (fix: UserGeolocationFix, flyToFix: boolean) => {
    const preciseSource = fix.source !== "ip";
    const cachedStreet =
      preciseSource && !fix.streetLabel && lastRevGeocodeRef.current
        ? (haversineDistanceMeters(lastRevGeocodeRef.current, fix) ?? 999) < 25
          ? lastRevGeocodeRef.current
          : null
        : null;
    const effectiveFix: UserGeolocationFix = cachedStreet
      ? {
          ...fix,
          streetLabel: cachedStreet.streetLabel,
          ...(cachedStreet.cityLabel && !fix.placeLabel ? { placeLabel: cachedStreet.cityLabel } : {}),
        }
      : fix;

    const prev = userFixRef.current;
    userFixRef.current = effectiveFix;
    if (effectiveFix.source && effectiveFix.source !== "ip") {
      resetStreetSearchUi();
      setStreetQuery("");
    }
    const movedMeters = prev ? (haversineDistanceMeters(prev, effectiveFix) ?? 999) : 999;
    const sourceChanged = prev?.source !== effectiveFix.source;
    const labelChanged = prev?.streetLabel !== effectiveFix.streetLabel || prev?.placeLabel !== effectiveFix.placeLabel;
    if (!prev || sourceChanged || labelChanged || Math.round(prev.accuracyMeters) !== Math.round(effectiveFix.accuracyMeters) || movedMeters >= 8 || flyToFix) {
      setUserLocation({ phase: "active", fix: effectiveFix });
      latest.current.onUserLocationChange?.(effectiveFix);
    }
    const ownedMap = mapInstanceRef.current;
    if (ownedMap && mapLoadedRef.current) {
      syncUserLocationOnMap(ownedMap, effectiveFix, activeMapFocus(latest.current.focus, latest.current.selectedJobId));
      if (flyToFix || flyOnNextFixRef.current) {
        flyOnNextFixRef.current = false;
        flyToUserLocation(ownedMap, effectiveFix);
      }
    }

    const needsReverseGeocode =
      (effectiveFix.source === undefined || effectiveFix.source === "browser" || effectiveFix.source === "manual" || effectiveFix.source === "macos")
      && !effectiveFix.streetLabel;
    if (needsReverseGeocode) {
      const inFlight = revGeocodeInFlightRef.current;
      const inFlightDist = inFlight ? (haversineDistanceMeters(inFlight, effectiveFix) ?? 999) : 999;
      if (!inFlight || inFlightDist >= 25) {
        revGeocodeSeqRef.current += 1;
        const seq = revGeocodeSeqRef.current;
        revGeocodeAbortRef.current?.abort();
        const controller = new AbortController();
        revGeocodeAbortRef.current = controller;
        revGeocodeInFlightRef.current = { longitude: effectiveFix.longitude, latitude: effectiveFix.latitude };
        void requestReverseGeocode(effectiveFix.longitude, effectiveFix.latitude, undefined, controller.signal).then((resolved) => {
          if (controller.signal.aborted || seq !== revGeocodeSeqRef.current) {
            return;
          }
          revGeocodeAbortRef.current = null;
          revGeocodeInFlightRef.current = null;
          if (!resolved?.streetLabel) {
            return;
          }
          lastRevGeocodeRef.current = {
            longitude: effectiveFix.longitude,
            latitude: effectiveFix.latitude,
            streetLabel: resolved.streetLabel,
            cityLabel: resolved.cityLabel,
          };
          const current = userFixRef.current;
          if (!current || current.source === "ip" || current.source === "search") {
            return;
          }
          const drift = haversineDistanceMeters(current, effectiveFix) ?? 999;
          if (drift > 35) {
            return;
          }
          applyUserLocationFixRef.current(
            {
              ...current,
              streetLabel: resolved.streetLabel,
              ...(resolved.cityLabel && !current.placeLabel ? { placeLabel: resolved.cityLabel } : {}),
              ...(resolved.district ? { district: resolved.district } : {}),
              ...(resolved.subdistrict ? { subdistrict: resolved.subdistrict } : {}),
              ...(resolved.road ? { road: resolved.road } : {}),
            },
            false,
          );
        });
      }
    }
  };
  const beginBrowserWatch = (geo: Geolocation) => {
    if (geoWatchIdRef.current !== null || typeof geo.watchPosition !== "function") return;
    geoWatchIdRef.current = geo.watchPosition(
      (position) => {
        const fix = normalizeGeolocationPosition(position);
        if (fix && userFixRef.current?.source !== "manual") {
          applyUserLocationFix(fix, false);
        }
      },
      (error) => {
        if (error.code === 1) {
          flyOnNextFixRef.current = false;
          stopGeolocationTracking();
          userFixRef.current = null;
          syncUserLocationOnMap(mapInstanceRef.current, null, undefined);
          setUserLocation({ phase: "error", ...describeGeolocationError(error) });
        }
      },
      { enableHighAccuracy: false, timeout: 20_000, maximumAge: 60_000 },
    );
  };
  const runNetworkFallback = (
    code: "unsupported" | "unavailable" | "timeout",
    message: string,
    flyToFix: boolean,
  ) => {
    stopGeolocationTracking();
    pickUserLocationRef.current = false;
    if (flyToFix) flyOnNextFixRef.current = true;
    const controller = new AbortController();
    geoCancelRef.current = () => {
      controller.abort();
    };
    void requestNetworkFallbackGeolocation({ authorize: true, signal: controller.signal }).then((fallbackFix) => {
      if (controller.signal.aborted) {
        return;
      }
      geoCancelRef.current = null;
      if (fallbackFix) {
        if (fallbackFix.source === "ip") {
          setIpRefineNoticeDismissed(false);
        } else {
          resetStreetSearchUi();
          setStreetQuery("");
        }
        applyUserLocationFixRef.current(fallbackFix, flyToFix);
        return;
      }
      flyOnNextFixRef.current = false;
      if (!userFixRef.current) {
        setUserLocation({ phase: "error", code, message });
      } else {
        setUserLocation({ phase: "active", fix: userFixRef.current });
      }
    });
  };
  const startGeolocationWatch = (flyToFix: boolean, interactive = true) => {
    const geo = typeof navigator !== "undefined" ? navigator.geolocation : undefined;
    if (!geo) {
      if (interactive) {
        runNetworkFallback("unsupported", UNSUPPORTED_GEOLOCATION_MESSAGE, flyToFix);
      }
      return;
    }
    pickUserLocationRef.current = false;
    geoCancelRef.current?.();
    if (flyToFix) flyOnNextFixRef.current = true;
    geoCancelRef.current = requestBrowserGeolocation(
      geo,
      (fix) => {
        geoCancelRef.current = null;
        applyUserLocationFix(fix, flyToFix);
        beginBrowserWatch(geo);
      },
      (error) => {
        geoCancelRef.current = null;
        stopGeolocationTracking();
        if (error.code === 1) {
          flyOnNextFixRef.current = false;
          userFixRef.current = null;
          syncUserLocationOnMap(mapInstanceRef.current, null, undefined);
          latest.current.onUserLocationChange?.(null);
          if (interactive) {
            setUserLocation({ phase: "error", ...describeGeolocationError(error) });
          } else if (!userFixRef.current) {
            setUserLocation({ phase: "idle" });
          }
          return;
        }
        const described = describeGeolocationError(error);
        if (interactive && (!userFixRef.current || userFixRef.current.source === "ip") && (described.code === "unavailable" || described.code === "timeout")) {
          runNetworkFallback(described.code, described.message, flyToFix);
          return;
        }
        flyOnNextFixRef.current = false;
        if (interactive && (error.code === 1 || !userFixRef.current)) {
          setUserLocation({ phase: "error", ...described });
        } else if (!interactive && !userFixRef.current) {
          setUserLocation({ phase: "idle" });
        } else if (userFixRef.current) {
          setUserLocation({ phase: "active", fix: userFixRef.current });
        }
      },
    );
  };
  const syncUserLocationRef = useRef(syncUserLocationOnMap);
  syncUserLocationRef.current = syncUserLocationOnMap;
  const startGeolocationWatchRef = useRef(startGeolocationWatch);
  startGeolocationWatchRef.current = startGeolocationWatch;
  const applyUserLocationFixRef = useRef(applyUserLocationFix);
  applyUserLocationFixRef.current = applyUserLocationFix;
  const cancelManualPickMode = () => {
    pickUserLocationRef.current = false;
    const canvas = mapInstanceRef.current?.getCanvas?.();
    if (canvas) canvas.style.cursor = "grab";
    setUserLocation(userFixRef.current ? { phase: "active", fix: userFixRef.current } : { phase: "idle" });
  };
  const enterManualPickMode = () => {
    stopGeolocationTracking();
    cancelStreetAssist();
    resetStreetSearchUi();
    flyOnNextFixRef.current = false;
    pickUserLocationRef.current = true;
    setPickMenu(null);
    setHoverCard(null);
    const canvas = mapInstanceRef.current?.getCanvas?.();
    if (canvas) canvas.style.cursor = "crosshair";
    setUserLocation({ phase: "picking" });
  };
  const retryPrecisionLocate = () => {
    resetStreetSearchUi();
    setIpRefineNoticeDismissed(false);
    setUserLocation({ phase: "locating" });
    startGeolocationWatch(true, true);
  };
  const handleStreetSearchSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const query = streetQuery.trim();
    if (!query) return;
    streetSearchSeqRef.current += 1;
    const seq = streetSearchSeqRef.current;
    streetSearchAbortRef.current?.abort();
    const controller = new AbortController();
    streetSearchAbortRef.current = controller;
    setStreetSearching(true);
    setStreetSearchedEmpty(false);
    const cityHint = userFixRef.current?.placeLabel;
    void requestSearchLocation(query, cityHint, undefined, controller.signal).then((hits) => {
      if (controller.signal.aborted || seq !== streetSearchSeqRef.current) {
        return;
      }
      streetSearchAbortRef.current = null;
      setStreetSearching(false);
      setStreetCandidates(hits);
      setStreetSearchedEmpty(hits.length === 0);
    });
  };
  const selectStreetCandidate = (hit: StreetSearchHit) => {
    stopGeolocationTracking();
    cancelStreetAssist();
    pickUserLocationRef.current = false;
    lastRevGeocodeRef.current = {
      longitude: hit.longitude,
      latitude: hit.latitude,
      streetLabel: hit.streetLabel,
      cityLabel: hit.cityLabel,
    };
    resetStreetSearchUi();
    setStreetQuery("");
    setIpRefineNoticeDismissed(true);
    applyUserLocationFix(
      {
        longitude: hit.longitude,
        latitude: hit.latitude,
        accuracyMeters: 80,
        heading: null,
        speedMps: null,
        timestamp: Date.now(),
        source: "search",
        ...(hit.cityLabel ? { placeLabel: hit.cityLabel } : {}),
        streetLabel: hit.streetLabel,
      },
      true,
    );
  };
  const handleLocateUser = () => {
    if (userLocation.phase === "picking") {
      cancelManualPickMode();
      return;
    }
    const geo = typeof navigator !== "undefined" ? navigator.geolocation : undefined;
    const ownedMap = mapInstanceRef.current;
    if (userFixRef.current) {
      if (ownedMap) flyToUserLocation(ownedMap, userFixRef.current);
      setUserLocation({ phase: "active", fix: userFixRef.current });
      if (geo && userFixRef.current.source !== "manual" && userFixRef.current.source !== "search") {
        startGeolocationWatch(false, false);
      }
      return;
    }
    setUserLocation({ phase: "locating" });
    startGeolocationWatch(true, true);
  };
  const clearUserLocation = () => {
    stopGeolocationTracking();
    cancelStreetAssist();
    resetStreetSearchUi();
    setStreetQuery("");
    lastRevGeocodeRef.current = null;
    pickUserLocationRef.current = false;
    flyOnNextFixRef.current = false;
    userFixRef.current = null;
    const canvas = mapInstanceRef.current?.getCanvas?.();
    if (canvas) canvas.style.cursor = "";
    syncUserLocationOnMap(mapInstanceRef.current, null, undefined);
    setUserLocation({ phase: "idle" });
    latest.current.onUserLocationChange?.(null);
  };
  const handleScanViewportArea = async () => {
    const ownedMap = mapInstanceRef.current;
    const rawCenter = ownedMap?.getCenter?.();
    const lng = rawCenter && isValidLngLat(rawCenter.lng, rawCenter.lat)
      ? Number(rawCenter.lng.toFixed(6))
      : viewportScanCenter?.longitude;
    const lat = rawCenter && isValidLngLat(rawCenter.lng, rawCenter.lat)
      ? Number(rawCenter.lat.toFixed(6))
      : viewportScanCenter?.latitude;
    if (lng === undefined || lat === undefined || !isValidLngLat(lng, lat)) return;
    setScanningViewportArea(true);
    try {
      const resolved = await requestReverseGeocode(lng, lat, undefined, undefined, 2_500).catch(() => null);
      latest.current.onScanViewportArea?.({
        longitude: lng,
        latitude: lat,
        ...(resolved?.cityLabel ? { placeLabel: resolved.cityLabel } : {}),
        ...(resolved?.streetLabel ? { streetLabel: resolved.streetLabel } : {}),
        ...(resolved?.road ? { road: resolved.road } : {}),
        ...(resolved?.district ? { district: resolved.district } : {}),
        ...(resolved?.subdistrict ? { subdistrict: resolved.subdistrict } : {}),
      });
    } finally {
      setScanningViewportArea(false);
    }
  };
  const switchLayerMode = (nextMode: MapLayerMode) => {
    layerModeRef.current = nextMode;
    setLayerMode(nextMode);
    const ownedMap = mapInstanceRef.current;
    if (ownedMap && supportsRealImagery && mapLoadedRef.current) {
      const effectiveMode: MapLayerMode = nextMode === "satellite" && satelliteBlockedRef.current
        ? (light ? "street" : "dark")
        : nextMode;
      const flat = latest.current.visual?.viewMode === "flat";
      building3dRef.current?.setVisualState(effectiveMode, flat);
      applyMapLayerMode(
        ownedMap,
        nextMode,
        mode,
        flat,
        terrainBlockedRef.current,
        satelliteBlockedRef.current,
        building3dRef.current?.isRenderingCustom() ?? false,
      );
      if (userFixRef.current) {
        syncUserLocationOnMap(ownedMap, userFixRef.current, activeMapFocus(latest.current.focus, latest.current.selectedJobId));
      }
    }
  };
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
    let stopped = false; let map: Map | undefined; let observer: ResizeObserver | undefined; let rotationFrame = 0; let resizeFrame = 0;
    let rotationResume: ReturnType<typeof setTimeout> | undefined, interacting = false, userMoved = false; let cancelHover = () => {};
    let focusMarker: Marker | undefined; let markerSignature = ""; let terrainSyncTimer: ReturnType<typeof setTimeout> | undefined;
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
      type GeoJsonData = Parameters<GeoJSONSource["setData"]>[0];
      const sources: Record<string, SourceSpecification> = {
        boundaries: { type: "geojson", data: boundary, maxzoom: 7, tolerance: 0.5 },
        buckets: { type: "geojson", data: initialBucketData, maxzoom: 15, buffer: 64, promoteId: "featureId" },
        "admin-highlight": { type: "geojson", data: initialAdminBoundary as GeoJsonData, maxzoom: 13, tolerance: 0.5 },
        "user-location": { type: "geojson", data: EMPTY_USER_LOCATION_GEOJSON as GeoJsonData },
        "nearby-companies": { type: "geojson", data: EMPTY_NEARBY_COMPANIES_GEOJSON as GeoJsonData },
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
          const renderedStreetAccent = new Set<string>();
          const extrudedBuildingLayers: LayerSpecification[] = [];
          const initialVisualMode: MapLayerMode = light ? "street" : "dark";
          const initialBuildingColor = buildBuildingColorExpr(initialVisualMode);
          const initialEdgePaint = buildBuildingEdgePaint(initialVisualMode);
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
            remoteLayers.push(refineBasemapLayer(layer as LayerSpecification, minzoom, source, light));
            if (layer.type === "line" && source && sourceLayer === "transportation" && !renderedStreetAccent.has(source)) {
              renderedStreetAccent.add(source);
              remoteLayers.push({
                id: `basemap:${layer.id}:street-accent`,
                type: "line",
                source,
                "source-layer": sourceLayer,
                minzoom: Math.max(minzoom, 13.2),
                filter: ["match", ["get", "class"], ["motorway", "trunk", "primary", "secondary"], true, false],
                layout: { "line-join": "miter", "line-cap": "butt" },
                paint: {
                  "line-color": light ? "#0284c7" : "#38bdf8",
                  "line-width": ["interpolate", ["linear"], ["zoom"], 13.2, 0.3, 15.5, 0.85, 19, 1.4],
                  "line-opacity": ["interpolate", ["linear"], ["zoom"], 13.2, 0, 15.2, light ? 0.07 : 0.14, 18, light ? 0.11 : 0.2],
                },
              } as LayerSpecification);
            }
            const buildingKey = source && sourceLayer === "building" ? `${source}\u0000${sourceLayer}` : "";
            if (layer.type === "fill" && source && sourceLayer === "building" && !renderedBuildingLayers.has(buildingKey)) {
              renderedBuildingLayers.add(buildingKey);
              // Preserve the basemap's own building visibility rules and only extrude features with a source height attribute.
              const heightFilter = ["any", ["has", "render_height"], ["has", "height"]];
              const visibility = buildingVisibilityFilters.get(buildingKey);
              const styleFilter = visibility?.hasUnfilteredLayer || !visibility?.filters.length
                ? undefined
                : visibility.filters.length === 1 ? visibility.filters[0] : ["any", ...visibility.filters];
              const buildingFilter = (styleFilter ? ["all", styleFilter, heightFilter] : heightFilter) as FilterSpecification;
              // Stage 3D volumes above ground polygons and surface roads (below symbol labels) so titled facades are never sliced by roads.
              extrudedBuildingLayers.push({
                id: `basemap:${layer.id}:3d`, type: "fill-extrusion", source, "source-layer": sourceLayer,
                minzoom: Math.max(minzoom, 13.0), ...(layer.maxzoom !== undefined ? { maxzoom: layer.maxzoom } : {}),
                filter: buildingFilter,
                paint: {
                  "fill-extrusion-color": initialBuildingColor,
                  "fill-extrusion-height": BUILDING_HEIGHT_EXPR,
                  "fill-extrusion-base": ["case", ["has", "render_min_height"], ["to-number", ["get", "render_min_height"], 0], ["to-number", ["get", "min_height"], 0]],
                  "fill-extrusion-opacity": ["interpolate", ["linear"], ["zoom"], 13.0, 0, 14.0, light ? .94 : .96],
                  "fill-extrusion-vertical-gradient": true,
                },
              } as LayerSpecification);
              // Fine footprint edges clarify the map's own height-backed building representation.
              extrudedBuildingLayers.push({
                id: `basemap:${layer.id}:3d-edges`, type: "line", source, "source-layer": sourceLayer,
                minzoom: Math.max(minzoom, 13.0), ...(layer.maxzoom !== undefined ? { maxzoom: layer.maxzoom } : {}),
                filter: buildingFilter,
                layout: { "line-join": "miter", "line-cap": "butt" },
                paint: {
                  "line-color": initialEdgePaint.color,
                  "line-width": ["interpolate", ["linear"], ["zoom"], 13.0, .3, 16, .65, 20, 1.05],
                  "line-opacity": ["interpolate", ["linear"], ["zoom"], 13.0, 0, 14.0, initialEdgePaint.opacity],
                },
              } as LayerSpecification);
            }
          });
          if (extrudedBuildingLayers.length) {
            let lastRoadIdx = -1;
            remoteLayers.forEach((item, idx) => {
              if (item.type === "line" && "source-layer" in item && item["source-layer"] === "transportation") lastRoadIdx = idx;
            });
            const insertBuildingAt = remoteLayers.findIndex((item, idx) => item.type === "symbol" && idx > lastRoadIdx);
            if (insertBuildingAt >= 0) remoteLayers.splice(insertBuildingAt, 0, ...extrudedBuildingLayers);
            else remoteLayers.push(...extrudedBuildingLayers);
          }
          if (sources["basemap:openmaptiles"]) {
            const { underlayLayers, minorRoadCasingLayers, transitLayers, overlaySymbolLayers } = buildOpenMapTilesSupplements(
              "basemap:openmaptiles",
              style.layers as LayerSpecification[],
              Boolean(remote.glyphs),
              Boolean(remote.sprite),
              light,
            );
            if (underlayLayers.length) {
              const insertAfter = remoteLayers.findIndex((item) => item.type !== "fill");
              if (insertAfter >= 0) remoteLayers.splice(insertAfter, 0, ...underlayLayers);
              else remoteLayers.unshift(...underlayLayers);
            }
            if (minorRoadCasingLayers.length) {
              const minorIndex = remoteLayers.findIndex((item) => item.id === "basemap:highway_minor");
              const fallbackRoadIdx = remoteLayers.findIndex((item) => item.type === "line");
              const insertAt = minorIndex >= 0 ? minorIndex : fallbackRoadIdx;
              if (insertAt >= 0) remoteLayers.splice(insertAt, 0, ...minorRoadCasingLayers);
              else remoteLayers.push(...minorRoadCasingLayers);
            }
            if (transitLayers.length) {
              let lastRoadIdx = -1;
              remoteLayers.forEach((item, idx) => {
                if (item.type === "line" && "source-layer" in item && item["source-layer"] === "transportation") lastRoadIdx = idx;
              });
              const buildingIdx = remoteLayers.findIndex((item) => item.id.endsWith(":3d"));
              const insertTransitAt = buildingIdx >= 0
                ? buildingIdx
                : lastRoadIdx >= 0
                  ? lastRoadIdx + 1
                  : remoteLayers.findIndex((item, idx) => item.type === "symbol" && idx > lastRoadIdx);
              if (insertTransitAt >= 0) remoteLayers.splice(insertTransitAt, 0, ...transitLayers);
              else remoteLayers.push(...transitLayers);
            }
            if (overlaySymbolLayers.length) remoteLayers.push(...overlaySymbolLayers);
          }
        } catch (error) { if (abort.signal.aborted) throw error; warnTiles(); }
      } else if (provider?.type === "raster") {
        sources["basemap:raster"] = { type: "raster", tiles: provider.tiles, tileSize: provider.tileSize, maxzoom: provider.maxNativeZoom, attribution: attributionHtml(provider) };
        remoteLayers.push({ id: "basemap:raster", type: "raster", source: "basemap:raster", minzoom: mode === "global" ? 2.4 : 0, paint: { "raster-fade-duration": 180 } });
      }
      const initialSatVisible = supportsRealImagery && layerModeRef.current === "satellite" && !satelliteBlockedRef.current;
      if (initialSatVisible && provider?.type === "vector-style" && provider.id.startsWith("openfreemap")) {
        sources["basemap:satellite"] = {
          type: "raster",
          tiles: SATELLITE_IMAGERY_TILES,
          tileSize: 256,
          maxzoom: 18,
          attribution: "© Esri",
        };
        sources["basemap:terrain"] = {
          type: "raster-dem",
          tiles: TERRAIN_DEM_TILES,
          tileSize: 256,
          maxzoom: 15,
          encoding: "terrarium",
          attribution: "© Mapzen",
        };
      }
      if (mode === "global") { const dots = await import("../geo/world-land-dots.geojson?url"); sources["land-dots"] = { type: "geojson", data: dots.default, maxzoom: 4, tolerance: 0.75 }; }
      if (stopped) return;
      const imageryUnderlayLayers: LayerSpecification[] = initialSatVisible
        ? [
            {
              id: "basemap:satellite-layer",
              type: "raster",
              source: "basemap:satellite",
              layout: { visibility: "visible" },
              paint: { "raster-fade-duration": 180, "raster-resampling": "linear", "raster-contrast": 0.08, "raster-saturation": 0.12 },
            },
            {
              id: "basemap:hillshade-layer",
              type: "hillshade",
              source: "basemap:terrain",
              minzoom: 5,
              maxzoom: 16,
              layout: { visibility: !terrainBlockedRef.current ? "visible" : "none" },
              paint: { "hillshade-exaggeration": 0.42, "hillshade-shadow-color": "#0b1929", "hillshade-highlight-color": "#ffffff", "hillshade-accent-color": "#1e3a5f", "hillshade-illumination-anchor": "map" },
            },
          ]
        : [];
      const layers: LayerSpecification[] = [
        { id: "ocean", type: "background", paint: { "background-color": background } },
        { id: "overview-land", type: "fill", source: "boundaries", ...(remoteLayers.length ? { maxzoom: 7 } : {}), layout: { visibility: initialSatVisible ? "none" : "visible" }, paint: { "fill-color": mode === "global" ? light ? "#b4c3c1" : "#3a5b6e" : light ? "#b8cace" : "#173a50", "fill-opacity": mode === "global" ? (light ? .22 : .24) : .85 } },
        ...imageryUnderlayLayers,
        ...remoteLayers,
        ...(mode === "global" ? [{ id: "land-dots", type: "circle" as const, source: "land-dots", maxzoom: 3.7, paint: { "circle-color": light ? "#455459" : "#9ec6d6", "circle-radius": ["interpolate", ["linear"], ["zoom"], 0, .65, 3, 1.15], "circle-opacity": ["interpolate", ["linear"], ["zoom"], 0, .72, 2.7, .72, 3.6, 0], "circle-pitch-alignment": "map" } } as LayerSpecification] : []),
        ...(mode === "global" ? [{ id: "regions", type: "fill" as const, source: "boundaries", paint: { "fill-color": light ? "#769696" : "#6b9aad", "fill-opacity": ["interpolate", ["linear"], ["zoom"], 0, .03, 3, .06, 6, 0] } } as LayerSpecification] : [
          // Natural Earth province shapes are intentionally rendered as a low-relief overview, not fabricated terrain.
          { id: "regions", type: "fill-extrusion" as const, source: "boundaries", maxzoom: 6.6, paint: { "fill-extrusion-color": light ? "#829fa8" : "#153f57", "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 3, 12_000, 4.5, 12_000, 6.5, 0], "fill-extrusion-base": 0, "fill-extrusion-opacity": ["interpolate", ["linear"], ["zoom"], 3, .72, 4.5, .68, 6.5, 0], "fill-extrusion-vertical-gradient": true } } as LayerSpecification,
        ]),
        { id: "boundary-casing", type: "line", source: "boundaries", maxzoom: 7, layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": light ? "#f1f7f5" : "#06131c", "line-width": ["interpolate", ["linear"], ["zoom"], 0, mode === "global" ? .85 : 1, 4.5, mode === "global" ? 1.5 : 1.85, 6.5, 1.05], "line-opacity": ["interpolate", ["linear"], ["zoom"], 0, mode === "global" ? .32 : .42, 4.5, .5, 6.5, .18] } },
        { id: "boundaries", type: "line", source: "boundaries", maxzoom: 7, layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": light ? "#497885" : "#7dd3fc", "line-width": ["interpolate", ["linear"], ["zoom"], 0, mode === "global" ? .45 : .55, 4.5, mode === "global" ? .82 : 1.02, 6.5, .62], "line-opacity": ["interpolate", ["linear"], ["zoom"], 0, mode === "global" ? .30 : .58, 4.5, mode === "global" ? .42 : .68, 6.5, 0] } },
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
            "line-width": ["interpolate", ["linear"], ["zoom"], 4, 2.0, 8, 3.2, 12, 4.2],
            "line-opacity": 0.24,
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
        {
          id: "user-location-accuracy-fill",
          type: "fill",
          source: "user-location",
          filter: ["==", ["get", "kind"], "accuracy"],
          paint: {
            "fill-color": light ? "#2563eb" : "#38bdf8",
            "fill-opacity": light ? 0.12 : 0.15,
          },
        },
        {
          id: "user-location-accuracy-stroke",
          type: "line",
          source: "user-location",
          filter: ["==", ["get", "kind"], "accuracy"],
          paint: {
            "line-color": light ? "#1d4ed8" : "#7dd3fc",
            "line-width": 1.5,
            "line-opacity": 0.72,
          },
        },
        {
          id: "nearby-company-rings",
          type: "circle",
          source: "nearby-companies",
          minzoom: 11.2,
          paint: {
            "circle-radius": ["case", ["boolean", ["get", "selected"], false], 15, [">", ["get", "indexedJobCount"], 0], 11.5, 9],
            "circle-color": ["get", "ownershipColor"],
            "circle-opacity": ["interpolate", ["linear"], ["zoom"], 11.2, 0, 12.2, ["case", ["boolean", ["get", "selected"], false], 0.28, 0.14]],
            "circle-stroke-color": ["get", "ownershipColor"],
            "circle-stroke-width": ["case", ["boolean", ["get", "selected"], false], 2, 1],
            "circle-stroke-opacity": ["interpolate", ["linear"], ["zoom"], 11.2, 0, 12.2, 0.75],
            "circle-pitch-alignment": "viewport",
          },
        },
        {
          id: "nearby-company-cores",
          type: "circle",
          source: "nearby-companies",
          minzoom: 11.2,
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 11.5, 4.5, 15, ["case", ["boolean", ["get", "selected"], false], 8, 6.2], 17, ["case", ["boolean", ["get", "selected"], false], 9.5, 7.2]],
            "circle-color": ["get", "ownershipColor"],
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": ["case", ["boolean", ["get", "selected"], false], 2.2, 1.5],
            "circle-opacity": ["interpolate", ["linear"], ["zoom"], 11.2, 0, 12.0, 0.96],
            "circle-stroke-opacity": ["interpolate", ["linear"], ["zoom"], 11.2, 0, 12.0, 0.96],
            "circle-pitch-alignment": "viewport",
          },
        },
        ...(remote.glyphs ? [{
          id: "nearby-company-labels",
          type: "symbol" as const,
          source: "nearby-companies",
          minzoom: 11.8,
          layout: {
            "text-field": ["get", "mapLabel"],
            "text-size": ["interpolate", ["linear"], ["zoom"], 12.0, 10.5, 16.5, 12],
            "text-font": ["Noto Sans Regular"],
            "text-offset": [0, 1.05],
            "text-anchor": "top",
            "text-padding": 5,
            "text-max-width": 13,
            "symbol-sort-key": ["get", "sortKey"],
            "text-optional": true,
          },
          paint: {
            "text-color": light ? "#0f172a" : "#e2f3ff",
            "text-halo-color": background,
            "text-halo-width": 2.1,
            "text-opacity": ["interpolate", ["linear"], ["zoom"], 11.8, 0, 12.6, 1],
          },
        } as LayerSpecification] : []),
        { id: "bucket-glow", type: "circle", source: "buckets", filter: ["==", ["get", "kind"], "core"], paint: { "circle-radius": ["+", ["get", "radius"], 6], "circle-color": ["get", "color"], "circle-blur": .85, "circle-opacity": light ? .18 : .30 } },
        { id: "bucket-selection", type: "circle", source: "buckets", filter: ["all", ["==", ["get", "kind"], "core"], ["==", ["get", "bucketId"], ""]], paint: { "circle-radius": ["+", ["get", "radius"], 10], "circle-color": light ? "#0f766e" : "#5eead4", "circle-opacity": .18, "circle-stroke-color": light ? "#0f766e" : "#5eead4", "circle-stroke-width": 2, "circle-pitch-alignment": "map" } },
        { id: "bucket-rings", type: "circle", source: "buckets", filter: ["==", ["get", "kind"], "category"], paint: { "circle-radius": ["get", "radius"], "circle-color": "#ffffff", "circle-opacity": 0, "circle-stroke-color": ["get", "color"], "circle-stroke-width": 1.4, "circle-stroke-opacity": .9, "circle-pitch-alignment": "viewport" } },
        { id: "bucket-cores", type: "circle", source: "buckets", filter: ["==", ["get", "kind"], "core"], paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, ["max", 4, ["*", ["get", "radius"], .48]], 14, ["max", 6, ["*", ["get", "radius"], .68]], 17, ["max", 8.5, ["*", ["get", "radius"], .85]]], "circle-color": ["get", "color"], "circle-stroke-color": ["match", ["get", "grade"], "building", light ? "#0f4c42" : "#ffffff", light ? "#ffffff" : "#cceee6"], "circle-stroke-width": ["match", ["get", "grade"], "building", 1.9, "street", 1.4, "address", 1.15, 0.85], "circle-opacity": ["match", ["get", "grade"], "street", 0.86, 0.98] } },
        { id: "bucket-stack-glow", type: "circle", source: "buckets", filter: ["==", ["get", "kind"], "stack"], paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, ["+", ["get", "radius"], 9], 16, ["+", ["get", "radius"], 2]], "circle-color": ["get", "color"], "circle-blur": .9, "circle-opacity": ["interpolate", ["linear"], ["zoom"], 12.5, light ? .20 : .34, 15.0, 0.02] } },
        { id: "bucket-stack-markers", type: "circle", source: "buckets", filter: ["==", ["get", "kind"], "stack"], paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, ["get", "radius"], 16, ["max", 7, ["*", ["get", "radius"], .5]]], "circle-color": light ? "#ffffff" : "#0d252e", "circle-opacity": ["interpolate", ["linear"], ["zoom"], 12.5, ["case", ["boolean", ["feature-state", "focused"], false], 0, .95], 15.0, ["case", ["boolean", ["feature-state", "focused"], false], 0, .14]], "circle-stroke-color": light ? "#0f766e" : "#5eead4", "circle-stroke-width": 1.75, "circle-stroke-opacity": ["interpolate", ["linear"], ["zoom"], 12.5, ["case", ["boolean", ["feature-state", "focused"], false], 0, 1], 15.0, ["case", ["boolean", ["feature-state", "focused"], false], 0, .24]], "circle-pitch-alignment": "viewport" } },
        ...(remote.glyphs ? [{ id: "bucket-labels", type: "symbol" as const, source: "buckets", filter: ["all", ["==", ["get", "kind"], "core"], ["==", ["get", "labelVisible"], true]], layout: { "text-field": ["get", "label"], "text-size": 11, "text-font": ["Noto Sans Regular"], "text-offset": [0, 1.5], "text-anchor": "top", "text-padding": 8, "text-max-width": 10 }, paint: { "text-color": light ? "#1e293b" : "#f0f7fa", "text-halo-color": background, "text-halo-width": 2, "text-opacity": ["interpolate", ["linear"], ["zoom"], 11.2, ["case", ["boolean", ["feature-state", "focused"], false], 0, 1], 12.2, ["case", ["boolean", ["feature-state", "focused"], false], 0, ["match", ["get", "grade"], ["building", "street", "address"], 0, 1]]] } } as LayerSpecification] : []),
        ...(remote.glyphs ? [{ id: "bucket-detail-labels", type: "symbol" as const, source: "buckets", minzoom: 11, filter: ["all", ["==", ["get", "kind"], "core"], ["match", ["get", "grade"], ["building", "street", "address"], true, false]], layout: { "text-field": ["get", "fullLabel"], "text-size": ["interpolate", ["linear"], ["zoom"], 11, 10, 16.5, 11.5], "text-font": ["Noto Sans Regular"], "text-offset": [0, 1.25], "text-anchor": "top", "text-padding": 12, "text-max-width": 11, "symbol-sort-key": ["*", -1, ["coalesce", ["get", "jobCount"], 1]], "text-optional": true }, paint: { "text-color": light ? "#1e293b" : "#f0f7fa", "text-halo-color": background, "text-halo-width": 2.2, "text-opacity": ["interpolate", ["linear"], ["zoom"], 11.4, 0, 12.6, ["case", ["boolean", ["feature-state", "focused"], false], 0, 1]] } } as LayerSpecification] : []),
        ...(remote.glyphs ? [{ id: "bucket-stack-labels", type: "symbol" as const, source: "buckets", filter: ["==", ["get", "kind"], "stack"], layout: { "text-field": ["get", "stackLabel"], "text-size": 9.5, "text-font": ["Noto Sans Regular"], "text-anchor": "center", "text-padding": 6, "text-optional": true }, paint: { "text-color": light ? "#0f4c42" : "#e6fff9", "text-halo-color": background, "text-halo-width": 1.8, "text-opacity": ["interpolate", ["linear"], ["zoom"], 13.5, ["case", ["boolean", ["feature-state", "focused"], false], 0, 1], 15.0, 0] } } as LayerSpecification] : []),
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
        maxZoom: provider?.maxZoom ?? 22, minZoom: .1, maxPitch: 75, pixelRatio: Math.min(window.devicePixelRatio || 1, maxDpr), canvasContextAttributes: { antialias: true, powerPreference: "high-performance" },
        // Use 1ms fade so street/POI labels appear immediately after decode while preserving MapLibre's 2ms incremental PauseablePlacement frame budget.
        fadeDuration: 1,
        crossSourceCollisions: false,
        maxTileCacheZoomLevels: 12,
        refreshExpiredTiles: false,
        attributionControl: false,
        cancelPendingTileRequestsWhileZooming: false,
        style: { version: 8, ...remote, projection: projection(), sources, layers } });
      const ownedMap = map;
      mapInstanceRef.current = ownedMap;
      (ownedMap as { scrollZoom?: { setZoomRate?: (rate: number) => void; setWheelZoomRate?: (rate: number) => void } }).scrollZoom?.setZoomRate?.(1 / 72);
      (ownedMap as { scrollZoom?: { setZoomRate?: (rate: number) => void; setWheelZoomRate?: (rate: number) => void } }).scrollZoom?.setWheelZoomRate?.(1 / 280);
      let lastFocusLabelBelow: boolean | null = null;
      const updateFocusLabelPlacement = () => {
        if (!focusMarker) {
          lastFocusLabelBelow = null;
          return;
        }
        const markerEl = focusMarker.getElement?.();
        const lngLat = focusMarker.getLngLat?.();
        if (!markerEl || !lngLat) return;
        const projected = ownedMap.project([lngLat.lng, lngLat.lat]);
        const nextBelow = projected.y < 145;
        if (nextBelow !== lastFocusLabelBelow) {
          lastFocusLabelBelow = nextBelow;
          markerEl.classList.toggle("is-below", nextBelow);
        }
      };
      const syncZoomHud = (zooming: boolean) => {
        // MapLibre already dispatches zoom/pitch inside its animation frame; update HUD directly to stay frame-locked with WebGL.
        if (!stopped) syncZoomHudDomRef.current(ownedMap.getZoom(), ownedMap.getPitch(), zooming);
      };
      const scheduleSatelliteTerrainSync = () => {
        if (terrainSyncTimer) clearTimeout(terrainSyncTimer);
        if (!supportsRealImagery || layerModeRef.current !== "satellite") return;
        terrainSyncTimer = setTimeout(() => {
          terrainSyncTimer = undefined;
          if (!stopped && !scrubbingRef.current) {
            syncTerrainForLayerState(ownedMap, layerModeRef.current, flatView(), terrainBlockedRef.current);
          }
        }, 160);
      };
      ownedMap.on("move", () => {
        updateFocusLabelPlacement();
      });
      ownedMap.on("zoom", () => {
        syncZoomHud(true);
        updateFocusLabelPlacement();
      });
      ownedMap.on("zoomend", () => {
        syncZoomHud(false);
        updateFocusLabelPlacement();
        scheduleSatelliteTerrainSync();
        building3dRef.current?.scheduleSync();
      });
      ownedMap.on("pitch", () => syncZoomHud(false));
      ownedMap.on("pitchend", () => syncZoomHud(false));
      ownedMap.addControl(new NavigationControl({ visualizePitch: true }), "top-right"); ownedMap.addControl(new ScaleControl({ maxWidth: 100, unit: "metric" }), "bottom-left");
      if (provider) ownedMap.addControl(new AttributionControl({ compact: false, customAttribution: attributionHtml(provider) }), "bottom-right");
      const lost = (event: Event) => { event.preventDefault(); stopRotation(); report(new Error("MapLibre WebGL context lost.")); };
      const restored = () => { if (!stopped) { setFailure(null); ownedMap.triggerRepaint(); rotate(); } };
      ownedMap.getCanvas().addEventListener("webglcontextlost", lost); ownedMap.getCanvas().addEventListener("webglcontextrestored", restored);
      ownedMap.on("error", (event) => {
        const sourceId = (event as { sourceId?: string }).sourceId;
        if (sourceId === "basemap:terrain") {
          terrainBlockedRef.current = true;
          if (supportsRealImagery) {
            if (ownedMap.getLayer?.("basemap:hillshade-layer")) ownedMap.setLayoutProperty("basemap:hillshade-layer", "visibility", "none");
            syncTerrainForLayerState(ownedMap, layerModeRef.current, flatView(), true);
          }
          return;
        }
        if (sourceId === "basemap:satellite") {
          satelliteBlockedRef.current = true;
          const fallbackMode: MapLayerMode = light ? "street" : "dark";
          layerModeRef.current = fallbackMode;
          setLayerMode(fallbackMode);
          building3dRef.current?.setVisualState(fallbackMode, flatView());
          if (supportsRealImagery && mapLoadedRef.current) applyMapLayerMode(ownedMap, fallbackMode, mode, flatView(), terrainBlockedRef.current, true, building3dRef.current?.isRenderingCustom() ?? false);
          return;
        }
        const errName = event.error && "name" in event.error ? String((event.error as { name?: unknown }).name) : "";
        if (errName === "AbortError" || /\babort(?:ed)?\b/i.test(event.error?.message ?? "")) return;
        if (sourceId?.startsWith("basemap:") || /(?:tile|glyph|sprite|fetch|network|status|AJAX|HTTP)/i.test(event.error.message)) warnTiles();
        else report(event.error);
      });
      ownedMap.on("sourcedata", (event) => {
        if (stopped) return;
        const ev = event as { sourceId?: string; isSourceLoaded?: boolean; dataType?: string; tile?: unknown };
        const sourceId = ev.sourceId;
        const loaded = ev.isSourceLoaded === true;
        if (sourceId && sourceId.startsWith("basemap:") && sourceId !== "basemap:satellite" && sourceId !== "basemap:terrain") {
          if (!scrubbingRef.current && (loaded || ev.tile) && ev.dataType !== "metadata") {
            building3dRef.current?.scheduleSync();
          }
          if (loaded) setBasemapWarning((prev) => (prev ? "" : prev));
        }
      });
      const viewChanged = () => {
        updateFocusLabelPlacement();
        building3dRef.current?.scheduleSync();
        if (scrubbingRef.current) return;
        if (rotationFrame && ownedMap.getZoom() < 3.5) return;
        const center = ownedMap.getCenter();
        const bounds = ownedMap.getBounds();
        const nextZoom = ownedMap.getZoom();
        setViewportScanCenter(
          nextZoom >= 10.8 && isValidLngLat(center.lng, center.lat)
            ? { longitude: Number(center.lng.toFixed(6)), latitude: Number(center.lat.toFixed(6)), zoom: nextZoom }
            : null,
        );
        latest.current.onViewChange?.({ zoom: nextZoom, center: [center.lng, center.lat], pitch: ownedMap.getPitch(), bearing: ownedMap.getBearing(), bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()] });
      };
      ownedMap.on("moveend", viewChanged);
      mapLoadedRef.current = false;
      ownedMap.on("load", () => {
        if (stopped) return;
        mapLoadedRef.current = true;
        ownedMap.setProjection(projection());
        ownedMap.resize();
        applyCameraLightAndSky(ownedMap, layerModeRef.current, mode);
        if (sources["basemap:openmaptiles"]) {
          const buildingSourceId = "basemap:openmaptiles";
          const resolveEffectiveMode = (): MapLayerMode => {
            const active = layerModeRef.current;
            return active === "satellite" && (!supportsRealImagery || satelliteBlockedRef.current)
              ? (light ? "street" : "dark")
              : active;
          };
          const controller = createBuilding3DController(ownedMap, {
            sourceId: buildingSourceId,
            initialMode: resolveEffectiveMode(),
            initialFlat: flatView(),
            onCustomStateChange: (active) => {
              if (!stopped) syncNative3dExtrusionLayers(ownedMap, resolveEffectiveMode(), flatView(), active);
            },
          });
          building3dRef.current = controller;
          controller.attach();
        }
        if (supportsRealImagery) {
          applyMapLayerMode(ownedMap, layerModeRef.current, mode, flatView(), terrainBlockedRef.current, satelliteBlockedRef.current, building3dRef.current?.isRenderingCustom() ?? false);
        }
        if (userFixRef.current) {
          syncUserLocationRef.current(ownedMap, userFixRef.current, activeMapFocus(latest.current.focus, latest.current.selectedJobId));
        }
        syncZoomHudDomRef.current(ownedMap.getZoom(), ownedMap.getPitch(), false);
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
            if (userFixRef.current && userFixRef.current.source !== "ip") return;
            ownedMap.stop();
            if (mode === "domestic") ownedMap.jumpTo({ center: [104, 35], zoom: 3.1, ...perspective() });
            else frameWideGlobe();
            return;
          }
          const cap = Number.isFinite(latest.current.boundsMaxZoom) ? latest.current.boundsMaxZoom! : 16;
          const mutableBounds: [number, number, number, number] = [bounds[0], bounds[1], bounds[2], bounds[3]];
          if (mode === "global" && !flatView() && wideGlobeBounds(mutableBounds)) { frameWideGlobe(mutableBounds); return; }
          ownedMap.stop();
          ownedMap.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: { top: 76, bottom: 78, left: 42, right: 48 }, duration: motion.matches || !entrance ? 0 : 900, maxZoom: Math.min(16, Math.max(1, cap)), ...perspective(true) });
        };
        const focus = (target: NonNullable<AtlasPrototypeProps["focus"]>) => { const options = mapFocusCameraOptions(target, provider?.maxZoom ?? 22, motion.matches); if (!options) return; stopRotation(); ownedMap.stop(); ownedMap.flyTo({ ...options, ...(flatView() ? { pitch: 0, bearing: 0 } : {}) }); };
        let focusedFeatureIds: string[] = [];
        const syncFocusedBucketLabels = (target: ReturnType<typeof activeMapFocus>, current: AtlasPrototypeProps) => {
          const setter = (ownedMap as { setFeatureState?: (feature: { source: string; id: string }, state: Record<string, unknown>) => void }).setFeatureState;
          if (!setter) return;
          for (const id of focusedFeatureIds) {
            try { setter.call(ownedMap, { source: "buckets", id }, { focused: false }); } catch { /* Ignore unloaded tiles */ }
          }
          focusedFeatureIds = [];
          if (!target) return;
          const matchingBuckets = current.buckets.filter(
            bucket => (target.locationId && bucket.locationIds?.includes(target.locationId))
              || (Math.abs(bucket.longitude - target.longitude) < 1e-4 && Math.abs(bucket.latitude - target.latitude) < 1e-4),
          );
          const matchingIds = new Set<string>();
          for (const bucket of matchingBuckets) {
            matchingIds.add(`core:${bucket.id}`);
            if (coordinateStackByBucket.current.has(bucket.id)) {
              matchingIds.add(`stack:${bucket.longitude},${bucket.latitude}`);
            }
          }
          for (const id of matchingIds) {
            try { setter.call(ownedMap, { source: "buckets", id }, { focused: true }); focusedFeatureIds.push(id); } catch { /* Ignore unloaded tiles */ }
          }
        };
        const highlight = (current: AtlasPrototypeProps) => {
          const target = activeMapFocus(current.focus, current.selectedJobId);
          const signature = target ? JSON.stringify(target) : "";
          syncFocusedBucketLabels(target, current);
          if (signature === markerSignature) return;
          focusMarker?.remove(); focusMarker = undefined; markerSignature = signature;
          if (target) {
            focusMarker = new Marker({ element: createMapFocusMarker(document, target, light), anchor: "center", pitchAlignment: "viewport", rotationAlignment: "viewport" })
              .setLngLat([target.longitude, target.latitude]).addTo(ownedMap);
            updateFocusLabelPlacement();
          }
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
        let nearbyCompaniesSignature = "";
        const update = (current: AtlasPrototypeProps) => {
          updateFacts(current); highlight(current);
          const nextNearbySig = JSON.stringify([current.selectedNearbyCompanyId ?? "", current.nearbyCompanies ?? []]);
          if (nextNearbySig !== nearbyCompaniesSignature) {
            nearbyCompaniesSignature = nextNearbySig;
            (ownedMap.getSource?.("nearby-companies") as GeoJSONSource | undefined)?.setData(
              buildNearbyCompaniesGeoJson(current.nearbyCompanies ?? [], current.selectedNearbyCompanyId) as Parameters<GeoJSONSource["setData"]>[0],
            );
          }
          const nextViewMode = current.visual?.viewMode ?? "spatial";
          if (nextViewMode !== viewMode) {
            viewMode = nextViewMode;
            stopRotation(); ownedMap.stop();
            ownedMap.setProjection(projection());
            for (const layer of reliefLayers) ownedMap.setLayoutProperty(layer.id, "visibility", flatView() ? "none" : "visible");
            const activeMode = layerModeRef.current === "satellite" && (!supportsRealImagery || satelliteBlockedRef.current)
              ? (light ? "street" : "dark")
              : layerModeRef.current;
            building3dRef.current?.setVisualState(activeMode, flatView());
            if (!flatView()) building3dRef.current?.scheduleSync(true);
            if (supportsRealImagery) applyMapLayerMode(ownedMap, layerModeRef.current, mode, flatView(), terrainBlockedRef.current, satelliteBlockedRef.current, building3dRef.current?.isRenderingCustom() ?? false);
            ownedMap.easeTo({ ...perspective(), duration: motion.matches || current.visual?.animateViewChange !== true ? 0 : 240 });
          }
          const highlightSource = ownedMap.getSource("admin-highlight") as GeoJSONSource | undefined;
          const nextBoundaryGeometry = current.adminBoundary?.geoJson ?? null;
          if (highlightSource && boundaryGeometry !== nextBoundaryGeometry) {
            highlightSource.setData((nextBoundaryGeometry ?? { type: "FeatureCollection", features: [] }) as Parameters<GeoJSONSource["setData"]>[0]);
            boundaryGeometry = nextBoundaryGeometry;
          }
          // When a finer-grained administrative boundary is active, suppress the coarse Natural Earth boundary and 3D extrusion
          // for the selected province so they do not overlap or cut across coastlines.
          const boundaryFilter = current.adminBoundary && current.selectedRegionId ? current.selectedRegionId : "";
          if (boundaryFilter !== boundaryFilterSignature) {
            const filter: FilterSpecification | null = boundaryFilter ? ["!=", ["get", "id"], boundaryFilter] : null;
            if (ownedMap.getLayer("boundaries")) ownedMap.setFilter("boundaries", filter);
            if (ownedMap.getLayer("boundary-casing")) ownedMap.setFilter("boundary-casing", filter);
            if (ownedMap.getLayer("regions")) ownedMap.setFilter("regions", filter);
            boundaryFilterSignature = boundaryFilter;
          }
          if (rotating !== (current.visual?.autoRotate === true)) { rotating = current.visual?.autoRotate === true; rotate(); }
        };
        handle.current = { fit, update, focus, dispose: () => { building3dRef.current?.dispose(); building3dRef.current = null; focusMarker?.remove(); userLocationMarkerRef.current?.remove(); userLocationMarkerRef.current = null; ownedMap.getCanvas().removeEventListener("webglcontextlost", lost); ownedMap.getCanvas().removeEventListener("webglcontextrestored", restored); } };
        update(latest.current);
        if (latest.current.focus && latest.current.focus !== openingFocus) focus(latest.current.focus);
        else if (latest.current.bounds) fit();
        else if (savedView) ownedMap.jumpTo({ ...savedView, ...(flatView() ? { pitch: 0, bearing: 0 } : {}) });
        else if (latest.current.focus) focus(latest.current.focus);
        else fit();
        // Silently display user's current location when permission was already granted, without hijacking initial framing.
        try {
          const geoApi = typeof navigator !== "undefined" ? navigator.geolocation : undefined;
          const permApi = typeof navigator !== "undefined" ? navigator.permissions : undefined;
          if (geoApi && permApi?.query && geoWatchIdRef.current === null) {
            void permApi.query({ name: "geolocation" as PermissionName }).then((perm) => {
              if (!stopped && perm.state === "granted" && geoWatchIdRef.current === null && !geoCancelRef.current) {
                startGeolocationWatchRef.current(false, false);
              }
            }).catch(() => {});
          }
        } catch { /* Ignore unsupported permissions API */ }
        observer = new ResizeObserver(() => {
          if (resizeFrame) cancelAnimationFrame(resizeFrame);
          resizeFrame = requestAnimationFrame(() => {
          resizeFrame = 0;
          if (stopped || element.clientWidth <= 0 || element.clientHeight <= 0) return;
          ownedMap.resize();
          if (userMoved || mode !== "global") return;
          const target = latest.current.bounds;
          if (target && !wideGlobeBounds([target[0], target[1], target[2], target[3]])) return;
          const zoom = globeFillZoom(element.clientWidth, element.clientHeight);
          if (Math.abs(ownedMap.getZoom() - zoom) > 0.08) ownedMap.jumpTo({ center: ownedMap.getCenter().toArray() as [number, number], zoom });
          });
        }); observer.observe(element);
        ownedMap.once("render", () => { if (!stopped) { latest.current.onReady?.(); viewChanged(); } }); rotate();
      });
      ownedMap.on("click", (event) => {
        if (pickUserLocationRef.current) {
          pickUserLocationRef.current = false;
          const canvas = ownedMap.getCanvas();
          if (canvas) canvas.style.cursor = "grab";
          const lngLat = event.lngLat;
          if (lngLat && isValidLngLat(lngLat.lng, lngLat.lat)) {
            applyUserLocationFixRef.current({
              longitude: Number(lngLat.lng.toFixed(6)),
              latitude: Number(lngLat.lat.toFixed(6)),
              accuracyMeters: 0,
              heading: null,
              speedMps: null,
              timestamp: Date.now(),
              source: "manual",
            }, true);
          } else {
            cancelManualPickMode();
          }
          return;
        }
        if (!ownedMap.getLayer("bucket-cores")) return;
        setHoverCard(null);
        setHoverNearbyCard(null);
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
        const nearbyLayers = [
          ...(ownedMap.getLayer?.("nearby-company-cores") ? ["nearby-company-cores"] : []),
          ...(ownedMap.getLayer?.("nearby-company-labels") ? ["nearby-company-labels"] : []),
        ];
        if (nearbyLayers.length > 0 && (latest.current.nearbyCompanies?.length ?? 0) > 0) {
          const nearbyHits = ownedMap.queryRenderedFeatures(box, { layers: nearbyLayers });
          const hitId = String((nearbyHits[0]?.properties as { companyId?: unknown } | undefined)?.companyId ?? "");
          const matchedCompany = hitId
            ? latest.current.nearbyCompanies?.find((item) => item.id === hitId)
            : undefined;
          if (matchedCompany) {
            setPickMenu(null);
            latest.current.onSelectNearbyCompany?.(matchedCompany);
            return;
          }
        }
        latest.current.onSelectNearbyCompany?.(null);
        setPickMenu(null);
        if (ownedMap.getZoom() > 6.5) return;
        const region = ownedMap.queryRenderedFeatures(event.point, { layers: ["regions", "overview-land"] })[0]; const feature = boundary.features.find((item) => item.id === String(region?.id ?? ""));
        if (feature) { latest.current.onCountry?.(regionSelection(feature)); const bounds = featureBounds(feature); stopRotation(); ownedMap.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: 65, maxZoom: 9, duration: motion.matches ? 0 : 1200, pitch: flatView() ? 0 : mode === "domestic" ? 40 : 15 }); }
      });
      const hover = createAtlasHover<Parameters<Map["queryRenderedFeatures"]>[0]>({ requestFrame: callback => requestAnimationFrame(callback), cancelFrame: id => cancelAnimationFrame(id),
        moving: () => stopped || ownedMap.isMoving() || !!rotationFrame,
        hit: point => {
          if (pickUserLocationRef.current) {
            if (ownedMap.getCanvas().style.cursor !== "crosshair") ownedMap.getCanvas().style.cursor = "crosshair";
            setHoverCard(null);
            setHoverNearbyCard(null);
            return;
          }
          if (!ownedMap.getLayer("bucket-cores")) return;
          const { x, y } = point as { x: number; y: number };
          const nearbyLayers = [
            ...(ownedMap.getLayer?.("nearby-company-cores") ? ["nearby-company-cores"] : []),
            ...(ownedMap.getLayer?.("nearby-company-labels") ? ["nearby-company-labels"] : []),
          ];
          const hits = ownedMap.queryRenderedFeatures([[x - 18, y - 18], [x + 18, y + 18]], { layers: ["bucket-cores", "bucket-rings", ...(ownedMap.getLayer("bucket-stack-markers") ? ["bucket-stack-markers"] : []), ...(ownedMap.getLayer("bucket-labels") ? ["bucket-labels"] : []), ...(ownedMap.getLayer("bucket-detail-labels") ? ["bucket-detail-labels"] : []), ...(ownedMap.getLayer("bucket-stack-labels") ? ["bucket-stack-labels"] : []), ...(ownedMap.getZoom() <= 6.5 ? ["regions"] : [])] });
          const target = rankAtlasBucketHits(hits, latest.current.buckets, { x, y }, bucket => ownedMap.project([bucket.longitude, bucket.latitude]), MAP_HIT_RADIUS_PX, true)[0];
          const nearbyHits = !target && nearbyLayers.length > 0 && (latest.current.nearbyCompanies?.length ?? 0) > 0
            ? ownedMap.queryRenderedFeatures([[x - 16, y - 16], [x + 16, y + 16]], { layers: nearbyLayers })
            : [];
          const nearbyId = String((nearbyHits[0]?.properties as { companyId?: unknown } | undefined)?.companyId ?? "");
          const nearbyTarget = nearbyId
            ? latest.current.nearbyCompanies?.find((item) => item.id === nearbyId) ?? null
            : null;
          const regionHit = hits.some(feature => feature.layer?.id === "regions");
          const cursor = target || nearbyTarget || regionHit ? "pointer" : "grab";
          if (ownedMap.getCanvas().style.cursor !== cursor) ownedMap.getCanvas().style.cursor = cursor;
          setHoverCard(current => {
            if (!target) return null;
            const stackHit = hits.some(feature => feature.layer?.id === "bucket-stack-markers" || feature.layer?.id === "bucket-stack-labels");
            const stack = stackHit ? coordinateStackByBucket.current.get(target.id) : undefined;
            if (current?.bucket.id === target.id && Boolean(current.stack) === Boolean(stack)) return current;
            const projected = ownedMap.project([target.longitude, target.latitude]);
            return { bucket: target, ...(stack ? { stack } : {}), left: Math.max(12, Math.min(projected.x + 14, element.clientWidth - 296)), top: Math.max(12, Math.min(projected.y + 12, element.clientHeight - 108)) };
          });
          setHoverNearbyCard(current => {
            if (!nearbyTarget) return null;
            if (current?.company.id === nearbyTarget.id) return current;
            const projected = ownedMap.project([nearbyTarget.longitude, nearbyTarget.latitude]);
            return {
              company: nearbyTarget,
              left: Math.max(12, Math.min(projected.x + 14, element.clientWidth - 276)),
              top: Math.max(12, Math.min(projected.y + 12, element.clientHeight - 96)),
            };
          });
        },
      });
      cancelHover = hover.cancel;
      let lastPointer: Parameters<Map["queryRenderedFeatures"]>[0] | null = null;
      ownedMap.on("mousemove", event => {
        lastPointer = event.point;
        hover.queue(event.point);
      });
      const leave = () => {
        lastPointer = null;
        hover.cancel();
        ownedMap.getCanvas().style.cursor = "";
        setHoverCard(null);
        setHoverNearbyCard(null);
      };
      ownedMap.getCanvas().addEventListener("mouseleave", leave);
      const pauseInteraction = () => { interacting = true; if (rotationResume) clearTimeout(rotationResume); rotationResume = undefined; stopRotation(); hover.cancel(); setHoverCard(null); setHoverNearbyCard(null); ownedMap.getCanvas().style.cursor = "grabbing"; };
      const resumeInteraction = () => {
        if (rotationResume) clearTimeout(rotationResume);
        ownedMap.getCanvas().style.cursor = pickUserLocationRef.current ? "crosshair" : "grab";
        if (lastPointer) hover.queue(lastPointer);
        rotationResume = setTimeout(() => { rotationResume = undefined; interacting = false; rotate(); }, 700);
      };
      ownedMap.on("dragstart", () => { userMoved = true; pauseInteraction(); }); ownedMap.on("wheel", () => { userMoved = true; }); ownedMap.on("dragend", resumeInteraction); ownedMap.on("zoomstart", pauseInteraction); ownedMap.on("zoomend", resumeInteraction);
      ownedMap.on("rotatestart", pauseInteraction); ownedMap.on("rotateend", resumeInteraction); ownedMap.on("pitchstart", pauseInteraction); ownedMap.on("pitchend", resumeInteraction);
      ownedMap.on("movestart", () => { setPickMenu(null); setHoverCard(null); setHoverNearbyCard(null); });
      abort.signal.addEventListener("abort", () => ownedMap.getCanvas().removeEventListener("mouseleave", leave), { once: true });
    })().catch(report);
    return () => {
      stopped = true;
      abort.abort();
      stopRotation();
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      if (scrubFrameRef.current) {
        cancelAnimationFrame(scrubFrameRef.current);
        scrubFrameRef.current = 0;
      }
      if (rotationResume) clearTimeout(rotationResume);
      if (scrubSettleTimerRef.current) {
        clearTimeout(scrubSettleTimerRef.current);
        scrubSettleTimerRef.current = undefined;
      }
      if (terrainSyncTimer) clearTimeout(terrainSyncTimer);
      scrubbingRef.current = false;
      scrubTargetRef.current = null;
      cancelHover();
      observer?.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      motion.removeEventListener("change", motionChange);
      handle.current?.dispose();
      handle.current = null;
      mapInstanceRef.current = null;
      mapLoadedRef.current = false;
      pickUserLocationRef.current = false;
      stopGeolocationTracking();
      cancelStreetAssist();
      map?.remove();
    };
  }, [mode, background, maxDpr, entrance, basemapKey, light, supportsRealImagery]);
  useEffect(() => {
    handle.current?.update(latest.current);
    if (userFixRef.current && mapInstanceRef.current && mapLoadedRef.current) {
      syncUserLocationRef.current(mapInstanceRef.current, userFixRef.current, activeMapFocus(props.focus, props.selectedJobId));
    }
  }, [props.buckets, props.selectedBucketId, props.selectedRegionId, props.focus, props.selectedJobId, props.visual?.autoRotate, props.visual?.viewMode, props.visual?.animateViewChange, props.adminBoundary, props.nearbyCompanies, props.selectedNearbyCompanyId]);
  useEffect(() => { handle.current?.fit(props.bounds); }, [props.bounds, props.boundsMaxZoom, props.framingKey]);
  useEffect(() => { if (props.focus) handle.current?.focus?.(props.focus); }, [props.focus]);
  useEffect(() => {
    const target = props.focusNearbyCompany;
    const ownedMap = mapInstanceRef.current;
    if (!target || !ownedMap || target.requestId === lastFocusedCompanyReqRef.current) return;
    lastFocusedCompanyReqRef.current = target.requestId;
    const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const maxZoom = basemap?.maxZoom ?? 22;
    const targetZoom = Math.min(maxZoom, Math.max(ownedMap.getZoom?.() ?? 0, 16.2));
    ownedMap.stop();
    ownedMap.flyTo({
      center: [target.longitude, target.latitude],
      zoom: targetZoom,
      pitch: flatViewMode ? 0 : 44,
      curve: 1.35,
      duration: reduced ? 0 : 650,
    });
  }, [props.focusNearbyCompany, basemap?.maxZoom, flatViewMode]);
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
  useEffect(() => {
    syncZoomHudDomRef.current(zoomStateRef.current.zoom, flatViewMode ? 0 : zoomStateRef.current.pitch, zoomStateRef.current.zooming);
  }, [flatViewMode]);
  useEffect(() => {
    if (userLocation.phase !== "picking" || typeof window === "undefined") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancelManualPickMode();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [userLocation.phase]);
  const visibleFocus = activeMapFocus(props.focus, props.selectedJobId);
  const initialTelemetry = resolveZoomTelemetry(zoomStateRef.current.zoom, minSliderZoom, maxSliderZoom);
  const flyToZoomPreset = (targetZoom: number, targetPitch: number) => {
    const ownedMap = mapInstanceRef.current;
    if (!ownedMap) return;
    const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const maxZoom = basemap?.maxZoom ?? 22;
    const center = visibleFocus
      ? ([visibleFocus.longitude, visibleFocus.latitude] as [number, number])
      : ([ownedMap.getCenter().lng, ownedMap.getCenter().lat] as [number, number]);
    ownedMap.stop();
    ownedMap.flyTo({
      center,
      zoom: Math.min(maxZoom, targetZoom),
      pitch: flatViewMode ? 0 : targetPitch,
      curve: 1.35,
      duration: reduced ? 0 : 750,
    });
  };
  const scrubZoom = (nextZoom: number) => {
    const ownedMap = mapInstanceRef.current;
    if (!ownedMap) return;
    const targetZoom = Math.max(minSliderZoom, Math.min(maxSliderZoom, nextZoom));
    scrubbingRef.current = true;
    scrubTargetRef.current = targetZoom;
    syncZoomHudDomRef.current(targetZoom, zoomStateRef.current.pitch, true);
    const applyScrub = () => {
      scrubFrameRef.current = 0;
      const queuedZoom = scrubTargetRef.current;
      scrubTargetRef.current = null;
      if (queuedZoom === null || mapInstanceRef.current !== ownedMap) return;
      ownedMap.stop();
      ownedMap.jumpTo({ zoom: queuedZoom });
    };
    if (!scrubFrameRef.current) {
      if (typeof requestAnimationFrame === "function") scrubFrameRef.current = requestAnimationFrame(applyScrub);
      else applyScrub();
    }
    if (scrubSettleTimerRef.current) clearTimeout(scrubSettleTimerRef.current);
    scrubSettleTimerRef.current = setTimeout(() => {
      scrubSettleTimerRef.current = undefined;
      scrubbingRef.current = false;
      if (mapInstanceRef.current !== ownedMap) return;
      syncZoomHudDomRef.current(ownedMap.getZoom(), ownedMap.getPitch(), false);
      const center = ownedMap.getCenter();
      const bounds = ownedMap.getBounds();
      latest.current.onViewChange?.({
        zoom: ownedMap.getZoom(),
        center: [center.lng, center.lat],
        pitch: ownedMap.getPitch(),
        bearing: ownedMap.getBearing(),
        bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
      });
      if (supportsRealImagery && layerModeRef.current === "satellite" && !flatViewMode && !terrainBlockedRef.current) {
        syncTerrainForLayerState(ownedMap, layerModeRef.current, flatViewMode, terrainBlockedRef.current);
      }
    }, 160);
  };
  const nudgeZoom = (delta: number) => {
    const ownedMap = mapInstanceRef.current;
    if (!ownedMap) return;
    const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const targetZoom = Math.max(minSliderZoom, Math.min(maxSliderZoom, ownedMap.getZoom() + delta));
    ownedMap.stop();
    ownedMap.easeTo({ zoom: targetZoom, duration: reduced ? 0 : 220 });
  };
  const togglePitch = () => {
    const ownedMap = mapInstanceRef.current;
    if (!ownedMap || flatViewMode) return;
    const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const tilted = ownedMap.getPitch() > 12;
    ownedMap.stop();
    ownedMap.easeTo({ pitch: tilted ? 0 : 48, bearing: tilted ? 0 : -12, duration: reduced ? 0 : 380 });
  };
  const renderStreetSearchAssist = (cityHint?: string) => (
    <>
      <form className="atlas-street-search-form" onSubmit={handleStreetSearchSubmit}>
        <input
          type="search"
          className="atlas-street-search-input"
          value={streetQuery}
          onChange={(event) => {
            setStreetQuery(event.target.value);
            if (!event.target.value.trim()) {
              setStreetCandidates([]);
              setStreetSearchedEmpty(false);
            }
          }}
          placeholder={cityHint ? `搜${cityHint}街道 / 小区 / 地铁站…` : "输入街道 / 路名 / 地标精准定位…"}
          aria-label="输入街道或地标精准定位"
        />
        <button
          type="submit"
          className="atlas-geolocate-action atlas-street-search-submit"
          disabled={streetSearching || !streetQuery.trim()}
        >
          {streetSearching ? "搜索中…" : "定到街道"}
        </button>
      </form>
      {streetCandidates.length > 0 && (
        <div className="atlas-street-search-results" role="listbox" aria-label="街道定位候选">
          {streetCandidates.map((hit) => (
            <button
              key={hit.id}
              type="button"
              role="option"
              aria-selected={false}
              className="atlas-street-candidate-btn"
              onClick={() => selectStreetCandidate(hit)}
            >
              <strong>{hit.streetLabel}</strong>
              <span>{hit.label}</span>
            </button>
          ))}
        </div>
      )}
      {streetSearchedEmpty && streetCandidates.length === 0 && (
        <div className="atlas-street-search-empty">
          未匹配到街道，可补充路名或用「地图点选」
        </div>
      )}
    </>
  );
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
          {visibleOfficeBuckets.length > 0 ? visibleOfficeBuckets.map((candidate, index) => {
            const addrParts = splitAtlasAddressDisplay(candidate.label);
            return <button
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
              <span className="atlas-map-location-main"><strong>{addrParts.primary}</strong><small>{candidate.jobCount.toLocaleString()} 个岗位</small></span>
              {addrParts.secondary && <span className="atlas-map-location-sub">{addrParts.secondary}</span>}
              <span className="atlas-map-location-precision">{mapBucketPrecisionLabel(candidate)}</span>
            </button>;
          }) : <p className="atlas-map-location-empty">没有匹配的来源地址。试试街道名或楼宇名。</p>}
        </div>
        <p className="atlas-map-location-note">仅列出来源披露或本人核对的建筑、街道、地址坐标；城市级估算不会绘制成办公点。</p>
      </div>}
    </>}
    {hoverCard && !pickMenu && (() => {
      const hoverAddr = hoverCard.stack ? null : splitAtlasAddressDisplay(hoverCard.bucket.label);
      return <div className={`atlas-map-hover-card${light ? " light" : ""}`} style={{ left: hoverCard.left, top: hoverCard.top }}>{hoverCard.stack ? <><strong>{hoverCard.stack.locationCount.toLocaleString()} 个来源地址共用此坐标</strong><span>{hoverCard.stack.jobCount.toLocaleString()} 个岗位 · 点击展开逐个选择</span></> : <><strong>{hoverAddr!.primary}</strong>{hoverAddr!.secondary && <span className="atlas-hover-subaddr">{hoverAddr!.secondary}</span>}<span>{hoverCard.bucket.jobCount.toLocaleString()} 个岗位 · {mapBucketPrecisionLabel(hoverCard.bucket)}</span></>}</div>;
    })()}
    {hoverNearbyCard && !hoverCard && !pickMenu && (
      <div className={`atlas-map-hover-card is-nearby-company${light ? " light" : ""}`} style={{ left: hoverNearbyCard.left, top: hoverNearbyCard.top }}>
        <strong>
          <i className="atlas-nearby-dot" style={{ background: hoverNearbyCard.company.ownershipColor }} aria-hidden="true" />
          {hoverNearbyCard.company.name}
        </strong>
        {hoverNearbyCard.company.streetAddress && <span className="atlas-hover-subaddr">{hoverNearbyCard.company.streetAddress}</span>}
        <span>
          {hoverNearbyCard.company.ownershipLabel} · 距定位 {formatDistanceLabel(hoverNearbyCard.company.distanceMeters)}
          {hoverNearbyCard.company.indexedJobCount ? ` · 库内 ${hoverNearbyCard.company.indexedJobCount} 岗` : " · 点击查在招"}
        </span>
      </div>
    )}
    {(() => {
      const selectedCompany = props.selectedNearbyCompanyId
        ? props.nearbyCompanies?.find((item) => item.id === props.selectedNearbyCompanyId)
        : undefined;
      if (!selectedCompany) return null;
      return (
        <div className={`atlas-nearby-selected-card${light ? " light" : ""}${props.adminBoundary ? " has-admin-boundary" : ""}`} role="dialog" aria-label={`周边企业 ${selectedCompany.name}`}>
          <div className="atlas-nearby-selected-head">
            <div className="atlas-nearby-selected-title">
              <span className="atlas-nearby-dot" style={{ background: selectedCompany.ownershipColor }} aria-hidden="true" />
              <strong>{selectedCompany.name}</strong>
            </div>
            <button
              type="button"
              className="atlas-nearby-selected-close"
              aria-label="关闭企业卡片"
              onClick={() => latest.current.onSelectNearbyCompany?.(null)}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </div>
          <div className="atlas-nearby-selected-meta">
            <span>{selectedCompany.ownershipLabel}</span>
            <span>距中心 {formatDistanceLabel(selectedCompany.distanceMeters)}</span>
            {selectedCompany.streetAddress && <span>{selectedCompany.streetAddress}</span>}
            <span>{selectedCompany.sourceTag === "street-web" ? "街道公开信息 · 全工种可查" : "地图企业 · 非限软件岗"}</span>
          </div>
          {selectedCompany.ownershipReason && (
            <p className="atlas-nearby-selected-reason">{selectedCompany.ownershipReason}</p>
          )}
          <div className="atlas-nearby-selected-actions">
            <button
              type="button"
              className="atlas-nearby-primary-action"
              onClick={() => latest.current.onSearchNearbyCompanyJobs?.(selectedCompany)}
            >
              {selectedCompany.indexedJobCount
                ? `查看库内 ${selectedCompany.indexedJobCount} 个在招岗（不限工种）`
                : `全网搜「${selectedCompany.searchKeyword}」全职能岗`}
            </button>
            {Boolean(selectedCompany.indexedJobCount) && latest.current.onFilterNearbyCompanyJobs && (
              <button
                type="button"
                className="atlas-nearby-secondary-action"
                onClick={() => latest.current.onFilterNearbyCompanyJobs?.(selectedCompany)}
              >
                全网补搜
              </button>
            )}
          </div>
        </div>
      );
    })()}
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
    <a href={`${import.meta.env.BASE_URL}legal/geography/`} target="_blank" rel="noopener noreferrer" style={{ ...creditStyle, left: 12, bottom: 38, padding: "2px 8px", borderRadius: 6, fontSize: 10.5, lineHeight: 1.4, fontWeight: 500, background: light ? "#ffffff" : "#0b141d", border: light ? "1px solid rgba(15, 118, 110, 0.22)" : "1px solid rgba(148, 163, 184, 0.26)", color: light ? "#2d4a43" : "#dce9f5", pointerEvents: "auto", textDecoration: "none" }}>{NATURAL_EARTH_CREDIT}</a>
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
          fontSize: "var(--atlas-boundary-font-size, 12px)",
          fontWeight: 600,
          letterSpacing: "0.02em",
          background: light ? "#ffffff" : "#0a141e",
          color: props.adminBoundary.color,
          border: `1.5px solid ${props.adminBoundary.color}`,
          boxShadow: `0 4px 14px rgba(0, 0, 0, 0.24), 0 0 10px ${props.adminBoundary.glowColor}33`,
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
    {visibleFocus && (() => {
      const focusSubject = visibleFocus.label ? formatAtlasAddress(visibleFocus.label).conciseLabel || visibleFocus.label : "";
      const focusPlace = visibleFocus.locationLabel ? formatAtlasAddress(visibleFocus.locationLabel).conciseLabel : "";
      const placeSegment = focusPlace && focusPlace !== focusSubject ? ` · ${focusPlace}` : "";
      return <div className={`atlas-focus-status${light ? " light" : ""}${basemapWarning ? " has-warning" : ""}`} role="status" aria-live="polite">已定位{focusSubject ? `：${focusSubject}${placeSegment} · ` : focusPlace ? `：${focusPlace} · ` : " · "}{mapFocusCompactPrecisionLabel(visibleFocus)}</div>;
    })()}
    <div className={`atlas-map-geolocate-bar${supportsRealImagery ? " has-layer-switcher" : ""}${layerMode === "street" || light ? " light" : ""}`} role="group" aria-label="当前位置定位">
      {userLocation.phase === "active" && userLocation.fix.source === "ip" && !ipRefineNoticeDismissed && (
        <div className="atlas-user-location-notice is-approximate" role="status" aria-live="polite">
          <div className="atlas-user-location-header">
            <div className="atlas-user-location-copy">
              <span className="atlas-user-location-summary">
                {userLocation.fix.placeLabel ?? "当前城市"}网络定位（城市级），可微调位置
              </span>
              {(userLocation.fix.coreLocationStatus === "denied" || userLocation.fix.coreLocationStatus === "not_determined_timeout") && (
                <span className="atlas-user-location-hint">
                  {userLocation.fix.coreLocationStatus === "denied"
                    ? "系统定位未授权，可授信后精准重试或搜街道"
                    : "系统定位等待授权超时，可直接搜街道或点选"}
                </span>
              )}
            </div>
            <div className="atlas-user-location-actions">
              <button
                type="button"
                className="atlas-geolocate-action atlas-geolocate-pick-btn"
                onClick={enterManualPickMode}
              >
                地图点选
              </button>
              <button
                type="button"
                className="atlas-geolocate-action atlas-geolocate-retry-btn"
                onClick={retryPrecisionLocate}
              >
                精准重试
              </button>
              <button
                type="button"
                className="atlas-geolocate-dismiss"
                aria-label="关闭网络定位提示"
                onClick={() => {
                  resetStreetSearchUi();
                  setIpRefineNoticeDismissed(true);
                }}
              >
                <X size={11} aria-hidden="true" />
              </button>
            </div>
          </div>
          {renderStreetSearchAssist(userLocation.fix.placeLabel)}
        </div>
      )}
      {userLocation.phase === "error" && (
        <div className="atlas-user-location-notice" role="status" aria-live="polite">
          <div className="atlas-user-location-header">
            <span className="atlas-user-location-summary">{userLocation.message}</span>
            <div className="atlas-user-location-actions">
              <button type="button" className="atlas-geolocate-action atlas-geolocate-pick-btn" onClick={enterManualPickMode}>
                地图点选
              </button>
              {userLocation.code !== "unsupported" && (
                <button type="button" className="atlas-geolocate-action atlas-geolocate-retry-btn" onClick={handleLocateUser}>
                  重试
                </button>
              )}
              <button type="button" className="atlas-geolocate-dismiss" aria-label="关闭定位提示" onClick={clearUserLocation}>
                <X size={12} aria-hidden="true" />
              </button>
            </div>
          </div>
          {renderStreetSearchAssist()}
        </div>
      )}
      {userLocation.phase === "picking" && (
        <div className="atlas-user-location-notice is-picking" role="status" aria-live="polite">
          <span>请在地图上点击你的当前位置（Esc 取消）</span>
          <button type="button" className="atlas-geolocate-action" onClick={cancelManualPickMode}>
            取消
          </button>
        </div>
      )}
      <div className="atlas-map-geolocate-pill-row">
        {props.onScanViewportArea && userLocation.phase !== "picking" && viewportScanCenter && viewportScanCenter.zoom >= 10.8 && (
          !props.radarCenter
          || (haversineDistanceMeters(viewportScanCenter, props.radarCenter) ?? 999) > (viewportScanCenter.zoom >= 14 ? 260 : 600)
        ) && (
          <button
            type="button"
            className="atlas-map-scan-area-btn"
            disabled={scanningViewportArea}
            onClick={() => void handleScanViewportArea()}
            title="扫描当前地图视野中心周围 2.5km 的全部企业与园区（不限岗位类型）"
          >
            {scanningViewportArea ? <LoaderCircle size={12} className="atlas-spin" aria-hidden="true" /> : <Compass size={12} aria-hidden="true" />}
            <span>{scanningViewportArea ? "探测中…" : "扫此区域企业"}</span>
          </button>
        )}
        <div className="atlas-map-geolocate-pill">
        <button
          type="button"
          className={`atlas-map-geolocate-btn${userLocation.phase === "active" ? " is-active" : userLocation.phase === "locating" || userLocation.phase === "picking" ? " is-locating" : ""}`}
          aria-pressed={userLocation.phase === "active" || userLocation.phase === "picking"}
          aria-label={userLocation.phase === "active"
            ? `居中到我的当前位置（${formatFixPrecisionLabel(userLocation.fix)}）`
            : userLocation.phase === "locating"
              ? "正在获取当前位置"
              : userLocation.phase === "picking"
                ? "正在地图上点选我的位置，点击取消"
                : "显示并居中我的当前位置"}
          title={userLocation.phase === "picking" ? "点击取消地图点选" : "使用浏览器真实定位或地图点选显示我的当前位置"}
          onClick={handleLocateUser}
        >
          {userLocation.phase === "locating"
            ? <LoaderCircle size={13} className="atlas-spin" aria-hidden="true" />
            : <LocateFixed size={13} aria-hidden="true" />}
          <span>
            {userLocation.phase === "locating"
              ? "定位中…"
              : userLocation.phase === "picking"
                ? "点选地图中…"
                : userLocation.phase === "active"
                  ? (() => {
                      const dist = visibleFocus
                        ? haversineDistanceMeters(userLocation.fix, { longitude: visibleFocus.longitude, latitude: visibleFocus.latitude })
                        : null;
                      const acc = formatFixPrecisionLabel(userLocation.fix);
                      return dist !== null ? `我的位置 · 距此 ${formatDistanceLabel(dist)}` : `我的位置 · ${acc}`;
                    })()
                  : "我的定位"}
          </span>
        </button>
        {userLocation.phase === "active" && (
          <button
            type="button"
            className="atlas-map-geolocate-clear"
            aria-label="隐藏我的当前定位"
            title="隐藏当前定位"
            onClick={clearUserLocation}
          >
            <X size={12} aria-hidden="true" />
          </button>
        )}
        </div>
      </div>
    </div>
    {supportsRealImagery && (
      <div className={`atlas-map-layer-switcher${layerMode === "street" || light ? " light" : ""}`} role="group" aria-label="底图视觉图层">
        <button type="button" className={layerMode === "satellite" ? "is-active" : ""} aria-pressed={layerMode === "satellite"} onClick={() => switchLayerMode("satellite")}>
          <Satellite size={12} aria-hidden="true" />卫星实景
        </button>
        <button type="button" className={layerMode === "street" ? "is-active" : ""} aria-pressed={layerMode === "street"} onClick={() => switchLayerMode("street")}>
          <Sun size={12} aria-hidden="true" />高清街区
        </button>
        <button type="button" className={layerMode === "dark" ? "is-active" : ""} aria-pressed={layerMode === "dark"} onClick={() => switchLayerMode("dark")}>
          <Moon size={12} aria-hidden="true" />深色雷达
        </button>
      </div>
    )}
    <div ref={zoomHudElRef} className={`atlas-map-zoom-hud${light ? " light" : ""}`} role="group" aria-label="缩放尺度与快捷视野">
      <div className="atlas-zoom-hud-row">
        <span className="atlas-zoom-telemetry" aria-live="polite">
          <strong ref={zoomTierRef}>{initialTelemetry.tier}</strong>
          <small ref={zoomValueRef}>z{zoomStateRef.current.zoom.toFixed(1)}</small>
          <span ref={zoomDetailRef} className="atlas-zoom-detail">{initialTelemetry.hint}</span>
        </span>
        <button
          ref={zoomPitchBtnRef}
          type="button"
          className={`atlas-zoom-pitch-btn${!flatViewMode && zoomStateRef.current.pitch > 12 ? " is-tilted" : ""}`}
          disabled={flatViewMode}
          aria-pressed={!flatViewMode && zoomStateRef.current.pitch > 12}
          title={flatViewMode ? "当前为平面视角" : "切换 2.5D 倾斜与垂直俯视"}
          onClick={togglePitch}
        >
          {flatViewMode ? "平面" : zoomStateRef.current.pitch > 12 ? `2.5D · ${Math.round(zoomStateRef.current.pitch)}°` : "俯视"}
        </button>
      </div>
      <div className="atlas-zoom-hud-row">
        <div className="atlas-zoom-scrubber" aria-label="连续缩放调节">
          <button type="button" className="atlas-zoom-step" aria-label="缩小地图" onClick={() => nudgeZoom(-1.2)}>−</button>
          <input
            ref={zoomSliderRef}
            type="range"
            className="atlas-zoom-slider"
            min={minSliderZoom}
            max={maxSliderZoom}
            step={0.1}
            defaultValue={initialTelemetry.clamped}
            aria-label="连续缩放级别"
            style={{ "--zoom-progress": `${initialTelemetry.progress}%` } as CSSProperties}
            onChange={(event) => scrubZoom(Number(event.target.value))}
          />
          <button type="button" className="atlas-zoom-step" aria-label="放大地图" onClick={() => nudgeZoom(1.2)}>+</button>
        </div>
        <div ref={zoomPresetsRef} className="atlas-zoom-presets">
          {ZOOM_PRESET_SPECS.map((preset, index) => (
            <button
              key={preset.key}
              type="button"
              className={initialTelemetry.presetIndex === index ? "is-active" : ""}
              onClick={() => flyToZoomPreset(mode === "domestic" ? preset.domesticZoom : preset.globalZoom, preset.pitch)}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>
    </div>
    {basemapWarning && <div className="atlas-map-basemap-warning" role="status" style={{ position: "absolute", left: "var(--atlas-warning-left, 14px)", top: "var(--atlas-warning-top, 14px)", right: "var(--atlas-warning-right, 58px)", bottom: "var(--atlas-warning-bottom, auto)", zIndex: 3, color: light ? "#725719" : "#ddcf9d", background: light ? "#fff9e9eb" : "#14232ae8", border: "1px solid #8b80504d", borderRadius: 8, padding: "9px 12px", font: "var(--atlas-warning-font, 11px/1.6 system-ui)" }}>{basemapWarning}</div>}
    {failure && <div role="alert" style={errorStyle}>{failure}</div>}
  </div>;
}
export default MapLibrePrototype;
