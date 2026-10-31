import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { watchDevService } from "./dev-service-watch.js";

/** Development-only Agent Host. Its token is shared with the local browser client. */
export const AGENT_HOST_DEV_ENDPOINT = "http://127.0.0.1:5179";
export const AGENT_HOST_DEV_TOKEN = "better-me-agent-token";
export const AGENT_HOST_DEV_ORIGINS = ["http://127.0.0.1:5173", "http://localhost:5173", "http://127.0.0.1:5193"] as const;

function agentHostDirectory(): string {
  const candidates = [
    fileURLToPath(new URL("../../agent-host/", import.meta.url)),
    join(process.cwd(), "apps", "agent-host"),
    join(process.cwd(), "..", "agent-host"),
  ];
  return candidates.find((candidate) => existsSync(join(candidate, "src", "cli.ts"))) ?? candidates[0]!;
}

export function agentHostLaunchArgs(spec: { cliPath: string; tsxLoader: string; origins: readonly string[]; endpoint?: string }): string[] {
  const port = new URL(spec.endpoint ?? AGENT_HOST_DEV_ENDPOINT).port || "5179";
  return [
    "--import", spec.tsxLoader, spec.cliPath,
    "--host", "127.0.0.1", "--port", port, "--token", AGENT_HOST_DEV_TOKEN,
    ...spec.origins.flatMap((origin) => ["--origin", origin]),
  ];
}

export type AgentHostProbeStatus = "ready" | "down" | "unauthorized" | "origin-rejected" | "unavailable";

export async function probeAgentHost(endpoint = AGENT_HOST_DEV_ENDPOINT, fetchImpl: typeof fetch = fetch): Promise<AgentHostProbeStatus> {
  try {
    for (const origin of AGENT_HOST_DEV_ORIGINS) {
      const response = await fetchImpl(new URL("/api/v1/agent/health", endpoint), {
        headers: { Authorization: `Bearer ${AGENT_HOST_DEV_TOKEN}`, Origin: origin },
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(1_500),
      });
      void response.body?.cancel().catch(() => {});
      if (response.status === 401) return "unauthorized";
      if (response.status !== 200) return "unavailable";
      if (response.headers.get("access-control-allow-origin") !== origin) return "origin-rejected";
    }
    return "ready";
  } catch {
    return "down";
  }
}

export type StartedAgentHost = { exited: () => boolean; exitError: () => string | undefined; stop: () => Promise<void> };
export type AgentHostStartSpec = { endpoint: string };

function launchAgentHost(spec: AgentHostStartSpec): StartedAgentHost {
  const directory = agentHostDirectory();
  const loader = createRequire(join(directory, "package.json")).resolve("tsx");
  const child: ChildProcess = spawn(process.execPath, agentHostLaunchArgs({
    cliPath: join(directory, "src", "cli.ts"),
    tsxLoader: loader,
    origins: AGENT_HOST_DEV_ORIGINS,
    endpoint: spec.endpoint,
  }), { cwd: directory, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  let exitMessage: string | undefined;
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-2_000); });
  const lastLine = () => stderr.trim().split("\n").filter(Boolean).at(-1)?.slice(0, 500);
  child.on("error", (error) => { exitMessage = error.message; });
  child.on("exit", (code, signal) => { exitMessage ??= lastLine() || `Agent Host 进程已退出（${signal ?? code ?? "unknown"}）。`; });
  return {
    exited: () => exitMessage !== undefined || child.exitCode !== null || child.signalCode !== null,
    exitError: () => exitMessage ?? lastLine() ?? "Agent Host 进程已退出。",
    stop: async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); },
  };
}

function startupError(status: Exclude<AgentHostProbeStatus, "ready" | "down">, endpoint: string): Error {
  if (status === "unauthorized") return new Error(`${endpoint} 上已有 Agent Host，但其开发令牌不匹配；为避免中断现有服务，未替换它。`);
  if (status === "origin-rejected") return new Error(`${endpoint} 上已有 Agent Host，但未允许当前开发页来源；请检查其跨域配置。为避免中断现有服务，未替换它。`);
  return new Error(`${endpoint} 已被其他服务占用，且未通过 Agent Host 健康检查；为避免中断现有服务，未替换它。`);
}

export function createDevAgentHostBroker(options: {
  endpoint?: string;
  probe?: (endpoint: string) => Promise<AgentHostProbeStatus>;
  start?: (spec: AgentHostStartSpec) => Promise<StartedAgentHost> | StartedAgentHost;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
} = {}): { ensure: () => Promise<{ endpoint: string }>; close: () => Promise<void> } {
  const endpoint = options.endpoint ?? AGENT_HOST_DEV_ENDPOINT;
  const probe = options.probe ?? ((value: string) => probeAgentHost(value));
  const start = options.start ?? launchAgentHost;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let managed: StartedAgentHost | undefined;
  let inflight: Promise<{ endpoint: string }> | undefined;
  let closing = false;
  let stoppingUnhealthy = false;
  let unhealthyChecks = 0;

  async function ensureOnce(): Promise<{ endpoint: string }> {
    if (closing) throw new Error("Vite 开发服务已关闭，取消 Agent Host 启动。");
    const current = await probe(endpoint);
    if (closing) throw new Error("Vite 开发服务已关闭，取消 Agent Host 启动。");
    if (current === "ready") { unhealthyChecks = 0; return { endpoint }; }
    if (current !== "down") throw startupError(current, endpoint);

    if (managed) {
      if (!managed.exited()) {
        if (++unhealthyChecks < 2) throw new Error("Agent Host 健康检查暂时失败，正在复核恢复状态。");
        if (!stoppingUnhealthy) { stoppingUnhealthy = true; await managed.stop(); }
        throw new Error("Agent Host 未通过健康检查，正在等待受管理的进程退出后恢复。");
      }
      managed = undefined;
      stoppingUnhealthy = false;
      unhealthyChecks = 0;
    }

    const service = await start({ endpoint });
    if (closing) {
      await service.stop();
      throw new Error("Vite 开发服务已关闭，取消 Agent Host 启动。");
    }
    managed = service;
    try {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (closing) throw new Error("Vite 开发服务已关闭，取消 Agent Host 启动。");
        if (service.exited()) throw new Error(service.exitError() || "Agent Host 进程已退出。");
        const status = await probe(endpoint);
        if (closing) throw new Error("Vite 开发服务已关闭，取消 Agent Host 启动。");
        if (status === "ready") return { endpoint };
        if (status !== "down") throw startupError(status, endpoint);
        await sleep(150);
      }
      throw new Error(`Agent Host 在 ${timeoutMs} 毫秒内没有在 ${endpoint} 就绪。`);
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

/** Starts or reuses Agent Host only in Vite dev, and closes only a child it owns. */
export function agentHostDevPlugin(options: {
  createBroker?: () => ReturnType<typeof createDevAgentHostBroker>;
  healthIntervalMs?: number;
} = {}): Plugin {
  return {
    name: "better-me-agent-host-dev",
    apply: "serve",
    configureServer(server) {
      const broker = options.createBroker?.() ?? createDevAgentHostBroker();
      const watch = watchDevService(broker, options.healthIntervalMs ?? 10_000, (error) => {
        const message = error instanceof Error && error.message.trim() ? error.message.trim() : "Agent Host 启动失败。";
        console.error(`[agent-host-dev] ${message.replace(/\s+/g, " ").slice(0, 500)}`);
      });
      return () => { server.httpServer?.once("close", () => { void watch.close(); }); };
    },
  };
}
