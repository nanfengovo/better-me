import assert from "node:assert/strict";
import test from "node:test";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAtlasBackendMiddleware, atlasBackendPlugin, type AtlasBackendOptions } from "../server/atlas-backend.js";
import { createToolRegistry } from "@better-me/opportunities";
import { createJobHttpServer } from "../../job-service/src/http.js";

const TOKEN = "synthetic_" + "x".repeat(40);
const PRIVATE_PATH = path.join(tmpdir(), "synthetic-secret-directory", "service.token");
const HEALTH = { status: "ok", mode: "local-job-service", apiVersion: 1 };
const ENVELOPE = { ok: true, requestId: "synthetic-request", data: { sources: [], adapters: [] } };
function baseOptions(extra: AtlasBackendOptions = {}): AtlasBackendOptions {
  return { env: { BETTERME_JOB_SERVICE_URL: "http://127.0.0.1:5178", BETTERME_JOB_SERVICE_TOKEN_FILE: PRIVATE_PATH },
    readTokenFile: async () => `${TOKEN}\n`, fetcher: async () => Response.json(ENVELOPE), ...extra };
}
async function fixture(options: AtlasBackendOptions) {
  const middleware = createAtlasBackendMiddleware(options);
  const server = createServer((request, response) => { void middleware(request, response, () => { response.writeHead(404); response.end("next"); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin,
    async call(route = "/api/atlas/api/v1/sources", init: RequestInit = {}) {
      return fetch(`${origin}${route}`, { ...init, headers: { Origin: origin, ...init.headers } });
    },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}
async function errorCode(response: Response, status: number, code: string) {
  assert.equal(response.status, status);
  const text = await response.text(), value = JSON.parse(text);
  assert.equal(value.ok, false); assert.match(value.requestId, /^gateway-/); assert.equal(value.error.code, code);
  assert.equal(text.includes(TOKEN), false); assert.equal(text.includes(PRIVATE_PATH), false);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
}

test("same-origin gateway injects host token and fixed Origin without forwarding browser credentials or backend headers", async () => {
  let calls = 0;
  const app = await fixture(baseOptions({ fetcher: async (input, init) => {
    calls++; assert.equal(String(input), "http://127.0.0.1:5178/api/v1/jobs/search");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`); assert.equal(headers.get("origin"), "http://localhost:5173");
    assert.equal(headers.get("cookie"), null); assert.equal(headers.get("x-forwarded-host"), null);
    assert.equal(headers.get("idempotency-key"), "synthetic-key"); assert.equal(headers.get("x-request-id"), "synthetic-ui-request");
    assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error");
    assert.deepEqual(JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)), { keyword: "C#" });
    return Response.json(ENVELOPE, { headers: { "set-cookie": "secret=value", authorization: TOKEN, "access-control-allow-origin": "*" } });
  } }));
  try {
    const response = await app.call("/api/atlas/api/v1/jobs/search", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer browser-value", Cookie: "browser-session=secret", "Idempotency-Key": "synthetic-key", "X-Request-Id": "synthetic-ui-request", "X-Forwarded-Host": "evil.example" }, body: JSON.stringify({ keyword: "C#" }) });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), ENVELOPE); assert.equal(calls, 1);
    for (const header of ["set-cookie", "authorization", "access-control-allow-origin"]) assert.equal(response.headers.get(header), null);
    assert.equal(response.headers.get("cache-control"), "no-store"); assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  } finally { await app.close(); }
});

test("bootstrap status authenticates healthz but exposes only the public gateway contract", async () => {
  const app = await fixture(baseOptions({ fetcher: async (input, init) => {
    assert.equal(String(input), "http://127.0.0.1:5178/healthz"); assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${TOKEN}`);
    return Response.json(HEALTH);
  } }));
  try {
    const response = await app.call("/api/atlas/status"); assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { mode: "same-origin-job-service", apiVersion: 1, configured: true, status: "ready", apiPrefix: "/api/atlas" });
  } finally { await app.close(); }
});

test("unconfigured or malformed private token returns fixed diagnostics without touching the upstream", async () => {
  for (const readTokenFile of [async () => { throw new Error(PRIVATE_PATH); }, async () => "bad-token", async () => TOKEN + "\r\n"]) {
    let calls = 0;
    const app = await fixture(baseOptions({ readTokenFile, fetcher: async () => { calls++; throw new Error("must not fetch"); } }));
    try {
      const response = await app.call("/api/atlas/status"), value = await response.json();
      assert.equal(response.status, 200); assert.equal(value.configured, false); assert.equal(value.status, "unconfigured");
      await errorCode(await app.call(), 503, "needs-auth"); assert.equal(calls, 0);
    } finally { await app.close(); }
  }
});

test("service target must be a literal loopback root and token path must be absolute", async () => {
  for (const target of ["https://remote.example", "http://remote.example:5178", "http://127.0.0.2:5178", "http://127.0.0.1:5178/path", "http://127.0.0.1:5178/?target=evil", "http://127.0.0.1:5178/#fragment", "http://user:password@127.0.0.1:5178", "http://127.0.0.1:65536", "http://127.0.0.1:0"]) {
    const app = await fixture(baseOptions({ env: { BETTERME_JOB_SERVICE_URL: target, BETTERME_JOB_SERVICE_TOKEN_FILE: PRIVATE_PATH }, fetcher: async () => { throw new Error("must not fetch"); } }));
    try { const status = await (await app.call("/api/atlas/status")).json(); assert.equal(status.status, "invalid-config"); await errorCode(await app.call(), 503, "invalid-context"); } finally { await app.close(); }
  }
  const app = await fixture(baseOptions({ env: { BETTERME_JOB_SERVICE_TOKEN_FILE: "relative/service.token" } }));
  try { await errorCode(await app.call(), 503, "invalid-context"); } finally { await app.close(); }
});

test("loopback localhost is pinned to IPv4 and IPv6 loopback remains supported", async () => {
  for (const [configured, target] of [["http://localhost:5179", "http://127.0.0.1:5179/api/v1/sources"], ["http://[::1]:5180/", "http://[::1]:5180/api/v1/sources"]]) {
    const app = await fixture(baseOptions({ env: { BETTERME_JOB_SERVICE_URL: configured, BETTERME_JOB_SERVICE_TOKEN_FILE: PRIVATE_PATH }, fetcher: async input => { assert.equal(String(input), target); return Response.json(ENVELOPE); } }));
    try { assert.equal((await app.call()).status, 200); } finally { await app.close(); }
  }
});

test("gateway denies cross-site, same-site, conflicting Origin and missing same-origin proof for reads and writes", async () => {
  let calls = 0;
  const app = await fixture(baseOptions({ fetcher: async () => { calls++; return Response.json(ENVELOPE); } }));
  try {
    for (const headers of [{ Origin: "https://evil.example" }, { Origin: "null" }, { "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "same-site" },
      { Origin: "https://evil.example", "Sec-Fetch-Site": "same-origin" }, { Origin: app.origin, "Sec-Fetch-Site": "cross-site" }]) {
      await errorCode(await fetch(`${app.origin}/api/atlas/api/v1/sources`, { headers }), 403, "not-authorized");
    }
    await errorCode(await fetch(`${app.origin}/api/atlas/status`), 403, "not-authorized");
    assert.equal(calls, 0);
    assert.equal((await fetch(`${app.origin}/api/atlas/api/v1/sources`, { headers: { "Sec-Fetch-Site": "same-origin" } })).status, 200);
    assert.equal((await app.call("/api/atlas/api/v1/jobs/search", { method: "POST", headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" }, body: "{}" })).status, 200);
    assert.equal(calls, 2);
    const rebound = await new Promise<number>(resolve => {
      const request = httpRequest(`${app.origin}/api/atlas/status`, { headers: { Host: "evil.example", Origin: "http://evil.example" } }, response => { response.resume(); resolve(response.statusCode!); }); request.end();
    });
    assert.equal(rebound, 403);
  } finally { await app.close(); }
});

test("only explicit method and API routes are proxied, with no query, target URL or traversal widening", async () => {
  let calls = 0;
  const app = await fixture(baseOptions({ fetcher: async () => { calls++; return Response.json(ENVELOPE); } }));
  try {
    for (const [route, method] of [["/api/atlas", "GET"], ["/api/atlas/api/v1/sources?url=https://evil.example", "GET"], ["/api/atlas/status?probe=1", "GET"],
      ["/api/atlas/https://evil.example", "GET"], ["/api/atlas/healthz", "GET"], ["/api/atlas/api/v1/private", "GET"],
      ["/api/atlas/api/v1/sources", "DELETE"], ["/api/atlas/api/v1/sources", "OPTIONS"], ["/api/atlas/api/v1/jobs/a%2Fb", "GET"]]) {
      await errorCode(await app.call(route, { method }), 404, "unsupported-capability");
    }
    assert.equal(calls, 0);
    const raw = await new Promise<number>(resolve => {
      const request = httpRequest(app.origin, { path: "/api/atlas/api/v1/jobs/../sources", headers: { Origin: app.origin } }, response => { response.resume(); resolve(response.statusCode!); }); request.end();
    }); assert.equal(raw, 404);
    assert.equal(await (await app.call("/api/atlas-other")).text(), "next");
    for (const [route, method] of [["jobs/job%3Asynthetic", "GET"], ["sources/source%3Asynthetic/preview", "POST"], ["runs/run-synthetic/cancel", "POST"],
      ["jobs/owned-detail-locations/read", "POST"], ["locations/office-address/confirmations", "POST"], ["dataset/export", "GET"]]) {
      const response = await app.call(`/api/atlas/api/v1/${route}`, { method, ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: "{}" } : {}) });
      assert.equal(response.status, 200, route);
    }
    assert.equal(calls, 6);
  } finally { await app.close(); }
});

test("gateway reads the existing private token from the default local data path without returning it", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "betterme-gateway-"));
  const tokenFile = path.join(directory, "BetterMe", "job-atlas", "service.token");
  await mkdir(path.dirname(tokenFile), { recursive: true }); await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const app = await fixture({ env: { LOCALAPPDATA: directory }, platform: "win32", fetcher: async (_input, init) => { assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${TOKEN}`); return Response.json(ENVELOPE); } });
  try { assert.equal((await app.call()).status, 200); await writeFile(tokenFile, "x".repeat(300)); await errorCode(await app.call(), 503, "needs-auth"); } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test("authentication errors and transport exceptions return fixed non-secret diagnostics", async () => {
  for (const status of [401, 403]) {
    const app = await fixture(baseOptions({ fetcher: async () => Response.json({ token: TOKEN, filename: PRIVATE_PATH }, { status }) }));
    try { await errorCode(await app.call(), 502, "needs-auth"); assert.equal((await (await app.call("/api/atlas/status")).json()).status, "unauthorized"); } finally { await app.close(); }
  }
  const app = await fixture(baseOptions({ fetcher: async () => { throw new Error(`${TOKEN} ${PRIVATE_PATH}`); } }));
  try { await errorCode(await app.call(), 503, "internal-error"); assert.equal((await (await app.call("/api/atlas/status")).json()).status, "unavailable"); } finally { await app.close(); }
});

test("request content type, declared and streamed body limits stop before any upstream work", async () => {
  let calls = 0;
  const app = await fixture(baseOptions({ maxRequestBytes: 10, fetcher: async () => { calls++; return Response.json(ENVELOPE); } }));
  try {
    await errorCode(await app.call("/api/atlas/api/v1/jobs/search", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" }), 415, "invalid-input");
    await errorCode(await app.call("/api/atlas/api/v1/jobs/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: "x".repeat(11) }), 413, "budget-exceeded");
    const streamed = await new Promise<number>(resolve => {
      const request = httpRequest(`${app.origin}/api/atlas/api/v1/jobs/search`, { method: "POST", headers: { Origin: app.origin, "Content-Type": "application/json", "Transfer-Encoding": "chunked" } }, response => { response.resume(); resolve(response.statusCode!); });
      request.write("123456"); request.end("78901");
    }); assert.equal(streamed, 413); assert.equal(calls, 0);
  } finally { await app.close(); }
});

test("response limits, malformed JSON and echoed credentials never cross into the browser", async () => {
  for (const response of [() => new Response("plain error", { headers: { "Content-Type": "text/plain" } }),
    () => new Response("{", { headers: { "Content-Type": "application/json" } }), () => Response.json({ token: TOKEN }),
    () => new Response(JSON.stringify({ token: TOKEN }).replaceAll("s", "\\u0073"), { headers: { "Content-Type": "application/json" } })]) {
    const app = await fixture(baseOptions({ fetcher: async () => response() }));
    try { await errorCode(await app.call(), 502, "invalid-output"); } finally { await app.close(); }
  }
  for (const headers of [{}, { "content-length": "1000" }]) {
    const app = await fixture(baseOptions({ maxResponseBytes: 10, fetcher: async () => Response.json(ENVELOPE, { headers }) }));
    try { await errorCode(await app.call(), 502, "budget-exceeded"); } finally { await app.close(); }
  }
});

test("timeout aborts an in-flight upstream request and returns a typed error", async () => {
  let aborted = false;
  const app = await fixture(baseOptions({ timeoutMs: 15, fetcher: async (_input, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => { aborted = true; reject(new Error("synthetic-aborted")); }, { once: true });
  }) }));
  try { await errorCode(await app.call(), 504, "timeout"); assert.equal(aborted, true); } finally { await app.close(); }
});

test("timeout also cancels a stalled response body instead of leaving the gateway pending", async () => {
  let cancelled = false;
  const app = await fixture(baseOptions({ timeoutMs: 15, fetcher: async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("{\"pending\":")); }, cancel() { cancelled = true; },
  }), { headers: { "Content-Type": "application/json" } }) }));
  try { await errorCode(await app.call(), 504, "timeout"); assert.equal(cancelled, true); } finally { await app.close(); }
});

test("real local job HTTP service accepts the server-owned gateway authentication and fixed Origin", async () => {
  const service = createJobHttpServer({ registry: createToolRegistry([]), token: TOKEN, allowedOrigins: ["http://localhost:5173"], port: 0 });
  const target = await service.listen();
  // Use real fetch for this isolated pair of ephemeral listeners, never the user's service or index.
  const real = await fixture({ env: { BETTERME_JOB_SERVICE_URL: target.url, BETTERME_JOB_SERVICE_TOKEN_FILE: PRIVATE_PATH }, readTokenFile: async () => `${TOKEN}\n` });
  try {
    const response = await real.call("/api/atlas/status"); assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "ready");
    const denied = await fetch(`${target.url}/healthz`, { headers: { Origin: real.origin } }); assert.equal(denied.status, 403);
  } finally { await real.close(); await service.close(); }
});

test("browser disconnect cancels only its upstream request", async () => {
  let markStarted!: () => void, markCancelled!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; }), cancelled = new Promise<void>(resolve => { markCancelled = resolve; });
  const app = await fixture(baseOptions({ fetcher: async (_input, init) => new Promise((_resolve, reject) => {
    markStarted(); init!.signal!.addEventListener("abort", () => { markCancelled(); reject(new Error("synthetic-cancelled")); }, { once: true });
  }) }));
  try {
    const request = httpRequest(`${app.origin}/api/atlas/api/v1/sources`, { headers: { Origin: app.origin } }); request.on("error", () => {}); request.end();
    await started; request.destroy(); await cancelled;
  } finally { await app.close(); }
});

test("Vite plugin attaches the same middleware to dev and preview servers", () => {
  const plugin = atlasBackendPlugin(), installed: unknown[] = [];
  const server = { middlewares: { use(value: unknown) { installed.push(value); } } };
  assert.equal(plugin.name, "betterme-atlas-backend");
  (plugin.configureServer as (server: unknown) => void)(server); (plugin.configurePreviewServer as (server: unknown) => void)(server);
  assert.equal(installed.length, 2); assert.ok(installed.every(value => typeof value === "function"));
});

test("Vite loads private host settings from the project env directory and terminal settings take precedence", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "atlas-host-settings-"));
  const keys = ["BETTERME_JOB_SERVICE_URL", "BETTERME_JOB_SERVICE_TOKEN_FILE"] as const;
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const tokenPath = path.join(directory, "service.token");
  await writeFile(tokenPath, `${TOKEN}\n`);
  const calls = [0, 0];
  const backends = [0, 1].map(index => createServer((request, response) => {
    assert.equal(request.url, "/healthz"); assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
    calls[index]!++; response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(HEALTH));
  }));
  const gateways: ReturnType<typeof createServer>[] = [];
  try {
    for (const backend of backends) await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
    const urls = backends.map(backend => `http://127.0.0.1:${(backend.address() as AddressInfo).port}`);
    await writeFile(path.join(directory, ".env.local"), [
      `BETTERME_JOB_SERVICE_URL=${urls[0]}`,
      `BETTERME_JOB_SERVICE_TOKEN_FILE=${tokenPath.replaceAll("\\", "/")}`,
      "VITE_UNRELATED_SETTING=synthetic-public-setting", "UNRELATED_PRIVATE_SETTING=synthetic-private-setting",
    ].join("\n"));
    for (const key of keys) delete process.env[key];
    for (let index = 0; index < 2; index++) {
      if (index === 1) process.env.BETTERME_JOB_SERVICE_URL = urls[1];
      const plugin = atlasBackendPlugin();
      (plugin.configResolved as (config: unknown) => void)({ mode: "development", envDir: directory });
      let middleware: ReturnType<typeof createAtlasBackendMiddleware> | undefined;
      (plugin.configureServer as (server: unknown) => void)({ middlewares: { use(value: typeof middleware) { middleware = value; } } });
      assert.ok(middleware);
      const gateway = createServer((request, response) => { void middleware!(request, response, () => response.end("next")); });
      gateways.push(gateway); await new Promise<void>(resolve => gateway.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
      const response = await fetch(`${origin}/api/atlas/status`, { headers: { Origin: origin } });
      const body = await response.text();
      assert.equal(JSON.parse(body).status, "ready");
      for (const value of [TOKEN, tokenPath, directory, "synthetic-private-setting", "synthetic-public-setting"]) assert.equal(body.includes(value), false);
    }
    assert.deepEqual(calls, [1, 1]);
  } finally {
    for (const server of [...gateways, ...backends]) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
    await rm(directory, { recursive: true, force: true });
  }
});
