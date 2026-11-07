import { z } from "zod";
import { CanonicalJobSchema, CompanySchema, JobLocationSchema, EntityIdSchema, TimestampSchema, HttpUrlSchema, LocationPrecisionSchema } from "./schema.js";
import { NormalizedCompensationSchema } from "./compensation.js";
import { LocationDistanceSchema } from "./geo.js";
import { CompanyColorMatchSchema } from "./colors.js";
import { JobQuerySchema, type JobQueryResult } from "./query.js";
import { ResolvedCityMapReferenceSchema } from "./query-map-references.js";

const CountSchema = z.number().int().nonnegative();
const FacetSchema = z.record(z.string(), CountSchema);
export const JobSearchItemSchema = z.object({
  job: CanonicalJobSchema, company: CompanySchema, locations: z.array(JobLocationSchema),
  salary: NormalizedCompensationSchema.optional(), salaryCny: z.number().finite().nonnegative().optional(),
  salaryCandidates: z.array(NormalizedCompensationSchema),
  salarySelection: z.enum(["none", "single", "equivalent", "ambiguous"]),
  salaryLocationScope: z.enum(["bound", "unscoped"]),
  distance: LocationDistanceSchema.optional(), color: CompanyColorMatchSchema,
  mapReferences: z.array(ResolvedCityMapReferenceSchema).max(1000).optional(),
  relevance: z.number().finite().nonnegative(), matchedFields: z.array(z.string()),
  sources: z.array(z.object({ sourceId: EntityIdSchema, label: z.string().min(1), url: HttpUrlSchema.optional(), listingId: EntityIdSchema }).strict()),
}).strict().superRefine((item, context) => {
  if (item.salarySelection === "ambiguous" && (item.salary !== undefined || item.salaryCny !== undefined)) {
    context.addIssue({ code: "custom", message: "Ambiguous salary candidates cannot select an arbitrary amount." });
  }
  if (item.salaryCny !== undefined && !item.salary?.cnyAnnual) {
    context.addIssue({ code: "custom", message: "A salary sort value requires CNY annual evidence." });
  }
  if (item.distance && !item.locations.some((location) => location.id === item.distance!.locationId)) {
    context.addIssue({ code: "custom", message: "Distance must reference a matched job location." });
  }
  if (item.mapReferences && (item.job.workMode === "remote" || new Set(item.mapReferences.map(reference => reference.locationId)).size !== item.mapReferences.length
    || item.mapReferences.some(reference => !item.locations.some(location => location.id === reference.locationId && !location.coordinates && location.kind !== "remote-region" && location.countryCode === reference.countryCode)))) {
    context.addIssue({ code: "custom", message: "City references must belong to distinct matched nonremote locations without source coordinates." });
  }
});
export const MapBucketSchema = z.object({
  id: z.string().min(1), label: z.string().min(1),
  latitude: z.number().finite().min(-90).max(90), longitude: z.number().finite().min(-180).max(180),
  jobIds: z.array(EntityIdSchema), locationIds: z.array(EntityIdSchema), jobCount: CountSchema, pinCount: CountSchema,
  categories: z.array(z.object({ ruleId: z.string().min(1), label: z.string().min(1), color: z.string().regex(/^#[a-fA-F0-9]{6}$/), jobCount: CountSchema }).strict()),
  positionBasis: z.literal("city-reference").optional(), precision: LocationPrecisionSchema.optional(), estimated: z.literal(true).optional(),
}).strict().superRefine((bucket, context) => {
  if (bucket.positionBasis === "city-reference" && (bucket.precision !== "city" || bucket.estimated !== true)) {
    context.addIssue({ code: "custom", message: "City reference buckets require city precision and an estimated label." });
  }
  if (bucket.positionBasis === undefined && bucket.estimated !== undefined) {
    context.addIssue({ code: "custom", message: "Source coordinate buckets cannot be marked as estimated." });
  }
});

/** The actual JSON response contract, including nested domain/value validation. */
export const JobQueryResultSchema: z.ZodType<JobQueryResult, z.ZodTypeDef, unknown> = z.object({
  queryId: z.string().regex(/^query_[a-f0-9]{64}$/), snapshotVersion: CountSchema, asOf: TimestampSchema,
  normalizedQuery: JobQuerySchema,
  totalJobs: CountSchema, companyCount: CountSchema, mappedJobs: CountSchema, unlocatedJobs: CountSchema, locationPinCount: CountSchema,
  unknownSalaryCount: CountSchema, unknownDistanceCount: CountSchema,
  mapReferenceCoverage: z.object({ cityReferenceJobs: CountSchema, cityReferencePinCount: CountSchema, mapVisibleJobs: CountSchema, mapPendingJobs: CountSchema,
    processedLocations: CountSchema, totalLocations: CountSchema, truncated: z.boolean() }).strict().optional(),
  items: z.array(JobSearchItemSchema).max(200), nextCursor: z.string().regex(/^query_[a-f0-9]{64}:\d+$/).optional(),
  mapBuckets: z.array(MapBucketSchema),
  facets: z.object({ countries: FacetSchema, controllerJurisdictions: FacetSchema, ownership: FacetSchema, sources: FacetSchema }).strict(),
  sourceCoverage: z.array(z.object({ sourceId: EntityIdSchema, listings: CountSchema, lastObservedAt: TimestampSchema.optional(), partial: z.boolean(), failed: z.boolean(), needsHuman: z.boolean() }).strict()),
}).strict().superRefine((result, context) => {
  if (result.mappedJobs + result.unlocatedJobs !== result.totalJobs || result.items.length > result.totalJobs || result.companyCount > result.totalJobs || result.unknownSalaryCount > result.totalJobs || result.unknownDistanceCount > result.totalJobs || result.locationPinCount < result.mappedJobs) {
    context.addIssue({ code: "custom", message: "Query totals do not describe the same full result set." });
  }
  if (new Set(result.items.map((item) => item.job.id)).size !== result.items.length || result.mapBuckets.reduce((sum, bucket) => sum + bucket.pinCount, 0) !== result.locationPinCount + (result.mapReferenceCoverage?.cityReferencePinCount ?? 0)) {
    context.addIssue({ code: "custom", message: "Map/list identity counts are inconsistent." });
  }
  const referenceCoverage = result.mapReferenceCoverage;
  const sourceJobs = new Set(result.mapBuckets.filter(bucket => !bucket.positionBasis).flatMap(bucket => bucket.jobIds));
  const referenceJobs = new Set(result.mapBuckets.filter(bucket => bucket.positionBasis === "city-reference").flatMap(bucket => bucket.jobIds));
  const visibleJobs = new Set([...sourceJobs, ...referenceJobs]);
  if (referenceCoverage && (referenceCoverage.mapVisibleJobs + referenceCoverage.mapPendingJobs !== result.totalJobs
    || result.mappedJobs !== sourceJobs.size || referenceCoverage.cityReferenceJobs !== referenceJobs.size || referenceCoverage.mapVisibleJobs !== visibleJobs.size
    || result.mapBuckets.some(bucket => bucket.jobCount !== new Set(bucket.jobIds).size || bucket.jobCount !== bucket.jobIds.length || bucket.pinCount < bucket.jobCount)
    || referenceCoverage.mapVisibleJobs < Math.max(result.mappedJobs, referenceCoverage.cityReferenceJobs)
    || referenceCoverage.mapVisibleJobs > result.mappedJobs + referenceCoverage.cityReferenceJobs
    || referenceCoverage.cityReferenceJobs > referenceCoverage.cityReferencePinCount
    || referenceCoverage.processedLocations > referenceCoverage.totalLocations
    || referenceCoverage.truncated !== (referenceCoverage.processedLocations < referenceCoverage.totalLocations)
    || result.mapBuckets.filter(bucket => bucket.positionBasis === "city-reference").reduce((sum, bucket) => sum + bucket.pinCount, 0) !== referenceCoverage.cityReferencePinCount)) {
    context.addIssue({ code: "custom", message: "City reference coverage must describe the same map and complete filtered job set." });
  }
  if (!referenceCoverage && (result.mapBuckets.some(bucket => bucket.positionBasis) || result.items.some(item => item.mapReferences?.length))) {
    context.addIssue({ code: "custom", message: "Derived city points require explicit reference coverage." });
  }
});
