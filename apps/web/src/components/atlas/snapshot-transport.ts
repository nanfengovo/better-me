import { AtlasDatasetSchema, type AtlasDataset } from "@better-me/opportunities";
import { AtlasClientError } from "./client-error";

export type SnapshotOptions = { signal?: AbortSignal; maxBytes?: number };
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
export function atlasConnection(endpoint: string, token: string, maxBytes = DEFAULT_MAX_BYTES) {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new AtlasClientError("invalid-endpoint", "请输入有效的本机服务地址。"); }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || !["http:", "https:"].includes(url.protocol) || url.username || url.password
      || url.search || url.hash || url.pathname !== "/") {
    throw new AtlasClientError("invalid-endpoint", "请输入本机 loopback 服务地址，例如 http://127.0.0.1:5178。");
  }
  if (!token.trim()) throw new AtlasClientError("missing-token", "请填写本机服务的访问令牌。");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be a positive safe integer.");
  return { url, token: token.trim(), maxBytes };
}

/** Shared bounded UTF-8/envelope reader for both versioned sync and legacy export. */
export async function readAtlasEnvelope(endpoint: string, token: string, { signal, maxBytes }: SnapshotOptions,
  request: { path: string; body?: unknown; allowUnsupported?: boolean }): Promise<{ supported: false } | { supported: true; value: unknown }> {
  signal?.throwIfAborted();
  const connection = atlasConnection(endpoint, token, maxBytes);
  const response = await fetch(new URL(request.path, connection.url), {
    signal, ...(request.body === undefined ? {} : { method: "POST" }),
    headers: { Authorization: `Bearer ${connection.token}`, ...(request.body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    credentials: "omit", redirect: "error", cache: "no-store",
  });
  if (signal?.aborted) void response.body?.cancel(signal.reason).catch(() => {});
  signal?.throwIfAborted();
  if (request.allowUnsupported && !response.redirected && [404, 405].includes(response.status)) {
    void response.body?.cancel().catch(() => {});
    return { supported: false };
  }
  if (!response.ok || response.redirected) {
    void response.body?.cancel().catch(() => {});
    throw new AtlasClientError("http-error", `服务返回 ${response.status}。请核对令牌和当前网页的允许 Origin。`);
  }
  const tooLarge = () => new AtlasClientError("too-large", "索引超过当前浏览器快照模式的字节上限，请缩小采集范围。");
  const declaredLength = response.headers.get("Content-Length");
  if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > connection.maxBytes) {
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
    const decoder = new TextDecoder("utf-8", { fatal: true }), parts: string[] = [];
    let bytes = 0;
    while (true) {
      const next = await reader.read();
      signal?.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > connection.maxBytes) throw tooLarge();
      parts.push(decoder.decode(next.value, { stream: true }));
    }
    parts.push(decoder.decode());
    let payload: unknown;
    try { payload = JSON.parse(parts.join("")); } catch { throw new AtlasClientError("invalid-response", "服务返回的索引不是有效 JSON。"); }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)
        || !("ok" in payload) || payload.ok !== true || !("value" in payload)
        || !("requestId" in payload) || typeof payload.requestId !== "string" || !payload.requestId.length || payload.requestId.length > 150
        || Object.keys(payload).some(key => !["ok", "requestId", "value"].includes(key))) {
      throw new AtlasClientError("invalid-response", "服务未返回有效的公开索引信封。");
    }
    signal?.throwIfAborted();
    complete = true;
    return { supported: true, value: payload.value };
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

/** Retained reference adapter for older services and non-browser clients. */
export async function readAtlasSnapshotLegacy(endpoint: string, token: string, options: SnapshotOptions = {}): Promise<AtlasDataset> {
  const result = await readAtlasEnvelope(endpoint, token, options, { path: "/api/v1/dataset/export" });
  const parsed = AtlasDatasetSchema.safeParse(result.supported ? result.value : undefined);
  if (!parsed.success) throw new AtlasClientError("invalid-response", "服务返回的公开索引不符合岗位数据契约。");
  options.signal?.throwIfAborted();
  return parsed.data;
}
