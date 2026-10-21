import { z } from "zod";
import { AtlasDatasetSchema, CanonicalJobSchema, CountryCodeSchema, EntityIdSchema, TimestampSchema, MergeDecisionSchema, JobAliasEventSchema, ReconciliationReceiptSchema, JobLocationSchema, LocationConfirmationDecisionSchema, LocationConfirmationReceiptSchema, OfficeAddressDecisionSchema, OfficeAddressReceiptSchema, CompensationSchema, CompensationReviewDecisionSchema, CompensationReviewReceiptSchema, FxReferenceSnapshotSchema, FxMutationReceiptSchema, CompanySchema, CompanyControlReviewDecisionSchema, CompanyControlReviewReceiptSchema, isCompanyControlReviewEntityId } from "@better-me/opportunities";
import { SourceJobRecordSchema } from "@better-me/source-adapters";

export const REPOSITORY_SCHEMA_VERSION = 7;
export const ActorScopeSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:/-]+$/);
export const IdempotencyKeySchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);
export const RequestFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const StoredFxSnapshotSchema = z.object({ revision: z.number().int().positive(), snapshot: FxReferenceSnapshotSchema }).strict();
export const FxActivationEventSchema = z.object({
  id: EntityIdSchema, revision: z.number().int().positive(), actorScope: ActorScopeSchema, at: TimestampSchema,
  kind: z.enum(["import", "activate"]), snapshotId: z.string().min(1).max(200).nullable(), activeSnapshotId: z.string().min(1).max(200).nullable(),
  activate: z.boolean().optional(), previewFingerprint: RequestFingerprintSchema.optional(),
}).strict().superRefine((event, context) => {
  if (event.kind === "import" && (event.snapshotId === null || event.activate === undefined || event.previewFingerprint === undefined)) context.addIssue({ code: "custom", message: "An FX import must bind its preview and activation choice." });
  if (event.kind === "activate" && (event.activate !== undefined || event.previewFingerprint !== undefined || event.activeSnapshotId !== event.snapshotId)) context.addIssue({ code: "custom", message: "An FX activation must select exactly its requested snapshot." });
});
export type StoredFxSnapshot = z.infer<typeof StoredFxSnapshotSchema>;
export type FxActivationEvent = z.infer<typeof FxActivationEventSchema>;
export const PublicRunSummarySchema = z.object({
  added: z.number().int().nonnegative().optional(), changed: z.number().int().nonnegative().optional(),
  unchanged: z.number().int().nonnegative().optional(), closed: z.number().int().nonnegative().optional(),
  failed: z.number().int().nonnegative().optional(), needsHuman: z.number().int().nonnegative().optional(),
  records: z.number().int().nonnegative().optional(), pages: z.number().int().nonnegative().optional(),
  leads: z.number().int().nonnegative().optional(), partial: z.boolean().optional(), errorCode: z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/).optional(),
}).strict();
export type PublicRunSummary = z.infer<typeof PublicRunSummarySchema>;
export const RunScopeSchema = z.object({
  keywords: z.array(z.string().trim().min(1).max(300)).max(100).optional(),
  regions: z.array(z.string().trim().min(1).max(300)).max(100).optional(),
  countryCodes: z.array(CountryCodeSchema).max(300).optional(),
  companies: z.array(z.string().trim().min(1).max(300)).max(100).optional(),
  maxRecords: z.number().int().min(1).max(100_000).optional(),
  maxPages: z.number().int().min(1).max(10_000).optional(),
}).strict();
export type RunScope = z.infer<typeof RunScopeSchema>;
export const SyncRunSchema = z.object({
  runId: EntityIdSchema, sourceId: EntityIdSchema, actorScope: ActorScopeSchema,
  generation: z.number().int().positive(), scope: RunScopeSchema,
  requestFingerprint: RequestFingerprintSchema.optional(),
  status: z.enum(["running", "completed", "partial", "failed", "cancelled", "superseded"]),
  startedAt: TimestampSchema, finishedAt: TimestampSchema.optional(), summary: PublicRunSummarySchema.optional(),
}).strict();
export type SyncRun = z.infer<typeof SyncRunSchema>;

export const ImportReceiptSchema = z.object({
  ok: z.literal(true), revision: z.number().int().nonnegative(), jobIds: z.array(EntityIdSchema), snapshotIds: z.array(EntityIdSchema),
  counts: z.object({ newJobs: z.number().int().nonnegative(), updatedJobs: z.number().int().nonnegative(), unchangedJobs: z.number().int().nonnegative(), newListings: z.number().int().nonnegative(), newObservations: z.number().int().nonnegative(), newSnapshots: z.number().int().nonnegative() }).strict(),
}).strict();
export type ImportReceipt = z.infer<typeof ImportReceiptSchema>;
export const DiscoveryLeadSchema = z.object({
  id: EntityIdSchema, sourceId: EntityIdSchema, observedAt: TimestampSchema, record: SourceJobRecordSchema,
}).strict().refine((lead) => lead.record.entityType !== "job-posting", "A discovery lead cannot enter the canonical jobs table.");
export type DiscoveryLead = z.infer<typeof DiscoveryLeadSchema>;
export const DiscoveryLeadReceiptSchema = z.object({ ok: z.literal(true), revision: z.number().int().nonnegative(), leadIds: z.array(EntityIdSchema) }).strict();
export type DiscoveryLeadReceipt = z.infer<typeof DiscoveryLeadReceiptSchema>;
export const StoredReceiptSchema = z.object({
  actorScope: ActorScopeSchema, tool: z.enum(["dataset.import", "dataset.restore", "runs.start", "leads.save", "sources.register", "jobs.merge", "jobs.reject-merge", "jobs.revoke-merge", "locations.confirm", "locations.revoke-confirmation", "locations.confirm-office-address", "locations.revoke-office-address", "compensations.confirm-review", "compensations.revoke-review", "fx.confirm-import", "fx.activate", "companies.confirm-control-review", "companies.revoke-control-review"]),
  idempotencyKey: IdempotencyKeySchema, signature: z.string().regex(/^[a-f0-9]{64}$/),
  response: z.union([ImportReceiptSchema, SyncRunSchema, DiscoveryLeadReceiptSchema, ReconciliationReceiptSchema, LocationConfirmationReceiptSchema, OfficeAddressReceiptSchema, CompensationReviewReceiptSchema, FxMutationReceiptSchema, CompanyControlReviewReceiptSchema]), createdAt: TimestampSchema,
}).strict().superRefine((receipt, context) => {
  if ((receipt.tool === "locations.confirm" || receipt.tool === "locations.revoke-confirmation") && !LocationConfirmationReceiptSchema.safeParse(receipt.response).success) context.addIssue({ code: "custom", message: "Location command receipts require a location response." });
  if ((receipt.tool === "locations.confirm-office-address" || receipt.tool === "locations.revoke-office-address") && !OfficeAddressReceiptSchema.safeParse(receipt.response).success) context.addIssue({ code: "custom", message: "Office command receipts require an office response." });
  if ((receipt.tool === "compensations.confirm-review" || receipt.tool === "compensations.revoke-review") && !CompensationReviewReceiptSchema.safeParse(receipt.response).success) context.addIssue({ code: "custom", message: "Compensation commands require a compensation review response." });
  if ((receipt.tool === "fx.confirm-import" || receipt.tool === "fx.activate") && !FxMutationReceiptSchema.safeParse(receipt.response).success) context.addIssue({ code: "custom", message: "FX commands require an FX mutation receipt." });
  if ((receipt.tool === "companies.confirm-control-review" || receipt.tool === "companies.revoke-control-review") && !CompanyControlReviewReceiptSchema.safeParse(receipt.response).success) context.addIssue({ code: "custom", message: "Company commands require a company control review receipt." });
});
export type StoredReceipt = z.infer<typeof StoredReceiptSchema>;
export const RepositoryBackupSchema = z.object({
  format: z.literal("better-me/job-repository"), schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6), z.literal(7)]),
  createdAt: TimestampSchema, dataset: AtlasDatasetSchema,
  runs: z.array(SyncRunSchema).max(100_000), receipts: z.array(StoredReceiptSchema).max(1_000_000),
  leads: z.array(DiscoveryLeadSchema).max(300_000).default([]),
  baseJobs: z.array(CanonicalJobSchema).max(100_000).optional(),
  mergeDecisions: z.array(MergeDecisionSchema).max(100_000).default([]),
  aliasHistory: z.array(JobAliasEventSchema).max(1_000_000).default([]),
  jobVersions: z.array(z.object({ jobId: EntityIdSchema, revision: z.number().int().nonnegative() }).strict()).max(100_000).default([]),
  baseLocations: z.array(JobLocationSchema.refine(value => !value.userResolution && !value.officeResolution, "Source locations cannot contain local decisions.")).max(200_000).optional(),
  locationDecisions: z.array(LocationConfirmationDecisionSchema).max(200_000).default([]),
  officeDecisions: z.array(OfficeAddressDecisionSchema).max(200_000).default([]),
  baseCompensations: z.array(CompensationSchema).max(200_000).optional(),
  compensationDecisions: z.array(CompensationReviewDecisionSchema).max(200_000).default([]),
  fxSnapshots: z.array(StoredFxSnapshotSchema).max(1000).default([]),
  fxActivations: z.array(FxActivationEventSchema).max(100_000).default([]),
  baseCompanies: z.array(CompanySchema.refine(value => !value.controlReview, "Source companies cannot contain local reviews.")).max(100_000).optional(),
  companyControlDecisions: z.array(CompanyControlReviewDecisionSchema).max(100_000).default([]),
}).strict().superRefine((backup, context) => {
  if (new Set(backup.runs.map((run) => run.runId)).size !== backup.runs.length) context.addIssue({ code: "custom", message: "Duplicate run IDs." });
  const keys = backup.receipts.map((receipt) => JSON.stringify([receipt.actorScope, receipt.tool, receipt.idempotencyKey]));
  if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", message: "Duplicate receipt keys." });
  const sources = new Set(backup.dataset.sources.map((source) => source.sourceId));
  if (new Set(backup.leads.map((lead) => lead.id)).size !== backup.leads.length || backup.leads.some((lead) => !sources.has(lead.sourceId))) context.addIssue({ code: "custom", message: "Invalid lead source references." });
  if (backup.schemaVersion >= 2 && !backup.baseJobs) context.addIssue({ code: "custom", message: "Version 2 and later backups require origin jobs." });
  if (backup.schemaVersion >= 3 && !backup.baseLocations) context.addIssue({ code: "custom", message: "Version 3 and later backups require origin locations." });
  if (backup.schemaVersion >= 5 && !backup.baseCompensations) context.addIssue({ code: "custom", message: "Version 5 and later backups require origin compensations." });
  if (backup.schemaVersion >= 7 && !backup.baseCompanies) context.addIssue({ code: "custom", message: "Version 7 and later backups require origin companies." });
  if (backup.schemaVersion < 7 && (backup.baseCompanies !== undefined || backup.companyControlDecisions.length || backup.dataset.companies.some(value => value.controlReview)
    || backup.dataset.sources.some(value => isCompanyControlReviewEntityId(value.sourceId)) || backup.dataset.listings.some(value => isCompanyControlReviewEntityId(value.id)) || backup.dataset.observations.some(value => isCompanyControlReviewEntityId(value.id))
    || backup.receipts.some(value => value.tool === "companies.confirm-control-review" || value.tool === "companies.revoke-control-review"))) context.addIssue({ code: "custom", message: "Old backups cannot contain company control reviews." });
  if (backup.baseCompanies && new Set(backup.baseCompanies.map(value => value.id)).size !== backup.baseCompanies.length
    || new Set(backup.companyControlDecisions.map(value => value.id)).size !== backup.companyControlDecisions.length
    || new Set(backup.companyControlDecisions.map(value => value.revision)).size !== backup.companyControlDecisions.length) context.addIssue({ code: "custom", message: "Duplicate company review identities." });
  if (backup.schemaVersion < 6 && (backup.fxSnapshots.length || backup.fxActivations.length || backup.receipts.some(value => value.tool === "fx.confirm-import" || value.tool === "fx.activate"))) context.addIssue({ code: "custom", message: "Old backups cannot contain FX state." });
  if (new Set(backup.fxSnapshots.map(value => value.snapshot.fx.id)).size !== backup.fxSnapshots.length || new Set(backup.fxSnapshots.map(value => value.revision)).size !== backup.fxSnapshots.length || new Set(backup.fxActivations.map(value => value.id)).size !== backup.fxActivations.length) context.addIssue({ code: "custom", message: "Duplicate FX state identities." });
  if (backup.schemaVersion < 5 && (backup.baseCompensations !== undefined || backup.compensationDecisions.length || backup.receipts.some(value => value.tool === "compensations.confirm-review" || value.tool === "compensations.revoke-review"))) context.addIssue({ code: "custom", message: "Old backups cannot contain compensation decisions." });
  if (backup.baseCompensations && new Set(backup.baseCompensations.map(value => value.id)).size !== backup.baseCompensations.length) context.addIssue({ code: "custom", message: "Duplicate source compensation identities." });
  if (backup.schemaVersion < 4 && (backup.officeDecisions.length || backup.dataset.locations.some(value => value.officeResolution) || backup.receipts.some(value => value.tool === "locations.confirm-office-address" || value.tool === "locations.revoke-office-address"))) context.addIssue({ code: "custom", message: "Old backups cannot contain office decisions." });
  if (backup.schemaVersion < 3 && (backup.baseLocations !== undefined || backup.locationDecisions.length || backup.dataset.locations.some(value => value.userResolution))) context.addIssue({ code: "custom", message: "Old backups cannot contain local location decisions." });
  if (backup.baseLocations && new Set(backup.baseLocations.map(value => value.id)).size !== backup.baseLocations.length) context.addIssue({ code: "custom", message: "Duplicate source location identities." });
  if (backup.schemaVersion === 1 && (backup.baseJobs !== undefined || backup.mergeDecisions.length || backup.aliasHistory.length || backup.jobVersions.length)) context.addIssue({ code: "custom", message: "Version 1 backups cannot contain version 2 reconciliation state." });
  if (new Set(backup.mergeDecisions.map((decision) => decision.id)).size !== backup.mergeDecisions.length
    || new Set(backup.baseJobs?.map((job) => job.id)).size !== backup.baseJobs?.length && backup.baseJobs !== undefined
    || new Set(backup.jobVersions.map((value) => value.jobId)).size !== backup.jobVersions.length) context.addIssue({ code: "custom", message: "Duplicate reconciliation identities." });
});
export type RepositoryBackup = z.infer<typeof RepositoryBackupSchema>;

export const REPOSITORY_MIGRATION_V1 = `
CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
INSERT INTO metadata(key,value) VALUES ('revision','0');
CREATE TABLE sources (id TEXT PRIMARY KEY, document TEXT NOT NULL CHECK(json_valid(document))) STRICT;
CREATE TABLE companies (id TEXT PRIMARY KEY, document TEXT NOT NULL CHECK(json_valid(document))) STRICT;
CREATE TABLE jobs (id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY DEFERRED, document TEXT NOT NULL CHECK(json_valid(document))) STRICT;
CREATE TABLE locations (id TEXT PRIMARY KEY, latitude REAL, longitude REAL, document TEXT NOT NULL CHECK(json_valid(document))) STRICT;
CREATE TABLE compensations (id TEXT PRIMARY KEY, document TEXT NOT NULL CHECK(json_valid(document))) STRICT;
CREATE TABLE listings (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) DEFERRABLE INITIALLY DEFERRED, job_id TEXT REFERENCES jobs(id) DEFERRABLE INITIALLY DEFERRED, document TEXT NOT NULL CHECK(json_valid(document))) STRICT;
CREATE TABLE observations (id TEXT PRIMARY KEY, listing_id TEXT NOT NULL REFERENCES listings(id) DEFERRABLE INITIALLY DEFERRED, document TEXT NOT NULL CHECK(json_valid(document))) STRICT;
CREATE TABLE snapshots (id TEXT PRIMARY KEY, listing_id TEXT NOT NULL REFERENCES listings(id) DEFERRABLE INITIALLY DEFERRED, observation_id TEXT NOT NULL REFERENCES observations(id) DEFERRABLE INITIALLY DEFERRED, document TEXT NOT NULL CHECK(json_valid(document))) STRICT;
CREATE TABLE job_locations (job_id TEXT NOT NULL REFERENCES jobs(id) DEFERRABLE INITIALLY DEFERRED, location_id TEXT NOT NULL REFERENCES locations(id) DEFERRABLE INITIALLY DEFERRED, PRIMARY KEY(job_id,location_id)) STRICT;
CREATE TABLE job_compensations (job_id TEXT NOT NULL REFERENCES jobs(id) DEFERRABLE INITIALLY DEFERRED, compensation_id TEXT NOT NULL REFERENCES compensations(id) DEFERRABLE INITIALLY DEFERRED, PRIMARY KEY(job_id,compensation_id)) STRICT;
CREATE TABLE job_listings (job_id TEXT NOT NULL REFERENCES jobs(id) DEFERRABLE INITIALLY DEFERRED, listing_id TEXT NOT NULL REFERENCES listings(id) DEFERRABLE INITIALLY DEFERRED, PRIMARY KEY(job_id,listing_id)) STRICT;
CREATE TABLE listing_observations (listing_id TEXT NOT NULL REFERENCES listings(id) DEFERRABLE INITIALLY DEFERRED, observation_id TEXT NOT NULL REFERENCES observations(id) DEFERRABLE INITIALLY DEFERRED, PRIMARY KEY(listing_id,observation_id)) STRICT;
CREATE TABLE location_rtree_ids (rid INTEGER PRIMARY KEY, location_id TEXT NOT NULL UNIQUE REFERENCES locations(id) DEFERRABLE INITIALLY DEFERRED) STRICT;
CREATE VIRTUAL TABLE location_rtree USING rtree(rid,min_lon,max_lon,min_lat,max_lat);
CREATE VIRTUAL TABLE jobs_fts USING fts5(job_id UNINDEXED,title,company,description,cjk,tokenize='unicode61 remove_diacritics 2');
CREATE TABLE runs (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, generation INTEGER NOT NULL, status TEXT NOT NULL, document TEXT NOT NULL CHECK(json_valid(document)), UNIQUE(source_id,generation)) STRICT;
CREATE TABLE source_generations (source_id TEXT PRIMARY KEY, generation INTEGER NOT NULL) STRICT;
CREATE TABLE receipts (actor_scope TEXT NOT NULL, tool TEXT NOT NULL, idempotency_key TEXT NOT NULL, signature TEXT NOT NULL, response TEXT NOT NULL CHECK(json_valid(response)), created_at TEXT NOT NULL, PRIMARY KEY(actor_scope,tool,idempotency_key)) STRICT;
CREATE TABLE discovery_leads (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) DEFERRABLE INITIALLY DEFERRED, document TEXT NOT NULL CHECK(json_valid(document))) STRICT;
CREATE INDEX listing_sources ON listings(source_id);
CREATE INDEX jobs_company ON jobs(company_id);
CREATE INDEX runs_status ON runs(source_id,status);
`;

/** Applied atomically to existing M1 files; origin data is initialized from their current jobs. */
export const REPOSITORY_MIGRATION_V2 = `
CREATE TABLE base_jobs (id TEXT PRIMARY KEY,document TEXT NOT NULL CHECK(json_valid(document))) STRICT;
INSERT INTO base_jobs(id,document) SELECT id,document FROM jobs;
CREATE TABLE merge_decisions (id TEXT PRIMARY KEY,revision INTEGER NOT NULL UNIQUE,document TEXT NOT NULL CHECK(json_valid(document))) STRICT;
CREATE TABLE job_aliases (job_id TEXT PRIMARY KEY,canonical_job_id TEXT NOT NULL) STRICT;
INSERT INTO job_aliases(job_id,canonical_job_id) SELECT id,id FROM jobs;
CREATE TABLE job_alias_history (sequence INTEGER PRIMARY KEY,job_id TEXT NOT NULL,revision INTEGER NOT NULL,document TEXT NOT NULL CHECK(json_valid(document))) STRICT;
INSERT INTO job_alias_history(job_id,revision,document) SELECT id,CAST((SELECT value FROM metadata WHERE key='revision') AS INTEGER),json_object('jobId',id,'canonicalJobId',id,'revision',CAST((SELECT value FROM metadata WHERE key='revision') AS INTEGER),'at',strftime('%Y-%m-%dT%H:%M:%fZ','now')) FROM jobs;
CREATE TABLE job_versions (job_id TEXT PRIMARY KEY,revision INTEGER NOT NULL) STRICT;
INSERT INTO job_versions(job_id,revision) SELECT id,json_extract(document,'$.revision') FROM jobs;
`;
export const RECONCILIATION_TRIGGERS = `
CREATE TRIGGER merge_decisions_no_update BEFORE UPDATE ON merge_decisions BEGIN SELECT RAISE(ABORT,'immutable-merge-decision'); END;
CREATE TRIGGER merge_decisions_no_delete BEFORE DELETE ON merge_decisions BEGIN SELECT RAISE(ABORT,'immutable-merge-decision'); END;
CREATE TRIGGER job_alias_history_no_update BEFORE UPDATE ON job_alias_history BEGIN SELECT RAISE(ABORT,'immutable-alias-history'); END;
CREATE TRIGGER job_alias_history_no_delete BEFORE DELETE ON job_alias_history BEGIN SELECT RAISE(ABORT,'immutable-alias-history'); END;
`;
export const REPOSITORY_MIGRATION_V3 = `
CREATE TABLE base_locations (id TEXT PRIMARY KEY,document TEXT NOT NULL CHECK(json_valid(document))) STRICT;
INSERT INTO base_locations(id,document) SELECT id,document FROM locations;
CREATE TABLE location_decisions (id TEXT PRIMARY KEY,revision INTEGER NOT NULL UNIQUE,document TEXT NOT NULL CHECK(json_valid(document))) STRICT;
`;
export const LOCATION_DECISION_TRIGGERS = `
CREATE TRIGGER location_decisions_no_update BEFORE UPDATE ON location_decisions BEGIN SELECT RAISE(ABORT,'immutable-location-decision'); END;
CREATE TRIGGER location_decisions_no_delete BEFORE DELETE ON location_decisions BEGIN SELECT RAISE(ABORT,'immutable-location-decision'); END;
`;
export const REPOSITORY_MIGRATION_V4 = `
CREATE TABLE office_decisions (id TEXT PRIMARY KEY,revision INTEGER NOT NULL UNIQUE,document TEXT NOT NULL CHECK(json_valid(document))) STRICT;
`;
export const OFFICE_DECISION_TRIGGERS = `
CREATE TRIGGER office_decisions_no_update BEFORE UPDATE ON office_decisions BEGIN SELECT RAISE(ABORT,'immutable-office-decision'); END;
CREATE TRIGGER office_decisions_no_delete BEFORE DELETE ON office_decisions BEGIN SELECT RAISE(ABORT,'immutable-office-decision'); END;
`;
export const REPOSITORY_MIGRATION_V5 = `
CREATE TABLE base_compensations (id TEXT PRIMARY KEY,document TEXT NOT NULL CHECK(json_valid(document))) STRICT;
INSERT INTO base_compensations(id,document) SELECT id,document FROM compensations;
CREATE TABLE compensation_decisions (id TEXT PRIMARY KEY,revision INTEGER NOT NULL UNIQUE,document TEXT NOT NULL CHECK(json_valid(document))) STRICT;
`;
export const COMPENSATION_DECISION_TRIGGERS = `
CREATE TRIGGER compensation_decisions_no_update BEFORE UPDATE ON compensation_decisions BEGIN SELECT RAISE(ABORT,'immutable-compensation-decision'); END;
CREATE TRIGGER compensation_decisions_no_delete BEFORE DELETE ON compensation_decisions BEGIN SELECT RAISE(ABORT,'immutable-compensation-decision'); END;
`;
export const REPOSITORY_MIGRATION_V6 = `
CREATE TABLE fx_snapshots (id TEXT PRIMARY KEY,revision INTEGER NOT NULL UNIQUE,document TEXT NOT NULL CHECK(json_valid(document))) STRICT;
CREATE TABLE fx_activations (id TEXT PRIMARY KEY,revision INTEGER NOT NULL UNIQUE,document TEXT NOT NULL CHECK(json_valid(document))) STRICT;
`;
export const FX_TRIGGERS = `
CREATE TRIGGER fx_snapshots_no_update BEFORE UPDATE ON fx_snapshots BEGIN SELECT RAISE(ABORT,'immutable-fx-snapshot'); END;
CREATE TRIGGER fx_snapshots_no_delete BEFORE DELETE ON fx_snapshots BEGIN SELECT RAISE(ABORT,'immutable-fx-snapshot'); END;
CREATE TRIGGER fx_activations_no_update BEFORE UPDATE ON fx_activations BEGIN SELECT RAISE(ABORT,'immutable-fx-activation'); END;
CREATE TRIGGER fx_activations_no_delete BEFORE DELETE ON fx_activations BEGIN SELECT RAISE(ABORT,'immutable-fx-activation'); END;
`;
export const REPOSITORY_MIGRATION_V7 = `
CREATE TABLE base_companies (id TEXT PRIMARY KEY,document TEXT NOT NULL CHECK(json_valid(document))) STRICT;
INSERT INTO base_companies(id,document) SELECT id,document FROM companies;
CREATE TABLE company_control_decisions (id TEXT PRIMARY KEY,revision INTEGER NOT NULL UNIQUE,document TEXT NOT NULL CHECK(json_valid(document))) STRICT;
`;
export const COMPANY_CONTROL_DECISION_TRIGGERS = `
CREATE TRIGGER company_control_decisions_no_update BEFORE UPDATE ON company_control_decisions BEGIN SELECT RAISE(ABORT,'immutable-company-control-decision'); END;
CREATE TRIGGER company_control_decisions_no_delete BEFORE DELETE ON company_control_decisions BEGIN SELECT RAISE(ABORT,'immutable-company-control-decision'); END;
`;
export const APPEND_ONLY_TRIGGERS = `
CREATE TRIGGER observations_no_update BEFORE UPDATE ON observations BEGIN SELECT RAISE(ABORT,'immutable-observation'); END;
CREATE TRIGGER observations_no_delete BEFORE DELETE ON observations BEGIN SELECT RAISE(ABORT,'immutable-observation'); END;
CREATE TRIGGER snapshots_no_update BEFORE UPDATE ON snapshots BEGIN SELECT RAISE(ABORT,'immutable-snapshot'); END;
CREATE TRIGGER snapshots_no_delete BEFORE DELETE ON snapshots BEGIN SELECT RAISE(ABORT,'immutable-snapshot'); END;
`;
