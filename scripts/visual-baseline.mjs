import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve("playwright-core", { paths: ["./apps/web"] }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const outputDir = path.join(rootDir, "output", "visual-baselines");

fs.mkdirSync(outputDir, { recursive: true });

function findChromeExecutable() {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) {
    return process.env.CHROME_BIN;
  }
  const macCandidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  for (const c of macCandidates) {
    if (fs.existsSync(c)) return c;
  }
  try {
    const pwPath = chromium.executablePath();
    if (pwPath && fs.existsSync(pwPath)) return pwPath;
  } catch {}
  return undefined;
}

const execPath = findChromeExecutable();
if (!execPath) {
  console.error("No valid Chrome executable found on system. Please install Google Chrome or run npx playwright install.");
  process.exit(1);
}
console.log(`Using Chrome binary: ${execPath}`);

const targetUrl = process.env.TARGET_URL || "http://localhost:5173/";

async function main() {
  console.log(`Starting visual baseline capture against ${targetUrl}...`);

  const browser = await chromium.launch({
    executablePath: execPath,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu-shader-disk-cache"],
  });

  const captures = [];

  try {
    // 1. Login Desktop 1440x900 Dark
    {
      console.log("Capturing 1: Login Desktop (1440x900, dark)...");
      const ctx = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        colorScheme: "dark",
      });
      const page = await ctx.newPage();
      await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 15000 });
      const imgPath = path.join(outputDir, "01-login-desktop-1440x900-dark.png");
      await page.screenshot({ path: imgPath });
      captures.push({
        id: "01-login-desktop",
        title: "登录页 - 桌面大屏 (1440x900 Dark)",
        file: "01-login-desktop-1440x900-dark.png",
        viewport: "1440x900",
        theme: "dark",
      });
      await ctx.close();
    }

    // 2. Login Compact 840x826 Dark (The specific size that was failing)
    {
      console.log("Capturing 2: Login Compact (840x826, dark)...");
      const ctx = await browser.newContext({
        viewport: { width: 840, height: 826 },
        colorScheme: "dark",
      });
      const page = await ctx.newPage();
      await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 15000 });
      const imgPath = path.join(outputDir, "02-login-compact-840x826-dark.png");
      await page.screenshot({ path: imgPath });
      captures.push({
        id: "02-login-compact",
        title: "登录页 - 紧凑尺寸 (840x826 Dark)",
        file: "02-login-compact-840x826-dark.png",
        viewport: "840x826",
        theme: "dark",
      });
      await ctx.close();
    }

    // 3. Login Mobile 390x844 Light
    {
      console.log("Capturing 3: Login Mobile (390x844, light)...");
      const ctx = await browser.newContext({
        viewport: { width: 390, height: 844 },
        colorScheme: "light",
      });
      const page = await ctx.newPage();
      await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 15000 });
      const imgPath = path.join(outputDir, "03-login-mobile-390x844-light.png");
      await page.screenshot({ path: imgPath });
      captures.push({
        id: "03-login-mobile",
        title: "登录页 - 移动端窄屏 (390x844 Light)",
        file: "03-login-mobile-390x844-light.png",
        viewport: "390x844",
        theme: "light",
      });
      await ctx.close();
    }

    // 4. Authenticated Workspace Desktop (1440x900)
    {
      console.log("Capturing 4: Authenticated Workspace (1440x900)...");
      const ctx = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        colorScheme: "dark",
      });
      const page = await ctx.newPage();
      await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 15000 });

      // Register / Sign-in synthetic test user
      const switchBtn = await page.$("button.login-mode-switch");
      if (switchBtn) {
        const text = await switchBtn.innerText();
        if (text.includes("首次使用") || text.includes("创建本机账号")) {
          await switchBtn.click();
          await page.waitForTimeout(300);
        }
      }

      const testUser = "verifier_" + Math.random().toString(36).slice(2, 8);
      if (await page.$("input[name=\"displayName\"]")) {
        await page.fill("input[name=\"displayName\"]", "Baseline Verifier");
      }
      await page.fill("input[name=\"username\"]", testUser);
      await page.fill("input[name=\"password\"]", "Password123456!");
      await page.click("button[type=\"submit\"]");

      // Handle WorkspaceBoot splash
      for (let i = 0; i < 10; i++) {
        await page.waitForTimeout(500);
        const bootBtn = await page.$(".workspace-boot button");
        if (bootBtn) {
          await bootBtn.click();
          await page.waitForTimeout(300);
          break;
        }
        if (await page.$(".desktop-shell")) break;
      }

      await page.waitForTimeout(1000);
      const imgPath = path.join(outputDir, "04-workspace-desktop-1440x900.png");
      await page.screenshot({ path: imgPath });
      captures.push({
        id: "04-workspace-desktop",
        title: "工作台主界面 - 桌面大屏 (1440x900)",
        file: "04-workspace-desktop-1440x900.png",
        viewport: "1440x900",
        theme: "dark",
      });

      // 5. Switch to Atlas Map inside same session
      console.log("Capturing 5: Atlas Map View (1440x900)...");
      await page.evaluate(() => {
        const btn = document.querySelector('button[data-onboarding="atlas"]') ||
                    document.querySelector('.os-menu-shortcuts button');
        if (btn) btn.click();
      });
      await page.waitForTimeout(2000);
      const atlasImgPath = path.join(outputDir, "05-workspace-atlas-map.png");
      await page.screenshot({ path: atlasImgPath });
      captures.push({
        id: "05-workspace-atlas",
        title: "工作台 - 岗位地图界面 (1440x900)",
        file: "05-workspace-atlas-map.png",
        viewport: "1440x900",
        theme: "dark",
      });

      await ctx.close();
    }

    // 6. Authenticated Workspace Compact 840x826
    {
      console.log("Capturing 6: Authenticated Workspace Compact (840x826)...");
      const ctx = await browser.newContext({
        viewport: { width: 840, height: 826 },
        colorScheme: "dark",
      });
      const page = await ctx.newPage();
      await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 15000 });

      const switchBtn = await page.$("button.login-mode-switch");
      if (switchBtn) {
        const text = await switchBtn.innerText();
        if (text.includes("首次使用") || text.includes("创建本机账号")) {
          await switchBtn.click();
          await page.waitForTimeout(300);
        }
      }

      const testUser = "verifier_" + Math.random().toString(36).slice(2, 8);
      if (await page.$("input[name=\"displayName\"]")) {
        await page.fill("input[name=\"displayName\"]", "Baseline Verifier");
      }
      await page.fill("input[name=\"username\"]", testUser);
      await page.fill("input[name=\"password\"]", "Password123456!");
      await page.click("button[type=\"submit\"]");

      for (let i = 0; i < 10; i++) {
        await page.waitForTimeout(500);
        const bootBtn = await page.$(".workspace-boot button");
        if (bootBtn) {
          await bootBtn.click();
          await page.waitForTimeout(300);
          break;
        }
        if (await page.$(".desktop-shell")) break;
      }

      await page.waitForTimeout(1000);
      const imgPath = path.join(outputDir, "06-workspace-compact-840x826.png");
      await page.screenshot({ path: imgPath });
      captures.push({
        id: "06-workspace-compact",
        title: "工作台主界面 - 紧凑尺寸 (840x826)",
        file: "06-workspace-compact-840x826.png",
        viewport: "840x826",
        theme: "dark",
      });

      await ctx.close();
    }

    // Generate HTML report
    const htmlReport = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>BetterMe 自动化视觉验收基准报告</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 24px; }
    h1 { font-size: 24px; margin-bottom: 8px; color: #38bdf8; }
    .meta { font-size: 13px; color: #94a3b8; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(480px, 1fr)); gap: 24px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; }
    .card-header { padding: 12px 16px; border-bottom: 1px solid #334155; display: flex; justify-content: space-between; align-items: center; }
    .card-title { font-weight: 600; font-size: 15px; }
    .card-badge { font-size: 12px; background: #0369a1; color: #e0f2fe; padding: 2px 8px; border-radius: 9999px; }
    .card-img { width: 100%; height: auto; display: block; background: #000; border-bottom: 1px solid #334155; }
    .card-footer { padding: 8px 16px; font-size: 12px; color: #64748b; }
  </style>
</head>
<body>
  <h1>BetterMe 自动化视觉验收基准报告</h1>
  <div class="meta">
    生成时间: ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} ·
    运行环境: Headless Chrome (${execPath}) ·
    状态: 全部 ${captures.length} 项捕获成功
  </div>
  <div class="grid">
    ${captures.map(c => `
      <div class="card">
        <div class="card-header">
          <span class="card-title">${c.title}</span>
          <span class="card-badge">${c.viewport}</span>
        </div>
        <img class="card-img" src="./${c.file}" alt="${c.title}" />
        <div class="card-footer">文件: ${c.file} · 主题: ${c.theme}</div>
      </div>
    `).join("")}
  </div>
</body>
</html>`;

    fs.writeFileSync(path.join(outputDir, "index.html"), htmlReport, "utf-8");
    console.log(`\nVisual baseline completed successfully! Report generated at: ${path.join(outputDir, "index.html")}`);
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error("Visual baseline execution failed:", err);
  process.exit(1);
});
