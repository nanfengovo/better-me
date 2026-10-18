import assert from "node:assert/strict";
import test from "node:test";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { bypassesProxy, createNetworkMiddleware, createNetworkRuntime, resolveNetworkRoute } from "../server/network-proxy.ts";
import { DEFAULT_NETWORK_SETTINGS, normalizeProxyUrl, validateNetworkSettings } from "../src/lib/network-settings.ts";

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
async function temporaryRuntime(extra: Omit<Parameters<typeof createNetworkRuntime>[0], "settingsFile"> = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "betterme-network-"));
  const settingsFile = path.join(directory, "network-settings.json");
  const runtime = createNetworkRuntime({ settingsFile, readEnv: () => ({}), readSystemProxy: async () => ({ enabled: false }), ...extra });
  return { runtime, settingsFile, cleanup: async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); } };
}
function proxyFixture() {
  const connects: string[] = [];
  const server = createServer((_request, response) => { response.writeHead(400); response.end("CONNECT required"); });
  server.on("connect", (request, socket, head) => {
    connects.push(request.url ?? "");
    socket.on("error", () => undefined);
    socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
    const reply = () => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\nproxy-proof");
    if (head.length) reply(); else socket.once("data", reply);
  });
  return { server, connects };
}

test("代理设置只接受无认证 HTTP/HTTPS 主机端口，不允许路径、查询、SOCKS/PAC", () => {
  assert.equal(normalizeProxyUrl(" HTTP://127.0.0.1:7890/ "), "http://127.0.0.1:7890");
  assert.equal(normalizeProxyUrl("https://[::1]:7890"), "https://[::1]:7890");
  for (const url of ["socks5://127.0.0.1:1080", "file:///proxy.pac", "http://user:secret@127.0.0.1:7890", "http://127.0.0.1:7890/path", "http://127.0.0.1:7890?password=secret", "http://127.0.0.1:7890#x", "http://127.0.0.1:7890?", "http://127.0.0.1:7890#", "127.0.0.1:7890"]) {
    assert.throws(() => validateNetworkSettings({ mode: "manual", proxyUrl: url, bypass: "" }));
  }
  assert.throws(() => validateNetworkSettings({ mode: "manual", proxyUrl: "", bypass: "" }));
  assert.equal(validateNetworkSettings({ mode: "direct", proxyUrl: "socks5://user:secret@localhost", bypass: "" }).proxyUrl, "");
  assert.throws(() => validateNetworkSettings({ ...DEFAULT_NETWORK_SETTINGS, bypass: "https://example.com/private" }));
  assert.deepEqual(validateNetworkSettings({ ...DEFAULT_NETWORK_SETTINGS, bypass: "localhost; 127.0.0.1,::1" }), DEFAULT_NETWORK_SETTINGS);
});

test("NO_PROXY 支持域名边界、前导点、端口、IPv6、大小写和本机短域名", () => {
  for (const [url, rules, expected] of [
    ["https://api.Example.com", ".example.com", true], ["https://example.com", "*.example.com", true],
    ["https://notexample.com", "example.com", false], ["https://example.com.evil.test", "example.com", false],
    ["https://example.com", "example.com:443", true], ["http://example.com", "example.com:443", false],
    ["http://[::1]:5173", "::1", true], ["http://[::1]:5173", "[::1]:5173", true],
    ["http://[::1]:5173", "[::1]:9000", false], ["http://printer", "<local>", true],
    ["http://printer.example", "<local>", false], ["https://anything.invalid", "*", true],
  ] as const) assert.equal(bypassesProxy(new URL(url), rules), expected, `${url} / ${rules}`);
});

test("真实 HTTP CONNECT 请求经代理访问不可解析目标，直连和绕过规则分别走目标服务", async () => {
  const proxy = proxyFixture();
  const proxyUrl = await listen(proxy.server);
  let targetHits = 0;
  const target = createServer((_request, response) => { targetHits += 1; response.end("direct-proof"); });
  const targetUrl = await listen(target);
  const { runtime, cleanup } = await temporaryRuntime();
  try {
    const proxied = await runtime.getFetch({ mode: "manual", proxyUrl, bypass: "" });
    assert.equal(await (await proxied("http://route-proof.invalid/resource")).text(), "proxy-proof");
    assert.deepEqual(proxy.connects, ["route-proof.invalid:80"]);
    const direct = await runtime.getFetch({ mode: "direct", proxyUrl, bypass: "" });
    assert.equal(await (await direct(targetUrl)).text(), "direct-proof");
    const bypassed = await runtime.getFetch({ mode: "manual", proxyUrl, bypass: "127.0.0.1" });
    assert.equal(await (await bypassed(targetUrl)).text(), "direct-proof");
    assert.equal(targetHits, 2);
    assert.equal(proxy.connects.length, 1);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(proxied("http://route-proof.invalid", { signal: controller.signal }), (error: unknown) => (error as Error).name === "AbortError");
    assert.equal(proxy.connects.length, 1);
  } finally { await cleanup(); await close(proxy.server); await close(target); }
});

test("代理端口失效时明确失败，目标可直连也绝不静默回退", async () => {
  const temporary = createServer(); const proxyUrl = await listen(temporary); await close(temporary);
  let targetHits = 0;
  const target = createServer((_request, response) => { targetHits += 1; response.end("should not connect"); });
  const targetUrl = await listen(target);
  const { runtime, cleanup } = await temporaryRuntime();
  try {
    const request = await runtime.getFetch({ mode: "manual", proxyUrl, bypass: "" });
    await assert.rejects(request(targetUrl), /代理.*失败.*没有回退/);
    assert.equal(targetHits, 0);
  } finally { await cleanup(); await close(target); }
});

test("调用者取消响应正文时底层连接也停止，不等待完整页面", async () => {
  let closed!: () => void;
  const cancelled = new Promise<void>((resolve) => { closed = resolve; });
  const target = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.write("partial page");
    response.once("close", closed);
  });
  const targetUrl = await listen(target);
  const { runtime, cleanup } = await temporaryRuntime();
  try {
    const request = await runtime.getFetch({ mode: "direct", proxyUrl: "", bypass: "" });
    const response = await request(targetUrl);
    await response.body?.cancel();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([cancelled, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("正文取消未传递到底层连接")), 2_000); })]); }
    finally { clearTimeout(timer); }
  } finally { await cleanup(); await close(target); }
});

test("自动模式按请求协议选择环境或系统代理，遵守绕过且不将 SOCKS 当 HTTP", () => {
  const settings = { ...DEFAULT_NETWORK_SETTINGS, bypass: "" };
  const context = { env: { HTTPS_PROXY: "http://127.0.0.1:7890", HTTP_PROXY: "http://127.0.0.1:7897", NO_PROXY: ".example.com" }, system: { enabled: true, server: "127.0.0.1:8080", override: "ignored.test" }, warnings: [] };
  assert.equal(resolveNetworkRoute(settings, new URL("https://linkedin.com"), context).proxyUrl, "http://127.0.0.1:7890");
  assert.equal(resolveNetworkRoute(settings, new URL("http://linkedin.com"), context).proxyUrl, "http://127.0.0.1:7897");
  assert.equal(resolveNetworkRoute(settings, new URL("https://api.example.com"), context).proxyUrl, undefined);
  assert.equal(resolveNetworkRoute(settings, new URL("https://ignored.test"), context).proxyUrl, "http://127.0.0.1:7890");
  const system = { env: {}, system: { enabled: true, server: "http=127.0.0.1:7897;https=127.0.0.1:7890", override: "*.example.com" }, warnings: [] };
  assert.equal(resolveNetworkRoute(settings, new URL("http://linkedin.com"), system).proxyUrl, "http://127.0.0.1:7897");
  assert.equal(resolveNetworkRoute(settings, new URL("https://linkedin.com"), system).proxyUrl, "http://127.0.0.1:7890");
  assert.equal(resolveNetworkRoute(settings, new URL("https://api.example.com"), system).proxyUrl, undefined);
  assert.throws(() => resolveNetworkRoute(settings, new URL("https://linkedin.com"), { env: {}, system: { enabled: true, server: "socks=127.0.0.1:1080" }, warnings: [] }), /SOCKS/);
  assert.throws(() => resolveNetworkRoute(settings, new URL("https://linkedin.com"), { ...context, env: { HTTPS_PROXY: "socks5://127.0.0.1:1080" } }), /SOCKS/);
  assert.throws(() => resolveNetworkRoute(settings, new URL("https://linkedin.com"), { env: {}, system: { enabled: false, pac: true }, warnings: [] }), /PAC/);
});

test("自动检测通过注入读取系统与环境，不把常见端口监听自动当成代理", async () => {
  let systemReads = 0;
  const { runtime, cleanup } = await temporaryRuntime({
    readEnv: () => ({ HTTPS_PROXY: "http://user:secret@127.0.0.1:9999" }),
    readSystemProxy: async () => { systemReads += 1; return { enabled: false, pac: true }; },
    probe: async (url) => url === "http://127.0.0.1:7890",
  });
  try {
    const result = await runtime.detect();
    assert.equal(systemReads, 1);
    assert.deepEqual(result.candidates, [{ url: "http://127.0.0.1:7890", reachable: true, source: "常见本机端口（仅检测监听，需手动选择并测试）" }]);
    assert.equal(result.autoRoute.proxyUrl, undefined);
    assert.match(result.warnings.join(" "), /PAC/);
    assert.ok(!JSON.stringify(result).includes("secret"));
    assert.match(result.autoRoute.source, /格式不受支持/);
  } finally { await cleanup(); }
});

test("同次采集快照只读取一次代理，后续操作才应用变化", async () => {
  const proxy = proxyFixture(); const proxyUrl = await listen(proxy.server);
  let env = { HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl };
  let reads = 0;
  const { runtime, cleanup } = await temporaryRuntime({ readEnv: () => { reads += 1; return env; } });
  try {
    const request = await runtime.getFetch();
    env = { HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1" };
    assert.equal(await (await request("http://one.invalid")).text(), "proxy-proof");
    assert.equal(await (await request("http://two.invalid")).text(), "proxy-proof");
    assert.equal(reads, 1);
    assert.equal(proxy.connects.length, 2);
    await runtime.getFetch();
    assert.equal(reads, 2);
  } finally { await cleanup(); await close(proxy.server); }
});

test("网络operation的routeFor与fetch共享固定配置和环境，保存新模式仅影响下次操作", async () => {
  const proxy = proxyFixture(); const proxyUrl = await listen(proxy.server);
  const env: Record<string, string> = { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl };
  let reads = 0;
  const { runtime, cleanup } = await temporaryRuntime({ readEnv: () => { reads += 1; return env; } });
  try {
    await runtime.saveSettings({ mode: "auto", proxyUrl: "", bypass: "" });
    const operation = await runtime.getOperation();
    const target = new URL("http://fixed-operation.invalid/resource");
    const originalRoute = operation.routeFor(target);
    assert.equal(originalRoute.proxyUrl, proxyUrl);
    env.HTTP_PROXY = "http://127.0.0.1:1";
    env.HTTPS_PROXY = "http://127.0.0.1:1";
    await runtime.saveSettings({ mode: "direct", proxyUrl: "", bypass: "" });
    originalRoute.proxyUrl = "http://127.0.0.1:2";
    assert.equal(operation.routeFor(target).proxyUrl, proxyUrl);
    assert.equal(await (await operation.fetch(target)).text(), "proxy-proof");
    assert.deepEqual(proxy.connects, ["fixed-operation.invalid:80"]);
    assert.equal(reads, 1);
    const next = await runtime.getOperation();
    assert.equal(next.routeFor(target).mode, "direct");
    assert.equal(next.routeFor(target).proxyUrl, undefined);
    assert.throws(() => operation.routeFor(new URL("file:///private")), /HTTP/);
  } finally { await cleanup(); await close(proxy.server); }
});

test("operation复制系统代理对象及手动设置草稿，调用方后续修改不会改变原操作", async () => {
  const proxy = proxyFixture(); const proxyUrl = await listen(proxy.server);
  const system = { enabled: true, server: proxyUrl, override: "" };
  const { runtime, cleanup } = await temporaryRuntime({ readSystemProxy: async () => system });
  try {
    const operation = await runtime.getOperation({ mode: "auto", proxyUrl: "", bypass: "" });
    system.server = "http://127.0.0.1:1";
    system.override = "*";
    const target = new URL("http://fixed-system.invalid");
    assert.equal(operation.routeFor(target).proxyUrl, proxyUrl);
    assert.equal(await (await operation.fetch(target)).text(), "proxy-proof");
    const next = await runtime.getOperation({ mode: "auto", proxyUrl: "", bypass: "" });
    assert.equal(next.routeFor(target).proxyUrl, undefined);
    const draft = { mode: "manual" as const, proxyUrl, bypass: "" };
    const manual = await runtime.getOperation(draft);
    draft.proxyUrl = "http://127.0.0.1:1";
    draft.bypass = "*";
    assert.equal(manual.routeFor(target).proxyUrl, proxyUrl);
    assert.equal(await (await manual.fetch(target)).text(), "proxy-proof");
  } finally { await cleanup(); await close(proxy.server); }
});

test("配置持久化只保留白名单字段，拒绝认证信息，损坏文件不被静默替换", async () => {
  const { runtime, settingsFile, cleanup } = await temporaryRuntime();
  try {
    assert.deepEqual(await runtime.readSettings(), DEFAULT_NETWORK_SETTINGS);
    const settings = { mode: "manual" as const, proxyUrl: "http://127.0.0.1:7890", bypass: "localhost" };
    await runtime.saveSettings({ ...settings, password: "not-persisted" });
    assert.deepEqual(await runtime.readSettings(), settings);
    assert.ok(!(await readFile(settingsFile, "utf8")).includes("not-persisted"));
    await assert.rejects(runtime.saveSettings({ ...settings, proxyUrl: "http://u:secret@127.0.0.1:7890" }), /用户名或密码/);
    assert.deepEqual(await runtime.readSettings(), settings);
    await writeFile(settingsFile, "{broken");
    await assert.rejects(runtime.readSettings(), /无法读取/);
    assert.equal(await readFile(settingsFile, "utf8"), "{broken");
  } finally { await cleanup(); }
});

test("BOSS与猎聘连接测试只请求固定公开首页，任意URL与继承属性不能成为目标", async (context) => {
  const calls: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
  let cancelledBodies = 0;
  context.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), redirect: init?.redirect });
    assert.ok(init?.signal instanceof AbortSignal);
    return new Response(new ReadableStream({ cancel() { cancelledBodies += 1; } }), { status: 200 });
  });
  const { runtime, cleanup } = await temporaryRuntime();
  const settings = { mode: "direct" as const, proxyUrl: "", bypass: "" };
  try {
    for (const target of ["boss", "liepin"]) {
      const result = await runtime.testConnection(settings, target);
      assert.equal(result.ok, true);
      assert.equal(result.status, 200);
    }
    assert.deepEqual(calls, [
      { url: "https://www.zhipin.com/", redirect: "manual" },
      { url: "https://www.liepin.com/", redirect: "manual" },
    ]);
    assert.equal(cancelledBodies, 2);
    for (const target of ["https://arbitrary.invalid/", "boss?url=https://arbitrary.invalid/", "constructor", "__proto__", null, {}]) {
      await assert.rejects(runtime.testConnection(settings, target), /支持的连接测试目标/);
    }
    assert.equal(calls.length, 2);
  } finally { await cleanup(); }
});

test("设置接口只接受本机同源请求，禁止恶意 Host、跨站写入与超大正文", async () => {
  const { runtime, cleanup } = await temporaryRuntime();
  const middleware = createNetworkMiddleware(runtime);
  const server = createServer((request, response) => { void middleware(request, response, () => { response.writeHead(404); response.end(); }); });
  const origin = await listen(server);
  try {
    const get = await fetch(`${origin}/api/network/settings`);
    assert.deepEqual(await get.json(), { settings: DEFAULT_NETWORK_SETTINGS });
    assert.equal(get.headers.get("access-control-allow-origin"), null);
    const hostileHostStatus = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${origin}/api/network/settings`, { headers: { Host: "evil.test" } }, (response) => { response.resume(); resolve(response.statusCode!); });
      request.on("error", reject); request.end();
    });
    assert.equal(hostileHostStatus, 403);
    assert.equal((await fetch(`${origin}/api/network/settings`, { headers: { Origin: "https://evil.test" } })).status, 403);
    const body = JSON.stringify({ settings: { mode: "direct", proxyUrl: "", bypass: "localhost" } });
    const init = { method: "PUT", headers: { "Content-Type": "application/json", Origin: origin }, body };
    assert.equal((await fetch(`${origin}/api/network/settings`, { ...init, headers: { "Content-Type": "application/json" } })).status, 403);
    assert.equal((await fetch(`${origin}/api/network/settings`, { ...init, headers: { ...init.headers, Origin: `${origin}.evil.test` } })).status, 403);
    assert.equal((await fetch(`${origin}/api/network/settings`, init)).status, 200);
    assert.equal((await runtime.readSettings()).mode, "direct");
    assert.equal((await fetch(`${origin}/api/network/settings`, { ...init, body: " ".repeat(9000) })).status, 400);
    const testResponse = await fetch(`${origin}/api/network/test`, { ...init, method: "POST", body: JSON.stringify({ settings: DEFAULT_NETWORK_SETTINGS, target: "https://arbitrary.invalid" }) });
    assert.equal(testResponse.status, 400);
  } finally { await close(server); await cleanup(); }
});
