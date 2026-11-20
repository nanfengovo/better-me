import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "../apps/web/node_modules/playwright-core/index.mjs";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const webDistDir = path.join(rootDir, "apps", "web", "dist");
const agentHostDir = path.join(rootDir, "apps", "agent-host");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".geojson": "application/geo+json; charset=utf-8",
};

function findChromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate));
}

async function allocatePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate port.")));
        return;
      }
      server.close((err) => (err ? reject(err) : resolve(address.port)));
    });
  });
}

async function waitForHealth(url, token, origin, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Origin: origin },
        signal: AbortSignal.timeout(1_500),
      });
      await res.body?.cancel().catch(() => {});
      if (res.ok) return;
    } catch {
      // Retry until ready
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function createStaticAndProxyGateway(distDir, agentOrigin) {
  const realDist = fs.realpathSync(distDir);
  return http.createServer(async (req, res) => {
    const rawUrl = req.url || "/";
    if (rawUrl.startsWith("/api/v1/agent")) {
      const targetUrl = new URL(rawUrl, agentOrigin);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (!value || key.toLowerCase() === "host" || key.toLowerCase() === "content-length") continue;
        headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      try {
        const upstream = await fetch(targetUrl, {
          method: req.method,
          headers,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
          redirect: "manual",
        });
        const responseHeaders = {};
        upstream.headers.forEach((value, key) => {
          if (key.toLowerCase() === "transfer-encoding") return;
          responseHeaders[key] = value;
        });
        const setCookie = upstream.headers.getSetCookie?.() ?? [];
        if (setCookie.length) responseHeaders["set-cookie"] = setCookie;
        const payload = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status, responseHeaders);
        res.end(payload);
      } catch (err) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    const reqPath = new URL(rawUrl, "http://127.0.0.1").pathname;
    const rel = reqPath === "/" ? "index.html" : reqPath.replace(/^\/+/, "");
    let filePath = path.resolve(realDist, rel);
    if (!filePath.startsWith(realDist + path.sep) && filePath !== realDist) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(realDist, "index.html");
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  });
}

function createMockOpenAiServer() {
  return http.createServer(async (req, res) => {
    const reqUrl = req.url || "/";
    if (req.method === "GET" && reqUrl.endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        object: "list",
        data: [{ id: "qwen2.5:latest", object: "model", created: 1700000000, owned_by: "golden-fixture" }],
      }));
      return;
    }
    if (req.method === "POST" && reqUrl.endsWith("/chat/completions")) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const replyJson = JSON.stringify({
        kind: "reply",
        content: "Golden Flow 模型已就绪，你的姓名与简历亮点均已核对。",
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-golden-flow",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "qwen2.5:latest",
        choices: [{ index: 0, message: { role: "assistant", content: replyJson }, finish_reason: "stop" }],
        usage: { prompt_tokens: 18, completion_tokens: 24, total_tokens: 42 },
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

async function main() {
  const chromeExecutable = findChromeExecutable();
  if (!chromeExecutable) {
    if (process.env.CI === "true" || process.env.BETTERME_GOLDEN_REQUIRED === "1") {
      throw new Error("No Chrome/Chromium executable found in CI environment for Golden Flow E2E.");
    }
    console.log(JSON.stringify({ status: "skipped", reason: "No Chrome/Chromium executable found on host." }, null, 2));
    return;
  }
  assert.ok(fs.existsSync(path.join(webDistDir, "index.html")), "apps/web/dist/index.html must be built first (`pnpm --filter @better-me/web build`).");

  const tempDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "betterme-golden-e2e-")));
  const agentPort = await allocatePort();
  const gatewayPort = await allocatePort();
  const mockModelPort = await allocatePort();
  const origin = `http://127.0.0.1:${gatewayPort}`;
  const agentOrigin = `http://127.0.0.1:${agentPort}`;
  const mockModelBaseUrl = `http://127.0.0.1:${mockModelPort}/v1`;
  const token = "better-me-agent-token";

  const req = createRequire(path.join(agentHostDir, "package.json"));
  const tsxLoader = req.resolve("tsx");
  const agentCli = path.join(agentHostDir, "src", "cli.ts");
  const agentLogs = [];
  const agentChild = spawn(
    process.execPath,
    [
      "--import", tsxLoader, agentCli,
      "--host", "127.0.0.1",
      "--port", String(agentPort),
      "--origin", origin,
      "--token", token,
      "--checkpoint-dir", path.join(tempDir, "checkpoints"),
      "--runs-dir", path.join(tempDir, "runs"),
      "--sandbox", "disabled",
    ],
    {
      cwd: agentHostDir,
      env: { ...process.env, HOME: tempDir },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  agentChild.stdout.on("data", (d) => agentLogs.push(String(d)));
  agentChild.stderr.on("data", (d) => agentLogs.push(String(d)));

  const gateway = createStaticAndProxyGateway(webDistDir, agentOrigin);
  await new Promise((resolve, reject) => {
    gateway.once("error", reject);
    gateway.listen(gatewayPort, "127.0.0.1", resolve);
  });

  const mockModelServer = createMockOpenAiServer();
  await new Promise((resolve, reject) => {
    mockModelServer.once("error", reject);
    mockModelServer.listen(mockModelPort, "127.0.0.1", resolve);
  });

  let browser;
  const pageErrors = [];
  try {
    await waitForHealth(`${agentOrigin}/api/v1/agent/health`, token, origin);
    browser = await chromium.launch({ executablePath: chromeExecutable, headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const page = await context.newPage();
    await page.addInitScript(() => {
      const spoken = [];
      window.__goldenSpoken = spoken;
      Object.defineProperty(window, "speechSynthesis", {
        configurable: true,
        value: {
          getVoices: () => [{ lang: "zh-CN", localService: true }, { lang: "en-US", localService: true }],
          speak: (utterance) => {
            spoken.push(utterance.text);
            utterance.onstart?.();
            setTimeout(() => utterance.onend?.(), 10);
          },
          cancel: () => {},
        },
      });
      Object.defineProperty(window, "SpeechSynthesisUtterance", {
        configurable: true,
        value: class {
          constructor(text) {
            this.text = text;
          }
        },
      });
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));

    // Step 1: Open workspace and register an isolated local account
    await page.goto(`${origin}/?workspace=resume`, { waitUntil: "domcontentloaded" });
    await page.locator("button.login-mode-switch").click();
    await page.locator('input[name="displayName"]').fill("Golden Tester");
    await page.locator('input[name="username"]').fill("golden_tester");
    await page.locator('input[name="password"]').fill("GoldenFlowPass!2026");
    await page.locator('.identity-card button[type="submit"]').click();

    // Wait for boot overlay to appear & finish, then dismiss first-run tour if it opens
    await page.locator("#resume-editor-panel").waitFor({ state: "visible", timeout: 15_000 });
    await page.locator("#resume-preview-panel").waitFor({ state: "visible", timeout: 15_000 });
    await page.locator("section.workspace-boot").waitFor({ state: "detached", timeout: 15_000 }).catch(() => {});
    const guideDialog = page.locator("dialog.first-run-guide[open]");
    if (await guideDialog.waitFor({ state: "visible", timeout: 4_000 }).then(() => true).catch(() => false)) {
      await guideDialog.locator('button[aria-label="关闭并跳过引导"], button:has-text("跳过引导"), button:has-text("稍后再说")').first().click();
      await guideDialog.waitFor({ state: "detached", timeout: 5_000 }).catch(() => {});
    }

    // Step 2: Edit the resume Chinese name field specifically and verify preview + filename sync
    const profileTab = page.locator("#resume-editor-panel button", { hasText: /基本信息|基础信息|Profile|个人信息/ }).first();
    await profileTab.click();
    const nameField = page.locator('#resume-editor-panel label:has-text("中文姓名")').locator("..").locator("input, textarea").first();
    await nameField.fill("Lin Golden Flow");
    await page.waitForFunction(
      () => (document.querySelector("#resume-preview-panel")?.textContent ?? "").includes("Lin Golden Flow"),
      undefined,
      { timeout: 5_000 },
    );

    // Step 3: Trigger DOCX export cleanly via "更多导出格式" menu and capture real download
    await page.locator('#resume-preview-panel button[aria-label="更多导出格式"]').click();
    const downloadPromise = page.waitForEvent("download", { timeout: 10_000 });
    await page.locator('#resume-preview-panel button:has-text("下载 DOCX")').click();
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), /Lin Golden Flow.*\.docx$/i);

    // Step 4: Configure isolated synthetic local model & Agent source
    await page.locator('button[aria-label="打开系统设置"]').click();
    await page.locator('nav[aria-label="设置分类"] button:has-text("模型与推理")').click();
    await page.locator('button:has-text("模型与 AI 配置")').click();
    await page.locator('button:has-text("Ollama（本地服务）")').click();
    await page.locator("#ai-base-url").fill(mockModelBaseUrl);
    await page.locator('button:has-text("保存配置")').click();
    await page.locator('dialog.ai-config-modal button:has-text("选择 Agent 来源")').click();
    await page.locator("dialog.ai-config-modal").waitFor({ state: "detached", timeout: 5_000 }).catch(() => {});

    await page.locator('select[aria-label="统一 Agent 来源"]').selectOption("current");
    await page.locator(".os-settings-window .os-traffic button").first().click();

    // Step 5: Navigate to AI 顾问, submit a sample JD, enable auto-read, send a chat prompt, and verify reply + speech
    await page.locator('summary[aria-label="应用菜单"]').click();
    await page.locator('nav[aria-label="切换应用"] button:has-text("AI 顾问")').click();

    await page.locator('.cs-advisor-slot .advisor-job-options > summary').click();
    const jdTitle = page.locator('.cs-advisor-slot input[placeholder*="例如：资深前端工程师"]').first();
    await jdTitle.waitFor({ state: "visible", timeout: 10_000 });
    await jdTitle.fill("Senior Fullstack Engineer");
    const jdDesc = page.locator('.cs-advisor-slot textarea[placeholder*="请在此粘贴招聘 JD"]').first();
    await jdDesc.fill("1. Lead fullstack TypeScript, React, and Node.js systems.\n2. Own automated testing and performance tuning.");
    await page.locator('.cs-advisor-slot button:has-text("授权当前简历并开始拆解")').click();

    const toggle = page.locator('.cs-advisor-slot [data-testid="agent-auto-speech-toggle"]');
    await toggle.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await toggle.getAttribute("aria-pressed"), "false");
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-pressed"), "true");

    const chatInput = page.locator(".cs-advisor-slot textarea.agent-chat-textarea");
    await chatInput.fill("请用一句话评价我刚才保存的测试简历");
    await chatInput.press("Enter");

    await page.waitForFunction(
      () => (document.querySelector(".cs-advisor-slot")?.textContent ?? "").includes("Golden Flow 模型已就绪"),
      undefined,
      { timeout: 15_000 },
    );
    await page.waitForFunction(
      () => Array.isArray(window.__goldenSpoken) && window.__goldenSpoken.length >= 1,
      undefined,
      { timeout: 5_000 },
    );
    const spokenTexts = await page.evaluate(() => window.__goldenSpoken);
    assert.match(spokenTexts[0] ?? "", /Golden Flow 模型已就绪/);

    // Hidden workspaces must not keep polling private task summaries.
    const summaryPath = "/api/v1/agent/tasks/summary";
    let summaryRequests = 0;
    page.on("request", request => { if (new URL(request.url()).pathname === summaryPath) summaryRequests++; });
    const loadedSummary = page.waitForResponse(response => new URL(response.url()).pathname === summaryPath && response.ok());
    await page.locator('summary[aria-label="应用菜单"]').click();
    await page.locator('nav[aria-label="切换应用"] button:has-text("自动化工坊")').click();
    const summary = await (await loadedSummary).json();
    assert.ok(summary.totalTasks > 0 && summary.tasks.length <= 6);
    assert.doesNotMatch(JSON.stringify(summary), /Golden Flow 模型已就绪|Lead fullstack/);
    await page.locator('summary[aria-label="应用菜单"]').click();
    await page.locator('nav[aria-label="切换应用"] button:has-text("简历工作室")').click();
    await page.locator("#resume-editor-panel").waitFor({ state: "visible" });
    const seenWhileOpen = summaryRequests;
    await new Promise(resolve => setTimeout(resolve, 8_500));
    assert.equal(summaryRequests, seenWhileOpen, "Hidden Autopilot kept polling");

    assert.deepEqual(pageErrors, [], `Unexpected page errors: ${pageErrors.join("; ")}`);
    console.log(JSON.stringify({
      status: "passed",
      steps: [
        "local-auth-register",
        "fact-editor-live-preview-sync",
        "docx-export-download",
        "model-config-and-source-selection",
        "agent-jd-chat-and-auto-speech",
        "autopilot-reads-summary-only-while-open",
      ],
      downloadedFile: download.suggestedFilename(),
      spokenUtterances: spokenTexts.length,
      pageErrors: 0,
    }, null, 2));
  } catch (error) {
    console.error("Agent Host logs:\n" + agentLogs.join(""));
    throw error;
  } finally {
    await browser?.close().catch(() => {});
    mockModelServer.closeAllConnections?.();
    await new Promise((resolve) => mockModelServer.close(() => resolve()));
    gateway.closeAllConnections?.();
    await new Promise((resolve) => gateway.close(() => resolve()));
    agentChild.kill("SIGTERM");
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
