import type { ExpressionSpecification, Map } from "maplibre-gl";

export const ZOOM_PRESET_SPECS = [
  { key: "overview", label: "全景", domesticZoom: 3.2, globalZoom: 1.75, pitch: 0 },
  { key: "city", label: "城市", domesticZoom: 11.8, globalZoom: 11.8, pitch: 30 },
  { key: "street", label: "街道", domesticZoom: 15.2, globalZoom: 15.2, pitch: 48 },
  { key: "building", label: "楼宇", domesticZoom: 17.2, globalZoom: 17.2, pitch: 54 },
] as const;

export function resolveZoomTelemetry(zoom: number, minZoom: number, maxZoom: number) {
  const tier = zoom >= 16 ? "楼宇" : zoom >= 14.2 ? "街道" : zoom >= 11.5 ? "街区" : zoom >= 8 ? "城市" : zoom >= 4 ? "省域" : "全球";
  const hint = zoom >= 16
    ? "3D 建筑与门牌"
    : zoom >= 14.2
      ? "街巷路名与门店"
      : zoom >= 11.5
        ? "地铁站点与校区"
        : zoom >= 8
          ? "城区干道与水域"
          : zoom >= 4
            ? "省市廓线与枢纽"
            : "全球航路与国界";
  const clamped = Math.max(minZoom, Math.min(maxZoom, Number(zoom.toFixed(1))));
  const progress = Math.max(0, Math.min(100, ((clamped - minZoom) / Math.max(0.1, maxZoom - minZoom)) * 100));
  const presetIndex = zoom < 8 ? 0 : zoom < 14.2 ? 1 : zoom < 16 ? 2 : 3;
  return { tier, hint, clamped, progress, presetIndex };
}

export type MapLayerMode = "satellite" | "street" | "dark";

export const SATELLITE_IMAGERY_TILES = ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"];
export const TERRAIN_DEM_TILES = ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{y}/{x}.png"];

export function buildPoiColorExpr(daylight: boolean): ExpressionSpecification {
  return [
    "match",
    ["get", "class"],
    ["park", "garden", "campsite"], daylight ? "#15803d" : "#6ee7b7",
    ["hospital", "doctors"], daylight ? "#be123c" : "#fda4af",
    ["college", "university", "school", "library", "museum"], daylight ? "#1d4ed8" : "#93c5fd",
    ["cafe", "restaurant", "fast_food", "bakery"], daylight ? "#b45309" : "#fcd34d",
    ["shop", "mall", "commercial", "lodging"], daylight ? "#334155" : "#f1f5f9",
    daylight ? "#334155" : "#e2e8f0",
  ] as unknown as ExpressionSpecification;
}

export const BUILDING_HEIGHT_EXPR = [
  "case",
  ["has", "render_height"],
  ["to-number", ["get", "render_height"], 0],
  ["to-number", ["get", "height"], 0],
] as unknown as ExpressionSpecification;

export function buildBuildingColorExpr(mode: MapLayerMode): ExpressionSpecification {
  if (mode === "street") {
    return [
      "interpolate", ["linear"], BUILDING_HEIGHT_EXPR,
      0, "#e2e8f0",
      12, "#cbd5e1",
      28, "#b0c1d6",
      65, "#8da7c7",
      140, "#6789b0",
    ] as unknown as ExpressionSpecification;
  }
  if (mode === "satellite") {
    return [
      "interpolate", ["linear"], BUILDING_HEIGHT_EXPR,
      0, "#475569",
      24, "#0ea5e9",
      80, "#7dd3fc",
    ] as unknown as ExpressionSpecification;
  }
  return [
    "interpolate", ["linear"], BUILDING_HEIGHT_EXPR,
    0, "#213a54",
    12, "#2f577d",
    30, "#4174a3",
    68, "#5899cc",
    145, "#7ec6f2",
  ] as unknown as ExpressionSpecification;
}

export function buildBuildingEdgePaint(mode: MapLayerMode) {
  if (mode === "street") return { color: "#788da4", opacity: 0.44 };
  if (mode === "satellite") return { color: "#bae6fd", opacity: 0.56 };
  return { color: "#7cc2ef", opacity: 0.48 };
}

export function buildStreetBackgroundPaint(mode: MapLayerMode): unknown {
  if (mode === "street") return ["interpolate", ["linear"], ["zoom"], 6.4, "#9ecae6", 7.8, "#f3f1ec"];
  if (mode === "satellite") return "#040c17";
  return ["interpolate", ["linear"], ["zoom"], 6.4, "#06101a", 7.8, "#0b141f"];
}

export function buildCivicLanduseColorExpr(daylight: boolean): ExpressionSpecification {
  return [
    "match",
    ["get", "class"],
    "hospital", daylight ? "#fce4ec" : "rgba(244,63,94,0.14)",
    ["school", "university", "college"], daylight ? "#e5ebfb" : "rgba(99,102,241,0.14)",
    ["commercial", "retail"], daylight ? "#f3ede2" : "rgba(56,189,248,0.09)",
    "industrial", daylight ? "#e1e5eb" : "rgba(71,85,105,0.19)",
    "parking", daylight ? "#e6e8ec" : "rgba(100,116,139,0.16)",
    ["recreation_ground", "pitch", "stadium", "cemetery"], daylight ? "#d6e9c6" : "rgba(16,185,129,0.16)",
    daylight ? "#dcebd0" : "rgba(16,185,129,0.15)",
  ] as unknown as ExpressionSpecification;
}

export function applyCameraLightAndSky(ownedMap: Map, mode: MapLayerMode, scopeMode: "global" | "domestic") {
  const street = mode === "street";
  const showSat = mode === "satellite";
  ownedMap.setLight?.(
    street
      ? { anchor: "viewport", color: "#fffcf5", intensity: 0.82, position: [1.45, 215, 58] }
      : showSat
        ? { anchor: "viewport", color: "#e0f2fe", intensity: 0.72, position: [1.4, 205, 52] }
        : { anchor: "viewport", color: "#dbeafe", intensity: 0.88, position: [1.45, 205, 56] },
  );
  ownedMap.setSky?.(
    street
      ? { "sky-color": "#cfe5fc", "horizon-color": "#edf4fc", "fog-color": "#f3f1ec", "fog-ground-blend": 0.42, "horizon-fog-blend": 0.6, "sky-horizon-blend": 0.6, "atmosphere-blend": scopeMode === "global" ? 0.78 : 0.22 }
      : showSat
        ? { "sky-color": "#020712", "horizon-color": "#1d4e78", "fog-color": "#07111e", "fog-ground-blend": 0.38, "horizon-fog-blend": 0.6, "sky-horizon-blend": 0.5, "atmosphere-blend": scopeMode === "global" ? 0.92 : 0.3 }
        : { "sky-color": "#060d15", "horizon-color": "#163047", "fog-color": "#0b131d", "fog-ground-blend": 0.48, "horizon-fog-blend": 0.65, "sky-horizon-blend": 0.55, "atmosphere-blend": scopeMode === "global" ? 0.9 : 0.25 },
  );
}

export const STREET_FILL_COLORS: Record<string, string> = {
  water: "#7fc1ec",
  park: "#c6e5b5",
  landuse_park: "#c6e5b5",
  landcover_wood: "#b8dca6",
  landuse_residential: "#eae6dc",
  "aeroway-area": "#dfe3e8",
};

export const WATERWAY_WIDTH_EXPR = ["interpolate", ["linear"], ["zoom"], 8, 0.9, 12, 1.9, 15, 3.4, 18, 6.4] as unknown as ExpressionSpecification;
export const MINOR_ROAD_CASING_WIDTH_EXPR = ["interpolate", ["exponential", 1.55], ["zoom"], 12.2, 2.2, 14, 4.2, 17, 10.5, 20, 23] as unknown as ExpressionSpecification;

export const SATELLITE_ROAD_PAINTS: Record<string, Record<string, unknown>> = {
  highway_motorway_inner: { "line-color": "#fbbf24", "line-opacity": 0.92 },
  highway_motorway_subtle: { "line-color": "#fbbf24", "line-opacity": 0.78 },
  highway_motorway_casing: { "line-color": "rgba(4,9,16,0.82)" },
  highway_major_inner: { "line-color": "#fde68a", "line-opacity": 0.86 },
  highway_major_subtle: { "line-color": "#fde68a", "line-opacity": 0.68 },
  highway_major_casing: { "line-color": "rgba(4,9,16,0.76)" },
  highway_minor: { "line-color": "rgba(255,255,255,0.68)", "line-opacity": 0.94 },
  highway_path: { "line-color": "rgba(241,245,249,0.52)", "line-opacity": 0.88 },
  railway: { "line-color": "#38bdf8", "line-opacity": 0.76 },
  railway_dashline: { "line-color": "#e0f2fe", "line-opacity": 0.62 },
  railway_transit: { "line-color": "#22d3ee", "line-opacity": 0.82 },
  waterway: { "line-color": "#38bdf8", "line-opacity": 0.45, "line-width": WATERWAY_WIDTH_EXPR },
};

export const STREET_ROAD_PAINTS: Record<string, Record<string, unknown>> = {
  highway_motorway_inner: { "line-color": "#fbbf24", "line-opacity": 1 },
  highway_motorway_subtle: { "line-color": "#fcd34d", "line-opacity": 0.92 },
  highway_motorway_casing: { "line-color": "#b45309" },
  highway_major_inner: { "line-color": "#ffffff", "line-opacity": 1 },
  highway_major_subtle: { "line-color": "#f8fafc", "line-opacity": 0.94 },
  highway_major_casing: { "line-color": "#94a3b8" },
  highway_minor: { "line-color": "#ffffff", "line-opacity": 1 },
  highway_path: { "line-color": "#cbd5e1", "line-opacity": 0.96 },
  railway: { "line-color": "#475569", "line-opacity": 0.84 },
  railway_dashline: { "line-color": "#f8fafc", "line-opacity": 0.86 },
  railway_transit: { "line-color": "#0284c7", "line-opacity": 0.78 },
  waterway: { "line-color": "#6cb6e8", "line-opacity": 0.95, "line-width": WATERWAY_WIDTH_EXPR },
};
