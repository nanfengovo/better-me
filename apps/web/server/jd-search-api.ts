import type { IncomingMessage, ServerResponse } from "node:http";
import { PlatformSearchInputSchema } from "@better-me/source-adapters/platform-search";
import type { JobSessionBackend } from "./jd-session-router";
import { isTrustedLocalRequest } from "./network-proxy";
import { JdExtractionError } from "../src/lib/jd-errors";
import { isJdStartRequestId } from "../src/lib/jd-start-request";
import {
  LiveBatchSearchInputSchema,
  liveBatchCardBudget,
  liveBatchProviderPageBudget,
  liveBatchScrollBudget,
  runLiveBatchSearch,
  type LiveBatchSearchInput,
  type LiveBatchSearchCallbacks,
} from "./jd-live-batch-search";
import {
  CompanyIntelligenceBatchInputSchema,
  CompanyIntelligenceLookupInputSchema,
  lookupCompanyIntelligence,
  lookupCompanyIntelligenceBatch,
} from "./company-intelligence";
import {
  HarvestPipelineInputSchema,
  OpportunityHarvestPipeline,
} from "./harvest-pipeline";

const send = (response: ServerResponse, status: number, value: unknown) => {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
};

const MAX_LIVE_STREAM_BYTES = 24 * 1024 * 1024;

export async function streamLiveBatchSearch(
  response: ServerResponse,
  input: LiveBatchSearchInput,
  operation: AbortController,
  runner: typeof runLiveBatchSearch = runLiveBatchSearch,
): Promise<void> {
  const { signal } = operation;
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders?.();
  let streamBytes = 0;
  const writeEvent = (event: unknown) => {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    streamBytes += Buffer.byteLength(frame, "utf8");
    if (streamBytes > MAX_LIVE_STREAM_BYTES) {
      operation.abort(new Error("实时搜索结果超过 24 MiB 安全上限，已停止本轮采集。"));
      return Promise.resolve(false);
    }
    if (response.destroyed || response.writableEnded || signal.aborted) return Promise.resolve(false);
    try {
      if (response.write(frame)) return Promise.resolve(true);
    } catch { return Promise.resolve(false); }
    return new Promise<boolean>((resolve) => {
      const finish = (writable: boolean) => {
        response.off("drain", onDrain);
        response.off("close", onClose);
        signal.removeEventListener("abort", onAbort);
        resolve(writable);
      };
      const onDrain = () => finish(true);
      const onClose = () => finish(false);
      const onAbort = () => finish(false);
      response.once("drain", onDrain);
      response.once("close", onClose);
      signal.addEventListener("abort", onAbort, { once: true });
      if (response.destroyed || response.writableEnded || signal.aborted) finish(false);
    });
  };
  const callbacks: LiveBatchSearchCallbacks = {
    async onProviderQueued(provider, platform) {
      await writeEvent({
        type: "provider-queued",
        provider,
        platform,
        pageLimit: liveBatchProviderPageBudget(provider, input.depth, input.maxPages),
        scrollLimit: liveBatchScrollBudget(provider, input.depth),
        cardLimit: liveBatchCardBudget(input.depth),
      });
    },
    async onProviderStart(provider, platform) {
      await writeEvent({
        type: "provider-start",
        provider,
        platform,
        pageLimit: liveBatchProviderPageBudget(provider, input.depth, input.maxPages),
        scrollLimit: liveBatchScrollBudget(provider, input.depth),
        cardLimit: liveBatchCardBudget(input.depth),
      });
    },
    async onProviderProgress(progress) {
      await writeEvent({
        type: "provider-progress",
        ...progress,
        pageLimit: liveBatchProviderPageBudget(progress.provider, input.depth, input.maxPages),
        scrollLimit: liveBatchScrollBudget(progress.provider, input.depth),
        cardLimit: liveBatchCardBudget(input.depth),
      });
    },
    async onProviderResult(result) { await writeEvent({ type: "provider-result", result }); },
  };
  try {
    const result = await runner(input, signal, callbacks);
    if (signal.aborted) throw signal.reason;
    await writeEvent({ type: "complete", capturedAt: result.capturedAt, providers: result.results.map((entry) => entry.provider) });
    if (!response.destroyed && !response.writableEnded) response.end();
  } catch (error) {
    if (response.destroyed || response.writableEnded) return;
    const failure = error instanceof JdExtractionError ? error.failure : undefined;
    // If a safety limit or disconnect aborts collection, the missing complete
    // event is deliberate; clients treat it as an incomplete run, never zero jobs.
    if (!signal.aborted) await writeEvent({ type: "error", message: failure?.message ?? (error instanceof Error ? error.message : "实时搜索未能完成。") });
    if (!response.destroyed && !response.writableEnded) response.end();
  }
}

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
    } else if (body.action === "live-batch-search") {
      const input = LiveBatchSearchInputSchema.safeParse(body.input);
      if (!input.success) { send(response, 400, { error: "多平台实时搜索关键词或地区参数无效。" }); return; }
      const result = await runLiveBatchSearch(input.data, operation.signal);
      send(response, 200, result);
    } else if (body.action === "live-batch-search-stream") {
      const input = LiveBatchSearchInputSchema.safeParse(body.input);
      if (!input.success) { send(response, 400, { error: "多平台实时搜索关键词或地区参数无效。" }); return; }
      await streamLiveBatchSearch(response, input.data, operation);
    } else if (body.action === "company-intelligence") {
      const input = CompanyIntelligenceLookupInputSchema.safeParse(body.input);
      if (!input.success) { send(response, 400, { error: "企业性质与办公地址查询参数无效。" }); return; }
      const result = await lookupCompanyIntelligence(input.data, operation.signal);
      send(response, 200, result);
    } else if (body.action === "harvest-pipeline") {
      const input = HarvestPipelineInputSchema.safeParse(body.input);
      if (!input.success) { send(response, 400, { error: "全链路流水线搜索参数无效。" }); return; }
      const pipeline = new OpportunityHarvestPipeline(input.data);
      const result = await pipeline.execute(operation.signal);
      send(response, 200, result);
    } else if (body.action === "company-intelligence-batch") {
      const input = CompanyIntelligenceBatchInputSchema.safeParse(body.input);
      if (!input.success) { send(response, 400, { error: "批量企业性质与办公地址查询参数无效。" }); return; }
      const result = await lookupCompanyIntelligenceBatch(input.data, operation.signal);
      send(response, 200, result);
    } else send(response, 400, { error: "请选择搜索启动或读取操作，并提供有效参数。" });
  } catch (error) {
    const failure = error instanceof JdExtractionError ? error.failure : { code: "browser_unavailable", stage: "service", message: "平台搜索读取未完成，请检查专用浏览器页面后重试。" };
    send(response, 422, { error: failure.message, failure });
  } finally { clearTimeout(timer); request.off("aborted", abort); response.off("close", closed); }
}
