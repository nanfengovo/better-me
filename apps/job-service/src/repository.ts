import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  AtlasDatasetObjectSchema, AtlasDatasetSchema, normalizeSearchText,
  SourceDefinitionSchema, type AtlasDataset, type Company, type CanonicalJob, type SourceListing,
  CanonicalJobSchema, EntityIdSchema, MergeDecisionSchema, ReconciliationReceiptSchema, JobAliasEventSchema,
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
  CompensationSchema, CompensationReviewDecisionSchema, CompensationReviewPreviewSchema, CompensationReviewReceiptSchema, CompensationReviewReadResultSchema,
  PreviewCompensationReviewInputSchema, ConfirmCompensationReviewInputSchema, RevokeCompensationReviewInputSchema, ReadCompensationReviewInputSchema,
  validateCompensationReviewProposal, captureCompensationReviewSourceBinding, applyCompensationReviewConfirmation, projectCompensationReviews, getInvalidatedCompensationReviewIds,
  type Compensation, type CompensationReviewDecision, type CompensationReviewPreview, type CompensationReviewReceipt, type CompensationReviewReadResult,
  type CompensationReviewSourceBinding,
  type PreviewCompensationReviewInput, type ConfirmCompensationReviewInput, type RevokeCompensationReviewInput,
  FxStateSchema, FxQueryContextSchema, FxMutationReceiptSchema,
  ReadFxStateInputSchema, PreviewFxImportInputSchema, ConfirmFxImportInputSchema, ActivateFxSnapshotInputSchema,
  buildFxImportPreview, validateFxReferenceSnapshot,
  type FxState, type FxQueryContext, type FxImportPreview, type FxMutationReceipt, type FxReferenceSnapshot,
  type ConfirmFxImportInput, type ActivateFxSnapshotInput,
  CompanySchema, CompanyControlReviewDecisionSchema, CompanyControlReviewReadResultSchema, CompanyControlReviewPreviewSchema, CompanyControlReviewReceiptSchema,
  ReadCompanyControlReviewInputSchema, PreviewCompanyControlReviewInputSchema, ConfirmCompanyControlReviewInputSchema, RevokeCompanyControlReviewInputSchema,
  validateCompanyControlReviewProposal, captureCompanyControlReviewSourceBinding, projectCompanyControlReviews, getInvalidatedCompanyControlReviewIds,
  stripCompanyControlReviewProjection, isCompanyControlReviewEntityId, buildCompanyControlReviewMaterials, validateCompanyControlReviewHistory,
  applyCompanyControlReviewConfirmation, activeCompanyControlReviewDecision,
  type CompanyControlReviewDecision, type CompanyControlReviewReadResult, type CompanyControlReviewPreview, type CompanyControlReviewReceipt,
  type PreviewCompanyControlReviewInput,
  type CompanyControlReviewSourceBinding,
} from "@better-me/opportunities";
import {
  ActorScopeSchema, IdempotencyKeySchema, SyncRunSchema, RunScopeSchema, PublicRunSummarySchema,
  RequestFingerprintSchema,
  ImportReceiptSchema, RepositoryBackupSchema, REPOSITORY_SCHEMA_VERSION, REPOSITORY_MIGRATION_V1, REPOSITORY_MIGRATION_V2, REPOSITORY_MIGRATION_V3, LOCATION_DECISION_TRIGGERS, REPOSITORY_MIGRATION_V4, OFFICE_DECISION_TRIGGERS,
  APPEND_ONLY_TRIGGERS, RECONCILIATION_TRIGGERS, type ImportReceipt, type SyncRun, type RunScope, type PublicRunSummary,
  type RepositoryBackup, type StoredReceipt, DiscoveryLeadSchema, DiscoveryLeadReceiptSchema,
  type DiscoveryLead, type DiscoveryLeadReceipt,
  REPOSITORY_MIGRATION_V5, COMPENSATION_DECISION_TRIGGERS,
  REPOSITORY_MIGRATION_V6, FX_TRIGGERS, FxActivationEventSchema, StoredFxSnapshotSchema, type FxActivationEvent, type StoredFxSnapshot,
  REPOSITORY_MIGRATION_V7, COMPANY_CONTROL_DECISION_TRIGGERS,
} from "./repository-schema.js";
import { resolveLocationArea } from "./location-catalog.js";
import { SourceScopeSchema, SourcePageSchema, SourceScanProgressSchema, type SourceScope, type SourcePage, type SourceScanProgress, type ContinueSourceScanInput } from "@better-me/source-adapters";
import { SourceScanCheckpointSchema, sourceScanFingerprint, sourceConfigurationFingerprint, type SourceScanCheckpoint } from "./source-scan-state.js";
import { REPOSITORY_MIGRATION_V8, SOURCE_SCAN_TRIGGERS, SourceScanPageReceiptSchema, type SourceScanPageReceipt } from "./repository-schema.js";

export type RepositoryErrorCode = "invalid-data" | "conflict" | "stale-version" | "idempotency-conflict" | "cancelled" | "not-authorized" | "not-found" | "closed" | "unsupported-schema" | "invalid-backup" | "storage-error" | "rate-limited";
const PUBLIC_ERRORS: Record<RepositoryErrorCode, string> = {
  "invalid-data": "岗位数据不符合公共领域契约。", "conflict": "岗位记录与已有版本冲突，未写入。",
  "stale-version": "索引版本或刷新任务已变化，未写入迟到结果。", "idempotency-conflict": "幂等键已用于不同请求。",
  "cancelled": "刷新任务已取消。", "not-authorized": "当前执行身份不拥有该刷新任务。",
  "not-found": "指定记录不存在。", "closed": "岗位仓库已关闭。", "unsupported-schema": "岗位数据库版本不受当前程序支持。",
  "invalid-backup": "备份版本或内容无效，现有数据未被替换。", "storage-error": "岗位仓库操作失败，事务未提交。",
  "rate-limited": "来源刷新间隔或每日读取额度尚未允许新的任务，现有任务保持原状态。",
};
export class RepositoryError extends Error {
  constructor(public readonly code: RepositoryErrorCode) { super(PUBLIC_ERRORS[code]); this.name = "RepositoryError"; }
}
export type ImportOptions = { expectedRevision?: number; actorScope: string; idempotencyKey: string; runId?: string;
  /** Host-computed identity of a fully validated command, independent of its projected delta. */
  requestFingerprint?: string };
export type StartRunOptions = { sourceId: string; scope: RunScope; actorScope: string; idempotencyKey: string; requestFingerprint?: string;
  /** Supplied only by the application for a real manual source scan. Legacy repository runs remain valid. */
  scan?: { sourceFingerprint: string; scope: SourceScope; continue?: ContinueSourceScanInput } };
export type FindRunByRequestOptions = { actorScope: string; idempotencyKey: string; requestFingerprint: string };
export type ReconciliationWriteOptions = Omit<ImportOptions, "runId"> & { expectedRevision: number; throwIfCancelled?: () => void };
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
function reconciliationSignature(input: unknown, options: ReconciliationWriteOptions) {
  return signature({ input, expectedRevision: options.expectedRevision, ...(options.requestFingerprint === undefined ? {} : { requestFingerprint: options.requestFingerprint }) });
}
function same(a: unknown, b: unknown) { return json(a) === json(b); }
function validateSourceScanBackup(backup: RepositoryBackup, currentTime: string) {
  const cutoff = Math.min(Date.parse(backup.createdAt), Date.parse(currentTime));
  const previous = new Map<string, SourceScanCheckpoint>(), runs = new Map(backup.runs.map(run => [run.runId, run]));
  const fail = (): never => { throw new RepositoryError("invalid-backup"); };
  const sourceScope = (run: SyncRun): SourceScope => ({ roles: run.scope.keywords ?? [], regions: run.scope.regions ?? [], companyNames: run.scope.companies ?? [], ...(run.scope.countryCodes ? { countryCodes: run.scope.countryCodes } : {}) });
  const immutableRun = ({ status: _status, finishedAt: _finishedAt, summary: _summary, ...run }: SyncRun) => run;
  const pageReceipts = backup.receipts.filter(value => value.tool === "sources.commit-page");
  for (const event of backup.sourceScans) {
    const run = runs.get(event.runId), prior = previous.get(event.scanId);
    if (!run || run.scanId !== event.scanId || run.sourceId !== event.sourceId || run.actorScope !== event.actorScope || run.generation !== event.generation
      || Date.parse(event.at) > cutoff || Date.parse(event.at) < Date.parse(run.startedAt) || !same(sourceScope(run), event.scope)) fail();
    if (!prior) {
      if (event.version !== 1 || event.pages || event.attemptedRecords || event.cursor || event.hadErrors || event.state !== "retry-page" || run!.continuedFromRunId) fail();
    } else {
      if (event.version !== prior.version + 1 || Date.parse(event.at) < Date.parse(prior.at) || prior.state === "invalidated"
        || event.sourceId !== prior.sourceId || event.actorScope !== prior.actorScope || event.sourceFingerprint !== prior.sourceFingerprint
        || event.scopeFingerprint !== prior.scopeFingerprint || event.adapterId !== prior.adapterId || event.adapterVersion !== prior.adapterVersion
        || !same(event.scope, prior.scope) || event.hadErrors < prior.hadErrors) fail();
      if (event.runId !== prior.runId) {
        if (run!.continuedFromRunId !== prior.runId || event.generation <= prior.generation || event.state !== prior.state || event.cursor !== prior.cursor
          || event.pages !== prior.pages || event.attemptedRecords !== prior.attemptedRecords || event.hadErrors !== prior.hadErrors) fail();
      } else if (event.pages === prior.pages + 1) {
        if (event.attemptedRecords < prior.attemptedRecords || event.generation !== prior.generation || event.state === "invalidated") fail();
        const matching = pageReceipts.filter(value => { const response = checked(SourceScanPageReceiptSchema, value.response, "invalid-backup"); return response.scanId === event.scanId && response.progressVersion === event.version; });
        if (matching.length !== 1 || matching[0]!.actorScope !== event.actorScope || checked(SourceScanPageReceiptSchema, matching[0]!.response, "invalid-backup").runId !== event.runId) fail();
        if (event.state === "retry-page" && event.cursor !== prior.cursor) fail();
      } else if (event.pages !== prior.pages || event.attemptedRecords !== prior.attemptedRecords || event.cursor !== prior.cursor
        || event.state !== "invalidated" && event.state !== "retry-page" && event.state !== prior.state) fail();
    }
    previous.set(event.scanId, event);
  }
  for (const event of previous.values()) {
    const source = backup.dataset.sources.find(value => value.sourceId === event.sourceId);
    if (!source || event.state !== "invalidated" && (event.sourceFingerprint !== sourceConfigurationFingerprint(source) || event.adapterId !== source.adapterId || event.adapterVersion !== source.adapterVersion)) fail();
  }
  for (const run of backup.runs.filter(value => value.scanId)) {
    if (!backup.sourceScans.some(event => event.runId === run.runId) || !run.requestFingerprint) fail();
    const starts = backup.receipts.filter(receipt => receipt.tool === "runs.start" && SyncRunSchema.safeParse(receipt.response).success && (receipt.response as SyncRun).runId === run.runId);
    if (starts.length !== 1 || starts[0]!.actorScope !== run.actorScope || starts[0]!.signature !== signature({ sourceId: run.sourceId, requestFingerprint: run.requestFingerprint })
      || !same(immutableRun(checked(SyncRunSchema, starts[0]!.response, "invalid-backup")), immutableRun(run))) fail();
  }
  for (const stored of pageReceipts) {
    const response = checked(SourceScanPageReceiptSchema, stored.response, "invalid-backup"), run = runs.get(response.runId);
    const event = backup.sourceScans.find(value => value.scanId === response.scanId && value.version === response.progressVersion);
    if (!run || !event || event.runId !== run.runId || run.actorScope !== stored.actorScope || response.revision > backup.dataset.revision || response.receipt.revision > response.revision
      || Date.parse(stored.createdAt) > cutoff || Date.parse(stored.createdAt) < Date.parse(run.startedAt)) fail();
    const imported = backup.receipts.find(value => value.tool === "dataset.import" && value.actorScope === stored.actorScope && value.idempotencyKey === stored.idempotencyKey);
    const leads = backup.receipts.find(value => value.tool === "leads.save" && value.actorScope === stored.actorScope && value.idempotencyKey === stored.idempotencyKey);
    if (!imported || !leads || !same(imported.response, response.receipt)) fail();
    const leadResult = checked(DiscoveryLeadReceiptSchema, leads!.response, "invalid-backup");
    if (leadResult.revision !== response.revision || !same(leadResult.leadIds, response.leadIds)) fail();
  }
}
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

/** A review cannot archive source reads, citations or snapshots that have not happened yet. */
function validateCompanyControlSourceTimes(company: Company, binding: CompanyControlReviewSourceBinding, at: string) {
  const cutoff = Date.parse(at);
  const overrides = company.manualOverrides.filter(value => value.field === "legalEntity" || value.field === "ultimateControllers");
  const refs = [...company.legalEntity?.evidence ?? [], ...company.ultimateControllers.evidence,
    ...overrides.flatMap(value => value.field === "legalEntity" || value.field === "ultimateControllers" ? value.value.evidence : [])];
  const timestamps = [...refs.map(value => value.observedAt), ...overrides.map(value => value.at),
    ...binding.observations.flatMap(value => [value.fetchedAt, value.feedFetchedAt, value.detailFetchedAt, value.availabilityVerifiedAt].filter((time): time is string => time !== undefined)),
    ...binding.snapshots.map(value => value.createdAt)];
  if (timestamps.some(value => Date.parse(value) > cutoff)) throw new Error("future-company-control-source-evidence");
}

/** Rebuild rates and command signatures from retained source JSON, not from derived backup fields. */
async function verifyFxBackup(backup: RepositoryBackup, targetNow: string) {
  try {
    const occupied = new Set([...backup.mergeDecisions, ...backup.locationDecisions, ...backup.officeDecisions, ...backup.compensationDecisions, ...backup.companyControlDecisions].map(value => value.revision));
    const snapshots = new Map(backup.fxSnapshots.map(value => [value.snapshot.fx.id, value]));
    for (const stored of backup.fxSnapshots) {
      if (stored.revision > backup.dataset.revision) throw new Error("invalid-fx-revision");
      const availableBy = Date.parse(targetNow) < Date.parse(backup.createdAt) ? targetNow : backup.createdAt;
      await validateFxReferenceSnapshot(stored.snapshot, { now: availableBy });
    }
    let previousRevision = 0, active: string | null = null;
    const fxReceipts = backup.receipts.filter(value => value.tool === "fx.confirm-import" || value.tool === "fx.activate");
    const receiptsByRevision = new Map<number, typeof fxReceipts>();
    for (const saved of fxReceipts) {
      const response = checked(FxMutationReceiptSchema, saved.response, "invalid-backup");
      receiptsByRevision.set(response.revision, [...receiptsByRevision.get(response.revision) ?? [], saved]);
    }
    const createdSnapshots = new Set<string>();
    for (const event of backup.fxActivations) {
      if (event.revision <= previousRevision || event.revision > backup.dataset.revision || occupied.has(event.revision) || Date.parse(event.at) > Date.parse(backup.createdAt) || Date.parse(event.at) > Date.parse(targetNow)) throw new Error("invalid-fx-event");
      previousRevision = event.revision;
      const stored = event.snapshotId === null ? undefined : snapshots.get(event.snapshotId);
      if (event.snapshotId !== null && (!stored || stored.revision > event.revision || Date.parse(stored.snapshot.retrievedAt) > Date.parse(event.at))) throw new Error("invalid-fx-reference");
      let input: ConfirmFxImportInput | ActivateFxSnapshotInput;
      if (event.kind === "import") {
        if (!stored) throw new Error("missing-fx-import");
        const { sourceUrl, retrievedAt, raw, format, fx } = stored.snapshot;
        const draft = { schemaVersion: 1 as const, provider: fx.provider, sourceUrl, retrievedAt, raw, format };
        const preview = await buildFxImportPreview({ draft, expectedRevision: event.revision - 1 }, { now: event.at });
        if (preview.previewFingerprint !== event.previewFingerprint || !same(preview.snapshot, stored.snapshot)) throw new Error("invalid-fx-preview");
        input = { draft, expectedRevision: event.revision - 1, previewFingerprint: event.previewFingerprint!, reviewed: true, activate: event.activate! };
        if (stored.revision === event.revision) createdSnapshots.add(stored.snapshot.fx.id);
        if (event.activate) active = event.snapshotId;
      } else {
        input = { snapshotId: event.snapshotId, expectedRevision: event.revision - 1, reviewed: true };
        active = event.snapshotId;
      }
      if (event.activeSnapshotId !== active) throw new Error("invalid-fx-selection");
      const matching = receiptsByRevision.get(event.revision) ?? [];
      if (matching.length !== 1) throw new Error("missing-fx-receipt");
      const saved = matching[0]!, response = { ok: true, revision: event.revision, snapshotId: event.snapshotId, activeSnapshotId: active };
      if (saved.actorScope !== event.actorScope || saved.tool !== (event.kind === "import" ? "fx.confirm-import" : "fx.activate") || saved.signature !== signature({ input }) || !same(saved.response, response)) throw new Error("invalid-fx-receipt");
    }
    if (fxReceipts.length !== backup.fxActivations.length || backup.fxSnapshots.some(value => !createdSnapshots.has(value.snapshot.fx.id))) throw new Error("orphan-fx-history");
  } catch { throw new RepositoryError("invalid-backup"); }
}

/** Rebuild review material and durable command results before opening a write transaction. */
async function verifyCompanyControlBackup(backup: RepositoryBackup, base: AtlasDataset, targetNow: string) {
  try {
    const entries = backup.companyControlDecisions, cutoff = Date.parse(targetNow) < Date.parse(backup.createdAt) ? targetNow : backup.createdAt;
    await validateCompanyControlReviewHistory(base, entries, { now: cutoff });
    const other = [...backup.mergeDecisions, ...backup.locationDecisions, ...backup.officeDecisions, ...backup.compensationDecisions];
    const savedReceipts = backup.receipts.filter(value => value.tool === "companies.confirm-control-review" || value.tool === "companies.revoke-control-review");
    const historicalBase = (entry: Exclude<CompanyControlReviewDecision, { kind: "invalidate" }>): AtlasDataset => checked(AtlasDatasetSchema, {
      ...base, companies: base.companies.map(company => company.id === entry.companyId ? entry.sourceCompany : company),
      jobs: base.jobs.map(job => job.id === entry.jobId ? { ...job, companyId: entry.companyId } : job),
      listings: base.listings.map(listing => { const saved = entry.sourceBinding.listings.find(value => value.id === listing.id); if (!saved) return listing;
        const { sourceRecordId: _record, canonicalUrl: _canonical, applicationUrl: _application, ...retained } = listing;
        return { ...retained, ...saved, observationIds: union(listing.observationIds, entry.sourceBinding.observations.filter(value => value.listingId === listing.id).map(value => value.id)) };
      }),
      observations: [...base.observations.filter(value => !entry.sourceBinding.observations.some(archived => archived.id === value.id)), ...entry.sourceBinding.observations],
      snapshots: [...base.snapshots.filter(value => !entry.sourceBinding.snapshots.some(archived => archived.id === value.id)), ...entry.sourceBinding.snapshots],
    }, "invalid-backup");
    for (const entry of entries) {
      if (entry.revision < 1 || other.some(value => value.id === entry.id || value.revision === entry.revision && !(value.kind === "invalidate" && entry.kind === "invalidate"))) throw new Error("invalid-company-control-revision");
      if (entry.kind === "invalidate") continue;
      if (!base.companies.some(company => company.id === entry.companyId) || !base.jobs.some(job => job.id === entry.jobId && job.companyId === entry.companyId)
        || entry.affectedJobIds.some(id => !base.jobs.some(job => job.id === id && job.companyId === entry.companyId))) throw new Error("invalid-company-control-scope");
      validateCompanyControlSourceTimes(entry.sourceCompany, entry.sourceBinding, entry.at);
      for (const observation of entry.sourceBinding.observations) {
        const retained = base.observations.find(value => value.id === observation.id);
        if (!retained || !same(retained, observation) || Date.parse(observation.fetchedAt) > Date.parse(entry.at)) throw new Error("invalid-company-control-archived-observation");
      }
      for (const snapshot of entry.sourceBinding.snapshots) {
        if (!same(base.snapshots.find(value => value.id === snapshot.id), snapshot)) throw new Error("invalid-company-control-archived-snapshot");
      }
      verifyContentHashes({ ...base, observations: entry.sourceBinding.observations, snapshots: entry.sourceBinding.snapshots }, "invalid-backup");
      const thenBase = historicalBase(entry);
      if (!same(captureCompanyControlReviewSourceBinding(thenBase, { jobId: entry.jobId, companyId: entry.companyId, sourceCompany: entry.sourceCompany }), entry.sourceBinding)) throw new Error("invalid-company-control-source-binding");
      const matches = savedReceipts.filter(saved => CompanyControlReviewReceiptSchema.parse(saved.response).decisionId === entry.id);
      if (matches.length !== 1) throw new Error("missing-company-control-receipt");
      const saved = matches[0]!, response = CompanyControlReviewReceiptSchema.parse(saved.response), tool = entry.kind === "confirm" ? "companies.confirm-control-review" : "companies.revoke-control-review";
      const common = { jobId: entry.jobId, companyId: entry.companyId, expectedRevision: entry.revision - 1, reason: entry.reason };
      const previewInput = entry.kind === "confirm" ? { ...common, proposal: entry.proposal } : undefined;
      const input = entry.kind === "confirm" ? { ...previewInput, reviewed: true, previewFingerprint: signature({ input: previewInput, sourceCompany: entry.sourceCompany, sourceBinding: entry.sourceBinding }) }
        : { ...common, decisionId: entry.targetDecisionId, reviewed: true };
      const prefix = entries.filter(value => value.revision <= entry.revision);
      const company = entry.kind === "confirm" ? applyCompanyControlReviewConfirmation(entry.sourceCompany, entry) : projectCompanyControlReviews(thenBase, prefix).companies.find(value => value.id === entry.companyId)!;
      const active = entry.kind === "confirm" ? entry : activeCompanyControlReviewDecision(thenBase, prefix, entry.companyId);
      const expected = { ok: true, revision: entry.revision, jobId: entry.jobId, companyId: entry.companyId, decisionId: entry.id, ...(active ? { activeDecisionId: active.id } : {}), company, affectedJobIds: entry.affectedJobIds };
      if (saved.actorScope !== entry.actorScope || saved.tool !== tool || saved.signature !== signature({ input }) || !same(response, expected)
        || Date.parse(saved.createdAt) < Date.parse(entry.at) || Date.parse(saved.createdAt) > Date.parse(cutoff)) throw new Error("invalid-company-control-receipt");
    }
    if (savedReceipts.length !== entries.filter(value => value.kind !== "invalidate").length) throw new Error("orphan-company-control-receipt");
    const projected = projectCompanyControlReviews(base, entries);
    for (const table of ["companies", "sources", "listings", "observations"] as const) {
      const sorted = (values: readonly unknown[]) => [...values].filter(value => table === "companies" || isCompanyControlReviewEntityId(sourceIdOrId(table, value))).sort((left, right) => compareIds(sourceIdOrId(table, left), sourceIdOrId(table, right)));
      if (!same(sorted(projected[table]), sorted(backup.dataset[table]))) throw new Error("invalid-company-control-projection");
    }
  } catch { throw new RepositoryError("invalid-backup"); }
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
      try { db.exec(REPOSITORY_MIGRATION_V5); db.exec(COMPENSATION_DECISION_TRIGGERS); db.exec("PRAGMA user_version=5; COMMIT;"); }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    if (version < 6) {
      db.exec("BEGIN IMMEDIATE");
      try { db.exec(REPOSITORY_MIGRATION_V6); db.exec(FX_TRIGGERS); db.exec("PRAGMA user_version=6; COMMIT;"); }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    if (version < 7) {
      db.exec("BEGIN IMMEDIATE");
      try { db.exec(REPOSITORY_MIGRATION_V7); db.exec(COMPANY_CONTROL_DECISION_TRIGGERS); db.exec("PRAGMA user_version=7; COMMIT;"); }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    if (version < 8) {
      db.exec("BEGIN IMMEDIATE");
      try { db.exec(REPOSITORY_MIGRATION_V8); db.exec(SOURCE_SCAN_TRIGGERS); db.exec("PRAGMA user_version=8; COMMIT;"); }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    // Opening a file with a matching user_version is not sufficient proof of this schema.
    db.prepare("SELECT value FROM metadata WHERE key='revision'").get();
    for (const table of TABLES) db.prepare(`SELECT id,document FROM ${table} LIMIT 0`).all();
    db.prepare("SELECT id,document FROM base_jobs LIMIT 0").all();
    db.prepare("SELECT id,revision,document FROM merge_decisions LIMIT 0").all();
    db.prepare("SELECT id,document FROM base_locations LIMIT 0").all();
    db.prepare("SELECT id,revision,document FROM location_decisions LIMIT 0").all();
    db.prepare("SELECT id,revision,document FROM office_decisions LIMIT 0").all();
    db.prepare("SELECT id,document FROM base_compensations LIMIT 0").all();
    db.prepare("SELECT id,revision,document FROM compensation_decisions LIMIT 0").all();
    db.prepare("SELECT id,revision,document FROM fx_snapshots LIMIT 0").all();
    db.prepare("SELECT id,revision,document FROM fx_activations LIMIT 0").all();
    db.prepare("SELECT id,document FROM base_companies LIMIT 0").all();
    db.prepare("SELECT id,revision,document FROM company_control_decisions LIMIT 0").all();
    db.prepare("SELECT id,scan_id,version,source_id,actor_scope,document FROM source_scan_events LIMIT 0").all();
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
  function saveReceipt(actorScope: string, tool: string, idempotencyKey: string, requestSignature: string, result: ImportReceipt | SyncRun | DiscoveryLeadReceipt | SourceScanPageReceipt | ReconciliationReceipt | LocationConfirmationReceipt | OfficeAddressReceipt | CompensationReviewReceipt | FxMutationReceipt | CompanyControlReviewReceipt) {
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
  function scanHistory(): SourceScanCheckpoint[] {
    return (db.prepare("SELECT document FROM source_scan_events ORDER BY rowid").all() as Array<{ document: string }>).map(row => checked(SourceScanCheckpointSchema, JSON.parse(row.document)));
  }
  function latestScans(sourceId?: string): SourceScanCheckpoint[] {
    const query = `SELECT event.document FROM source_scan_events event WHERE ${sourceId ? "event.source_id=? AND " : ""}event.version=(SELECT MAX(latest.version) FROM source_scan_events latest WHERE latest.scan_id=event.scan_id) ORDER BY event.rowid`;
    const rows = sourceId ? db.prepare(query).all(sourceId) : db.prepare(query).all();
    return (rows as Array<{ document: string }>).map(row => checked(SourceScanCheckpointSchema, JSON.parse(row.document)));
  }
  function scanForRun(runId: string, actorScope: string): SourceScanCheckpoint | undefined {
    const run = runById(runId);
    if (!run) throw new RepositoryError("not-found");
    if (run.actorScope !== actorScope) throw new RepositoryError("not-authorized");
    const row = run.scanId ? db.prepare("SELECT document FROM source_scan_events WHERE scan_id=? ORDER BY version DESC LIMIT 1").get(run.scanId) as { document: string } | undefined : undefined;
    return row ? checked(SourceScanCheckpointSchema, JSON.parse(row.document)) : undefined;
  }
  function saveScan(value: SourceScanCheckpoint) {
    const event = checked(SourceScanCheckpointSchema, value);
    db.prepare("INSERT INTO source_scan_events VALUES (?,?,?,?,?,?)").run(event.id, event.scanId, event.version, event.sourceId, event.actorScope, json(event));
    return event;
  }
  function evolveScan(prior: SourceScanCheckpoint, updates: Partial<SourceScanCheckpoint>): SourceScanCheckpoint {
    return saveScan({ ...prior, ...updates, id: `scan-event_${randomUUID()}`, version: prior.version + 1, at: now() });
  }
  function publicScan(value: SourceScanCheckpoint): SourceScanProgress {
    const run = runById(value.runId);
    if (!run) throw new RepositoryError("invalid-data");
    const running = run.status === "running";
    return checked(SourceScanProgressSchema, { scanId: value.scanId, sourceId: value.sourceId, runId: value.runId, version: value.version,
      scope: value.scope, state: value.state, running, canContinue: !running && (value.state === "ready" || value.state === "retry-page"),
      attemptedRecords: value.attemptedRecords, pages: value.pages, hadErrors: value.hadErrors, updatedAt: value.at,
      ...(value.invalidatedReason ? { invalidatedReason: value.invalidatedReason } : {}) });
  }
  function invalidateScans(sourceId: string, reason: NonNullable<SourceScanCheckpoint["invalidatedReason"]>) {
    for (const event of latestScans(sourceId).filter(value => value.state !== "invalidated")) evolveScan(event, { state: "invalidated", invalidatedReason: reason });
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
  function compensationDecisions(): CompensationReviewDecision[] {
    return (db.prepare("SELECT document FROM compensation_decisions ORDER BY revision").all() as Array<{ document: string }>).map(row => checked(CompensationReviewDecisionSchema, JSON.parse(row.document)));
  }
  function companyControlDecisions(): CompanyControlReviewDecision[] {
    return (db.prepare("SELECT document FROM company_control_decisions ORDER BY revision").all() as Array<{ document: string }>).map(row => checked(CompanyControlReviewDecisionSchema, JSON.parse(row.document)));
  }
  function fxSnapshots(): StoredFxSnapshot[] {
    return (db.prepare("SELECT revision,document FROM fx_snapshots ORDER BY revision").all() as Array<{ revision: number; document: string }>).map(row => checked(StoredFxSnapshotSchema, { revision: row.revision, snapshot: JSON.parse(row.document) }));
  }
  function fxActivations(): FxActivationEvent[] {
    return (db.prepare("SELECT document FROM fx_activations ORDER BY revision").all() as Array<{ document: string }>).map(row => checked(FxActivationEventSchema, JSON.parse(row.document)));
  }
  function activeFxSnapshotId(): string | null {
    const row = db.prepare("SELECT document FROM fx_activations ORDER BY revision DESC LIMIT 1").get() as { document: string } | undefined;
    return row ? checked(FxActivationEventSchema, JSON.parse(row.document)).activeSnapshotId : null;
  }
  function fxSnapshotById(id: string): StoredFxSnapshot | undefined {
    const row = db.prepare("SELECT revision,document FROM fx_snapshots WHERE id=?").get(id) as { revision: number; document: string } | undefined;
    return row ? checked(StoredFxSnapshotSchema, { revision: row.revision, snapshot: JSON.parse(row.document) }) : undefined;
  }
  function fxContext(): FxQueryContext {
    const selected = activeFxSnapshotId();
    const activeSnapshot = selected ? fxSnapshotById(selected)?.snapshot : undefined;
    if (selected && !activeSnapshot) throw new RepositoryError("invalid-data");
    const dayStart = `${now().slice(0, 10)}T00:00:00.000Z`;
    const asOf = activeSnapshot && Date.parse(activeSnapshot.retrievedAt) > Date.parse(dayStart) ? activeSnapshot.retrievedAt : dayStart;
    return checked(FxQueryContextSchema, { schemaVersion: 1, datasetRevision: revision(), asOf, ...(activeSnapshot ? { activeSnapshot } : {}) });
  }
  function fxReceipt(tool: "fx.confirm-import" | "fx.activate", input: unknown, options: ReconciliationWriteOptions) {
    validateOptions(options);
    const parsed = tool === "fx.confirm-import" ? checked(ConfirmFxImportInputSchema, input) : checked(ActivateFxSnapshotInputSchema, input);
    if (parsed.expectedRevision !== options.expectedRevision) throw new RepositoryError("invalid-data");
    const saved = receipt<FxMutationReceipt>(options.actorScope, tool, options.idempotencyKey, signature({ input: parsed }));
    return saved ? checked(FxMutationReceiptSchema, saved) : undefined;
  }
  function commitFx(event: FxActivationEvent, input: ConfirmFxImportInput | ActivateFxSnapshotInput, options: ReconciliationWriteOptions, snapshot?: FxReferenceSnapshot): FxMutationReceipt {
    options.throwIfCancelled?.();
    if (snapshot) {
      const existing = fxSnapshotById(snapshot.fx.id);
      if (existing && !same(existing.snapshot, snapshot)) throw new RepositoryError("conflict");
      if (!existing) {
        if ((db.prepare("SELECT COUNT(*) AS count FROM fx_snapshots").get() as { count: number }).count >= 1000) throw new RepositoryError("conflict");
        db.prepare("INSERT INTO fx_snapshots VALUES (?,?,?)").run(snapshot.fx.id, event.revision, json(snapshot));
      }
    }
    db.prepare("INSERT INTO fx_activations VALUES (?,?,?)").run(event.id, event.revision, json(event));
    db.prepare("UPDATE metadata SET value=? WHERE key='revision'").run(String(event.revision));
    const result = checked(FxMutationReceiptSchema, { ok: true, revision: event.revision, snapshotId: event.snapshotId, activeSnapshotId: event.activeSnapshotId });
    saveReceipt(options.actorScope, event.kind === "import" ? "fx.confirm-import" : "fx.activate", options.idempotencyKey, signature({ input }), result);
    options.throwIfCancelled?.();
    return result;
  }
  function baseSnapshot(current = read()): AtlasDataset {
    const jobs = (db.prepare("SELECT document FROM base_jobs ORDER BY id").all() as Array<{ document: string }>).map((row) => checked(CanonicalJobSchema, JSON.parse(row.document)));
    const owner = new Map(jobs.flatMap((job) => job.listingIds.map((id) => [id, job.id] as const)));
    const locations = (db.prepare("SELECT document FROM base_locations ORDER BY id").all() as Array<{ document: string }>).map(row => checked(JobLocationSchema, JSON.parse(row.document)));
    const compensations = (db.prepare("SELECT document FROM base_compensations ORDER BY id").all() as Array<{ document: string }>).map(row => checked(CompensationSchema, JSON.parse(row.document)));
    const companies = (db.prepare("SELECT document FROM base_companies ORDER BY id").all() as Array<{ document: string }>).map(row => checked(CompanySchema, JSON.parse(row.document)));
    return checked(AtlasDatasetSchema, stripCompanyControlReviewProjection({ ...current, companies, jobs, locations, compensations, listings: current.listings.map((listing) => ({ ...listing, ...(owner.has(listing.id) ? { canonicalJobId: owner.get(listing.id) } : {}) })) }, companyControlDecisions()));
  }
  function writeBaseJobs(jobs: readonly CanonicalJob[], replace = false) {
    if (replace) db.exec("DELETE FROM base_jobs");
    for (const job of jobs) db.prepare("INSERT INTO base_jobs(id,document) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document").run(job.id, json(job));
  }
  function writeBaseLocations(locations: readonly JobLocation[], replace = false) {
    if (replace) db.exec("DELETE FROM base_locations");
    for (const location of locations) {
      if (location.userResolution || location.officeResolution) throw new RepositoryError("conflict");
      db.prepare("INSERT INTO base_locations(id,document) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document").run(location.id, json(location));
    }
  }
  function writeBaseCompensations(compensations: readonly Compensation[], replace = false) {
    if (replace) db.exec("DELETE FROM base_compensations");
    for (const compensation of compensations) db.prepare("INSERT INTO base_compensations(id,document) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document").run(compensation.id, json(compensation));
  }
  function writeBaseCompanies(companies: readonly Company[], replace = false) {
    if (replace) db.exec("DELETE FROM base_companies");
    for (const company of companies) {
      if (company.controlReview) throw new RepositoryError("conflict");
      db.prepare("INSERT INTO base_companies(id,document) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document").run(company.id, json(company));
    }
  }
  function canonicalProjection(base: AtlasDataset, current: AtlasDataset, entries: readonly MergeDecision[], changedAt: string, locationEntries = locationDecisions(), officeEntries = officeDecisions(), compensationEntries = compensationDecisions(), companyEntries = companyControlDecisions()) {
    const projection = projectReconciliation(projectCompanyControlReviews(projectCompensationReviews(projectOfficeAddressConfirmations(projectLocationConfirmations(base, locationEntries), officeEntries), compensationEntries), companyEntries), entries);
    const old = new Map(current.jobs.map((job) => [job.id, job]));
    const body = (job: CanonicalJob, dataset: AtlasDataset) => { const { revision: _revision, updatedAt: _updatedAt, ...value } = job; return { job: value, company: dataset.companies.find(company => company.id === job.companyId), locations: job.locationIds.map(id => dataset.locations.find(location => location.id === id)), compensations: job.compensationIds.map(id => dataset.compensations.find(compensation => compensation.id === id)) }; };
    projection.dataset.jobs = projection.dataset.jobs.map((job) => {
      const previous = old.get(job.id);
      if (!previous && !db.prepare("SELECT job_id FROM job_versions WHERE job_id=?").get(job.id)) return job;
      const count = projection.aliases.filter((alias) => alias.canonicalJobId === job.id).length;
      if (previous && same(body(previous, current), body(job, projection.dataset))) return count === 1 && job.revision > previous.revision ? job : previous;
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
    // Invalidation is recorded in the same transaction as every source mutation,
    // including public imports. An A -> B -> A edit cannot revive old cursors.
    if (!replace) for (const row of db.prepare("SELECT id,document FROM sources").all() as Array<{ id: string; document: string }>) {
      const next = dataset.sources.find(source => source.sourceId === row.id);
      if (!next || !same(JSON.parse(row.document), next)) invalidateScans(row.id, "source-config-changed");
    }
    const obsoleteMaterials = { sources: [] as string[], listings: [] as string[], observations: [] as string[] };
    if (!replace) {
      for (const table of ["sources", "listings", "observations"] as const) {
        const retained = new Set(dataset[table].map(value => sourceIdOrId(table, value)));
        obsoleteMaterials[table] = (db.prepare(`SELECT id FROM ${table} WHERE id GLOB 'company-control-review-*'`).all() as Array<{ id: string }>).map(row => row.id).filter(id => isCompanyControlReviewEntityId(id) && !retained.has(id));
      }
      if (Object.values(obsoleteMaterials).some(ids => ids.length)) {
        const previous = read();
        // Only exact, reproducible review projections can leave the public index. Their
        // complete raw documents remain immutable in company_control_decisions.
        stripCompanyControlReviewProjection(previous, companyControlDecisions().filter(entry => entry.revision <= previous.revision));
      }
    }
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
    if (obsoleteMaterials.observations.length) db.exec("DROP TRIGGER observations_no_delete;");
    for (const table of ["observations", "listings", "sources"] as const) for (const id of obsoleteMaterials[table]) db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
    if (obsoleteMaterials.observations.length) db.exec("CREATE TRIGGER observations_no_delete BEFORE DELETE ON observations BEGIN SELECT RAISE(ABORT,'immutable-observation'); END;");
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
  function compensationTarget(current: AtlasDataset, jobId: string, compensationId: string) {
    const job = current.jobs.find(value => value.id === aliasId(jobId));
    const base = baseSnapshot(current), original = base.compensations.find(value => value.id === compensationId);
    if (!job || !original || !job.compensationIds.includes(compensationId)) throw new RepositoryError("not-found");
    const owners = base.jobs.filter(value => value.compensationIds.includes(compensationId));
    const explicitListings = base.listings.filter(value => value.compensationIds?.includes(compensationId));
    // Older source rows predate per-listing salary contributions. Exact retained observation
    // ownership can bind those rows; array order and a job's employer name cannot.
    const evidenceListings = new Set(original.evidence.map(ref => base.observations.find(value => value.id === ref.observationId)?.listingId));
    const listings = explicitListings.length ? explicitListings : evidenceListings.size === 1 ? base.listings.filter(value => evidenceListings.has(value.id)) : [];
    if (owners.length !== 1 || listings.length !== 1 || !owners[0]!.listingIds.includes(listings[0]!.id) || !job.listingIds.includes(listings[0]!.id)) throw new RepositoryError("conflict");
    if (original.evidence.some(ref => base.observations.find(value => value.id === ref.observationId)?.listingId !== listings[0]!.id)) throw new RepositoryError("conflict");
    return { base, original, owner: owners[0]!, listing: listings[0]!, job };
  }
  function activeCompensationDecision(base: AtlasDataset, entries: readonly CompensationReviewDecision[], compensationId: string) {
    const inactive = new Set(entries.flatMap(entry => entry.kind === "revoke" ? [entry.targetDecisionId] : entry.kind === "invalidate" ? entry.targetDecisionIds : []));
    for (const id of getInvalidatedCompensationReviewIds(base, entries)) inactive.add(id);
    return [...entries].reverse().find((entry): entry is Extract<CompensationReviewDecision, { kind: "confirm" }> => entry.kind === "confirm" && entry.compensationId === compensationId && !inactive.has(entry.id));
  }
  function prepareCompensation(input: PreviewCompensationReviewInput, current: AtlasDataset) {
    if (current.revision !== input.expectedRevision) throw new RepositoryError("stale-version");
    const target = compensationTarget(current, input.jobId, input.compensationId);
    let proposed: Compensation;
    try { proposed = validateCompensationReviewProposal(target.base, { jobId: target.owner.id, compensationId: input.compensationId, listingId: target.listing.id, sourceCompensation: target.original, proposal: input.proposal }); }
    catch { throw new RepositoryError("invalid-data"); }
    const active = activeCompensationDecision(target.base, compensationDecisions(), input.compensationId);
    const preview = checked(CompensationReviewPreviewSchema, { expectedRevision: current.revision,
      previewFingerprint: signature({ input, sourceCompensation: target.original, ownerJobId: target.owner.id, listingId: target.listing.id,
        sourceBinding: captureCompensationReviewSourceBinding(target.base, { jobId: target.owner.id, listingId: target.listing.id, compensationId: input.compensationId, sourceCompensation: target.original, proposal: input.proposal }) }),
      jobId: input.jobId, compensationId: input.compensationId, listingId: target.listing.id, sourceCompensation: target.original,
      current: current.compensations.find(value => value.id === input.compensationId)!, proposed,
      ...(active ? { activeDecisionId: active.id } : {}), warnings: [
        "这是本人依据已保存来源证据核对的薪资口径，仍为待核实；原始薪资文本、地点范围和来源证据保留。",
        "税前、固定薪资、发薪月数与工作时数需要各自的明确依据；不把奖金、股票或税后金额当固定税前年薪。",
        "来源薪资或岗位绑定变化会永久停用已有核对；撤销保留历史，仅恢复仍适配当前来源的前次核对。",
      ] });
    return { preview, target };
  }
  function commitCompensation(current: AtlasDataset, entry: Exclude<CompensationReviewDecision, { kind: "invalidate" }>, options: ReconciliationWriteOptions, tool: string, requestSignature: string, requestedJobId: string): CompensationReviewReceipt {
    options.throwIfCancelled?.();
    const entries = [...compensationDecisions(), entry], base = { ...baseSnapshot(current), revision: entry.revision };
    const projection = canonicalProjection(base, current, decisions(), entry.at, locationDecisions(), officeDecisions(), entries);
    projection.dataset.revision = entry.revision;
    db.prepare("INSERT INTO compensation_decisions VALUES (?,?,?)").run(entry.id, entry.revision, json(entry));
    write(projection.dataset);
    const compensation = projection.dataset.compensations.find(value => value.id === entry.compensationId)!;
    const active = activeCompensationDecision(base, entries, entry.compensationId);
    const result = checked(CompensationReviewReceiptSchema, { ok: true, revision: entry.revision, jobId: requestedJobId, compensationId: entry.compensationId,
      decisionId: entry.id, ...(active ? { activeDecisionId: active.id } : {}), compensation });
    saveReceipt(options.actorScope, tool, options.idempotencyKey, requestSignature, result);
    return result;
  }
  function companyControlTarget(current: AtlasDataset, jobId: string, companyId: string) {
    const base = baseSnapshot(current), sourceCompany = base.companies.find(value => value.id === companyId);
    const owner = base.jobs.find(value => value.id === jobId), job = current.jobs.find(value => value.id === aliasId(jobId));
    if (!sourceCompany || !owner || owner.companyId !== companyId || !job || !owner.listingIds.every(id => job.listingIds.includes(id))) throw new RepositoryError("not-found");
    return { base, sourceCompany, owner, job };
  }
  function activeCompanyControlDecision(base: AtlasDataset, entries: readonly CompanyControlReviewDecision[], companyId: string) {
    const inactive = new Set(entries.flatMap(entry => entry.kind === "revoke" ? [entry.targetDecisionId] : entry.kind === "invalidate" ? entry.targetDecisionIds : []));
    for (const id of getInvalidatedCompanyControlReviewIds(base, entries)) inactive.add(id);
    return [...entries].reverse().find((entry): entry is Extract<CompanyControlReviewDecision, { kind: "confirm" }> => entry.kind === "confirm" && entry.companyId === companyId && !inactive.has(entry.id));
  }
  function affectedCompanyJobs(dataset: AtlasDataset, companyId: string) { return dataset.jobs.filter(value => value.companyId === companyId).map(value => value.id).sort(compareIds); }
  function prepareCompanyControl(input: PreviewCompanyControlReviewInput, current: AtlasDataset) {
    if (current.revision !== input.expectedRevision) throw new RepositoryError("stale-version");
    const target = companyControlTarget(current, input.jobId, input.companyId);
    let proposed: Company;
    try {
      if (input.proposal.documents.some(value => Date.parse(value.retrievedAt) > Date.parse(now()))) throw new Error("future-evidence");
      proposed = validateCompanyControlReviewProposal(target.base, { jobId: target.owner.id, companyId: input.companyId, sourceCompany: target.sourceCompany, proposal: input.proposal });
    } catch { throw new RepositoryError("invalid-data"); }
    const active = activeCompanyControlDecision(target.base, companyControlDecisions(), input.companyId);
    const sourceBinding = captureCompanyControlReviewSourceBinding(target.base, { jobId: target.owner.id, companyId: input.companyId, sourceCompany: target.sourceCompany });
    try { validateCompanyControlSourceTimes(target.sourceCompany, sourceBinding, now()); } catch { throw new RepositoryError("invalid-data"); }
    const preview = checked(CompanyControlReviewPreviewSchema, { expectedRevision: current.revision, previewFingerprint: signature({ input, sourceCompany: target.sourceCompany, sourceBinding }),
      jobId: input.jobId, companyId: input.companyId, sourceCompany: target.sourceCompany, current: current.companies.find(value => value.id === input.companyId)!, proposed,
      affectedJobIds: affectedCompanyJobs(target.base, input.companyId), ...(active ? { activeDecisionId: active.id } : {}), warnings: [
        "这是本人对所引用原文的核对，不表示发布机构或官方认证；办公地点和品牌印象不证明最终控股来源。",
        "核对仅应用于同一公司标识的岗位，来源身份或相关证据变化会永久停用；新增同公司岗位不导致失效。",
        "原始公司资料和旧手工覆盖保留，撤销仅恢复仍适用的前次核对或来源分类。",
      ] });
    return { preview, target, sourceBinding };
  }
  function companyControlReceipt(tool: "companies.confirm-control-review" | "companies.revoke-control-review", input: unknown, options: ReconciliationWriteOptions) {
    validateOptions(options);
    const parsed = tool === "companies.confirm-control-review" ? checked(ConfirmCompanyControlReviewInputSchema, input) : checked(RevokeCompanyControlReviewInputSchema, input);
    if (parsed.expectedRevision !== options.expectedRevision) throw new RepositoryError("invalid-data");
    const saved = receipt<CompanyControlReviewReceipt>(options.actorScope, tool, options.idempotencyKey, signature({ input: parsed }));
    return saved ? checked(CompanyControlReviewReceiptSchema, saved) : undefined;
  }
  function commitCompanyControl(current: AtlasDataset, entry: Exclude<CompanyControlReviewDecision, { kind: "invalidate" }>, options: ReconciliationWriteOptions, tool: string, requestSignature: string, requestedJobId: string): CompanyControlReviewReceipt {
    options.throwIfCancelled?.();
    try { validateCompanyControlSourceTimes(entry.sourceCompany, entry.sourceBinding, entry.at); } catch { throw new RepositoryError("invalid-data"); }
    const entries = [...companyControlDecisions(), entry], base = { ...baseSnapshot(current), revision: entry.revision };
    const projection = canonicalProjection(base, current, decisions(), entry.at, locationDecisions(), officeDecisions(), compensationDecisions(), entries);
    projection.dataset.revision = entry.revision;
    db.prepare("INSERT INTO company_control_decisions VALUES (?,?,?)").run(entry.id, entry.revision, json(entry));
    write(projection.dataset);
    const active = activeCompanyControlDecision(base, entries, entry.companyId);
    const result = checked(CompanyControlReviewReceiptSchema, { ok: true, revision: entry.revision, jobId: requestedJobId, companyId: entry.companyId, decisionId: entry.id,
      ...(active ? { activeDecisionId: active.id } : {}), company: projection.dataset.companies.find(value => value.id === entry.companyId)!, affectedJobIds: entry.affectedJobIds });
    saveReceipt(options.actorScope, tool, options.idempotencyKey, requestSignature, result);
    options.throwIfCancelled?.();
    return result;
  }

  function importSnapshotNow(input: unknown, importOptions: ImportOptions): ImportReceipt {
      validateOptions(importOptions);
      const incoming = checked(AtlasDatasetObjectSchema, input);
      if (incoming.locations.some(location => location.userResolution || location.officeResolution)) throw new RepositoryError("conflict");
      if (incoming.companies.some(company => company.controlReview) || TABLES.some(table => incoming[table].some(value => isCompanyControlReviewEntityId(sourceIdOrId(table, value))))) throw new RepositoryError("conflict");
      const requestSignature = signature({ ...(importOptions.requestFingerprint === undefined ? { input: incoming } : { requestFingerprint: importOptions.requestFingerprint }), expectedRevision: importOptions.expectedRevision, runId: importOptions.runId });
        const cached = receipt<ImportReceipt>(importOptions.actorScope, "dataset.import", importOptions.idempotencyKey, requestSignature);
        if (cached) return checked(ImportReceiptSchema, cached);
        const current = read();
        if (importOptions.expectedRevision !== undefined && current.revision !== importOptions.expectedRevision) throw new RepositoryError("stale-version");
        const run = importOptions.runId ? currentRun(importOptions.runId, importOptions.actorScope) : undefined;
        const base = baseSnapshot(current);
        const nextBase = merged(base, incoming);
        if (run) validateRunDelta(incoming, nextBase, base, run);
        verifyContentHashes(nextBase);
        const priorOffice = officeDecisions();
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
        const priorCompensation = compensationDecisions();
        const invalidatedCompensationIds = getInvalidatedCompensationReviewIds(nextBase, priorCompensation);
        const compensationInvalidation: CompensationReviewDecision | undefined = invalidatedCompensationIds.length ? { id: `compensation-invalidate_${randomUUID()}`, kind: "invalidate", actorScope: importOptions.actorScope,
          at: now(), revision: current.revision + 1, reason: "source-changed", targetDecisionIds: invalidatedCompensationIds } : undefined;
        const priorCompany = companyControlDecisions(), invalidatedCompanyIds = getInvalidatedCompanyControlReviewIds(nextBase, priorCompany);
        const companyInvalidation: CompanyControlReviewDecision | undefined = invalidatedCompanyIds.length ? { id: `company-control-invalidate_${randomUUID()}`, kind: "invalidate", actorScope: importOptions.actorScope,
          at: now(), revision: current.revision + 1, reason: "source-changed", targetDecisionIds: invalidatedCompanyIds } : undefined;
        if (invalidation || compensationInvalidation || companyInvalidation) nextBase.revision = current.revision + 1;
        const projection = canonicalProjection(nextBase, current, decisions(), now(), locationDecisions(), [...priorOffice, ...(invalidation ? [invalidation] : [])], [...priorCompensation, ...(compensationInvalidation ? [compensationInvalidation] : [])], [...priorCompany, ...(companyInvalidation ? [companyInvalidation] : [])]);
        const next = projection.dataset;
        const changed = TABLES.some((table) => !same(base[table], nextBase[table])) || TABLES.some((table) => !same(current[table], next[table]));
        next.revision = current.revision + Number(changed);
        const targets = new Set(incoming.jobs.map((job) => projection.aliases.find((alias) => alias.jobId === job.id)!.canonicalJobId));
        const effectiveIncoming = { ...incoming, jobs: next.jobs.filter((job) => targets.has(job.id)) };
        const result: ImportReceipt = { ok: true, revision: next.revision, jobIds: effectiveIncoming.jobs.map((job) => job.id), snapshotIds: incoming.snapshots.map((snapshot) => snapshot.id), counts: counts(current, next, effectiveIncoming) };
        if (changed) {
          if (invalidation) db.prepare("INSERT INTO office_decisions VALUES (?,?,?)").run(invalidation.id, invalidation.revision, json(invalidation));
          if (compensationInvalidation) db.prepare("INSERT INTO compensation_decisions VALUES (?,?,?)").run(compensationInvalidation.id, compensationInvalidation.revision, json(compensationInvalidation));
          if (companyInvalidation) db.prepare("INSERT INTO company_control_decisions VALUES (?,?,?)").run(companyInvalidation.id, companyInvalidation.revision, json(companyInvalidation));
          writeBaseJobs(nextBase.jobs); writeBaseLocations(nextBase.locations); writeBaseCompensations(nextBase.compensations); writeBaseCompanies(nextBase.companies); write(next); saveAliases(projection.aliases, next.revision, now());
        }
        saveReceipt(importOptions.actorScope, "dataset.import", importOptions.idempotencyKey, requestSignature, result);
        return result;
  }
  function saveDiscoveryLeadsNow(input: readonly DiscoveryLead[], importOptions: Omit<ImportOptions, "expectedRevision">): DiscoveryLeadReceipt {
      validateOptions(importOptions);
      if (!Array.isArray(input) || input.length > 100_000) throw new RepositoryError("invalid-data");
      const leads = input.map((lead) => checked(DiscoveryLeadSchema, lead));
      if (new Set(leads.map((lead) => lead.id)).size !== leads.length) throw new RepositoryError("conflict");
      const requestSignature = signature({ leads, runId: importOptions.runId });
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
  }

  return {
    async readSnapshot(): Promise<AtlasDataset> { return transaction(read); },
    /** Lead documents, effective owners and the original projection basis share one revision. */
    async readLeadSnapshot(): Promise<{ dataset: AtlasDataset; projection: AtlasDataset; leads: DiscoveryLead[] }> {
      return transaction(() => {
        const dataset = read();
        const leads = (db.prepare("SELECT document FROM discovery_leads ORDER BY id").all() as Array<{ document: string }>)
          .map(row => checked(DiscoveryLeadSchema, JSON.parse(row.document)));
        return { dataset, projection: baseSnapshot(dataset), leads };
      });
    },
    /** Capture the FX selection and public dataset in one SQLite transaction. */
    async readFxQuerySnapshot(): Promise<{ dataset: AtlasDataset; context: FxQueryContext }> {
      const captured = transaction(() => ({ dataset: read(), context: fxContext() }));
      if (captured.context.activeSnapshot) {
        try { await validateFxReferenceSnapshot(captured.context.activeSnapshot, { now: now() }); }
        catch { throw new RepositoryError("invalid-data"); }
        transaction(() => { if (revision() !== captured.dataset.revision) throw new RepositoryError("stale-version"); });
      }
      return captured;
    },
    async readFxState(input: unknown = {}): Promise<FxState> {
      const parsed = checked(ReadFxStateInputSchema, input);
      const state = transaction(() => {
        if (parsed.expectedRevision !== undefined && revision() !== parsed.expectedRevision) throw new RepositoryError("stale-version");
        return checked(FxStateSchema, { schemaVersion: 1, revision: revision(), context: fxContext(), snapshots: fxSnapshots().map(value => value.snapshot) });
      });
      try { for (const snapshot of state.snapshots) await validateFxReferenceSnapshot(snapshot, { now: now() }); }
      catch { throw new RepositoryError("invalid-data"); }
      // Validation is asynchronous: never return a state under a revision that changed during it.
      transaction(() => { if (revision() !== state.revision) throw new RepositoryError("stale-version"); });
      return state;
    },
    async previewFxImport(input: unknown): Promise<FxImportPreview> {
      const parsed = checked(PreviewFxImportInputSchema, input);
      transaction(() => { if (revision() !== parsed.expectedRevision) throw new RepositoryError("stale-version"); });
      let preview: FxImportPreview;
      try { preview = await buildFxImportPreview(parsed, { now: now() }); } catch { throw new RepositoryError("invalid-data"); }
      transaction(() => { if (revision() !== parsed.expectedRevision) throw new RepositoryError("stale-version"); });
      return preview;
    },
    async findFxReceipt(tool: "fx.confirm-import" | "fx.activate", input: unknown, options: ReconciliationWriteOptions): Promise<FxMutationReceipt | undefined> {
      return transaction(() => fxReceipt(tool, input, options));
    },
    async confirmFxImport(input: unknown, options: ReconciliationWriteOptions): Promise<FxMutationReceipt> {
      validateOptions(options); const parsed = checked(ConfirmFxImportInputSchema, input);
      if (parsed.expectedRevision !== options.expectedRevision) throw new RepositoryError("invalid-data");
      const cached = transaction(() => fxReceipt("fx.confirm-import", parsed, options));
      if (cached) return cached;
      let preview: FxImportPreview;
      try { preview = await buildFxImportPreview({ draft: parsed.draft, expectedRevision: parsed.expectedRevision }, { now: now() }); }
      catch { throw new RepositoryError("invalid-data"); }
      return transaction(() => {
        const saved = fxReceipt("fx.confirm-import", parsed, options); if (saved) return saved;
        if (revision() !== parsed.expectedRevision || preview.previewFingerprint !== parsed.previewFingerprint) throw new RepositoryError("stale-version");
        const event = checked(FxActivationEventSchema, { id: `fx-import_${randomUUID()}`, revision: revision() + 1, at: now(), actorScope: options.actorScope,
          kind: "import", snapshotId: preview.snapshot.fx.id, activeSnapshotId: parsed.activate ? preview.snapshot.fx.id : activeFxSnapshotId(),
          activate: parsed.activate, previewFingerprint: parsed.previewFingerprint });
        return commitFx(event, parsed, options, preview.snapshot);
      });
    },
    async activateFxSnapshot(input: unknown, options: ReconciliationWriteOptions): Promise<FxMutationReceipt> {
      validateOptions(options); const parsed = checked(ActivateFxSnapshotInputSchema, input);
      if (parsed.expectedRevision !== options.expectedRevision) throw new RepositoryError("invalid-data");
      return transaction(() => {
        const cached = fxReceipt("fx.activate", parsed, options); if (cached) return cached;
        if (revision() !== parsed.expectedRevision) throw new RepositoryError("stale-version");
        if (parsed.snapshotId !== null && !fxSnapshotById(parsed.snapshotId)) throw new RepositoryError("not-found");
        const event = checked(FxActivationEventSchema, { id: `fx-activate_${randomUUID()}`, revision: revision() + 1, at: now(), actorScope: options.actorScope,
          kind: "activate", snapshotId: parsed.snapshotId, activeSnapshotId: parsed.snapshotId });
        return commitFx(event, parsed, options);
      });
    },
    /** Ingestion-only origins: never use this view for map totals or user-facing search. */
    async readProjectionSnapshot(): Promise<AtlasDataset> { return transaction(() => baseSnapshot()); },
    async readCompanyControlReview(input: unknown): Promise<CompanyControlReviewReadResult> {
      const parsed = checked(ReadCompanyControlReviewInputSchema, input);
      return transaction(() => {
        const current = read(); if (current.revision !== parsed.expectedRevision) throw new RepositoryError("stale-version");
        const target = companyControlTarget(current, parsed.jobId, parsed.companyId), entries = companyControlDecisions(), active = activeCompanyControlDecision(target.base, entries, parsed.companyId);
        const ids = new Set(entries.filter(entry => entry.kind !== "invalidate" && entry.companyId === parsed.companyId).map(entry => entry.id));
        return checked(CompanyControlReviewReadResultSchema, { schemaVersion: 1, revision: current.revision, jobId: parsed.jobId, companyId: parsed.companyId, sourceCompany: target.sourceCompany,
          current: current.companies.find(value => value.id === parsed.companyId)!, affectedJobIds: affectedCompanyJobs(target.base, parsed.companyId), ...(active ? { activeDecisionId: active.id } : {}),
          history: entries.filter(entry => entry.kind === "invalidate" ? entry.targetDecisionIds.some(id => ids.has(id)) : entry.companyId === parsed.companyId)
            .map(entry => entry.kind === "invalidate" ? { ...entry, targetDecisionIds: entry.targetDecisionIds.filter(id => ids.has(id)) } : entry) });
      });
    },
    async previewCompanyControlReview(input: unknown): Promise<CompanyControlReviewPreview> {
      const parsed = checked(PreviewCompanyControlReviewInputSchema, input);
      return transaction(() => prepareCompanyControl(parsed, read()).preview);
    },
    async findCompanyControlReviewReceipt(tool: "companies.confirm-control-review" | "companies.revoke-control-review", input: unknown, options: ReconciliationWriteOptions): Promise<CompanyControlReviewReceipt | undefined> {
      return transaction(() => companyControlReceipt(tool, input, options));
    },
    async confirmCompanyControlReview(input: unknown, options: ReconciliationWriteOptions): Promise<CompanyControlReviewReceipt> {
      validateOptions(options); const parsed = checked(ConfirmCompanyControlReviewInputSchema, input);
      if (options.expectedRevision !== parsed.expectedRevision) throw new RepositoryError("invalid-data");
      const cached = transaction(() => companyControlReceipt("companies.confirm-control-review", parsed, options)); if (cached) return cached;
      options.throwIfCancelled?.();
      let materials: Awaited<ReturnType<typeof buildCompanyControlReviewMaterials>>;
      try { materials = await buildCompanyControlReviewMaterials(parsed.proposal, { now: now() }); } catch { throw new RepositoryError("invalid-data"); }
      return transaction(() => {
        const saved = companyControlReceipt("companies.confirm-control-review", parsed, options); if (saved) return saved;
        const current = read(); assertWriteVersion(options, current);
        const { reviewed: _reviewed, previewFingerprint, ...previewInput } = parsed, { preview, target, sourceBinding } = prepareCompanyControl(previewInput, current);
        if (preview.previewFingerprint !== previewFingerprint) throw new RepositoryError("stale-version");
        const entry = checked(CompanyControlReviewDecisionSchema, { id: `company-control-confirm_${randomUUID()}`, kind: "confirm", jobId: target.owner.id, companyId: parsed.companyId,
          sourceCompany: target.sourceCompany, sourceBinding, proposal: parsed.proposal, materials, affectedJobIds: affectedCompanyJobs(target.base, parsed.companyId), actorScope: options.actorScope, at: now(), revision: current.revision + 1, reason: parsed.reason });
        if (entry.kind === "invalidate") throw new RepositoryError("invalid-data");
        return commitCompanyControl(current, entry, options, "companies.confirm-control-review", signature({ input: parsed }), parsed.jobId);
      });
    },
    async revokeCompanyControlReview(input: unknown, options: ReconciliationWriteOptions): Promise<CompanyControlReviewReceipt> {
      validateOptions(options); const parsed = checked(RevokeCompanyControlReviewInputSchema, input);
      if (options.expectedRevision !== parsed.expectedRevision) throw new RepositoryError("invalid-data");
      return transaction(() => {
        const cached = companyControlReceipt("companies.revoke-control-review", parsed, options); if (cached) return cached;
        const current = read(); assertWriteVersion(options, current);
        const entries = companyControlDecisions(), prior = entries.find(value => value.id === parsed.decisionId);
        if (!prior || prior.kind !== "confirm" || prior.companyId !== parsed.companyId) throw new RepositoryError("not-found");
        if (prior.actorScope !== options.actorScope) throw new RepositoryError("not-authorized");
        if (entries.some(value => value.kind === "revoke" && value.targetDecisionId === prior.id)) throw new RepositoryError("conflict");
        const target = companyControlTarget(current, parsed.jobId, parsed.companyId);
        const entry = checked(CompanyControlReviewDecisionSchema, { id: `company-control-revoke_${randomUUID()}`, kind: "revoke", jobId: target.owner.id, companyId: parsed.companyId,
          sourceCompany: target.sourceCompany, sourceBinding: captureCompanyControlReviewSourceBinding(target.base, { jobId: target.owner.id, companyId: parsed.companyId, sourceCompany: target.sourceCompany }),
          affectedJobIds: affectedCompanyJobs(target.base, parsed.companyId), actorScope: options.actorScope, at: now(), revision: current.revision + 1, reason: parsed.reason, targetDecisionId: prior.id });
        if (entry.kind === "invalidate") throw new RepositoryError("invalid-data");
        return commitCompanyControl(current, entry, options, "companies.revoke-control-review", signature({ input: parsed }), parsed.jobId);
      });
    },
    async readCompensationReview(input: unknown): Promise<CompensationReviewReadResult> {
      const parsed = checked(ReadCompensationReviewInputSchema, input);
      return transaction(() => {
        const current = read(); if (current.revision !== parsed.expectedRevision) throw new RepositoryError("stale-version");
        const target = compensationTarget(current, parsed.jobId, parsed.compensationId), entries = compensationDecisions();
        const active = activeCompensationDecision(target.base, entries, parsed.compensationId);
        const ids = new Set(entries.filter(entry => entry.kind !== "invalidate" && entry.compensationId === parsed.compensationId).map(entry => entry.id));
        return checked(CompensationReviewReadResultSchema, { schemaVersion: 1, revision: current.revision, jobId: parsed.jobId, compensationId: parsed.compensationId,
          listingId: target.listing.id, sourceCompensation: target.original, current: current.compensations.find(value => value.id === parsed.compensationId)!,
          ...(active ? { activeDecisionId: active.id } : {}), history: entries.filter(entry => entry.kind === "invalidate" ? entry.targetDecisionIds.some(id => ids.has(id)) : entry.compensationId === parsed.compensationId)
            .map(entry => entry.kind === "invalidate" ? { ...entry, targetDecisionIds: entry.targetDecisionIds.filter(id => ids.has(id)) } : entry) });
      });
    },
    async previewCompensationReview(input: unknown): Promise<CompensationReviewPreview> {
      const parsed = checked(PreviewCompensationReviewInputSchema, input);
      return transaction(() => prepareCompensation(parsed, read()).preview);
    },
    async findCompensationReviewReceipt(tool: "compensations.confirm-review" | "compensations.revoke-review", input: unknown, options: ReconciliationWriteOptions): Promise<CompensationReviewReceipt | undefined> {
      validateOptions(options);
      const parsed = tool === "compensations.confirm-review" ? checked(ConfirmCompensationReviewInputSchema, input) : checked(RevokeCompensationReviewInputSchema, input);
      if (parsed.expectedRevision !== options.expectedRevision) throw new RepositoryError("invalid-data");
      const requestSignature = signature({ input: parsed });
      return transaction(() => { const saved = receipt<CompensationReviewReceipt>(options.actorScope, tool, options.idempotencyKey, requestSignature); return saved ? checked(CompensationReviewReceiptSchema, saved) : undefined; });
    },
    async confirmCompensationReview(input: ConfirmCompensationReviewInput, options: ReconciliationWriteOptions): Promise<CompensationReviewReceipt> {
      validateOptions(options); const parsed = checked(ConfirmCompensationReviewInputSchema, input);
      if (options.expectedRevision !== parsed.expectedRevision) throw new RepositoryError("invalid-data");
      const requestSignature = signature({ input: parsed });
      return transaction(() => {
        const cached = receipt<CompensationReviewReceipt>(options.actorScope, "compensations.confirm-review", options.idempotencyKey, requestSignature);
        if (cached) return checked(CompensationReviewReceiptSchema, cached);
        const current = read(); assertWriteVersion(options, current);
        const { reviewed: _reviewed, previewFingerprint, ...previewInput } = parsed;
        const { preview, target } = prepareCompensation(previewInput, current);
        if (preview.previewFingerprint !== previewFingerprint) throw new RepositoryError("stale-version");
        const entry: CompensationReviewDecision = { id: `compensation-confirm_${randomUUID()}`, kind: "confirm", jobId: target.owner.id, listingId: target.listing.id, compensationId: parsed.compensationId,
          sourceCompensation: target.original, sourceBinding: captureCompensationReviewSourceBinding(target.base, { jobId: target.owner.id, listingId: target.listing.id, compensationId: parsed.compensationId, sourceCompensation: target.original, proposal: parsed.proposal }),
          proposal: parsed.proposal, actorScope: options.actorScope, at: now(), revision: current.revision + 1, reason: parsed.reason };
        return commitCompensation(current, entry, options, "compensations.confirm-review", requestSignature, parsed.jobId);
      });
    },
    async revokeCompensationReview(input: RevokeCompensationReviewInput, options: ReconciliationWriteOptions): Promise<CompensationReviewReceipt> {
      validateOptions(options); const parsed = checked(RevokeCompensationReviewInputSchema, input);
      if (options.expectedRevision !== parsed.expectedRevision) throw new RepositoryError("invalid-data");
      const requestSignature = signature({ input: parsed });
      return transaction(() => {
        const cached = receipt<CompensationReviewReceipt>(options.actorScope, "compensations.revoke-review", options.idempotencyKey, requestSignature);
        if (cached) return checked(CompensationReviewReceiptSchema, cached);
        const current = read(); assertWriteVersion(options, current);
        const entries = compensationDecisions(), target = entries.find(value => value.id === parsed.decisionId);
        if (!target || target.kind !== "confirm" || target.compensationId !== parsed.compensationId) throw new RepositoryError("not-found");
        if (target.actorScope !== options.actorScope) throw new RepositoryError("not-authorized");
        const job = current.jobs.find(value => value.id === aliasId(parsed.jobId));
        if (!job?.listingIds.includes(target.listingId)) throw new RepositoryError("not-found");
        if (entries.some(value => value.kind === "revoke" && value.targetDecisionId === target.id)) throw new RepositoryError("conflict");
        const base = baseSnapshot(current), sourceCompensation = base.compensations.find(value => value.id === target.compensationId);
        if (!sourceCompensation) throw new RepositoryError("not-found");
        const entry: CompensationReviewDecision = { id: `compensation-revoke_${randomUUID()}`, kind: "revoke", jobId: target.jobId, listingId: target.listingId, compensationId: target.compensationId,
          actorScope: options.actorScope, at: now(), revision: current.revision + 1, reason: parsed.reason, targetDecisionId: target.id, sourceCompensation,
          sourceBinding: captureCompensationReviewSourceBinding(base, { listingId: target.listingId, sourceCompensation }) };
        return commitCompensation(current, entry, options, "compensations.revoke-review", requestSignature, parsed.jobId);
      });
    },
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
      return transaction(() => importSnapshotNow(input, importOptions));
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
        const dataset = read();
        return { dataset, originDataset: projectCompanyControlReviews(projectCompensationReviews(projectOfficeAddressConfirmations(projectLocationConfirmations(baseSnapshot(dataset), locationDecisions()), officeDecisions()), compensationDecisions()), companyControlDecisions()), decisions: decisions(), aliases: (db.prepare("SELECT job_id,canonical_job_id FROM job_aliases ORDER BY job_id").all() as Array<{ job_id: string; canonical_job_id: string }>).map(row => ({ jobId: row.job_id, canonicalJobId: row.canonical_job_id })) };
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
      if (isCompanyControlReviewEntityId(source.sourceId)) throw new RepositoryError("conflict");
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
        const scanScope = input.scan ? checked(SourceScopeSchema, input.scan.scope) : undefined;
        let continued: SourceScanCheckpoint | undefined;
        if (input.scan) {
          if (sourceConfigurationFingerprint(source) !== input.scan.sourceFingerprint || !same(scanScope, { roles: scope.keywords ?? [], regions: scope.regions ?? [], companyNames: scope.companies ?? [], ...(scope.countryCodes ? { countryCodes: scope.countryCodes } : {}) })) throw new RepositoryError("stale-version");
          if (input.scan.continue) {
            const command = input.scan.continue;
            continued = scanForRun(command.fromRunId, input.actorScope);
            if (!continued || command.sourceId !== source.sourceId || continued.sourceId !== source.sourceId || continued.runId !== command.fromRunId
              || continued.version !== command.expectedProgressVersion || continued.sourceFingerprint !== input.scan.sourceFingerprint
              || continued.scopeFingerprint !== sourceScanFingerprint(scanScope) || !publicScan(continued).canContinue) throw new RepositoryError("stale-version");
          }
        }
        const latestRow = db.prepare("SELECT document FROM runs WHERE source_id=? ORDER BY generation DESC LIMIT 1").get(input.sourceId) as { document: string } | undefined;
        const startedAt = now();
        if (latestRow && Date.parse(startedAt) - Date.parse(checked(SyncRunSchema, JSON.parse(latestRow.document)).startedAt) < source.refreshPolicy.minIntervalSeconds * 1000) throw new RepositoryError("rate-limited");
        if (source.refreshPolicy.maxRequestsPerUtcDay !== undefined) {
          const utcDay = startedAt.slice(0, 10);
          const daily = db.prepare("SELECT COUNT(*) AS count FROM runs WHERE source_id=? AND substr(json_extract(document,'$.startedAt'),1,10)=?").get(input.sourceId, utcDay) as { count: number };
          if (daily.count >= source.refreshPolicy.maxRequestsPerUtcDay) throw new RepositoryError("rate-limited");
        }
        if (!input.scan) invalidateScans(source.sourceId, "new-scan");
        const previous = db.prepare("SELECT document FROM runs WHERE source_id=? AND status='running'").all(input.sourceId) as Array<{ document: string }>;
        for (const row of previous) saveRun({ ...checked(SyncRunSchema, JSON.parse(row.document)), status: "superseded", finishedAt: now() });
        const oldGeneration = db.prepare("SELECT generation FROM source_generations WHERE source_id=?").get(input.sourceId) as { generation: number } | undefined;
        const generation = (oldGeneration?.generation ?? 0) + 1;
        db.prepare("INSERT INTO source_generations VALUES (?,?) ON CONFLICT(source_id) DO UPDATE SET generation=excluded.generation").run(input.sourceId, generation);
        const runId = `run_${randomUUID()}`;
        const scanId = input.scan ? continued?.scanId ?? `scan_${randomUUID()}` : undefined;
        const run: SyncRun = { runId, sourceId: input.sourceId, actorScope: input.actorScope, generation, scope, ...(requestFingerprint === undefined ? {} : { requestFingerprint }),
          ...(scanId ? { scanId, ...(continued ? { continuedFromRunId: continued.runId } : {}) } : {}), status: "running", startedAt };
        if (input.scan && scanScope && scanId) {
          if (continued) evolveScan(continued, { runId, generation });
          else {
            invalidateScans(source.sourceId, "new-scan");
            saveScan({ id: `scan-event_${randomUUID()}`, scanId, version: 1, sourceId: source.sourceId, actorScope: input.actorScope, runId, generation,
              sourceFingerprint: input.scan.sourceFingerprint, scopeFingerprint: sourceScanFingerprint(scanScope), scope: scanScope,
              adapterId: source.adapterId, adapterVersion: source.adapterVersion, state: "retry-page", attemptedRecords: 0, pages: 0, hadErrors: false, at: startedAt });
          }
        }
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
    async readScanProgress(input: { sourceId: string; runId?: string; actorScope: string }) {
      checked(EntityIdSchema, input.sourceId); checked(ActorScopeSchema, input.actorScope);
      return transaction(() => {
        const event = input.runId ? scanForRun(input.runId, input.actorScope) : latestScans(input.sourceId).filter(value => value.actorScope === input.actorScope).at(-1);
        if (event && event.sourceId !== input.sourceId) throw new RepositoryError("not-found");
        return { sourceId: input.sourceId, progress: event && (!input.runId || event.runId === input.runId) ? publicScan(event) : null };
      });
    },
    async readScanCheckpoint(runId: string, actorScope: string): Promise<SourceScanCheckpoint> {
      return transaction(() => {
        const event = scanForRun(runId, actorScope);
        if (!event || event.runId !== runId) throw new RepositoryError("stale-version");
        return event;
      });
    },
    /** Projection, leads, checkpoint and their durable receipt have one SQLite commit. */
    async commitScanPage(input: { delta: unknown; leads: readonly DiscoveryLead[]; page: SourcePage; expectedProgressVersion: number; summary: PublicRunSummary }, pageOptions: ImportOptions & { runId: string; throwIfCancelled?: () => void }): Promise<SourceScanPageReceipt> {
      validateOptions(pageOptions);
      const page = checked(SourcePageSchema, input.page), summary = checked(PublicRunSummarySchema, input.summary);
      const requestSignature = signature({ input: { ...input, page, summary }, expectedRevision: pageOptions.expectedRevision, runId: pageOptions.runId });
      return transaction(() => {
        const cached = receipt<SourceScanPageReceipt>(pageOptions.actorScope, "sources.commit-page", pageOptions.idempotencyKey, requestSignature);
        if (cached) return checked(SourceScanPageReceiptSchema, cached);
        pageOptions.throwIfCancelled?.();
        const run = currentRun(pageOptions.runId, pageOptions.actorScope), event = scanForRun(run.runId, pageOptions.actorScope);
        if (!event || event.runId !== run.runId || event.version !== input.expectedProgressVersion || !["ready", "retry-page"].includes(event.state)) throw new RepositoryError("stale-version");
        const source = read().sources.find(value => value.sourceId === run.sourceId);
        if (!source || sourceConfigurationFingerprint(source) !== event.sourceFingerprint) throw new RepositoryError("stale-version");
        const imported = importSnapshotNow(input.delta, pageOptions);
        pageOptions.throwIfCancelled?.();
        const leadReceipt = saveDiscoveryLeadsNow(input.leads, pageOptions);
        pageOptions.throwIfCancelled?.();
        const state = page.retryCurrentPage ? "retry-page" : page.nextCursor ? "ready" : page.coverage.complete ? "exhausted" : "truncated";
        const checkpoint = evolveScan(event, { state, cursor: page.retryCurrentPage ? event.cursor : page.nextCursor,
          attemptedRecords: event.attemptedRecords + page.coverage.fetchedRecords, pages: event.pages + 1,
          hadErrors: event.hadErrors || page.coverage.partial });
        const nextSummary = { ...summary, added: (run.summary?.added ?? 0) + imported.counts.newJobs,
          changed: (run.summary?.changed ?? 0) + imported.counts.updatedJobs, unchanged: (run.summary?.unchanged ?? 0) + imported.counts.unchangedJobs,
          leads: (run.summary?.leads ?? 0) + input.leads.length };
        saveRun({ ...run, summary: checked(PublicRunSummarySchema, nextSummary) });
        const result = checked(SourceScanPageReceiptSchema, { ok: true, runId: run.runId, scanId: event.scanId, progressVersion: checkpoint.version,
          receipt: imported, leadIds: leadReceipt.leadIds, revision: leadReceipt.revision });
        saveReceipt(pageOptions.actorScope, "sources.commit-page", pageOptions.idempotencyKey, requestSignature, result);
        pageOptions.throwIfCancelled?.();
        return result;
      });
    },
    async markScanFailure(runId: string, actorScope: string, sourceChanged: boolean) {
      return transaction(() => {
        const run = currentRun(runId, actorScope), event = scanForRun(run.runId, actorScope);
        if (!event || event.runId !== runId || event.state === "invalidated") return;
        evolveScan(event, sourceChanged ? { state: "invalidated", invalidatedReason: "source-changed", hadErrors: true }
          : ["ready", "retry-page"].includes(event.state) ? { state: "retry-page", hadErrors: true } : { hadErrors: true });
      });
    },
    async listRuns(): Promise<SyncRun[]> { ensureOpen(); return (db.prepare("SELECT document FROM runs ORDER BY rowid DESC").all() as Array<{ document: string }>).map((row) => checked(SyncRunSchema, JSON.parse(row.document))); },
    async assertRunCurrent(runId: string, actorScope?: string) { return currentRun(runId, actorScope); },
    /** Invoke once after the service acquires exclusive process ownership, never on each DB open. */
    async recoverInterruptedRuns(): Promise<{ recovered: number }> {
      return transaction(() => {
        const interrupted = db.prepare("SELECT document FROM runs WHERE status='running'").all() as Array<{ document: string }>;
        for (const row of interrupted) {
          const run = checked(SyncRunSchema, JSON.parse(row.document));
          saveRun({ ...run, status: "failed", finishedAt: now(), summary: { ...run.summary, errorCode: "service-restarted", partial: true } });
        }
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
      return transaction(() => saveDiscoveryLeadsNow(input, importOptions));
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
        const result = checked(RepositoryBackupSchema, { format: "better-me/job-repository", schemaVersion: REPOSITORY_SCHEMA_VERSION, createdAt: now(), dataset, runs, receipts, leads, baseJobs, baseLocations: baseSnapshot(dataset).locations, locationDecisions: locationDecisions(), officeDecisions: officeDecisions(), baseCompensations: baseSnapshot(dataset).compensations, compensationDecisions: compensationDecisions(), mergeDecisions: decisions(), aliasHistory, jobVersions, fxSnapshots: fxSnapshots(), fxActivations: fxActivations(), baseCompanies: baseSnapshot(dataset).companies, companyControlDecisions: companyControlDecisions(), sourceScans: scanHistory() }, "invalid-backup");
        validateSourceScanBackup(result, now());
        return result;
      });
    },
    async restore(input: unknown, restoreOptions: Omit<ImportOptions, "runId"> & { expectedRevision: number }): Promise<ImportReceipt> {
      validateOptions(restoreOptions);
      const backup = checked(RepositoryBackupSchema, input, "invalid-backup");
      validateSourceScanBackup(backup, now());
      verifyContentHashes(backup.dataset, "invalid-backup");
      if (encoder.encode(json(backup)).byteLength > 128 * 1024 * 1024) throw new RepositoryError("invalid-backup");
      await verifyFxBackup(backup, now());
      const baseJobs = backup.baseJobs ?? backup.dataset.jobs;
      const baseLocations = backup.baseLocations ?? backup.dataset.locations;
      const baseCompensations = backup.baseCompensations ?? backup.dataset.compensations;
      const baseCompanies = backup.baseCompanies ?? backup.dataset.companies;
      const owners = new Map(baseJobs.flatMap((job) => job.listingIds.map((id) => [id, job.id] as const)));
      let restoredBase: AtlasDataset;
      try { restoredBase = checked(AtlasDatasetSchema, stripCompanyControlReviewProjection({ ...backup.dataset, jobs: baseJobs, companies: baseCompanies, locations: baseLocations, compensations: baseCompensations, listings: backup.dataset.listings.map((listing) => ({ ...listing, ...(owners.has(listing.id) ? { canonicalJobId: owners.get(listing.id) } : {}) })) }, backup.companyControlDecisions), "invalid-backup"); }
      catch { throw new RepositoryError("invalid-backup"); }
      await verifyCompanyControlBackup(backup, restoredBase, now());
      const historicalLocationBasis = (event: { jobId: string; listingId: string; locationId: string }, sourceLocation: JobLocation): AtlasDataset => checked(AtlasDatasetSchema, {
        ...restoredBase, locations: restoredBase.locations.map(location => location.id === event.locationId ? sourceLocation : location),
        jobs: restoredBase.jobs.map(job => job.id === event.jobId ? { ...job, locationIds: union(job.locationIds, [event.locationId]) } : job),
        listings: restoredBase.listings.map(listing => listing.id === event.listingId ? { ...listing, locationIds: union(listing.locationIds ?? [], [event.locationId]) } : listing),
      }, "invalid-backup");
      const historicalCompensationBasis = (event: { jobId: string; listingId: string; compensationId: string; sourceBinding: CompensationReviewSourceBinding }, sourceCompensation: Compensation): AtlasDataset => checked(AtlasDatasetSchema, {
        ...restoredBase, compensations: restoredBase.compensations.map(compensation => compensation.id === event.compensationId ? sourceCompensation : compensation),
        jobs: restoredBase.jobs.map(job => job.id === event.jobId ? { ...job, compensationIds: union(job.compensationIds, [event.compensationId]), locationIds: union(job.locationIds, sourceCompensation.locationIds ?? []) } : { ...job, compensationIds: job.compensationIds.filter(id => id !== event.compensationId) }),
        listings: restoredBase.listings.map(listing => listing.id === event.listingId ? { ...listing, ...event.sourceBinding.listing, canonicalJobId: event.jobId, compensationIds: union(listing.compensationIds ?? [], [event.compensationId]), locationIds: union(listing.locationIds ?? [], sourceCompensation.locationIds ?? []),
          observationIds: union(listing.observationIds, event.sourceBinding.observations.map(value => value.id)) } : { ...listing, compensationIds: listing.compensationIds?.filter(id => id !== event.compensationId) }),
        observations: [...restoredBase.observations.filter(value => !event.sourceBinding.observations.some(archived => archived.id === value.id)), ...event.sourceBinding.observations],
        snapshots: [...restoredBase.snapshots.filter(value => !event.sourceBinding.snapshots.some(archived => archived.id === value.id)), ...event.sourceBinding.snapshots],
      }, "invalid-backup");
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
        let compensationRevision = 0;
        for (const entry of backup.compensationDecisions) {
          const sharedInvalidation = entry.kind === "invalidate" && backup.officeDecisions.some(office => office.revision === entry.revision && office.kind === "invalidate");
          if (entry.revision > backup.dataset.revision || entry.revision < 1 || entry.revision <= compensationRevision || decisionRevisions.has(entry.revision) && !sharedInvalidation) throw new Error("invalid-compensation-revision");
          compensationRevision = entry.revision; decisionRevisions.add(entry.revision);
          if (entry.kind !== "invalidate") {
            // Historical listing URLs may have changed, but an immutable source material
            // cannot have two different bodies under the same observation or snapshot ID.
            for (const observation of entry.sourceBinding.observations) {
              const retained = restoredBase.observations.find(value => value.id === observation.id);
              if (retained && !same(retained, observation)) throw new Error("invalid-compensation-archived-observation");
            }
            for (const snapshot of entry.sourceBinding.snapshots) {
              const retained = restoredBase.snapshots.find(value => value.id === snapshot.id);
              if (retained && !same(retained, snapshot)) throw new Error("invalid-compensation-archived-snapshot");
            }
            verifyContentHashes({ ...restoredBase, observations: entry.sourceBinding.observations, snapshots: entry.sourceBinding.snapshots }, "invalid-backup");
            if (!same(restoredBase.compensations.find(value => value.id === entry.compensationId), entry.sourceCompensation)
              || !restoredBase.jobs.find(job => job.id === entry.jobId)?.listingIds.includes(entry.listingId)) throw new Error("invalid-compensation-source");
            if (entry.kind === "confirm") validateCompensationReviewProposal(historicalCompensationBasis(entry, entry.sourceCompensation), {
              jobId: entry.jobId, compensationId: entry.compensationId, listingId: entry.listingId, sourceCompensation: entry.sourceCompensation, proposal: entry.proposal,
            });
          }
        }
        const resolvedBase = projectCompanyControlReviews(projectCompensationReviews(projectOfficeAddressConfirmations(projectLocationConfirmations(restoredBase, backup.locationDecisions), backup.officeDecisions), backup.compensationDecisions), backup.companyControlDecisions);
        restoredProjection = projectReconciliation(resolvedBase, backup.mergeDecisions);
        if (!same(restoredProjection.dataset.locations, backup.dataset.locations)) throw new Error("invalid-location-projection");
        if (!same(restoredProjection.dataset.compensations, backup.dataset.compensations)) throw new Error("invalid-compensation-projection");
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
        for (const stored of backup.receipts) if (stored.tool === "compensations.confirm-review" || stored.tool === "compensations.revoke-review") {
          const response = checked(CompensationReviewReceiptSchema, stored.response, "invalid-backup");
          const event = backup.compensationDecisions.find(entry => entry.id === response.decisionId);
          if (!event || event.kind === "invalidate" || event.actorScope !== stored.actorScope || event.revision !== response.revision || event.compensationId !== response.compensationId
            || event.kind !== (stored.tool === "compensations.confirm-review" ? "confirm" : "revoke") || !originIds.has(response.jobId)) throw new Error("invalid-compensation-receipt");
          const thenProjection = projectReconciliation(restoredBase, backup.mergeDecisions.filter(entry => entry.revision < event.revision));
          const thenAlias = thenProjection.aliases.find(alias => alias.jobId === response.jobId)?.canonicalJobId;
          if (!thenProjection.dataset.jobs.find(job => job.id === thenAlias)?.listingIds.includes(event.listingId)) throw new Error("invalid-compensation-receipt-job");
          if (event.kind === "confirm") {
            const expected = applyCompensationReviewConfirmation(event.sourceCompensation, event);
            if (!same(expected, response.compensation) || response.activeDecisionId !== event.id) throw new Error("invalid-compensation-receipt-body");
          } else {
            const receiptBase = historicalCompensationBasis(event, event.sourceCompensation), thenEntries = backup.compensationDecisions.filter(entry => entry.revision <= event.revision);
            const expected = projectCompensationReviews(receiptBase, thenEntries).compensations.find(value => value.id === response.compensationId);
            const active = activeCompensationDecision(receiptBase, thenEntries, event.compensationId);
            if (!expected || !same(expected, response.compensation) || active?.id !== response.activeDecisionId) throw new Error("invalid-compensation-receipt-body");
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
        // Replacing selected rates must not orphan a durable command from the current file.
        if (fxSnapshots().some(value => !backup.fxSnapshots.some(saved => same(value, saved))) || fxActivations().some(value => !backup.fxActivations.some(saved => same(value, saved)))) throw new RepositoryError("conflict");
        if (companyControlDecisions().some(value => !backup.companyControlDecisions.some(saved => same(value, saved)))) throw new RepositoryError("conflict");
        // Existing checkpoints and all commands that can move them remain durable.
        // Restoring an older file must never erase an invalidation or resurrect a consumed cursor.
        if (scanHistory().some(value => !backup.sourceScans.some(saved => same(value, saved)))) throw new RepositoryError("conflict");
        const currentScanRunIds = new Set(scanHistory().map(value => value.runId));
        for (const runId of currentScanRunIds) {
          const currentRunValue = runById(runId);
          const retained = backup.runs.find(value => value.runId === runId);
          if (!currentRunValue || !retained || !same(currentRunValue, retained)) throw new RepositoryError("conflict");
        }
        const durableScanReceipts = (db.prepare("SELECT * FROM receipts WHERE tool IN ('runs.start','sources.commit-page','dataset.import','leads.save')").all() as Array<{ actor_scope: string; tool: StoredReceipt["tool"]; idempotency_key: string; signature: string; response: string; created_at: string }>).filter(row => row.tool === "sources.commit-page" || row.tool === "runs.start" && currentScanRunIds.has((JSON.parse(row.response) as SyncRun).runId) || [...currentScanRunIds].some(runId => row.idempotency_key.startsWith(`${runId}.page-`)))
          .map(row => ({ actorScope: row.actor_scope, tool: row.tool, idempotencyKey: row.idempotency_key, signature: row.signature, response: JSON.parse(row.response) as unknown, createdAt: row.created_at }));
        if (durableScanReceipts.some(value => !backup.receipts.some(saved => same(value, saved)))) throw new RepositoryError("conflict");
        const currentCompanyReceipts = (db.prepare("SELECT * FROM receipts WHERE tool IN ('companies.confirm-control-review','companies.revoke-control-review')").all() as Array<{ actor_scope: string; tool: StoredReceipt["tool"]; idempotency_key: string; signature: string; response: string; created_at: string }>)
          .map(row => ({ actorScope: row.actor_scope, tool: row.tool, idempotencyKey: row.idempotency_key, signature: row.signature, response: JSON.parse(row.response) as unknown, createdAt: row.created_at }));
        if (currentCompanyReceipts.some(value => !backup.receipts.some(saved => same(value, saved)))) throw new RepositoryError("conflict");
        // A source run that was active in the saved file has no live executor after restoration.
        const restoredRuns = backup.runs.map((run): SyncRun => run.status === "running" ? { ...run, status: "cancelled", finishedAt: now(), summary: { ...run.summary, partial: true, errorCode: "backup-restored" } } : run);
        const dataset = { ...backup.dataset, revision: Math.max(current.revision, backup.dataset.revision) + 1 };
        write(dataset, true);
        writeBaseJobs(baseJobs, true);
        writeBaseLocations(baseLocations, true);
        writeBaseCompensations(baseCompensations, true);
        writeBaseCompanies(baseCompanies, true);
        db.exec("DROP TRIGGER company_control_decisions_no_update; DROP TRIGGER company_control_decisions_no_delete; DELETE FROM company_control_decisions;");
        for (const entry of backup.companyControlDecisions) db.prepare("INSERT INTO company_control_decisions VALUES (?,?,?)").run(entry.id, entry.revision, json(entry));
        db.exec(COMPANY_CONTROL_DECISION_TRIGGERS);
        db.exec("DROP TRIGGER location_decisions_no_update; DROP TRIGGER location_decisions_no_delete; DELETE FROM location_decisions;");
        for (const entry of backup.locationDecisions) db.prepare("INSERT INTO location_decisions VALUES (?,?,?)").run(entry.id, entry.revision, json(entry));
        db.exec(LOCATION_DECISION_TRIGGERS);
        db.exec("DROP TRIGGER office_decisions_no_update; DROP TRIGGER office_decisions_no_delete; DELETE FROM office_decisions;");
        for (const entry of backup.officeDecisions) db.prepare("INSERT INTO office_decisions VALUES (?,?,?)").run(entry.id, entry.revision, json(entry));
        db.exec(OFFICE_DECISION_TRIGGERS);
        db.exec("DROP TRIGGER compensation_decisions_no_update; DROP TRIGGER compensation_decisions_no_delete; DELETE FROM compensation_decisions;");
        for (const entry of backup.compensationDecisions) db.prepare("INSERT INTO compensation_decisions VALUES (?,?,?)").run(entry.id, entry.revision, json(entry));
        db.exec(COMPENSATION_DECISION_TRIGGERS);
        db.exec("DROP TRIGGER fx_snapshots_no_update; DROP TRIGGER fx_snapshots_no_delete; DROP TRIGGER fx_activations_no_update; DROP TRIGGER fx_activations_no_delete; DELETE FROM fx_activations; DELETE FROM fx_snapshots;");
        for (const stored of backup.fxSnapshots) db.prepare("INSERT INTO fx_snapshots VALUES (?,?,?)").run(stored.snapshot.fx.id, stored.revision, json(stored.snapshot));
        for (const event of backup.fxActivations) db.prepare("INSERT INTO fx_activations VALUES (?,?,?)").run(event.id, event.revision, json(event));
        db.exec(FX_TRIGGERS);
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
        // Existing events were checked for exact preservation above; importing a
        // superset only appends new events and never disables immutability triggers.
        const existingScanEventIds = new Set(scanHistory().map(value => value.id));
        for (const event of backup.sourceScans) if (!existingScanEventIds.has(event.id)) saveScan(event);
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
