import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { extname, resolve, sep } from "node:path";

export type GatewayOptions = {
  root: string; origins: string[]; agentEndpoint: string; jobEndpoint: string;
  agentToken: string; jobToken: string;
  health: () => Promise<boolean>;
  /** Container-side URL of a host Ollama. Never inferred from arbitrary URLs. */
  ollamaEndpoint?: string;
};
export function sendRuntimeJson(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(value));
}
export function trustedRuntimeRequest(req: IncomingMessage, origins: string[]): boolean {
  const configured = origins.find(origin => new URL(origin).host === req.headers.host);
  return Boolean(configured && (!req.headers.origin || req.headers.origin === configured)
    && req.headers["sec-fetch-site"] !== "cross-site"
    && (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method ?? "") || req.headers.origin === configured));
}
function tokenMatches(req: IncomingMessage, token: string) {
  const actual = Buffer.from(req.headers.authorization ?? ""), expected = Buffer.from("Bearer " + token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
/** Rewrite only the explicit local Ollama endpoint; never send credentials to a guessed gateway. */
export function containerModelBody(body: Buffer, endpoint?: string): Buffer {
  if (!endpoint) return body;
  try {
    const data = JSON.parse(body.toString("utf8"));
    const settings = data.modelSettings;
    if (!settings || typeof settings.baseUrl !== "string") return body;
    const url = new URL(settings.baseUrl);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.port !== "11434" || url.protocol !== "http:") return body;
    const host = new URL(endpoint);
    settings.baseUrl = host.origin + url.pathname;
    return Buffer.from(JSON.stringify(data));
  } catch { return body; }
}
async function proxy(req: IncomingMessage, res: ServerResponse, endpoint: string, token: string, ollama?: string) {
  if (!tokenMatches(req, token)) return sendRuntimeJson(res, 401, { error: "unauthorized" });
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 64 * 1024 * 1024) return sendRuntimeJson(res, 413, { error: "request_too_large" });
    chunks.push(Buffer.from(chunk));
  }
  let body = Buffer.concat(chunks);
  if (ollama) body = containerModelBody(body, ollama);
  const target = new URL(req.url!, endpoint);
  // endpoint is a fixed internal loopback service, never taken from the request.
  if (target.origin !== new URL(endpoint).origin) return sendRuntimeJson(res, 400, { error: "invalid_path" });
  const upstream = httpRequest(target, { method: req.method, headers: {
    authorization: "Bearer " + token,
    ...(req.headers.origin ? { origin: req.headers.origin } : {}),
    ...(req.headers["content-type"] ? { "content-type": req.headers["content-type"] } : {}),
    ...(req.headers["idempotency-key"] ? { "idempotency-key": req.headers["idempotency-key"] } : {}),
    ...(req.headers["x-request-id"] ? { "x-request-id": req.headers["x-request-id"] } : {}),
    ...(body.length ? { "content-length": String(body.length) } : {}),
  } }, response => {
    res.writeHead(response.statusCode ?? 502, { ...response.headers, "cache-control": "no-store", "x-content-type-options": "nosniff" });
    response.pipe(res);
  });
  upstream.setTimeout(180_000, () => upstream.destroy(new Error("upstream timeout")));
  res.once("close", () => { if (!res.writableEnded) upstream.destroy(); });
  upstream.on("error", () => { if (!res.headersSent) sendRuntimeJson(res, 503, { error: "service_recovering", message: "配套服务正在恢复，请稍后重试；已保存的数据不会清空。" }); else res.destroy(); });
  upstream.end(body);
}
const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".geojson": "application/geo+json", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".wasm": "application/wasm", ".woff2": "font/woff2", ".txt": "text/plain", ".md": "text/plain" };

export function createRuntimeGateway(options: GatewayOptions) {
  return createServer((req, res) => { void (async () => {
    if (!trustedRuntimeRequest(req, options.origins)) return sendRuntimeJson(res, 403, { error: "local_origin_required" });
    const url = new URL(req.url ?? "/", "http://" + req.headers.host);
    if (url.pathname === "/healthz") {
      const healthy = await options.health();
      return sendRuntimeJson(res, healthy ? 200 : 503, { mode: "full", status: healthy ? "ok" : "recovering" });
    }
    if (url.pathname === "/__better-me/runtime.js") {
      if (req.method !== "GET") return sendRuntimeJson(res, 405, { error: "method_not_allowed" });
      res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin" });
      res.end("window.__BETTER_ME_RUNTIME__=" + JSON.stringify({ mode: "docker", origin: url.origin, agentToken: options.agentToken, jobToken: options.jobToken }) + ";"); return;
    }
    if (url.pathname === "/__better-me/dev/local-job-index") {
      if (req.method !== "GET") return sendRuntimeJson(res, 405, { error: "method_not_allowed" });
      return sendRuntimeJson(res, 200, { endpoint: url.origin, token: options.jobToken });
    }
    if (url.pathname.startsWith("/api/v1/")) {
      const agent = url.pathname.startsWith("/api/v1/agent/");
      return proxy(req, res, agent ? options.agentEndpoint : options.jobEndpoint, agent ? options.agentToken : options.jobToken, agent ? options.ollamaEndpoint : undefined);
    }
    if (url.pathname.startsWith("/api/") || url.pathname === "/api") return sendRuntimeJson(res, 501, { error: "host_browser_required", message: "此操作需要宿主机可交互的招聘浏览器。请使用本机 pnpm dev，或粘贴岗位原文；容器不会接管你的个人浏览器。" });
    if (!["GET", "HEAD"].includes(req.method ?? "")) return sendRuntimeJson(res, 405, { error: "method_not_allowed" });
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.split("/").some(part => part.startsWith("."))) return sendRuntimeJson(res, 404, { error: "not_found" });
    const root = await realpath(options.root);
    let file = resolve(root, "." + pathname);
    if (!file.startsWith(root + sep) && file !== root) return sendRuntimeJson(res, 404, { error: "not_found" });
    try { if ((await stat(file)).isDirectory()) file = resolve(file, "index.html"); await stat(file); }
    catch {
      if (extname(pathname) || pathname.startsWith("/legal/") || pathname.startsWith("/assets/") || pathname.startsWith("/__better-me/")) return sendRuntimeJson(res, 404, { error: "not_found" });
      file = resolve(root, "index.html");
    }
    file = await realpath(file);
    if (!file.startsWith(root + sep)) return sendRuntimeJson(res, 404, { error: "not_found" });
    res.setHeader("Content-Type", mime[extname(file)] ?? "application/octet-stream");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", /\/assets\/.+-[\w-]{8,}\./.test(pathname) ? "public, max-age=31536000, immutable" : "no-store");
    if (req.method === "HEAD") { res.end(); return; }
    if (file === resolve(root, "index.html")) {
      const html = await readFile(file, "utf8");
      res.end(html.replace("<head>", '<head><script src="/__better-me/runtime.js"></script>')); return;
    }
    createReadStream(file).on("error", () => res.destroy()).pipe(res);
  })().catch(() => { if (!res.headersSent) sendRuntimeJson(res, 500, { error: "request_failed" }); else res.destroy(); }); });
}
