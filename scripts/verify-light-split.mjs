import { chromium } from "../apps/web/node_modules/playwright-core/index.mjs";
import fs from "node:fs";

async function main() {
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

  await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
  await page.waitForTimeout(500);

  // Switch to light theme
  const lightToggle = page.locator("button:has-text('浅色')").first();
  if (await lightToggle.isVisible()) {
    await lightToggle.click();
    await page.waitForTimeout(500);
  }

  // Navigate to AI Agent Workspace
  const agentNavBtn = page.locator("button:has-text('AI Agent 助手')").first();
  await agentNavBtn.click();
  await page.waitForTimeout(600);

  // Load sample JD & Submit
  const loadSampleBtn = page.locator("button:has-text('载入范例岗位 JD')").first();
  await loadSampleBtn.click();
  await page.waitForTimeout(400);

  const submitBtn = page.locator("button:has-text('开始智能拆解与匹配分析')").first();
  await submitBtn.click();
  await page.waitForTimeout(1200);

  // Split mode screenshot in light theme
  const lightSplitPath = "/Users/feng/.gemini/antigravity/brain/688efe34-71bf-4b5a-b98a-e6ebe121d112/agent-workspace-light-split-fixed.png";
  await page.screenshot({ path: lightSplitPath, fullPage: false });
  console.log("Saved Light Split screenshot to:", lightSplitPath);

  await browser.close();
}

main().catch(console.error);
