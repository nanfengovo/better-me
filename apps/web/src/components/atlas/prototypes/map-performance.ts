import type { MapBucket } from "@better-me/opportunities";
import { bucketRadius, categories, validBuckets } from "./types";

export type BucketGeoJSON = { type: "FeatureCollection"; features: Array<{ type: "Feature"; properties: { bucketId: string; kind: string; color: string; radius: number; label: string; fullLabel: string; labelVisible: boolean; grade: string; stackLocationCount?: number; stackJobCount?: number; stackLabel?: string }; geometry: { type: "Point"; coordinates: [number, number] } }> };
export type AtlasMapGeometry = { data: BucketGeoJSON; signature: string; officeBucketIds: string[]; coordinateStacks: AtlasCoordinateStack[] };

export function mapBucketPrecisionLabel(bucket: MapBucket): string {
  if (bucket.displayGrade === "building") {
    const meaning = bucket.coordinateMeaning;
    if (meaning === "building") return "本人核对 · 楼宇坐标";
    if (meaning === "entrance") return "本人核对 · 入口坐标";
    if (meaning === "site") return "本人核对 · 园区位置";
    return "办公楼级来源坐标";
  }
  if (bucket.displayGrade === "street") return "街道级来源坐标";
  if (bucket.displayGrade === "address") return "地址级来源坐标";
  if (bucket.displayGrade === "city" || bucket.positionBasis === "city-reference") return "城市级估算 · 非办公地址";
  return "来源坐标 · 精度未标明";
}

/** Cities and estimated references belong in search results, never on the office-address map. */
export function isMappableOfficeBucket(bucket: MapBucket): boolean {
  if (bucket.positionBasis === "city-reference") return false;
  return bucket.displayGrade === "building" || bucket.displayGrade === "street" || bucket.displayGrade === "address";
}

/**
 * Return the same source-backed office points used by the map renderer in a
 * stable order for the keyboard/touch address browser. City references and
 * ungraded coordinates stay out of this list by design.
 */
export function mappableOfficeBuckets(input: readonly MapBucket[]): MapBucket[] {
  return validBuckets(input)
    .filter(isMappableOfficeBucket)
    .slice()
    .sort((left, right) => right.jobCount - left.jobCount || left.label.localeCompare(right.label, "zh-CN") || left.id.localeCompare(right.id));
}

export type AtlasCoordinateStack = { id: string; latitude: number; longitude: number; bucketIds: string[]; locationCount: number; jobCount: number };

/** Exact-coordinate groups are display summaries only; the underlying office buckets remain individually selectable. */
export function atlasCoordinateStacks(input: readonly MapBucket[]): AtlasCoordinateStack[] {
  const groups = new Map<string, MapBucket[]>();
  for (const bucket of mappableOfficeBuckets(input)) {
    const id = `${bucket.longitude},${bucket.latitude}`;
    const group = groups.get(id);
    if (group) group.push(bucket);
    else groups.set(id, [bucket]);
  }
  return [...groups.entries()].flatMap(([id, group]) => {
    if (group.length < 2) return [];
    const jobs = new Set(group.flatMap(bucket => bucket.jobIds ?? []));
    return [{ id, longitude: group[0]!.longitude, latitude: group[0]!.latitude, bucketIds: group.map(bucket => bucket.id),
      locationCount: group.length, jobCount: jobs.size || group.reduce((sum, bucket) => sum + bucket.jobCount, 0) }];
  });
}

/** Only source facts live in GeoJSON. Selection uses layer filters without re-indexing points in a worker. */
export function atlasBucketData(input: readonly MapBucket[]): BucketGeoJSON {
  const features: BucketGeoJSON["features"] = [], buckets = mappableOfficeBuckets(input);
  const labelIds = new Set([...buckets].sort((a, b) => b.jobCount - a.jobCount || a.id.localeCompare(b.id)).slice(0, 6).map(bucket => bucket.id));
  for (const bucket of buckets) {
    const colors = categories(bucket), base = bucketRadius(bucket);
    const point = { type: "Point" as const, coordinates: [bucket.longitude, bucket.latitude] as [number, number] };
    const precision = mapBucketPrecisionLabel(bucket);
    const place = bucket.label.length > 28 ? `${bucket.label.slice(0, 26)}…` : bucket.label;
    const label = `${place} · ${bucket.jobCount}${precision ? ` · ${precision}` : ""}`;
    const fullLabel = `${bucket.label} · ${bucket.jobCount}`;
    const grade = bucket.displayGrade ?? (bucket.positionBasis === "city-reference" ? "city" : "");
    features.push({ type: "Feature", geometry: point, properties: { bucketId: bucket.id, kind: "core", color: colors.length === 1 ? colors[0]!.color : "#a5bbb6", radius: base * .46, label, fullLabel, labelVisible: labelIds.has(bucket.id), grade } });
    colors.forEach((category, index) => features.push({ type: "Feature", geometry: point, properties: { bucketId: bucket.id, kind: "category", color: category.color, radius: base * .58 + index * 2.1, label, fullLabel, labelVisible: false, grade } }));
  }
  const bucketsById = new Map(buckets.map(bucket => [bucket.id, bucket]));
  for (const stack of atlasCoordinateStacks(buckets)) {
    const first = bucketsById.get(stack.bucketIds[0]!)!;
    const radius = 12 + Math.min(12, Math.log2(stack.locationCount) * 3);
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [stack.longitude, stack.latitude] },
      properties: {
        bucketId: first.id, kind: "stack", color: "#d5f4e8", radius,
        label: `${stack.locationCount} 个来源地址 · ${stack.jobCount} 个岗位`, fullLabel: `${stack.locationCount} 个来源地址 · ${stack.jobCount} 个岗位`,
        labelVisible: false, grade: first.displayGrade ?? "address",
        stackLocationCount: stack.locationCount, stackJobCount: stack.jobCount, stackLabel: `${stack.locationCount}址 · ${stack.jobCount}岗`,
      },
    });
  }
  return { type: "FeatureCollection", features };
}

/** Compute-owned immutable projection; the renderer need not sort, hash or
 * re-project the whole library on its UI thread for each committed batch. */
export async function prepareAtlasMapGeometry(input: readonly MapBucket[]): Promise<AtlasMapGeometry> {
  const data = atlasBucketData(input);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(data)));
  return { data, signature: Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join(""),
    officeBucketIds: mappableOfficeBuckets(input).map(bucket => bucket.id), coordinateStacks: atlasCoordinateStacks(input) };
}

/** Deduplicate core/ring hits and rank nearby locations by their actual screen-space distance. */
export function rankAtlasBucketHits(
  features: readonly { properties?: { bucketId?: unknown }; layer?: { id?: string } }[],
  buckets: readonly MapBucket[],
  pointer: { x: number; y: number },
  project: (bucket: MapBucket) => { x: number; y: number },
  maxDistancePx = 22,
  includeProjectedFallback = true,
): MapBucket[] {
  const labelHits = new Set<string>();
  const renderedHits = new Set<string>();
  for (const feature of features) {
    const id = feature.properties?.bucketId;
    if (typeof id !== "string") continue;
    renderedHits.add(id);
    if (feature.layer?.id === "bucket-labels" || feature.layer?.id === "bucket-detail-labels" || feature.layer?.id === "bucket-stack-labels") labelHits.add(id);
  }
  // Use projected coordinates as the authoritative screen-space hit target. The helper
  // defaults to a 44px target for compact renderers; MapLibre's production handler
  // passes the wider 56px target needed for touch-sized office markers. Rendered-feature
  // queries can omit collision-hidden labels or crowded points, so they are only needed
  // to let a visible label itself win when it is farther from its marker.
  const eligible = validBuckets(buckets).filter(isMappableOfficeBucket);
  return (includeProjectedFallback ? eligible : eligible.filter(bucket => renderedHits.has(bucket.id))).map(bucket => {
    const projected = project(bucket);
    return { bucket, distance: Math.hypot(projected.x - pointer.x, projected.y - pointer.y), labelHit: labelHits.has(bucket.id) };
  }).filter(item => item.labelHit || item.distance <= maxDistancePx)
    .sort((left, right) => Number(right.labelHit) - Number(left.labelHit) || left.distance - right.distance || left.bucket.label.localeCompare(right.bucket.label))
    .map(item => item.bucket);
}

/** Keep the overlap chooser fully inside the map, including narrow/tall phone layouts. */
export function positionMapPickMenu(
  pointer: { x: number; y: number },
  viewport: { width: number; height: number },
  menu = { width: 320, height: 360, margin: 12, offset: 12 },
): { left: number; top: number } {
  const margin = Math.max(0, Math.min(menu.margin, viewport.width / 2, viewport.height / 2));
  const width = Math.max(0, Math.min(menu.width, viewport.width - margin * 2));
  const height = Math.max(0, Math.min(menu.height, viewport.height - margin * 2));
  const maxLeft = Math.max(margin, viewport.width - width - margin);
  const right = pointer.x + menu.offset;
  const leftOf = pointer.x - menu.offset - width;
  const left = right + width <= viewport.width - margin
    ? right
    : leftOf >= margin
      ? leftOf
      : Math.max(margin, Math.min(right, maxLeft));
  const maxTop = Math.max(margin, viewport.height - height - margin);
  const top = Math.max(margin, Math.min(pointer.y - 16, maxTop));
  return { left, top };
}

/** Parent camera/UI renders do not resend unchanged geometry or selection style to MapLibre. */
export function createAtlasMapUpdates(initialBuckets: readonly MapBucket[], initialData: BucketGeoJSON, write: {
  buckets: (data: BucketGeoJSON) => void;
  bucketSelection: (id: string) => void;
  regionSelection: (id: string) => void;
}, initialSignature?: string) {
  let buckets = initialBuckets, signature = initialSignature ?? JSON.stringify(initialData), selectedBucket = "", selectedRegion = "";
  return (next: { buckets: readonly MapBucket[]; geometry?: AtlasMapGeometry; selectedBucketId?: string; selectedRegionId?: string }) => {
    if (buckets !== next.buckets || next.geometry && next.geometry.signature !== signature) {
      const data = next.geometry?.data ?? atlasBucketData(next.buckets), nextSignature = next.geometry?.signature ?? JSON.stringify(data);
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
