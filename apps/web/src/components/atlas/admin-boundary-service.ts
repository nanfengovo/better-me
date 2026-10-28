import manifest from "../../../../../config/geography/china-administrative/source-manifest.json";
import { getChinaDistricts, getChinaCities, getChinaProvinces, type ChinaRegionSelection } from "./china-regions";
import {
  normalizeBoundaryGeometry,
  type AdminGeoJson,
  type GeoJsonFeature,
  type GeoJsonFeatureCollection,
  type BoundaryCoordinateSystem,
} from "./boundary-geometry-normalization";
export type { AdminGeoJson, GeoJsonFeature, GeoJsonFeatureCollection } from "./boundary-geometry-normalization";

export type AdminBoundaryLevel = "province" | "city" | "district";

export type AdminBoundaryColors = {
  stroke: string;
  glow: string;
  fill: string;
};

export const ADMIN_BOUNDARY_COLORS: Record<
  AdminBoundaryLevel,
  {
    dark: AdminBoundaryColors;
    light: AdminBoundaryColors;
    label: string;
  }
> = {
  province: {
    dark: { stroke: "#00f0ff", glow: "#38bdf8", fill: "rgba(0, 240, 255, 0.08)" },
    light: { stroke: "#0284c7", glow: "#38bdf8", fill: "rgba(2, 132, 199, 0.06)" },
    label: "省级行政边界",
  },
  city: {
    dark: { stroke: "#a855f7", glow: "#c084fc", fill: "rgba(168, 85, 247, 0.08)" },
    light: { stroke: "#7c3aed", glow: "#a855f7", fill: "rgba(124, 58, 237, 0.06)" },
    label: "市级行政边界",
  },
  district: {
    dark: { stroke: "#f59e0b", glow: "#fbbf24", fill: "rgba(245, 158, 11, 0.10)" },
    light: { stroke: "#d97706", glow: "#f59e0b", fill: "rgba(217, 119, 6, 0.07)" },
    label: "区县行政边界",
  },
};

export type AdminBoundaryHighlight = {
  level: AdminBoundaryLevel;
  name: string;
  code: string;
  levelLabel: string;
  color: string;
  glowColor: string;
  fillColor: string;
  bounds?: [west: number, south: number, east: number, north: number];
  boundsMaxZoom?: number;
  geoJson: AdminGeoJson;
};

const provinceMapIds: Record<string, string> = manifest.provinceMapIds;
const municipalities = new Set(["11", "12", "31", "50"]);

// All caches contain display-ready WGS84 geometry; never normalize cached data.
const boundaryMemoryCache = new Map<string, AdminGeoJson>();

let chinaProvincesCache: GeoJsonFeatureCollection | null = null;
let shanghaiDistrictsCache: GeoJsonFeatureCollection | null = null;
let beijingDistrictsCache: GeoJsonFeatureCollection | null = null;
let guangdongCitiesCache: GeoJsonFeatureCollection | null = null;
let jiangsuCitiesCache: GeoJsonFeatureCollection | null = null;
let zhejiangCitiesCache: GeoJsonFeatureCollection | null = null;

let shanghaiOfficialCache: GeoJsonFeatureCollection | null = null;
let beijingOfficialCache: GeoJsonFeatureCollection | null = null;
let tianjinOfficialCache: GeoJsonFeatureCollection | null = null;
let chongqingOfficialCache: GeoJsonFeatureCollection | null = null;

async function loadBundledShanghaiOfficial(): Promise<GeoJsonFeatureCollection> {
  if (shanghaiOfficialCache) return shanghaiOfficialCache;
  shanghaiOfficialCache = await loadGeoJsonAsset(
    () => import("./geo/shanghai-official-boundary.geojson?url"),
    "./geo/shanghai-official-boundary.geojson", "GCJ-02"
  );
  return shanghaiOfficialCache;
}

async function loadBundledBeijingOfficial(): Promise<GeoJsonFeatureCollection> {
  if (beijingOfficialCache) return beijingOfficialCache;
  beijingOfficialCache = await loadGeoJsonAsset(
    () => import("./geo/beijing-official-boundary.geojson?url"),
    "./geo/beijing-official-boundary.geojson", "GCJ-02"
  );
  return beijingOfficialCache;
}

async function loadBundledTianjinOfficial(): Promise<GeoJsonFeatureCollection> {
  if (tianjinOfficialCache) return tianjinOfficialCache;
  tianjinOfficialCache = await loadGeoJsonAsset(
    () => import("./geo/tianjin-official-boundary.geojson?url"),
    "./geo/tianjin-official-boundary.geojson", "GCJ-02"
  );
  return tianjinOfficialCache;
}

async function loadBundledChongqingOfficial(): Promise<GeoJsonFeatureCollection> {
  if (chongqingOfficialCache) return chongqingOfficialCache;
  chongqingOfficialCache = await loadGeoJsonAsset(
    () => import("./geo/chongqing-official-boundary.geojson?url"),
    "./geo/chongqing-official-boundary.geojson", "GCJ-02"
  );
  return chongqingOfficialCache;
}

// Legacy asset filenames say "official"; they are DataV visualization data,
// not certified cadastral/coastline geometry. See geo/NOTICE.md for provenance.
const MUNICIPALITY_LOADERS: Record<string, () => Promise<GeoJsonFeatureCollection>> = {
  "31": loadBundledShanghaiOfficial,
  "11": loadBundledBeijingOfficial,
  "12": loadBundledTianjinOfficial,
  "50": loadBundledChongqingOfficial,
};

async function loadGeoJsonAsset(
  loader: () => Promise<{ default: string }>,
  relativePath: string,
  coordinateSystem: BoundaryCoordinateSystem
): Promise<GeoJsonFeatureCollection> {
  let geoJson: GeoJsonFeatureCollection;
  if (typeof window === "undefined") {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const fullPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), relativePath);
    geoJson = JSON.parse(fs.readFileSync(fullPath, "utf-8")) as GeoJsonFeatureCollection;
  } else {
    const asset = await loader();
    const res = await fetch(asset.default);
    geoJson = (await res.json()) as GeoJsonFeatureCollection;
  }
  return normalizeBoundaryGeometry({ geoJson, coordinateSystem }).geoJson;
}

async function loadBundledProvinces(): Promise<GeoJsonFeatureCollection> {
  if (chinaProvincesCache) return chinaProvincesCache;
  chinaProvincesCache = await loadGeoJsonAsset(
    () => import("./geo/china-provinces-10m.geojson?url"),
    "./geo/china-provinces-10m.geojson", "WGS84"
  );
  return chinaProvincesCache;
}

async function loadBundledShanghaiDistricts(): Promise<GeoJsonFeatureCollection> {
  if (shanghaiDistrictsCache) return shanghaiDistrictsCache;
  shanghaiDistrictsCache = await loadGeoJsonAsset(
    () => import("./geo/shanghai-districts.geojson?url"),
    "./geo/shanghai-districts.geojson", "GCJ-02"
  );
  return shanghaiDistrictsCache;
}

async function loadBundledBeijingDistricts(): Promise<GeoJsonFeatureCollection> {
  if (beijingDistrictsCache) return beijingDistrictsCache;
  beijingDistrictsCache = await loadGeoJsonAsset(
    () => import("./geo/beijing-districts.geojson?url"),
    "./geo/beijing-districts.geojson", "GCJ-02"
  );
  return beijingDistrictsCache;
}

async function loadBundledGuangdongCities(): Promise<GeoJsonFeatureCollection> {
  if (guangdongCitiesCache) return guangdongCitiesCache;
  guangdongCitiesCache = await loadGeoJsonAsset(
    () => import("./geo/guangdong-cities.geojson?url"),
    "./geo/guangdong-cities.geojson", "GCJ-02"
  );
  return guangdongCitiesCache;
}

async function loadBundledJiangsuCities(): Promise<GeoJsonFeatureCollection> {
  if (jiangsuCitiesCache) return jiangsuCitiesCache;
  jiangsuCitiesCache = await loadGeoJsonAsset(
    () => import("./geo/jiangsu-cities.geojson?url"),
    "./geo/jiangsu-cities.geojson", "GCJ-02"
  );
  return jiangsuCitiesCache;
}

async function loadBundledZhejiangCities(): Promise<GeoJsonFeatureCollection> {
  if (zhejiangCitiesCache) return zhejiangCitiesCache;
  zhejiangCitiesCache = await loadGeoJsonAsset(
    () => import("./geo/zhejiang-cities.geojson?url"),
    "./geo/zhejiang-cities.geojson", "GCJ-02"
  );
  return zhejiangCitiesCache;
}

/** Compute bounding box [west, south, east, north] from GeoJSON coordinates */
export function calculateGeoJsonBounds(
  geoJson: AdminGeoJson
): [number, number, number, number] | undefined {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;

  function processCoordinates(coords: unknown) {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === "number" && typeof coords[1] === "number") {
      const lng = coords[0];
      const lat = coords[1];
      if (lng < west) west = lng;
      if (lng > east) east = lng;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    } else {
      for (const item of coords) {
        processCoordinates(item);
      }
    }
  }

  if (geoJson.type === "FeatureCollection") {
    for (const feature of geoJson.features) {
      if (feature.geometry) {
        processCoordinates(feature.geometry.coordinates);
      }
    }
  } else if (geoJson.type === "Feature" && geoJson.geometry) {
    processCoordinates(geoJson.geometry.coordinates);
  }

  if (!Number.isFinite(west) || !Number.isFinite(south) || !Number.isFinite(east) || !Number.isFinite(north)) {
    return undefined;
  }

  return [west, south, east, north];
}

async function fetchOnlineBoundary(adcode: string | number): Promise<AdminGeoJson | null> {
  const codeStr = String(adcode);
  const cacheKey = `online:${codeStr}`;
  if (boundaryMemoryCache.has(cacheKey)) {
    return boundaryMemoryCache.get(cacheKey) as AdminGeoJson;
  }

  try {
    const url = `https://geo.datav.aliyun.com/areas_v3/bound/${codeStr}.json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(3500) });
    if (!res.ok) return null;
    const data = (await res.json()) as AdminGeoJson;
    if (data && (data.type === "FeatureCollection" || data.type === "Feature")) {
      // This endpoint is DataV GCJ-02, unlike Natural Earth's WGS84 fallback.
      const normalized = normalizeBoundaryGeometry({ geoJson: data, coordinateSystem: "GCJ-02" }).geoJson;
      boundaryMemoryCache.set(cacheKey, normalized);
      return normalized;
    }
  } catch {
    // Network or timeout: return null to let fallback handle it
  }
  return null;
}

/**
 * Resolves the boundary GeoJSON and distinct visual styles for the active China administrative selection.
 * Colors are strictly distinct by hierarchy:
 * - Province: Cyan (#00e5ff dark / #0284c7 light)
 * - City: Emerald Green (#10b981 dark / #059669 light)
 * - District: Amber/Gold (#f59e0b dark / #d97706 light)
 */
export async function resolveAdminBoundaryHighlight(
  selection: ChinaRegionSelection,
  theme: "dark" | "light" = "dark",
  signal?: AbortSignal
): Promise<AdminBoundaryHighlight | null> {
  if (!selection.provinceCode) {
    return null;
  }

  const { provinceCode, cityCode, districtCode } = selection;

  // 1. DISTRICT LEVEL HIGHLIGHT
  if (districtCode) {
    const colorSpec = ADMIN_BOUNDARY_COLORS.district[theme];
    const districts = getChinaDistricts(provinceCode, cityCode);
    const district = districts.find((d) => d.code === districtCode);
    const name = district?.name ?? "已选区县";

    let feature: GeoJsonFeature | null = null;

    // Check Shanghai bundled districts
    if (provinceCode === "31") {
      const shCollection = await loadBundledShanghaiDistricts();
      const match = shCollection.features.find(
        (f: GeoJsonFeature) => String(f.properties?.adcode) === districtCode || f.properties?.name === name
      );
      if (match) feature = match;
    }
    // Check Beijing bundled districts
    else if (provinceCode === "11") {
      const bjCollection = await loadBundledBeijingDistricts();
      const match = bjCollection.features.find(
        (f: GeoJsonFeature) => String(f.properties?.adcode) === districtCode || f.properties?.name === name
      );
      if (match) feature = match;
    }

    // Try online fetch if not found in bundled datasets
    if (!feature && !signal?.aborted) {
      const onlineData = await fetchOnlineBoundary(districtCode);
      if (onlineData) {
        if (onlineData.type === "Feature") {
          feature = onlineData;
        } else if (onlineData.type === "FeatureCollection" && onlineData.features.length > 0) {
          feature = onlineData.features[0]!;
        }
      }
    }

    if (feature) {
      const styledFeature: GeoJsonFeature = {
        ...feature,
        properties: {
          ...feature.properties,
          level: "district",
          name,
          color: colorSpec.stroke,
          glowColor: colorSpec.glow,
          fillColor: colorSpec.fill,
        },
      };

      const geoJson: GeoJsonFeatureCollection = {
        type: "FeatureCollection",
        features: [styledFeature],
      };

      const bounds = calculateGeoJsonBounds(geoJson);

      return {
        level: "district",
        name,
        code: districtCode,
        levelLabel: ADMIN_BOUNDARY_COLORS.district.label,
        color: colorSpec.stroke,
        glowColor: colorSpec.glow,
        fillColor: colorSpec.fill,
        bounds,
        boundsMaxZoom: 13.5,
        geoJson,
      };
    }
  }

  // 2. CITY LEVEL HIGHLIGHT
  if (cityCode) {
    const isDirect = municipalities.has(provinceCode);
    const colorSpec = isDirect ? ADMIN_BOUNDARY_COLORS.province[theme] : ADMIN_BOUNDARY_COLORS.city[theme];
    const levelLabel = isDirect ? "直辖市行政边界" : ADMIN_BOUNDARY_COLORS.city.label;
    const cities = getChinaCities(provinceCode);
    const city = cities.find((c) => c.code === cityCode);
    const provinces = getChinaProvinces();
    const province = provinces.find((p) => p.code === provinceCode);
    const name = isDirect && province ? `${province.name}全域` : (city?.name ?? "已选城市");

    let feature: GeoJsonFeature | null = null;

    // For direct-controlled municipalities (Beijing, Shanghai, Tianjin, Chongqing),
    // selecting the city level uses the bundled DataV municipality geometry.
    if (isDirect) {
      const officialLoader = MUNICIPALITY_LOADERS[provinceCode];
      if (officialLoader) {
        const officialCol = await officialLoader();
        if (officialCol.features.length > 0) feature = officialCol.features[0]!;
      }
      if (!feature) {
        const mapId = provinceMapIds[provinceCode];
        if (mapId) {
          const provincesCol = await loadBundledProvinces();
          const provFeature = provincesCol.features.find((f: GeoJsonFeature) => f.id === mapId);
          if (provFeature) feature = provFeature;
        }
      }
    }

    // Check Guangdong bundled cities
    if (!feature && provinceCode === "44") {
      const gdCollection = await loadBundledGuangdongCities();
      const match = gdCollection.features.find(
        (f: GeoJsonFeature) => String(f.properties?.adcode).startsWith(cityCode) || f.properties?.name === name
      );
      if (match) feature = match;
    }

    // Check Jiangsu bundled cities
    if (!feature && provinceCode === "32") {
      const jsCollection = await loadBundledJiangsuCities();
      const match = jsCollection.features.find(
        (f: GeoJsonFeature) => String(f.properties?.adcode).startsWith(cityCode) || f.properties?.name === name
      );
      if (match) feature = match;
    }

    // Check Zhejiang bundled cities
    if (!feature && provinceCode === "33") {
      const zjCollection = await loadBundledZhejiangCities();
      const match = zjCollection.features.find(
        (f: GeoJsonFeature) => String(f.properties?.adcode).startsWith(cityCode) || f.properties?.name === name
      );
      if (match) feature = match;
    }

    // Try online fetch for city boundary
    if (!feature && !signal?.aborted) {
      const adcodeFull = cityCode.length === 4 ? `${cityCode}00` : cityCode;
      const onlineData = await fetchOnlineBoundary(adcodeFull);
      if (onlineData) {
        if (onlineData.type === "Feature") {
          feature = onlineData;
        } else if (onlineData.type === "FeatureCollection" && onlineData.features.length > 0) {
          feature = onlineData.features[0]!;
        }
      }
    }

    if (feature) {
      const styledFeature: GeoJsonFeature = {
        ...feature,
        properties: {
          ...feature.properties,
          level: isDirect ? "province" : "city",
          name,
          color: colorSpec.stroke,
          glowColor: colorSpec.glow,
          fillColor: colorSpec.fill,
        },
      };

      const geoJson: GeoJsonFeatureCollection = {
        type: "FeatureCollection",
        features: [styledFeature],
      };

      const bounds = calculateGeoJsonBounds(geoJson);

      return {
        level: isDirect ? "province" : "city",
        name,
        code: cityCode,
        levelLabel,
        color: colorSpec.stroke,
        glowColor: colorSpec.glow,
        fillColor: colorSpec.fill,
        bounds,
        boundsMaxZoom: 11,
        geoJson,
      };
    }
  }

  // 3. PROVINCE LEVEL HIGHLIGHT
  if (provinceCode) {
    const colorSpec = ADMIN_BOUNDARY_COLORS.province[theme];
    const mapId = provinceMapIds[provinceCode];
    const provinces = getChinaProvinces();
    const province = provinces.find((p) => p.code === provinceCode);
    const name = province?.name ?? "已选省份";

    let feature: GeoJsonFeature | null = null;
    const officialLoader = MUNICIPALITY_LOADERS[provinceCode];
    if (officialLoader) {
      const officialCol = await officialLoader();
      if (officialCol.features.length > 0) feature = officialCol.features[0]!;
    }

    if (!feature && !signal?.aborted) {
      const adcodeFull = `${provinceCode}0000`;
      const onlineData = await fetchOnlineBoundary(adcodeFull);
      if (onlineData) {
        if (onlineData.type === "Feature") {
          feature = onlineData;
        } else if (onlineData.type === "FeatureCollection" && onlineData.features.length > 0) {
          feature = onlineData.features[0]!;
        }
      }
    }

    if (!feature && mapId) {
      const provincesCol = await loadBundledProvinces();
      const provFeature = provincesCol.features.find((f: GeoJsonFeature) => f.id === mapId);
      if (provFeature) feature = provFeature;
    }

    if (feature) {
      const styledFeature: GeoJsonFeature = {
        ...feature,
        properties: {
          ...feature.properties,
          level: "province",
          name,
          color: colorSpec.stroke,
          glowColor: colorSpec.glow,
          fillColor: colorSpec.fill,
        },
      };

      const geoJson: GeoJsonFeatureCollection = {
        type: "FeatureCollection",
        features: [styledFeature],
      };

      const bounds = calculateGeoJsonBounds(geoJson);

      return {
        level: "province",
        name,
        code: provinceCode,
        levelLabel: ADMIN_BOUNDARY_COLORS.province.label,
        color: colorSpec.stroke,
        glowColor: colorSpec.glow,
        fillColor: colorSpec.fill,
        bounds,
        boundsMaxZoom: 8,
        geoJson,
      };
    }
  }

  return null;
}
