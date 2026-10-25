import type { MapBucket } from "@better-me/opportunities";
import { bucketRadius, categories, validBuckets } from "./types";

export type BucketGeoJSON = { type: "FeatureCollection"; features: Array<{ type: "Feature"; properties: { bucketId: string; kind: string; color: string; radius: number; label: string; labelVisible: boolean; grade: string }; geometry: { type: "Point"; coordinates: [number, number] } }> };

function bucketPrecisionLabel(bucket: MapBucket): string {
  if (bucket.displayGrade === "building") return "办公楼";
  if (bucket.displayGrade === "street") return "街道";
  if (bucket.displayGrade === "address") return "地址坐标 · 非已核办公楼";
  if (bucket.displayGrade === "city" || bucket.positionBasis === "city-reference") return "城市估算";
  return "";
}

/** Only source facts live in GeoJSON. Selection uses layer filters without re-indexing points in a worker. */
export function atlasBucketData(input: readonly MapBucket[]): BucketGeoJSON {
  const features: BucketGeoJSON["features"] = [], buckets = validBuckets(input);
  const labelIds = new Set([...buckets].sort((a, b) => b.jobCount - a.jobCount || a.id.localeCompare(b.id)).slice(0, 6).map(bucket => bucket.id));
  for (const bucket of buckets) {
    const colors = categories(bucket), base = bucketRadius(bucket);
    const point = { type: "Point" as const, coordinates: [bucket.longitude, bucket.latitude] as [number, number] };
    const precision = bucketPrecisionLabel(bucket);
    const place = bucket.label.length > 28 ? `${bucket.label.slice(0, 26)}…` : bucket.label;
    const label = `${place} · ${bucket.jobCount}${precision ? ` · ${precision}` : ""}`;
    const grade = bucket.displayGrade ?? (bucket.positionBasis === "city-reference" ? "city" : "");
    features.push({ type: "Feature", geometry: point, properties: { bucketId: bucket.id, kind: "core", color: colors.length === 1 ? colors[0]!.color : "#a5bbb6", radius: base * .46, label, labelVisible: labelIds.has(bucket.id), grade } });
    colors.forEach((category, index) => features.push({ type: "Feature", geometry: point, properties: { bucketId: bucket.id, kind: "category", color: category.color, radius: base * .58 + index * 2.1, label, labelVisible: false, grade } }));
  }
  return { type: "FeatureCollection", features };
}

/** Parent camera/UI renders do not resend unchanged geometry or selection style to MapLibre. */
export function createAtlasMapUpdates(initialBuckets: readonly MapBucket[], initialData: BucketGeoJSON, write: {
  buckets: (data: BucketGeoJSON) => void;
  bucketSelection: (id: string) => void;
  regionSelection: (id: string) => void;
}) {
  let buckets = initialBuckets, signature = JSON.stringify(initialData), selectedBucket = "", selectedRegion = "";
  return (next: { buckets: readonly MapBucket[]; selectedBucketId?: string; selectedRegionId?: string }) => {
    if (buckets !== next.buckets) {
      const data = atlasBucketData(next.buckets), nextSignature = JSON.stringify(data);
      if (nextSignature !== signature) { write.buckets(data); signature = nextSignature; }
      buckets = next.buckets;
    }
    const bucket = next.selectedBucketId ?? "", region = next.selectedRegionId ?? "";
    if (bucket !== selectedBucket) { write.bucketSelection(bucket); selectedBucket = bucket; }
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
