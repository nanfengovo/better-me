import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadEnv, type Plugin } from "vite";
import type { ToolErrorCode } from "@better-me/opportunities";

const PREFIX = "/api/atlas";
const UPSTREAM_ORIGIN = "http://localhost:5173";
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const POST_ROUTES = new Set([
  "leads/query", "leads/read", "leads/original/read", "leads/original/preview", "leads/original/import",
  "jobs/address-enrichment/plan", "jobs/reconciliation/candidates", "jobs/reconciliation/preview", "jobs/reconciliation/preview-revoke",
  "jobs/reconciliation/merge", "jobs/reconciliation/reject", "jobs/reconciliation/history", "jobs/reconciliation/revoke", "jobs/search",
  "jobs/reviewed-cards/preview", "jobs/reviewed-cards/import", "jobs/detail-locations/preview", "jobs/detail-locations/import",
  "jobs/owned-detail-locations/read", "jobs/owned-detail-locations/preview", "jobs/owned-detail-locations/import",
  "compensations/review", "compensations/preview", "compensations/confirm", "compensations/revoke",
  "fx/state", "fx/preview", "fx/import", "fx/activate", "fx/reference",
  "companies/control-review/read", "companies/control-review/preview", "companies/control-review/confirm", "companies/control-review/revoke",
  "locations/geocode-candidates", "locations/office-address/candidates", "locations/office-address/preview", "locations/office-address/confirmations",
  "locations/office-address/revoke", "locations/map-references", "locations/confirmations/preview", "locations/confirmations", "locations/confirmations/revoke",
  "sources", "sources/discover", "companies/discover-careers", "sources/inspect", "sources/propose", "dataset/import",
]);
const GET_ROUTES = new Set(["sources", "companies/discovery-capabilities", "runs", "dataset/export", "leads"]);
const MESSAGES = {
  forbidden: "岗位后台仅允许当前本机工作台的同源访问。",
  invalidConfig: "岗位后台连接配置无效；服务地址须为本机根地址，令牌文件须使用本机绝对路径。",
  unconfigured: "本机岗位后台尚未配置；请确认岗位服务及服务端令牌文件已就绪。",
  unavailable: "本机岗位后台暂时不可用，请确认岗位服务已启动。",
  unauthorized: "岗位后台拒绝认证，请检查服务端连接配置。",
  route: "不支持此岗位后台请求。",
  request: "岗位后台请求格式无效。",
  tooLarge: "岗位后台请求或响应超过大小限制。",
  timeout: "岗位后台请求超时，请检查本机服务状态。",
  response: "岗位后台返回了无法使用的响应。",
};

type Status = "ready" | "unconfigured" | "unavailable" | "unauthorized" | "invalid-config";
export type AtlasBackendOptions = {
  /** Host-only configuration. These variables are never returned or bundled into the UI. */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  statusTimeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  /** Dependency seam for isolated middleware tests; production reads a bounded private file. */
  readTokenFile?: (filename: string) => Promise<string>;
};
class GatewayFailure extends Error {
  constructor(readonly status: number, readonly code: ToolErrorCode, message: string) { super(message); }
}
function send(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(value));
}
function errorResponse(response: ServerResponse, failure: GatewayFailure): void {
  send(response, failure.status, { ok: false, requestId: `gateway-${randomUUID()}`, error: { code: failure.code, message: failure.message } });
}
function isLoopbackHost(host: string): boolean { return ["localhost", "127.0.0.1", "[::1]"].includes(host); }
function trustedRequest(request: IncomingMessage): boolean {
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "")) return false;
  const site = request.headers["sec-fetch-site"], origin = request.headers.origin;
  if (site !== undefined && site !== "same-origin" && site !== "none") return false;
  let ownOrigin: string;
  try {
    const secure = "encrypted" in request.socket && request.socket.encrypted;
    const base = new URL(`${secure ? "https" : "http"}://${request.headers.host}`);
    if (!isLoopbackHost(base.hostname) || base.username || base.password || base.pathname !== "/" || base.search || base.hash) return false;
    ownOrigin = base.origin;
  } catch { return false; }
  if (origin !== undefined && origin !== ownOrigin) return false;
  return origin === ownOrigin || site === "same-origin";
}
function configuration(options: AtlasBackendOptions): { target: URL; tokenFile: string } | undefined {
  const env = options.env ?? process.env, platform = options.platform ?? process.platform;
  const value = env.BETTERME_JOB_SERVICE_URL ?? "http://127.0.0.1:5178";
  // Literal loopback only. localhost is pinned to IPv4 rather than resolved through DNS.
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[1-9]\d{0,4})?\/?$/.test(value)) return;
  let target: URL;
  try { target = new URL(value); } catch { return; }
  if (target.port && Number(target.port) > 65535) return;
  if (target.hostname === "localhost") target.hostname = "127.0.0.1";
  const home = options.homeDirectory ?? homedir();
  const dataHome = platform === "win32" ? env.LOCALAPPDATA ?? path.join(home, "AppData", "Local")
    : env.XDG_DATA_HOME ?? path.join(home, ".local", "share");
  const tokenFile = env.BETTERME_JOB_SERVICE_TOKEN_FILE ?? path.join(dataHome, "BetterMe", "job-atlas", "service.token");
  if (!path.isAbsolute(tokenFile) || /[\p{Cc}\p{Cs}]/u.test(tokenFile)) return;
  return { target, tokenFile };
}
async function privateTokenFile(filename: string): Promise<string> {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256) throw new Error("invalid-token");
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > 256) throw new Error("invalid-token");
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}
async function tokenFor(filename: string, options: AtlasBackendOptions): Promise<string | undefined> {
  try {
    const raw = await (options.readTokenFile ?? privateTokenFile)(filename);
    return /^[A-Za-z0-9_-]{43,128}\n?$/.test(raw) ? raw.trimEnd() : undefined;
  } catch { return; }
}
function identifier(value: string): boolean {
  try { return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(decodeURIComponent(value)); } catch { return false; }
}
function allowedRoute(method: string | undefined, suffix: string): boolean {
  if (!suffix.startsWith("/api/v1/")) return false;
  const route = suffix.slice("/api/v1/".length);
  if (method === "GET") return GET_ROUTES.has(route) || /^(?:jobs|runs)\/([^/]+)$/.test(route) && identifier(route.split("/")[1]!);
  if (method !== "POST") return false;
  if (POST_ROUTES.has(route)) return true;
  const dynamic = /^(?:sources\/([^/]+)\/(?:preview|sync|scan-progress|continue-sync)|runs\/([^/]+)\/cancel)$/.exec(route);
  return !!dynamic && identifier(dynamic[1] ?? dynamic[2]!);
}
function readBody(request: IncomingMessage, limit: number, signal: AbortSignal): Promise<Buffer> {
  const length = request.headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > limit)) {
    request.resume();
    return Promise.reject(new GatewayFailure(413, "budget-exceeded", MESSAGES.tooLarge));
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const cleanup = () => { request.off("data", data); request.off("end", end); request.off("error", error); signal.removeEventListener("abort", abort); };
    const fail = (failure: GatewayFailure) => { cleanup(); request.resume(); reject(failure); };
    const data = (chunk: Buffer) => { size += chunk.length; if (size > limit) fail(new GatewayFailure(413, "budget-exceeded", MESSAGES.tooLarge)); else chunks.push(Buffer.from(chunk)); };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const error = () => fail(new GatewayFailure(400, "invalid-input", MESSAGES.request));
    const abort = () => fail(new GatewayFailure(504, "timeout", MESSAGES.timeout));
    request.on("data", data); request.once("end", end); request.once("error", error); signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
async function readResponse(response: Response, limit: number, token: string, signal: AbortSignal): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") || !response.body) {
    await response.body?.cancel();
    throw new GatewayFailure(502, "invalid-output", MESSAGES.response);
  }
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    await response.body.cancel();
    throw new GatewayFailure(502, "budget-exceeded", MESSAGES.tooLarge);
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  let size = 0;
  try {
    signal.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new GatewayFailure(502, "budget-exceeded", MESSAGES.tooLarge);
      chunks.push(value);
    }
    signal.throwIfAborted();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    const value: unknown = JSON.parse(text);
    // Only API JSON crosses this boundary. Never expose a credential echoed by a
    // misconfigured listener, including JSON Unicode escapes, or upstream headers.
    if (!value || typeof value !== "object" || JSON.stringify(value).includes(token)) throw new Error("invalid-response");
    return value;
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof GatewayFailure) throw error;
    throw new GatewayFailure(502, "invalid-output", MESSAGES.response);
  } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
}

/** Same-origin local backend gateway; no caller-controlled URLs or browser-side service token. */
export function createAtlasBackendMiddleware(options: AtlasBackendOptions = {}) {
  return async (request: IncomingMessage, response: ServerResponse, next: () => void): Promise<void> => {
    const rawPath = request.url ?? "";
    if (rawPath !== PREFIX && !rawPath.startsWith(`${PREFIX}/`)) { next(); return; }
    if (!trustedRequest(request)) { errorResponse(response, new GatewayFailure(403, "not-authorized", MESSAGES.forbidden)); return; }
    const statusRequest = rawPath === `${PREFIX}/status` && request.method === "GET";
    if (/[?#\\\s\p{Cc}\p{Cs}]/u.test(rawPath) || !statusRequest && !allowedRoute(request.method, rawPath.slice(PREFIX.length))) {
      errorResponse(response, new GatewayFailure(404, "unsupported-capability", MESSAGES.route)); return;
    }
    const config = configuration(options);
    const status = (value: Status, configured: boolean) => send(response, 200, { mode: "same-origin-job-service", apiVersion: 1, configured, status: value, apiPrefix: PREFIX });
    if (!config) {
      if (statusRequest) status("invalid-config", false); else errorResponse(response, new GatewayFailure(503, "invalid-context", MESSAGES.invalidConfig));
      return;
    }
    const token = await tokenFor(config.tokenFile, options);
    if (!token) {
      if (statusRequest) status("unconfigured", false); else errorResponse(response, new GatewayFailure(503, "needs-auth", MESSAGES.unconfigured));
      return;
    }
    if (request.destroyed || response.destroyed) return;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, statusRequest ? options.statusTimeoutMs ?? 2_000 : options.timeoutMs ?? 130_000);
    const aborted = () => controller.abort();
    const closed = () => { if (!response.writableEnded) controller.abort(); };
    request.once("aborted", aborted); response.once("close", closed);
    try {
      const headers: Record<string, string> = { authorization: `Bearer ${token}`, origin: UPSTREAM_ORIGIN, accept: "application/json" };
      let body: Buffer | undefined;
      if (request.method === "POST") {
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) throw new GatewayFailure(415, "invalid-input", MESSAGES.request);
        body = await readBody(request, options.maxRequestBytes ?? MAX_REQUEST_BYTES, controller.signal);
        headers["content-type"] = "application/json";
      }
      for (const name of ["idempotency-key", "x-request-id"] as const) {
        const value = request.headers[name];
        if (typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value)) headers[name] = value;
      }
      const upstream = await (options.fetcher ?? fetch)(new URL(statusRequest ? "/healthz" : rawPath.slice(PREFIX.length), config.target), {
        method: request.method, headers, ...(body ? { body: new Uint8Array(body) } : {}), redirect: "error", signal: controller.signal,
      });
      if (upstream.status === 401 || upstream.status === 403) {
        await upstream.body?.cancel();
        if (statusRequest) status("unauthorized", true); else throw new GatewayFailure(502, "needs-auth", MESSAGES.unauthorized);
        return;
      }
      const value = await readResponse(upstream, statusRequest ? 1024 : options.maxResponseBytes ?? MAX_RESPONSE_BYTES, token, controller.signal);
      if (statusRequest) {
        const health = value as Record<string, unknown>;
        status(upstream.ok && health.status === "ok" && health.mode === "local-job-service" && health.apiVersion === 1 ? "ready" : "unavailable", true);
      } else send(response, upstream.status, value);
    } catch (error) {
      if (response.destroyed || response.writableEnded || controller.signal.aborted && !timedOut) return;
      if (statusRequest) status("unavailable", true);
      else errorResponse(response, timedOut ? new GatewayFailure(504, "timeout", MESSAGES.timeout)
        : error instanceof GatewayFailure ? error : new GatewayFailure(503, "internal-error", MESSAGES.unavailable));
    } finally {
      clearTimeout(timer); request.off("aborted", aborted); response.off("close", closed);
    }
  };
}
export function atlasBackendPlugin(): Plugin {
  let middleware = createAtlasBackendMiddleware();
  return {
    name: "betterme-atlas-backend",
    configResolved(config) {
      // Host-only project settings support a service launched outside this
      // terminal (including Windows app data redirection). Never use VITE_*.
      middleware = createAtlasBackendMiddleware({ env: {
        ...loadEnv(config.mode, config.envDir, "BETTERME_JOB_SERVICE_"), ...process.env,
      } });
    },
    configureServer(server) { server.middlewares.use((request, response, next) => { void middleware(request, response, next); }); },
    configurePreviewServer(server) { server.middlewares.use((request, response, next) => { void middleware(request, response, next); }); },
  };
}
