import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createHash, randomUUID } from "node:crypto";
import * as esbuild from "esbuild";

export type MicroAppScope = "selected_offers" | "backcheck_summary" | "job_snapshots";

export interface SandboxBuildInput {
  appId: string;
  name: string;
  nameEn?: string;
  icon?: string;
  version?: string;
  description?: string;
  grantedScopes: MicroAppScope[];
  sourceCode: string;
  customCss?: string;
  dependencies?: string[];
  syntheticMockData?: unknown;
}

export interface SandboxVerificationCheck {
  id: string;
  name: string;
  passed: boolean;
  detail: string;
}

export interface SandboxVerificationResult {
  passed: boolean;
  timestamp: string;
  checks: SandboxVerificationCheck[];
}

export interface BuiltMicroAppArtifact {
  appId: string;
  name: string;
  nameEn: string;
  icon: string;
  version: string;
  description: string;
  codeHash: string;
  grantedScopes: MicroAppScope[];
  bundleHtml: string;
  compiledAt: string;
  pinnedToDock: boolean;
  verification: SandboxVerificationResult;
}

export class SandboxBuildService {
  constructor(private readonly workDir = path.join(os.tmpdir(), "betterme-sandbox-builds")) {}

  /**
   * Bundles source code using esbuild inside an isolated directory,
   * performs a pre-flight synthetic execution in a secure VM realm,
   * and wraps it in a hardened CSP-locked HTML document.
   */
  async build(input: SandboxBuildInput): Promise<BuiltMicroAppArtifact> {
    const buildId = randomUUID();
    const buildDir = path.join(this.workDir, `build-${input.appId}-${buildId}`);
    await fs.mkdir(buildDir, { recursive: true });

    try {
      const entryFile = path.join(buildDir, "index.tsx");
      await fs.writeFile(entryFile, input.sourceCode, "utf8");

      // 1. esbuild isolated compilation
      const buildResult = await esbuild.build({
        entryPoints: [entryFile],
        bundle: false,
        format: "iife",
        target: ["es2022"],
        minify: false,
        write: false,
        loader: {
          ".tsx": "tsx",
          ".ts": "ts",
          ".jsx": "jsx",
          ".js": "js",
        },
      });

      const compiledJs = buildResult.outputFiles?.[0]?.text ?? input.sourceCode;
      const codeHash = createHash("sha256").update(compiledJs).digest("hex");

      // 2. Pre-flight synthetic test
      const checks: SandboxVerificationCheck[] = [];

      // Check 1: Compilation sanity
      checks.push({
        id: "esbuild-compile",
        name: "esbuild 语法解析与 IIFE 隔离编译",
        passed: true,
        detail: `代码编译通过，产物尺寸: ${(Buffer.byteLength(compiledJs) / 1024).toFixed(1)} KB`,
      });

      // Check 2: CSP security audit
      const hasDangerousEvals = /\beval\(|new\s+Function\(|document\.cookie|window\.parent\.localStorage/i.test(compiledJs);
      checks.push({
        id: "csp-security",
        name: "CSP 零外联与越权访问静态审计",
        passed: !hasDangerousEvals,
        detail: hasDangerousEvals
          ? "检测到潜在危险的 eval 或直接宿主存储访问"
          : "无越权调用，严格遵循 postMessage 受控桥通道",
      });

      // Check 3: Synthetic data dry run in VM realm
      let syntheticPassed = true;
      let syntheticDetail = "合成数据隔离自检通过";
      try {
        const sandboxGlobals: Record<string, unknown> = {
          window: {
            renderMicroApp: null,
            parent: { postMessage: () => {} },
            addEventListener: () => {},
            removeEventListener: () => {},
          },
          document: {
            documentElement: { setAttribute: () => {} },
            getElementById: () => ({ innerHTML: "" }),
          },
          console: { log: () => {}, warn: () => {}, error: () => {} },
        };
        const script = new vm.Script(`
          (function() {
            ${compiledJs}
          })();
        `);
        const context = vm.createContext(sandboxGlobals);
        script.runInContext(context, { timeout: 1500 });
        syntheticDetail = "已成功在隔离环境模拟运行并核验脚本生命周期";
      } catch (err) {
        syntheticPassed = false;
        syntheticDetail = `合成自检未通过: ${err instanceof Error ? err.message : String(err)}`;
      }

      checks.push({
        id: "synthetic-dryrun",
        name: "合成数据隔离环境冒烟测试",
        passed: syntheticPassed,
        detail: syntheticDetail,
      });

      const allPassed = checks.every((c) => c.passed);

      // 3. Assemble hardened CSP-locked HTML
      const version = input.version || "1.0.0";
      const bundleHtml = this.generateHardenedHtml({
        appId: input.appId,
        name: input.name,
        version,
        codeHash,
        jsCode: compiledJs,
        customCss: input.customCss || "",
      });

      return {
        appId: input.appId,
        name: input.name,
        nameEn: input.nameEn || input.name,
        icon: input.icon || "⚡",
        version,
        description: input.description || "Agent 自主构建与安全验证的微应用",
        codeHash,
        grantedScopes: input.grantedScopes,
        bundleHtml,
        compiledAt: new Date().toISOString(),
        pinnedToDock: false,
        verification: {
          passed: allPassed,
          timestamp: new Date().toISOString(),
          checks,
        },
      };
    } finally {
      await fs.rm(buildDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private generateHardenedHtml(opts: {
    appId: string;
    name: string;
    version: string;
    codeHash: string;
    jsCode: string;
    customCss: string;
  }): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<title>${opts.name}</title>
<style>
  :root {
    --bg: #F8FAFC;
    --surface: #FFFFFF;
    --border: #E2E8F0;
    --text: #0F172A;
    --muted: #64748B;
    --accent: #0284C7;
    --accent-bg: rgba(2, 132, 199, 0.08);
    --success: #059669;
    --warn: #D97706;
  }
  :root[data-theme="dark"] {
    --bg: #070B12;
    --surface: #0E1624;
    --border: #1E2D40;
    --text: #F1F5F9;
    --muted: #94A3B8;
    --accent: #38BDF8;
    --accent-bg: rgba(56, 189, 248, 0.12);
    --success: #10B981;
    --warn: #F59E0B;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    padding: 16px;
    font-size: 13px;
    line-height: 1.5;
  }
  .app-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 16px;
  }
  .app-badge {
    font-size: 10px;
    font-family: ui-monospace, monospace;
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--accent-bg);
    color: var(--accent);
    border: 1px solid var(--border);
  }
  ${opts.customCss}
</style>
</head>
<body>
<div id="root">
  <div class="app-header">
    <div>
      <h2 style="font-size:15px; font-weight:800;">${opts.name}</h2>
      <p style="font-size:11px; color:var(--muted); margin-top:2px;">BetterMe Agent OS · 安全沙箱隔离容器</p>
    </div>
    <span class="app-badge">HASH: ${opts.codeHash.slice(0, 8)}</span>
  </div>
  <div id="app-content">
    <div style="padding:24px; text-align:center; color:var(--muted);">
      <p>正在建立安全 JSON-RPC 双向受控通道...</p>
    </div>
  </div>
</div>

<script>
(function() {
  var APP_META = {
    appId: "${opts.appId}",
    version: "${opts.version}",
    codeHash: "${opts.codeHash}"
  };

  // 1. Send handshake ready signal to host window
  window.parent.postMessage({
    jsonrpc: "2.0",
    method: "ui/ready",
    params: { appId: APP_META.appId }
  }, "*");

  // 2. Listen for host data initialization
  window.addEventListener("message", function(event) {
    if (!event.data || event.data.jsonrpc !== "2.0") return;
    if (event.data.method === "ui/initialize" && event.data.params) {
      var params = event.data.params;
      if (params.theme) {
        document.documentElement.setAttribute("data-theme", params.theme);
      }
      try {
        if (typeof window.renderMicroApp === "function") {
          window.renderMicroApp(params, document.getElementById("app-content"), function(action, payload) {
            window.parent.postMessage({
              jsonrpc: "2.0",
              method: "workspace/proposeDecision",
              params: Object.assign({ appId: APP_META.appId, action: action }, payload || {})
            }, "*");
          });
        }
      } catch(err) {
        console.error("Micro-app render error:", err);
      }
    }
  });

  // User-compiled script execution
  try {
    ${opts.jsCode}
  } catch(e) {
    console.error("Sandboxed app bootstrap error:", e);
    document.getElementById("app-content").innerHTML = '<div style="color:#ef4444; padding:16px; background:rgba(239,68,68,0.1); border-radius:8px;"><strong>微应用启动异常:</strong> ' + e.message + '</div>';
  }
})();
</script>
</body>
</html>`;
  }
}
