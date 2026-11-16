import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve("playwright-core", { paths: ["./apps/web"] }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const outDir = path.resolve(process.env.SHOWCASE_OUT_DIR || path.join(rootDir, "docs/media/showcase-20261116"));
const tempDir = path.resolve(process.env.SHOWCASE_TMP_DIR || path.join(rootDir, "tmp/showcase-capture"));

fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(tempDir, { recursive: true });

function findChromeExecutable() {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  for (const candidate of [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  try {
    const pwPath = chromium.executablePath();
    if (pwPath && fs.existsSync(pwPath)) return pwPath;
  } catch {
    // ignore
  }
  return undefined;
}

const TARGET_URL = process.env.TARGET_URL || "http://localhost:5173/";
const VIEWPORT = { width: 1440, height: 900 };

async function installPointerRing(page) {
  await page.evaluate(() => {
    if (document.getElementById("__showcase_pointer")) return;
    const ring = document.createElement("div");
    ring.id = "__showcase_pointer";
    Object.assign(ring.style, {
      position: "fixed",
      left: "-100px",
      top: "-100px",
      width: "22px",
      height: "22px",
      marginLeft: "-11px",
      marginTop: "-11px",
      borderRadius: "999px",
      border: "2.5px solid rgba(56, 189, 248, 0.95)",
      backgroundColor: "rgba(56, 189, 248, 0.18)",
      boxShadow: "0 0 0 4px rgba(15, 23, 42, 0.28), 0 4px 12px rgba(0, 0, 0, 0.35)",
      pointerEvents: "none",
      zIndex: "2147483647",
      transition: "transform 110ms ease-out, left 60ms linear, top 60ms linear",
      opacity: "0",
    });
    document.body.appendChild(ring);
    window.__moveShowcasePointer = (x, y, pulse = false) => {
      ring.style.opacity = "1";
      ring.style.left = `${x}px`;
      ring.style.top = `${y}px`;
      ring.style.transform = pulse ? "scale(0.76)" : "scale(1)";
    };
    window.__hideShowcasePointer = () => {
      ring.style.opacity = "0";
    };
  });
}

async function takeCleanScreenshot(page, fileName, manifest) {
  await page.evaluate(() => window.__hideShowcasePointer?.());
  await page.waitForTimeout(80);
  await page.screenshot({ path: path.join(outDir, fileName) });
  manifest.screenshots.push(fileName);
  console.log(`Captured ${fileName}`);
}

async function smoothClick(page, locatorOrSelector, options = {}) {
  const loc = typeof locatorOrSelector === "string" ? page.locator(locatorOrSelector).first() : locatorOrSelector.first();
  if (!(await loc.isVisible().catch(() => false))) return false;
  const box = await loc.boundingBox();
  if (!box) return false;
  const cx = Math.round(box.x + box.width * 0.5);
  const cy = Math.round(box.y + box.height * 0.5);
  await page.evaluate(({ x, y }) => window.__moveShowcasePointer?.(x, y, false), { x: cx, y: cy });
  await page.mouse.move(cx, cy, { steps: options.steps ?? 9 });
  await page.waitForTimeout(options.hoverPause ?? 100);
  await page.evaluate(({ x, y }) => window.__moveShowcasePointer?.(x, y, true), { x: cx, y: cy });
  await page.mouse.down();
  await page.waitForTimeout(45);
  await page.mouse.up();
  await page.waitForTimeout(90);
  await page.evaluate(({ x, y }) => window.__moveShowcasePointer?.(x, y, false), { x: cx, y: cy });
  return true;
}

async function dismissFirstRunTourIfPresent(page) {
  for (let i = 0; i < 6; i++) {
    const skipBtn = page.locator("dialog[open] button:has-text('跳过引导'), dialog[open] button:has-text('稍后再说'), dialog[open] button[aria-label*='跳过']").first();
    if (await skipBtn.isVisible().catch(() => false)) {
      await skipBtn.click();
      await page.waitForTimeout(250);
      return true;
    }
    await page.waitForTimeout(150);
  }
  return false;
}

async function ensureAgentSidebarOpen(page, wantOpen) {
  const trigger = page.locator("button.studio-writing-trigger").first();
  if (await trigger.isVisible().catch(() => false)) {
    const expanded = await trigger.getAttribute("aria-expanded");
    if (wantOpen && expanded !== "true") {
      await trigger.click();
      await page.waitForTimeout(550);
      return true;
    }
    if (!wantOpen && expanded === "true") {
      await trigger.click();
      await page.waitForTimeout(450);
      return true;
    }
  }
  return false;
}

async function navigateViaAppMenu(page, labelMatch, animated = false) {
  const summary = page.locator(".os-app-menu summary").first();
  if (animated) {
    await smoothClick(page, summary);
    await page.waitForTimeout(150);
    await smoothClick(page, page.locator(`.os-app-menu nav button:has-text("${labelMatch}")`).first());
  } else {
    await summary.click();
    await page.waitForTimeout(130);
    await page.locator(`.os-app-menu nav button:has-text("${labelMatch}")`).first().click();
  }
  await page.waitForTimeout(550);
}

async function fillSyntheticPersona(page) {
  const profileTab = page.locator('#resume-editor-panel button:has-text("个人信息")').first();
  if (!(await profileTab.isVisible().catch(() => false))) return;
  await profileTab.click();
  await page.waitForTimeout(250);

  const nameField = page.locator('[data-editor-anchor="profile:displayName"] textarea, [data-editor-anchor="profile:displayName"] input').first();
  if (await nameField.isVisible().catch(() => false)) {
    await nameField.fill("林致远（示例）");
  }

  const emailField = page.locator('#resume-editor-panel input[value*="example.com"]').first();
  if (await emailField.isVisible().catch(() => false)) {
    await emailField.fill("zhiyuan.lin@example.test");
  }

  await page.waitForTimeout(180);
  const expTab = page.locator('#resume-editor-panel button:has-text("经历与成果")').first();
  if (await expTab.isVisible().catch(() => false)) await expTab.click();
  await page.waitForTimeout(250);
}

async function seedSyntheticOpportunities(page) {
  const saveBtn = page.locator('.opportunity-actions button:has-text("收藏岗位")').first();
  if (!(await saveBtn.isVisible().catch(() => false))) return;

  const samples = [
    {
      company: "星汉智能科技（示例）",
      title: "高级分布式系统架构师",
      platform: "BOSS直聘",
      city: "上海 · 张江科学城",
      salary: "35-55K · 16薪",
      desc: "负责智能调度中台与高可用事件总线架构演进，主导千万级并发通信链路优化、服务治理与跨集群容灾。",
    },
    {
      company: "云起智算平台（示例）",
      title: "AI Infra / 推理引擎工程师",
      platform: "猎聘",
      city: "北京 / 上海",
      salary: "40-65K · 15薪",
      desc: "负责多模型推理路由、异构算力调度与分布式缓存加速，要求熟悉 Kubernetes、Go / C# / TypeScript 与高并发系统调优。",
    },
    {
      company: "明曦数据工坊（示例）",
      title: "资深全栈研发工程师",
      platform: "官方招聘页",
      city: "杭州 · 余杭区",
      salary: "30-45K · 15薪",
      desc: "主导本地优先桌面应用与实时协作工作台研发，构建高性能 WebGL 数据可视化视图及端云混合存储同步。",
    },
  ];

  for (const job of samples) {
    await page.locator('.opportunity-actions button:has-text("收藏岗位")').first().click();
    await page.waitForSelector(".opportunity-form", { timeout: 6000 });
    await page.locator('.opportunity-form label:has-text("公司名称") input').fill(job.company);
    await page.locator('.opportunity-form label:has-text("岗位名称") input').fill(job.title);
    await page.locator('.opportunity-form label:has-text("来源平台") input').fill(job.platform);
    await page.locator('.opportunity-form label:has-text("工作城市") input').fill(job.city);
    await page.locator('.opportunity-form label:has-text("薪资原文") input').fill(job.salary);
    await page.locator('.opportunity-form textarea').fill(job.desc);
    await page.locator('.opportunity-form button[type="submit"]').click();
    await page.waitForTimeout(260);
    const closeDialog = page.locator('.opportunity-dialog-header button[aria-label*="关闭"]').first();
    if (await closeDialog.isVisible().catch(() => false)) {
      await closeDialog.click();
      await page.waitForTimeout(200);
    }
  }
}

async function waitForAtlasLoaded(page, maxWaitMs = 5500) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const banner = await page.locator(".atlas-banner, [role='status']").filter({ hasText: "正在分页加载" }).first().isVisible().catch(() => false);
    if (!banner && Date.now() - start > 1800) break;
    await page.waitForTimeout(450);
  }
}

async function main() {
  const execPath = findChromeExecutable();
  if (!execPath) throw new Error("Google Chrome / Chromium executable not found.");
  console.log(`Using browser binary: ${execPath}`);

  const videoTempDir = path.join(tempDir, "video");
  fs.rmSync(videoTempDir, { recursive: true, force: true });
  fs.mkdirSync(videoTempDir, { recursive: true });

  const browser = await chromium.launch({
    executablePath: execPath,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--use-gl=angle",
      "--use-angle=swiftshader-webgl",
      "--enable-unsafe-swiftshader",
    ],
  });

  const consoleErrors = [];
  const manifest = { capturedAt: new Date().toISOString(), targetUrl: TARGET_URL, screenshots: [], clips: {} };

  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    colorScheme: "dark",
    locale: "zh-CN",
    geolocation: { latitude: 31.2047, longitude: 121.5878, accuracy: 24 },
    permissions: ["geolocation"],
    recordVideo: {
      dir: videoTempDir,
      size: { width: 960, height: 600 },
    },
  });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("betterme:onboarding:v1", JSON.stringify({ version: 1, state: "completed" }));
    } catch {
      // ignore
    }
  });

  const page = await ctx.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    consoleErrors.push(`pageerror: ${err.message}`);
  });

  console.log(`Opening ${TARGET_URL}...`);
  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector(".identity-screen, .os-desktop", { timeout: 30000 });
  await page.waitForTimeout(800);

  if (await page.locator(".identity-screen").isVisible().catch(() => false)) {
    await takeCleanScreenshot(page, "01-login-showcase.png", manifest);

    const modeBtn = page.locator("button.login-mode-switch").first();
    if (await modeBtn.isVisible().catch(() => false)) {
      const txt = await modeBtn.innerText();
      if (txt.includes("创建本机账号") || txt.includes("首次使用")) await modeBtn.click();
    }
    const uid = `showcase_${Date.now().toString(36)}`;
    if (await page.locator('input[name="displayName"]').isVisible().catch(() => false)) {
      await page.fill('input[name="displayName"]', "林致远");
    }
    await page.fill('input[name="username"]', uid);
    await page.fill('input[name="password"]', "ShowcasePass!2026");
    await page.click('button[type="submit"]');

    for (let i = 0; i < 14; i++) {
      await page.waitForTimeout(300);
      const skipBoot = page.locator(".workspace-boot button").first();
      if (await skipBoot.isVisible().catch(() => false)) await skipBoot.click().catch(() => {});
      if (await page.locator(".os-stage").isVisible().catch(() => false)) break;
    }
  }

  await page.waitForSelector(".studio-document-bar", { timeout: 30000 });
  await dismissFirstRunTourIfPresent(page);
  await page.waitForTimeout(500);
  await fillSyntheticPersona(page);
  await installPointerRing(page);

  // =========================================================================
  // Segment 1: Resume Studio -> Design Gallery -> Writing Copilot + GIF 1
  // =========================================================================
  await takeCleanScreenshot(page, "02-resume-studio.png", manifest);
  {
    const dir = path.join(tempDir, "clip-resume-copilot");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    let frame = 0;
    const snap = async (count = 4, delay = 105) => {
      for (let i = 0; i < count; i++) {
        await page.screenshot({ path: path.join(dir, `frame_${String(frame++).padStart(4, "0")}.jpg`), type: "jpeg", quality: 88 });
        await page.waitForTimeout(delay);
      }
    };
    await snap(5, 110);
    await smoothClick(page, '.studio-mode-switch button:has-text("设计")');
    await snap(6, 115);
    await takeCleanScreenshot(page, "04-resume-design.png", manifest);
    await snap(3, 110);

    await smoothClick(page, '.studio-mode-switch button:has-text("内容")');
    await snap(4, 105);
    await smoothClick(page, "button.studio-writing-trigger");
    await snap(6, 115);
    const refine = page.locator('button:has-text("一起完善这条经历")').first();
    if (await refine.isVisible().catch(() => false)) {
      await smoothClick(page, refine);
      await snap(6, 115);
    }
    await takeCleanScreenshot(page, "03-writing-copilot.png", manifest);
    await snap(4, 105);
    await ensureAgentSidebarOpen(page, false);
    manifest.clips["clip-resume-copilot"] = frame;
  }

  // =========================================================================
  // Segment 2: Opportunities -> AI Advisor -> Career Studio -> Autopilot + GIF 2
  // =========================================================================
  await navigateViaAppMenu(page, "岗位与投递", true);
  await page.waitForTimeout(500);
  await seedSyntheticOpportunities(page);
  await page.waitForTimeout(450);
  await takeCleanScreenshot(page, "09-opportunities.png", manifest);

  {
    const dir = path.join(tempDir, "clip-agent-autopilot");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    let frame = 0;
    const snap = async (count = 4, delay = 110) => {
      for (let i = 0; i < count; i++) {
        await page.screenshot({ path: path.join(dir, `frame_${String(frame++).padStart(4, "0")}.jpg`), type: "jpeg", quality: 88 });
        await page.waitForTimeout(delay);
      }
    };
    await snap(6, 115);

    await navigateViaAppMenu(page, "AI 顾问", true);
    const sampleBtn = page.locator('button:has-text("后端 / 云原生")').first();
    if (await sampleBtn.isVisible().catch(() => false)) {
      await smoothClick(page, sampleBtn);
      await page.waitForTimeout(500);
    }
    await takeCleanScreenshot(page, "07-ai-advisor.png", manifest);
    await snap(7, 115);

    await smoothClick(page, 'nav.advisor-tasks button:has-text("演练与证据")');
    await page.waitForSelector('[data-testid="career-studio"] .cs-setup, [data-testid="career-studio"] .cs-tabs', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(500);
    await takeCleanScreenshot(page, "08-career-studio.png", manifest);
    await snap(7, 115);

    await navigateViaAppMenu(page, "自动化工坊", true);
    await page.waitForTimeout(650);
    await page.mouse.move(720, 898, { steps: 10 });
    await page.waitForTimeout(400);
    await takeCleanScreenshot(page, "10-autopilot-studio.png", manifest);
    await snap(8, 120);
    manifest.clips["clip-agent-autopilot"] = frame;

    // Switch into Sleek Dark Theme before entering 3D Job Atlas Command Center!
    const moonBtn = page.locator("button:has(svg.lucide-moon)").first();
    if (await moonBtn.isVisible().catch(() => false)) {
      await smoothClick(page, moonBtn);
      await page.waitForTimeout(350);
    }
  }

  // =========================================================================
  // Segment 3: Job Atlas 3D (Global Globe -> Offline Fast Dark Radar -> Locate -> Nearby Radar) + GIF 3
  // =========================================================================
  await navigateViaAppMenu(page, "岗位地图", true);
  await page.waitForSelector('.maplibregl-canvas', { timeout: 25000 });
  await waitForAtlasLoaded(page, 6000);
  // Switch basemap to Local Offline Vector Boundaries so 3D map loads in <200ms without flaky OpenFreeMap PBF waits!
  const filterSettingsBtn = page.locator('button:has-text("筛选与设置")').first();
  if (await filterSettingsBtn.isVisible().catch(() => false)) {
    await filterSettingsBtn.click();
    await page.waitForTimeout(350);
    const mapConnBtn = page.locator('.atlas-top-actions summary').first();
    if (await mapConnBtn.isVisible().catch(() => false)) {
      await mapConnBtn.click();
      await page.waitForTimeout(200);
      const mapServiceBtn = page.locator('button:has-text("地图服务")').first();
      if (await mapServiceBtn.isVisible().catch(() => false)) {
        await mapServiceBtn.click();
        await page.waitForTimeout(250);
        const basemapSelect = page.locator(".atlas-basemap-select select").first();
        if (await basemapSelect.isVisible().catch(() => false)) {
          await basemapSelect.selectOption("offline");
          await page.waitForTimeout(300);
        }
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(200);
      }
    }
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(400);
  }
  await page.waitForSelector('.maplibregl-canvas', { timeout: 15000 });
  await page.waitForTimeout(1200);
  {
    const dir = path.join(tempDir, "clip-atlas-3d");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    let frame = 0;
    const snap = async (count = 5, delay = 115) => {
      for (let i = 0; i < count; i++) {
        await page.screenshot({ path: path.join(dir, `frame_${String(frame++).padStart(4, "0")}.jpg`), type: "jpeg", quality: 88 });
        await page.waitForTimeout(delay);
      }
    };

    // Start in Global 3D Dark Radar Globe!
    await snap(6, 115);

    // Fly into Domestic 3D Clusters in Dark Mode
    await smoothClick(page, '.atlas-mode-switch button:has-text("国内")');
    await page.waitForSelector('.maplibregl-canvas', { timeout: 20000 });
    await page.waitForTimeout(1400);
    await snap(6, 115);
    await takeCleanScreenshot(page, "05-atlas-panorama.png", manifest);
    await snap(4, 115);

    await smoothClick(page, ".atlas-map-geolocate-btn");
    await snap(14, 130);
    await page.waitForTimeout(2400);

    // Zoom cleanly to 城市 (z10.5) so Yangtze coastline, indexed pins, my street fix & 39 nearby pins shine!
    await smoothClick(page, 'button:has-text("城市")');
    await page.waitForTimeout(1100);
    await snap(8, 120);

    const cardBtn = page.locator(".atlas-nearby-card button").first();
    if (await cardBtn.isVisible().catch(() => false)) {
      await smoothClick(page, cardBtn);
      await page.waitForTimeout(900);
      // Step back to ~z11.5 regional radar overview so nearby pins & coastline frame cleanly around selected company card
      await smoothClick(page, 'button:has-text("城市")');
      await page.waitForTimeout(1000);
    }
    await takeCleanScreenshot(page, "06-atlas-3d-nearby-radar.png", manifest);
    await snap(10, 120);

    const mapBox = await page.locator(".maplibregl-canvas").first().boundingBox();
    if (mapBox) {
      const mx = Math.round(mapBox.x + mapBox.width * 0.52);
      const my = Math.round(mapBox.y + mapBox.height * 0.48);
      await page.mouse.move(mx, my);
      await page.mouse.down();
      for (let s = 1; s <= 6; s++) {
        await page.mouse.move(mx - s * 16, my - s * 8);
        await page.evaluate(({ x, y }) => window.__moveShowcasePointer?.(x, y, true), { x: mx - s * 16, y: my - s * 8 });
        await snap(1, 75);
      }
      await page.mouse.up();
      await snap(6, 120);
    }
    manifest.clips["clip-atlas-3d"] = frame;
  }

  const video = page.video();
  await ctx.close();

  if (video) {
    const rawVideoPath = await video.path();
    const targetVideoPath = path.join(outDir, "betterme-walkthrough-20261116.webm");
    fs.copyFileSync(rawVideoPath, targetVideoPath);
    manifest.video = {
      file: "betterme-walkthrough-20261116.webm",
      bytes: fs.statSync(targetVideoPath).size,
    };
    console.log(`Saved walkthrough video: ${targetVideoPath} (${(manifest.video.bytes / 1048576).toFixed(2)} MB)`);
  }

  manifest.consoleErrorCount = consoleErrors.length;
  manifest.consoleErrors = consoleErrors.slice(0, 10);
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log("Capture complete:", JSON.stringify({ screenshots: manifest.screenshots.length, clips: manifest.clips, video: manifest.video, consoleErrorCount: consoleErrors.length }));

  await browser.close();
}

main().catch((err) => {
  console.error("Showcase capture failed:", err);
  process.exit(1);
});
