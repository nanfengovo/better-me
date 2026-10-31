import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  AtlasDatasetObjectSchema, AtlasDatasetSchema, validateAtlasDatasetReferences, normalizeSearchText,
  SourceDefinitionSchema, CompanySchema, type AtlasDataset, type Company, type CanonicalJob, type SourceListing,
  EntityIdSchema, MergeDecisionSchema, ReconciliationReceiptSchema, JobAliasEventSchema,
  ConfirmMergeInputSchema, RejectMergeInputSchema, RevokeMergeInputSchema, explainMergeCandidate,
  findMergeCandidates, projectReconciliation,
  JobLocationSchema, LocationConfirmationDecisionSchema, LocationConfirmationPreviewSchema, LocationConfirmationReceiptSchema,
  PreviewLocationConfirmationInputSchema, ConfirmLocationInputSchema, RevokeLocationConfirmationInputSchema,
  applyLocationConfirmation, projectLocationConfirmations,
  compatibleSourceLocation, applyOfficeAddressConfirmation, projectOfficeAddressConfirmations,
  OfficeAddressCandidatesInputSchema, OfficeAddressDecisionSchema, OfficeAddressPreviewSchema, OfficeAddressReceiptSchema,
  PreviewOfficeConfirmationInputSchema, ConfirmOfficeAddressInputSchema, RevokeOfficeAddressInputSchema,
  type OfficeAddressCandidatesInput, type OfficeAddressDecision, type OfficeAddressPreview, type OfficeAddressReceipt,
  type PreviewOfficeConfirmationInput, type ConfirmOfficeAddressInput, type RevokeOfficeAddressInput,
  type PreviewLocationConfirmationInput, type ConfirmLocationInput, type RevokeLocationConfirmationInput,
  type LocationConfirmationDecision, type LocationConfirmationPreview, type LocationConfirmationReceipt, type JobLocation,
  type MergeDecision, type ReconciliationReceipt, type JobAliasEvent, type ConfirmMergeInput, type OfficialRequisitionLink,
  classifyCompany, resolveCompanyColor, normalizeCompensation,
  CompensationSchema, type Compensation, type CompanyManualOverride,
  PreviewCompanyControllerOverrideInputSchema, ConfirmCompanyControllerOverrideInputSchema, RevokeCompanyControllerOverrideInputSchema,
  CompanyControllerOverridePreviewSchema, CompanyControllerOverrideReceiptSchema,
  PreviewCompensationAuditInputSchema, ConfirmCompensationAuditInputSchema, RevokeCompensationAuditInputSchema,
  CompensationAuditPreviewSchema, CompensationAuditReceiptSchema,
  type ConfirmCompanyControllerOverrideInput, type RevokeCompanyControllerOverrideInput,
  type CompanyControllerOverridePreview, type CompanyControllerOverrideReceipt,
  type ConfirmCompensationAuditInput, type RevokeCompensationAuditInput,
  type CompensationAuditPreview, type CompensationAuditReceipt,
} from "@better-me/opportunities";
import {
  ActorScopeSchema, IdempotencyKeySchema, SyncRunSchema, RunScopeSchema, PublicRunSummarySchema,
  RequestFingerprintSchema,
  ImportReceiptSchema, RepositoryBackupSchema, REPOSITORY_SCHEMA_VERSION, REPOSITORY_MIGRATION_V1, REPOSITORY_MIGRATION_V2, REPOSITORY_MIGRATION_V3, LOCATION_DECISION_TRIGGERS, REPOSITORY_MIGRATION_V4, OFFICE_DECISION_TRIGGERS, REPOSITORY_MIGRATION_V5, REPOSITORY_MIGRATION_V6, REPOSITORY_MIGRATION_V7,
  APPEND_ONLY_TRIGGERS, RECONCILIATION_TRIGGERS, type ImportReceipt, type SyncRun, type RunScope, type PublicRunSummary,
  type RepositoryBackup, type StoredReceipt, DiscoveryLeadSchema, DiscoveryLeadReceiptSchema,
  type DiscoveryLead, type DiscoveryLeadReceipt,
} from "./repository-schema.js";
import { resolveLocationArea, listSourceNormalizationAreas } from "./location-catalog.js";
import { BackgroundEnrichmentTaskSchema, ENRICHMENT_MAX_ATTEMPTS, backgroundEnrichmentSource, planBackgroundEnrichment, applyBackgroundEnrichment,
  type BackgroundEnrichmentTask, type BackgroundEnrichmentOptions, type BackgroundEnrichmentStatus, type BackgroundEnrichmentBatchResult } from "./background-enrichment.js";
import { createDatasetSyncStore } from "./dataset-sync.js";
import { createDatasetBaselineStore } from "./dataset-baseline.js";
import { BaselineRequestSchema, type BaselineRequest, type BaselineResponse } from "./dataset-baseline-contract.js";
import { createPublicSyncProjection } from "./public-sync-projection.js";
import { DatasetSyncRequestSchema, type DatasetSyncRequest, type DatasetSyncResponse, type DatasetUpserts } from "./dataset-sync-contract.js";
import { createProjectionSlice, type ProjectionSelection } from "./projection-slice.js";
import { createProjectionDependencies } from "./projection-dependencies.js";
import { DATASET_TABLES as TABLES, DATASET_ENTITY_LIMITS } from "./dataset-tables.js";
export type { BackgroundEnrichmentOptions, BackgroundEnrichmentStatus, BackgroundEnrichmentBatchResult } from "./background-enrichment.js";

export type RepositoryErrorCode = "invalid-data" | "conflict" | "stale-version" | "idempotency-conflict" | "cancelled" | "not-authorized" | "not-found" | "closed" | "unsupported-schema" | "invalid-backup" | "storage-error" | "rate-limited";
const PUBLIC_ERRORS: Record<RepositoryErrorCode, string> = {
  "invalid-data": "岗位数据不符合公共领域契约。", "conflict": "岗位记录与已有版本冲突，未写入。",
  "stale-version": "索引版本或刷新任务已变化，未写入迟到结果。", "idempotency-conflict": "幂等键已用于不同请求。",
  "cancelled": "刷新任务已取消。", "not-authorized": "当前执行身份不拥有该刷新任务。",
  "not-found": "指定记录不存在。", "closed": "岗位仓库已关闭。", "unsupported-schema": "岗位数据库版本不受当前程序支持。",
  "invalid-backup": "备份版本或内容无效，现有数据未被替换。", "storage-error": "岗位仓库操作失败，事务未提交。",
  "rate-limited": "来源刷新间隔尚未到期，现有任务保持原状态。",
};
export class RepositoryError extends Error {
  constructor(public readonly code: RepositoryErrorCode) { super(PUBLIC_ERRORS[code]); this.name = "RepositoryError"; }
}
export type ImportOptions = { expectedRevision?: number; actorScope: string; idempotencyKey: string; runId?: string;
  /** Host-computed identity of a fully validated command, independent of its projected delta. */
  requestFingerprint?: string };
export type StartRunOptions = { sourceId: string; scope: RunScope; actorScope: string; idempotencyKey: string; requestFingerprint?: string };
export type FindRunByRequestOptions = { actorScope: string; idempotencyKey: string; requestFingerprint: string };
export type ReconciliationWriteOptions = Omit<ImportOptions, "runId"> & { expectedRevision: number; throwIfCancelled?: () => void };
export type CandidateQuery = { search?: string; mode?: "exact" | "fuzzy"; viewport?: [number, number, number, number] };
export type CandidateResult = { jobIds: string[]; indexedHits: string[]; exact: false; reason: "safe-superset"; snapshotVersion: number };

const BASE_ENTITIES_SCHEMA = AtlasDatasetObjectSchema.pick({ jobs: true, locations: true });
type Table = typeof TABLES[number];
const encoder = new TextEncoder();
const LEGACY_INFERRED_OFFICE_REASON_PREFIX = "企业公开办公区与园区坐标核实：";
const LEGACY_INFERRED_OFFICE_WARNING = "legacy-office-coordinate-quarantined：历史批量推定的办公地址和坐标已从公共视图隔离；保留来源地点及既有行政区核对，需重新核对实际工作地址。";

/** Read-only safety view; the stored overlay, decisions and receipts remain intact. */
function projectPublicOfficeLocations(dataset: AtlasDataset, entries: readonly OfficeAddressDecision[]): AtlasDataset {
  const legacy = new Map(entries.filter((entry): entry is Extract<OfficeAddressDecision, { kind: "confirm" }> =>
    entry.kind === "confirm" && entry.reason.startsWith(LEGACY_INFERRED_OFFICE_REASON_PREFIX)).map(entry => [entry.id, entry]));
  if (!legacy.size) return dataset;
  const affectedObservations = new Set<string>();
  const locations = dataset.locations.map(location => {
    const decision = location.officeResolution && legacy.get(location.officeResolution.decisionId);
    if (!decision || decision.locationId !== location.id || decision.sourceLocation.id !== location.id) return location;
    for (const evidence of decision.sourceLocation.evidence) affectedObservations.add(evidence.observationId);
    return decision.sourceLocation;
  });
  if (!affectedObservations.size) return dataset;
  return { ...dataset, locations, observations: dataset.observations.map(observation => {
    if (!affectedObservations.has(observation.id) || observation.warnings.includes(LEGACY_INFERRED_OFFICE_WARNING)) return observation;
    // Public warning lists have a 100-entry bound; keep the quarantine visible
    // even when a historical observation already uses the entire warning budget.
    return { ...observation, warnings: [...observation.warnings.slice(-99), LEGACY_INFERRED_OFFICE_WARNING] };
  }) };
}

function json(value: unknown): string {
  function sorted(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(sorted);
    if (item && typeof item === "object") {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(item).sort()) {
        const val: unknown = (item as Record<string, unknown>)[key];
        if (val !== undefined) Object.defineProperty(result, key, { value: sorted(val), enumerable: true });
      }
      return result;
    }
    return item;
  }
  return JSON.stringify(sorted(value));
}
function signature(value: unknown) { return createHash("sha256").update(json(value)).digest("hex"); }
function reconciliationSignature(input: unknown, options: ReconciliationWriteOptions) {
  return signature({ input, expectedRevision: options.expectedRevision, ...(options.requestFingerprint === undefined ? {} : { requestFingerprint: options.requestFingerprint }) });
}
function same(a: unknown, b: unknown) { return json(a) === json(b); }
function compareIds(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }
function union<T>(left: readonly T[], right: readonly T[]) { return [...new Set([...left, ...right])]; }
function sourceIdOrId(table: Table, value: unknown): string {
  return String((value as Record<string, unknown>)[table === "sources" ? "sourceId" : "id"]);
}
function checked<T>(schema: { safeParse(input: unknown): { success: boolean; data?: T } }, input: unknown, code: RepositoryErrorCode = "invalid-data"): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new RepositoryError(code);
  return parsed.data as T;
}
function validateOptions(options: ImportOptions) {
  checked(ActorScopeSchema, options.actorScope); checked(IdempotencyKeySchema, options.idempotencyKey);
  if (options.requestFingerprint !== undefined) checked(RequestFingerprintSchema, options.requestFingerprint);
  if (options.expectedRevision !== undefined && (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0)) throw new RepositoryError("invalid-data");
}
function emptyDataset(revision = 0): AtlasDataset {
  return { schemaVersion: 1, revision, sources: [], companies: [], jobs: [], locations: [], compensations: [], listings: [], observations: [], snapshots: [] };
}
function verifyContentHashes(dataset: AtlasDataset, errorCode: RepositoryErrorCode = "invalid-data") {
  const snapshots = new Map(dataset.snapshots.map((snapshot) => [snapshot.id, snapshot]));
  for (const snapshot of dataset.snapshots) {
    if (createHash("sha256").update(snapshot.text).digest("hex") !== snapshot.contentHash) throw new RepositoryError(errorCode);
  }
  for (const observation of dataset.observations) {
    if (observation.snapshotId && observation.contentHash && snapshots.get(observation.snapshotId)?.contentHash !== observation.contentHash) throw new RepositoryError(errorCode);
    if (observation.rawText !== undefined && observation.contentHash && createHash("sha256").update(observation.rawText).digest("hex") !== observation.contentHash) throw new RepositoryError(errorCode);
  }
}

function mergeCompany(current: Company, incoming: Company): Company {
  const overrides = new Map(current.manualOverrides.map((value) => [value.id, value]));
  for (const value of incoming.manualOverrides) {
    if (overrides.has(value.id) && !same(overrides.get(value.id), value)) throw new RepositoryError("conflict");
    overrides.set(value.id, value);
  }
  const choose = <T extends { verification: string; revision: number }>(old: T | undefined, next: T | undefined): T | undefined => {
    if (!old) return next;
    if (!next || same(old, next)) return old;
    if (old.verification === "verified" && next.verification !== "verified") return old;
    if (next.revision <= old.revision) {
      if (next.verification === "unknown" || next.verification === "unverified") return old;
      throw new RepositoryError("conflict");
    }
    return next;
  };
  const legalEntity = choose(current.legalEntity, incoming.legalEntity);
  return {
    id: current.id, names: union(current.names, incoming.names), domains: union(current.domains, incoming.domains),
    parentCompanyIds: union(current.parentCompanyIds, incoming.parentCompanyIds),
    ...(legalEntity ? { legalEntity } : {}), ultimateControllers: choose(current.ultimateControllers, incoming.ultimateControllers)!,
    manualOverrides: [...overrides.values()],
  };
}
function mergeJob(current: CanonicalJob, incoming: CanonicalJob): CanonicalJob {
  if (same(current, incoming)) return current;
  if (current.companyId !== incoming.companyId || incoming.revision <= current.revision || Date.parse(incoming.updatedAt) < Date.parse(current.updatedAt)) throw new RepositoryError("conflict");
  return { ...incoming, listingIds: union(current.listingIds, incoming.listingIds) };
}
function mergeListing(current: SourceListing, incoming: SourceListing): SourceListing {
  if (current.sourceId !== incoming.sourceId || (current.canonicalJobId && incoming.canonicalJobId && current.canonicalJobId !== incoming.canonicalJobId)
    || (current.sourceRecordId && incoming.sourceRecordId && current.sourceRecordId !== incoming.sourceRecordId)) throw new RepositoryError("conflict");
  const first = Date.parse(current.firstDiscoveredAt) <= Date.parse(incoming.firstDiscoveredAt) ? current.firstDiscoveredAt : incoming.firstDiscoveredAt;
  const last = [current.recordLastSeenAt, incoming.recordLastSeenAt].filter((value): value is string => Boolean(value)).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  return {
    ...current, ...incoming, firstDiscoveredAt: first, ...(last ? { recordLastSeenAt: last } : {}),
    canonicalJobId: current.canonicalJobId ?? incoming.canonicalJobId,
    observationIds: union(current.observationIds, incoming.observationIds),
    ...(current.discoverySourceIds || incoming.discoverySourceIds ? { discoverySourceIds: union(current.discoverySourceIds ?? [], incoming.discoverySourceIds ?? []) } : {}),
    ...(current.discoveredViaUrls || incoming.discoveredViaUrls ? { discoveredViaUrls: union(current.discoveredViaUrls ?? [], incoming.discoveredViaUrls ?? []) } : {}),
  };
}

/** Open only a caller-selected path. The repository never discovers user profiles or browser data. */
export function openJobRepository(path: string, options: { now?: () => string; readOnly?: boolean } = {}) {
  if (typeof path !== "string" || !path || path.includes("\0")) throw new RepositoryError("invalid-data");
  let db: DatabaseSync;
  try { db = new DatabaseSync(path, { readOnly: options.readOnly ?? false }); } catch { throw new RepositoryError("storage-error"); }
  let closed = false;
  const now = () => {
    const value = options.now?.() ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(value))) throw new RepositoryError("invalid-data");
    return new Date(value).toISOString();
  };
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version > REPOSITORY_SCHEMA_VERSION) throw new RepositoryError("unsupported-schema");
    if (options.readOnly && version !== REPOSITORY_SCHEMA_VERSION) throw new RepositoryError("unsupported-schema");
    if (version === 0) {
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
      if (tables.length) throw new RepositoryError("unsupported-schema");
      db.exec("BEGIN IMMEDIATE");
      try { db.exec(REPOSITORY_MIGRATION_V1); db.exec(APPEND_ONLY_TRIGGERS); db.exec("PRAGMA user_version=1; COMMIT;"); }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    if (version < 2) {
      db.exec("BEGIN IMMEDIATE");
      try { db.exec(REPOSITORY_MIGRATION_V2); db.exec(RECONCILIATION_TRIGGERS); db.exec("PRAGMA user_version=2; COMMIT;"); }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    if (version < 3) {
      db.exec("BEGIN IMMEDIATE");
      try { db.exec(REPOSITORY_MIGRATION_V3); db.exec(LOCATION_DECISION_TRIGGERS); db.exec("PRAGMA user_version=3; COMMIT;"); }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    if (version < 4) {
      db.exec("BEGIN IMMEDIATE");
      try { db.exec(REPOSITORY_MIGRATION_V4); db.exec(OFFICE_DECISION_TRIGGERS); db.exec("PRAGMA user_version=4; COMMIT;"); }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    if (version < 5) {
      db.exec("BEGIN IMMEDIATE");
      try { db.exec(REPOSITORY_MIGRATION_V5); db.exec("PRAGMA user_version=5; COMMIT;"); }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    if (version < 6) {
      db.exec("BEGIN IMMEDIATE");
      try { db.exec(REPOSITORY_MIGRATION_V6); db.exec("PRAGMA user_version=6; COMMIT;"); }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    if (version < 7) {
      db.exec("BEGIN IMMEDIATE");
      try { db.exec(REPOSITORY_MIGRATION_V7); db.exec("PRAGMA user_version=7; COMMIT;"); }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    if (!options.readOnly) db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    // Opening a file with a matching user_version is not sufficient proof of this schema.
    db.prepare("SELECT value FROM metadata WHERE key='revision'").get();
    for (const table of TABLES) db.prepare(`SELECT id,document FROM ${table} LIMIT 0`).all();
    db.prepare("SELECT id,document FROM base_jobs LIMIT 0").all();
    db.prepare("SELECT id,revision,document FROM merge_decisions LIMIT 0").all();
    db.prepare("SELECT id,document FROM base_locations LIMIT 0").all();
    db.prepare("SELECT id,revision,document FROM location_decisions LIMIT 0").all();
    db.prepare("SELECT id,revision,document FROM office_decisions LIMIT 0").all();
    db.prepare("SELECT id,actor_scope,kind,job_id,state,next_retry_at,document FROM enrichment_tasks LIMIT 0").all();
    db.prepare("SELECT table_name,entity_id,revision,deleted FROM dataset_changes LIMIT 0").all();
    db.prepare("SELECT job_id,kind,entity_id FROM base_job_dependencies LIMIT 0").all();
    for (const key of ["sync_epoch", "sync_floor"]) if (!db.prepare("SELECT value FROM metadata WHERE key=?").get(key)) throw new RepositoryError("storage-error");
    const check = db.prepare("PRAGMA quick_check").get() as Record<string, unknown>;
    if (Object.values(check)[0] !== "ok") throw new RepositoryError("storage-error");
  } catch (error) { db.close(); throw error instanceof RepositoryError ? error : new RepositoryError("storage-error"); }

  function ensureOpen() { if (closed) throw new RepositoryError("closed"); }
  function transaction<T>(work: () => T): T {
    // A WAL reader observes one committed revision without taking the writer lock.
    ensureOpen(); db.exec(options.readOnly ? "BEGIN" : "BEGIN IMMEDIATE");
    try { const result = work(); db.exec("COMMIT"); return result; }
    catch (error) { try { db.exec("ROLLBACK"); } catch { /* preserve fixed error below */ } throw error instanceof RepositoryError ? error : new RepositoryError("storage-error"); }
  }
  function revision() { return Number((db.prepare("SELECT value FROM metadata WHERE key='revision'").get() as { value: string }).value); }
  const projectionSlice = createProjectionSlice(db, input => { const data = checked(AtlasDatasetSchema, input); verifyContentHashes(data); return data; });
  const projectionDependencies = createProjectionDependencies(db);
  function publicSyncRows(rows: DatasetUpserts): DatasetUpserts {
    return !rows.locations.length && !rows.observations.length ? rows : createPublicSyncProjection(db)(rows);
  }
  const datasetSync = createDatasetSyncStore(db, () => projectPublicOfficeLocations(read(), officeDecisions()), publicSyncRows);
  const baselineStore = createDatasetBaselineStore(path);
  function markPublicOfficeEvidence(location: JobLocation | undefined, atRevision: number) {
    const id = location?.officeResolution?.decisionId;
    if (!id) return;
    const row = db.prepare("SELECT document FROM office_decisions WHERE id=?").get(id) as { document: string } | undefined;
    if (!row) return;
    const entry = checked(OfficeAddressDecisionSchema, JSON.parse(row.document));
    if (entry.kind !== "confirm" || !entry.reason.startsWith(LEGACY_INFERRED_OFFICE_REASON_PREFIX) || entry.locationId !== location!.id) return;
    for (const evidence of entry.sourceLocation.evidence) datasetSync.changed("observations", evidence.observationId, atRevision);
  }
  function saveEnrichmentTask(task: BackgroundEnrichmentTask) {
    const value = checked(BackgroundEnrichmentTaskSchema, task);
    db.prepare("INSERT INTO enrichment_tasks(id,actor_scope,kind,job_id,state,next_retry_at,document) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,next_retry_at=excluded.next_retry_at,document=excluded.document")
      .run(value.id, value.actorScope, value.kind, value.jobId, value.state, value.nextRetryAt ?? null, json(value));
  }
  function enrichmentTasks(actorScope?: string): BackgroundEnrichmentTask[] {
    const rows = actorScope === undefined ? db.prepare("SELECT document FROM enrichment_tasks ORDER BY id").all()
      : db.prepare("SELECT document FROM enrichment_tasks WHERE actor_scope=? ORDER BY id").all(actorScope);
    return (rows as { document: string }[]).map(row => checked(BackgroundEnrichmentTaskSchema, JSON.parse(row.document)));
  }
  function enrichmentStatus(actorScope: string): BackgroundEnrichmentStatus {
    const result: BackgroundEnrichmentStatus = { revision: revision(), pending: 0, running: 0, completed: 0, failed: 0 };
    const rows = db.prepare("SELECT state,COUNT(*) AS count,MIN(next_retry_at) AS next FROM enrichment_tasks WHERE actor_scope=? GROUP BY state").all(actorScope) as { state: BackgroundEnrichmentTask["state"]; count: number; next: string | null }[];
    for (const row of rows) {
      result[row.state] = row.count;
      if (row.next && (!result.nextRetryAt || row.next < result.nextRetryAt)) result.nextRetryAt = row.next;
    }
    return result;
  }
  function enqueueEnrichment(before: AtlasDataset, after: AtlasDataset, actorScope: string) {
    const changedIds = (table: "jobs" | "locations" | "companies" | "listings") => {
      const old = new Map(before[table].map(value => [value.id, value]));
      return new Set(after[table].filter(value => !same(old.get(value.id), value)).map(value => value.id));
    };
    const jobs = changedIds("jobs"), locations = changedIds("locations"), companies = changedIds("companies"), listings = changedIds("listings");
    for (const job of after.jobs) {
      if (!jobs.has(job.id) && !companies.has(job.companyId) && !job.locationIds.some(id => locations.has(id)) && !job.listingIds.some(id => listings.has(id))) continue;
      const id = `enrichment_${signature({ actorScope, kind: "source-metadata-v1", jobId: job.id })}`;
      const sourceFingerprint = signature(backgroundEnrichmentSource(after, job.id));
      const row = db.prepare("SELECT document FROM enrichment_tasks WHERE id=?").get(id) as { document: string } | undefined;
      const previous = row && checked(BackgroundEnrichmentTaskSchema, JSON.parse(row.document));
      if (previous?.sourceFingerprint === sourceFingerprint) continue;
      saveEnrichmentTask({ id, kind: "source-metadata-v1", jobId: job.id, actorScope, sourceFingerprint, state: "pending", attempts: 0, createdAt: previous?.createdAt ?? now(), updatedAt: now() });
    }
  }
  function releaseEnrichment(task: BackgroundEnrichmentTask, state: "pending" | "failed", at: string): BackgroundEnrichmentTask {
    const { leaseId: _lease, leaseExpiresAt: _expiry, nextRetryAt: _retry, result: _result, errorCode: _error, ...value } = task;
    const exhausted = task.attempts >= ENRICHMENT_MAX_ATTEMPTS;
    return { ...value, state: exhausted ? "failed" : state, updatedAt: at,
      ...(exhausted ? { errorCode: "attempts-exhausted" as const } : state === "failed" ? { errorCode: "planning-failed" as const, nextRetryAt: new Date(Date.parse(at) + 1000 * 2 ** task.attempts).toISOString() } : {}) };
  }
  function read(): AtlasDataset {
    ensureOpen(); const dataset = emptyDataset(revision());
    for (const table of TABLES) {
      const rows = db.prepare(`SELECT document FROM ${table} ORDER BY id`).all() as Array<{ document: string }>;
      (dataset[table] as unknown[]) = rows.map((row) => JSON.parse(row.document) as unknown);
    }
    const validated = checked(AtlasDatasetSchema, dataset);
    verifyContentHashes(validated); return validated;
  }
  function receipt<T>(actorScope: string, tool: string, idempotencyKey: string, expectedSignature: string): T | undefined {
    const row = db.prepare("SELECT signature,response FROM receipts WHERE actor_scope=? AND tool=? AND idempotency_key=?").get(actorScope, tool, idempotencyKey) as { signature: string; response: string } | undefined;
    if (!row) return undefined;
    if (row.signature !== expectedSignature) throw new RepositoryError("idempotency-conflict");
    return JSON.parse(row.response) as T;
  }
  function saveReceipt(actorScope: string, tool: string, idempotencyKey: string, requestSignature: string, result: ImportReceipt | SyncRun | DiscoveryLeadReceipt | ReconciliationReceipt | LocationConfirmationReceipt | OfficeAddressReceipt | CompanyControllerOverrideReceipt | CompensationAuditReceipt) {
    db.prepare("INSERT INTO receipts(actor_scope,tool,idempotency_key,signature,response,created_at) VALUES (?,?,?,?,?,?)").run(actorScope, tool, idempotencyKey, requestSignature, json(result), now());
  }
  function runById(runId: string): SyncRun | undefined {
    ensureOpen(); const row = db.prepare("SELECT document FROM runs WHERE id=?").get(runId) as { document: string } | undefined;
    return row ? checked(SyncRunSchema, JSON.parse(row.document)) : undefined;
  }
  function currentRun(runId: string, actorScope?: string): SyncRun {
    const run = runById(runId);
    if (!run) throw new RepositoryError("not-found");
    if (actorScope !== undefined && actorScope !== run.actorScope) throw new RepositoryError("not-authorized");
    if (run.status === "cancelled") throw new RepositoryError("cancelled");
    const generation = db.prepare("SELECT generation FROM source_generations WHERE source_id=?").get(run.sourceId) as { generation: number } | undefined;
    if (run.status !== "running" || !generation || generation.generation !== run.generation) throw new RepositoryError("stale-version");
    return run;
  }
  function saveRun(run: SyncRun) {
    const clean = checked(SyncRunSchema, run);
    db.prepare("INSERT INTO runs(id,source_id,generation,status,document) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,document=excluded.document").run(clean.runId, clean.sourceId, clean.generation, clean.status, json(clean));
  }
  function decisions(): MergeDecision[] {
    return (db.prepare("SELECT document FROM merge_decisions ORDER BY revision").all() as Array<{ document: string }>).map((row) => checked(MergeDecisionSchema, JSON.parse(row.document)));
  }
  function locationDecisions(): LocationConfirmationDecision[] {
    return (db.prepare("SELECT document FROM location_decisions ORDER BY revision").all() as Array<{ document: string }>).map(row => checked(LocationConfirmationDecisionSchema, JSON.parse(row.document)));
  }
  function officeDecisions(): OfficeAddressDecision[] {
    return (db.prepare("SELECT document FROM office_decisions ORDER BY revision").all() as Array<{ document: string }>).map(row => checked(OfficeAddressDecisionSchema, JSON.parse(row.document)));
  }
  function baseSnapshot(current = read()): AtlasDataset {
    // Every caller supplies read()'s validated current snapshot (or uses the
    // default). Validate the replaced base entities and their array bounds once,
    // then validate all composed references without reparsing unchanged tables.
    const { jobs, locations } = checked(BASE_ENTITIES_SCHEMA, {
      jobs: (db.prepare("SELECT document FROM base_jobs ORDER BY id").all() as Array<{ document: string }>).map(row => JSON.parse(row.document)),
      locations: (db.prepare("SELECT document FROM base_locations ORDER BY id").all() as Array<{ document: string }>).map(row => JSON.parse(row.document)),
    });
    const owner = new Map(jobs.flatMap((job) => job.listingIds.map((id) => [id, job.id] as const)));
    const result = { ...current, jobs, locations, listings: current.listings.map((listing) => ({ ...listing, ...(owner.has(listing.id) ? { canonicalJobId: owner.get(listing.id) } : {}) })) };
    if (validateAtlasDatasetReferences(result).length) throw new RepositoryError("invalid-data");
    return result;
  }
  function writeBaseJobs(jobs: readonly CanonicalJob[], replace = false) {
    if (replace) { projectionDependencies.clear(); db.exec("DELETE FROM base_jobs"); }
    const existing = db.prepare("SELECT document FROM base_jobs WHERE id=?");
    const insert = db.prepare("INSERT INTO base_jobs(id,document) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document");
    for (const job of jobs) {
      const document = json(job);
      if ((existing.get(job.id) as { document: string } | undefined)?.document !== document) {
        insert.run(job.id, document); projectionDependencies.save(job);
      }
    }
  }
  function writeBaseLocations(locations: readonly JobLocation[], replace = false) {
    if (replace) db.exec("DELETE FROM base_locations");
    const existing = db.prepare("SELECT document FROM base_locations WHERE id=?");
    const insert = db.prepare("INSERT INTO base_locations(id,document) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document");
    for (const location of locations) {
      if (location.userResolution || location.officeResolution) throw new RepositoryError("conflict");
      const document = json(location);
      if ((existing.get(location.id) as { document: string } | undefined)?.document !== document) insert.run(location.id, document);
    }
  }
  function canonicalProjection(base: AtlasDataset, current: AtlasDataset, entries: readonly MergeDecision[], changedAt: string, locationEntries = locationDecisions(), officeEntries = officeDecisions()) {
    // Empty overlays are identity operations. Keep the complete final dataset
    // validation below, but do not parse every unchanged record four extra times.
    const withAreas = locationEntries.length ? projectLocationConfirmations(base, locationEntries) : base;
    const withOffices = officeEntries.length ? projectOfficeAddressConfirmations(withAreas, officeEntries) : withAreas;
    const revoked = new Set(entries.flatMap(entry => entry.kind === "revoke" ? [entry.targetDecisionId] : []));
    const activeMerge = entries.some(entry => entry.kind === "merge" && !revoked.has(entry.id));
    const projection: ReturnType<typeof projectReconciliation> = activeMerge ? projectReconciliation(withOffices, entries) : {
      dataset: { ...withOffices, jobs: [...withOffices.jobs].sort((a, b) => compareIds(a.id, b.id)) },
      aliases: withOffices.jobs.map(job => ({ jobId: job.id, canonicalJobId: job.id })).sort((a, b) => compareIds(a.jobId, b.jobId)), conflicts: [],
    };
    const old = new Map(current.jobs.map((job) => [job.id, job]));
    const currentLocations = new Map(current.locations.map(location => [location.id, location]));
    const projectedLocations = new Map(projection.dataset.locations.map(location => [location.id, location]));
    const aliasCounts = new Map<string, number>();
    for (const alias of projection.aliases) aliasCounts.set(alias.canonicalJobId, (aliasCounts.get(alias.canonicalJobId) ?? 0) + 1);
    const body = (job: CanonicalJob, locations: ReadonlyMap<string, JobLocation>) => { const { revision: _revision, updatedAt: _updatedAt, ...value } = job; return { job: value, locations: job.locationIds.map(id => locations.get(id)) }; };
    projection.dataset.jobs = projection.dataset.jobs.map((job) => {
      const previous = old.get(job.id);
      if (!previous && !db.prepare("SELECT job_id FROM job_versions WHERE job_id=?").get(job.id)) return job;
      const count = aliasCounts.get(job.id) ?? 0;
      if (previous && same(body(previous, currentLocations), body(job, projectedLocations))) return count === 1 && job.revision > previous.revision ? job : previous;
      const counter = db.prepare("SELECT revision FROM job_versions WHERE job_id=?").get(job.id) as { revision: number } | undefined;
      const version = Math.max(job.revision, counter ? counter.revision + 1 : 0, previous ? previous.revision + 1 : 0);
      const updatedAt = [job.updatedAt, ...(previous ? [previous.updatedAt] : []), changedAt].sort((a, b) => Date.parse(b) - Date.parse(a))[0]!;
      return { ...job, revision: version, updatedAt };
    });
    projection.dataset = checked(AtlasDatasetSchema, projection.dataset);
    return projection;
  }
  function saveAliases(aliases: readonly { jobId: string; canonicalJobId: string }[], version: number, at: string, decisionId?: string, partial = false) {
    const select = db.prepare("SELECT job_id,canonical_job_id FROM job_aliases WHERE job_id=?");
    const rows = partial ? aliases.flatMap(alias => { const row = select.get(alias.jobId); return row ? [row] : []; }) : db.prepare("SELECT job_id,canonical_job_id FROM job_aliases").all();
    const previous = new Map((rows as Array<{ job_id: string; canonical_job_id: string }>).map((row) => [row.job_id, row.canonical_job_id]));
    const currentIds = new Set(aliases.map(alias => alias.jobId));
    const remove = db.prepare("DELETE FROM job_aliases WHERE job_id=?");
    for (const id of previous.keys()) if (!currentIds.has(id)) remove.run(id);
    const insert = db.prepare("INSERT INTO job_aliases VALUES (?,?) ON CONFLICT(job_id) DO UPDATE SET canonical_job_id=excluded.canonical_job_id");
    const history = db.prepare("INSERT INTO job_alias_history(job_id,revision,document) VALUES (?,?,?)");
    for (const alias of aliases) {
      if (previous.get(alias.jobId) !== alias.canonicalJobId) {
        insert.run(alias.jobId, alias.canonicalJobId);
        const event: JobAliasEvent = { ...alias, revision: version, at, ...(decisionId ? { decisionId } : {}) };
        history.run(alias.jobId, version, json(event));
      }
    }
  }
  function supersedeSources(dataset: AtlasDataset, jobIds: readonly string[], reason: string) {
    const sources = new Set(dataset.listings.filter((listing) => listing.canonicalJobId && jobIds.includes(listing.canonicalJobId)).map((listing) => listing.sourceId));
    const active = db.prepare("SELECT document FROM runs WHERE status='running'").all() as Array<{ document: string }>;
    for (const row of active) {
      const run = checked(SyncRunSchema, JSON.parse(row.document));
      if (sources.has(run.sourceId)) saveRun({ ...run, status: "superseded", finishedAt: now(), summary: { partial: true, errorCode: reason } });
    }
  }
  function write(dataset: AtlasDataset, replace = false, scope?: ReadonlySet<string>) {
    if (replace) {
      db.exec("DROP TRIGGER observations_no_update; DROP TRIGGER observations_no_delete; DROP TRIGGER snapshots_no_update; DROP TRIGGER snapshots_no_delete;");
      db.exec("DELETE FROM job_locations; DELETE FROM job_compensations; DELETE FROM job_listings; DELETE FROM listing_observations; DELETE FROM location_rtree; DELETE FROM location_rtree_ids; DELETE FROM jobs_fts; DELETE FROM discovery_leads;");
      for (const table of [...TABLES].reverse()) db.exec(`DELETE FROM ${table}`);
    }
    // Full operations retain the original reference path; hot writes supply a
    // validated dependency slice and may delete only jobs in that explicit scope.
    // Existing secondary-index semantics remain derived from actual row changes.
    const changedJobs = new Set<string>();
    const changedCompanyNames = new Set<string>();
    const changedListingObservations = new Set<string>();
    const changedCoordinates = new Set<string>();
    const selectExisting = new Map(TABLES.map(table => [table, db.prepare(`SELECT document FROM ${table} WHERE id=?`)]));
    for (const table of TABLES) for (const value of dataset[table]) {
      const id = sourceIdOrId(table, value); const document = json(value);
      const existing = selectExisting.get(table)!.get(id) as { document: string } | undefined;
      if (existing?.document === document) continue;
      if ((table === "observations" || table === "snapshots") && existing) throw new RepositoryError("conflict");
      if (table === "jobs") {
        const job = value as CanonicalJob;
        changedJobs.add(id);
        db.prepare("INSERT INTO jobs(id,company_id,document) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET company_id=excluded.company_id,document=excluded.document").run(id, job.companyId, document);
      } else if (table === "locations") {
        const location = value as AtlasDataset["locations"][number];
        const previous = existing ? JSON.parse(existing.document) as JobLocation : undefined;
        if (!replace) { markPublicOfficeEvidence(previous, dataset.revision); markPublicOfficeEvidence(location, dataset.revision); }
        if (!same(previous?.coordinates, location.coordinates)) changedCoordinates.add(id);
        db.prepare("INSERT INTO locations(id,latitude,longitude,document) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET latitude=excluded.latitude,longitude=excluded.longitude,document=excluded.document").run(id, location.coordinates?.latitude ?? null, location.coordinates?.longitude ?? null, document);
      } else if (table === "listings") {
        const listing = value as SourceListing;
        const previous = existing ? JSON.parse(existing.document) as SourceListing : undefined;
        if (!previous || !same(previous.observationIds, listing.observationIds)) changedListingObservations.add(id);
        db.prepare("INSERT INTO listings(id,source_id,job_id,document) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET source_id=excluded.source_id,job_id=excluded.job_id,document=excluded.document").run(id, listing.sourceId, listing.canonicalJobId ?? null, document);
      } else if (table === "observations") {
        const observation = value as AtlasDataset["observations"][number];
        db.prepare("INSERT INTO observations(id,listing_id,document) VALUES (?,?,?)").run(id, observation.listingId, document);
      } else if (table === "snapshots") {
        const snapshot = value as AtlasDataset["snapshots"][number];
        db.prepare("INSERT INTO snapshots(id,listing_id,observation_id,document) VALUES (?,?,?,?)").run(id, snapshot.listingId, snapshot.observationId, document);
      } else {
        if (table === "companies") {
          const previous = existing ? JSON.parse(existing.document) as Company : undefined;
          if (!previous || !same(previous.names, (value as Company).names)) changedCompanyNames.add(id);
        }
        db.prepare(`INSERT INTO ${table}(id,document) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document`).run(id, document);
      }
      if (!replace) datasetSync.changed(table, id, dataset.revision);
    }
    const activeJobIds = new Set(dataset.jobs.map((job) => job.id));
    const removedJobIds = scope ? [...scope].filter(id => !activeJobIds.has(id))
      : (db.prepare("SELECT id FROM jobs").all() as Array<{ id: string }>).filter(row => !activeJobIds.has(row.id)).map(row => row.id);
    for (const id of [...changedJobs, ...removedJobIds]) {
      db.prepare("DELETE FROM job_locations WHERE job_id=?").run(id);
      db.prepare("DELETE FROM job_compensations WHERE job_id=?").run(id);
      db.prepare("DELETE FROM job_listings WHERE job_id=?").run(id);
    }
    const reindexedJobs = new Set([...changedJobs, ...removedJobIds]);
    // A company-only edit changes FTS text for its jobs even if their documents
    // (and therefore job revisions and relationship rows) remain unchanged.
    for (const job of dataset.jobs) if (changedCompanyNames.has(job.companyId)) reindexedJobs.add(job.id);
    for (const id of reindexedJobs) db.prepare("DELETE FROM jobs_fts WHERE job_id=?").run(id);
    for (const id of removedJobIds) {
      db.prepare("DELETE FROM jobs WHERE id=?").run(id);
      if (!replace) datasetSync.changed("jobs", id, dataset.revision, true);
    }
    const companyById = new Map(dataset.companies.map((company) => [company.id, company]));
    for (const job of dataset.jobs) {
      if (changedJobs.has(job.id)) {
        db.prepare("INSERT INTO job_versions VALUES (?,?) ON CONFLICT(job_id) DO UPDATE SET revision=MAX(revision,excluded.revision)").run(job.id, job.revision);
        for (const id of job.locationIds) db.prepare("INSERT INTO job_locations VALUES (?,?)").run(job.id, id);
        for (const id of job.compensationIds) db.prepare("INSERT INTO job_compensations VALUES (?,?)").run(job.id, id);
        for (const id of job.listingIds) db.prepare("INSERT INTO job_listings VALUES (?,?)").run(job.id, id);
      }
      if (!reindexedJobs.has(job.id)) continue;
      const company = companyById.get(job.companyId)!.names.join(" ");
      const cjkText = [job.title.value, company, job.description].join(" ").normalize("NFKC");
      const cjk: string[] = [];
      for (const segment of cjkText.match(/\p{Script=Han}+/gu) ?? []) {
        cjk.push(...segment);
        for (let index = 0; index < segment.length - 1; index++) cjk.push(segment.slice(index, index + 2));
      }
      db.prepare("INSERT INTO jobs_fts(job_id,title,company,description,cjk) VALUES (?,?,?,?,?)").run(job.id, normalizeSearchText(job.title.value), normalizeSearchText(company), normalizeSearchText(job.description), [...new Set(cjk)].join(" "));
    }
    for (const listing of dataset.listings) if (changedListingObservations.has(listing.id)) {
      db.prepare("DELETE FROM listing_observations WHERE listing_id=?").run(listing.id);
      for (const observationId of listing.observationIds) db.prepare("INSERT INTO listing_observations VALUES (?,?)").run(listing.id, observationId);
    }
    for (const location of dataset.locations) if (changedCoordinates.has(location.id)) {
      const existing = db.prepare("SELECT rid FROM location_rtree_ids WHERE location_id=?").get(location.id) as { rid: number } | undefined;
      if (!location.coordinates) {
        if (existing) db.prepare("DELETE FROM location_rtree WHERE rid=?").run(existing.rid);
        // Retain the location-to-rid identity if a confirmation is revoked and
        // later re-added. No RTree row means it is not a spatial candidate.
        continue;
      }
      const rid = existing?.rid ?? db.prepare("INSERT INTO location_rtree_ids(location_id) VALUES (?)").run(location.id).lastInsertRowid;
      db.prepare("INSERT OR REPLACE INTO location_rtree VALUES (?,?,?,?,?)").run(rid, location.coordinates.longitude, location.coordinates.longitude, location.coordinates.latitude, location.coordinates.latitude);
    }
    if (scope) {
      // Partial validation must preserve the public contract's global array caps.
      for (const table of TABLES) if ((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count > DATASET_ENTITY_LIMITS[table]) throw new RepositoryError("invalid-data");
    }
    db.prepare("UPDATE metadata SET value=? WHERE key='revision'").run(String(dataset.revision));
    datasetSync.finish(dataset.revision, replace);
    if (replace) db.exec(APPEND_ONLY_TRIGGERS);
  }
  function merged(current: AtlasDataset, incoming: AtlasDataset): AtlasDataset {
    const result = emptyDataset(current.revision);
    for (const table of TABLES) {
      const values = new Map<string, unknown>(current[table].map((value) => [sourceIdOrId(table, value), value]));
      for (const value of incoming[table]) {
        const id = sourceIdOrId(table, value); const old = values.get(id);
        if (!old || same(old, value)) { values.set(id, value); continue; }
        if (table === "observations" || table === "snapshots") throw new RepositoryError("conflict");
        if (table === "companies") values.set(id, mergeCompany(old as Company, value as Company));
        else if (table === "jobs") values.set(id, mergeJob(old as CanonicalJob, value as CanonicalJob));
        else if (table === "listings") values.set(id, mergeListing(old as SourceListing, value as SourceListing));
        else if (table === "sources") {
          // Refresh observations never silently enable a source or replace its endpoint/attribution policy.
          if (!same(old, value)) throw new RepositoryError("conflict");
        } else if (table === "locations") {
          const before = old as JobLocation, after = value as JobLocation;
          const combined = JobLocationSchema.parse({ ...before, ...after, streetAddress: after.streetAddress ?? before.streetAddress, postalCode: after.postalCode ?? before.postalCode,
            evidence: [...before.evidence, ...after.evidence.filter(entry => !before.evidence.some(previous => same(entry, previous)))] });
          if (!compatibleSourceLocation(before, combined) || before.userResolution || before.officeResolution || after.userResolution || after.officeResolution) throw new RepositoryError("conflict");
          values.set(id, combined);
        } else if (table === "compensations") throw new RepositoryError("conflict");
      }
      (result[table] as unknown[]) = [...values.values()].sort((a, b) => compareIds(sourceIdOrId(table, a), sourceIdOrId(table, b)));
    }
    return checked(AtlasDatasetSchema, result);
  }
  function validateRunDelta(incoming: AtlasDataset, next: AtlasDataset, current: AtlasDataset, run: SyncRun) {
    const listings = new Map(next.listings.map((listing) => [listing.id, listing]));
    const belongs = (id: string) => listings.get(id)?.sourceId === run.sourceId;
    if (incoming.sources.some((source) => source.sourceId !== run.sourceId)
      || incoming.listings.some((listing) => !belongs(listing.id))
      || incoming.observations.some((observation) => !belongs(observation.listingId))
      || incoming.snapshots.some((snapshot) => !belongs(snapshot.listingId))
      || incoming.jobs.some((job) => !job.listingIds.some(belongs))) throw new RepositoryError("conflict");
    const allowedJobs = next.jobs.filter((job) => job.listingIds.some(belongs));
    const companyIds = new Set(allowedJobs.map((job) => job.companyId));
    const locationIds = new Set(allowedJobs.flatMap((job) => job.locationIds));
    const salaryIds = new Set(allowedJobs.flatMap((job) => job.compensationIds));
    if (incoming.companies.some((company) => !companyIds.has(company.id))
      || incoming.locations.some((location) => !locationIds.has(location.id))
      || incoming.compensations.some((salary) => !salaryIds.has(salary.id))) throw new RepositoryError("conflict");
    const oldCompanies = new Map(current.companies.map((company) => [company.id, company]));
    for (const company of incoming.companies) for (const override of company.manualOverrides) {
      const oldOverride = oldCompanies.get(company.id)?.manualOverrides.find((value) => value.id === override.id);
      if (!oldOverride || !same(oldOverride, override)) throw new RepositoryError("conflict");
    }
  }
  function counts(current: AtlasDataset, next: AtlasDataset, incoming: AtlasDataset): ImportReceipt["counts"] {
    const oldJobs = new Map(current.jobs.map((job) => [job.id, job]));
    const newJobs = new Map(next.jobs.map((job) => [job.id, job]));
    let added = 0, updated = 0, unchanged = 0;
    for (const job of incoming.jobs) {
      if (!oldJobs.has(job.id)) added++;
      else if (!same(oldJobs.get(job.id), newJobs.get(job.id))) updated++; else unchanged++;
    }
    const addedIds = (table: "listings" | "observations" | "snapshots") => { const oldIds = new Set(current[table].map((value) => value.id)); return incoming[table].filter((value) => !oldIds.has(value.id)).length; };
    return { newJobs: added, updatedJobs: updated, unchangedJobs: unchanged, newListings: addedIds("listings"), newObservations: addedIds("observations"), newSnapshots: addedIds("snapshots") };
  }
  function aliasId(jobId: string): string | undefined {
    return (db.prepare("SELECT canonical_job_id FROM job_aliases WHERE job_id=?").get(jobId) as { canonical_job_id: string } | undefined)?.canonical_job_id;
  }
  function assertWriteVersion(writeOptions: ReconciliationWriteOptions, current: AtlasDataset) {
    validateOptions(writeOptions);
    if (writeOptions.expectedRevision === undefined || writeOptions.expectedRevision !== current.revision) throw new RepositoryError("stale-version");
  }
  function commitDecision(current: AtlasDataset, entry: MergeDecision, options: ReconciliationWriteOptions, tool: string, requestSignature: string): ReconciliationReceipt {
    const base = baseSnapshot(current);
    const prior = decisions();
    const revoked = entry.kind === "revoke" ? prior.find((decision) => decision.id === entry.targetDecisionId) : undefined;
    const affected = entry.kind === "merge" ? [entry.targetJobId, entry.sourceJobId] : revoked?.kind === "merge" ? [aliasId(revoked.targetJobId), aliasId(revoked.sourceJobId)].filter((id): id is string => Boolean(id)) : [];
    const projection = canonicalProjection(base, current, [...prior, entry], entry.at);
    projection.dataset.revision = entry.revision;
    db.prepare("INSERT INTO merge_decisions VALUES (?,?,?)").run(entry.id, entry.revision, json(entry));
    write(projection.dataset);
    saveAliases(projection.aliases, entry.revision, entry.at, entry.id);
    if (affected.length) supersedeSources(current, affected, "reconciliation-changed");
    const result: ReconciliationReceipt = { ok: true, revision: entry.revision, decision: entry, aliases: projection.aliases };
    saveReceipt(options.actorScope, tool, options.idempotencyKey, requestSignature, result);
    return result;
  }

  function locationTarget(current: AtlasDataset, jobId: string, locationId: string, requireCurrent = true) {
    const canonicalJobId = aliasId(jobId); const job = current.jobs.find(value => value.id === canonicalJobId);
    const base = baseSnapshot(current); const original = base.locations.find(value => value.id === locationId);
    if (!job || !original || requireCurrent && !job.locationIds.includes(locationId)) throw new RepositoryError("not-found");
    if (!original.evidence.length) throw new RepositoryError("conflict");
    const owners = base.jobs.filter(value => value.locationIds.includes(locationId));
    const listings = base.listings.filter(value => value.locationIds?.includes(locationId));
    if (owners.length !== 1 || listings.length !== 1 || !owners[0]!.listingIds.includes(listings[0]!.id) || !job.listingIds.includes(listings[0]!.id)) throw new RepositoryError("conflict");
    if (original.evidence.some(ref => base.observations.find(value => value.id === ref.observationId)?.listingId !== listings[0]!.id)) throw new RepositoryError("conflict");
    return { base, original, owner: owners[0]!, listing: listings[0]!, job };
  }
  function prepareLocation(input: PreviewLocationConfirmationInput, current: AtlasDataset): { preview: LocationConfirmationPreview; target: ReturnType<typeof locationTarget>; area: Extract<LocationConfirmationDecision, { kind: "confirm" }>["area"] } {
    if (current.revision !== input.expectedRevision) throw new RepositoryError("stale-version");
    const target = locationTarget(current, input.jobId, input.locationId);
    let area: Extract<LocationConfirmationDecision, { kind: "confirm" }>["area"];
    try { area = resolveLocationArea(input.proposal); } catch { throw new RepositoryError("invalid-data"); }
    const currentLocation = current.locations.find(value => value.id === input.locationId)!;
    const entry: Extract<LocationConfirmationDecision, { kind: "confirm" }> = { id: "location-preview", kind: "confirm", jobId: target.owner.id, listingId: target.listing.id, locationId: input.locationId, sourceLocation: target.original, area, actorScope: "preview", at: now(), revision: current.revision + 1, reason: input.reason };
    const preview = checked(LocationConfirmationPreviewSchema, { expectedRevision: current.revision, previewFingerprint: signature({ input, original: target.original, area }), jobId: input.jobId, locationId: input.locationId,
      original: target.original, current: currentLocation, proposed: applyLocationConfirmation(target.original, entry),
      ...(currentLocation.userResolution ? { activeDecisionId: currentLocation.userResolution.decisionId } : {}), warnings: [
        "这是本人确认的工作地区，原站地点原文及证据保持不变；不代表原站已核实该行政区域。",
        "本次不生成或沿用办公坐标。城市名称不是精确办公地址；地图参考点需另行明确选择。",
        ...(area.basis.kind === "china-catalog" ? ["省市区目录为2023年统计快照；分组、镇街及功能区按原目录保留，不声明为现行行政权威。"] : []),
      ] });
    return { preview, target, area };
  }
  function commitLocation(current: AtlasDataset, entry: LocationConfirmationDecision, options: ReconciliationWriteOptions, tool: string, requestSignature: string, requestedJobId: string): LocationConfirmationReceipt {
    const entries = [...locationDecisions(), entry];
    const base = { ...baseSnapshot(current), revision: entry.revision };
    const projection = canonicalProjection(base, current, decisions(), entry.at, entries);
    projection.dataset.revision = entry.revision;
    db.prepare("INSERT INTO location_decisions VALUES (?,?,?)").run(entry.id, entry.revision, json(entry));
    write(projection.dataset);
    const location = projection.dataset.locations.find(value => value.id === entry.locationId)!;
    const result = checked(LocationConfirmationReceiptSchema, { ok: true, revision: entry.revision, jobId: requestedJobId, locationId: entry.locationId, decisionId: entry.id, ...(location.userResolution ? { activeDecisionId: location.userResolution.decisionId } : {}), location });
    saveReceipt(options.actorScope, tool, options.idempotencyKey, requestSignature, result);
    return result;
  }
  function officeTarget(current: AtlasDataset, jobId: string, locationId: string) {
    const target = locationTarget(current, jobId, locationId);
    const sourceLocation = projectLocationConfirmations(target.base, locationDecisions()).locations.find(value => value.id === locationId)!;
    if (sourceLocation.kind !== "office" || target.job.workMode === "remote") throw new RepositoryError("conflict");
    return { ...target, sourceLocation };
  }
  function prepareOffice(input: PreviewOfficeConfirmationInput, current: AtlasDataset) {
    if (current.revision !== input.expectedRevision) throw new RepositoryError("stale-version");
    const target = officeTarget(current, input.jobId, input.locationId);
    try { resolveLocationArea({ countryCode: input.proposal.countryCode, locationKind: "office", area: { kind: "manual-area" } }); } catch { throw new RepositoryError("invalid-data"); }
    const simple = (value: string | undefined) => value?.normalize("NFKC").replace(/\s/gu, "").toLowerCase();
    if ([target.sourceLocation.city, target.sourceLocation.region, target.sourceLocation.countryCode].some(value => value && simple(value) === simple(input.proposal.streetAddress))) throw new RepositoryError("invalid-data");
    const entry: Extract<OfficeAddressDecision, { kind: "confirm" }> = { id: "office-preview", kind: "confirm", jobId: target.owner.id, listingId: target.listing.id, locationId: input.locationId,
      sourceLocation: target.sourceLocation, proposal: input.proposal, actorScope: "preview", at: now(), revision: current.revision + 1, reason: input.reason };
    let proposed: JobLocation;
    try { proposed = applyOfficeAddressConfirmation(target.sourceLocation, entry); } catch { throw new RepositoryError("invalid-data"); }
    const currentLocation = current.locations.find(value => value.id === input.locationId)!;
    const preview = checked(OfficeAddressPreviewSchema, { expectedRevision: current.revision, previewFingerprint: signature({ input, sourceLocation: target.sourceLocation }), jobId: input.jobId,
      locationId: input.locationId, current: currentLocation, sourceLocation: target.sourceLocation, proposed,
      ...(currentLocation.officeResolution ? { activeDecisionId: currentLocation.officeResolution.decisionId } : {}), warnings: [
        "这是本人核对的具体街址与WGS84点，仍为待核实；不代表原站、地图provider或雇主认证办公地址。",
        "来源原文与证据保持不变。来源地点或有效地区确认变化后，本次办公位置不再自动采用；历史可撤销。",
        "楼宇、入口或园区点不代表具体楼层；离家直线距离仍为估算，不是通勤路线。",
      ] });
    return { preview, target };
  }
  function commitOffice(current: AtlasDataset, entry: Exclude<OfficeAddressDecision, { kind: "invalidate" }>, options: ReconciliationWriteOptions, tool: string, requestSignature: string, requestedJobId: string): OfficeAddressReceipt {
    options.throwIfCancelled?.();
    const base = { ...baseSnapshot(current), revision: entry.revision };
    const projection = canonicalProjection(base, current, decisions(), entry.at, locationDecisions(), [...officeDecisions(), entry]);
    projection.dataset.revision = entry.revision;
    db.prepare("INSERT INTO office_decisions VALUES (?,?,?)").run(entry.id, entry.revision, json(entry));
    write(projection.dataset);
    const location = projection.dataset.locations.find(value => value.id === entry.locationId)!;
    const result = checked(OfficeAddressReceiptSchema, { ok: true, revision: entry.revision, jobId: requestedJobId, locationId: entry.locationId, decisionId: entry.id,
      ...(location.officeResolution ? { activeDecisionId: location.officeResolution.decisionId } : {}), location });
    saveReceipt(options.actorScope, tool, options.idempotencyKey, requestSignature, result);
    return result;
  }

  return {
    async getEnrichmentStatus(options: Pick<BackgroundEnrichmentOptions, "actorScope"> = {}): Promise<BackgroundEnrichmentStatus> {
      const actorScope = checked(ActorScopeSchema, options.actorScope ?? "local-owner");
      return transaction(() => enrichmentStatus(actorScope));
    },
    async processEnrichmentBatch(options: BackgroundEnrichmentOptions = {}): Promise<BackgroundEnrichmentBatchResult> {
      const actorScope = checked(ActorScopeSchema, options.actorScope ?? "local-owner");
      const limit = options.limit ?? 8;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new RepositoryError("invalid-data");
      options.signal?.throwIfAborted();
      const claimed = transaction(() => {
        const at = now();
        const expired = db.prepare("SELECT document FROM enrichment_tasks WHERE actor_scope=? AND state='running' AND json_extract(document,'$.leaseExpiresAt')<=?").all(actorScope, at) as { document: string }[];
        for (const row of expired) saveEnrichmentTask(releaseEnrichment(checked(BackgroundEnrichmentTaskSchema, JSON.parse(row.document)), "pending", at));
        const rows = db.prepare("SELECT document FROM enrichment_tasks WHERE actor_scope=? AND (state='pending' OR (state='failed' AND next_retry_at<=?)) ORDER BY rowid LIMIT ?").all(actorScope, at, limit) as { document: string }[];
        return rows.map(row => {
          const task = checked(BackgroundEnrichmentTaskSchema, JSON.parse(row.document));
          const running: BackgroundEnrichmentTask = { ...task, state: "running", attempts: task.attempts + 1, updatedAt: at, leaseId: `lease_${randomUUID()}`, leaseExpiresAt: new Date(Date.parse(at) + 60_000).toISOString(), nextRetryAt: undefined };
          saveEnrichmentTask(running); return running;
        });
      });
      if (!claimed.length) {
        const status = transaction(() => enrichmentStatus(actorScope));
        return { processed: 0, completed: 0, failed: 0, changedJobs: 0, revision: status.revision, status };
      }
      try {
        return transaction(() => {
          options.signal?.throwIfAborted();
          const slice = projectionSlice.read({ seeds: { jobs: claimed.map(task => task.jobId) }, companyContext: true });
          const { current, base } = slice;
          let nextBase = base;
          const completed: Array<{ task: BackgroundEnrichmentTask; changed: boolean }> = [];
          const changedBaseLocationIds = new Set<string>();
          let failed = 0;
          for (const task of claimed) {
            const row = db.prepare("SELECT document FROM enrichment_tasks WHERE id=?").get(task.id) as { document: string } | undefined;
            if (!row || checked(BackgroundEnrichmentTaskSchema, JSON.parse(row.document)).leaseId !== task.leaseId) continue;
            const fingerprint = signature(backgroundEnrichmentSource(base, task.jobId));
            if (fingerprint !== task.sourceFingerprint) {
              saveEnrichmentTask({ ...releaseEnrichment(task, "pending", now()), state: "pending", attempts: 0, sourceFingerprint: fingerprint, errorCode: undefined });
              continue;
            }
            try {
              const plan = planBackgroundEnrichment(nextBase, current, task.jobId, listSourceNormalizationAreas());
              // Validate each task's small delta here; canonicalProjection below
              // validates the complete batch, including all cross-record references.
              const validated = { locations: plan.locations.map(value => checked(JobLocationSchema, value)), companies: plan.companies.map(value => checked(CompanySchema, value)) };
              completed.push({ task, changed: validated.locations.length > 0 || validated.companies.length > 0 });
              for (const location of validated.locations) changedBaseLocationIds.add(location.id);
              nextBase = applyBackgroundEnrichment(nextBase, validated);
            } catch { saveEnrichmentTask(releaseEnrichment(task, "failed", now())); failed++; }
          }
          const projection = canonicalProjection(nextBase, current, slice.merges, now(), slice.locations, slice.offices);
          const next = projection.dataset;
          const changed = TABLES.some(table => !same(current[table], next[table]));
          next.revision = current.revision + Number(changed);
          const previousCompanies = new Map(current.companies.map(value => [value.id, value]));
          const previousJobs = new Map(current.jobs.map(value => [value.id, value]));
          const previousLocations = new Map(current.locations.map(value => [value.id, value]));
          const changedCompanies = new Set(next.companies.filter(value => !same(previousCompanies.get(value.id), value)).map(value => value.id));
          const changedLocations = new Set(next.locations.filter(value => !same(previousLocations.get(value.id), value)).map(value => value.id));
          const changedJobs = next.jobs.filter(value => changedCompanies.has(value.companyId) || value.locationIds.some(id => changedLocations.has(id)) || !same(previousJobs.get(value.id), value)).length;
          options.signal?.throwIfAborted();
          if (changed) { writeBaseLocations(nextBase.locations.filter(location => changedBaseLocationIds.has(location.id))); write(next, false, new Set(current.jobs.map(job => job.id))); saveAliases(projection.aliases, next.revision, now(), undefined, true); }
          for (const { task, changed: taskChanged } of completed) {
            const clean = releaseEnrichment(task, "pending", now());
            saveEnrichmentTask({ ...clean, state: "completed", errorCode: undefined, nextRetryAt: undefined, sourceFingerprint: signature(backgroundEnrichmentSource(nextBase, task.jobId)), result: { revision: next.revision, changedJobs: Number(taskChanged) } });
          }
          const status = enrichmentStatus(actorScope);
          return { processed: claimed.length, completed: completed.length, failed, changedJobs, revision: next.revision, status };
        });
      } catch (error) {
        // The work/receipt transaction rolled back. Preserve bounded retry state
        // without pretending any facts committed; a crash leaves the lease for recovery.
        transaction(() => {
          for (const task of claimed) {
            const row = db.prepare("SELECT document FROM enrichment_tasks WHERE id=?").get(task.id) as { document: string } | undefined;
            if (row && checked(BackgroundEnrichmentTaskSchema, JSON.parse(row.document)).leaseId === task.leaseId) saveEnrichmentTask(releaseEnrichment(task, options.signal?.aborted ? "pending" : "failed", now()));
          }
        });
        options.signal?.throwIfAborted();
        throw error;
      }
    },
    async readSnapshot(): Promise<AtlasDataset> { return transaction(() => projectPublicOfficeLocations(read(), officeDecisions())); },
    async syncSnapshot(input: DatasetSyncRequest = {}, paged = false): Promise<DatasetSyncResponse> {
      const request = checked(DatasetSyncRequestSchema, input);
      return transaction(() => datasetSync.read(request, paged));
    },
    async readBaselinePage(input: BaselineRequest = {}, actorScope = "local-owner"): Promise<BaselineResponse> {
      ensureOpen(); return baselineStore.read(checked(BaselineRequestSchema, input), actorScope);
    },
    async closeBaselineSession(session: string, actorScope = "local-owner") { ensureOpen(); return baselineStore.closeSession(session, actorScope); },
    /** Ingestion-only origins: never use this view for map totals or user-facing search. */
    async readProjectionSnapshot(selection?: ProjectionSelection): Promise<AtlasDataset> { return transaction(() => selection ? projectionSlice.read({ seeds: selection, listingHistory: true }).base : baseSnapshot()); },
    async readOfficeAddressTarget(input: OfficeAddressCandidatesInput) {
      const parsed = checked(OfficeAddressCandidatesInputSchema, input);
      return transaction(() => {
        const current = read(); if (current.revision !== parsed.expectedRevision) throw new RepositoryError("stale-version");
        const target = officeTarget(current, parsed.jobId, parsed.locationId);
        return { revision: current.revision, jobId: parsed.jobId, locationId: parsed.locationId, sourceLocation: target.sourceLocation };
      });
    },
    async previewOfficeConfirmation(input: unknown): Promise<OfficeAddressPreview> {
      const parsed = checked(PreviewOfficeConfirmationInputSchema, input);
      return transaction(() => prepareOffice(parsed, read()).preview);
    },
    async findOfficeAddressReceipt(tool: "locations.confirm-office-address" | "locations.revoke-office-address", input: unknown, options: ReconciliationWriteOptions): Promise<OfficeAddressReceipt | undefined> {
      validateOptions(options);
      const parsed = tool === "locations.confirm-office-address" ? checked(ConfirmOfficeAddressInputSchema, input) : checked(RevokeOfficeAddressInputSchema, input);
      if (parsed.expectedRevision !== options.expectedRevision) throw new RepositoryError("invalid-data");
      const requestSignature = signature({ input: parsed });
      return transaction(() => { const saved = receipt<OfficeAddressReceipt>(options.actorScope, tool, options.idempotencyKey, requestSignature); return saved ? checked(OfficeAddressReceiptSchema, saved) : undefined; });
    },
    async confirmOfficeAddress(input: ConfirmOfficeAddressInput, options: ReconciliationWriteOptions): Promise<OfficeAddressReceipt> {
      validateOptions(options); const parsed = checked(ConfirmOfficeAddressInputSchema, input);
      if (options.expectedRevision !== parsed.expectedRevision) throw new RepositoryError("invalid-data");
      const requestSignature = signature({ input: parsed });
      return transaction(() => {
        const cached = receipt<OfficeAddressReceipt>(options.actorScope, "locations.confirm-office-address", options.idempotencyKey, requestSignature);
        if (cached) return checked(OfficeAddressReceiptSchema, cached);
        const current = read(); assertWriteVersion(options, current);
        const { reviewed: _reviewed, previewFingerprint, ...previewInput } = parsed;
        const { preview, target } = prepareOffice(previewInput, current);
        if (preview.previewFingerprint !== previewFingerprint) throw new RepositoryError("stale-version");
        const entry: OfficeAddressDecision = { id: `office-confirm_${randomUUID()}`, kind: "confirm", jobId: target.owner.id, listingId: target.listing.id, locationId: parsed.locationId,
          sourceLocation: target.sourceLocation, proposal: parsed.proposal, actorScope: options.actorScope, at: now(), revision: current.revision + 1, reason: parsed.reason };
        return commitOffice(current, entry, options, "locations.confirm-office-address", requestSignature, parsed.jobId);
      });
    },
    async revokeOfficeAddress(input: RevokeOfficeAddressInput, options: ReconciliationWriteOptions): Promise<OfficeAddressReceipt> {
      validateOptions(options); const parsed = checked(RevokeOfficeAddressInputSchema, input);
      if (options.expectedRevision !== parsed.expectedRevision) throw new RepositoryError("invalid-data");
      const requestSignature = signature({ input: parsed });
      return transaction(() => {
        const cached = receipt<OfficeAddressReceipt>(options.actorScope, "locations.revoke-office-address", options.idempotencyKey, requestSignature);
        if (cached) return checked(OfficeAddressReceiptSchema, cached);
        const current = read(); assertWriteVersion(options, current);
        const entries = officeDecisions(), target = entries.find(value => value.id === parsed.decisionId);
        if (!target || target.kind !== "confirm" || target.locationId !== parsed.locationId) throw new RepositoryError("not-found");
        if (target.actorScope !== options.actorScope) throw new RepositoryError("not-authorized");
        const job = current.jobs.find(value => value.id === aliasId(parsed.jobId));
        if (!job?.listingIds.includes(target.listingId)) throw new RepositoryError("not-found");
        if (entries.some(value => value.kind === "revoke" && value.targetDecisionId === target.id)) throw new RepositoryError("conflict");
        const entry: OfficeAddressDecision = { id: `office-revoke_${randomUUID()}`, kind: "revoke", jobId: target.jobId, listingId: target.listingId, locationId: target.locationId,
          actorScope: options.actorScope, at: now(), revision: current.revision + 1, reason: parsed.reason, targetDecisionId: target.id,
          sourceLocation: projectLocationConfirmations(baseSnapshot(current), locationDecisions()).locations.find(location => location.id === target.locationId)! };
        return commitOffice(current, entry, options, "locations.revoke-office-address", requestSignature, parsed.jobId);
      });
    },
    async previewCompanyControllerOverride(input: unknown): Promise<CompanyControllerOverridePreview> {
      const parsed = checked(PreviewCompanyControllerOverrideInputSchema, input);
      return transaction(() => {
        const current = read();
        if (current.revision !== parsed.expectedRevision) throw new RepositoryError("stale-version");
        const company = current.companies.find(c => c.id === parsed.companyId);
        if (!company) throw new RepositoryError("not-found");
        const obsIds = new Set(current.observations.map(o => o.id));
        if (parsed.proposal.evidence.some(ref => !obsIds.has(ref.observationId))) throw new RepositoryError("invalid-data");
        const proposedControllers = {
          value: parsed.proposal.controllers,
          evidence: parsed.proposal.evidence,
          method: "manual" as const,
          verification: "verified" as const,
          revision: company.ultimateControllers.revision + 1,
        };
        const simulatedOverride: CompanyManualOverride = {
          id: "ctrl-override-preview",
          field: "ultimateControllers",
          reason: parsed.proposal.reason,
          at: now(),
          actor: "preview",
          basedOnRevision: company.ultimateControllers.revision,
          value: proposedControllers,
        };
        const simulatedCompany: Company = {
          ...company,
          manualOverrides: [...company.manualOverrides, simulatedOverride],
        };
        const classification = classifyCompany(simulatedCompany);
        const colorMatch = resolveCompanyColor(simulatedCompany);
        const previewFingerprint = signature({ input: parsed, companyId: parsed.companyId, controllers: parsed.proposal.controllers });
        return checked(CompanyControllerOverridePreviewSchema, {
          companyId: parsed.companyId,
          previewFingerprint,
          proposedControllers,
          classification,
          colorMatch,
        });
      });
    },
    async confirmCompanyControllerOverride(input: ConfirmCompanyControllerOverrideInput, options: ReconciliationWriteOptions): Promise<CompanyControllerOverrideReceipt> {
      validateOptions(options);
      const parsed = checked(ConfirmCompanyControllerOverrideInputSchema, input);
      if (options.expectedRevision !== parsed.expectedRevision) throw new RepositoryError("invalid-data");
      const requestSignature = signature({ input: parsed });
      return transaction(() => {
        const cached = receipt<CompanyControllerOverrideReceipt>(options.actorScope, "companies.confirm-controller-override", options.idempotencyKey, requestSignature);
        if (cached) return checked(CompanyControllerOverrideReceiptSchema, cached);
        options.throwIfCancelled?.();
        const current = read();
        assertWriteVersion(options, current);
        const company = current.companies.find(c => c.id === parsed.companyId);
        if (!company) throw new RepositoryError("not-found");
        const obsIds = new Set(current.observations.map(o => o.id));
        if (parsed.proposal.evidence.some(ref => !obsIds.has(ref.observationId))) throw new RepositoryError("invalid-data");
        const previewInput = { companyId: parsed.companyId, expectedRevision: parsed.expectedRevision, proposal: parsed.proposal };
        const previewFingerprint = signature({ input: previewInput, companyId: parsed.companyId, controllers: parsed.proposal.controllers });
        if (previewFingerprint !== parsed.previewFingerprint) throw new RepositoryError("stale-version");
        const nextRevision = current.revision + 1;
        const decisionId = `ctrl-override_${randomUUID()}`;
        const override: CompanyManualOverride = {
          id: decisionId,
          field: "ultimateControllers",
          reason: parsed.proposal.reason,
          at: now(),
          actor: options.actorScope,
          basedOnRevision: company.ultimateControllers.revision,
          value: {
            value: parsed.proposal.controllers,
            evidence: parsed.proposal.evidence,
            method: "manual",
            verification: "verified",
            revision: company.ultimateControllers.revision + 1,
          },
        };
        const updatedCompany: Company = {
          ...company,
          manualOverrides: [...company.manualOverrides, override],
        };
        const nextDataset: AtlasDataset = {
          ...current,
          revision: nextRevision,
          companies: current.companies.map(c => c.id === company.id ? updatedCompany : c),
        };
        write(checked(AtlasDatasetSchema, nextDataset));
        const classification = classifyCompany(updatedCompany);
        const colorMatch = resolveCompanyColor(updatedCompany);
        const result: CompanyControllerOverrideReceipt = {
          ok: true,
          revision: nextRevision,
          decisionId,
          activeDecisionId: decisionId,
          company: updatedCompany,
          classification,
          colorMatch,
        };
        saveReceipt(options.actorScope, "companies.confirm-controller-override", options.idempotencyKey, requestSignature, result);
        return result;
      });
    },
    async revokeCompanyControllerOverride(input: RevokeCompanyControllerOverrideInput, options: ReconciliationWriteOptions): Promise<CompanyControllerOverrideReceipt> {
      validateOptions(options);
      const parsed = checked(RevokeCompanyControllerOverrideInputSchema, input);
      if (options.expectedRevision !== parsed.expectedRevision) throw new RepositoryError("invalid-data");
      const requestSignature = signature({ input: parsed });
      return transaction(() => {
        const cached = receipt<CompanyControllerOverrideReceipt>(options.actorScope, "companies.revoke-controller-override", options.idempotencyKey, requestSignature);
        if (cached) return checked(CompanyControllerOverrideReceiptSchema, cached);
        options.throwIfCancelled?.();
        const current = read();
        assertWriteVersion(options, current);
        const company = current.companies.find(c => c.id === parsed.companyId);
        if (!company) throw new RepositoryError("not-found");
        const targetOverride = company.manualOverrides.find(o => o.id === parsed.decisionId);
        if (!targetOverride) throw new RepositoryError("not-found");
        if (targetOverride.actor && targetOverride.actor !== options.actorScope) throw new RepositoryError("not-authorized");
        const nextRevision = current.revision + 1;
        const updatedCompany: Company = {
          ...company,
          manualOverrides: company.manualOverrides.filter(o => o.id !== parsed.decisionId),
        };
        const nextDataset: AtlasDataset = {
          ...current,
          revision: nextRevision,
          companies: current.companies.map(c => c.id === company.id ? updatedCompany : c),
        };
        write(checked(AtlasDatasetSchema, nextDataset));
        const classification = classifyCompany(updatedCompany);
        const colorMatch = resolveCompanyColor(updatedCompany);
        const result: CompanyControllerOverrideReceipt = {
          ok: true,
          revision: nextRevision,
          decisionId: parsed.decisionId,
          company: updatedCompany,
          classification,
          colorMatch,
        };
        saveReceipt(options.actorScope, "companies.revoke-controller-override", options.idempotencyKey, requestSignature, result);
        return result;
      });
    },
    async previewCompensationAudit(input: unknown): Promise<CompensationAuditPreview> {
      const parsed = checked(PreviewCompensationAuditInputSchema, input);
      return transaction(() => {
        const current = read();
        if (current.revision !== parsed.expectedRevision) throw new RepositoryError("stale-version");
        const canonicalJobId = aliasId(parsed.jobId);
        const job = current.jobs.find(j => j.id === canonicalJobId);
        if (!job || !job.compensationIds.includes(parsed.compensationId)) throw new RepositoryError("not-found");
        const target = current.compensations.find(c => c.id === parsed.compensationId);
        if (!target) throw new RepositoryError("not-found");
        const obsIds = new Set(current.observations.map(o => o.id));
        if (parsed.proposal.evidence.some(ref => !obsIds.has(ref.observationId))) throw new RepositoryError("invalid-data");
        const proposed: Compensation = checked(CompensationSchema, {
          id: target.id,
          locationIds: target.locationIds,
          raw: target.raw,
          currency: parsed.proposal.currency,
          period: parsed.proposal.period,
          min: parsed.proposal.min,
          max: parsed.proposal.max,
          tax: parsed.proposal.tax,
          kind: parsed.proposal.kind,
          monthsPerYear: parsed.proposal.monthsPerYear,
          hoursPerYear: parsed.proposal.hoursPerYear,
          daysPerYear: parsed.proposal.daysPerYear,
          weeksPerYear: parsed.proposal.weeksPerYear,
          verification: "verified",
          evidence: parsed.proposal.evidence,
        });
        const normalized = normalizeCompensation(proposed);
        const previewFingerprint = signature({ input: parsed, target });
        return checked(CompensationAuditPreviewSchema, {
          jobId: parsed.jobId,
          compensationId: parsed.compensationId,
          previewFingerprint,
          proposed,
          normalized,
        });
      });
    },
    async confirmCompensationAudit(input: ConfirmCompensationAuditInput, options: ReconciliationWriteOptions): Promise<CompensationAuditReceipt> {
      validateOptions(options);
      const parsed = checked(ConfirmCompensationAuditInputSchema, input);
      if (options.expectedRevision !== parsed.expectedRevision) throw new RepositoryError("invalid-data");
      const requestSignature = signature({ input: parsed });
      return transaction(() => {
        const cached = receipt<CompensationAuditReceipt>(options.actorScope, "compensations.confirm-audit", options.idempotencyKey, requestSignature);
        if (cached) return checked(CompensationAuditReceiptSchema, cached);
        options.throwIfCancelled?.();
        const current = read();
        assertWriteVersion(options, current);
        const canonicalJobId = aliasId(parsed.jobId);
        const job = current.jobs.find(j => j.id === canonicalJobId);
        if (!job || !job.compensationIds.includes(parsed.compensationId)) throw new RepositoryError("not-found");
        const target = current.compensations.find(c => c.id === parsed.compensationId);
        if (!target) throw new RepositoryError("not-found");
        const obsIds = new Set(current.observations.map(o => o.id));
        if (parsed.proposal.evidence.some(ref => !obsIds.has(ref.observationId))) throw new RepositoryError("invalid-data");
        const previewInput = { jobId: parsed.jobId, compensationId: parsed.compensationId, expectedRevision: parsed.expectedRevision, proposal: parsed.proposal };
        const previewFingerprint = signature({ input: previewInput, target });
        if (previewFingerprint !== parsed.previewFingerprint) throw new RepositoryError("stale-version");
        const nextRevision = current.revision + 1;
        const decisionId = `comp-audit_${randomUUID()}`;
        const updatedCompensation: Compensation = checked(CompensationSchema, {
          id: target.id,
          locationIds: target.locationIds,
          raw: target.raw,
          currency: parsed.proposal.currency,
          period: parsed.proposal.period,
          min: parsed.proposal.min,
          max: parsed.proposal.max,
          tax: parsed.proposal.tax,
          kind: parsed.proposal.kind,
          monthsPerYear: parsed.proposal.monthsPerYear,
          hoursPerYear: parsed.proposal.hoursPerYear,
          daysPerYear: parsed.proposal.daysPerYear,
          weeksPerYear: parsed.proposal.weeksPerYear,
          verification: "verified",
          evidence: parsed.proposal.evidence,
        });
        const normalized = normalizeCompensation(updatedCompensation);
        const nextDataset: AtlasDataset = {
          ...current,
          revision: nextRevision,
          compensations: current.compensations.map(c => c.id === target.id ? updatedCompensation : c),
        };
        write(checked(AtlasDatasetSchema, nextDataset));
        const result: CompensationAuditReceipt = {
          ok: true,
          revision: nextRevision,
          decisionId,
          activeDecisionId: decisionId,
          compensation: updatedCompensation,
          normalized,
        };
        saveReceipt(options.actorScope, "compensations.confirm-audit", options.idempotencyKey, requestSignature, result);
        return result;
      });
    },
    async revokeCompensationAudit(input: RevokeCompensationAuditInput, options: ReconciliationWriteOptions): Promise<CompensationAuditReceipt> {
      validateOptions(options);
      const parsed = checked(RevokeCompensationAuditInputSchema, input);
      if (options.expectedRevision !== parsed.expectedRevision) throw new RepositoryError("invalid-data");
      const requestSignature = signature({ input: parsed });
      return transaction(() => {
        const cached = receipt<CompensationAuditReceipt>(options.actorScope, "compensations.revoke-audit", options.idempotencyKey, requestSignature);
        if (cached) return checked(CompensationAuditReceiptSchema, cached);
        options.throwIfCancelled?.();
        const current = read();
        assertWriteVersion(options, current);
        const canonicalJobId = aliasId(parsed.jobId);
        const job = current.jobs.find(j => j.id === canonicalJobId);
        if (!job || !job.compensationIds.includes(parsed.compensationId)) throw new RepositoryError("not-found");
        const target = current.compensations.find(c => c.id === parsed.compensationId);
        if (!target) throw new RepositoryError("not-found");
        const nextRevision = current.revision + 1;
        const revertedCompensation: Compensation = checked(CompensationSchema, {
          ...target,
          verification: "unverified",
          evidence: [],
        });
        const normalized = normalizeCompensation(revertedCompensation);
        const nextDataset: AtlasDataset = {
          ...current,
          revision: nextRevision,
          compensations: current.compensations.map(c => c.id === target.id ? revertedCompensation : c),
        };
        write(checked(AtlasDatasetSchema, nextDataset));
        const result: CompensationAuditReceipt = {
          ok: true,
          revision: nextRevision,
          decisionId: parsed.decisionId,
          compensation: revertedCompensation,
          normalized,
        };
        saveReceipt(options.actorScope, "compensations.revoke-audit", options.idempotencyKey, requestSignature, result);
        return result;
      });
    },
    async previewLocationConfirmation(input: unknown): Promise<LocationConfirmationPreview> {
      const parsed = checked(PreviewLocationConfirmationInputSchema, input);
      return transaction(() => prepareLocation(parsed, read()).preview);
    },
    async confirmLocation(input: ConfirmLocationInput, options: ReconciliationWriteOptions): Promise<LocationConfirmationReceipt> {
      validateOptions(options); const parsed = checked(ConfirmLocationInputSchema, input);
      if (options.expectedRevision !== parsed.expectedRevision) throw new RepositoryError("invalid-data");
      const requestSignature = signature({ input: parsed });
      return transaction(() => {
        const cached = receipt<LocationConfirmationReceipt>(options.actorScope, "locations.confirm", options.idempotencyKey, requestSignature);
        if (cached) return checked(LocationConfirmationReceiptSchema, cached);
        const current = read(); assertWriteVersion(options, current);
        const { reviewed: _reviewed, previewFingerprint, ...previewInput } = parsed;
        const { preview, target, area } = prepareLocation(previewInput, current);
        if (preview.previewFingerprint !== previewFingerprint) throw new RepositoryError("stale-version");
        const entry: LocationConfirmationDecision = { id: `location-confirm_${randomUUID()}`, kind: "confirm", jobId: target.owner.id, listingId: target.listing.id, locationId: parsed.locationId, sourceLocation: target.original, area, actorScope: options.actorScope, at: now(), revision: current.revision + 1, reason: parsed.reason };
        return commitLocation(current, entry, options, "locations.confirm", requestSignature, parsed.jobId);
      });
    },
    async revokeLocationConfirmation(input: RevokeLocationConfirmationInput, options: ReconciliationWriteOptions): Promise<LocationConfirmationReceipt> {
      validateOptions(options); const parsed = checked(RevokeLocationConfirmationInputSchema, input);
      if (options.expectedRevision !== parsed.expectedRevision) throw new RepositoryError("invalid-data");
      const requestSignature = signature({ input: parsed });
      return transaction(() => {
        const cached = receipt<LocationConfirmationReceipt>(options.actorScope, "locations.revoke-confirmation", options.idempotencyKey, requestSignature);
        if (cached) return checked(LocationConfirmationReceiptSchema, cached);
        const current = read(); assertWriteVersion(options, current);
        const entries = locationDecisions(); const target = entries.find(value => value.id === parsed.decisionId);
        if (!target || target.kind !== "confirm" || target.locationId !== parsed.locationId) throw new RepositoryError("not-found");
        if (target.actorScope !== options.actorScope) throw new RepositoryError("not-authorized");
        const job = current.jobs.find(value => value.id === aliasId(parsed.jobId));
        if (!job?.listingIds.includes(target.listingId)) throw new RepositoryError("not-found");
        if (entries.some(value => value.kind === "revoke" && value.targetDecisionId === target.id)) throw new RepositoryError("conflict");
        const entry: LocationConfirmationDecision = { id: `location-revoke_${randomUUID()}`, kind: "revoke", jobId: target.jobId, listingId: target.listingId, locationId: target.locationId, actorScope: options.actorScope, at: now(), revision: current.revision + 1, reason: parsed.reason, targetDecisionId: target.id,
          sourceLocation: baseSnapshot(current).locations.find(location => location.id === target.locationId)! };
        return commitLocation(current, entry, options, "locations.revoke-confirmation", requestSignature, parsed.jobId);
      });
    },
    /** Recover a committed command before re-projecting against a newer index revision. */
    async findImportReceipt(options: ImportOptions & { requestFingerprint: string }): Promise<ImportReceipt | undefined> {
      validateOptions(options);
      const requestSignature = signature({ requestFingerprint: options.requestFingerprint, expectedRevision: options.expectedRevision, runId: options.runId });
      return transaction(() => {
        const cached = receipt<ImportReceipt>(options.actorScope, "dataset.import", options.idempotencyKey, requestSignature);
        return cached ? checked(ImportReceiptSchema, cached) : undefined;
      });
    },
    async importSnapshot(input: unknown, importOptions: ImportOptions): Promise<ImportReceipt> {
      validateOptions(importOptions);
      const incoming = checked(AtlasDatasetObjectSchema, input);
      if (incoming.locations.some(location => location.userResolution || location.officeResolution)) throw new RepositoryError("conflict");
      const requestSignature = signature({ ...(importOptions.requestFingerprint === undefined ? { input: incoming } : { requestFingerprint: importOptions.requestFingerprint }), expectedRevision: importOptions.expectedRevision, runId: importOptions.runId });
      return transaction(() => {
        const cached = receipt<ImportReceipt>(importOptions.actorScope, "dataset.import", importOptions.idempotencyKey, requestSignature);
        if (cached) return checked(ImportReceiptSchema, cached);
        const slice = projectionSlice.read({ incoming });
        const { current, base } = slice;
        if (importOptions.expectedRevision !== undefined && current.revision !== importOptions.expectedRevision) throw new RepositoryError("stale-version");
        const run = importOptions.runId ? currentRun(importOptions.runId, importOptions.actorScope) : undefined;
        const nextBase = merged(base, incoming);
        if (run) validateRunDelta(incoming, nextBase, base, run);
        verifyContentHashes(nextBase);
        const priorOffice = slice.offices;
        const inactiveOffice = new Set(priorOffice.flatMap(entry => entry.kind === "revoke" ? [entry.targetDecisionId] : entry.kind === "invalidate" ? entry.targetDecisionIds : []));
        const sourceBasis = (dataset: AtlasDataset, decision: Extract<OfficeAddressDecision, { kind: "confirm" }>) => ({
          location: dataset.locations.find(value => value.id === decision.locationId),
          listingStillUsesLocation: Boolean(dataset.listings.find(value => value.id === decision.listingId)?.locationIds?.includes(decision.locationId)),
          jobStillUsesLocation: Boolean(dataset.jobs.find(value => value.id === decision.jobId)?.locationIds.includes(decision.locationId)),
          workMode: dataset.jobs.find(value => value.id === decision.jobId)?.workMode,
        });
        const invalidatedIds = priorOffice.filter((entry): entry is Extract<OfficeAddressDecision, { kind: "confirm" }> => entry.kind === "confirm" && !inactiveOffice.has(entry.id))
          .filter(entry => !same(sourceBasis(base, entry), sourceBasis(nextBase, entry))).map(entry => entry.id);
        const invalidation: OfficeAddressDecision | undefined = invalidatedIds.length ? { id: `office-invalidate_${randomUUID()}`, kind: "invalidate", actorScope: importOptions.actorScope,
          at: now(), revision: current.revision + 1, reason: "source-changed", targetDecisionIds: invalidatedIds } : undefined;
        if (invalidation) nextBase.revision = invalidation.revision;
        const projection = canonicalProjection(nextBase, current, slice.merges, now(), slice.locations, [...priorOffice, ...(invalidation ? [invalidation] : [])]);
        const next = projection.dataset;
        const changed = TABLES.some((table) => !same(base[table], nextBase[table])) || TABLES.some((table) => !same(current[table], next[table]));
        next.revision = current.revision + Number(changed);
        const targets = new Set(incoming.jobs.map((job) => projection.aliases.find((alias) => alias.jobId === job.id)!.canonicalJobId));
        const effectiveIncoming = { ...incoming, jobs: next.jobs.filter((job) => targets.has(job.id)) };
        const result: ImportReceipt = { ok: true, revision: next.revision, jobIds: effectiveIncoming.jobs.map((job) => job.id), snapshotIds: incoming.snapshots.map((snapshot) => snapshot.id), counts: counts(current, next, effectiveIncoming) };
        if (changed) {
          if (invalidation) db.prepare("INSERT INTO office_decisions VALUES (?,?,?)").run(invalidation.id, invalidation.revision, json(invalidation));
          // Only an incoming origin can change the base tables. Manual overlays
          // and merges are projected into effective tables, never back into base.
          const jobIds = new Set(incoming.jobs.map(job => job.id)), locationIds = new Set(incoming.locations.map(location => location.id));
          writeBaseJobs(nextBase.jobs.filter(job => jobIds.has(job.id))); writeBaseLocations(nextBase.locations.filter(location => locationIds.has(location.id)));
          write(next, false, new Set(current.jobs.map(job => job.id))); saveAliases(projection.aliases, next.revision, now(), undefined, true);
          enqueueEnrichment(base, nextBase, importOptions.actorScope);
        }
        saveReceipt(importOptions.actorScope, "dataset.import", importOptions.idempotencyKey, requestSignature, result);
        return result;
      });
    },
    async listMergeCandidates(options: { limit?: number; requisitionLinks?: readonly OfficialRequisitionLink[] } = {}) {
      const state = transaction(() => ({ dataset: read(), decisions: decisions() }));
      const revoked = new Set(state.decisions.filter((decision) => decision.kind === "revoke").map((decision) => decision.targetDecisionId));
      const rejected = new Set(state.decisions.filter((decision): decision is Extract<MergeDecision, { kind: "reject" }> => decision.kind === "reject" && !revoked.has(decision.id)).map((decision) => JSON.stringify([decision.leftJobId, decision.rightJobId].sort(compareIds))));
      return (await findMergeCandidates(state.dataset, options)).filter((candidate) => !rejected.has(JSON.stringify([candidate.leftJobId, candidate.rightJobId].sort(compareIds))));
    },
    async listMergeDecisions(): Promise<MergeDecision[]> { return transaction(decisions); },
    /** Public review composition reads aliases, evidence and decisions under one SQLite version. */
    async readReconciliationState() {
      return transaction(() => {
        const stored = read(), officeEntries = officeDecisions();
        const dataset = projectPublicOfficeLocations(stored, officeEntries);
        const originDataset = projectPublicOfficeLocations(projectOfficeAddressConfirmations(projectLocationConfirmations(baseSnapshot(stored), locationDecisions()), officeEntries), officeEntries);
        return { dataset, originDataset, decisions: decisions(), aliases: (db.prepare("SELECT job_id,canonical_job_id FROM job_aliases ORDER BY job_id").all() as Array<{ job_id: string; canonical_job_id: string }>).map(row => ({ jobId: row.job_id, canonicalJobId: row.canonical_job_id })) };
      });
    },
    /** Recover a lost reviewed-command receipt before checking its now-stale preview revision. */
    async findReconciliationReceipt(tool: "jobs.merge" | "jobs.reject-merge" | "jobs.revoke-merge", input: unknown, writeOptions: ReconciliationWriteOptions): Promise<ReconciliationReceipt | undefined> {
      validateOptions(writeOptions);
      const parsed = tool === "jobs.merge" ? checked(ConfirmMergeInputSchema, input) : tool === "jobs.reject-merge" ? checked(RejectMergeInputSchema, input) : checked(RevokeMergeInputSchema, input);
      return transaction(() => {
        const saved = receipt<ReconciliationReceipt>(writeOptions.actorScope, tool, writeOptions.idempotencyKey, reconciliationSignature(parsed, writeOptions));
        return saved ? checked(ReconciliationReceiptSchema, saved) : undefined;
      });
    },
    async resolveJobId(jobId: string, options: { atRevision?: number } = {}) {
      checked(EntityIdSchema, jobId);
      if (options.atRevision !== undefined && (!Number.isSafeInteger(options.atRevision) || options.atRevision < 0)) throw new RepositoryError("invalid-data");
      return transaction(() => {
        const history = (db.prepare("SELECT document FROM job_alias_history WHERE job_id=? ORDER BY revision,sequence").all(jobId) as Array<{ document: string }>).map((row) => checked(JobAliasEventSchema, JSON.parse(row.document)));
        const canonicalJobId = options.atRevision === undefined ? aliasId(jobId) : history.filter((event) => event.revision <= options.atRevision!).at(-1)?.canonicalJobId;
        if (!canonicalJobId) return undefined;
        return { requestedJobId: jobId, canonicalJobId, snapshotRevision: revision(), history };
      });
    },
    async readReconciliationConflicts(jobId: string) {
      checked(EntityIdSchema, jobId);
      return transaction(() => {
        const current = read(); const canonicalJobId = aliasId(jobId);
        if (!canonicalJobId) throw new RepositoryError("not-found");
        const projection = projectReconciliation(baseSnapshot(current), decisions());
        return projection.conflicts.find((group) => group.canonicalJobId === canonicalJobId) ?? { canonicalJobId, summaryJobId: canonicalJobId, conflicts: [], decisionIds: [] };
      });
    },
    async mergeJobs(input: ConfirmMergeInput, writeOptions: ReconciliationWriteOptions): Promise<ReconciliationReceipt> {
      validateOptions(writeOptions); const parsed = checked(ConfirmMergeInputSchema, input);
      const requestSignature = reconciliationSignature(parsed, writeOptions);
      const state = transaction(() => {
        const cached = receipt<ReconciliationReceipt>(writeOptions.actorScope, "jobs.merge", writeOptions.idempotencyKey, requestSignature);
        if (cached) return { cached: checked(ReconciliationReceiptSchema, cached) };
        const current = read(); assertWriteVersion(writeOptions, current);
        const targetJobId = aliasId(parsed.targetJobId); const sourceJobId = aliasId(parsed.sourceJobId);
        if (!targetJobId || !sourceJobId) throw new RepositoryError("not-found");
        if (targetJobId === sourceJobId) throw new RepositoryError("conflict");
        return { current, targetJobId, sourceJobId };
      });
      if (state.cached) return state.cached;
      const candidate = await explainMergeCandidate(state.current!, { leftJobId: state.targetJobId!, rightJobId: state.sourceJobId!, requisitionLinks: parsed.requisitionLinks });
      if (candidate.requiresCompanyConfirmation && !parsed.companyIdentityConfirmed) throw new RepositoryError("conflict");
      return transaction(() => {
        const cached = receipt<ReconciliationReceipt>(writeOptions.actorScope, "jobs.merge", writeOptions.idempotencyKey, requestSignature);
        if (cached) return checked(ReconciliationReceiptSchema, cached);
        writeOptions.throwIfCancelled?.();
        const current = read(); assertWriteVersion(writeOptions, current);
        const entry: MergeDecision = { id: `merge_${randomUUID()}`, kind: "merge", at: now(), revision: current.revision + 1, actorScope: writeOptions.actorScope, reason: parsed.reason, targetJobId: state.targetJobId!, sourceJobId: state.sourceJobId!, companyIdentityConfirmed: parsed.companyIdentityConfirmed, candidate };
        return commitDecision(current, entry, writeOptions, "jobs.merge", requestSignature);
      });
    },
    async rejectMerge(input: { leftJobId: string; rightJobId: string; reason: string }, writeOptions: ReconciliationWriteOptions): Promise<ReconciliationReceipt> {
      validateOptions(writeOptions); const parsed = checked(RejectMergeInputSchema, input);
      const requestSignature = reconciliationSignature(parsed, writeOptions);
      const state = transaction(() => {
        const cached = receipt<ReconciliationReceipt>(writeOptions.actorScope, "jobs.reject-merge", writeOptions.idempotencyKey, requestSignature);
        if (cached) return { cached: checked(ReconciliationReceiptSchema, cached) };
        const current = read(); assertWriteVersion(writeOptions, current);
        const leftJobId = aliasId(parsed.leftJobId), rightJobId = aliasId(parsed.rightJobId);
        if (!leftJobId || !rightJobId) throw new RepositoryError("not-found");
        if (leftJobId === rightJobId) throw new RepositoryError("conflict");
        return { current, leftJobId, rightJobId };
      });
      if (state.cached) return state.cached;
      const candidate = await explainMergeCandidate(state.current!, { leftJobId: state.leftJobId!, rightJobId: state.rightJobId! });
      return transaction(() => {
        const cached = receipt<ReconciliationReceipt>(writeOptions.actorScope, "jobs.reject-merge", writeOptions.idempotencyKey, requestSignature);
        if (cached) return checked(ReconciliationReceiptSchema, cached);
        writeOptions.throwIfCancelled?.();
        const current = read(); assertWriteVersion(writeOptions, current);
        const entry: MergeDecision = { id: `merge-reject_${randomUUID()}`, kind: "reject", at: now(), revision: current.revision + 1, actorScope: writeOptions.actorScope, reason: parsed.reason, leftJobId: candidate.leftJobId, rightJobId: candidate.rightJobId, candidate };
        return commitDecision(current, entry, writeOptions, "jobs.reject-merge", requestSignature);
      });
    },
    async revokeMerge(input: { decisionId: string; reason: string }, writeOptions: ReconciliationWriteOptions): Promise<ReconciliationReceipt> {
      validateOptions(writeOptions); const parsed = checked(RevokeMergeInputSchema, input);
      const requestSignature = reconciliationSignature(parsed, writeOptions);
      return transaction(() => {
        const cached = receipt<ReconciliationReceipt>(writeOptions.actorScope, "jobs.revoke-merge", writeOptions.idempotencyKey, requestSignature);
        if (cached) return checked(ReconciliationReceiptSchema, cached);
        writeOptions.throwIfCancelled?.();
        const current = read(); assertWriteVersion(writeOptions, current); const entries = decisions();
        const target = entries.find((entry) => entry.id === parsed.decisionId);
        if (!target) throw new RepositoryError("not-found");
        if (target.actorScope !== writeOptions.actorScope) throw new RepositoryError("not-authorized");
        if (target.kind === "revoke" || entries.some((entry) => entry.kind === "revoke" && entry.targetDecisionId === target.id)) throw new RepositoryError("conflict");
        const entry: MergeDecision = { id: `merge-revoke_${randomUUID()}`, kind: "revoke", at: now(), revision: current.revision + 1, actorScope: writeOptions.actorScope, reason: parsed.reason, targetDecisionId: target.id };
        return commitDecision(current, entry, writeOptions, "jobs.revoke-merge", requestSignature);
      });
    },
    /** Explicit trusted configuration action, kept separate from source observations/imports. */
    async registerSource(input: unknown, registerOptions: Omit<ImportOptions, "runId">): Promise<ImportReceipt> {
      validateOptions(registerOptions);
      const source = checked(SourceDefinitionSchema, input);
      const requestSignature = signature({ source, expectedRevision: registerOptions.expectedRevision });
      return transaction(() => {
        const cached = receipt<ImportReceipt>(registerOptions.actorScope, "sources.register", registerOptions.idempotencyKey, requestSignature);
        if (cached) return checked(ImportReceiptSchema, cached);
        const current = read();
        if (registerOptions.expectedRevision !== undefined && current.revision !== registerOptions.expectedRevision) throw new RepositoryError("stale-version");
        const old = current.sources.find((value) => value.sourceId === source.sourceId);
        const changed = !old || !same(old, source);
        if (old && changed && registerOptions.expectedRevision === undefined) throw new RepositoryError("stale-version");
        if (changed) {
          current.sources = [...current.sources.filter((value) => value.sourceId !== source.sourceId), source].sort((a, b) => compareIds(a.sourceId, b.sourceId));
          current.revision++;
          write(checked(AtlasDatasetSchema, current));
          // An in-flight fetch with the old endpoint/policy cannot commit after a configuration edit.
          const active = db.prepare("SELECT document FROM runs WHERE source_id=? AND status='running'").all(source.sourceId) as Array<{ document: string }>;
          for (const row of active) saveRun({ ...checked(SyncRunSchema, JSON.parse(row.document)), status: "superseded", finishedAt: now(), summary: { partial: true, errorCode: "source-config-changed" } });
        }
        const result: ImportReceipt = { ok: true, revision: current.revision, jobIds: [], snapshotIds: [], counts: { newJobs: 0, updatedJobs: 0, unchangedJobs: 0, newListings: 0, newObservations: 0, newSnapshots: 0 } };
        saveReceipt(registerOptions.actorScope, "sources.register", registerOptions.idempotencyKey, requestSignature, result); return result;
      });
    },
    async startRun(input: StartRunOptions): Promise<SyncRun> {
      checked(ActorScopeSchema, input.actorScope); checked(IdempotencyKeySchema, input.idempotencyKey);
      const scope = checked(RunScopeSchema, input.scope);
      const requestFingerprint = input.requestFingerprint === undefined ? undefined : checked(RequestFingerprintSchema, input.requestFingerprint);
      // Effective limits depend on editable source policy. Request identity uses the full
      // normalized caller input when the trusted application supplies its fingerprint.
      const requestSignature = signature(requestFingerprint === undefined ? { sourceId: input.sourceId, scope } : { sourceId: input.sourceId, requestFingerprint });
      return transaction(() => {
        const cached = receipt<SyncRun>(input.actorScope, "runs.start", input.idempotencyKey, requestSignature);
        if (cached) {
          const current = runById(checked(SyncRunSchema, cached).runId);
          if (!current) throw new RepositoryError("stale-version");
          return current;
        }
        const sourceRow = db.prepare("SELECT document FROM sources WHERE id=?").get(input.sourceId) as { document: string } | undefined;
        if (!sourceRow) throw new RepositoryError("not-found");
        const source = checked(SourceDefinitionSchema, JSON.parse(sourceRow.document));
        const latestRow = db.prepare("SELECT document FROM runs WHERE source_id=? ORDER BY generation DESC LIMIT 1").get(input.sourceId) as { document: string } | undefined;
        const startedAt = now();
        if (latestRow && Date.parse(startedAt) - Date.parse(checked(SyncRunSchema, JSON.parse(latestRow.document)).startedAt) < source.refreshPolicy.minIntervalSeconds * 1000) throw new RepositoryError("rate-limited");
        const previous = db.prepare("SELECT document FROM runs WHERE source_id=? AND status='running'").all(input.sourceId) as Array<{ document: string }>;
        for (const row of previous) saveRun({ ...checked(SyncRunSchema, JSON.parse(row.document)), status: "superseded", finishedAt: now() });
        const oldGeneration = db.prepare("SELECT generation FROM source_generations WHERE source_id=?").get(input.sourceId) as { generation: number } | undefined;
        const generation = (oldGeneration?.generation ?? 0) + 1;
        db.prepare("INSERT INTO source_generations VALUES (?,?) ON CONFLICT(source_id) DO UPDATE SET generation=excluded.generation").run(input.sourceId, generation);
        const run: SyncRun = { runId: `run_${randomUUID()}`, sourceId: input.sourceId, actorScope: input.actorScope, generation, scope, ...(requestFingerprint === undefined ? {} : { requestFingerprint }), status: "running", startedAt };
        saveRun(run); saveReceipt(input.actorScope, "runs.start", input.idempotencyKey, requestSignature, run); return run;
      });
    },
    /** Resolve durable ownership before consulting a source's current availability or policy. */
    async findRunByRequest(input: FindRunByRequestOptions): Promise<SyncRun | undefined> {
      checked(ActorScopeSchema, input.actorScope); checked(IdempotencyKeySchema, input.idempotencyKey);
      const requestFingerprint = checked(RequestFingerprintSchema, input.requestFingerprint);
      return transaction(() => {
        const row = db.prepare("SELECT signature,response FROM receipts WHERE actor_scope=? AND tool='runs.start' AND idempotency_key=?").get(input.actorScope, input.idempotencyKey) as { signature: string; response: string } | undefined;
        if (!row) return undefined;
        const stored = checked(SyncRunSchema, JSON.parse(row.response));
        if (stored.actorScope !== input.actorScope || stored.requestFingerprint !== requestFingerprint
          || row.signature !== signature({ sourceId: stored.sourceId, requestFingerprint })) throw new RepositoryError("idempotency-conflict");
        const current = runById(stored.runId);
        if (!current) throw new RepositoryError("stale-version");
        if (current.actorScope !== stored.actorScope || current.sourceId !== stored.sourceId || current.requestFingerprint !== requestFingerprint) throw new RepositoryError("idempotency-conflict");
        return current;
      });
    },
    async getRun(runId: string) { return runById(runId); },
    async listRuns(): Promise<SyncRun[]> { ensureOpen(); return (db.prepare("SELECT document FROM runs ORDER BY rowid DESC").all() as Array<{ document: string }>).map((row) => checked(SyncRunSchema, JSON.parse(row.document))); },
    async assertRunCurrent(runId: string, actorScope?: string) { return currentRun(runId, actorScope); },
    /** Invoke once after the service acquires exclusive process ownership, never on each DB open. */
    async recoverInterruptedRuns(): Promise<{ recovered: number }> {
      return transaction(() => {
        for (const task of enrichmentTasks()) if (task.state === "running") saveEnrichmentTask(releaseEnrichment(task, "pending", now()));
        const interrupted = db.prepare("SELECT document FROM runs WHERE status='running'").all() as Array<{ document: string }>;
        for (const row of interrupted) saveRun({ ...checked(SyncRunSchema, JSON.parse(row.document)), status: "failed", finishedAt: now(), summary: { errorCode: "service-restarted", partial: true } });
        return { recovered: interrupted.length };
      });
    },
    async cancelRun(runId: string, input: { actorScope: string }): Promise<SyncRun> {
      checked(ActorScopeSchema, input.actorScope);
      return transaction(() => {
        const run = runById(runId);
        if (!run) throw new RepositoryError("not-found");
        if (run.actorScope !== input.actorScope) throw new RepositoryError("not-authorized");
        if (run.status === "cancelled") return run;
        currentRun(runId, input.actorScope);
        const cancelled: SyncRun = { ...run, status: "cancelled", finishedAt: now() }; saveRun(cancelled); return cancelled;
      });
    },
    async finishRun(runId: string, input: { actorScope: string; status: "completed" | "partial" | "failed"; summary?: PublicRunSummary }): Promise<SyncRun> {
      checked(ActorScopeSchema, input.actorScope);
      if (!["completed", "partial", "failed"].includes(input.status)) throw new RepositoryError("invalid-data");
      const summary = input.summary === undefined ? undefined : checked(PublicRunSummarySchema, input.summary);
      return transaction(() => {
        const run = currentRun(runId, input.actorScope);
        const finished: SyncRun = { ...run, status: input.status, finishedAt: now(), ...(summary ? { summary } : {}) }; saveRun(finished); return finished;
      });
    },
    async saveDiscoveryLeads(input: readonly DiscoveryLead[], importOptions: Omit<ImportOptions, "expectedRevision">): Promise<DiscoveryLeadReceipt> {
      validateOptions(importOptions);
      if (!Array.isArray(input) || input.length > 100_000) throw new RepositoryError("invalid-data");
      const leads = input.map((lead) => checked(DiscoveryLeadSchema, lead));
      if (new Set(leads.map((lead) => lead.id)).size !== leads.length) throw new RepositoryError("conflict");
      const requestSignature = signature({ leads, runId: importOptions.runId });
      return transaction(() => {
        const cached = receipt<DiscoveryLeadReceipt>(importOptions.actorScope, "leads.save", importOptions.idempotencyKey, requestSignature);
        if (cached) return checked(DiscoveryLeadReceiptSchema, cached);
        const run = importOptions.runId ? currentRun(importOptions.runId, importOptions.actorScope) : undefined;
        let changed = false;
        for (const lead of leads) {
          if (run && lead.sourceId !== run.sourceId) throw new RepositoryError("conflict");
          if (!db.prepare("SELECT id FROM sources WHERE id=?").get(lead.sourceId)) throw new RepositoryError("invalid-data");
          const row = db.prepare("SELECT source_id,document FROM discovery_leads WHERE id=?").get(lead.id) as { source_id: string; document: string } | undefined;
          if (row && (row.source_id !== lead.sourceId || Date.parse((JSON.parse(row.document) as DiscoveryLead).observedAt) > Date.parse(lead.observedAt))) throw new RepositoryError("conflict");
          if (row && same(JSON.parse(row.document), lead)) continue;
          changed = true;
          db.prepare("INSERT INTO discovery_leads VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document").run(lead.id, lead.sourceId, json(lead));
        }
        const nextRevision = revision() + Number(changed);
        if (changed) { db.prepare("UPDATE metadata SET value=? WHERE key='revision'").run(String(nextRevision)); datasetSync.finish(nextRevision); }
        const result: DiscoveryLeadReceipt = { ok: true, revision: nextRevision, leadIds: leads.map((lead) => lead.id) };
        saveReceipt(importOptions.actorScope, "leads.save", importOptions.idempotencyKey, requestSignature, result); return result;
      });
    },
    async listDiscoveryLeads(): Promise<DiscoveryLead[]> {
      ensureOpen(); return (db.prepare("SELECT document FROM discovery_leads ORDER BY id").all() as Array<{ document: string }>).map((row) => checked(DiscoveryLeadSchema, JSON.parse(row.document)));
    },
    async candidateIds(input: CandidateQuery = {}): Promise<CandidateResult> {
      const dataset = read();
      let hits = dataset.jobs.map((job) => job.id);
      if (input.search?.trim()) {
        const words = normalizeSearchText(input.search).split(" ").filter(Boolean);
        const expression = words.map((word) => `"${word.replace(/"/g, '""')}"*`).join(" OR ");
        hits = expression ? (db.prepare("SELECT job_id FROM jobs_fts WHERE jobs_fts MATCH ?").all(expression) as Array<{ job_id: string }>).map((row) => row.job_id) : [];
      }
      if (input.viewport) {
        const [west, south, east, north] = input.viewport;
        if (![west, south, east, north].every(Number.isFinite) || west < -180 || west > 180 || east < -180 || east > 180 || south < -90 || north > 90 || south > north) throw new RepositoryError("invalid-data");
        const sql = `SELECT DISTINCT jl.job_id FROM location_rtree r JOIN location_rtree_ids li ON li.rid=r.rid JOIN job_locations jl ON jl.location_id=li.location_id WHERE r.max_lat>=? AND r.min_lat<=? AND ${west <= east ? "r.max_lon>=? AND r.min_lon<=?" : "(r.max_lon>=? OR r.min_lon<=?)"}`;
        const geoHits = new Set((db.prepare(sql).all(south, north, west, east) as Array<{ job_id: string }>).map((row) => row.job_id));
        hits = hits.filter((id) => geoHits.has(id));
      }
      // FTS token/prefix and RTree points do not cover all fuzzy aliases/unknown-location modes.
      // Expose useful indexed hits while returning a proven safe superset for actual filtering.
      return { jobIds: dataset.jobs.map((job) => job.id), indexedHits: [...new Set(hits)].sort(), exact: false, reason: "safe-superset", snapshotVersion: dataset.revision };
    },
    async backup(): Promise<RepositoryBackup> {
      ensureOpen();
      return transaction(() => {
        const dataset = read();
        const runs = (db.prepare("SELECT document FROM runs ORDER BY id").all() as Array<{ document: string }>).map((row) => JSON.parse(row.document) as SyncRun);
        const receipts = (db.prepare("SELECT * FROM receipts ORDER BY actor_scope,tool,idempotency_key").all() as Array<{ actor_scope: string; tool: StoredReceipt["tool"]; idempotency_key: string; signature: string; response: string; created_at: string }>).map((row) => ({ actorScope: row.actor_scope, tool: row.tool, idempotencyKey: row.idempotency_key, signature: row.signature, response: JSON.parse(row.response) as StoredReceipt["response"], createdAt: row.created_at }));
        const leads = (db.prepare("SELECT document FROM discovery_leads ORDER BY id").all() as Array<{ document: string }>).map((row) => JSON.parse(row.document) as DiscoveryLead);
        const baseJobs = baseSnapshot(dataset).jobs;
        const aliasHistory = (db.prepare("SELECT document FROM job_alias_history ORDER BY sequence").all() as Array<{ document: string }>).map((row) => checked(JobAliasEventSchema, JSON.parse(row.document)));
        const jobVersions = (db.prepare("SELECT job_id,revision FROM job_versions ORDER BY job_id").all() as Array<{ job_id: string; revision: number }>).map((row) => ({ jobId: row.job_id, revision: row.revision }));
        return checked(RepositoryBackupSchema, { format: "better-me/job-repository", schemaVersion: REPOSITORY_SCHEMA_VERSION, createdAt: now(), dataset, runs, receipts, leads, baseJobs, baseLocations: baseSnapshot(dataset).locations, locationDecisions: locationDecisions(), officeDecisions: officeDecisions(), mergeDecisions: decisions(), aliasHistory, jobVersions, enrichmentTasks: enrichmentTasks() }, "invalid-backup");
      });
    },
    async restore(input: unknown, restoreOptions: Omit<ImportOptions, "runId"> & { expectedRevision: number }): Promise<ImportReceipt> {
      validateOptions(restoreOptions);
      const backup = checked(RepositoryBackupSchema, input, "invalid-backup");
      verifyContentHashes(backup.dataset, "invalid-backup");
      if (encoder.encode(json(backup)).byteLength > 128 * 1024 * 1024) throw new RepositoryError("invalid-backup");
      const baseJobs = backup.baseJobs ?? backup.dataset.jobs;
      const baseLocations = backup.baseLocations ?? backup.dataset.locations;
      const owners = new Map(baseJobs.flatMap((job) => job.listingIds.map((id) => [id, job.id] as const)));
      const restoredBase = checked(AtlasDatasetSchema, { ...backup.dataset, jobs: baseJobs, locations: baseLocations, listings: backup.dataset.listings.map((listing) => ({ ...listing, ...(owners.has(listing.id) ? { canonicalJobId: owners.get(listing.id) } : {}) })) }, "invalid-backup");
      const historicalLocationBasis = (event: { jobId: string; listingId: string; locationId: string }, sourceLocation: JobLocation): AtlasDataset => checked(AtlasDatasetSchema, {
        ...restoredBase, locations: restoredBase.locations.map(location => location.id === event.locationId ? sourceLocation : location),
        jobs: restoredBase.jobs.map(job => job.id === event.jobId ? { ...job, locationIds: union(job.locationIds, [event.locationId]) } : job),
        listings: restoredBase.listings.map(listing => listing.id === event.listingId ? { ...listing, locationIds: union(listing.locationIds ?? [], [event.locationId]) } : listing),
      }, "invalid-backup");
      const originIds = new Set(baseJobs.map((job) => job.id)); const decisionIds = new Set<string>(); const decisionRevisions = new Set<number>();
      if (backup.enrichmentTasks.some(task => !originIds.has(task.jobId)
        || task.id !== `enrichment_${signature({ actorScope: task.actorScope, kind: task.kind, jobId: task.jobId })}`
        || task.result && task.result.revision > backup.dataset.revision)) throw new RepositoryError("invalid-backup");
      const priorDecisions = new Map<string, MergeDecision>(); const revokedDecisions = new Set<string>(); let previousRevision = 0;
      for (const entry of backup.mergeDecisions) {
        if (entry.revision > backup.dataset.revision || decisionRevisions.has(entry.revision) || entry.revision <= previousRevision) throw new RepositoryError("invalid-backup");
        decisionRevisions.add(entry.revision);
        if (entry.kind === "merge" || entry.kind === "reject") {
          const left = entry.kind === "merge" ? entry.targetJobId : entry.leftJobId;
          const right = entry.kind === "merge" ? entry.sourceJobId : entry.rightJobId;
          if (left === right || !originIds.has(left) || !originIds.has(right)
            || !same([left, right].sort(compareIds), [entry.candidate.leftJobId, entry.candidate.rightJobId].sort(compareIds))
            || entry.candidate.snapshotRevision !== entry.revision - 1
            || entry.kind === "merge" && entry.candidate.requiresCompanyConfirmation && !entry.companyIdentityConfirmed) throw new RepositoryError("invalid-backup");
        } else {
          const target = priorDecisions.get(entry.targetDecisionId);
          if (!target || target.kind === "revoke" || target.actorScope !== entry.actorScope || revokedDecisions.has(target.id)) throw new RepositoryError("invalid-backup");
          revokedDecisions.add(target.id);
        }
        decisionIds.add(entry.id); priorDecisions.set(entry.id, entry); previousRevision = entry.revision;
      }
      if (backup.aliasHistory.some((event) => !originIds.has(event.jobId) || !originIds.has(event.canonicalJobId) || event.revision > backup.dataset.revision || event.decisionId && !decisionIds.has(event.decisionId))
        || backup.jobVersions.some((value) => !originIds.has(value.jobId))) throw new RepositoryError("invalid-backup");
      const lastAliases = new Map<string, JobAliasEvent>();
      for (const event of backup.aliasHistory) {
        const previous = lastAliases.get(event.jobId); const decision = event.decisionId ? priorDecisions.get(event.decisionId) : undefined;
        if (previous && previous.revision >= event.revision
          || decision && (decision.revision !== event.revision || decision.kind === "reject"
            || decision.kind === "revoke" && priorDecisions.get(decision.targetDecisionId)?.kind !== "merge")) throw new RepositoryError("invalid-backup");
        lastAliases.set(event.jobId, event);
      }
      let restoredProjection: ReturnType<typeof projectReconciliation>;
      try {
        for (const entry of backup.locationDecisions) {
          if (entry.revision > backup.dataset.revision || entry.revision < 1 || decisionRevisions.has(entry.revision)) throw new Error("invalid-location-revision");
          decisionRevisions.add(entry.revision);
          if (entry.kind === "confirm") {
            const { basis, countryCode, kind, region, city, district } = entry.area;
            const proposal = { countryCode, locationKind: kind, area: basis.kind === "china-catalog" ? { kind: basis.kind, provinceCode: basis.provinceCode, ...(basis.cityCode ? { cityCode: basis.cityCode } : {}), ...(basis.districtCode ? { districtCode: basis.districtCode } : {}) } : { kind: basis.kind, ...(region ? { region } : {}), ...(city ? { city } : {}), ...(district ? { district } : {}) } };
            if (!same(resolveLocationArea(proposal), entry.area)) throw new Error("invalid-location-area");
          }
        }
        for (const entry of backup.officeDecisions) {
          if (entry.revision > backup.dataset.revision || entry.revision < 1 || decisionRevisions.has(entry.revision)) throw new Error("invalid-office-revision");
          decisionRevisions.add(entry.revision);
          if (entry.kind === "confirm") resolveLocationArea({ countryCode: entry.proposal.countryCode, locationKind: "office", area: { kind: "manual-area" } });
        }
        const resolvedBase = projectOfficeAddressConfirmations(projectLocationConfirmations(restoredBase, backup.locationDecisions), backup.officeDecisions);
        restoredProjection = projectReconciliation(resolvedBase, backup.mergeDecisions);
        if (!same(restoredProjection.dataset.locations, backup.dataset.locations)) throw new Error("invalid-location-projection");
        for (const stored of backup.receipts) if (stored.tool === "locations.confirm" || stored.tool === "locations.revoke-confirmation") {
          const response = checked(LocationConfirmationReceiptSchema, stored.response, "invalid-backup");
          const event = backup.locationDecisions.find(entry => entry.id === response.decisionId);
          if (!event || event.actorScope !== stored.actorScope || event.revision !== response.revision || event.locationId !== response.locationId || event.kind !== (stored.tool === "locations.confirm" ? "confirm" : "revoke") || !originIds.has(response.jobId)) throw new Error("invalid-location-receipt");
          const thenProjection = projectReconciliation(restoredBase, backup.mergeDecisions.filter(entry => entry.revision < event.revision));
          const thenAlias = thenProjection.aliases.find(alias => alias.jobId === response.jobId)?.canonicalJobId;
          if (!thenProjection.dataset.jobs.find(job => job.id === thenAlias)?.listingIds.includes(event.listingId)) throw new Error("invalid-location-receipt-job");
          if (event.kind === "confirm") {
            const expectedLocation = applyLocationConfirmation(event.sourceLocation, event);
            if (!same(expectedLocation, response.location) || response.activeDecisionId !== event.id) throw new Error("invalid-location-receipt-body");
          } else {
            const receiptBase = event.sourceLocation ? historicalLocationBasis(event, event.sourceLocation) : restoredBase;
            const thenLocations = projectLocationConfirmations(receiptBase, backup.locationDecisions.filter(entry => entry.revision <= event.revision));
            const expectedLocation = projectOfficeAddressConfirmations(thenLocations, backup.officeDecisions.filter(entry => entry.revision < event.revision)).locations.find(location => location.id === response.locationId);
            const target = backup.locationDecisions.find(entry => entry.id === event.targetDecisionId);
            if (!expectedLocation || !target || target.kind !== "confirm" || !(event.sourceLocation ? same(response.location, expectedLocation) : compatibleSourceLocation(response.location, expectedLocation))
              || !target.sourceLocation.evidence.every(ref => response.location.evidence.some(value => same(ref, value)))
              || expectedLocation.userResolution?.decisionId !== response.activeDecisionId) throw new Error("invalid-location-receipt-body");
          }
        }
        for (const stored of backup.receipts) if (stored.tool === "locations.confirm-office-address" || stored.tool === "locations.revoke-office-address") {
          const response = checked(OfficeAddressReceiptSchema, stored.response, "invalid-backup");
          const event = backup.officeDecisions.find(entry => entry.id === response.decisionId);
          if (!event || event.kind === "invalidate" || event.actorScope !== stored.actorScope || event.revision !== response.revision || event.locationId !== response.locationId
            || event.kind !== (stored.tool === "locations.confirm-office-address" ? "confirm" : "revoke") || !originIds.has(response.jobId)) throw new Error("invalid-office-receipt");
          const thenProjection = projectReconciliation(restoredBase, backup.mergeDecisions.filter(entry => entry.revision < event.revision));
          const thenAlias = thenProjection.aliases.find(alias => alias.jobId === response.jobId)?.canonicalJobId;
          if (!thenProjection.dataset.jobs.find(job => job.id === thenAlias)?.listingIds.includes(event.listingId)) throw new Error("invalid-office-receipt-job");
          if (event.kind === "confirm") {
            const expectedLocation = applyOfficeAddressConfirmation(event.sourceLocation, event);
            if (!same(expectedLocation, response.location) || response.activeDecisionId !== event.id) throw new Error("invalid-office-receipt-body");
          } else {
            const target = backup.officeDecisions.find(entry => entry.id === event.targetDecisionId);
            if (!target || target.kind !== "confirm") throw new Error("invalid-office-receipt-target");
            const receiptBase = historicalLocationBasis(event, event.sourceLocation);
            const expected = projectOfficeAddressConfirmations(receiptBase, backup.officeDecisions.filter(entry => entry.revision <= event.revision)).locations.find(location => location.id === response.locationId);
            if (!expected || !same(response.location, expected) || response.activeDecisionId !== expected.officeResolution?.decisionId) throw new Error("invalid-office-receipt-body");
          }
        }
      } catch { throw new RepositoryError("invalid-backup"); }
      const jobBodies = (jobs: readonly CanonicalJob[]) => jobs.map(({ revision: _revision, updatedAt: _updatedAt, ...job }) => job).sort((a, b) => compareIds(a.id, b.id));
      const listingOwners = (dataset: AtlasDataset) => dataset.listings.map((listing) => ({ id: listing.id, canonicalJobId: listing.canonicalJobId })).sort((a, b) => compareIds(a.id, b.id));
      if (!same(jobBodies(restoredProjection.dataset.jobs), jobBodies(backup.dataset.jobs)) || !same(listingOwners(restoredProjection.dataset), listingOwners(backup.dataset))) throw new RepositoryError("invalid-backup");
      const restoredVersions = new Map(backup.jobVersions.map((value) => [value.jobId, value.revision]));
      if (backup.schemaVersion >= 2 && (backup.jobVersions.length !== originIds.size
        || restoredProjection.aliases.some((alias) => lastAliases.get(alias.jobId)?.canonicalJobId !== alias.canonicalJobId)
        || backup.dataset.jobs.some((job) => (restoredVersions.get(job.id) ?? -1) < job.revision))) throw new RepositoryError("invalid-backup");
      const requestSignature = signature({ backup, expectedRevision: restoreOptions.expectedRevision });
      return transaction(() => {
        const cached = receipt<ImportReceipt>(restoreOptions.actorScope, "dataset.restore", restoreOptions.idempotencyKey, requestSignature);
        if (cached) return checked(ImportReceiptSchema, cached);
        const current = read();
        if (current.revision !== restoreOptions.expectedRevision) throw new RepositoryError("stale-version");
        // A source run that was active in the saved file has no live executor after restoration.
        const restoredRuns = backup.runs.map((run): SyncRun => run.status === "running" ? { ...run, status: "cancelled", finishedAt: now() } : run);
        const dataset = { ...backup.dataset, revision: Math.max(current.revision, backup.dataset.revision) + 1 };
        write(dataset, true);
        writeBaseJobs(baseJobs, true);
        writeBaseLocations(baseLocations, true);
        db.exec("DELETE FROM enrichment_tasks;");
        for (const task of backup.enrichmentTasks) saveEnrichmentTask(task.state === "running" ? releaseEnrichment(task, "pending", now()) : task);
        db.exec("DROP TRIGGER location_decisions_no_update; DROP TRIGGER location_decisions_no_delete; DELETE FROM location_decisions;");
        for (const entry of backup.locationDecisions) db.prepare("INSERT INTO location_decisions VALUES (?,?,?)").run(entry.id, entry.revision, json(entry));
        db.exec(LOCATION_DECISION_TRIGGERS);
        db.exec("DROP TRIGGER office_decisions_no_update; DROP TRIGGER office_decisions_no_delete; DELETE FROM office_decisions;");
        for (const entry of backup.officeDecisions) db.prepare("INSERT INTO office_decisions VALUES (?,?,?)").run(entry.id, entry.revision, json(entry));
        db.exec(OFFICE_DECISION_TRIGGERS);
        db.exec("DROP TRIGGER merge_decisions_no_update; DROP TRIGGER merge_decisions_no_delete; DROP TRIGGER job_alias_history_no_update; DROP TRIGGER job_alias_history_no_delete; DELETE FROM merge_decisions; DELETE FROM job_alias_history; DELETE FROM job_aliases; DELETE FROM job_versions;");
        for (const entry of backup.mergeDecisions) db.prepare("INSERT INTO merge_decisions VALUES (?,?,?)").run(entry.id, entry.revision, json(entry));
        for (const event of backup.aliasHistory) db.prepare("INSERT INTO job_alias_history(job_id,revision,document) VALUES (?,?,?)").run(event.jobId, event.revision, json(event));
        for (const value of backup.jobVersions) db.prepare("INSERT INTO job_versions VALUES (?,?)").run(value.jobId, value.revision);
        for (const job of dataset.jobs) db.prepare("INSERT INTO job_versions VALUES (?,?) ON CONFLICT(job_id) DO UPDATE SET revision=MAX(revision,excluded.revision)").run(job.id, job.revision);
        saveAliases(restoredProjection.aliases, dataset.revision, now());
        db.exec(RECONCILIATION_TRIGGERS);
        db.exec("DELETE FROM runs; DELETE FROM source_generations;");
        for (const run of restoredRuns) {
          saveRun(run);
          db.prepare("INSERT INTO source_generations VALUES (?,?) ON CONFLICT(source_id) DO UPDATE SET generation=MAX(generation,excluded.generation)").run(run.sourceId, run.generation);
        }
        for (const lead of backup.leads) db.prepare("INSERT INTO discovery_leads VALUES (?,?,?)").run(lead.id, lead.sourceId, json(lead));
        for (const stored of backup.receipts) {
          const old = db.prepare("SELECT signature,response FROM receipts WHERE actor_scope=? AND tool=? AND idempotency_key=?").get(stored.actorScope, stored.tool, stored.idempotencyKey) as { signature: string; response: string } | undefined;
          if (old && (old.signature !== stored.signature || !same(JSON.parse(old.response), stored.response))) throw new RepositoryError("conflict");
          if (!old) db.prepare("INSERT INTO receipts VALUES (?,?,?,?,?,?)").run(stored.actorScope, stored.tool, stored.idempotencyKey, stored.signature, json(stored.response), stored.createdAt);
        }
        const result: ImportReceipt = { ok: true, revision: dataset.revision, jobIds: dataset.jobs.map((job) => job.id), snapshotIds: dataset.snapshots.map((snapshot) => snapshot.id), counts: { newJobs: dataset.jobs.length, updatedJobs: 0, unchangedJobs: 0, newListings: dataset.listings.length, newObservations: dataset.observations.length, newSnapshots: dataset.snapshots.length } };
        saveReceipt(restoreOptions.actorScope, "dataset.restore", restoreOptions.idempotencyKey, requestSignature, result);
        return result;
      });
    },
    close() { if (!closed) { baselineStore.close(); db.close(); closed = true; } },
  };
}
export type JobRepository = ReturnType<typeof openJobRepository>;
