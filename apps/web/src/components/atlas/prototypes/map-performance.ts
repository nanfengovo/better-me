import type { MapBucket } from "@better-me/opportunities";
import { bucketRadius, categories, validBuckets } from "./types";
import { atlasSelectedBucketIds } from "./bucket-selection";

export type BucketGeoJSON = { type: "FeatureCollection"; features: Array<{ type: "Feature"; properties: {
  bucketId: string; kind: string; color: string; radius: number; label: string; labelVisible: boolean;
  /** Kept on the point so the renderer can distinguish an office point from a city estimate. */
  precision: string; estimated: boolean; positionBasis: string; precisionColor: string;
}; geometry: { type: "Point"; coordinates: [number, number] } }> };

function precisionColor(bucket: MapBucket): string {
  if (bucket.positionBasis === "city-reference") return "#f2b84b";
  switch (bucket.precision) {
    case "address":
    case "manual": return "#32d6a4";
    case "street": return "#55c8e8";
    case "city": return "#f2b84b";
    case "region":
    case "country": return "#e68f72";
    default: return "#c4d0d2";
  }
}

/**
 * Compare only facts that affect the uploaded point source. Query pages can
 * recreate or reorder bucket objects while preserving the same geometry and
 * display facts; those updates must not rebuild the GeoJSON source.
 */
export function atlasBucketFactSignature(input: readonly MapBucket[]): string {
  return JSON.stringify(validBuckets(input).map(bucket => [
    bucket.id, bucket.label, bucket.latitude, bucket.longitude, bucket.jobCount, bucket.pinCount,
    bucket.positionBasis ?? null, bucket.precision ?? null, bucket.estimated ?? false,
    bucket.categories.map(category => [category.ruleId, category.label, category.color, category.jobCount]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

/** Only source facts live in GeoJSON. Selection uses layer filters without re-indexing points in a worker. */
export function atlasBucketData(input: readonly MapBucket[]): BucketGeoJSON {
  const features: BucketGeoJSON["features"] = [], buckets = validBuckets(input);
  const labelIds = new Set([...buckets].sort((a, b) => b.jobCount - a.jobCount || a.id.localeCompare(b.id)).slice(0, 6).map(bucket => bucket.id));
  for (const bucket of buckets) {
    const colors = categories(bucket), base = bucketRadius(bucket);
    const point = { type: "Point" as const, coordinates: [bucket.longitude, bucket.latitude] as [number, number] };
    const label = `${bucket.label} · ${bucket.jobCount}${bucket.positionBasis === "city-reference" ? " · 城市估算" : ""}`;
    const precision = bucket.precision ?? "unknown", estimated = bucket.estimated === true, positionBasis = bucket.positionBasis ?? "source", markerPrecisionColor = precisionColor(bucket);
    const shared = { precision, estimated, positionBasis, precisionColor: markerPrecisionColor };
    features.push({ type: "Feature", geometry: point, properties: { bucketId: bucket.id, kind: "core", color: colors.length === 1 ? colors[0]!.color : "#a5bbb6", radius: base * .46, label, labelVisible: labelIds.has(bucket.id), ...shared } });
    colors.forEach((category, index) => features.push({ type: "Feature", geometry: point, properties: { bucketId: bucket.id, kind: "category", color: category.color, radius: base * .58 + index * 2.1, label, labelVisible: false, ...shared } }));
  }
  return { type: "FeatureCollection", features };
}

/** Parent camera/UI renders do not resend unchanged geometry or selection style to MapLibre. */
export function createAtlasMapUpdates(initialBuckets: readonly MapBucket[], _initialData: BucketGeoJSON, write: {
  buckets: (data: BucketGeoJSON) => void;
  bucketSelection: (id: string, ids: readonly string[]) => void;
  regionSelection: (id: string) => void;
}) {
  let buckets = initialBuckets, signature = atlasBucketFactSignature(initialBuckets), selectedBucket = "", selectedRegion = "";
  return (next: { buckets: readonly MapBucket[]; selectedBucketId?: string; selectedBucketIds?: readonly string[]; selectedRegionId?: string }) => {
    if (buckets !== next.buckets) {
      const nextSignature = atlasBucketFactSignature(next.buckets);
      if (nextSignature !== signature) { write.buckets(atlasBucketData(next.buckets)); signature = nextSignature; }
      buckets = next.buckets;
    }
    const ids = atlasSelectedBucketIds(next), bucket = ids.length ? JSON.stringify(ids) : "", region = next.selectedRegionId ?? "";
    if (bucket !== selectedBucket) { write.bucketSelection(next.selectedBucketId ?? "", ids); selectedBucket = bucket; }
    if (region !== selectedRegion) { write.regionSelection(region); selectedRegion = region; }
  };
}

/** At most one hit-test per animation frame, and none while the camera is moving. */
export function createAtlasHover<T>(options: {
  requestFrame: (callback: () => void) => number;
  cancelFrame: (id: number) => void;
  moving: () => boolean;
  hit: (point: T) => void;
}) {
  let frame: number | undefined, point: T | undefined;
  const cancel = () => { if (frame !== undefined) options.cancelFrame(frame); frame = undefined; point = undefined; };
  return {
    cancel,
    queue(next: T) {
      if (options.moving()) { cancel(); return; }
      point = next;
      if (frame !== undefined) return;
      frame = options.requestFrame(() => { frame = undefined; const current = point; point = undefined; if (current !== undefined && !options.moving()) options.hit(current); });
    },
  };
}
