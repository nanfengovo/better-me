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
  await page.waitForTimeout(1200);

  // If in active matched state, click "更换岗位 / 编辑 JD" or "编辑岗位" to enter setup view
  const editJdBtn = page.locator('button:has-text("更换岗位 / 编辑 JD"), button:has-text("编辑岗位")').first();
  if (await editJdBtn.isVisible()) {
    console.log("Entering Setup/Edit view...");
    await editJdBtn.click();
    await page.waitForTimeout(600);
  }

  // Verify that the dedicated Setup View is present via the link import button
  const linkImportBtn = page.locator('button:has-text("读取链接填入")').first();
  await linkImportBtn.waitFor({ state: "visible", timeout: 5000 });
  console.log("Found dedicated Setup View with '读取链接填入' button!");

  // Verify that there is NO squashed chat container in this view
  const chatInputInSetup = page.locator('input[placeholder*="向 Copilot 提问"]');
  const hasSquashedChat = await chatInputInSetup.isVisible();
  console.log(`Squashed chat visible during setup? ${hasSquashedChat} (Expected: false)`);
  if (hasSquashedChat) {
    throw new Error("Chat input should not be visible during setup mode!");
  }

  // Open link import panel
  await linkImportBtn.click();
  await page.waitForTimeout(400);

  // Save screenshot of Refined Setup View (Light Mode)
  const setupLightScreenshot = path.join(ARTIFACTS_DIR, "refined-setup-view-light.png");
  await page.screenshot({ path: setupLightScreenshot, fullPage: false });
  console.log(`Saved screenshot: ${setupLightScreenshot}`);

  // Load sample JD
  console.log("Loading sample JD...");
  const loadSampleBtn = page.locator('button:has-text("载入范例岗位 JD")');
  await loadSampleBtn.click();
  await page.waitForTimeout(400);

  // Click submit: "开始智能拆解与匹配分析" or "保存并重新分析"
  console.log("Starting smart breakdown and matching...");
  const submitBtn = page.locator('button:has-text("开始智能拆解与匹配分析"), button:has-text("保存并重新分析")').first();
  await submitBtn.click();

  // Wait for matching to complete and active view to render
  console.log("Waiting for active view to render...");
  await page.waitForTimeout(3000);

  const activeChatHeader = page.locator('text=助理协同对话 (Career Copilot)');
  await activeChatHeader.waitFor({ state: "visible", timeout: 10000 });
  console.log("Active mode Copilot chat rendered successfully!");

  // Save screenshot of Refined Active View (Light Mode)
  const activeLightScreenshot = path.join(ARTIFACTS_DIR, "refined-active-view-light.png");
  await page.screenshot({ path: activeLightScreenshot, fullPage: false });
  console.log(`Saved screenshot: ${activeLightScreenshot}`);

  // Switch to Dark mode by clicking the "深色" theme button
  console.log("Switching to Dark mode...");
  const darkThemeBtn = page.locator('button:has-text("深色")').first();
  if (await darkThemeBtn.isVisible()) {
    await darkThemeBtn.click();
    await page.waitForTimeout(600);
  }

  // Save screenshot of Refined Active View (Dark Mode)
  const activeDarkScreenshot = path.join(ARTIFACTS_DIR, "refined-active-view-dark.png");
  await page.screenshot({ path: activeDarkScreenshot, fullPage: false });
  console.log(`Saved screenshot: ${activeDarkScreenshot}`);

  // In dark mode, click "编辑岗位" to verify dark setup view
  console.log("Opening edit view in dark mode...");
  const darkEditBtn = page.locator('button:has-text("更换岗位 / 编辑 JD"), button:has-text("编辑岗位")').first();
  if (await darkEditBtn.isVisible()) {
    await darkEditBtn.click();
    await page.waitForTimeout(600);
  }

  // Save screenshot of Refined Setup View (Dark Mode)
  const setupDarkScreenshot = path.join(ARTIFACTS_DIR, "refined-setup-view-dark.png");
  await page.screenshot({ path: setupDarkScreenshot, fullPage: false });
  console.log(`Saved screenshot: ${setupDarkScreenshot}`);

  await browser.close();
  console.log("All visual verifications passed successfully!");
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
