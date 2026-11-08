import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

export class WebServerManager {
  private process: ChildProcess | null = null;
  private readonly port: number = 5173;
  private readonly url: string = "http://127.0.0.1:5173";

  async isRunning(): Promise<boolean> {
    try {
      const res = await fetch(this.url, { signal: AbortSignal.timeout(800) });
      return res.status < 500;
    } catch {
      return false;
    }
  }

  async ensureStarted(): Promise<void> {
    if (await this.isRunning()) {
      console.log("[desktop:web] Web server is already running at", this.url);
      return;
    }

    const appPath = app.getAppPath();
    const candidateDirs = [
      path.resolve(appPath, "../web"),
      path.resolve(appPath, "apps/web"),
      path.resolve(appPath, "../../../../better-me-agent-os/apps/web"),
      path.resolve(__dirname, "../../../../../better-me-agent-os/apps/web"),
      path.resolve(process.cwd(), "better-me-agent-os/apps/web"),
      path.resolve(process.cwd(), "apps/web"),
      path.resolve(process.cwd(), "../web"),
    ];

    const webDir = candidateDirs.find((d) => existsSync(path.join(d, "package.json")));
    if (!webDir) {
      console.warn("[desktop:web] Could not locate apps/web directory.");
      return;
    }

    const viteBin = path.resolve(webDir, "node_modules/.bin/vite");
    const useViteDirect = existsSync(viteBin);

    console.log(`[desktop:web] Spawning web dev server from ${webDir} (direct vite: ${useViteDirect})`);

    const env = {
      ...process.env,
      PATH: `/usr/local/bin:/opt/homebrew/bin:${process.env.PATH || ""}`,
    };

    if (useViteDirect) {
      this.process = spawn(viteBin, ["--port", "5173", "--host", "127.0.0.1"], {
        cwd: webDir,
        env,
        stdio: "pipe",
      });
    } else {
      this.process = spawn("pnpm", ["dev"], {
        cwd: webDir,
        env,
        stdio: "pipe",
      });
    }

    this.process.stdout?.on("data", (data) => {
      const str = data.toString().trim();
      if (str.includes("ready in") || str.includes("Local:")) {
        console.log(`[desktop:web] ${str}`);
      }
    });

    // Wait until web server responds
    const start = Date.now();
    while (Date.now() - start < 15000) {
      if (await this.isRunning()) {
        console.log("[desktop:web] Successfully connected to web server at", this.url);
        return;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    console.warn("[desktop:web] Web server did not respond within 15s; proceeding anyway.");
  }

  stop(): void {
    if (this.process) {
      console.log("[desktop:web] Stopping child web server...");
      try {
        this.process.kill();
      } catch {}
      this.process = null;
    }
  }
}
