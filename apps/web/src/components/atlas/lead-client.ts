import { z } from "zod";
import { EntityIdSchema, TOOL_ERROR_CODES } from "@better-me/opportunities";
import {
  LeadQueryInputSchema, LeadQueryResultSchema, LeadReadInputSchema, LeadReadResultSchema,
  OriginalLeadReadInputSchema, OriginalLeadCaptureSchema, OriginalLeadPreviewInputSchema,
  OriginalLeadPreviewSchema, OriginalLeadImportInputSchema,
  type LeadQueryInput, type LeadReadInput, type OriginalLeadReadInput,
  type OriginalLeadPreviewInput, type OriginalLeadImportInput,
} from "@better-me/source-adapters/browser-contracts";
import { resolveAtlasServiceTarget } from "./backend-connection";
import { AtlasSourceServiceError } from "./service-client";

const count = z.number().int().nonnegative();
export const LeadImportReceiptSchema = z.object({
  ok: z.literal(true), revision: count, jobIds: z.array(EntityIdSchema), snapshotIds: z.array(EntityIdSchema),
  counts: z.object({ newJobs: count, updatedJobs: count, unchangedJobs: count,
    newListings: count, newObservations: count, newSnapshots: count }).strict(),
}).strict();
export type LeadImportReceipt = z.infer<typeof LeadImportReceiptSchema>;
type Options = { signal?: AbortSignal; maxBytes?: number };
const requestId = z.string().min(1).max(150);
const errorEnvelope = z.object({ ok: z.literal(false), requestId,
  error: z.object({ code: z.enum(TOOL_ERROR_CODES), message: z.string().max(4000) }).strict() }).strict();
const successEnvelope = z.object({ ok: z.literal(true), requestId, value: z.unknown() }).strict();
const keySchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);
const invalid = () => new AtlasSourceServiceError("invalid-response", "线索工具回执与本次请求不一致。写入结果仍需用原请求核对。");
function checked<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AtlasSourceServiceError("invalid-input", "线索请求不符合工具契约。");
  return parsed.data;
}
async function responseJson(response: Response, options: Options): Promise<unknown> {
  const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be positive.");
  const tooLarge = () => new AtlasSourceServiceError("too-large", "线索结果超过浏览器读取上限，请缩小范围。");
  if (Number(response.headers.get("content-length")) > maxBytes) { void response.body?.cancel().catch(() => {}); throw tooLarge(); }
  if (!response.body) throw invalid();
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  options.signal?.addEventListener("abort", abort, { once: true });
  let completed = false;
  try {
    options.signal?.throwIfAborted();
    const decoder = new TextDecoder("utf-8", { fatal: true }), parts: string[] = [];
    let bytes = 0;
    for (;;) {
      const next = await reader.read(); options.signal?.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw tooLarge();
      parts.push(decoder.decode(next.value, { stream: true }));
    }
    parts.push(decoder.decode()); const value: unknown = JSON.parse(parts.join("")); completed = true; return value;
  } catch (problem) {
    options.signal?.throwIfAborted();
    if (problem instanceof AtlasSourceServiceError) throw problem;
    throw invalid();
  } finally {
    options.signal?.removeEventListener("abort", abort);
    if (!completed) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Fixed tool routes only; URL selection and external access stay in the backend. */
export function createAtlasLeadClient(endpoint: string, token: string) {
  async function request<T>(route: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown, options: Options = {}, key?: string): Promise<T> {
    options.signal?.throwIfAborted();
    const target = resolveAtlasServiceTarget(endpoint, token);
    if (key !== undefined) checked(keySchema, key);
    let response: Response;
    try {
      response = await fetch(new URL(`leads/${route}`, target.apiRoot), { method: "POST", signal: options.signal,
        credentials: "omit", cache: "no-store", redirect: "error",
        headers: { ...target.headers, "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) }, body: JSON.stringify(input) });
    } catch (problem) {
      options.signal?.throwIfAborted();
      if (problem instanceof AtlasSourceServiceError) throw problem;
      throw new AtlasSourceServiceError("transport-error", "未收到线索工具回执；保存重试会沿用原请求和原幂等键。");
    }
    if (response.redirected || options.signal?.aborted) { void response.body?.cancel().catch(() => {}); options.signal?.throwIfAborted(); throw invalid(); }
    let body: unknown;
    try { body = await responseJson(response, options); }
    catch (problem) {
      if (response.status === 404 && problem instanceof AtlasSourceServiceError && problem.code === "invalid-response") throw new AtlasSourceServiceError("http-error", "岗位后端尚不支持持久线索接续，请更新并重启岗位后端。未定保存请保留原请求核对。", 404);
      throw problem;
    }
    options.signal?.throwIfAborted();
    const error = errorEnvelope.safeParse(body);
    if (error.success) throw new AtlasSourceServiceError(error.data.error.code, `线索工具返回 ${error.data.error.code}；请核对来源、版本及原页支持范围。`, response.status);
    if (!response.ok) throw new AtlasSourceServiceError("http-error", `线索服务返回 ${response.status}，保存结果尚未确认。`, response.status);
    const envelope = successEnvelope.safeParse(body);
    if (!envelope.success) throw invalid();
    const parsed = schema.safeParse(envelope.data.value);
    if (!parsed.success) throw invalid();
    return parsed.data;
  }
  return {
    query: async (input: LeadQueryInput, options: Options = {}) => request("query", LeadQueryResultSchema, checked(LeadQueryInputSchema, input), options),
    read: async (input: LeadReadInput, options: Options = {}) => {
      const query = checked(LeadReadInputSchema, input), result = await request("read", LeadReadResultSchema, query, options);
      if (result.lead.id !== query.leadId || query.expectedRevision !== undefined && result.snapshotRevision !== query.expectedRevision) throw invalid();
      return result;
    },
    readOriginal: async (input: OriginalLeadReadInput, options: Options = {}) => {
      const query = checked(OriginalLeadReadInputSchema, input), result = await request("original/read", OriginalLeadCaptureSchema, query, options);
      if (result.leadId !== query.leadId || result.leadDigest !== query.leadDigest || result.originalSourceId !== query.originalSourceId) throw invalid();
      return result;
    },
    previewOriginal: async (input: OriginalLeadPreviewInput, options: Options = {}) => {
      const query = checked(OriginalLeadPreviewInputSchema, input), result = await request("original/preview", OriginalLeadPreviewSchema, query, options);
      if (result.leadId !== query.capture.leadId || result.originalSourceId !== query.capture.originalSourceId
        || result.expectedRevision !== query.expectedRevision || !result.listings.length
        || !result.listings.every(listing => listing.canonicalJobId === result.job.id && listing.sourceId === result.originalSourceId)) throw invalid();
      return result;
    },
    importOriginal: async (input: OriginalLeadImportInput, options: Options & { idempotencyKey: string; jobId: string }) => {
      const query = checked(OriginalLeadImportInputSchema, input), jobId = checked(EntityIdSchema, options.jobId);
      const result = await request("original/import", LeadImportReceiptSchema, query, options, options.idempotencyKey);
      if (result.revision < query.expectedRevision || result.jobIds.length !== 1 || result.jobIds[0] !== jobId) throw invalid();
      return result;
    },
  };
}
