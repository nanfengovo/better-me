import { z } from "zod";
import { CountryCodeSchema, EntityIdSchema, HttpUrlSchema, TimestampSchema } from "./schema.js";
import { Wgs84CoordinateSchema } from "./geo.js";

const unique = <T extends z.ZodTypeAny>(schema: T, maximum: number) => z.array(schema).max(maximum)
  .refine((values) => new Set(values.map((value: unknown) => JSON.stringify(value))).size === values.length, "Duplicate values are not allowed.");
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const name = z.string().min(1).max(1000);
const code = z.string().min(1).max(40);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}, "Invalid calendar date.");

/** Preserve provider codes. GeoNames admin1 is often FIPS, and is not silently relabelled ISO. */
export const GeographicAdministrativeCodesSchema = z.object({ admin1: code.optional(), admin2: code.optional(), admin3: code.optional(), admin4: code.optional() }).strict();
export type GeographicAdministrativeCodes = z.infer<typeof GeographicAdministrativeCodesSchema>;
export const GeographicBoundsSchema = z.tuple([
  z.number().finite().min(-180).max(180), z.number().finite().min(-90).max(90),
  z.number().finite().min(-180).max(180), z.number().finite().min(-90).max(90),
]).refine((bounds) => bounds[1] <= bounds[3], "South cannot exceed north; west > east explicitly spans the antimeridian.");
export type GeographicBounds = z.infer<typeof GeographicBoundsSchema>;

/** Exact Unicode names stay exact: no inferred translations, suffix stripping or substring city extraction. */
export function normalizeGeographicName(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}
export const GeocodingRequestSchema = z.object({
  raw: z.string().min(1).max(1000).refine((value) => /[\p{L}\p{N}]/u.test(normalizeGeographicName(value)) && ![...value].some((character) => {
    const point = character.charCodeAt(0);
    return point === 127 || point < 32 && ![9, 10, 13].includes(point);
  }), "A searchable original place name is required."),
  kind: z.enum(["office", "remote-region", "unknown"]),
  countryCodes: unique(CountryCodeSchema, 250).default([]),
  countryBias: unique(CountryCodeSchema, 250).default([]),
  administrativeCodes: GeographicAdministrativeCodesSchema.optional(),
  bounds: GeographicBoundsSchema.optional(),
  allowPrefix: z.boolean().default(false),
  limit: z.number().int().min(1).max(50).default(10),
}).strict().refine((request) => !request.allowPrefix || [...normalizeGeographicName(request.raw)].length >= 2, "Prefix searches need at least two Unicode characters.");
export type GeocodingRequest = z.infer<typeof GeocodingRequestSchema>;
export type GeocodingInput = z.input<typeof GeocodingRequestSchema>;

export const GazetteerPlaceSchema = z.object({
  id: EntityIdSchema, name, asciiName: name.optional(), aliases: unique(name, 1000),
  sourceRecordUrl: HttpUrlSchema,
  countryCode: CountryCodeSchema, alternateCountryCodes: unique(CountryCodeSchema, 250),
  administrativeCodes: GeographicAdministrativeCodesSchema,
  coordinates: Wgs84CoordinateSchema,
  featureCode: code,
  population: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sourceModifiedDate: date,
}).strict();
export type GazetteerPlace = z.infer<typeof GazetteerPlaceSchema>;
export const GazetteerProvenanceSchema = z.object({
  datasetId: EntityIdSchema, version: EntityIdSchema,
  sourceUrl: HttpUrlSchema, sourceArchiveSha256: Sha256Schema,
  retrievedAt: TimestampSchema, sourceLastModified: z.string().max(200).optional(),
  license: z.string().min(1).max(100), licenseUrl: HttpUrlSchema,
  attribution: z.string().min(1).max(1000), coordinateSystem: z.literal("WGS84"),
  coverage: z.string().min(1).max(3000),
}).strict();
export type GazetteerProvenance = z.infer<typeof GazetteerProvenanceSchema>;
export const GazetteerShardDescriptorSchema = z.object({
  countryCode: CountryCodeSchema,
  alternateCountryCodes: unique(CountryCodeSchema, 250),
  file: z.string().regex(/^[A-Z]{2}\.json(?:\.gz)?$/),
  encoding: z.enum(["identity", "gzip"]),
  sha256: Sha256Schema,
  bytes: z.number().int().min(1).max(8 * 1024 * 1024),
  decodedBytes: z.number().int().min(1).max(8 * 1024 * 1024),
  count: z.number().int().min(1).max(100_000),
}).strict().refine((shard) => shard.file === `${shard.countryCode}.json${shard.encoding === "gzip" ? ".gz" : ""}` && (shard.encoding !== "identity" || shard.bytes === shard.decodedBytes), "A shard path/size must match its encoding and original country code.");
export type GazetteerShardDescriptor = z.infer<typeof GazetteerShardDescriptorSchema>;
export const GazetteerManifestSchema = z.object({
  schemaVersion: z.literal(1), provenance: GazetteerProvenanceSchema,
  recordCount: z.number().int().min(1).max(1_000_000),
  shards: z.array(GazetteerShardDescriptorSchema).min(1).max(250),
}).strict().superRefine((manifest, context) => {
  if (new Set(manifest.shards.map((shard) => shard.countryCode)).size !== manifest.shards.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["shards"], message: "Duplicate country shards." });
  if (manifest.shards.reduce((sum, shard) => sum + shard.count, 0) !== manifest.recordCount) context.addIssue({ code: z.ZodIssueCode.custom, path: ["recordCount"], message: "Shard counts must account for all records." });
});
export type GazetteerManifest = z.infer<typeof GazetteerManifestSchema>;
export const GazetteerShardSchema = z.object({
  schemaVersion: z.literal(1), datasetVersion: EntityIdSchema, countryCode: CountryCodeSchema,
  places: z.array(GazetteerPlaceSchema).min(1).max(100_000),
}).strict().superRefine((shard, context) => {
  if (new Set(shard.places.map((place) => place.id)).size !== shard.places.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["places"], message: "Duplicate place identities." });
  if (shard.places.some((place) => place.countryCode !== shard.countryCode)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["places"], message: "Place must retain the shard's original country code." });
});
export type GazetteerShard = z.infer<typeof GazetteerShardSchema>;

export const GeocodingCandidateSchema = z.object({
  id: EntityIdSchema, providerId: EntityIdSchema,
  place: GazetteerPlaceSchema,
  matchedName: name, match: z.enum(["exact-name", "exact-alias", "prefix"]), countryBiasMatched: z.boolean(),
  precision: z.literal("city"), estimated: z.literal(true),
  coordinateMeaning: z.literal("populated-place-reference-point"),
  verification: z.literal("unverified"),
  evidence: z.object({ provenance: GazetteerProvenanceSchema, shardSha256: Sha256Schema, sourceRecordUrl: HttpUrlSchema }).strict(),
}).strict().superRefine((candidate, context) => {
  if (![candidate.place.name, candidate.place.asciiName, ...candidate.place.aliases].includes(candidate.matchedName)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["matchedName"], message: "The matched name must actually occur in the source record." });
});
export type GeocodingCandidate = z.infer<typeof GeocodingCandidateSchema>;
export const GeocodingResultSchema = z.object({
  schemaVersion: z.literal(1), providerId: EntityIdSchema,
  request: GeocodingRequestSchema,
  status: z.enum(["candidates", "unresolved", "not-applicable"]),
  reason: z.enum(["single-exact-city", "ambiguous-place-name", "partial-name-candidates", "no-match-in-scope", "not-an-office"]),
  candidates: z.array(GeocodingCandidateSchema).max(50),
  totalCandidates: z.number().int().nonnegative().max(1_000_000), truncated: z.boolean(),
  requiresConfirmation: z.literal(true),
  searchedCountryCodes: unique(CountryCodeSchema, 250),
  datasetVersion: EntityIdSchema.optional(), warnings: unique(z.string().min(1).max(3000), 100),
}).strict().superRefine((result, context) => {
  const issue = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
  if (result.candidates.length > result.request.limit || result.candidates.length > result.totalCandidates || result.truncated !== (result.totalCandidates > result.candidates.length)) issue("Candidate counts and truncation must agree.");
  if (new Set(result.candidates.map((candidate) => candidate.id)).size !== result.candidates.length) issue("Duplicate candidate identities.");
  if (result.status === "candidates" && (!result.candidates.length || !result.datasetVersion || result.request.kind !== "office")) issue("Candidates require a data version and an office request.");
  if (result.status === "candidates" && !["single-exact-city", "ambiguous-place-name", "partial-name-candidates"].includes(result.reason)) issue("Candidate results require a candidate reason.");
  if (result.status !== "candidates" && (result.candidates.length || result.totalCandidates || result.truncated)) issue("Non-candidate results cannot contain candidates.");
  if (result.status === "not-applicable" && (result.request.kind === "office" || result.reason !== "not-an-office")) issue("Only office locations can be geocoded.");
  if (result.status === "unresolved" && (result.request.kind !== "office" || result.reason !== "no-match-in-scope")) issue("Unresolved office request needs a no-match reason.");
  if (result.reason === "single-exact-city" && (result.totalCandidates !== 1 || result.candidates.some((candidate) => candidate.match === "prefix"))) issue("Single exact city is not a prefix or ambiguous result.");
  if (result.reason === "ambiguous-place-name" && result.totalCandidates < 2) issue("Ambiguity requires at least two candidates.");
  if (result.reason === "partial-name-candidates" && (!result.request.allowPrefix || result.candidates.some((candidate) => candidate.match !== "prefix"))) issue("Partial matches must be requested explicitly.");
  for (const candidate of result.candidates) {
    if (candidate.providerId !== result.providerId || candidate.evidence.provenance.version !== result.datasetVersion) issue("Candidate provider/data version differs from the result.");
    const matched = normalizeGeographicName(candidate.matchedName);
    const raw = normalizeGeographicName(result.request.raw);
    if (candidate.match === "prefix" ? !result.request.allowPrefix || !matched.startsWith(raw) : matched !== raw) issue("Candidate match differs from the requested name.");
    if (candidate.match === "exact-name" && candidate.matchedName !== candidate.place.name) issue("An exact primary-name match must use the source primary name.");
    if (result.request.countryCodes.length && ![candidate.place.countryCode, ...candidate.place.alternateCountryCodes].some((country) => result.request.countryCodes.includes(country))) issue("Candidate lies outside the explicit country scope.");
    for (const [level, value] of Object.entries(result.request.administrativeCodes ?? {})) if (candidate.place.administrativeCodes[level as keyof typeof candidate.place.administrativeCodes] !== value) issue("Candidate lies outside the administrative scope.");
    if (result.request.bounds) {
      const [west, south, east, north] = result.request.bounds;
      const { latitude, longitude } = candidate.place.coordinates;
      if (latitude < south || latitude > north || !(west <= east ? longitude >= west && longitude <= east : longitude >= west || longitude <= east)) issue("Candidate lies outside the geographic bounds.");
    }
  }
});
export type GeocodingResult = z.infer<typeof GeocodingResultSchema>;
export const GeocodingSelectionSchema = z.object({
  schemaVersion: z.literal(1), raw: z.string().min(1).max(1000), kind: z.literal("office"),
  candidate: GeocodingCandidateSchema,
  selection: z.literal("explicit-candidate-selection"),
  /** User choice confirms intended place, not the accuracy of an employer's street address. */
  verification: z.literal("unverified"),
}).strict();
export type GeocodingSelection = z.infer<typeof GeocodingSelectionSchema>;

/** Explicit selection returns a proposal; it does not mutate a listing, location or personal fact. */
export function acceptGeocodingCandidate(input: GeocodingResult, candidateId: string): GeocodingSelection {
  const result = GeocodingResultSchema.parse(input);
  const candidate = result.candidates.find((candidate) => candidate.id === candidateId);
  if (result.status !== "candidates" || !candidate) throw new Error("Select a returned office-place candidate.");
  return GeocodingSelectionSchema.parse({ schemaVersion: 1, raw: result.request.raw, kind: "office", candidate, selection: "explicit-candidate-selection", verification: "unverified" });
}
