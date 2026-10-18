import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { createToolRegistry, type TrustedToolContext } from "@better-me/opportunities";

type Registry = ReturnType<typeof createToolRegistry>;
export interface JobHttpOptions {
  registry: Registry;
  token: string;
  allowedOrigins: readonly string[];
  host?: "127.0.0.1" | "::1";
  port?: number;
  maxRequestBytes?: number;
}

const ROUTES: Array<{ method: string; path: RegExp; tool: string; key?: string }> = [
  { method: "POST", path: /^\/api\/v1\/jobs\/search$/, tool: "jobs.search" },
  { method: "POST", path: /^\/api\/v1\/locations\/geocode-candidates$/, tool: "locations.geocode-candidates" },
  { method: "GET", path: /^\/api\/v1\/jobs\/([^/]+)$/, tool: "jobs.read-detail", key: "jobId" },
  { method: "GET", path: /^\/api\/v1\/sources$/, tool: "sources.list" },
  { method: "POST", path: /^\/api\/v1\/sources$/, tool: "sources.register" },
  { method: "POST", path: /^\/api\/v1\/sources\/discover$/, tool: "sources.discover" },
  { method: "POST", path: /^\/api\/v1\/companies\/discover-careers$/, tool: "companies.discover-careers" },
  { method: "POST", path: /^\/api\/v1\/sources\/inspect$/, tool: "sources.inspect" },
  { method: "POST", path: /^\/api\/v1\/sources\/propose$/, tool: "sources.propose" },
  { method: "POST", path: /^\/api\/v1\/sources\/([^/]+)\/preview$/, tool: "sources.preview", key: "sourceId" },
  { method: "POST", path: /^\/api\/v1\/sources\/([^/]+)\/sync$/, tool: "sources.sync", key: "sourceId" },
  { method: "GET", path: /^\/api\/v1\/runs$/, tool: "runs.list" },
  { method: "GET", path: /^\/api\/v1\/runs\/([^/]+)$/, tool: "runs.read", key: "runId" },
  { method: "POST", path: /^\/api\/v1\/runs\/([^/]+)\/cancel$/, tool: "runs.cancel", key: "runId" },
  { method: "POST", path: /^\/api\/v1\/dataset\/import$/, tool: "jobs.import-public" },
  { method: "GET", path: /^\/api\/v1\/dataset\/export$/, tool: "jobs.export-public" },
  { method: "GET", path: /^\/api\/v1\/leads$/, tool: "leads.list" },
];
function send(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(value));
}
function sameToken(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
function loopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
async function readBody(request: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const length = request.headers["content-length"];
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new Error("too-large");
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    received += value.byteLength;
    if (received > maxBytes) throw new Error("too-large");
    chunks.push(value);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-json");
  return value as Record<string, unknown>;
}

/** Dedicated loopback API. No browser profiles, shell commands, private resume data or URL proxy. */
export function createJobHttpServer(options: JobHttpOptions) {
  if (!/^[A-Za-z0-9_-]{32,200}$/.test(options.token)) throw new Error("A strong local service token is required.");
  const origins = new Set(options.allowedOrigins.map((origin) => {
    const parsed = new URL(origin);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin || parsed.username || parsed.password) throw new Error("Invalid configured UI origin.");
    return origin;
  }));
  const token = options.token;
  const maxBytes = options.maxRequestBytes ?? 8 * 1024 * 1024;
  const server = createServer(async (request, response) => {
    // Host and peer checks protect the local API against DNS rebinding as well as CORS bypass.
    const listening = server.address();
    const port = listening && typeof listening === "object" ? listening.port : options.port;
    const hosts = new Set([`127.0.0.1:${port}`, `[::1]:${port}`]);
    if (!loopback(request.socket.remoteAddress) || !hosts.has(request.headers.host ?? "")) return send(response, 403, { error: "local-origin-required" });
    const origin = request.headers.origin;
    if (origin !== undefined && !origins.has(origin)) return send(response, 403, { error: "origin-not-allowed" });
    if (origin !== undefined) {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      if (!origin || !["GET", "POST"].includes(request.headers["access-control-request-method"] ?? "")) return send(response, 403, { error: "invalid-preflight" });
      const names = (request.headers["access-control-request-headers"] ?? "").toLowerCase().split(",").map((name) => name.trim()).filter(Boolean);
      if (names.some((name) => !["authorization", "content-type", "idempotency-key", "x-request-id"].includes(name))) return send(response, 403, { error: "invalid-preflight" });
      response.setHeader("access-control-allow-methods", "GET, POST");
      response.setHeader("access-control-allow-headers", "Authorization, Content-Type, Idempotency-Key, X-Request-Id");
      return send(response, 200, { ok: true });
    }
    if (!sameToken(request.headers.authorization, token)) return send(response, 401, { error: "unauthorized" });
    if (!request.url?.startsWith("/") || request.url.startsWith("//")) return send(response, 400, { error: "invalid-request" });
    let url: URL;
    try { url = new URL(request.url, "http://127.0.0.1"); }
    catch { return send(response, 400, { error: "invalid-request" }); }
    if (url.search) return send(response, 400, { error: "query-parameters-not-supported" });
    if (request.method === "GET" && url.pathname === "/healthz") return send(response, 200, { status: "ok", mode: "local-job-service", apiVersion: 1 });
    const route = ROUTES.find((candidate) => candidate.method === request.method && candidate.path.test(url.pathname));
    if (!route) return send(response, 404, { error: "route-not-found" });
    const cancellation = new AbortController();
    request.once("aborted", () => cancellation.abort());
    response.once("close", () => { if (!response.writableEnded) cancellation.abort(); });
    try {
      let input: Record<string, unknown> = {};
      if (request.method === "POST") {
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) return send(response, 415, { error: "json-required" });
        input = await readBody(request, maxBytes);
      }
      if (route.key) {
        const identifier = decodeURIComponent(route.path.exec(url.pathname)![1]!);
        if (Object.hasOwn(input, route.key) && input[route.key] !== identifier) return send(response, 400, { error: "conflicting-route-identifier" });
        input[route.key] = identifier;
      }
      const rawRequestId = request.headers["x-request-id"];
      const requestId = typeof rawRequestId === "string" && /^[A-Za-z0-9._:-]{1,150}$/.test(rawRequestId) ? rawRequestId : randomUUID();
      const key = request.headers["idempotency-key"];
      const context: TrustedToolContext = {
        requestId, signal: cancellation.signal, actorScope: "local-owner",
        allowedEffects: ["read-index", "external-read", "local-write"],
        budget: { requests: 80, bytes: 32 * 1024 * 1024, timeoutMs: 120_000 },
        ...(typeof key === "string" ? { idempotencyKey: key } : {}),
      };
      const result = await options.registry.execute(route.tool, input, context);
      const status = result.ok ? 200 : result.error.code === "invalid-input" || result.error.code === "invalid-context" ? 400 : result.error.code === "not-authorized" ? 403 : result.error.code === "stale-version" || result.error.code === "idempotency-conflict" ? 409 : result.error.code === "timeout" ? 504 : result.error.code === "rate-limited" ? 429 : 422;
      send(response, status, result);
    } catch (error) {
      send(response, error instanceof Error && error.message === "too-large" ? 413 : 400, { error: "invalid-request" });
    }
  });
  server.requestTimeout = 130_000;
  server.headersTimeout = 15_000;
  server.maxHeadersCount = 40;
  return {
    server,
    async listen(): Promise<{ url: string; port: number }> {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 5178, options.host ?? "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Local service listener did not initialize.");
      return { url: `http://${options.host === "::1" ? "[::1]" : "127.0.0.1"}:${address.port}`, port: address.port };
    },
    async close(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
