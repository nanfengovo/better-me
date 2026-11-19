import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { containerModelBody, createRuntimeGateway } from "../server/runtime-gateway.ts";
import { jdExtractionMiddleware } from "../server/jd-extractor.ts";
import { getNetworkOperation } from "../server/network-proxy.ts";
import { configureDesktopJdBridge } from "../server/jd-desktop-bridge.ts";
import { createNativeLiepinBrowser } from "../server/jd-native-liepin-browser.ts";
import { checkCdpRunning, killRealChromeCdp } from "../server/jd-real-chrome-launcher.ts";
import { readRuntimeConnection } from "../src/lib/runtime-connection.ts";
import { parseDevJobIndexBootstrap } from "../src/components/atlas/dev-index-bootstrap.ts";

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return "http://127.0.0.1:" + (server.address() as AddressInfo).port;
}
const close = (server: Server) => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); });

test("Docker gateway serves real static assets, scoped connections and truthful API boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "better-me-gateway-"));
  await mkdir(join(root, "assets")); await writeFile(join(root, "index.html"), "<html><head></head><body>synthetic app</body></html>");
  await writeFile(join(root, "assets/main-12345678.js"), "export default 1");
  const seen: string[] = [];
  const backend = createServer((req, res) => { seen.push(req.url!); res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: true, authorization: req.headers.authorization, userAgent: req.headers["user-agent"] })); });
  const endpoint = await listen(backend), origins: string[] = [], token = "a".repeat(43);
  let health = true;
  const gateway = createRuntimeGateway({ root, origins, agentEndpoint: endpoint, jobEndpoint: endpoint, agentToken: token, jobToken: "j".repeat(43), health: async () => health });
  const url = await listen(gateway); origins.push(url);
  try {
    const home = await fetch(url); assert.match(await home.text(), /runtime\.js/); assert.match(home.headers.get("cache-control")!, /no-store/);
    assert.match(await (await fetch(url + "/resume/nested")).text(), /synthetic app/);
    const asset = await fetch(url + "/assets/main-12345678.js"); assert.match(asset.headers.get("cache-control")!, /immutable/);
    for (const path of ["/assets/missing.js", "/.env", "/legal/missing", "/%2e%2e%2f.env"]) assert.equal((await fetch(url + path)).status, 404);
    assert.equal((await fetch(url + "/__better-me/runtime.js", { headers: { Origin: "http://evil.invalid" } })).status, 403);
    assert.equal((await fetch(url + "/__better-me/runtime.js", { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
    assert.equal((await fetch(url + "/api/v1/agent/health")).status, 401);
    const reply = await fetch(url + "/api/v1/agent/health", { headers: { Authorization: "Bearer " + token, "User-Agent": "Synthetic MicroMessenger" } });
    const value = await reply.json();
    assert.equal(reply.status, 200); assert.equal(value.authorization, "Bearer " + token);
    assert.equal(value.userAgent, "Synthetic MicroMessenger", "provider context survives the same-origin gateway");
    assert.deepEqual(seen, ["/api/v1/agent/health"]);
    const callback = await fetch(url + "/api/v1/agent/identity/oidc/callback?code=synthetic&state=synthetic", { headers: { "Sec-Fetch-Site": "cross-site", Cookie: "betterme_oidc_browser=synthetic" } });
    assert.equal(callback.status, 200, "only the exact GET OIDC callback reaches its server-side state validator without a transport header");
    for (const path of ["/api/v1/agent/identity/oidc/callback/", "/api/v1/agent/identity/session", "/api/v1/agent/records/continuity"]) {
      assert.equal((await fetch(url + path, { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
    }
    assert.equal((await fetch(url + "/api/v1/jobs/search", { method: "POST", headers: { Authorization: "Bearer " + "j".repeat(43), "Content-Type": "application/json" }, body: "{}" })).status, 403, "writes require an exact browser Origin");
    assert.equal((await fetch(url + "/api/v1/jobs/search", { method: "POST", headers: { Origin: url, Authorization: "Bearer " + "j".repeat(43), "Content-Type": "application/json" }, body: "{}" })).status, 200);
    const bootstrap = await (await fetch(url + "/__better-me/dev/local-job-index")).json(); assert.equal(bootstrap.endpoint, url);
    const runtime = await fetch(url + "/__better-me/runtime.js"); assert.match(runtime.headers.get("cross-origin-resource-policy")!, /same-origin/);
    assert.match(await runtime.text(), /agentToken/);
    assert.equal((await fetch(url + "/api/jd/browser-session")).status, 501);
    assert.equal((await fetch(url + "/healthz")).status, 200);
    health = false; assert.equal((await fetch(url + "/healthz")).status, 503);
  } finally { await close(gateway); await close(backend); await rm(root, { recursive: true, force: true }); }
});

test("only explicitly local Ollama is translated to the configured container host", () => {
  const make = (baseUrl: string) => Buffer.from(JSON.stringify({ modelSettings: { baseUrl, apiKey: "synthetic" } }));
  const mapped = JSON.parse(containerModelBody(make("http://127.0.0.1:11434/v1"), "http://host.docker.internal:11434").toString());
  assert.equal(mapped.modelSettings.baseUrl, "http://host.docker.internal:11434/v1");
  for (const url of ["https://api.example.invalid/v1", "http://localhost:9999/v1", "http://localhost.evil.invalid:11434/v1"]) assert.deepEqual(containerModelBody(make(url), "http://host.docker.internal:11434"), make(url));
});

test("HTTPS deployment uses its configured public origin, never forwarded request headers", async () => {
  const root = await mkdtemp(join(tmpdir(), "betterme-https-gateway-"));
  const publicOrigin = "https://workspace.example.invalid";
  const gateway = createRuntimeGateway({ root, origins: [publicOrigin], agentEndpoint: "http://127.0.0.1:1", jobEndpoint: "http://127.0.0.1:1", agentToken: "a".repeat(43), jobToken: "j".repeat(43), health: async () => true });
  const url = await listen(gateway);
  try {
    const get = (path: string, headers: Record<string, string>) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(url + path, { headers }, res => {
        const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(Buffer.from(chunk)));
        res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
      }); req.on("error", reject); req.end();
    });
    const headers = { Host: "workspace.example.invalid", "X-Forwarded-Host": "attacker.invalid", "X-Forwarded-Proto": "http" };
    const script = await get("/__better-me/runtime.js", headers);
    assert.equal(script.status, 200); assert.ok(script.body.includes('"origin":"' + publicOrigin + '"'));
    const bootstrap = JSON.parse((await get("/__better-me/dev/local-job-index", headers)).body);
    assert.equal(bootstrap.endpoint, publicOrigin);
    assert.equal((await get("/__better-me/runtime.js", { ...headers, Host: "attacker.invalid", "X-Forwarded-Host": "workspace.example.invalid" })).status, 403);
  } finally { await close(gateway); await rm(root, { recursive: true, force: true }); }
});

test("browser accepts an explicitly injected same-origin HTTPS runtime but never remote HTTP or another origin", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const config = { mode: "docker", origin: "https://workspace.example.invalid", agentToken: "a".repeat(43), jobToken: "j".repeat(43) };
  const win = { location: { origin: config.origin }, __BETTER_ME_RUNTIME__: config };
  Object.defineProperty(globalThis, "window", { configurable: true, value: win });
  try {
    assert.deepEqual(readRuntimeConnection(), config);
    assert.equal(parseDevJobIndexBootstrap({ endpoint: config.origin, token: config.jobToken })?.ok, true);
    win.__BETTER_ME_RUNTIME__ = { ...config, origin: "https://other.example.invalid" }; assert.equal(readRuntimeConnection(), undefined);
    win.location.origin = "http://workspace.example.invalid"; win.__BETTER_ME_RUNTIME__ = { ...config, origin: win.location.origin }; assert.equal(readRuntimeConnection(), undefined);
  } finally { if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window"); }
});

test("browser runtime and index autoconnection only accept the exact local gateway", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const config = { mode: "docker", origin: "http://127.0.0.1:8080", agentToken: "a".repeat(43), jobToken: "j".repeat(43) };
  const win = { location: { origin: config.origin }, __BETTER_ME_RUNTIME__: config };
  Object.defineProperty(globalThis, "window", { configurable: true, value: win });
  try {
    assert.deepEqual(readRuntimeConnection(), config);
    assert.equal(parseDevJobIndexBootstrap({ endpoint: config.origin, token: config.jobToken })?.ok, true);
    win.__BETTER_ME_RUNTIME__ = { ...config, origin: "https://evil.invalid" };
    assert.equal(readRuntimeConnection(), undefined);
    assert.equal(parseDevJobIndexBootstrap({ endpoint: config.origin, token: config.jobToken }), undefined);
  } finally { if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window"); }
});

test("desktop injection preserves the gateway origin and token guards", async () => {
  const root = await mkdtemp(join(tmpdir(), "betterme-desktop-gateway-"));
  const origins: string[] = [];
  const gateway = createRuntimeGateway({
    mode: "desktop",
    root,
    origins,
    agentEndpoint: "http://127.0.0.1:1",
    jobEndpoint: "http://127.0.0.1:1",
    agentToken: "a".repeat(43),
    jobToken: "j".repeat(43),
    networkSettingsFile: join(root, "network-settings.json"),
    jdMiddleware: jdExtractionMiddleware,
    health: async () => true,
  });
  const url = await listen(gateway); origins.push(url);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const config = { mode: "desktop", origin: url, agentToken: "a".repeat(43), jobToken: "j".repeat(43) };
  const win = { location: { origin: url }, __BETTER_ME_RUNTIME__: config };
  try {
    assert.match(await (await fetch(url + "/__better-me/runtime.js")).text(), /"mode":"desktop"/);
    assert.equal((await fetch(url + "/api/network/settings")).status, 200, "desktop exposes network proxy settings");
    const settings = { mode: "manual", proxyUrl: "http://127.0.0.1:18901", bypass: "" };
    assert.equal((await fetch(url + "/api/network/settings", { method: "PUT",
      headers: { Origin: url, "Content-Type": "application/json" }, body: JSON.stringify({ settings }),
    })).status, 200);
    assert.equal((await getNetworkOperation()).routeFor(new URL("https://fixture.invalid")).proxyUrl, settings.proxyUrl);
    assert.equal((await fetch(url + "/api/opportunities/source")).status, 405, "desktop exposes ATS opportunity sources instead of 501");
    assert.equal((await fetch(url + "/api/jd/browser-session")).status, 403, "desktop routes /api/jd/* to extraction middleware origin guard instead of 501");
    assert.equal((await fetch(url + "/api/jd/extract", { method: "GET", headers: { Origin: url } })).status, 405, "desktop routes /api/jd/extract to method validation instead of 501");
    Object.defineProperty(globalThis, "window", { configurable: true, value: win });
    assert.deepEqual(readRuntimeConnection(), config);
    for (const invalid of [{ origin: url + "/subpath" }, { origin: "http://localhost:1" }, { agentToken: "short" }, { jobToken: "bad token" }, { mode: "arbitrary" }]) {
      win.__BETTER_ME_RUNTIME__ = { ...config, ...invalid };
      assert.equal(readRuntimeConnection(), undefined);
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window");
    await close(gateway); await rm(root, { recursive: true, force: true });
  }
});

test("desktop Windows-style dedicated profiles resolve below the private runtime directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "betterme-desktop-profile-"));
  try {
    configureDesktopJdBridge(root);
    const inspected: string[] = [];
    for (const platform of ["猎聘", "BOSS直聘", "51JOB"] as const) {
      const browser = createNativeLiepinBrowser({ platform, inspectProfileOccupancy: async profile => {
        inspected.push(profile);
        return "clear";
      } });
      await browser.stop();
    }
    assert.equal(new Set(inspected).size, 3);
    assert.ok(inspected.every(profile => profile.startsWith(join(root, "recruitment-browser"))));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("packaged desktop never attaches to or stops a pre-existing debug listener", async () => {
  const root = await mkdtemp(join(tmpdir(), "betterme-desktop-debug-ownership-"));
  let requests = 0;
  const foreign = createServer((_req, res) => { requests++; res.end("{}"); });
  const port = Number(new URL(await listen(foreign)).port);
  try {
    configureDesktopJdBridge(root);
    assert.equal(await checkCdpRunning(port), false);
    assert.equal(await killRealChromeCdp(port), true);
    assert.equal(foreign.listening, true);
    assert.equal(requests, 0);
  } finally { await close(foreign); await rm(root, { recursive: true, force: true }); }
});

test("desktop routes paired bridge transfers without opening unrelated APIs and awaits final cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "betterme-desktop-bridge-"));
  const origins: string[] = [];
  const cleanupStarted = Promise.withResolvers<void>();
  const cleanupFinished = Promise.withResolvers<void>();
  const gateway = createRuntimeGateway({
    mode: "desktop", root, origins, agentEndpoint: "http://127.0.0.1:1", jobEndpoint: "http://127.0.0.1:1",
    agentToken: "fixture-agent", jobToken: "fixture-jobs", networkSettingsFile: join(root, "network-settings.json"),
    jdMiddleware: jdExtractionMiddleware, health: async () => true,
    onClose: async () => { cleanupStarted.resolve(); await cleanupFinished.promise; },
  });
  const url = await listen(gateway); origins.push(url);
  const sender = "chrome-extension://syntheticfixture";
  const submit = (route: string, origin: string, body: unknown, headers = {}) => fetch(url + "/api/jd/" + route, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  let closing: Promise<void> | undefined;
  try {
    const grant = await submit("bridge-grant", url, { purpose: "job", origin: sender }, { "X-BetterMe-Bridge": "1" });
    assert.equal(grant.status, 200);
    const { token } = await grant.json();
    const preflight = (origin: string) => fetch(url + "/api/jd/sync-extension", {
      method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type", "Sec-Fetch-Site": "cross-site" },
    });
    const permitted = await preflight(sender);
    assert.equal(permitted.status, 204);
    assert.equal(permitted.headers.get("access-control-allow-origin"), sender);
    assert.equal((await preflight("https://other.invalid")).status, 403);
    const job = { title: "Fixture role", company: "Fixture employer", description: "Synthetic job description for bridge verification." };
    const headers = { Authorization: "Bearer " + token, "Sec-Fetch-Site": "cross-site" };
    assert.equal((await submit("sync-extension", sender, job, headers)).status, 200);
    assert.equal((await submit("sync-extension", sender, job, headers)).status, 403);
    assert.equal((await submit("extract", sender, {}, headers)).status, 403);
    assert.equal((await fetch(url + "/api/jd/sync-extension", { headers: { Origin: sender } })).status, 403);

    let closed = false;
    closing = close(gateway).then(() => { closed = true; });
    await cleanupStarted.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(closed, false, "close callback waits for the browser cleanup");
  } finally {
    cleanupFinished.resolve();
    await (closing ?? close(gateway));
    await rm(root, { recursive: true, force: true });
  }
});
