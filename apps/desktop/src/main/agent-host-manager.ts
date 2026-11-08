import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

export interface AgentHostConfig {
  endpoint: string;
  token: string;
  port: number;
}

export class AgentHostManager {
  private process: ChildProcess | null = null;
  private readonly port: number = 5179;
  private readonly token: string = "better-me-agent-token";
  private readonly endpoint: string = "http://127.0.0.1:5179";

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

    // Locate agent-host cli
    const appPath = app.getAppPath();
    const candidateDirs = [
      path.resolve(appPath, "../agent-host"),
      path.resolve(appPath, "apps/agent-host"),
      path.resolve(appPath, "../../../../better-me-agent-os/apps/agent-host"),
      path.resolve(__dirname, "../../../../../better-me-agent-os/apps/agent-host"),
      path.resolve(process.cwd(), "better-me-agent-os/apps/agent-host"),
      path.resolve(process.cwd(), "apps/agent-host"),
      path.resolve(process.cwd(), "../agent-host"),
    ];

    const hostDir = candidateDirs.find((d) => existsSync(path.join(d, "src/cli.ts")));
    if (!hostDir) {
      console.warn("[desktop:agent-host] Could not find agent-host source directory, assuming standalone/external host.");
      return;
    }

    const cliPath = path.join(hostDir, "src/cli.ts");
    console.log("[desktop:agent-host] Spawning embedded agent-host from:", cliPath);

    try {
      this.process = spawn(
        process.execPath, // In dev, this is electron or node
        [
          "--import",
          path.resolve(hostDir, "../../node_modules/.pnpm/tsx@4.23.15/node_modules/tsx/dist/loader.mjs"),
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
          env: {
            ...process.env,
            NODE_ENV: app.isPackaged ? "production" : "development",
            ELECTRON_RUN_AS_NODE: "1",
          },
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
  }

  stop(): void {
    if (this.process) {
      console.log("[desktop:agent-host] Stopping embedded agent-host process...");
      this.process.kill();
      this.process = null;
    }
  }
}
