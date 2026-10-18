import { z } from "zod";
import { EntityIdSchema, SourceDefinitionSchema, TimestampSchema, TOOL_ERROR_CODES, GeocodingRequestSchema, GeocodingResultSchema, type GeocodingInput } from "@better-me/opportunities";
import {
  DiscoverSourceCandidatesInputSchema, InspectSourceCandidateInputSchema, ProposeSourceRegistrationInputSchema,
  SourceAdapterMetadataSchema, SourceCandidateInspectionSchema, SourceDiscoveryPageSchema,
  SourcePageSchema, SourceRegistrationProposalSchema, SourceScopeSchema,
  DiscoverCompanyCareersInputSchema, CompanyCareerDiscoveryResultSchema, type DiscoverCompanyCareersInput,
  type DiscoverSourceCandidatesInput, type InspectSourceCandidateInput, type ProposeSourceRegistrationInput,
  PreviewReviewedCardsInputSchema, ReviewedCardsPreviewSchema, ImportReviewedCardsInputSchema,
  type PreviewReviewedCardsInput, type ImportReviewedCardsInput,
} from "@better-me/source-adapters/browser-contracts";
import { AtlasClientError, readAtlasSnapshot } from "./client";
import {
  PreviewLocationConfirmationInputSchema, ConfirmLocationInputSchema, RevokeLocationConfirmationInputSchema,
  LocationConfirmationPreviewSchema, LocationConfirmationReceiptSchema,
  type PreviewLocationConfirmationInput, type ConfirmLocationInput, type RevokeLocationConfirmationInput,
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
    discoverCompany: async (sourceId: string, value: DiscoverCompanyCareersInput, options: Options = {}) => request("companies/discover-careers", CompanyCareerDiscoveryResultSchema, options, { sourceId: input(EntityIdSchema, sourceId), request: input(DiscoverCompanyCareersInputSchema, value) }),
    inspect: async (sourceId: string, value: InspectSourceCandidateInput, options: Options = {}) => request("sources/inspect", SourceCandidateInspectionSchema, options, { sourceId: input(EntityIdSchema, sourceId), request: input(InspectSourceCandidateInputSchema, value) }),
    propose: async (value: ProposeSourceRegistrationInput, options: Options = {}) => request("sources/propose", SourceRegistrationProposalSchema, options, input(ProposeSourceRegistrationInputSchema, value)),
    snapshot: (options: Options = {}) => readAtlasSnapshot(endpoint, token, options),
    previewReviewedCards: (value: PreviewReviewedCardsInput, options: Options = {}) => request("jobs/reviewed-cards/preview", ReviewedCardsPreviewSchema, options, input(PreviewReviewedCardsInputSchema, value)),
    importReviewedCards: (value: ImportReviewedCardsInput, options: WriteOptions) => request("jobs/reviewed-cards/import", ReceiptSchema, options, input(ImportReviewedCardsInputSchema, value), input(KeySchema, options.idempotencyKey)),
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
