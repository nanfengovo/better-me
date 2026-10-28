import { z } from "zod";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const BackgroundEnrichmentStatusSchema = z.object({
  revision: count,
  pending: count,
  running: count,
  completed: count,
  failed: count,
  nextRetryAt: z.string().datetime({ offset: true }).optional(),
  workerState: z.enum(["idle", "running", "stopped", "error"]).optional(),
  workerError: z.string().min(1).max(300).optional(),
}).strict();
/** Counts describe current background task rows, not a unique-job or run total. */
export type BackgroundEnrichmentStatus = z.infer<typeof BackgroundEnrichmentStatusSchema>;

const envelope = z.object({ ok: z.literal(true), requestId: z.string().min(1).max(150), value: BackgroundEnrichmentStatusSchema }).strict();
type Options = { signal?: AbortSignal; maxBytes?: number };
export class BackgroundEnrichmentClientError extends Error {
  constructor(readonly code: "invalid-endpoint" | "missing-token" | "transport-error" | "http-error" | "invalid-response" | "too-large", message: string, readonly status?: number) {
    super(message); this.name = "BackgroundEnrichmentClientError";
  }
}

/** Read-only observation; never submits, cancels or resumes server work. */
export async function readBackgroundEnrichmentStatus(endpoint: string, token: string, { signal, maxBytes = 64 * 1024 }: Options = {}): Promise<BackgroundEnrichmentStatus> {
  signal?.throwIfAborted();
  let base: URL;
  try { base = new URL(endpoint); } catch { throw new BackgroundEnrichmentClientError("invalid-endpoint", "后台补全只连接已授权的本机服务。"); }
  if (!["http:", "https:"].includes(base.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)
    || base.username || base.password || base.pathname !== "/" || base.search || base.hash) {
    throw new BackgroundEnrichmentClientError("invalid-endpoint", "后台补全只连接已授权的本机服务根地址。");
  }
  if (!token.trim() || token.length > 4096 || /[\r\n\0]/.test(token)) throw new BackgroundEnrichmentClientError("missing-token", "请先连接本机岗位服务，再读取后台补全状态。");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be a positive safe integer.");
  let response: Response;
  try {
    response = await fetch(new URL("/api/v1/enrichment/status", base), {
      method: "GET", signal, headers: { Authorization: `Bearer ${token.trim()}` },
      credentials: "omit", redirect: "error", cache: "no-store",
    });
  } catch {
    signal?.throwIfAborted();
    throw new BackgroundEnrichmentClientError("transport-error", "暂时无法读取后台补全状态，将自动重试；岗位列表仍可使用。");
  }
  if (signal?.aborted || !response.ok || response.redirected) {
    void response.body?.cancel().catch(() => {}); signal?.throwIfAborted();
    throw new BackgroundEnrichmentClientError("http-error", response.status === 404
      ? "本机服务尚不支持后台补全状态，请更新岗位服务；岗位列表仍可使用。"
      : "后台补全状态暂不可用，请核对服务连接与授权；岗位列表仍可使用。", response.status);
  }
  const over = () => new BackgroundEnrichmentClientError("too-large", "后台补全状态超过读取上限。");
  const length = response.headers.get("content-length");
  if (length !== null && /^\d+$/.test(length) && Number(length) > maxBytes) { void response.body?.cancel().catch(() => {}); throw over(); }
  if (!response.body) throw new BackgroundEnrichmentClientError("invalid-response", "本机服务未返回有效的后台补全状态。");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  let complete = false;
  try {
    signal?.throwIfAborted();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const parts: string[] = []; let bytes = 0;
    while (true) {
      const next = await reader.read(); signal?.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength; if (bytes > maxBytes) throw over();
      parts.push(decoder.decode(next.value, { stream: true }));
    }
    parts.push(decoder.decode());
    const parsed = envelope.safeParse(JSON.parse(parts.join("")));
    if (!parsed.success) throw new BackgroundEnrichmentClientError("invalid-response", "本机服务返回的后台补全状态不符合契约。");
    signal?.throwIfAborted(); complete = true; return parsed.data.value;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof BackgroundEnrichmentClientError) throw error;
    throw new BackgroundEnrichmentClientError("invalid-response", "本机服务返回的后台补全状态不符合契约。");
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
