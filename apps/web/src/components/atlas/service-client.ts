import { z } from "zod";
import { PlanAddressEnrichmentInputSchema, AddressEnrichmentPlanSchema, type PlanAddressEnrichmentInput } from "@better-me/opportunities";
import { EntityIdSchema, SourceDefinitionSchema, TimestampSchema, TOOL_ERROR_CODES, GeocodingRequestSchema, GeocodingResultSchema, MapReferencesInputSchema, MapReferencesResultSchema, type GeocodingInput, type MapReferencesInput } from "@better-me/opportunities";
import {
  DiscoverSourceCandidatesInputSchema, InspectSourceCandidateInputSchema, ProposeSourceRegistrationInputSchema,
  SourceAdapterMetadataSchema, SourceCandidateInspectionSchema, SourceDiscoveryPageSchema,
  SourcePageSchema, SourceRegistrationProposalSchema, SourceScopeSchema,
  DiscoverCompanyCareersRequestSchema, CompanyCareerDiscoveryResultSchema, CompanyCareerDiscoveryCapabilitiesSchema, type DiscoverCompanyCareersInput,
  type DiscoverSourceCandidatesInput, type InspectSourceCandidateInput, type ProposeSourceRegistrationInput,
  PreviewReviewedCardsInputSchema, ReviewedCardsPreviewSchema, ImportReviewedCardsInputSchema,
  type PreviewReviewedCardsInput, type ImportReviewedCardsInput,
  PreviewDetailLocationsInputSchema, ImportDetailLocationsInputSchema, DetailLocationsPreviewSchema,
  type PreviewDetailLocationsInput, type ImportDetailLocationsInput,
} from "@better-me/source-adapters/browser-contracts";
import { AtlasClientError, readAtlasSnapshot } from "./client";
import {
  PreviewLocationConfirmationInputSchema, ConfirmLocationInputSchema, RevokeLocationConfirmationInputSchema,
  LocationConfirmationPreviewSchema, LocationConfirmationReceiptSchema,
  type PreviewLocationConfirmationInput, type ConfirmLocationInput, type RevokeLocationConfirmationInput,
  ListMergeCandidatesInputSchema, MergeCandidatesPageSchema, PreviewMergeReviewInputSchema, MergeReviewPreviewSchema,
  ConfirmMergeReviewInputSchema, RejectMergeReviewInputSchema, ReconciliationReceiptSchema,
  ListMergeDecisionsInputSchema, MergeDecisionsPageSchema, PreviewRevokeMergeReviewInputSchema,
  RevokeMergeReviewPreviewSchema, RevokeMergeReviewInputSchema,
  type ListMergeCandidatesInput, type PreviewMergeReviewInput, type ConfirmMergeReviewInput, type RejectMergeReviewInput,
  type ListMergeDecisionsInput, type PreviewRevokeMergeReviewInput, type RevokeMergeReviewInput,
  type MergeReviewPreview, type ReconciliationReceipt,
  OfficeAddressCandidatesInputSchema, OfficeAddressCandidatesResultSchema, PreviewOfficeConfirmationInputSchema,
  ConfirmOfficeAddressInputSchema, RevokeOfficeAddressInputSchema, OfficeAddressPreviewSchema, OfficeAddressReceiptSchema,
  sameLocationValue, type OfficeAddressCandidatesInput, type PreviewOfficeConfirmationInput,
  type ConfirmOfficeAddressInput, type RevokeOfficeAddressInput, type OfficeAddressProposal, type JobLocation,
  PreviewCompanyControllerOverrideInputSchema, CompanyControllerOverridePreviewSchema,
  ConfirmCompanyControllerOverrideInputSchema, CompanyControllerOverrideReceiptSchema,
  RevokeCompanyControllerOverrideInputSchema,
  type PreviewCompanyControllerOverrideInput, type ConfirmCompanyControllerOverrideInput, type RevokeCompanyControllerOverrideInput,
} from "@better-me/opportunities";

export const AtlasSourceListSchema = z.object({ sources: z.array(SourceDefinitionSchema), adapters: z.array(SourceAdapterMetadataSchema) }).strict();
export type AtlasSourceList = z.infer<typeof AtlasSourceListSchema>;
export const AtlasRegisterSourceSchema = z.object({ source: SourceDefinitionSchema, expectedRevision: z.number().int().nonnegative().optional() }).strict();
export type AtlasRegisterSource = z.infer<typeof AtlasRegisterSourceSchema>;
const PreviewInputSchema = z.object({ scope: SourceScopeSchema.optional(), maxRecords: z.number().int().min(1).max(100_000).optional() }).strict();
const SyncInputSchema = PreviewInputSchema.extend({ maxPages: z.number().int().min(1).max(1000).optional() }).strict();
export type AtlasSourceScopeInput = z.infer<typeof SyncInputSchema>;
export const AtlasSourcePreviewSchema = z.object({ page: SourcePageSchema, localMatchedRecords: z.number().int().nonnegative(), localFilters: SourceScopeSchema }).strict();
export type AtlasSourcePreview = z.infer<typeof AtlasSourcePreviewSchema>;
const count = () => z.number().int().nonnegative();
// These HTTP views intentionally contain only the public fields emitted by the local service.
const ReceiptSchema = z.object({ ok: z.literal(true), revision: count(), jobIds: z.array(EntityIdSchema), snapshotIds: z.array(EntityIdSchema),
  counts: z.object({ newJobs: count(), updatedJobs: count(), unchangedJobs: count(), newListings: count(), newObservations: count(), newSnapshots: count() }).strict(),
}).strict();
const RunSchema = z.object({
  runId: EntityIdSchema, sourceId: EntityIdSchema, actorScope: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:/-]+$/), generation: z.number().int().positive(),
  scope: z.object({ keywords: z.array(z.string().trim().min(1).max(300)).max(100).optional(), regions: z.array(z.string().trim().min(1).max(300)).max(100).optional(),
    companies: z.array(z.string().trim().min(1).max(300)).max(100).optional(), countryCodes: z.array(z.string().regex(/^[A-Z]{2}$/)).max(100).optional(), maxRecords: z.number().int().min(1).max(100_000).optional(), maxPages: z.number().int().min(1).max(10_000).optional() }).strict(),
  requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(), status: z.enum(["running", "completed", "partial", "failed", "cancelled", "superseded"]),
  startedAt: TimestampSchema, finishedAt: TimestampSchema.optional(), summary: z.object({
    added: count().optional(), changed: count().optional(), unchanged: count().optional(), closed: count().optional(), failed: count().optional(),
    needsHuman: count().optional(), records: count().optional(), pages: count().optional(), leads: count().optional(), partial: z.boolean().optional(),
    errorCode: z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/).optional(),
  }).strict().optional(),
}).strict();
export const AtlasSourceSyncSchema = z.object({ run: RunSchema, localFilters: SourceScopeSchema, warnings: z.array(z.string()),
  sourceError: z.object({ code: z.string(), retryAfterSeconds: z.number().nonnegative().optional() }).strict().optional(),
}).strict();
export type AtlasSourceSync = z.infer<typeof AtlasSourceSyncSchema>;
const requestId = z.string().min(1).max(150);
const ErrorEnvelopeSchema = z.object({ ok: z.literal(false), requestId, error: z.object({ code: z.enum(TOOL_ERROR_CODES), message: z.string().max(4000) }).strict() }).strict();
const KeySchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);
type Options = { signal?: AbortSignal; maxBytes?: number };
type WriteOptions = Options & { idempotencyKey: string };

const samePair = (left: readonly string[], right: readonly string[]) => left.length === 2 && right.length === 2
  && left[0] !== left[1] && right[0] !== right[1] && left.every(id => right.includes(id));
function matchingMergeSide(side: MergeReviewPreview["target"]) {
  return side.canonicalJobId === side.job.id && side.company.id === side.job.companyId
    && sameIds(side.listings.map(value => value.id), side.job.listingIds)
    && sameIds(side.locations.map(value => value.id), side.job.locationIds)
    && sameIds(side.compensations.map(value => value.id), side.job.compensationIds)
    && sameIds(side.sources.map(value => value.sourceId), [...new Set(side.listings.map(value => value.sourceId))]);
}
function sameIds(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && new Set(left).size === left.length && new Set(right).size === right.length
    && left.every(id => right.includes(id));
}
function matchingReceiptRevision(receipt: ReconciliationReceipt, expectedRevision: number, reason: string) {
  return receipt.revision === expectedRevision + 1 && receipt.decision.revision === receipt.revision && receipt.decision.reason === reason;
}
function matchingMergeReceipt(receipt: ReconciliationReceipt, query: z.output<typeof ConfirmMergeReviewInputSchema>, kind: "merge" | "reject") {
  const decision = receipt.decision;
  if (decision.kind !== kind || !matchingReceiptRevision(receipt, query.expectedRevision, query.reason)
    || decision.candidate.snapshotRevision !== query.expectedRevision) return false;
  const pair = [decision.candidate.leftJobId, decision.candidate.rightJobId];
  const alias = (id: string) => receipt.aliases.find(value => value.jobId === id)?.canonicalJobId;
  if (decision.kind === "reject") return samePair(pair, [decision.leftJobId, decision.rightJobId])
    && samePair(pair, [alias(query.targetJobId) ?? query.targetJobId, alias(query.sourceJobId) ?? query.sourceJobId]);
  // Current IDs bind direction directly. Historical aliases resolve through the returned
  // projection; their original direction was already bound by the authenticated preview.
  return samePair(pair, [decision.targetJobId, decision.sourceJobId]) && decision.companyIdentityConfirmed === query.companyIdentityConfirmed
    && (pair.includes(query.targetJobId) ? decision.targetJobId === query.targetJobId : alias(query.targetJobId) === decision.targetJobId)
    && (pair.includes(query.sourceJobId) ? decision.sourceJobId === query.sourceJobId : alias(query.sourceJobId) === decision.targetJobId);
}

function matchingOfficeProposal(location: JobLocation, proposal: OfficeAddressProposal) {
  const resolution = location.officeResolution;
  return location.kind === "office" && location.precision === "address" && location.verification === "unverified"
    && location.provider === "manual-user-confirmation" && location.countryCode === proposal.countryCode
    && location.streetAddress === proposal.streetAddress && location.postalCode === proposal.postalCode
    && sameLocationValue(location.coordinates, proposal.coordinates) && !location.originalCoordinates
    && resolution?.originalLocationId === location.id && resolution.method === proposal.basis
    && resolution.formattedAddress === proposal.formattedAddress && resolution.streetAddress === proposal.streetAddress
    && resolution.postalCode === proposal.postalCode && resolution.coordinateMeaning === proposal.coordinateMeaning
    && resolution.evidenceUrl === proposal.evidenceUrl && location.resolvedAt === resolution.at;
}

export class AtlasSourceServiceError extends Error {
  constructor(readonly code: "invalid-input" | "invalid-response" | "too-large" | "http-error" | "transport-error" | typeof TOOL_ERROR_CODES[number], message: string, readonly status?: number) {
    super(message); this.name = "AtlasSourceServiceError";
  }
}
function input<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AtlasSourceServiceError("invalid-input", "输入不符合来源工具契约，请检查 JSON、范围或限制。");
  return parsed.data;
}
function baseUrl(endpoint: string, token: string): URL {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new AtlasClientError("invalid-endpoint", "请输入有效的本机服务地址。"); }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !["http:", "https:"].includes(url.protocol)
    || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new AtlasClientError("invalid-endpoint", "来源工具仅连接本机 loopback 服务根地址。");
  }
  if (!token.trim()) throw new AtlasClientError("missing-token", "请先填写本机服务访问令牌。");
  return url;
}
async function bodyJson(response: Response, { signal, maxBytes = 32 * 1024 * 1024 }: Options): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be positive.");
  const over = () => new AtlasSourceServiceError("too-large", "服务结果超过浏览器字节上限，请缩小记录数或查询范围。");
  if (Number(response.headers.get("content-length")) > maxBytes) { void response.body?.cancel().catch(() => {}); throw over(); }
  if (!response.body) throw new AtlasSourceServiceError("invalid-response", "服务没有返回 JSON 内容。");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  let completed = false;
  try {
    signal?.throwIfAborted();
    const decoder = new TextDecoder("utf-8", { fatal: true }); let bytes = 0; const parts: string[] = [];
    while (true) {
      const next = await reader.read(); signal?.throwIfAborted(); if (next.done) break;
      bytes += next.value.byteLength; if (bytes > maxBytes) throw over();
      parts.push(decoder.decode(next.value, { stream: true }));
    }
    parts.push(decoder.decode()); const value: unknown = JSON.parse(parts.join("")); completed = true; return value;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof AtlasSourceServiceError) throw error;
    throw new AtlasSourceServiceError("invalid-response", "服务返回的 JSON 或 UTF-8 无效。");
  } finally {
    signal?.removeEventListener("abort", cancel); if (!completed) void reader.cancel().catch(() => {}); reader.releaseLock();
  }
}

/** Browser access to the real authenticated tool routes. Source configs remain inert data. */
export function createAtlasSourceClient(endpoint: string, token: string) {
  async function request<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, options: Options = {}, payload?: unknown, key?: string): Promise<T> {
    options.signal?.throwIfAborted(); const base = baseUrl(endpoint, token);
    if (key !== undefined) input(KeySchema, key);
    let response: Response;
    try {
      response = await fetch(new URL(`/api/v1/${path}`, base), { method: payload === undefined ? "GET" : "POST", signal: options.signal,
        credentials: "omit", redirect: "error", cache: "no-store",
        headers: { Authorization: `Bearer ${token.trim()}`, ...(payload === undefined ? {} : { "Content-Type": "application/json" }), ...(key === undefined ? {} : { "Idempotency-Key": key }) },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof AtlasClientError || error instanceof AtlasSourceServiceError) throw error;
      throw new AtlasSourceServiceError("transport-error", "未收到本机服务回执。请检查服务连接；写操作重试会沿用原幂等键。");
    }
    if (options.signal?.aborted || response.redirected) { void response.body?.cancel().catch(() => {}); options.signal?.throwIfAborted(); throw new AtlasSourceServiceError("http-error", "服务发生了不允许的跳转。", response.status); }
    if (path === "locations/map-references" && response.status === 404) {
      void response.body?.cancel().catch(() => {});
      throw new AtlasSourceServiceError("http-error", "本机服务尚不支持城市分布参考，请更新岗位服务后重试。", 404);
    }
    const value = await bodyJson(response, options); options.signal?.throwIfAborted();
    const error = ErrorEnvelopeSchema.safeParse(value);
    if (error.success) throw new AtlasSourceServiceError(error.data.error.code, `来源工具返回 ${error.data.error.code}。请检查来源状态、版本、范围与服务日志。`, response.status);
    if (!response.ok) throw new AtlasSourceServiceError("http-error", `服务返回 ${response.status}。请核对令牌、允许 Origin 及服务状态。`, response.status);
    const parsed = z.object({ ok: z.literal(true), requestId, value: z.unknown() }).strict().safeParse(value);
    if (!parsed.success) throw new AtlasSourceServiceError("invalid-response", "服务返回内容不符合来源工具契约。");
    const result = schema.safeParse(parsed.data.value);
    if (!result.success) throw new AtlasSourceServiceError("invalid-response", "服务返回内容不符合来源工具契约。");
    return result.data;
  }
  const sourcePath = (id: string) => `sources/${encodeURIComponent(input(EntityIdSchema, id))}`;
  return {
    mapReferences: async (value: MapReferencesInput, options: Options = {}) => {
      const query = input(MapReferencesInputSchema, value);
      const result = await request("locations/map-references", MapReferencesResultSchema, options, query);
      const ids = [...result.references, ...result.unresolved].map(entry => entry.locationId);
      if (result.snapshotRevision !== query.expectedRevision || result.processedLocations > query.limit
        || (query.locationIds && (result.totalLocations !== query.locationIds.length || ids.some(id => !query.locationIds!.includes(id)))))
        throw new AtlasSourceServiceError("invalid-response", "城市分布参考与本次地点范围或索引版本不一致，请重新读取。");
      return result;
    },
    listMergeCandidates: async (value: ListMergeCandidatesInput = {}, options: Options = {}) => {
      const query = input(ListMergeCandidatesInputSchema, value);
      const result = await request("jobs/reconciliation/candidates", MergeCandidatesPageSchema, options, query);
      if (result.limit !== query.limit || result.candidates.length > query.limit
        || new Set(result.candidates.map(candidate => candidate.id)).size !== result.candidates.length
        || result.candidates.some(candidate => candidate.snapshotRevision !== result.snapshotRevision || candidate.leftJobId === candidate.rightJobId))
        throw new AtlasSourceServiceError("invalid-response", "重复岗位候选与本次范围或索引版本不一致，请重新读取。");
      return result;
    },
    previewMerge: async (value: PreviewMergeReviewInput, options: Options = {}) => {
      const query = input(PreviewMergeReviewInputSchema, value);
      const result = await request("jobs/reconciliation/preview", MergeReviewPreviewSchema, options, query);
      if (result.snapshotRevision !== query.expectedRevision || result.expectedRevision !== query.expectedRevision
        || result.candidate.snapshotRevision !== query.expectedRevision || JSON.stringify(result.input) !== JSON.stringify(query)
        || result.target.requestedJobId !== query.targetJobId || result.source.requestedJobId !== query.sourceJobId
        || !samePair([result.candidate.leftJobId, result.candidate.rightJobId], [result.target.canonicalJobId, result.source.canonicalJobId])
        || !matchingMergeSide(result.target) || !matchingMergeSide(result.source))
        throw new AtlasSourceServiceError("invalid-response", "归并预览与本次岗位、方向、核对说明或版本不一致，请重新预览。");
      return result;
    },
    mergeJobs: async (value: ConfirmMergeReviewInput, options: WriteOptions) => {
      const query = input(ConfirmMergeReviewInputSchema, value);
      const result = await request("jobs/reconciliation/merge", ReconciliationReceiptSchema, options, query, input(KeySchema, options.idempotencyKey));
      if (!matchingMergeReceipt(result, query, "merge"))
        throw new AtlasSourceServiceError("invalid-response", "归并回执与本次请求不一致，请沿用原请求核对回执。");
      return result;
    },
    rejectMerge: async (value: RejectMergeReviewInput, options: WriteOptions) => {
      const query = input(RejectMergeReviewInputSchema, value);
      const result = await request("jobs/reconciliation/reject", ReconciliationReceiptSchema, options, query, input(KeySchema, options.idempotencyKey));
      if (!matchingMergeReceipt(result, query, "reject"))
        throw new AtlasSourceServiceError("invalid-response", "拒绝归并回执与本次请求不一致，请沿用原请求核对回执。");
      return result;
    },
    listMergeDecisions: async (value: ListMergeDecisionsInput = {}, options: Options = {}) => {
      const query = input(ListMergeDecisionsInputSchema, value);
      const result = await request("jobs/reconciliation/history", MergeDecisionsPageSchema, options, query);
      if (result.limit !== query.limit || result.items.length !== Math.min(result.totalAvailable, query.limit)
        || result.truncated !== (result.totalAvailable > query.limit)
        || new Set(result.items.map(item => item.decision.id)).size !== result.items.length
        || result.items.some(item => item.decision.revision > result.snapshotRevision
          || (item.decision.kind === "revoke") !== (item.status === "revocation")))
        throw new AtlasSourceServiceError("invalid-response", "归并历史与本次范围或索引版本不一致，请重新读取。");
      return result;
    },
    previewRevokeMerge: async (value: PreviewRevokeMergeReviewInput, options: Options = {}) => {
      const query = input(PreviewRevokeMergeReviewInputSchema, value);
      const result = await request("jobs/reconciliation/preview-revoke", RevokeMergeReviewPreviewSchema, options, query);
      if (result.snapshotRevision !== query.expectedRevision || result.expectedRevision !== query.expectedRevision
        || JSON.stringify(result.input) !== JSON.stringify(query) || result.decision.id !== query.decisionId
        || result.decision.kind === "revoke" || result.decision.revision > result.snapshotRevision
        || result.before.length === 0 || result.after.length === 0
        || result.counts.beforeJobs !== result.before.length || result.counts.afterJobs !== result.after.length
        || new Set(result.before.map(side => side.canonicalJobId)).size !== result.before.length
        || new Set(result.after.map(side => side.canonicalJobId)).size !== result.after.length
        || result.before.some(side => !matchingMergeSide(side)) || result.after.some(side => !matchingMergeSide(side)))
        throw new AtlasSourceServiceError("invalid-response", "撤销预览与本次决议、说明或版本不一致，请重新预览。");
      return result;
    },
    revokeMerge: async (value: RevokeMergeReviewInput, options: WriteOptions) => {
      const query = input(RevokeMergeReviewInputSchema, value);
      const result = await request("jobs/reconciliation/revoke", ReconciliationReceiptSchema, options, query, input(KeySchema, options.idempotencyKey));
      if (result.decision.kind !== "revoke" || result.decision.targetDecisionId !== query.decisionId
        || !matchingReceiptRevision(result, query.expectedRevision, query.reason))
        throw new AtlasSourceServiceError("invalid-response", "撤销归并回执与本次请求不一致，请沿用原请求核对回执。");
      return result;
    },
    previewLocationConfirmation: async (value: PreviewLocationConfirmationInput, options: Options = {}) => {
      const query = input(PreviewLocationConfirmationInputSchema, value);
      const result = await request("locations/confirmations/preview", LocationConfirmationPreviewSchema, options, query);
      if (result.expectedRevision !== query.expectedRevision || result.jobId !== query.jobId || result.locationId !== query.locationId)
        throw new AtlasSourceServiceError("invalid-response", "地点预览与本次岗位或版本不一致，请重新核对。");
      return result;
    },
    confirmLocation: async (value: ConfirmLocationInput, options: WriteOptions) => {
      const query = input(ConfirmLocationInputSchema, value);
      const result = await request("locations/confirmations", LocationConfirmationReceiptSchema, options, query, input(KeySchema, options.idempotencyKey));
      if (result.jobId !== query.jobId || result.locationId !== query.locationId || result.revision <= query.expectedRevision)
        throw new AtlasSourceServiceError("invalid-response", "地点写入回执与本次请求不一致，请重试同一请求核对回执。");
      return result;
    },
    revokeLocationConfirmation: async (value: RevokeLocationConfirmationInput, options: WriteOptions) => {
      const query = input(RevokeLocationConfirmationInputSchema, value);
      const result = await request("locations/confirmations/revoke", LocationConfirmationReceiptSchema, options, query, input(KeySchema, options.idempotencyKey));
      if (result.jobId !== query.jobId || result.locationId !== query.locationId || result.revision <= query.expectedRevision)
        throw new AtlasSourceServiceError("invalid-response", "地点撤销回执与本次请求不一致，请重试同一请求核对回执。");
      return result;
    },
    officeAddressCandidates: async (value: OfficeAddressCandidatesInput, options: Options = {}) => {
      const query = input(OfficeAddressCandidatesInputSchema, value);
      const result = await request("locations/office-address/candidates", OfficeAddressCandidatesResultSchema, options, query);
      if (result.revision !== query.expectedRevision || result.jobId !== query.jobId || result.locationId !== query.locationId
        || result.sourceLocation.id !== query.locationId || result.sourceLocation.kind !== "office"
        || !result.sourceLocation.evidence.length || new Set(result.candidates.map(candidate => candidate.id)).size !== result.candidates.length
        || !query.query && (result.status !== "manual-available" || result.candidates.length !== 0)
        || !!query.query && !result.configured && result.status !== "not-configured"
        || !!query.query && result.configured && !["candidates", "no-address-match"].includes(result.status)
        || !result.configured && (result.candidates.length !== 0 || result.status === "candidates")
        || (result.status === "candidates") !== (result.candidates.length > 0))
        throw new AtlasSourceServiceError("invalid-response", "地址候选与本次岗位、地点、读取范围或版本不一致，请重新读取。");
      return result;
    },
    previewOfficeConfirmation: async (value: PreviewOfficeConfirmationInput, options: Options = {}) => {
      const query = input(PreviewOfficeConfirmationInputSchema, value);
      const result = await request("locations/office-address/preview", OfficeAddressPreviewSchema, options, query);
      if (result.expectedRevision !== query.expectedRevision || result.jobId !== query.jobId || result.locationId !== query.locationId
        || [result.current.id, result.sourceLocation.id, result.proposed.id].some(id => id !== query.locationId)
        || result.sourceLocation.officeResolution || !result.sourceLocation.evidence.length
        || result.activeDecisionId !== result.current.officeResolution?.decisionId
        || !matchingOfficeProposal(result.proposed, query.proposal)
        || result.proposed.raw !== result.sourceLocation.raw || !sameLocationValue(result.proposed.evidence, result.sourceLocation.evidence))
        throw new AtlasSourceServiceError("invalid-response", "办公地址预览与本次输入、岗位或版本不一致，请重新核对。");
      return result;
    },
    confirmOfficeAddress: async (value: ConfirmOfficeAddressInput, options: WriteOptions) => {
      const query = input(ConfirmOfficeAddressInputSchema, value);
      const result = await request("locations/office-address/confirmations", OfficeAddressReceiptSchema, options, query, input(KeySchema, options.idempotencyKey));
      if (result.jobId !== query.jobId || result.locationId !== query.locationId || result.location.id !== query.locationId
        || result.revision !== query.expectedRevision + 1 || result.activeDecisionId !== result.decisionId
        || result.location.officeResolution?.decisionId !== result.decisionId || !matchingOfficeProposal(result.location, query.proposal))
        throw new AtlasSourceServiceError("invalid-response", "办公地址写入回执与本次输入不一致，请沿用原请求核对回执。");
      return result;
    },
    revokeOfficeAddress: async (value: RevokeOfficeAddressInput, options: WriteOptions) => {
      const query = input(RevokeOfficeAddressInputSchema, value);
      const result = await request("locations/office-address/revoke", OfficeAddressReceiptSchema, options, query, input(KeySchema, options.idempotencyKey));
      if (result.jobId !== query.jobId || result.locationId !== query.locationId || result.location.id !== query.locationId
        || result.revision !== query.expectedRevision + 1 || result.decisionId === query.decisionId
        || result.activeDecisionId === query.decisionId || result.activeDecisionId !== result.location.officeResolution?.decisionId)
        throw new AtlasSourceServiceError("invalid-response", "办公地址撤销回执与本次请求不一致，请沿用原请求核对回执。");
      return result;
    },
    geocodeCandidates: async (value: GeocodingInput, options: Options = {}) => {
      const query = input(GeocodingRequestSchema, value);
      const result = await request("locations/geocode-candidates", GeocodingResultSchema, options, query);
      if (JSON.stringify(result.request) !== JSON.stringify(query)) throw new AtlasSourceServiceError("invalid-response", "地点候选与本次查询不一致，请重新查询。");
      return result;
    },
    list: (options: Options = {}) => request("sources", AtlasSourceListSchema, options),
    register: async (value: AtlasRegisterSource, options: WriteOptions) => request("sources", ReceiptSchema, options, input(AtlasRegisterSourceSchema, value), input(KeySchema, options.idempotencyKey)),
    preview: async (sourceId: string, value: Omit<AtlasSourceScopeInput, "maxPages">, options: Options = {}) => request(`${sourcePath(sourceId)}/preview`, AtlasSourcePreviewSchema, options, input(PreviewInputSchema, value)),
    sync: async (sourceId: string, value: AtlasSourceScopeInput, options: WriteOptions) => request(`${sourcePath(sourceId)}/sync`, AtlasSourceSyncSchema, options, input(SyncInputSchema, value), input(KeySchema, options.idempotencyKey)),
    discover: async (sourceId: string, value: DiscoverSourceCandidatesInput, options: Options = {}) => request("sources/discover", SourceDiscoveryPageSchema, options, { sourceId: input(EntityIdSchema, sourceId), request: input(DiscoverSourceCandidatesInputSchema, value) }),
    companyDiscoveryCapabilities: (options: Options = {}) => request("companies/discovery-capabilities", CompanyCareerDiscoveryCapabilitiesSchema, options),
    discoverCompany: async (sourceId: string | undefined, value: DiscoverCompanyCareersInput, options: Options = {}) => {
      const query = input(DiscoverCompanyCareersRequestSchema, { ...(sourceId === undefined ? {} : { sourceId }), request: value });
      const result = await request("companies/discover-careers", CompanyCareerDiscoveryResultSchema, options, query);
      if (result.companyName !== query.request.companyName
        || result.proposals.some(proposal => proposal.source.enabled || proposal.source.status !== "needs-review"))
        throw new AtlasSourceServiceError("invalid-response", "企业发现结果与本次企业或禁用提案不一致，请重新核对。");
      return result;
    },
    inspect: async (sourceId: string, value: InspectSourceCandidateInput, options: Options = {}) => request("sources/inspect", SourceCandidateInspectionSchema, options, { sourceId: input(EntityIdSchema, sourceId), request: input(InspectSourceCandidateInputSchema, value) }),
    propose: async (value: ProposeSourceRegistrationInput, options: Options = {}) => request("sources/propose", SourceRegistrationProposalSchema, options, input(ProposeSourceRegistrationInputSchema, value)),
    planAddressEnrichment: async (value: PlanAddressEnrichmentInput, options: Options = {}) => {
      const query = input(PlanAddressEnrichmentInputSchema, value);
      const result = await request("jobs/address-enrichment/plan", AddressEnrichmentPlanSchema, options, query);
      if (result.snapshotRevision !== query.expectedRevision || result.requestedJobs !== query.jobIds.length
        || !sameIds(result.items.map(item => item.jobId), query.jobIds)) throw new AtlasSourceServiceError("invalid-response", "办公地点补全计划与当前岗位或索引版本不一致，请重新读取。");
      return result;
    },
    snapshot: (options: Options = {}) => readAtlasSnapshot(endpoint, token, options),
    previewDetailLocations: async (value: PreviewDetailLocationsInput, options: Options = {}) => {
      const query = input(PreviewDetailLocationsInputSchema, value);
      const result = await request("jobs/detail-locations/preview", DetailLocationsPreviewSchema, options, query);
      const sameAddress = (location: JobLocation, address: typeof query.capture.locations[number]) =>
        (["raw", "countryCode", "region", "city", "streetAddress", "postalCode"] as const).every(field => location[field] === address[field])
        && location.evidence.some(ref => ref.sourceUrl === query.capture.url && ref.observedAt === query.capture.capturedAt && ref.selector === address.evidence.selector && ref.quote === address.evidence.quote);
      if (result.jobId !== query.jobId || result.listingId !== query.listingId || result.sourceId !== `reviewed-platform-${query.capture.provider}` || result.expectedRevision !== query.expectedRevision
        || !result.newLocations.length || result.newLocations.length > query.capture.locations.length
        || result.newLocations.some(location => location.coordinates || location.originalCoordinates || location.officeResolution || location.userResolution || location.verification !== "unverified"
          || location.kind !== (query.capture.workMode === "remote" ? "remote-region" : "office") || !query.capture.locations.some(address => sameAddress(location, address)))
        || query.capture.locations.some(address => !result.newLocations.some(location => sameAddress(location, address))))
        throw new AtlasSourceServiceError("invalid-response", "地点预览与本次岗位、来源或索引版本不一致。");
      return result;
    },
    importDetailLocations: async (value: ImportDetailLocationsInput, options: WriteOptions) => {
      const query = input(ImportDetailLocationsInputSchema, value);
      const result = await request("jobs/detail-locations/import", ReceiptSchema, options, query, input(KeySchema, options.idempotencyKey));
      if (result.jobIds.length !== 1 || result.jobIds[0] !== query.jobId || ![query.expectedRevision, query.expectedRevision + 1].includes(result.revision)
        || result.counts.newJobs !== 0 || result.counts.newListings !== 0 || result.counts.newSnapshots !== 0 || result.snapshotIds.length !== 0
        || result.counts.updatedJobs + result.counts.unchangedJobs !== 1 || result.counts.updatedJobs > 1 || result.counts.newObservations > 1
        || (result.revision === query.expectedRevision && (result.counts.updatedJobs !== 0 || result.counts.newObservations !== 0)))
        throw new AtlasSourceServiceError("invalid-response", "地点保存回执与本次已有岗位不一致，请使用原请求核对回执。");
      return result;
    },
    previewReviewedCards: (value: PreviewReviewedCardsInput, options: Options = {}) => request("jobs/reviewed-cards/preview", ReviewedCardsPreviewSchema, options, input(PreviewReviewedCardsInputSchema, value)),
    importReviewedCards: (value: ImportReviewedCardsInput, options: WriteOptions) => request("jobs/reviewed-cards/import", ReceiptSchema, options, input(ImportReviewedCardsInputSchema, value), input(KeySchema, options.idempotencyKey)),
    previewCompanyControllerOverride: (value: PreviewCompanyControllerOverrideInput, options: Options = {}) => request("companies/controllers/preview", CompanyControllerOverridePreviewSchema, options, input(PreviewCompanyControllerOverrideInputSchema, value)),
    confirmCompanyControllerOverride: (value: ConfirmCompanyControllerOverrideInput, options: WriteOptions) => request("companies/controllers/confirm", CompanyControllerOverrideReceiptSchema, options, input(ConfirmCompanyControllerOverrideInputSchema, value), input(KeySchema, options.idempotencyKey)),
    revokeCompanyControllerOverride: (value: RevokeCompanyControllerOverrideInput, options: WriteOptions) => request("companies/controllers/revoke", CompanyControllerOverrideReceiptSchema, options, input(RevokeCompanyControllerOverrideInputSchema, value), input(KeySchema, options.idempotencyKey)),
  };
}

/** Supports the checked-in config/sources array without implicitly saving or enabling its members. */
export function parseAtlasSourceJson(text: string): AtlasRegisterSource[] {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new AtlasSourceServiceError("invalid-input", "来源配置不是有效 JSON。"); }
  const values = Array.isArray(value) ? value : [value];
  if (values.length < 1 || values.length > 1000) throw new AtlasSourceServiceError("invalid-input", "一次可检查 1–1000 项来源配置。");
  return values.map((entry) => {
    const wrapped = AtlasRegisterSourceSchema.safeParse(entry);
    return wrapped.success ? wrapped.data : { source: input(SourceDefinitionSchema, entry) };
  });
}
