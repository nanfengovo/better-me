import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { assertDesktopQaEndpoint } from "./isolated-qa-config.js";

export class WebServerManager {
  private process: ChildProcess | null = null;
  private readonly port: number;
  private readonly url: string;
  private readonly externalOnly: boolean;

  constructor(qa?: { externalOnly: true; endpoint: string; port: number }) {
    if (qa) {
      assertDesktopQaEndpoint(qa.endpoint, qa.port);
      if (qa.externalOnly !== true) throw new Error("desktop_qa_configuration_invalid");
    }
    this.port = qa?.port ?? 5173;
    this.url = qa?.endpoint ?? "http://127.0.0.1:5173";
    this.externalOnly = qa?.externalOnly === true;
  }

  getEndpoint(): string { return this.url; }

  private async probe(): Promise<"ready" | "absent" | "occupied"> {
    try {
      const res = await fetch(this.url, { signal: AbortSignal.timeout(1000), redirect: "manual" });
      if (!res.ok || !res.headers.get("Content-Type")?.toLowerCase().includes("text/html") || !res.body) {
        await res.body?.cancel(); return "occupied";
      }
      // A listener on 5173 may be an unrelated dev app. Recognize the
      // expected entry point before exposing the Electron bridge to a page.
      const reader = res.body.getReader(), decoder = new TextDecoder();
      let html = "", remaining = 8192;
      try {
        while (remaining > 0) {
          const { done, value } = await reader.read();
          if (done) break;
          html += decoder.decode(value.subarray(0, remaining), { stream: true });
          remaining -= value.length;
          if (/<\/html>/i.test(html)) break;
        }
      } finally { await reader.cancel().catch(() => {}); }
      return html.includes("<title>迈向更好 · BetterMe</title>") && html.includes('id="root"') && html.includes('type="module"') ? "ready" : "occupied";
    } catch {
      return "absent";
    }
  }

  async ensureStarted(): Promise<void> {
    const current = await this.probe();
    if (current === "occupied") throw new Error("本机 5173 端口上的服务未被识别为 BetterMe。为保护桌面权限，未打开该页面，也未替换该服务。");
    if (current === "ready") {
      console.log("[desktop:web] Web server is already running at", this.url);
      return;
    }
    if (this.externalOnly) throw new Error("desktop_qa_external_web_unavailable");

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
      throw new Error("本机 BetterMe Web 服务不可用，且未找到工作区源码。请安装工作区依赖或启动本机 BetterMe 服务后重试。");
    }

    const viteBin = path.resolve(webDir, "node_modules/.bin/vite");
    const useViteDirect = existsSync(viteBin);

    console.log(`[desktop:web] Spawning web dev server from ${webDir} (direct vite: ${useViteDirect})`);

    const env = {
      ...process.env,
      PATH: `/usr/local/bin:/opt/homebrew/bin:${process.env.PATH || ""}`,
    };

    if (useViteDirect) {
      this.process = spawn(viteBin, ["--port", String(this.port), "--strictPort", "--host", "127.0.0.1"], {
        cwd: webDir,
        env,
        stdio: "pipe",
      });
    } else {
      this.process = spawn("pnpm", ["dev", "--port", String(this.port), "--strictPort", "--host", "127.0.0.1"], {
        cwd: webDir,
        env,
        stdio: "pipe",
      });
    }
    let exited = false;
    this.process.once("error", () => { exited = true; });
    this.process.once("exit", () => { exited = true; });

    this.process.stdout?.on("data", (data) => {
      const str = data.toString().trim();
      if (str.includes("ready in") || str.includes("Local:")) {
        console.log(`[desktop:web] ${str}`);
      }
    });

    // Wait until web server responds
    const start = Date.now();
    while (!exited && Date.now() - start < 15000) {
      const probe = await this.probe();
      if (probe === "ready") {
        console.log("[desktop:web] Successfully connected to web server at", this.url);
        return;
      }
      if (probe === "occupied") break;
      await new Promise((r) => setTimeout(r, 400));
    }
    this.stop();
    throw new Error("本机 BetterMe Web 服务未能在 127.0.0.1:5173 就绪。未加载其他页面；请检查端口及工作区依赖后重试。");
  }

  stop(): void {
    if (this.externalOnly) return;
    if (this.process) {
      console.log("[desktop:web] Stopping child web server...");
      try {
        this.process.kill();
      } catch { /* The owned child may already have exited. */ }
      this.process = null;
    }
  }
}
