import { chromium } from "../apps/web/node_modules/playwright-core/index.mjs";
import fs from "node:fs";

async function main() {
  console.log("Launching browser for collapsible filters verification...");
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
    await domesticBtn.click();
    await page.waitForTimeout(1000);
  }

  // 1. Screenshot of default expanded state
  console.log("Capturing 1: default expanded filters...");
  const ssExpanded = "/Users/feng/.gemini/antigravity/brain/1c53dd12-c792-4c43-987e-d0f16f35a0f6/atlas-filters-collapsible-expanded.png";
  await page.screenshot({ path: ssExpanded });
  console.log(`Saved: ${ssExpanded}`);

  // 2. Select some filters: "外企" and "BOSS直聘"
  console.log("Selecting '外企' and 'BOSS直聘' filters...");
  const foreignBtn = page.locator(".atlas-filter-pills button:has-text('外企')").first();
  if (await foreignBtn.isVisible()) {
    await foreignBtn.click();
    await page.waitForTimeout(400);
  }
  const bossBtn = page.locator(".atlas-filter-pills button:has-text('BOSS直聘')").first();
  if (await bossBtn.isVisible()) {
    await bossBtn.click();
    await page.waitForTimeout(400);
  }

  // 3. Click collapse button
  console.log("Clicking collapse button...");
  const toggleBtn = page.locator(".atlas-filter-toggle-btn");
  await toggleBtn.click();
  await page.waitForTimeout(600);

  // 4. Screenshot of collapsed state with active filter summary tags
  console.log("Capturing 2: collapsed filters with active summary tags...");
  const ssCollapsedActive = "/Users/feng/.gemini/antigravity/brain/1c53dd12-c792-4c43-987e-d0f16f35a0f6/atlas-filters-collapsible-collapsed-active.png";
  await page.screenshot({ path: ssCollapsedActive });
  console.log(`Saved: ${ssCollapsedActive}`);

  // 5. Click "重置" in the collapsed summary bar
  console.log("Clicking reset in collapsed summary...");
  const resetBtn = page.locator(".summary-reset-btn");
  if (await resetBtn.isVisible()) {
    await resetBtn.click();
    await page.waitForTimeout(400);
  }

  // 6. Screenshot of collapsed state with no active filters (clean maximum job list space)
  console.log("Capturing 3: collapsed filters with no active filters (max list height)...");
  const ssCollapsedClean = "/Users/feng/.gemini/antigravity/brain/1c53dd12-c792-4c43-987e-d0f16f35a0f6/atlas-filters-collapsible-collapsed-clean.png";
  await page.screenshot({ path: ssCollapsedClean });
  console.log(`Saved: ${ssCollapsedClean}`);

  // 7. Click expand button to restore
  console.log("Clicking expand button to restore...");
  await toggleBtn.click();
  await page.waitForTimeout(600);

  const ssRestored = "/Users/feng/.gemini/antigravity/brain/1c53dd12-c792-4c43-987e-d0f16f35a0f6/atlas-filters-collapsible-restored.png";
  await page.screenshot({ path: ssRestored });
  console.log(`Saved: ${ssRestored}`);

  await browser.close();
  console.log("Collapsible verification completed successfully!");
}

main().catch((err) => {
  console.error("Error during verification:", err);
  process.exit(1);
});
