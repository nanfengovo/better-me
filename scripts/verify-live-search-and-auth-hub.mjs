import { chromium } from "../apps/web/node_modules/playwright-core/index.mjs";
import fs from "node:fs";

async function main() {
  console.log("Launching browser for verification...");
  const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const browser = await chromium.launch({
    executablePath: fs.existsSync(chromePath) ? chromePath : undefined,
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });
  const page = await context.newPage();

  console.log("Navigating to http://localhost:5173/?workspace=atlas...");
  await page.goto("http://localhost:5173/?workspace=atlas", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  // Switch to domestic mode
  const domesticBtn = page.locator(".atlas-mode-switch button:has-text('国内')");
  if (await domesticBtn.isVisible()) {
    console.log("Switching to Domestic mode...");
    await domesticBtn.click();
    await page.waitForTimeout(1000);
  }

  // Open Platform Auth Hub modal
  console.log("Opening Platform Auth Hub modal...");
  const authBtn = page.locator(".atlas-auth-hub-trigger");
  await authBtn.click();
  await page.waitForTimeout(1500);

  // Take screenshot of Platform Auth Hub - Tab 1 (独立接管窗口)
  const modalScreenshot1 = "/Users/feng/.gemini/antigravity/brain/1c53dd12-c792-4c43-987e-d0f16f35a0f6/platform-auth-hub-modal.png";
  await page.screenshot({ path: modalScreenshot1 });
  console.log(`Saved Tab 1 screenshot to ${modalScreenshot1}`);

  // Switch to Tab 2: 日常浏览器 Cookie 桥接
  console.log("Switching to Cookie Bridge tab...");
  const bridgeTabBtn = page.locator(".platform-tab-btn:has-text('Cookie 桥接')");
  await bridgeTabBtn.click();
  await page.waitForTimeout(1000);

  // Take screenshot of Platform Auth Hub - Tab 2 (Cookie 桥接)
  const modalScreenshot2 = "/Users/feng/.gemini/antigravity/brain/1c53dd12-c792-4c43-987e-d0f16f35a0f6/platform-auth-hub-cookie-bridge.png";
  await page.screenshot({ path: modalScreenshot2 });
  console.log(`Saved Tab 2 screenshot to ${modalScreenshot2}`);

  // Test pasting JSON and importing
  console.log("Testing Cookie-Editor JSON import in UI...");
  const textarea = page.locator(".cookie-json-textarea");
  await textarea.fill(JSON.stringify([{ name: "wt2", value: "token_verified_ui_test", domain: ".zhipin.com" }]));
  const importBtn = page.locator(".btn-import-cookies");
  await importBtn.click();
  await page.waitForTimeout(1500);

  const importResultScreenshot = "/Users/feng/.gemini/antigravity/brain/1c53dd12-c792-4c43-987e-d0f16f35a0f6/platform-auth-hub-import-result.png";
  await page.screenshot({ path: importResultScreenshot });
  console.log(`Saved Import Result screenshot to ${importResultScreenshot}`);

  // Close Platform Auth Hub via "完成" or close button
  const doneBtn = page.locator(".btn-auth-done");
  if (await doneBtn.isVisible()) {
    await doneBtn.click();
    await page.waitForTimeout(600);
  }

  // Trigger search by clicking a skill chip, e.g. "⚡ Java"
  console.log("Clicking ⚡ Java chip to trigger live commercial harvest...");
  const javaChip = page.locator(".atlas-chip-btn:has-text('Java')").first();
  if (await javaChip.isVisible()) {
    await javaChip.click();
  } else {
    const input = page.locator("input[placeholder*='关键词']");
    await input.fill("Java");
    await input.press("Enter");
  }

  // Wait for search execution / progress
  await page.waitForTimeout(3000);

  const searchExecutionScreenshot = "/Users/feng/.gemini/antigravity/brain/1c53dd12-c792-4c43-987e-d0f16f35a0f6/atlas-live-search-execution.png";
  await page.screenshot({ path: searchExecutionScreenshot });
  console.log(`Saved search execution screenshot to ${searchExecutionScreenshot}`);

  await browser.close();
  console.log("Verification finished successfully!");
}

main().catch((err) => {
  console.error("Error during verification:", err);
  process.exit(1);
});
