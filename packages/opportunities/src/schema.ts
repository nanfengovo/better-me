import { z } from "zod";

/** These are wire contracts. Parsing never supplies invented domain values. */
export const EntityIdSchema = z.string().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const TimestampSchema = z.string().datetime({ offset: true }).max(64);
export const RevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const CountryCodeSchema = z.string().regex(/^[A-Z]{2}$/);
export const CurrencyCodeSchema = z.string().regex(/^[A-Z]{3}$/);
export const VerificationSchema = z.enum(["verified", "unverified", "conflicting", "unknown"]);
export type Verification = z.infer<typeof VerificationSchema>;

/** Syntax validation only; an executor must separately enforce DNS/redirect/endpoint policy. */
export const HttpUrlSchema = z.string().min(1).max(4096).refine((value) => {
  if (value !== value.trim() || [...value].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}, "Expected an HTTP(S) URL without credentials or unescaped whitespace.");

export const DomainSchema = z.string().min(1).max(253).refine((value) =>
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(value),
"Expected a hostname, without a URL, credentials, path, or port.");

function uniqueArray<T extends z.ZodTypeAny>(schema: T, max: number) {
  return z.array(schema).max(max).superRefine((values, context) => {
    const keys = values.map((value) => JSON.stringify(value));
    if (new Set(keys).size !== keys.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate array values are not allowed." });
    }
  });
}

export const EvidenceRefSchema = z.object({
  observationId: EntityIdSchema,
  sourceUrl: HttpUrlSchema,
  selector: z.string().min(1).max(1000).optional(),
  quote: z.string().min(1).max(20_000).optional(),
  observedAt: TimestampSchema,
}).strict();
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
export const EvidenceMethodSchema = z.enum(["source-structured", "parser", "model-proposal", "manual"]);
export type EvidenceMethod = z.infer<typeof EvidenceMethodSchema>;

export function createEvidencedSchema<T extends z.ZodTypeAny>(valueSchema: T) {
  return z.object({
    value: valueSchema,
    evidence: z.array(EvidenceRefSchema).max(200),
    method: EvidenceMethodSchema,
    verification: VerificationSchema,
    revision: RevisionSchema,
  }).strict().superRefine((field, context) => {
    if (field.verification === "verified" && field.evidence.length === 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["evidence"], message: "Verified values require source evidence." });
    }
    if (field.verification === "verified" && field.method === "model-proposal") {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["verification"], message: "A model proposal is not verified evidence." });
    }
  });
}
export type Evidenced<T> = {
  value: T;
  evidence: EvidenceRef[];
  method: EvidenceMethod;
  verification: Verification;
  revision: number;
};

export const ControllerKindSchema = z.enum(["state", "private", "dispersed", "joint", "unknown"]);
export type ControllerKind = z.infer<typeof ControllerKindSchema>;
export const CompanyControllerSchema = z.object({
  name: z.string().trim().min(1).max(500),
  jurisdictionCode: CountryCodeSchema.optional(),
  kind: ControllerKindSchema,
}).strict();
export type CompanyController = z.infer<typeof CompanyControllerSchema>;
export const CompanyControllersSchema = createEvidencedSchema(z.array(CompanyControllerSchema).max(100));
export const EvidencedTextSchema = createEvidencedSchema(z.string().trim().min(1).max(2000));

const OverrideMetadata = {
  id: EntityIdSchema,
  reason: z.string().trim().min(1).max(2000),
  at: TimestampSchema,
  actor: z.string().min(1).max(240).optional(),
  basedOnRevision: RevisionSchema,
};
export const CompanyManualOverrideSchema = z.discriminatedUnion("field", [
  z.object({ ...OverrideMetadata, field: z.literal("legalEntity"), value: EvidencedTextSchema }).strict(),
  z.object({ ...OverrideMetadata, field: z.literal("ultimateControllers"), value: CompanyControllersSchema }).strict(),
  z.object({ ...OverrideMetadata, field: z.literal("names"), value: uniqueArray(z.string().trim().min(1).max(500), 100) }).strict(),
  z.object({ ...OverrideMetadata, field: z.literal("domains"), value: uniqueArray(DomainSchema, 100) }).strict(),
  z.object({ ...OverrideMetadata, field: z.literal("parentCompanyIds"), value: uniqueArray(EntityIdSchema, 100) }).strict(),
]);
export type CompanyManualOverride = z.infer<typeof CompanyManualOverrideSchema>;
export const CompanySchema = z.object({
  id: EntityIdSchema,
  names: uniqueArray(z.string().trim().min(1).max(500), 100).refine((names) => names.length > 0, "A company requires at least one name."),
  domains: uniqueArray(DomainSchema, 100),
  legalEntity: EvidencedTextSchema.optional(),
  parentCompanyIds: uniqueArray(EntityIdSchema, 100),
  ultimateControllers: CompanyControllersSchema,
  manualOverrides: z.array(CompanyManualOverrideSchema).max(1000),
}).strict().superRefine((company, context) => {
  if (company.parentCompanyIds.includes(company.id)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["parentCompanyIds"], message: "A company cannot be its own parent." });
  }
});
export type Company = z.infer<typeof CompanySchema>;

export const WorkModeSchema = z.enum(["on-site", "hybrid", "remote", "unknown"]);
export type WorkMode = z.infer<typeof WorkModeSchema>;
export const EmploymentTypeSchema = z.enum(["social", "campus", "internship", "unknown"]);
export type EmploymentType = z.infer<typeof EmploymentTypeSchema>;
export const AvailabilitySchema = z.enum(["open", "closed", "unknown"]);
export type Availability = z.infer<typeof AvailabilitySchema>;
export const CanonicalJobSchema = z.object({
  id: EntityIdSchema,
  companyId: EntityIdSchema,
  title: createEvidencedSchema(z.string().trim().min(1).max(1000)),
  description: z.string().max(2_000_000),
  roleFamily: EvidencedTextSchema.optional(),
  seniority: EvidencedTextSchema.optional(),
  locationIds: uniqueArray(EntityIdSchema, 1000),
  compensationIds: uniqueArray(EntityIdSchema, 100),
  listingIds: uniqueArray(EntityIdSchema, 1000),
  selectedSnapshotId: EntityIdSchema.optional(),
  workMode: WorkModeSchema,
  employmentType: EmploymentTypeSchema,
  remoteEligibleRegions: uniqueArray(z.string().trim().min(1).max(240), 500),
  status: AvailabilitySchema,
  revision: RevisionSchema,
  updatedAt: TimestampSchema,
}).strict();
export type CanonicalJob = z.infer<typeof CanonicalJobSchema>;

export const CoordinatesSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  coordinateSystem: z.literal("WGS84"),
}).strict();
export type Coordinates = z.infer<typeof CoordinatesSchema>;
export const OriginalCoordinatesSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  coordinateSystem: z.enum(["WGS84", "GCJ02", "BD09"]),
}).strict();
export type OriginalCoordinates = z.infer<typeof OriginalCoordinatesSchema>;
export const LocationPrecisionSchema = z.enum(["country", "region", "city", "street", "address", "manual", "unknown"]);
export type LocationPrecision = z.infer<typeof LocationPrecisionSchema>;
export const JobLocationSchema = z.object({
  id: EntityIdSchema,
  raw: z.string().min(1).max(5000),
  kind: z.enum(["office", "remote-region", "unknown"]).optional(),
  regionId: z.string().min(1).max(240).optional(),
  countryCode: CountryCodeSchema.optional(),
  region: z.string().min(1).max(500).optional(),
  city: z.string().min(1).max(500).optional(),
  coordinates: CoordinatesSchema.optional(),
  originalCoordinates: OriginalCoordinatesSchema.optional(),
  precision: LocationPrecisionSchema,
  provider: z.string().min(1).max(240).optional(),
  resolvedAt: TimestampSchema.optional(),
  evidence: z.array(EvidenceRefSchema).max(200),
  verification: VerificationSchema,
}).strict().superRefine((location, context) => {
  if (location.verification === "verified" && location.evidence.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["evidence"], message: "Verified locations require evidence." });
  }
  if (location.coordinates && location.precision === "unknown") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["precision"], message: "Coordinates require an explicit precision." });
  }
  if (location.kind === "remote-region" && location.coordinates) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["coordinates"], message: "A remote eligibility region is not an office point." });
  }
});
export type JobLocation = z.infer<typeof JobLocationSchema>;

export const CompensationPeriodSchema = z.enum(["hour", "day", "week", "month", "year", "unknown"]);
export type CompensationPeriod = z.infer<typeof CompensationPeriodSchema>;
export const CompensationKindSchema = z.enum(["base", "bonus", "equity", "total", "unknown"]);
export type CompensationKind = z.infer<typeof CompensationKindSchema>;
export const CompensationSchema = z.object({
  id: EntityIdSchema,
  /** Absent means source-wide / unscoped; never infer a specific office from array order. */
  locationIds: uniqueArray(EntityIdSchema, 1000).optional(),
  raw: z.string().min(1).max(5000),
  currency: CurrencyCodeSchema.optional(),
  period: CompensationPeriodSchema,
  min: z.number().finite().nonnegative().max(1_000_000_000_000).optional(),
  max: z.number().finite().nonnegative().max(1_000_000_000_000).optional(),
  tax: z.enum(["gross", "net", "unknown"]),
  kind: CompensationKindSchema,
  monthsPerYear: z.number().finite().positive().max(36).optional(),
  hoursPerYear: z.number().finite().positive().max(8784).optional(),
  daysPerYear: z.number().finite().positive().max(366).optional(),
  weeksPerYear: z.number().finite().positive().max(53).optional(),
  verification: VerificationSchema,
  evidence: z.array(EvidenceRefSchema).max(200),
}).strict().superRefine((salary, context) => {
  if (salary.min !== undefined && salary.max !== undefined && salary.min > salary.max) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["max"], message: "The upper salary bound cannot be below the lower bound." });
  }
  if (salary.verification === "verified" && salary.evidence.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["evidence"], message: "Verified compensation requires evidence." });
  }
});
export type Compensation = z.infer<typeof CompensationSchema>;

export const SourceCapabilitySchema = z.enum(["discover-sources", "search-remote", "list-jobs", "read-detail", "verify-status", "delta-sync"]);
export type SourceCapability = z.infer<typeof SourceCapabilitySchema>;
export const SourceRuntimeSchema = z.enum(["local-service", "browser-companion", "server"]);
export type SourceRuntime = z.infer<typeof SourceRuntimeSchema>;
export const SourceEntityTypeSchema = z.enum(["job-posting", "recruitment-campaign", "company-directory"]);
export type SourceEntityType = z.infer<typeof SourceEntityTypeSchema>;
export const SourceOptionValueSchema = z.union([
  z.string().max(4096), z.number().finite(), z.boolean(), z.null(),
  z.array(z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null()])).max(100),
]);
export const SourceOptionsSchema = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/), SourceOptionValueSchema)
  .superRefine((options, context) => {
    const keys = Object.keys(options);
    if (keys.length > 100) context.addIssue({ code: z.ZodIssueCode.custom, message: "Too many source options." });
    for (const key of keys) {
      if (/^(?:api[-_]?key|authorization|password|cookie|secret|access[-_]?token|refresh[-_]?token|client[-_]?secret)$/i.test(key)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: "Credentials belong in a secret store referenced by secretRef, not public source options." });
      }
    }
  });
export type SourceOptions = z.infer<typeof SourceOptionsSchema>;
export const EndpointPolicySchema = z.object({
  allowedHosts: uniqueArray(DomainSchema, 100),
  allowedPathPrefixes: uniqueArray(z.string().min(1).max(1000).regex(/^\/(?!\/)/), 100),
  requireHttps: z.boolean(),
  allowRedirects: z.boolean(),
  maxRedirects: z.number().int().min(0).max(10),
}).strict().superRefine((policy, context) => {
  if (!policy.allowRedirects && policy.maxRedirects !== 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["maxRedirects"], message: "Disabled redirects require a zero redirect budget." });
  }
});
export type EndpointPolicy = z.infer<typeof EndpointPolicySchema>;
export const AttributionPolicySchema = z.object({
  label: z.string().trim().min(1).max(240),
  homepageUrl: HttpUrlSchema.optional(),
  license: z.string().min(1).max(500).optional(),
  usage: z.enum(["link-only", "metadata", "full-text", "unknown"]),
  requiresAttribution: z.boolean(),
  notes: z.string().max(5000).optional(),
}).strict();
export type AttributionPolicy = z.infer<typeof AttributionPolicySchema>;
export const RefreshPolicySchema = z.object({
  mode: z.enum(["manual", "scheduled"]),
  minIntervalSeconds: z.number().int().min(0).max(31_536_000),
  maxRecords: z.number().int().min(1).max(100_000),
  maxPages: z.number().int().min(1).max(10_000),
  requestsPerMinute: z.number().int().min(1).max(6000),
}).strict();
export type RefreshPolicy = z.infer<typeof RefreshPolicySchema>;
export const SourceDefinitionSchema = z.object({
  sourceId: EntityIdSchema,
  name: z.string().trim().min(1).max(240),
  adapterId: EntityIdSchema,
  adapterVersion: z.string().min(1).max(80),
  capabilities: uniqueArray(SourceCapabilitySchema, 6),
  runtime: uniqueArray(SourceRuntimeSchema, 3).refine((values) => values.length > 0, "A source needs an execution runtime."),
  entityType: SourceEntityTypeSchema,
  enabled: z.boolean(),
  status: z.enum(["active", "needs-review", "disabled", "unavailable"]),
  entryUrl: HttpUrlSchema.optional(),
  options: SourceOptionsSchema.optional(),
  remoteFilters: uniqueArray(z.string().min(1).max(80), 100),
  endpointPolicy: EndpointPolicySchema,
  attribution: AttributionPolicySchema,
  refreshPolicy: RefreshPolicySchema,
  secretRef: EntityIdSchema.optional(),
}).strict();
export type SourceDefinition = z.infer<typeof SourceDefinitionSchema>;
/** The registry contains configuration and secret references, never secret values. */
export const SourceConfigSchema = SourceDefinitionSchema;
export type SourceConfig = SourceDefinition;

export const SourceListingSchema = z.object({
  id: EntityIdSchema,
  sourceId: EntityIdSchema,
  sourceRecordId: z.string().min(1).max(1000).optional(),
  canonicalUrl: HttpUrlSchema.optional(),
  applicationUrl: HttpUrlSchema.optional(),
  discoverySourceIds: uniqueArray(EntityIdSchema, 100).optional(),
  discoveredViaUrls: uniqueArray(HttpUrlSchema, 100).optional(),
  canonicalJobId: EntityIdSchema.optional(),
  /** Current source contributions keep refreshes from removing another listing's locations/pay. */
  locationIds: uniqueArray(EntityIdSchema, 1000).optional(),
  compensationIds: uniqueArray(EntityIdSchema, 1000).optional(),
  observationIds: uniqueArray(EntityIdSchema, 10_000),
  firstDiscoveredAt: TimestampSchema,
  recordLastSeenAt: TimestampSchema.optional(),
}).strict().superRefine((listing, context) => {
  if (!listing.sourceRecordId && !listing.canonicalUrl) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["canonicalUrl"], message: "A listing requires a source record ID or canonical URL." });
  }
});
export type SourceListing = z.infer<typeof SourceListingSchema>;

export const ObservationResultSchema = z.enum(["read", "partial", "failed", "needs-human"]);
export type ObservationResult = z.infer<typeof ObservationResultSchema>;
export const CompletenessSchema = z.enum(["detail", "excerpt", "lead"]);
export type Completeness = z.infer<typeof CompletenessSchema>;
/** Append-only. fetchedAt does not imply publication or availability verification. */
export const SourceObservationSchema = z.object({
  id: EntityIdSchema,
  listingId: EntityIdSchema,
  fetchedAt: TimestampSchema,
  feedFetchedAt: TimestampSchema.optional(),
  detailFetchedAt: TimestampSchema.optional(),
  sourcePublishedRaw: z.string().max(1000).optional(),
  sourcePublishedAt: TimestampSchema.optional(),
  sourceUpdatedRaw: z.string().max(1000).optional(),
  sourceUpdatedAt: TimestampSchema.optional(),
  availabilityVerifiedAt: TimestampSchema.optional(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  snapshotId: EntityIdSchema.optional(),
  result: ObservationResultSchema,
  availability: AvailabilitySchema,
  availabilityMethod: z.enum(["source-explicit", "detail-explicit", "manual"]).optional(),
  completeness: CompletenessSchema,
  rawText: z.string().max(2_000_000).optional(),
  warnings: z.array(z.string().min(1).max(2000)).max(100),
  errorCode: z.string().min(1).max(120).optional(),
}).strict().superRefine((observation, context) => {
  if (observation.availabilityVerifiedAt &&
      (observation.availability === "unknown" || !observation.availabilityMethod)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["availabilityVerifiedAt"], message: "Availability verification requires an explicit status and method." });
  }
  if ((observation.result === "failed" || observation.result === "needs-human") && observation.availability !== "unknown") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["availability"], message: "A failed or human-blocked read cannot establish availability." });
  }
});
export type SourceObservation = z.infer<typeof SourceObservationSchema>;
export const ObservationSchema = SourceObservationSchema;
export type Observation = SourceObservation;

/** Snapshots are immutable content versions; mutable current projections only hold their IDs. */
export const JdSnapshotSchema = z.object({
  id: EntityIdSchema,
  listingId: EntityIdSchema,
  observationId: EntityIdSchema,
  text: z.string().min(1).max(2_000_000),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: TimestampSchema,
  sourceUrl: HttpUrlSchema.optional(),
  extractionMethod: z.enum(["source-structured", "parser", "browser", "manual", "model-transcription"]),
  completeness: CompletenessSchema,
}).strict();
export type JdSnapshot = z.infer<typeof JdSnapshotSchema>;

export const AtlasDatasetObjectSchema = z.object({
  schemaVersion: z.literal(1),
  revision: RevisionSchema,
  sources: z.array(SourceDefinitionSchema).max(10_000),
  companies: z.array(CompanySchema).max(100_000),
  jobs: z.array(CanonicalJobSchema).max(100_000),
  locations: z.array(JobLocationSchema).max(200_000),
  compensations: z.array(CompensationSchema).max(200_000),
  listings: z.array(SourceListingSchema).max(300_000),
  observations: z.array(SourceObservationSchema).max(1_000_000),
  snapshots: z.array(JdSnapshotSchema).max(1_000_000),
}).strict();
export type AtlasDataset = z.infer<typeof AtlasDatasetObjectSchema>;
export type DatasetReferenceIssue = {
  code: "duplicate-id" | "missing-reference" | "inconsistent-reference";
  path: Array<string | number>;
  message: string;
};

/** Public for repositories that validate transactions without reparsing large unchanged text. */
export function validateAtlasDatasetReferences(dataset: AtlasDataset): DatasetReferenceIssue[] {
  const issues: DatasetReferenceIssue[] = [];
  const tables = ["sources", "companies", "jobs", "locations", "compensations", "listings", "observations", "snapshots"] as const;
  const ids: Record<typeof tables[number], Set<string>> = {
    sources: new Set(), companies: new Set(), jobs: new Set(), locations: new Set(),
    compensations: new Set(), listings: new Set(), observations: new Set(), snapshots: new Set(),
  };
  for (const table of tables) {
    dataset[table].forEach((row, index) => {
      const id = "sourceId" in row && table === "sources" ? row.sourceId : (row as { id: string }).id;
      if (ids[table].has(id)) issues.push({ code: "duplicate-id", path: [table, index], message: `Duplicate ${table} ID: ${id}` });
      ids[table].add(id);
    });
  }
  const requireRef = (table: typeof tables[number], id: string, path: Array<string | number>) => {
    if (!ids[table].has(id)) issues.push({ code: "missing-reference", path, message: `Missing ${table} reference: ${id}` });
  };
  const evidenceRefs = (refs: EvidenceRef[], path: Array<string | number>) => refs.forEach((ref, index) =>
    requireRef("observations", ref.observationId, [...path, index, "observationId"]));
  dataset.companies.forEach((company, index) => {
    company.parentCompanyIds.forEach((id, i) => requireRef("companies", id, ["companies", index, "parentCompanyIds", i]));
    evidenceRefs(company.ultimateControllers.evidence, ["companies", index, "ultimateControllers", "evidence"]);
    if (company.legalEntity) evidenceRefs(company.legalEntity.evidence, ["companies", index, "legalEntity", "evidence"]);
    company.manualOverrides.forEach((override, i) => {
      if (override.field === "legalEntity" || override.field === "ultimateControllers") {
        evidenceRefs(override.value.evidence, ["companies", index, "manualOverrides", i, "value", "evidence"]);
      } else if (override.field === "parentCompanyIds") {
        override.value.forEach((id, j) => requireRef("companies", id, ["companies", index, "manualOverrides", i, "value", j]));
      }
    });
  });
  const listingById = new Map(dataset.listings.map((listing) => [listing.id, listing]));
  const jobById = new Map(dataset.jobs.map((job) => [job.id, job]));
  const observationById = new Map(dataset.observations.map((observation) => [observation.id, observation]));
  const snapshotById = new Map(dataset.snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const compensationById = new Map(dataset.compensations.map((compensation) => [compensation.id, compensation]));
  const listingOwners = new Map<string, string>();
  dataset.jobs.forEach((job, index) => {
    requireRef("companies", job.companyId, ["jobs", index, "companyId"]);
    job.locationIds.forEach((id, i) => requireRef("locations", id, ["jobs", index, "locationIds", i]));
    job.compensationIds.forEach((id, i) => {
      requireRef("compensations", id, ["jobs", index, "compensationIds", i]);
      if (compensationById.get(id)?.locationIds?.some((locationId) => !job.locationIds.includes(locationId))) {
        issues.push({ code: "inconsistent-reference", path: ["jobs", index, "compensationIds", i], message: "Compensation location does not belong to this job." });
      }
    });
    job.listingIds.forEach((id, i) => {
      requireRef("listings", id, ["jobs", index, "listingIds", i]);
      const owner = listingOwners.get(id);
      if (owner && owner !== job.id) {
        issues.push({ code: "inconsistent-reference", path: ["jobs", index, "listingIds", i], message: "A source listing cannot belong to multiple canonical jobs." });
      }
      listingOwners.set(id, job.id);
      const listing = listingById.get(id);
      if (listing?.canonicalJobId && listing.canonicalJobId !== job.id) {
        issues.push({ code: "inconsistent-reference", path: ["jobs", index, "listingIds", i], message: "Listing belongs to a different canonical job." });
      }
    });
    if (job.selectedSnapshotId) {
      requireRef("snapshots", job.selectedSnapshotId, ["jobs", index, "selectedSnapshotId"]);
      const snapshot = snapshotById.get(job.selectedSnapshotId);
      if (snapshot && !job.listingIds.includes(snapshot.listingId)) {
        issues.push({ code: "inconsistent-reference", path: ["jobs", index, "selectedSnapshotId"], message: "Selected snapshot is not from this job's listings." });
      }
    }
    evidenceRefs(job.title.evidence, ["jobs", index, "title", "evidence"]);
    if (job.roleFamily) evidenceRefs(job.roleFamily.evidence, ["jobs", index, "roleFamily", "evidence"]);
    if (job.seniority) evidenceRefs(job.seniority.evidence, ["jobs", index, "seniority", "evidence"]);
  });
  dataset.locations.forEach((location, index) => evidenceRefs(location.evidence, ["locations", index, "evidence"]));
  dataset.compensations.forEach((compensation, index) => {
    evidenceRefs(compensation.evidence, ["compensations", index, "evidence"]);
    compensation.locationIds?.forEach((id, i) => requireRef("locations", id, ["compensations", index, "locationIds", i]));
  });
  dataset.listings.forEach((listing, index) => {
    requireRef("sources", listing.sourceId, ["listings", index, "sourceId"]);
    listing.locationIds?.forEach((id, i) => requireRef("locations", id, ["listings", index, "locationIds", i]));
    listing.compensationIds?.forEach((id, i) => requireRef("compensations", id, ["listings", index, "compensationIds", i]));
    listing.discoverySourceIds?.forEach((id, i) => requireRef("sources", id, ["listings", index, "discoverySourceIds", i]));
    if (listing.canonicalJobId) {
      requireRef("jobs", listing.canonicalJobId, ["listings", index, "canonicalJobId"]);
      const owner = jobById.get(listing.canonicalJobId);
      if (owner && !owner.listingIds.includes(listing.id)) {
        issues.push({ code: "inconsistent-reference", path: ["listings", index, "canonicalJobId"], message: "Canonical job does not include this listing." });
      }
    }
    listing.observationIds.forEach((id, i) => {
      requireRef("observations", id, ["listings", index, "observationIds", i]);
      if (observationById.get(id)?.listingId !== undefined && observationById.get(id)?.listingId !== listing.id) {
        issues.push({ code: "inconsistent-reference", path: ["listings", index, "observationIds", i], message: "Observation belongs to a different listing." });
      }
    });
  });
  dataset.observations.forEach((observation, index) => {
    requireRef("listings", observation.listingId, ["observations", index, "listingId"]);
    const listing = listingById.get(observation.listingId);
    if (listing && !listing.observationIds.includes(observation.id)) {
      issues.push({ code: "inconsistent-reference", path: ["observations", index, "listingId"], message: "Listing does not include this observation." });
    }
    if (observation.snapshotId) {
      requireRef("snapshots", observation.snapshotId, ["observations", index, "snapshotId"]);
      const snapshot = snapshotById.get(observation.snapshotId);
      if (snapshot && snapshot.listingId !== observation.listingId) {
        issues.push({ code: "inconsistent-reference", path: ["observations", index, "snapshotId"], message: "Snapshot and observation belong to different listings." });
      }
    }
  });
  dataset.snapshots.forEach((snapshot, index) => {
    requireRef("listings", snapshot.listingId, ["snapshots", index, "listingId"]);
    requireRef("observations", snapshot.observationId, ["snapshots", index, "observationId"]);
    const observation = observationById.get(snapshot.observationId);
    if (observation && observation.listingId !== snapshot.listingId) {
      issues.push({ code: "inconsistent-reference", path: ["snapshots", index, "observationId"], message: "Snapshot and observation belong to different listings." });
    }
  });
  return issues;
}

export const AtlasDatasetSchema = AtlasDatasetObjectSchema.superRefine((dataset, context) => {
  for (const issue of validateAtlasDatasetReferences(dataset)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: issue.message });
  }
});
