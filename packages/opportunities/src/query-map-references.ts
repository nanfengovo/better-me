import { z } from "zod";
import { CountryCodeSchema, EntityIdSchema, HttpUrlSchema, type AtlasDataset } from "./schema.js";
import { Wgs84CoordinateSchema } from "./geo.js";
import { normalizeGeographicName } from "./geocoding.js";
import { fingerprintMapReferenceLocation, type MapReferencesResult } from "./map-references.js";
import type { JobQuery, JobSearchItem, MapBucket } from "./query.js";

/** A display reference for a disclosed work city. It never becomes a JobLocation or distance input. */
export const ResolvedCityMapReferenceSchema = z.object({
  locationId: EntityIdSchema, locationFingerprint: z.string().regex(/^[a-f0-9]{64}$/), placeId: EntityIdSchema,
  label: z.string().min(1).max(1000), countryCode: CountryCodeSchema,
  coordinates: Wgs84CoordinateSchema,
  precision: z.literal("city"), estimated: z.literal(true), coordinateMeaning: z.literal("populated-place-reference-point"),
  providerId: EntityIdSchema, datasetVersion: EntityIdSchema, sourceRecordUrl: HttpUrlSchema,
}).strict();
export type ResolvedCityMapReference = z.infer<typeof ResolvedCityMapReferenceSchema>;

export async function prepareCityMapReferences(dataset: AtlasDataset, batch: MapReferencesResult): Promise<Map<string, ResolvedCityMapReference>> {
  if (batch.snapshotRevision !== dataset.revision) throw new Error("Map references belong to a different index revision.");
  const locations = new Map(dataset.locations.map(location => [location.id, location]));
  const places = new Map(batch.places.map(entry => [entry.place.id, entry.place]));
  const references = new Map<string, ResolvedCityMapReference>();
  for (const reference of batch.references) {
    const location = locations.get(reference.locationId), place = places.get(reference.placeId);
    if (!location || !place || !batch.provenance || location.coordinates || location.kind === "remote-region" || location.verification === "conflicting"
      || !location.city || !location.countryCode || reference.countryCode !== location.countryCode || reference.city !== location.city
      || ![place.countryCode, ...place.alternateCountryCodes].includes(location.countryCode)
      || normalizeGeographicName(reference.matchedName) !== normalizeGeographicName(location.city)
      || reference.locationFingerprint !== await fingerprintMapReferenceLocation(location)) {
      throw new Error("Map reference no longer matches its source location.");
    }
    references.set(location.id, ResolvedCityMapReferenceSchema.parse({
      locationId: location.id, locationFingerprint: reference.locationFingerprint, placeId: place.id,
      label: location.city, countryCode: location.countryCode, coordinates: place.coordinates,
      precision: "city", estimated: true, coordinateMeaning: "populated-place-reference-point",
      providerId: batch.providerId, datasetVersion: batch.provenance.version, sourceRecordUrl: place.sourceRecordUrl,
    }));
  }
  return references;
}

/** Separate buckets keep city representatives distinct from supplied source coordinates at every zoom level. */
export function buildCityReferenceBuckets(items: readonly JobSearchItem[], level: JobQuery["mapLevel"]): MapBucket[] {
  type Bucket = { label: string; references: ResolvedCityMapReference[]; jobs: Set<string>; locations: Set<string>;
    pins: Set<string>; categories: Map<string, { label: string; color: string; jobs: Set<string> }> };
  const buckets = new Map<string, Bucket>();
  for (const item of items) for (const reference of item.mapReferences ?? []) {
    const location = item.locations.find(entry => entry.id === reference.locationId);
    if (!location || location.coordinates || item.job.workMode === "remote") continue;
    const scope = level === "country" ? [location.countryCode] : level === "region"
      ? [location.countryCode, location.regionId ?? location.region ?? reference.placeId] : [reference.placeId];
    const id = JSON.stringify(["city-reference", ...scope]);
    let bucket = buckets.get(id);
    if (!bucket) {
      bucket = { label: (level === "country" ? location.countryCode : level === "region" ? location.region : reference.label) ?? reference.label,
        references: [], jobs: new Set(), locations: new Set(), pins: new Set(), categories: new Map() };
      buckets.set(id, bucket);
    }
    const pin = JSON.stringify([item.job.id, location.id]);
    if (!bucket.pins.has(pin)) bucket.references.push(reference);
    bucket.pins.add(pin); bucket.jobs.add(item.job.id); bucket.locations.add(location.id);
    let category = bucket.categories.get(item.color.ruleId);
    if (!category) { category = { label: item.color.label, color: item.color.color, jobs: new Set() }; bucket.categories.set(item.color.ruleId, category); }
    category.jobs.add(item.job.id);
  }
  return [...buckets.entries()].map(([id, bucket]): MapBucket => {
    let x = 0, y = 0, z = 0;
    for (const reference of bucket.references) {
      const lat = reference.coordinates.latitude * Math.PI / 180, lon = reference.coordinates.longitude * Math.PI / 180;
      x += Math.cos(lat) * Math.cos(lon); y += Math.cos(lat) * Math.sin(lon); z += Math.sin(lat);
    }
    return { id, label: bucket.label, latitude: Math.atan2(z, Math.hypot(x, y)) * 180 / Math.PI,
      longitude: Math.atan2(y, x) * 180 / Math.PI, jobIds: [...bucket.jobs].sort(), locationIds: [...bucket.locations].sort(),
      jobCount: bucket.jobs.size, pinCount: bucket.pins.size, positionBasis: "city-reference", precision: "city", estimated: true,
      categories: [...bucket.categories.entries()].map(([ruleId, category]) => ({ ruleId, label: category.label, color: category.color, jobCount: category.jobs.size }))
        .sort((a, b) => a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0),
    };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
