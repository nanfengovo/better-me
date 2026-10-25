import { chromium } from "../apps/web/node_modules/playwright-core/index.mjs";
import fs from "node:fs";
import path from "node:path";

const ARTIFACTS_DIR = "/Users/feng/.gemini/antigravity/brain/688efe34-71bf-4b5a-b98a-e6ebe121d112";

async function main() {
  const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const browser = await chromium.launch({
    executablePath: fs.existsSync(chromePath) ? chromePath : undefined,
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  console.log("Navigating to http://localhost:5173 ...");
  await page.goto("http://localhost:5173", { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);

  // Switch to Agent workspace
  console.log("Switching to Agent Workspace...");
  const agentNavBtn = page.locator('button[aria-label*="AI 顾问工作台"], button:has-text("AI Agent 助手"), button:has-text("顾问")').first();
  await agentNavBtn.click();
  await page.waitForTimeout(1000);

  // If in active matched state, click "更换岗位 / 编辑 JD" or "编辑岗位" to enter setup view
  const editJdBtn = page.locator('button:has-text("更换岗位 / 编辑 JD"), button:has-text("编辑岗位")').first();
  if (await editJdBtn.isVisible()) {
    console.log("Entering Setup/Edit view to capture newly refined Setup View...");
    await editJdBtn.click();
    await page.waitForTimeout(600);
  }

  // Ensure graphite theme and dark mode
  const themeSelect = page.locator('.workspace-theme-picker select, select:has(option:has-text("石墨工坊"))').first();
  if (await themeSelect.isVisible()) {
    await themeSelect.selectOption("graphite");
    await page.waitForTimeout(400);
  }
  const darkThemeBtn = page.locator('button:has-text("深色")').first();
  if (await darkThemeBtn.isVisible()) {
    await darkThemeBtn.click();
    await page.waitForTimeout(600);
  }

  // 1. Capture Refined Setup View (Dark Mode) - This directly replaces Image 1!
  const setupDarkShot = path.join(ARTIFACTS_DIR, "agent-workspace-setup-dark.png");
  await page.screenshot({ path: setupDarkShot, fullPage: false });
  console.log(`Saved screenshot: ${setupDarkShot}`);

  // Test clicking one of the sample cards on the right side
  const sampleCard = page.locator('div:has-text("资深前端/全栈架构师")').last();
  if (await sampleCard.isVisible()) {
    console.log("Clicking quick sample card on right pane...");
    await sampleCard.click();
    await page.waitForTimeout(500);
  }

  // 2. Capture Setup View after clicking sample card
  const setupPopulatedShot = path.join(ARTIFACTS_DIR, "agent-workspace-setup-populated.png");
  await page.screenshot({ path: setupPopulatedShot, fullPage: false });
  console.log(`Saved screenshot: ${setupPopulatedShot}`);

  // 3. Submit and enter Active View
  const submitBtn = page.locator('button:has-text("开始智能拆解与匹配分析"), button:has-text("保存并重新分析")').first();
  if (await submitBtn.isVisible()) {
    console.log("Submitting JD to enter Active View...");
    await submitBtn.click();
    await page.waitForTimeout(3000);
  }

  // 4. Capture Active View (Dark Mode)
  const activeDarkShot = path.join(ARTIFACTS_DIR, "agent-workspace-active-dark.png");
  await page.screenshot({ path: activeDarkShot, fullPage: false });
  console.log(`Saved screenshot: ${activeDarkShot}`);

  await browser.close();
  console.log("All screenshots captured successfully!");
}

main().catch((err) => {
  console.error("Error in verification script:", err);
  process.exit(1);
});
