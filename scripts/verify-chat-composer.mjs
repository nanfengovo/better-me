import { chromium } from "../apps/web/node_modules/playwright-core/index.mjs";
import fs from "node:fs";
import { resolve } from "node:path";

const ARTIFACTS_DIR = "/Users/feng/.gemini/antigravity/brain/688efe34-71bf-4b5a-b98a-e6ebe121d112";

async function main() {
  console.log("Launching browser for chat composer verification...");
  const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const browser = await chromium.launch({
    executablePath: fs.existsSync(chromePath) ? chromePath : undefined,
    headless: true,
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: 2,
  });

  const page = await context.newPage();

  console.log("Navigating to http://localhost:5173/ ...");
  await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);

  // Ensure Light mode
  const lightBtn = page.locator('button:has-text("浅色")').first();
  if (await lightBtn.isVisible()) {
    await lightBtn.click();
    await page.waitForTimeout(400);
  }

  // Go to Agent Workspace
  console.log("Going to Agent Workspace...");
  const agentNavBtn = page.locator('button:has-text("AI Agent 助手")').first();
  await agentNavBtn.click();
  await page.waitForTimeout(1000);

  // Load sample JD if on setup screen
  const loadSampleBtn = page.locator('button:has-text("载入范例岗位 JD")').first();
  if (await loadSampleBtn.isVisible()) {
    await loadSampleBtn.click();
    await page.waitForTimeout(400);
    const submitBtn = page.locator('button:has-text("开始智能拆解与匹配分析")').first();
    await submitBtn.click();
    await page.waitForTimeout(1500);
  }

  // Ensure "助理对话" is active
  const copilotTab = page.locator('button:has-text("助理对话")').first();
  if (await copilotTab.isVisible()) {
    await copilotTab.click();
    await page.waitForTimeout(500);
  }

  // 1. Light Mode - Click and focus the composer
  console.log("1. Focusing chat composer in Light Mode...");
  const composerTextarea = page.locator('textarea[placeholder*="向 Copilot 提问"]').first();
  await composerTextarea.click();
  await page.waitForTimeout(300);

  await page.screenshot({
    path: resolve(ARTIFACTS_DIR, "chat-composer-light-focused.png"),
    fullPage: false,
  });
  console.log("Saved chat-composer-light-focused.png");

  // Type some text
  await composerTextarea.fill("请结合本岗位要求，帮我按 STAR 原则重点优化高并发状态机重构这篇工作经历");
  await page.waitForTimeout(400);

  await page.screenshot({
    path: resolve(ARTIFACTS_DIR, "chat-composer-light-typing.png"),
    fullPage: false,
  });
  console.log("Saved chat-composer-light-typing.png");

  // 2. Dark Mode verification
  console.log("2. Switching to Dark Mode...");
  const darkBtn = page.locator('button:has-text("深色")').first();
  if (await darkBtn.isVisible()) {
    await darkBtn.click();
    await page.waitForTimeout(600);

    await composerTextarea.click();
    await page.waitForTimeout(300);

    await page.screenshot({
      path: resolve(ARTIFACTS_DIR, "chat-composer-dark-focused.png"),
      fullPage: false,
    });
    console.log("Saved chat-composer-dark-focused.png");
  }

  await browser.close();
  console.log("Verification finished successfully!");
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
