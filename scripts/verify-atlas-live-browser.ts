import { chromium } from "playwright";
import { homedir } from "os";
import { join } from "path";

async function main() {
  const browser = await chromium.launch({
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  console.log("Navigating to http://localhost:5173...");
  await page.goto("http://localhost:5173", { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);

  // Check top bar or stats
  const topText = await page.textContent("body");
  console.log("Page loaded. Checking for keywords...");

  // Click on "岗位地图" or ensure we are on the atlas tab
  const atlasTab = page.locator('button:has-text("岗位地图"), a:has-text("岗位地图")').first();
  if (await atlasTab.isVisible()) {
    await atlasTab.click();
    await page.waitForTimeout(1500);
  }

  // Ensure Domestic mode is active
  const domesticBtn = page.locator('button:has-text("国内")').first();
  if (await domesticBtn.isVisible()) {
    await domesticBtn.click();
    await page.waitForTimeout(1000);
  }

  // Select Shanghai in Province dropdown if not already selected
  const provinceSelect = page.locator('select').first();
  if (await provinceSelect.isVisible()) {
    await provinceSelect.selectOption({ label: "上海市" });
    await page.waitForTimeout(1000);
  }

  // Input "C#" in search
  const searchInput = page.locator('input[placeholder*="搜索"], input[type="search"], input[type="text"]').first();
  if (await searchInput.isVisible()) {
    await searchInput.fill("C#");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2500);
  }

  // Check the match count text
  const matchInfo = await page.locator('.atlas-dataset-status, .atlas-summary-strip, [role="status"]').allTextContents();
  console.log("Match info text contents:", matchInfo.filter(t => t.trim().length > 0));

  // Take a full page screenshot
  const fullScreenshotPath = "/Users/feng/.gemini/antigravity/brain/1c53dd12-c792-4c43-987e-d0f16f35a0f6/atlas-verified-live-full.png";
  await page.screenshot({ path: fullScreenshotPath });
  console.log(`Saved full screenshot to: ${fullScreenshotPath}`);

  // Take a screenshot of the map card
  const mapCard = page.locator('.atlas-map-card, .atlas-scene').first();
  if (await mapCard.isVisible()) {
    const mapScreenshotPath = "/Users/feng/.gemini/antigravity/brain/1c53dd12-c792-4c43-987e-d0f16f35a0f6/atlas-verified-live-map.png";
    await mapCard.screenshot({ path: mapScreenshotPath });
    console.log(`Saved map screenshot to: ${mapScreenshotPath}`);
  }

  await browser.close();
}

main().catch(console.error);
