import type { CSSProperties } from "react";
import type { MapBucket } from "@better-me/opportunities";
import type { AtlasBasemapConfig } from "./basemaps";
import type { AtlasMapFocus } from "../map-focus";
import type { AdminBoundaryHighlight } from "../admin-boundary-service";

export type AtlasMode = "global" | "domestic";
export type AtlasRegionSelection = { id: string; name: string; countryCode?: string };
export type AtlasCamera = { zoom: number; center: [longitude: number, latitude: number]; pitch: number; bearing: number };
export type AtlasPrototypeProps = {
  mode: AtlasMode;
  buckets: readonly MapBucket[];
  selectedBucketId?: string;
  selectedJobId?: string;
  selectedRegionId?: string;
  adminBoundary?: AdminBoundaryHighlight | null;
  bounds?: readonly [west: number, south: number, east: number, north: number];
  /** Caps fitBounds so a city estimate cannot zoom to building scale. */
  boundsMaxZoom?: number;
  /** Undefined uses the registered default. Null explicitly selects local overview geometry only. */
  basemap?: AtlasBasemapConfig | null;
  focus?: AtlasMapFocus;
  /** Restore the camera when the GPU instance is rebuilt; this is not a live fly-to command. */
  initialView?: AtlasCamera;
  onViewChange?: (view: AtlasCamera & { bounds: [west: number, south: number, east: number, north: number] }) => void;
  onPick?: (bucket: MapBucket) => void;
  onCountry?: (region: AtlasRegionSelection) => void;
  onError?: (error: Error) => void;
  onReady?: () => void;
  className?: string;
  style?: CSSProperties;
  visual?: {
    theme?: "light" | "dark";
    pedestal?: boolean;
    entrance?: boolean;
    autoRotate?: boolean;
    maxDpr?: number;
    /** Three.js scene units. MapLibre uses its own physically scaled equivalent. */
    extrusion?: number;
    background?: string;
  };
};
export type Coordinate = [longitude: number, latitude: number];
export type BoundaryGeometry = { type: "Polygon"; coordinates: Coordinate[][] } | { type: "MultiPolygon"; coordinates: Coordinate[][][] };
export type BoundaryProperties = {
  id: string; name: string; nameZh: string; labelPoint: Coordinate;
  countryCode?: string | null; sourceAdm0A3?: string | string[]; sourceAdm1Codes?: string[];
};
export type BoundaryFeature = { type: "Feature"; id: string; properties: BoundaryProperties; geometry: BoundaryGeometry };
export type BoundaryCollection = { type: "FeatureCollection"; features: BoundaryFeature[] };
export type PrototypeHandle = { update: (props: AtlasPrototypeProps) => void; fit: (bounds?: AtlasPrototypeProps["bounds"]) => void; focus?: (target: NonNullable<AtlasPrototypeProps["focus"]>) => void; dispose: () => void };

export const NATURAL_EARTH_CREDIT = "Made with Natural Earth · 概略边界";
export const CHINA_BOUNDS = [73.602256, 15.775377, 134.772579, 53.569444] as const;
export const PROTOTYPE_BACKGROUND = "#081723";
export const DEFAULT_EXTRUSION = 0.16;

export function validBuckets(buckets: readonly MapBucket[]): MapBucket[] {
  return buckets.filter((bucket) => Number.isFinite(bucket.latitude) && Number.isFinite(bucket.longitude)
    && bucket.latitude >= -90 && bucket.latitude <= 90 && bucket.longitude >= -180 && bucket.longitude <= 180 && bucket.jobCount > 0);
}
export function bucketRadius(bucket: MapBucket): number { return 6 + Math.min(11, Math.log2(1 + bucket.jobCount) * 1.5); }
export function categories(bucket: MapBucket) {
  return bucket.categories.filter((category) => category.jobCount > 0 && /^#[a-fA-F0-9]{6}$/.test(category.color));
}
export function regionSelection(feature: BoundaryFeature): AtlasRegionSelection {
  return { id: feature.id, name: feature.properties.nameZh || feature.properties.name,
    ...(feature.properties.countryCode ? { countryCode: feature.properties.countryCode } : {}) };
}
export async function loadBoundary(mode: AtlasMode, signal: AbortSignal): Promise<BoundaryCollection> {
  const asset = mode === "global" ? await import("../geo/world-countries-110m.geojson?url") : await import("../geo/china-provinces-10m.geojson?url");
  const response = await fetch(asset.default, { signal });
  if (!response.ok) throw new Error("Local atlas boundary asset could not be loaded.");
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || !("type" in value) || value.type !== "FeatureCollection" || !("features" in value) || !Array.isArray(value.features)) throw new Error("Invalid local atlas boundary asset.");
  return value as BoundaryCollection;
}
export const prototypeFrameStyle: CSSProperties = { position: "relative", width: "100%", height: "100%", minHeight: 0, overflow: "hidden", isolation: "isolate", borderRadius: 20, background: PROTOTYPE_BACKGROUND };
export const canvasHostStyle: CSSProperties = { position: "absolute", inset: 0 };
export const creditStyle: CSSProperties = { position: "absolute", left: 18, bottom: 12, zIndex: 2, font: "10px/1.4 system-ui,sans-serif", color: "#9ab1bb", letterSpacing: ".04em", pointerEvents: "none" };
export const errorStyle: CSSProperties = { position: "absolute", inset: 0, display: "grid", placeItems: "center", padding: 32, color: "#d5e6e9", textAlign: "center", font: "13px/1.7 system-ui,sans-serif", background: "#091925e8" };
