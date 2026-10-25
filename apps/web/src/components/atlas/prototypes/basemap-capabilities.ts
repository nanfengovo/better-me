import type { LayerSpecification } from "maplibre-gl";

type JsonRecord = Record<string, unknown>;

export type AtlasBuildingCapability = {
  sourceId: string;
  sourceLayer: string;
  heightField: string;
  baseField?: string;
  minZoom: number;
};

export type AtlasHouseNumberCapability = {
  sourceId: string;
  sourceLayer: string;
  numberField: string;
  minZoom: number;
};

export type AtlasVectorCapabilities = {
  building?: AtlasBuildingCapability;
  houseNumbers?: AtlasHouseNumberCapability;
  /** Highest native vector-tile zoom advertised by the source metadata. */
  nativeMaxZoom?: number;
};

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function numericField(fields: JsonRecord | undefined, names: readonly string[]): string | undefined {
  if (!fields) return undefined;
  return names.find((name) => {
    const type = fields[name];
    return typeof type === "string" && /^(?:number|integer|float|double|real)\b/i.test(type);
  });
}

function textField(fields: JsonRecord | undefined, names: readonly string[]): string | undefined {
  if (!fields) return undefined;
  return names.find((name) => typeof fields[name] === "string" && /^(?:string|text)\b/i.test(fields[name] as string));
}

type TileLayer = { id: string; fields?: JsonRecord; minzoom?: number; maxzoom?: number; invalidMinzoom?: true; invalidMaxzoom?: true };

function tileLayers(value: unknown): TileLayer[] {
  const root = record(value);
  if (!Array.isArray(root?.vector_layers)) return [];
  return root.vector_layers.flatMap((entry) => {
    const item = record(entry);
    if (typeof item?.id !== "string") return [];
    const minzoom = item.minzoom, maxzoom = item.maxzoom;
    return [{ id: item.id, fields: record(item.fields),
      ...(minzoom === undefined ? {} : typeof minzoom === "number" && Number.isFinite(minzoom) && minzoom >= 0 && minzoom <= 22 ? { minzoom } : { invalidMinzoom: true as const }),
      ...(maxzoom === undefined ? {} : typeof maxzoom === "number" && Number.isFinite(maxzoom) && maxzoom >= 0 && maxzoom <= 22 ? { maxzoom } : { invalidMaxzoom: true as const }) }];
  });
}

function sourceEntries(value: unknown): Array<[string, JsonRecord]> {
  const root = record(value);
  const sources = record(root?.sources);
  if (!sources) return [];
  return Object.entries(sources).flatMap(([id, source]) => {
    const item = record(source);
    return item ? [[id, item] as [string, JsonRecord]] : [];
  });
}

/**
 * Resolve optional close-range vector features from a style and its TileJSON.
 * A style layer alone is not enough: the TileJSON must prove the source layer
 * and numeric/text fields exist. Unknown providers therefore keep their normal
 * style unchanged instead of receiving expressions that render empty tiles.
 */
export function readAtlasVectorCapabilities(style: unknown, tileJson: unknown, tileJsonUrl: string): AtlasVectorCapabilities | null {
  const metadata = new Map(tileLayers(tileJson).map((layer) => [layer.id, layer]));
  const capabilities: AtlasVectorCapabilities = {};
  const root = record(tileJson);
  const sourceMaxZoom = root?.maxzoom;
  if (typeof sourceMaxZoom === "number" && Number.isFinite(sourceMaxZoom) && sourceMaxZoom >= 0 && sourceMaxZoom <= 22) {
    capabilities.nativeMaxZoom = sourceMaxZoom;
  }
  const normalizedTileJsonUrl = normalizeUrl(tileJsonUrl);

  for (const [sourceId, source] of sourceEntries(style)) {
    if (source.type !== "vector" || typeof source.url !== "string" || normalizeUrl(source.url) !== normalizedTileJsonUrl) continue;
    const building = metadata.get("building");
    if (!capabilities.building && building) {
      const heightField = numericField(building.fields, ["render_height", "height"]);
      if (heightField && !building.invalidMinzoom) {
        const baseField = numericField(building.fields, ["render_min_height", "min_height"]);
        if (capabilities.nativeMaxZoom === undefined && !building.invalidMaxzoom && typeof building.maxzoom === "number") capabilities.nativeMaxZoom = building.maxzoom;
        capabilities.building = { sourceId, sourceLayer: building.id, heightField, minZoom: Math.max(building.minzoom ?? 13, 0), ...(baseField ? { baseField } : {}) };
      }
    }
    const houseLayer = metadata.get("housenumber");
    const numberField = textField(houseLayer?.fields, ["housenumber"]);
    if (!capabilities.houseNumbers && houseLayer && numberField && !houseLayer.invalidMinzoom) capabilities.houseNumbers = {
      sourceId, sourceLayer: houseLayer.id, numberField, minZoom: Math.max(14, houseLayer.minzoom ?? 0),
    };
    if (capabilities.nativeMaxZoom === undefined && !houseLayer?.invalidMaxzoom && typeof houseLayer?.maxzoom === "number") capabilities.nativeMaxZoom = houseLayer.maxzoom;
  }
  return capabilities.building || capabilities.houseNumbers ? capabilities : null;
}

function normalizeUrl(value: string): string {
  try { return new URL(value).toString().replace(/\/$/, ""); } catch { return ""; }
}

export function openFreeMapTileJsonUrls(style: unknown, styleUrl: string): string[] {
  try {
    const styleOrigin = new URL(styleUrl);
    if (styleOrigin.protocol !== "https:" || styleOrigin.hostname !== "tiles.openfreemap.org" || styleOrigin.username || styleOrigin.password || styleOrigin.port) return [];
    return sourceEntries(style).flatMap(([, source]) => {
      if (source.type !== "vector" || typeof source.url !== "string") return [];
      const sourceUrl = new URL(source.url);
      return sourceUrl.protocol === "https:" && sourceUrl.origin === styleOrigin.origin && /^\/planet\/?$/.test(sourceUrl.pathname)
        && !sourceUrl.username && !sourceUrl.password && !sourceUrl.port && !sourceUrl.search && !sourceUrl.hash
        ? [sourceUrl.toString().replace(/\/$/, "")]
        : [];
    });
  } catch { return []; }
}

/** Layers are inserted below job markers and above the provider's street labels. */
export function createAtlasDetailLayers(capability: AtlasVectorCapabilities, light: boolean): LayerSpecification[] {
  const layers: LayerSpecification[] = [];
  if (capability.building) {
    const { sourceId, sourceLayer, heightField, baseField } = capability.building;
    layers.push({
      id: "atlas-buildings-3d", type: "fill-extrusion", source: `basemap:${sourceId}`, "source-layer": sourceLayer,
      minzoom: capability.building.minZoom, maxzoom: 22,
      paint: {
        "fill-extrusion-color": light ? "#a8c5bd" : "#23566a",
        "fill-extrusion-height": ["coalesce", ["get", heightField], 0],
        "fill-extrusion-base": baseField ? ["coalesce", ["get", baseField], 0] : 0,
        "fill-extrusion-opacity": light ? 0.58 : 0.72,
        "fill-extrusion-vertical-gradient": true,
      },
    } as LayerSpecification);
  }
  if (capability.houseNumbers) {
    const { sourceId, sourceLayer, numberField } = capability.houseNumbers;
    layers.push({
      id: "atlas-house-numbers", type: "symbol", source: `basemap:${sourceId}`, "source-layer": sourceLayer,
      minzoom: capability.houseNumbers.minZoom, maxzoom: 22,
      layout: {
        "text-field": ["get", numberField], "text-size": ["interpolate", ["linear"], ["zoom"], 14, 9, 18, 12],
        "text-allow-overlap": false, "text-ignore-placement": false, "text-padding": 2,
      },
      paint: { "text-color": light ? "#395850" : "#d9f2e7", "text-halo-color": light ? "#f5f6f4" : "#102631", "text-halo-width": 1.1 },
    } as LayerSpecification);
  }
  return layers;
}

