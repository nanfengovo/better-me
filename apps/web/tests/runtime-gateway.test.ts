import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { containerModelBody, createRuntimeGateway } from "../server/runtime-gateway.ts";
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
  const backend = createServer((req, res) => { seen.push(req.url!); res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: true, authorization: req.headers.authorization })); });
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
    const reply = await fetch(url + "/api/v1/agent/health", { headers: { Authorization: "Bearer " + token } });
    assert.equal(reply.status, 200); assert.equal((await reply.json()).authorization, "Bearer " + token);
    assert.deepEqual(seen, ["/api/v1/agent/health"]);
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
