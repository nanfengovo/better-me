import { z } from "zod";
import { CanonicalJobSchema, CompanySchema, JobLocationSchema, EntityIdSchema, TimestampSchema, HttpUrlSchema } from "./schema.js";
import { NormalizedCompensationSchema } from "./compensation.js";
import { LocationDistanceSchema } from "./geo.js";
import { CompanyColorMatchSchema } from "./colors.js";
import { JobQuerySchema, type JobQueryResult } from "./query.js";

const CountSchema = z.number().int().nonnegative();
const FacetSchema = z.record(z.string(), CountSchema);
export const JobSearchItemSchema = z.object({
  job: CanonicalJobSchema, company: CompanySchema, locations: z.array(JobLocationSchema),
  salary: NormalizedCompensationSchema.optional(), salaryCny: z.number().finite().nonnegative().optional(),
  salaryCandidates: z.array(NormalizedCompensationSchema),
  salarySelection: z.enum(["none", "single", "equivalent", "ambiguous"]),
  salaryLocationScope: z.enum(["bound", "unscoped"]),
  distance: LocationDistanceSchema.optional(), color: CompanyColorMatchSchema,
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
});
export const MapBucketSchema = z.object({
  id: z.string().min(1), label: z.string().min(1),
  latitude: z.number().finite().min(-90).max(90), longitude: z.number().finite().min(-180).max(180),
  jobIds: z.array(EntityIdSchema), locationIds: z.array(EntityIdSchema), jobCount: CountSchema, pinCount: CountSchema,
  categories: z.array(z.object({ ruleId: z.string().min(1), label: z.string().min(1), color: z.string().regex(/^#[a-fA-F0-9]{6}$/), jobCount: CountSchema }).strict()),
}).strict();

/** The actual JSON response contract, including nested domain/value validation. */
export const JobQueryResultSchema: z.ZodType<JobQueryResult, z.ZodTypeDef, unknown> = z.object({
  queryId: z.string().regex(/^query_[a-f0-9]{64}$/), snapshotVersion: CountSchema, asOf: TimestampSchema,
  normalizedQuery: JobQuerySchema,
  totalJobs: CountSchema, companyCount: CountSchema, mappedJobs: CountSchema, unlocatedJobs: CountSchema, locationPinCount: CountSchema,
  unknownSalaryCount: CountSchema, unknownDistanceCount: CountSchema,
  items: z.array(JobSearchItemSchema).max(200), nextCursor: z.string().regex(/^query_[a-f0-9]{64}:\d+$/).optional(),
  mapBuckets: z.array(MapBucketSchema),
  facets: z.object({ countries: FacetSchema, controllerJurisdictions: FacetSchema, ownership: FacetSchema, sources: FacetSchema }).strict(),
  sourceCoverage: z.array(z.object({ sourceId: EntityIdSchema, listings: CountSchema, lastObservedAt: TimestampSchema.optional(), partial: z.boolean(), failed: z.boolean(), needsHuman: z.boolean() }).strict()),
}).strict().superRefine((result, context) => {
  if (result.mappedJobs + result.unlocatedJobs !== result.totalJobs || result.items.length > result.totalJobs || result.companyCount > result.totalJobs || result.unknownSalaryCount > result.totalJobs || result.unknownDistanceCount > result.totalJobs || result.locationPinCount < result.mappedJobs) {
    context.addIssue({ code: "custom", message: "Query totals do not describe the same full result set." });
  }
  if (new Set(result.items.map((item) => item.job.id)).size !== result.items.length || result.mapBuckets.reduce((sum, bucket) => sum + bucket.pinCount, 0) !== result.locationPinCount) {
    context.addIssue({ code: "custom", message: "Map/list identity counts are inconsistent." });
  }
});
