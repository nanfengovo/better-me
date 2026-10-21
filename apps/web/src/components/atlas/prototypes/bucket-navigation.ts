import type { MapBucket } from "@better-me/opportunities";

export type AtlasBucketLevel = "country" | "region" | "city" | "location";

/** A bucket supplies a representative point, never proof of an individual office. */
export function bucketNavigationCamera(bucket: MapBucket, options: {
  level: AtlasBucketLevel; currentZoom: number; maxZoom: number; reducedMotion: boolean;
}) {
  if (!Number.isFinite(bucket.longitude) || !Number.isFinite(bucket.latitude)
    || Math.abs(bucket.longitude) > 180 || Math.abs(bucket.latitude) > 90
    || !Number.isFinite(options.currentZoom) || !Number.isFinite(options.maxZoom) || bucket.jobCount <= 0) return null;
  // Location buckets still lack coordinate precision. Address-level navigation uses the
  // selected job's separate, evidence-aware focus path instead of promoting this centroid.
  const overviewZoom: Record<AtlasBucketLevel, number> = { country: 4.5, region: 7.5, city: 10.5, location: 10.5 };
  const zoom = Math.min(Math.max(0, options.maxZoom), overviewZoom[options.level], bucket.positionBasis === "city-reference" ? 9 : Infinity);
  if (zoom <= options.currentZoom + .05) return null;
  return { center: [bucket.longitude, bucket.latitude] as [number, number], zoom,
    pitch: options.level === "country" ? 15 : options.level === "region" ? 25 : 35,
    bearing: 0, duration: options.reducedMotion ? 0 : 900, curve: 1.25, essential: false };
}
