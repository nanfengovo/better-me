import { z } from 'zod';
import type { JobLocation } from './schema.js';

export const Wgs84CoordinateSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  coordinateSystem: z.literal('WGS84'),
}).strict();
export type Wgs84Coordinate = z.infer<typeof Wgs84CoordinateSchema>;
export const MEAN_EARTH_RADIUS_KM = 6371.0088;
export const DISTANCE_RULE_VERSION = 'wgs84-haversine-v1' as const;

/** Approximate great-circle distance. Never silently treat GCJ-02/BD-09 as WGS84. */
export function haversineKm(from: Wgs84Coordinate, to: Wgs84Coordinate): number | undefined {
  const start = Wgs84CoordinateSchema.safeParse(from);
  const end = Wgs84CoordinateSchema.safeParse(to);
  if (!start.success || !end.success) return undefined;
  const radians = Math.PI / 180;
  const latA = start.data.latitude * radians;
  const latB = end.data.latitude * radians;
  const deltaLat = latB - latA;
  const deltaLon = (((end.data.longitude - start.data.longitude + 540) % 360) - 180) * radians;
  const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(latA) * Math.cos(latB) * Math.sin(deltaLon / 2) ** 2;
  const clamped = Math.min(1, Math.max(0, a));
  return 2 * MEAN_EARTH_RADIUS_KM * Math.atan2(Math.sqrt(clamped), Math.sqrt(1 - clamped));
}

export const LocationDistanceOptionsSchema = z.object({
  allowCityEstimate: z.boolean().default(false),
}).strict();
export type LocationDistanceOptions = z.input<typeof LocationDistanceOptionsSchema>;
export interface LocationDistance {
  km: number;
  locationId: string;
  estimated: boolean;
  precision: JobLocation['precision'];
  ruleVersion: typeof DISTANCE_RULE_VERSION;
}
export const LocationDistanceSchema: z.ZodType<LocationDistance> = z.object({
  km: z.number().finite().nonnegative().max(Math.PI * MEAN_EARTH_RADIUS_KM + 1e-8),
  locationId: z.string().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  estimated: z.boolean(),
  precision: z.enum(['city', 'street', 'address', 'manual']),
  ruleVersion: z.literal(DISTANCE_RULE_VERSION),
}).strict().refine(
  (distance) => !['city', 'street'].includes(distance.precision) || distance.estimated,
  'Coarse location distance must be marked as an estimate',
);
export const LocationDistanceReasonSchema = z.enum([
  'available', 'invalid-anchor', 'invalid-options', 'not-office-location', 'missing-coordinates',
  'invalid-coordinates', 'insufficient-precision', 'city-estimate-disabled',
]);
export type LocationDistanceReason = z.infer<typeof LocationDistanceReasonSchema>;

export function evaluateLocationDistance(
  anchor: Wgs84Coordinate,
  location: JobLocation,
  options: LocationDistanceOptions = {},
): { distance?: LocationDistance; reason: LocationDistanceReason } {
  if (!Wgs84CoordinateSchema.safeParse(anchor).success) return { reason: 'invalid-anchor' };
  const opts = LocationDistanceOptionsSchema.safeParse(options);
  if (!opts.success) return { reason: 'invalid-options' };
  if (location.kind === 'remote-region' || location.kind === 'unknown') return { reason: 'not-office-location' };
  if (!location.coordinates) return { reason: 'missing-coordinates' };
  if (['country', 'region', 'unknown'].includes(location.precision)) return { reason: 'insufficient-precision' };
  if (location.precision === 'city' && !opts.data.allowCityEstimate) return { reason: 'city-estimate-disabled' };
  const km = haversineKm(anchor, location.coordinates);
  if (km === undefined) return { reason: 'invalid-coordinates' };
  return {
    reason: 'available',
    distance: {
      km,
      locationId: location.id,
      estimated: location.precision === 'city' || location.precision === 'street' || Boolean(location.officeResolution),
      precision: location.precision,
      ruleVersion: DISTANCE_RULE_VERSION,
    },
  };
}

/** One job may have multiple optional offices: choose the nearest usable office, not their sum. */
export function distanceToLocations(
  anchor: Wgs84Coordinate,
  locations: readonly JobLocation[],
  options: LocationDistanceOptions = {},
): LocationDistance | undefined {
  let nearest: LocationDistance | undefined;
  for (const location of locations) {
    const candidate = evaluateLocationDistance(anchor, location, options).distance;
    if (!candidate) continue;
    if (!nearest || candidate.km < nearest.km || (candidate.km === nearest.km && candidate.locationId < nearest.locationId)) {
      nearest = candidate;
    }
  }
  return nearest;
}
