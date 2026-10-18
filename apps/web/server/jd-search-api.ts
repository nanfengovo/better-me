import type { IncomingMessage, ServerResponse } from "node:http";
import { PlatformSearchInputSchema } from "@better-me/source-adapters/platform-search";
import type { JobSessionBackend } from "./jd-session-router";
import { isTrustedLocalRequest } from "./network-proxy";
import { JdExtractionError } from "../src/lib/jd-errors";
import { isJdStartRequestId } from "../src/lib/jd-start-request";

const send = (response: ServerResponse, status: number, value: unknown) => {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
};

/** Uses the same browser owner and global page lease as the single-job reader. */
export async function jobSearchMiddleware(request: IncomingMessage, response: ServerResponse, sessions: JobSessionBackend) {
  if (!isTrustedLocalRequest(request) || !request.headers.origin || !request.headers.host) {
    send(response, 403, { error: "平台岗位搜索仅允许本机工作台同源访问。" }); return;
  }
  if (request.method !== "POST") { send(response, 405, { error: "请使用 POST 搜索岗位。" }); return; }
  if (!request.headers["content-type"]?.includes("application/json")) { send(response, 415, { error: "仅接受 JSON 搜索参数。" }); return; }
  const operation = new AbortController();
  const abort = () => operation.abort(new DOMException("搜索操作已取消。", "AbortError"));
  const closed = () => { if (!response.writableEnded) abort(); };
  request.on("aborted", abort); response.on("close", closed);
  const timer = setTimeout(() => { abort(); request.destroy(); }, 5_000);
  try {
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of request) {
      operation.signal.throwIfAborted(); bytes += chunk.length;
      if (bytes > 32_000) { send(response, 413, { error: "搜索请求超过上限。" }); return; }
      chunks.push(Buffer.from(chunk));
    }
    clearTimeout(timer);
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      body = parsed as Record<string, unknown>;
    } catch { send(response, 400, { error: "搜索请求必须是有效 JSON。" }); return; }
    operation.signal.throwIfAborted();
    const owner = `${request.headers.origin}\n${request.headers.host}`;
    if (body.action === "start") {
      const input = PlatformSearchInputSchema.safeParse(body.input);
      if (!input.success) { send(response, 400, { error: "平台、关键词或地区参数无效。" }); return; }
      if (!isJdStartRequestId(body.requestId)) { send(response, 400, { error: "搜索启动标识无效。" }); return; }
      if (!sessions.startSearchRequest) throw new JdExtractionError({ code: "service_unavailable", stage: "service", message: "本机服务尚未加载可恢复搜索工具，请更新本地服务。" });
      send(response, 200, await sessions.startSearchRequest(owner, input.data, body.requestId, operation.signal));
    } else if (body.action === "cancel-start") {
      const input = PlatformSearchInputSchema.safeParse(body.input);
      if (!input.success || !isJdStartRequestId(body.requestId)) { send(response, 400, { error: "原始搜索参数或启动标识无效，未操作其他会话。" }); return; }
      if (!sessions.cancelSearchStart) throw new JdExtractionError({ code: "service_unavailable", stage: "service", message: "本机服务尚不支持按启动标识结束搜索。" });
      send(response, 200, await sessions.cancelSearchStart(owner, input.data, body.requestId));
    } else if (body.action === "read" && typeof body.sessionId === "string" && /^[a-z\d_-]{16,200}$/i.test(body.sessionId)) {
      if (!sessions.readSearch) throw new JdExtractionError({ code: "service_unavailable", stage: "service", message: "本机服务尚未加载搜索列表读取工具。" });
      const result = await sessions.readSearch(owner, body.sessionId, operation.signal);
      send(response, 200, { ...result, capturedAt: new Date().toISOString() });
    } else send(response, 400, { error: "请选择搜索启动或读取操作，并提供有效参数。" });
  } catch (error) {
    const failure = error instanceof JdExtractionError ? error.failure : { code: "browser_unavailable", stage: "service", message: "平台搜索读取未完成，请检查专用浏览器页面后重试。" };
    send(response, 422, { error: failure.message, failure });
  } finally { clearTimeout(timer); request.off("aborted", abort); response.off("close", closed); }
}
