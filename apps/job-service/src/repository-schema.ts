import { z } from "zod";
import {
  AtlasDatasetSchema, CanonicalJobSchema, CountryCodeSchema, EntityIdSchema, TimestampSchema,
  MergeDecisionSchema, JobAliasEventSchema, ReconciliationReceiptSchema, JobLocationSchema,
  LocationConfirmationDecisionSchema, LocationConfirmationReceiptSchema, OfficeAddressDecisionSchema, OfficeAddressReceiptSchema,
  CompanyControllerOverrideReceiptSchema, CompensationAuditReceiptSchema,
} from "@better-me/opportunities";
import { SourceJobRecordSchema } from "@better-me/source-adapters";
import { BackgroundEnrichmentTaskSchema } from "./background-enrichment.js";

export const REPOSITORY_SCHEMA_VERSION = 7;
export const ActorScopeSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:/-]+$/);
export const IdempotencyKeySchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);
export const RequestFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
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
  actorScope: ActorScopeSchema, tool: z.enum([
    "dataset.import", "dataset.restore", "runs.start", "leads.save", "sources.register",
    "jobs.merge", "jobs.reject-merge", "jobs.revoke-merge",
    "locations.confirm", "locations.revoke-confirmation",
    "locations.confirm-office-address", "locations.revoke-office-address",
    "companies.confirm-controller-override", "companies.revoke-controller-override",
    "compensations.confirm-audit", "compensations.revoke-audit",
  ]),
  idempotencyKey: IdempotencyKeySchema, signature: z.string().regex(/^[a-f0-9]{64}$/),
  response: z.union([
    ImportReceiptSchema, SyncRunSchema, DiscoveryLeadReceiptSchema, ReconciliationReceiptSchema,
    LocationConfirmationReceiptSchema, OfficeAddressReceiptSchema,
    CompanyControllerOverrideReceiptSchema, CompensationAuditReceiptSchema,
  ]), createdAt: TimestampSchema,
}).strict().superRefine((receipt, context) => {
  if ((receipt.tool === "locations.confirm" || receipt.tool === "locations.revoke-confirmation") && !LocationConfirmationReceiptSchema.safeParse(receipt.response).success) context.addIssue({ code: "custom", message: "Location command receipts require a location response." });
  if ((receipt.tool === "locations.confirm-office-address" || receipt.tool === "locations.revoke-office-address") && !OfficeAddressReceiptSchema.safeParse(receipt.response).success) context.addIssue({ code: "custom", message: "Office command receipts require an office response." });
  if ((receipt.tool === "companies.confirm-controller-override" || receipt.tool === "companies.revoke-controller-override") && !CompanyControllerOverrideReceiptSchema.safeParse(receipt.response).success) context.addIssue({ code: "custom", message: "Company controller command receipts require a company controller response." });
  if ((receipt.tool === "compensations.confirm-audit" || receipt.tool === "compensations.revoke-audit") && !CompensationAuditReceiptSchema.safeParse(receipt.response).success) context.addIssue({ code: "custom", message: "Compensation audit command receipts require a compensation audit response." });
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
  enrichmentTasks: z.array(BackgroundEnrichmentTaskSchema).max(100_000).default([]),
}).strict().superRefine((backup, context) => {
  if (backup.schemaVersion < 5 && backup.enrichmentTasks.length) context.addIssue({ code: "custom", message: "Old backups cannot contain enrichment tasks." });
  if (new Set(backup.enrichmentTasks.map(value => value.id)).size !== backup.enrichmentTasks.length
    || new Set(backup.enrichmentTasks.map(value => JSON.stringify([value.actorScope, value.kind, value.jobId]))).size !== backup.enrichmentTasks.length) context.addIssue({ code: "custom", message: "Duplicate enrichment tasks." });
  if (new Set(backup.runs.map((run) => run.runId)).size !== backup.runs.length) context.addIssue({ code: "custom", message: "Duplicate run IDs." });
  const keys = backup.receipts.map((receipt) => JSON.stringify([receipt.actorScope, receipt.tool, receipt.idempotencyKey]));
  if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", message: "Duplicate receipt keys." });
  const sources = new Set(backup.dataset.sources.map((source) => source.sourceId));
  if (new Set(backup.leads.map((lead) => lead.id)).size !== backup.leads.length || backup.leads.some((lead) => !sources.has(lead.sourceId))) context.addIssue({ code: "custom", message: "Invalid lead source references." });
  if (backup.schemaVersion >= 2 && !backup.baseJobs) context.addIssue({ code: "custom", message: "Version 2 and later backups require origin jobs." });
  if (backup.schemaVersion >= 3 && !backup.baseLocations) context.addIssue({ code: "custom", message: "Version 3 and later backups require origin locations." });
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

export const REPOSITORY_MIGRATION_V5 = `
CREATE TABLE enrichment_tasks (id TEXT PRIMARY KEY, actor_scope TEXT NOT NULL, kind TEXT NOT NULL, job_id TEXT NOT NULL, state TEXT NOT NULL, next_retry_at TEXT, document TEXT NOT NULL CHECK(json_valid(document)), UNIQUE(actor_scope,kind,job_id)) STRICT;
CREATE INDEX enrichment_tasks_ready ON enrichment_tasks(actor_scope,state,next_retry_at);
`;

/** Existing libraries start a new baseline at their current revision, without rewriting entities. */
export const REPOSITORY_MIGRATION_V6 = `
INSERT INTO metadata(key,value) VALUES ('sync_epoch',lower(hex(randomblob(16))));
INSERT INTO metadata(key,value) SELECT 'sync_floor',value FROM metadata WHERE key='revision';
CREATE TABLE dataset_changes (table_name TEXT NOT NULL CHECK(table_name IN ('sources','companies','jobs','locations','compensations','listings','observations','snapshots')),entity_id TEXT NOT NULL,revision INTEGER NOT NULL,deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),PRIMARY KEY(table_name,entity_id)) STRICT;
CREATE INDEX dataset_changes_revision ON dataset_changes(revision);
`;

/** Write-projection dependencies only; public facts, revision and sync epoch are unchanged. */
export const REPOSITORY_MIGRATION_V7 = `
CREATE TABLE base_job_dependencies (job_id TEXT NOT NULL REFERENCES base_jobs(id) DEFERRABLE INITIALLY DEFERRED,kind TEXT NOT NULL CHECK(kind IN ('company','location','compensation','listing')),entity_id TEXT NOT NULL,PRIMARY KEY(job_id,kind,entity_id)) STRICT;
CREATE INDEX base_job_dependency_targets ON base_job_dependencies(kind,entity_id,job_id);
INSERT OR IGNORE INTO base_job_dependencies SELECT id,'company',json_extract(document,'$.companyId') FROM base_jobs;
INSERT OR IGNORE INTO base_job_dependencies SELECT j.id,'location',v.value FROM base_jobs j,json_each(j.document,'$.locationIds') v;
INSERT OR IGNORE INTO base_job_dependencies SELECT j.id,'compensation',v.value FROM base_jobs j,json_each(j.document,'$.compensationIds') v;
INSERT OR IGNORE INTO base_job_dependencies SELECT j.id,'listing',v.value FROM base_jobs j,json_each(j.document,'$.listingIds') v;
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
export const APPEND_ONLY_TRIGGERS = `
CREATE TRIGGER observations_no_update BEFORE UPDATE ON observations BEGIN SELECT RAISE(ABORT,'immutable-observation'); END;
CREATE TRIGGER observations_no_delete BEFORE DELETE ON observations BEGIN SELECT RAISE(ABORT,'immutable-observation'); END;
CREATE TRIGGER snapshots_no_update BEFORE UPDATE ON snapshots BEGIN SELECT RAISE(ABORT,'immutable-snapshot'); END;
CREATE TRIGGER snapshots_no_delete BEFORE DELETE ON snapshots BEGIN SELECT RAISE(ABORT,'immutable-snapshot'); END;
`;
