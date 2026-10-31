import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { existsSync } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { createRequire } from "node:module";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { watchDevService } from "./dev-service-watch.js";

/** Dev-server-only route. Production builds and `vite preview` never register it. */
export const ATLAS_DEV_JOB_INDEX_PATH = "/__better-me/dev/local-job-index";
export const ATLAS_DEV_JOB_INDEX_ENDPOINT = "http://127.0.0.1:5178";
export const ATLAS_DEV_PAGE_ORIGINS = ["http://127.0.0.1:5173", "http://localhost:5173", "http://127.0.0.1:5193"] as const;

const DUMMY_PROBE_TOKEN = "0".repeat(43);

function jobServiceDirectory(): string {
  const candidates = [
    fileURLToPath(new URL("../../job-service/", import.meta.url)),
    join(process.cwd(), "apps", "job-service"),
    join(process.cwd(), "..", "job-service"),
  ];
  return candidates.find((candidate) => existsSync(join(candidate, "src", "cli.ts"))) ?? candidates[0]!;
}

export function defaultJobAtlasDataDirectory(home = homedir()): string {
  return join(home, "Library", "Application Support", "BetterMe", "job-atlas");
}

export function jobServiceLaunchArgs(spec: { dataDirectory: string; port: string; origins: readonly string[]; cliPath: string; tsxLoader: string; officeGeocoder?: string }): string[] {
  return [
    "--import", spec.tsxLoader, spec.cliPath,
    "--data-dir", spec.dataDirectory, "--host", "127.0.0.1", "--port", spec.port,
    ...spec.origins.flatMap((origin) => ["--origin", origin]),
    ...(spec.officeGeocoder ? ["--office-geocoder", spec.officeGeocoder] : []),
  ];
}

export type JobServiceProbeStatus = "ready" | "down" | "unauthorized" | "origin-rejected" | "unavailable";

/** Loopback health check. The token is sent only to the job service, never logged. */
export async function probeJobServiceOrigin(endpoint: string, token: string, origin: string, fetchImpl: typeof fetch = fetch): Promise<JobServiceProbeStatus> {
  try {
    const response = await fetchImpl(new URL("/healthz", endpoint), {
      headers: { Authorization: `Bearer ${token}`, Origin: origin },
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(3000),
    });
    if (response.status === 200) { void response.body?.cancel().catch(() => {}); return "ready"; }
    const body = await response.text();
    if (response.status === 401) return "unauthorized";
    if (response.status === 403 && body.includes("origin-not-allowed")) return "origin-rejected";
    return "unavailable";
  } catch { return "down"; }
}

export async function readJobServiceToken(directory: string): Promise<string | undefined> {
  const tokenPath = join(directory, "service.token");
  let stat: Awaited<ReturnType<typeof lstat>>;
  try { stat = await lstat(tokenPath); }
  catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return undefined;
    throw new Error("本机岗位服务令牌文件无法读取。", { cause: error });
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256) throw new Error("现有 service.token 无法使用，文件已保留。");
  const handle = await open(tokenPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > 256) throw new Error("现有 service.token 无法使用，文件已保留。");
    const raw = await handle.readFile("utf8");
    if (!/^[A-Za-z0-9_-]{43,128}\n?$/.test(raw)) throw new Error("现有 service.token 无法使用，文件已保留。");
    return raw.trimEnd();
  } finally { await handle.close(); }
}

export type StartedJobService = { exited: () => boolean; exitError: () => string | undefined; stop: () => Promise<void> };
export type JobServiceStartSpec = { dataDirectory: string; endpoint: string; origins: readonly string[] };
type EnsureResult = { endpoint: string; token: string };

function launchJobService(spec: JobServiceStartSpec): StartedJobService {
  const url = new URL(spec.endpoint);
  const directory = jobServiceDirectory();
  const loader = createRequire(join(directory, "package.json")).resolve("tsx");
  const hasAmap = existsSync(join(spec.dataDirectory, "amap.key")) || Boolean(process.env.AMAP_KEY) || Boolean(process.env.AMAP_WEB_KEY);
  const child: ChildProcess = spawn(process.execPath, jobServiceLaunchArgs({
    dataDirectory: spec.dataDirectory,
    port: url.port || "5178",
    origins: spec.origins,
    cliPath: join(directory, "src", "cli.ts"),
    tsxLoader: loader,
    ...(hasAmap ? { officeGeocoder: "amap" } : {}),
  }), { cwd: directory, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  let exitMessage: string | undefined;
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });
  const lastLine = () => stderr.trim().split("\n").filter(Boolean).at(-1)?.slice(0, 500);
  child.on("error", (error) => { exitMessage = error.message; });
  child.on("exit", (code, signal) => { exitMessage ??= lastLine() || `岗位服务进程已退出（${signal ?? code ?? "unknown"}）。`; });
  return {
    exited: () => exitMessage !== undefined || child.exitCode !== null || child.signalCode !== null,
    exitError: () => exitMessage ?? lastLine() ?? "岗位服务进程已退出。",
    stop: async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); },
  };
}

function statusError(status: Exclude<JobServiceProbeStatus, "ready" | "down">, endpoint: string, origins: readonly string[]): string {
  if (status === "unauthorized") return `${endpoint} 上的岗位服务拒绝了数据目录中的访问令牌。开发页不会改用其他令牌。`;
  if (status === "origin-rejected") return `${endpoint} 上的岗位服务未允许当前开发页来源。需要同时允许 ${origins.join(" 和 ")}。`;
  return `${endpoint} 上的岗位服务没有返回可用的健康检查。`;
}

export function createDevJobIndexBroker(options: {
  dataDirectory?: string;
  endpoint?: string;
  origins?: readonly string[];
  readToken?: (directory: string) => Promise<string | undefined>;
  probe?: (endpoint: string, token: string, origin: string) => Promise<JobServiceProbeStatus>;
  start?: (spec: JobServiceStartSpec) => Promise<StartedJobService> | StartedJobService;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
} = {}): { ensure: () => Promise<EnsureResult>; close: () => Promise<void> } {
  const dataDirectory = options.dataDirectory ?? defaultJobAtlasDataDirectory();
  const endpoint = options.endpoint ?? ATLAS_DEV_JOB_INDEX_ENDPOINT;
  const origins = options.origins ?? ATLAS_DEV_PAGE_ORIGINS;
  const readToken = options.readToken ?? readJobServiceToken;
  const probe = options.probe ?? probeJobServiceOrigin;
  const start = options.start ?? launchJobService;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  if (!isAbsolute(dataDirectory)) throw new Error("岗位索引数据目录必须是仓库外的绝对路径。");
  if (origins.length === 0) throw new Error("至少要允许一个开发页来源。");
  let managed: StartedJobService | undefined;
  let inflight: Promise<EnsureResult> | undefined;
  let closing = false;
  let stoppingUnhealthy = false;
  let unhealthyChecks = 0;

  async function classify(token: string): Promise<JobServiceProbeStatus> {
    for (const origin of origins) {
      const status = await probe(endpoint, token, origin);
      if (status !== "ready") return status;
    }
    return "ready";
  }

  async function waitUntilReady(service: StartedJobService): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (closing) throw new Error("Vite 开发服务已关闭，取消岗位索引启动。");
      if (service.exited()) throw new Error(service.exitError() || "岗位服务进程已退出。");
      const token = await readToken(dataDirectory);
      if (closing) throw new Error("Vite 开发服务已关闭，取消岗位索引启动。");
      if (token) {
        const status = await classify(token);
        if (closing) throw new Error("Vite 开发服务已关闭，取消岗位索引启动。");
        if (status === "ready") return token;
        if (status !== "down") throw new Error(statusError(status, endpoint, origins));
      }
      await sleep(150);
    }
    throw new Error(`岗位服务在 ${timeoutMs} 毫秒内没有在 ${endpoint} 就绪。`);
  }

  async function ensureOnce(): Promise<EnsureResult> {
    if (closing) throw new Error("Vite 开发服务已关闭，取消岗位索引启动。");
    const current = await readToken(dataDirectory);
    if (closing) throw new Error("Vite 开发服务已关闭，取消岗位索引启动。");
    if (current) {
      const status = await classify(current);
      if (closing) throw new Error("Vite 开发服务已关闭，取消岗位索引启动。");
      if (status === "ready") { unhealthyChecks = 0; return { endpoint, token: current }; }
      if (status !== "down") throw new Error(statusError(status, endpoint, origins));
    } else {
      const listening = await probe(endpoint, DUMMY_PROBE_TOKEN, origins[0] ?? ATLAS_DEV_PAGE_ORIGINS[0]);
      if (closing) throw new Error("Vite 开发服务已关闭，取消岗位索引启动。");
      if (listening !== "down") throw new Error(`${endpoint} 已有岗位服务，但本机数据目录没有可用的 service.token。开发页不会使用其他令牌。`);
    }
    if (managed) {
      if (!managed.exited()) {
        if (++unhealthyChecks < 2) throw new Error("岗位索引健康检查暂时失败，正在复核恢复状态。");
        if (!stoppingUnhealthy) { stoppingUnhealthy = true; await managed.stop(); }
        throw new Error("岗位索引未通过健康检查，正在等待受管理的进程退出后恢复。");
      }
      managed = undefined;
      stoppingUnhealthy = false;
      unhealthyChecks = 0;
    }
    const service = await start({ dataDirectory, endpoint, origins });
    if (closing) {
      await service.stop();
      throw new Error("Vite 开发服务已关闭，取消岗位索引启动。");
    }
    managed = service;
    try {
      const token = await waitUntilReady(service);
      return { endpoint, token };
    } catch (error) {
      await service.stop().catch(() => undefined);
      if (managed === service) managed = undefined;
      throw error;
    }
  }

  return {
    ensure: () => {
      inflight ??= ensureOnce().finally(() => { inflight = undefined; });
      return inflight;
    },
    close: async () => {
      closing = true;
      await inflight?.catch(() => undefined);
      const service = managed; managed = undefined; await service?.stop();
    },
  };
}

function loopbackPeer(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function loopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const value = host.toLowerCase();
  if (value.startsWith("[")) return value.startsWith("[::1]");
  const name = value.split(":")[0];
  return name === "127.0.0.1" || name === "localhost";
}

export function publicDevIndexError(error: unknown): string {
  const message = error instanceof Error && error.message.trim() ? error.message.trim() : "无法准备本机岗位索引。";
  return message.replace(/[A-Za-z0-9_-]{43,}/g, "[redacted]").replace(/\s+/g, " ").slice(0, 500);
}

function send(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(JSON.stringify(value));
}

export function createDevJobIndexMiddleware(broker: { ensure: () => Promise<EnsureResult> }) {
  return (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname !== ATLAS_DEV_JOB_INDEX_PATH) { next(); return; }
    if (!loopbackPeer(request.socket.remoteAddress) || !loopbackHost(request.headers.host)) {
      send(response, 403, { error: "仅本机开发页可以读取岗位索引连接。" });
      return;
    }
    if (request.url?.includes("?")) { send(response, 400, { error: "岗位索引连接地址不接受查询参数。" }); return; }
    if (!["GET", "HEAD"].includes(request.method ?? "GET")) { send(response, 405, { error: "仅支持读取岗位索引连接。" }); return; }
    void (async () => {
      try {
        const value = await broker.ensure();
        if (response.destroyed || response.writableEnded) return;
        if (value.endpoint !== ATLAS_DEV_JOB_INDEX_ENDPOINT || !/^[A-Za-z0-9_-]{43,128}$/.test(value.token)) {
          send(response, 503, { error: "本机岗位服务没有返回可用的 loopback 连接。" });
          return;
        }
        if (request.method === "HEAD") {
          response.writeHead(200, { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
          response.end();
          return;
        }
        send(response, 200, { endpoint: value.endpoint, token: value.token });
      } catch (error) {
        console.error(`[atlas-dev-index] ${publicDevIndexError(error)}`);
        send(response, 503, { error: publicDevIndexError(error) });
      }
    })().catch((error) => next(error));
  };
}

/** Registers the loopback helper on the Vite development server only. */
export function atlasDevIndexPlugin(options: {
  createBroker?: () => ReturnType<typeof createDevJobIndexBroker>;
  healthIntervalMs?: number;
} = {}): Plugin {
  return {
    name: "better-me-atlas-dev-index",
    apply: "serve",
    configureServer(server) {
      const broker = options.createBroker?.() ?? createDevJobIndexBroker();
      server.middlewares.use(createDevJobIndexMiddleware(broker));
      const watch = watchDevService(broker, options.healthIntervalMs ?? 10_000, (error) => {
        console.error(`[atlas-dev-index] ${publicDevIndexError(error)}`);
      });
      return () => { server.httpServer?.once("close", () => { void watch.close(); }); };
    },
  };
}
