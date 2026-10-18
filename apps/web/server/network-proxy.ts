import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, mkdir, rename, stat, writeFile, unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { Agent, ProxyAgent, type Dispatcher } from "undici";
import type { Plugin } from "vite";
import {
  DEFAULT_NETWORK_SETTINGS, normalizeProxyUrl, validateNetworkSettings,
  type NetworkDetectionResult, type NetworkRoute, type NetworkSettings, type NetworkTestResult, type NetworkTestTarget,
} from "../src/lib/network-settings";

export type SystemProxy = { enabled: boolean; server?: string; override?: string; pac?: boolean };
export type NetworkOperation = { fetch: typeof fetch; routeFor: (url: URL) => NetworkRoute };
type Environment = Record<string, string | undefined>;
type ProxyEnvironment = { env: Environment; system: SystemProxy; warnings: string[] };
type RuntimeOptions = {
  settingsFile: string;
  readEnv?: () => Environment;
  readSystemProxy?: () => Promise<SystemProxy>;
  probe?: (url: string) => Promise<boolean>;
};
const COMMON_PORTS = [7890, 7897, 10809, 8080];
const TEST_URLS: Record<NetworkTestTarget, string> = {
  "51job": "https://msearch.51job.com/",
  boss: "https://www.zhipin.com/",
  liepin: "https://www.liepin.com/",
  linkedin: "https://www.linkedin.com/jobs/",
  greenhouse: "https://boards-api.greenhouse.io/v1/boards/duolingo/jobs?content=false",
  lever: "https://api.lever.co/v0/postings/spotify?mode=json&limit=1",
  tencent: "https://careers.tencent.com/tencentcareer/api/post/Query?pageIndex=1&pageSize=1",
};

/** Reads only current-user Internet Settings; never invokes a shell or changes the OS proxy. */
export async function readWindowsProxy(): Promise<SystemProxy> {
  if (process.platform !== "win32") return { enabled: false };
  const run = promisify(execFile);
  const { stdout } = await run("reg.exe", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"], {
    timeout: 2_000, maxBuffer: 128 * 1024, windowsHide: true,
  });
  const value = (name: string) => stdout.match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*)$`, "mi"))?.[1]?.trim();
  return { enabled: value("ProxyEnable") === "0x1", server: value("ProxyServer"), override: value("ProxyOverride"), pac: !!value("AutoConfigURL") || value("AutoDetect") === "0x1" };
}

export function probeProxyPort(address: string): Promise<boolean> {
  const proxy = new URL(address);
  return new Promise((resolve) => {
    const socket = net.connect({ host: proxy.hostname.replace(/^\[|\]$/g, ""), port: Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80)) });
    const finish = (reachable: boolean) => { socket.destroy(); resolve(reachable); };
    socket.setTimeout(350, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** NO_PROXY domains match the domain and subdomains; optional ports and <local> are supported. */
export function bypassesProxy(target: URL, rules: string): boolean {
  const hostname = target.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const port = target.port || (target.protocol === "https:" ? "443" : "80");
  return rules.split(/[,;]/).some((raw) => {
    let rule = raw.trim().toLowerCase();
    if (!rule) return false;
    if (rule === "*") return true;
    if (rule === "<local>") return !hostname.includes(".") && !hostname.includes(":");
    const withPort = rule.match(/^(\[[\da-f:]+\]|[^:]+):(\d+)$/i);
    if (withPort) { if (withPort[2] !== port) return false; rule = withPort[1]!; }
    rule = rule.replace(/^\[|\]$/g, "").replace(/^\*?\./, "");
    return hostname === rule || (!hostname.includes(":") && hostname.endsWith(`.${rule}`));
  });
}

function systemProxyFor(system: SystemProxy, protocol: string): string | undefined {
  if (!system.enabled || !system.server) return undefined;
  const parts = system.server.split(";");
  const keyed = parts.some((item) => item.includes("="));
  const value = keyed ? parts.find((item) => item.trim().toLowerCase().startsWith(`${protocol.replace(":", "")}=`))?.split("=").slice(1).join("=") : system.server;
  if (!value?.trim()) return undefined;
  // Windows ProxyServer entries normally omit the transport scheme, even for HTTPS destinations.
  return value.includes("://") ? value.trim() : `http://${value.trim()}`;
}

function automaticProxy(snapshot: ProxyEnvironment, protocol: string): { value?: string; source: string } {
  const { env, system } = snapshot;
  const candidates = protocol === "https:"
    ? [[env.HTTPS_PROXY ?? env.https_proxy, "HTTPS_PROXY"], [env.HTTP_PROXY ?? env.http_proxy, "HTTP_PROXY"], [env.ALL_PROXY ?? env.all_proxy, "ALL_PROXY"]]
    : [[env.HTTP_PROXY ?? env.http_proxy, "HTTP_PROXY"], [env.ALL_PROXY ?? env.all_proxy, "ALL_PROXY"]];
  for (const [value, source] of candidates) if (value?.trim()) return { value, source: `环境变量 ${source}` };
  const value = systemProxyFor(system, protocol);
  if (value) return { value, source: "Windows 系统代理" };
  if (system.enabled && system.server && /(?:^|;)socks=/i.test(system.server)) throw new Error("系统只配置了 SOCKS 代理；当前请在软件中选择 HTTP / HTTPS 代理端口。");
  if (system.pac) throw new Error("系统启用了 PAC / 自动配置；当前服务无法执行 PAC，请在网络设置中手动指定 HTTP / HTTPS 代理端口，或明确选择直接连接。");
  return { source: "未发现已启用的代理，直接连接" };
}

export function resolveNetworkRoute(settings: NetworkSettings, target: URL, snapshot: ProxyEnvironment): NetworkRoute {
  const hostname = target.hostname.toLowerCase();
  const domesticJob = ["51job.com", "zhipin.com", "liepin.com"].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  if (settings.domesticProxyUrl?.trim() && domesticJob) return { mode: "manual", source: "国内招聘平台独立代理", proxyUrl: normalizeProxyUrl(settings.domesticProxyUrl) };
  if (settings.mode === "direct") return { mode: "direct", source: "直接连接" };
  const sharedBypass = [settings.bypass, settings.mode === "auto" ? snapshot.env.NO_PROXY ?? snapshot.env.no_proxy : undefined].filter(Boolean).join(",");
  if (bypassesProxy(target, sharedBypass)) return { mode: settings.mode, source: "命中绕过代理规则，直接连接" };
  const automatic = settings.mode === "auto" ? automaticProxy(snapshot, target.protocol) : undefined;
  if (automatic?.source === "Windows 系统代理" && bypassesProxy(target, snapshot.system.override ?? "")) return { mode: settings.mode, source: "命中系统绕过代理规则，直接连接" };
  if (settings.mode === "manual") return { mode: "manual", source: "手动代理", proxyUrl: normalizeProxyUrl(settings.proxyUrl) };
  return { mode: "auto", source: automatic!.source, ...(automatic!.value ? { proxyUrl: normalizeProxyUrl(automatic!.value) } : {}) };
}

function transportReason(error: unknown): string {
  let code: string | undefined;
  let current = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth += 1) {
    const detail = current as { code?: unknown; cause?: unknown };
    if (typeof detail.code === "string") { code = detail.code; break; }
    current = detail.cause;
  }
  if (code === "ECONNREFUSED") return "端口拒绝连接，请确认代理已启动且端口正确";
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") return "连接被对端重置，请检查代理规则及目标网站限制";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "域名解析失败，请检查网络与代理";
  if (code && /CERT|TLS|SSL|SELF_SIGNED/.test(code)) return "TLS 连接或证书校验失败，请检查代理和系统证书";
  if (code && /TIMEOUT|TIMEDOUT/.test(code)) return "建立连接超时，请检查网络、代理端口与规则";
  return "无法建立连接，请检查网络、代理规则与目标网站限制";
}

export function createNetworkRuntime(options: RuntimeOptions) {
  const dispatchers = new Map<string, Dispatcher>();
  let saves = Promise.resolve();
  async function snapshot(): Promise<ProxyEnvironment> {
    const warnings: string[] = [];
    let system: SystemProxy = { enabled: false };
    try { system = { ...await (options.readSystemProxy ?? readWindowsProxy)() }; }
    catch { warnings.push("无法读取本机系统代理，仍可使用环境变量或手动配置。"); }
    if (system.pac) warnings.push("检测到 PAC / 自动配置：当前服务不执行 PAC 脚本，请填写本机 HTTP / HTTPS 代理端口，或使用系统 TUN 网络。");
    return { env: { ...(options.readEnv ?? (() => process.env))() }, system, warnings };
  }
  async function readSettings(): Promise<NetworkSettings> {
    try {
      if ((await stat(options.settingsFile)).size > 8192) throw new Error("oversize");
      return validateNetworkSettings(JSON.parse(await readFile(options.settingsFile, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_NETWORK_SETTINGS };
      throw new Error("本机网络配置文件无法读取，请在网络设置中重新保存配置。", { cause: error });
    }
  }
  async function saveSettings(input: unknown): Promise<NetworkSettings> {
    const settings = validateNetworkSettings(input);
    const operation = saves.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(options.settingsFile), { recursive: true });
      const temporary = `${options.settingsFile}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 }); await rename(temporary, options.settingsFile); }
      finally { await unlink(temporary).catch(() => undefined); }
    });
    saves = operation;
    await operation;
    return settings;
  }
  function dispatcher(proxyUrl?: string): Dispatcher {
    const key = proxyUrl ?? "direct";
    const existing = dispatchers.get(key);
    if (existing) return existing;
    const instance = proxyUrl
      ? new ProxyAgent({ uri: proxyUrl, connections: 8, connectTimeout: 10_000, headersTimeout: 15_000, bodyTimeout: 15_000 })
      : new Agent({ connections: 8, connect: { timeout: 10_000 }, headersTimeout: 15_000, bodyTimeout: 15_000 });
    if (dispatchers.size >= 8) {
      const first = dispatchers.entries().next().value;
      if (first) { dispatchers.delete(first[0]); void first[1].close().catch(() => undefined); }
    }
    dispatchers.set(key, instance);
    return instance;
  }
  async function prepare(settingsOverride?: NetworkSettings) {
    const settings = settingsOverride ? validateNetworkSettings(settingsOverride) : await readSettings();
    const context = settings.mode === "auto" ? await snapshot() : { env: {}, system: { enabled: false }, warnings: [] };
    return { settings, context };
  }
  function fetchFor(settings: NetworkSettings, context: ProxyEnvironment): typeof fetch {
    return async (input, init) => {
      const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (!["http:", "https:"].includes(target.protocol)) return Promise.reject(new Error("网络请求仅支持 HTTP / HTTPS。"));
      const route = resolveNetworkRoute(settings, target, context);
      const requestInit: RequestInit & { dispatcher: Dispatcher } = { ...init, dispatcher: dispatcher(route.proxyUrl) };
      try { return await fetch(input, requestInit); }
      catch (error) {
        if (init?.signal?.aborted || (input instanceof Request && input.signal.aborted)) throw error;
        throw new Error(`${route.proxyUrl ? `通过代理 ${route.proxyUrl}` : "直接连接"}失败：${transportReason(error)}。${route.proxyUrl ? "本次没有回退到直接连接。" : "可在网络设置中检测或配置本机代理。"}`, { cause: error });
      }
    };
  }
  async function getOperation(settingsOverride?: NetworkSettings): Promise<NetworkOperation> {
    const { settings, context } = await prepare(settingsOverride);
    return {
      fetch: fetchFor(settings, context),
      routeFor: (url: URL) => {
        if (!["http:", "https:"].includes(url.protocol)) throw new Error("网络请求仅支持 HTTP / HTTPS。");
        return resolveNetworkRoute(settings, url, context);
      },
    };
  }
  async function getFetch(settingsOverride?: NetworkSettings): Promise<typeof fetch> {
    return (await getOperation(settingsOverride)).fetch;
  }
  async function detect(): Promise<NetworkDetectionResult> {
    const context = await snapshot();
    const candidates: NetworkDetectionResult["candidates"] = [];
    const pending = new Map<string, string>();
    for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"]) {
      const value = context.env[key];
      if (!value?.trim()) continue;
      try { const url = normalizeProxyUrl(value); if (!pending.has(url)) pending.set(url, `环境变量 ${key}`); }
      catch { context.warnings.push(`环境变量 ${key} 的代理格式不受支持，请改用无认证的 HTTP / HTTPS 代理。`); }
    }
    for (const protocol of ["https:", "http:"]) {
      const value = systemProxyFor(context.system, protocol);
      if (!value) continue;
      try { const url = normalizeProxyUrl(value); if (!pending.has(url)) pending.set(url, "Windows 系统代理"); }
      catch { context.warnings.push("系统代理格式不受支持，请手动指定 HTTP / HTTPS 代理。"); }
    }
    for (const port of COMMON_PORTS) { const url = `http://127.0.0.1:${port}`; if (!pending.has(url)) pending.set(url, "常见本机端口（仅检测监听，需手动选择并测试）"); }
    const probe = options.probe ?? probeProxyPort;
    await Promise.all([...pending].map(async ([url, source]) => {
      const reachable = await probe(url).catch(() => false);
      if (reachable || !source.startsWith("常见")) candidates.push({ url, source, reachable });
    }));
    candidates.sort((a, b) => a.url.localeCompare(b.url));
    let autoRoute: NetworkRoute;
    try { autoRoute = resolveNetworkRoute(DEFAULT_NETWORK_SETTINGS, new URL(TEST_URLS["51job"]), context); }
    catch { autoRoute = { mode: "auto", source: "已发现代理配置，但格式不受支持；请改用手动代理" }; }
    return { candidates, warnings: [...new Set(context.warnings)], autoRoute };
  }
  async function testConnection(input: unknown, target: unknown): Promise<NetworkTestResult> {
    if (typeof target !== "string" || !Object.hasOwn(TEST_URLS, target)) throw new Error("请选择支持的连接测试目标。");
    const { settings, context } = await prepare(validateNetworkSettings(input));
    const url = TEST_URLS[target as NetworkTestTarget];
    const route = resolveNetworkRoute(settings, new URL(url), context);
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 16_000);
    try {
      const response = await fetchFor(settings, context)(url, { redirect: "manual", signal: controller.signal, headers: { "User-Agent": "BetterMe/0.1 (user-requested connectivity test)", Accept: "text/html,application/json" } });
      await response.body?.cancel();
      return { ok: response.status >= 200 && response.status < 400, status: response.status, route, elapsedMs: Date.now() - start,
        message: response.status >= 200 && response.status < 400 ? "已收到目标网站响应。网络连通不代表岗位正文一定可提取。" : `已连接目标网站，但返回 HTTP ${response.status}；可能存在登录、验证或访问限制。` };
    } catch (error) {
      const reason = controller.signal.aborted ? "连接测试超过 16 秒。" : `${transportReason(error)}。`;
      return { ok: false, route, elapsedMs: Date.now() - start, message: `${reason}${route.proxyUrl ? "本次没有回退到直接连接。" : ""}` };
    } finally { clearTimeout(timer); }
  }
  return { readSettings, saveSettings, detect, getFetch, getOperation, testConnection, close: async () => { await Promise.all([...dispatchers.values()].map((item) => item.destroy())); dispatchers.clear(); } };
}

type NetworkRuntime = ReturnType<typeof createNetworkRuntime>;
let defaultRuntime = createNetworkRuntime({ settingsFile: path.resolve(process.cwd(), "data/network-settings.json") });
export function getNetworkFetch(settingsOverride?: NetworkSettings): Promise<typeof fetch> { return defaultRuntime.getFetch(settingsOverride); }
export function getNetworkOperation(settingsOverride?: NetworkSettings): Promise<NetworkOperation> { return defaultRuntime.getOperation(settingsOverride); }

function loopback(value: string | undefined): boolean {
  return !!value && (value === "::1" || value === "localhost" || /^127\.\d+\.\d+\.\d+$/.test(value) || /^::ffff:127\.\d+\.\d+\.\d+$/.test(value));
}
export function isTrustedLocalRequest(request: IncomingMessage): boolean {
  if (!loopback(request.socket.remoteAddress)) return false;
  let host: URL;
  try { host = new URL(`http://${request.headers.host}`); } catch { return false; }
  if (!loopback(host.hostname.replace(/^\[|\]$/g, ""))) return false;
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers.origin;
  if (origin && origin !== host.origin) return false;
  if (request.method === "PUT" || request.method === "POST") {
    if (origin !== host.origin || !request.headers["content-type"]?.toLowerCase().startsWith("application/json")) return false;
  }
  return true;
}
function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    const cleanup = () => { clearTimeout(timer); request.off("data", onData); request.off("end", onEnd); request.off("error", onError); request.off("aborted", onAborted); };
    const fail = (error: Error) => { cleanup(); request.resume(); reject(error); };
    const onData = (chunk: Buffer) => { total += chunk.length; if (total > 8192) fail(new Error("请求内容超过 8 KB。")); else chunks.push(chunk); };
    const onEnd = () => { cleanup(); try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("请求必须是有效 JSON。")); } };
    const onError = () => fail(new Error("网络设置请求中断。"));
    const onAborted = () => fail(new Error("网络设置请求中断。"));
    const timer = setTimeout(() => fail(new Error("网络设置请求读取超时。")), 5_000);
    request.on("data", onData); request.on("end", onEnd); request.on("error", onError); request.on("aborted", onAborted);
  });
}
export function createNetworkMiddleware(runtime: NetworkRuntime) {
  return async (request: IncomingMessage, response: ServerResponse, next: () => void): Promise<void> => {
    const pathname = request.url?.split("?")[0];
    if (!pathname?.startsWith("/api/network/")) { next(); return; }
    response.setHeader("Content-Type", "application/json; charset=utf-8"); response.setHeader("Cache-Control", "no-store"); response.setHeader("X-Content-Type-Options", "nosniff");
    const send = (status: number, value: unknown) => { response.statusCode = status; response.end(JSON.stringify(value)); };
    if (!isTrustedLocalRequest(request)) { send(403, { error: "网络设置仅允许本机页面同源访问。" }); return; }
    try {
      if (pathname === "/api/network/settings" && request.method === "GET") { send(200, { settings: await runtime.readSettings() }); return; }
      if (pathname === "/api/network/detect" && request.method === "GET") { send(200, await runtime.detect()); return; }
      if (pathname === "/api/network/settings" && request.method === "PUT") {
        const body = await readJson(request) as { settings?: unknown };
        const settings = validateNetworkSettings(body?.settings);
        try { await runtime.saveSettings(settings); } catch { send(500, { error: "无法保存本机网络配置，请检查数据目录的写入权限。" }); return; }
        send(200, { settings }); return;
      }
      if (pathname === "/api/network/test" && request.method === "POST") { const body = await readJson(request) as { settings?: unknown; target?: unknown }; send(200, await runtime.testConnection(body?.settings, body?.target)); return; }
      send(405, { error: "不支持的网络设置请求。" });
    } catch (error) { send(400, { error: error instanceof Error ? error.message : "网络设置操作失败。" }); }
  };
}

export function networkProxyPlugin(): Plugin {
  let runtime: NetworkRuntime;
  return {
    name: "betterme-network-proxy",
    configResolved(config) { runtime = createNetworkRuntime({ settingsFile: path.resolve(config.root, "../..", "data/network-settings.json") }); defaultRuntime = runtime; },
    configureServer(server) { server.middlewares.use(createNetworkMiddleware(runtime)); server.httpServer?.once("close", () => { void runtime.close(); }); },
    configurePreviewServer(server) { server.middlewares.use(createNetworkMiddleware(runtime)); server.httpServer.once("close", () => { void runtime.close(); }); },
    async closeBundle() { if (runtime) await runtime.close(); },
  };
}
