import { z } from "zod";
import { CountryCodeSchema, EntityIdSchema, JobLocationSchema, RevisionSchema, type JobLocation } from "./schema.js";
import { GazetteerPlaceSchema, GazetteerProvenanceSchema, normalizeGeographicName, Sha256Schema } from "./geocoding.js";

const uniqueIds = z.array(EntityIdSchema).max(1000).refine(values => new Set(values).size === values.length, "Duplicate location IDs.");
export const MapReferencesInputSchema = z.object({
  expectedRevision: RevisionSchema,
  locationIds: uniqueIds.optional(),
  limit: z.number().int().min(1).max(1000).default(1000),
}).strict();
export type MapReferencesInput = z.input<typeof MapReferencesInputSchema>;

/** A city distribution reference is never an employer's office coordinate. */
export const MapReferencePlaceSchema = z.object({
  place: GazetteerPlaceSchema,
  shardSha256: Sha256Schema,
  precision: z.literal("city"),
  estimated: z.literal(true),
  coordinateMeaning: z.literal("populated-place-reference-point"),
  verification: z.literal("unverified"),
}).strict();
export type MapReferencePlace = z.infer<typeof MapReferencePlaceSchema>;
export const LocationMapReferenceSchema = z.object({
  locationId: EntityIdSchema,
  locationFingerprint: Sha256Schema,
  countryCode: CountryCodeSchema,
  city: z.string().min(1).max(500),
  placeId: EntityIdSchema,
  matchedName: z.string().min(1).max(1000),
  match: z.enum(["exact-name", "exact-alias"]),
}).strict();
export type LocationMapReference = z.infer<typeof LocationMapReferenceSchema>;
export const UnresolvedMapReferenceSchema = z.object({
  locationId: EntityIdSchema,
  reason: z.enum(["remote-region", "existing-coordinate", "conflicting-location", "missing-country", "missing-city", "no-exact-match", "ambiguous-city"]),
}).strict();
export type UnresolvedMapReference = z.infer<typeof UnresolvedMapReferenceSchema>;
const projectionShape = {
  providerId: EntityIdSchema,
  provenance: GazetteerProvenanceSchema.optional(),
  places: z.array(MapReferencePlaceSchema).max(1000),
  references: z.array(LocationMapReferenceSchema).max(1000),
  unresolved: z.array(UnresolvedMapReferenceSchema).max(1000),
  warnings: z.array(z.string().min(1).max(3000)).max(100),
};
function validateProjection(value: MapReferenceProjection, context: z.RefinementCtx) {
  const issue = (message: string) => context.addIssue({ code: "custom", message });
  const places = new Map(value.places.map(row => [row.place.id, row]));
  if (places.size !== value.places.length) issue("Duplicate reference places.");
  const ids = [...value.references.map(row => row.locationId), ...value.unresolved.map(row => row.locationId)];
  if (new Set(ids).size !== ids.length) issue("Each location must have one reference or one unresolved reason.");
  if (value.places.length && !value.provenance) issue("Reference places require provider provenance.");
  const used = new Set<string>();
  for (const reference of value.references) {
    const row = places.get(reference.placeId);
    if (!row) { issue("Reference place is missing."); continue; }
    used.add(reference.placeId);
    const place = row.place;
    if (![place.countryCode, ...place.alternateCountryCodes].includes(reference.countryCode)) issue("Reference country is outside the place country scope.");
    if (normalizeGeographicName(reference.city) !== normalizeGeographicName(reference.matchedName)) issue("Reference city must match the whole source name.");
    if (![place.name, place.asciiName, ...place.aliases].includes(reference.matchedName)) issue("Matched name must occur in the source place.");
    if (reference.match === "exact-name" && reference.matchedName !== place.name) issue("A primary name match must use the primary source name.");
  }
  if (used.size !== places.size) issue("Unused reference places are not allowed.");
}
export type MapReferenceProjection = {
  providerId: string;
  provenance?: z.infer<typeof GazetteerProvenanceSchema>;
  places: MapReferencePlace[];
  references: LocationMapReference[];
  unresolved: UnresolvedMapReference[];
  warnings: string[];
};
export const MapReferenceProjectionSchema = z.object(projectionShape).strict().superRefine(validateProjection);
export const MapReferencesResultSchema = z.object({
  schemaVersion: z.literal(1),
  snapshotRevision: RevisionSchema,
  ...projectionShape,
  totalLocations: z.number().int().min(0).max(200_000),
  processedLocations: z.number().int().min(0).max(1000),
  truncated: z.boolean(),
}).strict().superRefine((value, context) => {
  validateProjection(value, context);
  if (value.processedLocations !== value.references.length + value.unresolved.length || value.processedLocations > value.totalLocations
    || value.truncated !== (value.totalLocations > value.processedLocations)) context.addIssue({ code: "custom", message: "Reference location counts and truncation must agree." });
});
export type MapReferencesResult = z.infer<typeof MapReferencesResultSchema>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
/** Shared browser/server binding. A changed source, local decision or coordinate invalidates its reference. */
export async function fingerprintMapReferenceLocation(location: JobLocation): Promise<string> {
  const value = canonical(JobLocationSchema.parse(location));
  const bytes = new TextEncoder().encode(JSON.stringify(["better-me/map-reference-location", 1, value]));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
