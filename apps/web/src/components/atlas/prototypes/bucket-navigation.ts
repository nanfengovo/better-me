import type { MapBucket } from "@better-me/opportunities";

export type AtlasBucketLevel = "country" | "region" | "city" | "location";

/** A bucket supplies a representative point, never proof of an individual office. */
export function bucketNavigationCamera(bucket: MapBucket, options: {
  level: AtlasBucketLevel; currentZoom: number; maxZoom: number; reducedMotion: boolean;
}) {
  if (!Number.isFinite(bucket.longitude) || !Number.isFinite(bucket.latitude)
    || Math.abs(bucket.longitude) > 180 || Math.abs(bucket.latitude) > 90
    || !Number.isFinite(options.currentZoom) || !Number.isFinite(options.maxZoom) || bucket.jobCount <= 0) return null;
  // Broader buckets remain overview-only. Location-level source buckets can carry
  // their declared precision; city-reference buckets never promote an estimate.
  const overviewZoom: Record<AtlasBucketLevel, number> = { country: 4.5, region: 7.5, city: 10.5, location: 10.5 };
  // At location level the query keeps the source precision. Honour it when it
  // is safe to do so, while city-reference buckets remain capped at city scale.
  const precisionZoom: Record<NonNullable<MapBucket["precision"]>, number> = {
    country: 4.5, region: 7.5, city: 10.5, street: 14, address: 16.5, manual: 16, unknown: 10.5,
  };
  const requested = options.level === "location" && bucket.positionBasis === undefined && bucket.precision
    ? precisionZoom[bucket.precision] : overviewZoom[options.level];
  const zoom = Math.min(Math.max(0, options.maxZoom), requested, bucket.positionBasis === "city-reference" ? 9 : Infinity);
  if (zoom <= options.currentZoom + .05) return null;
  return { center: [bucket.longitude, bucket.latitude] as [number, number], zoom,
    pitch: options.level === "country" ? 15 : options.level === "region" ? 25 : 35,
    bearing: 0, duration: options.reducedMotion ? 0 : 900, curve: 1.25, essential: false };
}
