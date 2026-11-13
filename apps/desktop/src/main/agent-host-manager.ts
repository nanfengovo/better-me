import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { assertDesktopQaEndpoint, assertDesktopQaToken } from "./isolated-qa-config.js";
import { agentHostEnvironment, resolveAgentHostRuntime } from "./agent-host-runtime.js";

export interface AgentHostConfig {
  endpoint: string;
  token: string;
  port: number;
}

export class AgentHostManager {
  private process: ChildProcess | null = null;
  private readonly port: number;
  private readonly token: string;
  private readonly endpoint: string;
  private readonly externalOnly: boolean;

  constructor(qa?: AgentHostConfig & { externalOnly: true }) {
    if (qa) {
      assertDesktopQaEndpoint(qa.endpoint, qa.port);
      assertDesktopQaToken(qa.token);
      if (qa.externalOnly !== true) throw new Error("desktop_qa_configuration_invalid");
    }
    this.port = qa?.port ?? 5179;
    this.token = qa?.token ?? "better-me-agent-token";
    this.endpoint = qa?.endpoint ?? "http://127.0.0.1:5179";
    this.externalOnly = qa?.externalOnly === true;
  }

  getConfig(): AgentHostConfig {
    return {
      endpoint: this.endpoint,
      token: this.token,
      port: this.port,
    };
  }

  async isRunning(): Promise<boolean> {
    try {
      const res = await fetch(`${this.endpoint}/api/v1/agent/health`, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(1000),
        ...(this.externalOnly ? { redirect: "error" as const } : {}),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async ensureStarted(): Promise<void> {
    const alreadyRunning = await this.isRunning();
    if (alreadyRunning) {
      console.log("[desktop:agent-host] Host is already running at", this.endpoint);
      return;
    }
    if (this.externalOnly) throw new Error("desktop_qa_external_host_unavailable");

    // This source-linked desktop loads only its known app/worktree layout, never launch cwd or PATH.
    const appPath = app.getAppPath();
    const candidateDirs = [
      path.resolve(appPath, "../agent-host"),
      path.resolve(appPath, "apps/agent-host"),
      path.resolve(appPath, "../../../../better-me-agent-os/apps/agent-host"),
      path.resolve(__dirname, "../../../../../better-me-agent-os/apps/agent-host"),
    ];

    const hostDir = candidateDirs.find((d) => existsSync(path.join(d, "src/cli.ts")));
    if (!hostDir) {
      throw new Error("desktop_agent_host_source_unavailable：未找到桌面工作台配套的 Agent Host。请先启动受信任的本机 Host。");
    }

    const cliPath = path.join(hostDir, "src/cli.ts");
    const loaderPath = path.resolve(hostDir, "../../node_modules/.pnpm/tsx@4.23.15/node_modules/tsx/dist/loader.mjs");
    if (!existsSync(loaderPath)) throw new Error("desktop_agent_host_source_unavailable：未找到 Agent Host 配套的 tsx 加载器。");
    const runtime = resolveAgentHostRuntime();
    console.log("[desktop:agent-host] Spawning embedded agent-host from:", cliPath);

    try {
      this.process = spawn(
        runtime.executable,
        [
          "--import",
          loaderPath,
          cliPath,
          "--host",
          "127.0.0.1",
          "--port",
          String(this.port),
          "--token",
          this.token,
          "--origin",
          "http://127.0.0.1:5173",
          "--origin",
          "http://localhost:5173",
          "--origin",
          "app://-",
        ],
        {
          cwd: hostDir,
          env: agentHostEnvironment(runtime, app.isPackaged),
          stdio: "pipe",
        }
      );

      this.process.stdout?.on("data", (data) => {
        const str = data.toString().trim();
        if (str) console.log(`[agent-host:stdout] ${str}`);
      });

      this.process.stderr?.on("data", (data) => {
        const str = data.toString().trim();
        if (str && !str.includes("ExperimentalWarning")) console.error(`[agent-host:stderr] ${str}`);
      });

      this.process.on("error", () => {
        console.error("[desktop:agent-host] Child process could not start.");
        this.process = null;
      });
      this.process.on("exit", (code) => {
        console.log(`[desktop:agent-host] Process exited with code ${code}`);
        this.process = null;
      });

      // Wait up to 5 seconds for health endpoint
      const startTime = Date.now();
      while (Date.now() - startTime < 5000) {
        if (await this.isRunning()) {
          console.log("[desktop:agent-host] Embedded host verified healthy on port", this.port);
          return;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    } catch (err) {
      console.error("[desktop:agent-host] Failed to spawn agent-host:", err);
    }
    throw new Error("desktop_agent_host_not_ready：本机 Agent Host 未在启动时间内通过健康检查，请核对本机服务后重试。");
  }

  stop(): void {
    if (this.externalOnly) return;
    if (this.process) {
      console.log("[desktop:agent-host] Stopping embedded agent-host process...");
      this.process.kill();
      this.process = null;
    }
  }
}
