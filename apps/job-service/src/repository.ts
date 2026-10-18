import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  AtlasDatasetObjectSchema, AtlasDatasetSchema, normalizeSearchText,
  SourceDefinitionSchema, type AtlasDataset, type Company, type CanonicalJob, type SourceListing,
  CanonicalJobSchema, EntityIdSchema, MergeDecisionSchema, ReconciliationReceiptSchema, JobAliasEventSchema,
  ConfirmMergeInputSchema, RejectMergeInputSchema, RevokeMergeInputSchema, explainMergeCandidate,
  findMergeCandidates, projectReconciliation,
  type MergeDecision, type ReconciliationReceipt, type JobAliasEvent, type ConfirmMergeInput, type OfficialRequisitionLink,
} from "@better-me/opportunities";
import {
  ActorScopeSchema, IdempotencyKeySchema, SyncRunSchema, RunScopeSchema, PublicRunSummarySchema,
  RequestFingerprintSchema,
  ImportReceiptSchema, RepositoryBackupSchema, REPOSITORY_SCHEMA_VERSION, REPOSITORY_MIGRATION_V1, REPOSITORY_MIGRATION_V2,
  APPEND_ONLY_TRIGGERS, RECONCILIATION_TRIGGERS, type ImportReceipt, type SyncRun, type RunScope, type PublicRunSummary,
  type RepositoryBackup, type StoredReceipt, DiscoveryLeadSchema, DiscoveryLeadReceiptSchema,
  type DiscoveryLead, type DiscoveryLeadReceipt,
} from "./repository-schema.js";

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
export type ImportOptions = { expectedRevision?: number; actorScope: string; idempotencyKey: string; runId?: string };
export type StartRunOptions = { sourceId: string; scope: RunScope; actorScope: string; idempotencyKey: string; requestFingerprint?: string };
export type FindRunByRequestOptions = { actorScope: string; idempotencyKey: string; requestFingerprint: string };
export type ReconciliationWriteOptions = Omit<ImportOptions, "runId"> & { expectedRevision: number };
export type CandidateQuery = { search?: string; mode?: "exact" | "fuzzy"; viewport?: [number, number, number, number] };
export type CandidateResult = { jobIds: string[]; indexedHits: string[]; exact: false; reason: "safe-superset"; snapshotVersion: number };

const TABLES = ["sources", "companies", "jobs", "locations", "compensations", "listings", "observations", "snapshots"] as const;
type Table = typeof TABLES[number];
const encoder = new TextEncoder();

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
export function openJobRepository(path: string, options: { now?: () => string } = {}) {
  if (typeof path !== "string" || !path || path.includes("\0")) throw new RepositoryError("invalid-data");
  let db: DatabaseSync;
  try { db = new DatabaseSync(path); } catch { throw new RepositoryError("storage-error"); }
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
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    // Opening a file with a matching user_version is not sufficient proof of this schema.
    db.prepare("SELECT value FROM metadata WHERE key='revision'").get();
    for (const table of TABLES) db.prepare(`SELECT id,document FROM ${table} LIMIT 0`).all();
    db.prepare("SELECT id,document FROM base_jobs LIMIT 0").all();
    db.prepare("SELECT id,revision,document FROM merge_decisions LIMIT 0").all();
    const check = db.prepare("PRAGMA quick_check").get() as Record<string, unknown>;
    if (Object.values(check)[0] !== "ok") throw new RepositoryError("storage-error");
  } catch (error) { db.close(); throw error instanceof RepositoryError ? error : new RepositoryError("storage-error"); }

  function ensureOpen() { if (closed) throw new RepositoryError("closed"); }
  function transaction<T>(work: () => T): T {
    ensureOpen(); db.exec("BEGIN IMMEDIATE");
    try { const result = work(); db.exec("COMMIT"); return result; }
    catch (error) { try { db.exec("ROLLBACK"); } catch { /* preserve fixed error below */ } throw error instanceof RepositoryError ? error : new RepositoryError("storage-error"); }
  }
  function revision() { return Number((db.prepare("SELECT value FROM metadata WHERE key='revision'").get() as { value: string }).value); }
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
  function saveReceipt(actorScope: string, tool: string, idempotencyKey: string, requestSignature: string, result: ImportReceipt | SyncRun | DiscoveryLeadReceipt | ReconciliationReceipt) {
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
  function baseSnapshot(current = read()): AtlasDataset {
    const jobs = (db.prepare("SELECT document FROM base_jobs ORDER BY id").all() as Array<{ document: string }>).map((row) => checked(CanonicalJobSchema, JSON.parse(row.document)));
    const owner = new Map(jobs.flatMap((job) => job.listingIds.map((id) => [id, job.id] as const)));
    return checked(AtlasDatasetSchema, { ...current, jobs, listings: current.listings.map((listing) => ({ ...listing, ...(owner.has(listing.id) ? { canonicalJobId: owner.get(listing.id) } : {}) })) });
  }
  function writeBaseJobs(jobs: readonly CanonicalJob[], replace = false) {
    if (replace) db.exec("DELETE FROM base_jobs");
    for (const job of jobs) db.prepare("INSERT INTO base_jobs(id,document) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document").run(job.id, json(job));
  }
  function canonicalProjection(base: AtlasDataset, current: AtlasDataset, entries: readonly MergeDecision[], changedAt: string) {
    const projection = projectReconciliation(base, entries);
    const old = new Map(current.jobs.map((job) => [job.id, job]));
    const body = (job: CanonicalJob) => { const { revision: _revision, updatedAt: _updatedAt, ...value } = job; return value; };
    projection.dataset.jobs = projection.dataset.jobs.map((job) => {
      const previous = old.get(job.id);
      if (!previous && !db.prepare("SELECT job_id FROM job_versions WHERE job_id=?").get(job.id)) return job;
      const count = projection.aliases.filter((alias) => alias.canonicalJobId === job.id).length;
      if (previous && same(body(previous), body(job))) return count === 1 && job.revision > previous.revision ? job : previous;
      const counter = db.prepare("SELECT revision FROM job_versions WHERE job_id=?").get(job.id) as { revision: number } | undefined;
      const version = Math.max(job.revision, counter ? counter.revision + 1 : 0, previous ? previous.revision + 1 : 0);
      const updatedAt = [job.updatedAt, ...(previous ? [previous.updatedAt] : []), changedAt].sort((a, b) => Date.parse(b) - Date.parse(a))[0]!;
      return { ...job, revision: version, updatedAt };
    });
    projection.dataset = checked(AtlasDatasetSchema, projection.dataset);
    return projection;
  }
  function saveAliases(aliases: readonly { jobId: string; canonicalJobId: string }[], version: number, at: string, decisionId?: string) {
    const previous = new Map((db.prepare("SELECT job_id,canonical_job_id FROM job_aliases").all() as Array<{ job_id: string; canonical_job_id: string }>).map((row) => [row.job_id, row.canonical_job_id]));
    db.exec("DELETE FROM job_aliases");
    for (const alias of aliases) {
      db.prepare("INSERT INTO job_aliases VALUES (?,?)").run(alias.jobId, alias.canonicalJobId);
      if (previous.get(alias.jobId) !== alias.canonicalJobId) {
        const event: JobAliasEvent = { ...alias, revision: version, at, ...(decisionId ? { decisionId } : {}) };
        db.prepare("INSERT INTO job_alias_history(job_id,revision,document) VALUES (?,?,?)").run(alias.jobId, version, json(event));
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
  function write(dataset: AtlasDataset, replace = false) {
    if (replace) {
      db.exec("DROP TRIGGER observations_no_update; DROP TRIGGER observations_no_delete; DROP TRIGGER snapshots_no_update; DROP TRIGGER snapshots_no_delete;");
      db.exec("DELETE FROM job_locations; DELETE FROM job_compensations; DELETE FROM job_listings; DELETE FROM listing_observations; DELETE FROM location_rtree; DELETE FROM location_rtree_ids; DELETE FROM jobs_fts; DELETE FROM discovery_leads;");
      for (const table of [...TABLES].reverse()) db.exec(`DELETE FROM ${table}`);
    }
    for (const table of TABLES) for (const value of dataset[table]) {
      const id = sourceIdOrId(table, value); const document = json(value);
      const existing = db.prepare(`SELECT document FROM ${table} WHERE id=?`).get(id) as { document: string } | undefined;
      if (existing?.document === document) continue;
      if ((table === "observations" || table === "snapshots") && existing) throw new RepositoryError("conflict");
      if (table === "jobs") {
        const job = value as CanonicalJob;
        db.prepare("INSERT INTO jobs(id,company_id,document) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET company_id=excluded.company_id,document=excluded.document").run(id, job.companyId, document);
      } else if (table === "locations") {
        const location = value as AtlasDataset["locations"][number];
        db.prepare("INSERT INTO locations(id,latitude,longitude,document) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET latitude=excluded.latitude,longitude=excluded.longitude,document=excluded.document").run(id, location.coordinates?.latitude ?? null, location.coordinates?.longitude ?? null, document);
      } else if (table === "listings") {
        const listing = value as SourceListing;
        db.prepare("INSERT INTO listings(id,source_id,job_id,document) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET source_id=excluded.source_id,job_id=excluded.job_id,document=excluded.document").run(id, listing.sourceId, listing.canonicalJobId ?? null, document);
      } else if (table === "observations") {
        const observation = value as AtlasDataset["observations"][number];
        db.prepare("INSERT INTO observations(id,listing_id,document) VALUES (?,?,?)").run(id, observation.listingId, document);
      } else if (table === "snapshots") {
        const snapshot = value as AtlasDataset["snapshots"][number];
        db.prepare("INSERT INTO snapshots(id,listing_id,observation_id,document) VALUES (?,?,?,?)").run(id, snapshot.listingId, snapshot.observationId, document);
      } else db.prepare(`INSERT INTO ${table}(id,document) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document`).run(id, document);
    }
    db.exec("DELETE FROM job_locations; DELETE FROM job_compensations; DELETE FROM job_listings; DELETE FROM listing_observations; DELETE FROM location_rtree; DELETE FROM location_rtree_ids; DELETE FROM jobs_fts;");
    const activeJobIds = new Set(dataset.jobs.map((job) => job.id));
    for (const row of db.prepare("SELECT id FROM jobs").all() as Array<{ id: string }>) if (!activeJobIds.has(row.id)) db.prepare("DELETE FROM jobs WHERE id=?").run(row.id);
    for (const job of dataset.jobs) db.prepare("INSERT INTO job_versions VALUES (?,?) ON CONFLICT(job_id) DO UPDATE SET revision=MAX(revision,excluded.revision)").run(job.id, job.revision);
    const companyById = new Map(dataset.companies.map((company) => [company.id, company]));
    for (const job of dataset.jobs) {
      for (const id of job.locationIds) db.prepare("INSERT INTO job_locations VALUES (?,?)").run(job.id, id);
      for (const id of job.compensationIds) db.prepare("INSERT INTO job_compensations VALUES (?,?)").run(job.id, id);
      for (const id of job.listingIds) db.prepare("INSERT INTO job_listings VALUES (?,?)").run(job.id, id);
      const company = companyById.get(job.companyId)!.names.join(" ");
      const cjkText = [job.title.value, company, job.description].join(" ").normalize("NFKC");
      const cjk: string[] = [];
      for (const segment of cjkText.match(/\p{Script=Han}+/gu) ?? []) {
        cjk.push(...segment);
        for (let index = 0; index < segment.length - 1; index++) cjk.push(segment.slice(index, index + 2));
      }
      db.prepare("INSERT INTO jobs_fts(job_id,title,company,description,cjk) VALUES (?,?,?,?,?)").run(job.id, normalizeSearchText(job.title.value), normalizeSearchText(company), normalizeSearchText(job.description), [...new Set(cjk)].join(" "));
    }
    for (const listing of dataset.listings) for (const observationId of listing.observationIds) db.prepare("INSERT INTO listing_observations VALUES (?,?)").run(listing.id, observationId);
    for (const location of dataset.locations) if (location.coordinates) {
      const inserted = db.prepare("INSERT INTO location_rtree_ids(location_id) VALUES (?)").run(location.id);
      db.prepare("INSERT INTO location_rtree VALUES (?,?,?,?,?)").run(inserted.lastInsertRowid, location.coordinates.longitude, location.coordinates.longitude, location.coordinates.latitude, location.coordinates.latitude);
    }
    db.prepare("UPDATE metadata SET value=? WHERE key='revision'").run(String(dataset.revision));
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
        } else if (table === "locations" || table === "compensations") throw new RepositoryError("conflict");
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

  return {
    async readSnapshot(): Promise<AtlasDataset> { return transaction(read); },
    /** Ingestion-only origins: never use this view for map totals or user-facing search. */
    async readProjectionSnapshot(): Promise<AtlasDataset> { return transaction(() => baseSnapshot()); },
    async importSnapshot(input: unknown, importOptions: ImportOptions): Promise<ImportReceipt> {
      validateOptions(importOptions);
      const incoming = checked(AtlasDatasetObjectSchema, input);
      const requestSignature = signature({ input: incoming, expectedRevision: importOptions.expectedRevision, runId: importOptions.runId });
      return transaction(() => {
        const cached = receipt<ImportReceipt>(importOptions.actorScope, "dataset.import", importOptions.idempotencyKey, requestSignature);
        if (cached) return checked(ImportReceiptSchema, cached);
        const current = read();
        if (importOptions.expectedRevision !== undefined && current.revision !== importOptions.expectedRevision) throw new RepositoryError("stale-version");
        const run = importOptions.runId ? currentRun(importOptions.runId, importOptions.actorScope) : undefined;
        const base = baseSnapshot(current);
        const nextBase = merged(base, incoming);
        if (run) validateRunDelta(incoming, nextBase, base, run);
        verifyContentHashes(nextBase);
        const projection = canonicalProjection(nextBase, current, decisions(), now());
        const next = projection.dataset;
        const changed = TABLES.some((table) => !same(base[table], nextBase[table])) || TABLES.some((table) => !same(current[table], next[table]));
        next.revision = current.revision + Number(changed);
        const targets = new Set(incoming.jobs.map((job) => projection.aliases.find((alias) => alias.jobId === job.id)!.canonicalJobId));
        const effectiveIncoming = { ...incoming, jobs: next.jobs.filter((job) => targets.has(job.id)) };
        const result: ImportReceipt = { ok: true, revision: next.revision, jobIds: effectiveIncoming.jobs.map((job) => job.id), snapshotIds: incoming.snapshots.map((snapshot) => snapshot.id), counts: counts(current, next, effectiveIncoming) };
        if (changed) { writeBaseJobs(nextBase.jobs); write(next); saveAliases(projection.aliases, next.revision, now()); }
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
      const requestSignature = signature({ input: parsed, expectedRevision: writeOptions.expectedRevision });
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
        const current = read(); assertWriteVersion(writeOptions, current);
        const entry: MergeDecision = { id: `merge_${randomUUID()}`, kind: "merge", at: now(), revision: current.revision + 1, actorScope: writeOptions.actorScope, reason: parsed.reason, targetJobId: state.targetJobId!, sourceJobId: state.sourceJobId!, companyIdentityConfirmed: parsed.companyIdentityConfirmed, candidate };
        return commitDecision(current, entry, writeOptions, "jobs.merge", requestSignature);
      });
    },
    async rejectMerge(input: { leftJobId: string; rightJobId: string; reason: string }, writeOptions: ReconciliationWriteOptions): Promise<ReconciliationReceipt> {
      validateOptions(writeOptions); const parsed = checked(RejectMergeInputSchema, input);
      const requestSignature = signature({ input: parsed, expectedRevision: writeOptions.expectedRevision });
      const state = transaction(() => {
        const cached = receipt<ReconciliationReceipt>(writeOptions.actorScope, "jobs.reject-merge", writeOptions.idempotencyKey, requestSignature);
        if (cached) return { cached: checked(ReconciliationReceiptSchema, cached) };
        const current = read(); assertWriteVersion(writeOptions, current); return { current };
      });
      if (state.cached) return state.cached;
      const candidate = await explainMergeCandidate(state.current!, parsed);
      return transaction(() => {
        const cached = receipt<ReconciliationReceipt>(writeOptions.actorScope, "jobs.reject-merge", writeOptions.idempotencyKey, requestSignature);
        if (cached) return checked(ReconciliationReceiptSchema, cached);
        const current = read(); assertWriteVersion(writeOptions, current);
        const entry: MergeDecision = { id: `merge-reject_${randomUUID()}`, kind: "reject", at: now(), revision: current.revision + 1, actorScope: writeOptions.actorScope, reason: parsed.reason, leftJobId: candidate.leftJobId, rightJobId: candidate.rightJobId, candidate };
        return commitDecision(current, entry, writeOptions, "jobs.reject-merge", requestSignature);
      });
    },
    async revokeMerge(input: { decisionId: string; reason: string }, writeOptions: ReconciliationWriteOptions): Promise<ReconciliationReceipt> {
      validateOptions(writeOptions); const parsed = checked(RevokeMergeInputSchema, input);
      const requestSignature = signature({ input: parsed, expectedRevision: writeOptions.expectedRevision });
      return transaction(() => {
        const cached = receipt<ReconciliationReceipt>(writeOptions.actorScope, "jobs.revoke-merge", writeOptions.idempotencyKey, requestSignature);
        if (cached) return checked(ReconciliationReceiptSchema, cached);
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
        if (changed) db.prepare("UPDATE metadata SET value=? WHERE key='revision'").run(String(nextRevision));
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
        return checked(RepositoryBackupSchema, { format: "better-me/job-repository", schemaVersion: REPOSITORY_SCHEMA_VERSION, createdAt: now(), dataset, runs, receipts, leads, baseJobs, mergeDecisions: decisions(), aliasHistory, jobVersions }, "invalid-backup");
      });
    },
    async restore(input: unknown, restoreOptions: Omit<ImportOptions, "runId"> & { expectedRevision: number }): Promise<ImportReceipt> {
      validateOptions(restoreOptions);
      const backup = checked(RepositoryBackupSchema, input, "invalid-backup");
      verifyContentHashes(backup.dataset, "invalid-backup");
      if (encoder.encode(json(backup)).byteLength > 128 * 1024 * 1024) throw new RepositoryError("invalid-backup");
      const baseJobs = backup.baseJobs ?? backup.dataset.jobs;
      const owners = new Map(baseJobs.flatMap((job) => job.listingIds.map((id) => [id, job.id] as const)));
      const restoredBase = checked(AtlasDatasetSchema, { ...backup.dataset, jobs: baseJobs, listings: backup.dataset.listings.map((listing) => ({ ...listing, ...(owners.has(listing.id) ? { canonicalJobId: owners.get(listing.id) } : {}) })) }, "invalid-backup");
      const originIds = new Set(baseJobs.map((job) => job.id)); const decisionIds = new Set<string>(); const decisionRevisions = new Set<number>();
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
      try { restoredProjection = projectReconciliation(restoredBase, backup.mergeDecisions); } catch { throw new RepositoryError("invalid-backup"); }
      const jobBodies = (jobs: readonly CanonicalJob[]) => jobs.map(({ revision: _revision, updatedAt: _updatedAt, ...job }) => job).sort((a, b) => compareIds(a.id, b.id));
      const listingOwners = (dataset: AtlasDataset) => dataset.listings.map((listing) => ({ id: listing.id, canonicalJobId: listing.canonicalJobId })).sort((a, b) => compareIds(a.id, b.id));
      if (!same(jobBodies(restoredProjection.dataset.jobs), jobBodies(backup.dataset.jobs)) || !same(listingOwners(restoredProjection.dataset), listingOwners(backup.dataset))) throw new RepositoryError("invalid-backup");
      const restoredVersions = new Map(backup.jobVersions.map((value) => [value.jobId, value.revision]));
      if (backup.schemaVersion === 2 && (backup.jobVersions.length !== originIds.size
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
    close() { if (!closed) { db.close(); closed = true; } },
  };
}
export type JobRepository = ReturnType<typeof openJobRepository>;
