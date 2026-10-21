import {
  AtlasDatasetSchema, JobQueryError, JobQuerySchema, queryJobs,
  type AtlasDataset, type JobQueryInput, type JobQueryResult, type JobSearchItem, type QueryOptions,
} from "@better-me/opportunities";

import { AtlasClientError, isDefaultAtlasEndpoint, resolveAtlasServiceTarget } from "./backend-connection";
export { AtlasClientError } from "./backend-connection";

type SnapshotOptions = { signal?: AbortSignal; maxBytes?: number };
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
function tooLarge(): AtlasClientError {
  return new AtlasClientError("too-large", "索引超过当前浏览器快照模式的字节上限，请缩小采集范围。");
}

/** Read only the public loopback export. The byte limit applies before decoding or parsing. */
export async function readAtlasSnapshot(endpoint: string, token: string, { signal, maxBytes = DEFAULT_MAX_BYTES }: SnapshotOptions = {}): Promise<AtlasDataset> {
  signal?.throwIfAborted();
  const target = resolveAtlasServiceTarget(endpoint, token);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be a positive safe integer.");
  const response = await fetch(new URL("dataset/export", target.apiRoot), {
    signal, headers: target.headers,
    credentials: "omit", redirect: "error", cache: "no-store",
  });
  if (signal?.aborted) void response.body?.cancel(signal.reason).catch(() => {});
  signal?.throwIfAborted();
  if (!response.ok || response.redirected) {
    void response.body?.cancel().catch(() => {});
    throw new AtlasClientError("http-error", isDefaultAtlasEndpoint(endpoint)
      ? `默认后端不可用（HTTP ${response.status}）。请启动本机网页与岗位后台后重试；GitHub 静态网页可在高级连接中直连本机服务。`
      : `服务返回 ${response.status}。请核对令牌和当前网页的允许 Origin。`);
  }
  const declaredLength = response.headers.get("Content-Length");
  if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!response.body) throw new AtlasClientError("invalid-response", "服务没有返回公开索引内容。");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  let complete = false;
  try {
    signal?.throwIfAborted();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const parts: string[] = [];
    let bytes = 0;
    while (true) {
      const next = await reader.read();
      signal?.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw tooLarge();
      parts.push(decoder.decode(next.value, { stream: true }));
    }
    parts.push(decoder.decode());
    let payload: unknown;
    try { payload = JSON.parse(parts.join("")); } catch { throw new AtlasClientError("invalid-response", "服务返回的索引不是有效 JSON。"); }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)
        || !("ok" in payload) || payload.ok !== true || !("value" in payload)
        || !("requestId" in payload) || typeof payload.requestId !== "string" || !payload.requestId.length || payload.requestId.length > 150
        || Object.keys(payload).some((key) => !["ok", "requestId", "value"].includes(key))) {
      throw new AtlasClientError("invalid-response", "服务未返回有效的公开索引信封。");
    }
    const parsed = AtlasDatasetSchema.safeParse(payload.value);
    if (!parsed.success) throw new AtlasClientError("invalid-response", "服务返回的公开索引不符合岗位数据契约。");
    signal?.throwIfAborted();
    complete = true;
    return parsed.data;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof TypeError) throw new AtlasClientError("invalid-response", "服务返回的索引包含无效 UTF-8 或读取失败。");
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export type AtlasPageOptions = { cursor?: string; selectedJobIds?: readonly string[]; signal?: AbortSignal };
export type AtlasPageResult = { summary: JobQueryResult; page: JobQueryResult };

/** Keep map/statistics on the base query; the list has its own genuine shared-query cursor. */
export async function queryAtlasPage(data: AtlasDataset, query: JobQueryInput, options: QueryOptions = {}, { cursor, selectedJobIds, signal }: AtlasPageOptions = {}): Promise<AtlasPageResult> {
  signal?.throwIfAborted();
  const baseQuery: JobQueryInput = { ...query, page: { limit: query.page?.limit } };
  if (selectedJobIds === undefined) {
    const result = await queryJobs(data, { ...baseQuery, page: { ...baseQuery.page, ...(cursor ? { cursor } : {}) } }, options);
    signal?.throwIfAborted();
    return { summary: result, page: result };
  }
  const selection = JobQuerySchema.shape.jobIds.safeParse(selectedJobIds);
  if (!selection.success) throw new JobQueryError("invalid-query", "所选岗位 ID 不符合岗位查询契约。");
  const summary = await queryJobs(data, baseQuery, options);
  signal?.throwIfAborted();
  const baseIds = query.jobIds === undefined ? undefined : new Set(query.jobIds);
  const jobIds = [...new Set(selection.data)].filter((id) => !baseIds || baseIds.has(id)).sort();
  const page = await queryJobs(data, { ...baseQuery, jobIds, page: { ...baseQuery.page, ...(cursor ? { cursor } : {}) } }, options);
  signal?.throwIfAborted();
  return { summary, page };
}

export type AtlasJobAction = { title: string; text: string; url?: string; platform: string; observedAt?: string; sourcePublishedAt?: string; sourcePublishedText?: string };

/** A record update or a failed read never becomes a source capture timestamp. */
export function buildAtlasJobAction(data: AtlasDataset, item: JobSearchItem): AtlasJobAction {
  const candidates = item.sources.map((source) => ({ source, listing: data.listings.find((listing) =>
    listing.id === source.listingId && listing.sourceId === source.sourceId && item.job.listingIds.includes(listing.id)
      && (!listing.canonicalJobId || listing.canonicalJobId === item.job.id)) })).filter((entry) => entry.listing);
  const snapshot = item.job.selectedSnapshotId ? data.snapshots.find((entry) => entry.id === item.job.selectedSnapshotId
    && item.job.listingIds.includes(entry.listingId)) : undefined;
  const primary = snapshot ? candidates.find((entry) => entry.listing!.id === snapshot.listingId) : candidates[0];
  const observationIds = new Set(primary?.listing?.observationIds ?? []);
  const observation = primary ? data.observations.filter((entry) => observationIds.has(entry.id)
    && entry.listingId === primary.listing!.id && (entry.result === "read" || entry.result === "partial")
    && (!item.job.selectedSnapshotId || (snapshot?.text === item.job.description && entry.id === snapshot.observationId
      && (!entry.snapshotId || entry.snapshotId === snapshot.id))))
    .sort((a, b) => Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt) || a.id.localeCompare(b.id))[0] : undefined;
  const url = primary ? snapshot?.sourceUrl ?? primary.listing?.canonicalUrl : undefined;
  return {
    title: `${item.company.names[0]} · ${item.job.title.value}`, text: item.job.description,
    ...(url ? { url } : {}), platform: primary?.source.label ?? "来源待核实",
    ...(observation ? { observedAt: observation.fetchedAt } : {}),
    ...(observation?.sourcePublishedAt ? { sourcePublishedAt: observation.sourcePublishedAt } : {}),
    ...(observation?.sourcePublishedRaw ? { sourcePublishedText: observation.sourcePublishedRaw } : {}),
  };
}
