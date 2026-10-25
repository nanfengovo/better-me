import { chromium } from "../apps/web/node_modules/playwright-core/index.mjs";

async function main() {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const page = await context.newPage();

  console.log("Navigating to http://localhost:5173/?workspace=atlas ...");
  await page.goto("http://localhost:5173/?workspace=atlas", { waitUntil: "networkidle", timeout: 20000 });


  // Find the platform trigger button
  const platformTrigger = page.locator(".atlas-platform-trigger");
  await platformTrigger.waitFor({ state: "visible", timeout: 10000 });
  console.log("Platform trigger text:", await platformTrigger.textContent());
  await platformTrigger.click();
  await page.waitForTimeout(600);

  // Type C# in the search bar if not already present
  const searchInput = page.locator('input[aria-label="搜索地图岗位"]');
  await searchInput.fill("C#");
  await page.waitForTimeout(500);

  // Ensure details is open
  const details = page.locator(".atlas-platform-search");
  await details.waitFor({ state: "visible" });

  // Get summary and grid items
  const summaryText = await details.locator("summary").textContent();
  console.log("Summary text:", summaryText);

  const gridItems = await details.locator(".atlas-platform-search-grid > li").allTextContents();
  console.log("Grid items count:", gridItems.length);
  gridItems.forEach((text, i) => console.log(`  Item ${i + 1}:`, text.replace(/\s+/g, " ").trim()));

  const tabButtons = await page.locator(".atlas-platform-tab-btn").allTextContents();
  console.log("Platform reader tab buttons:", tabButtons);

  const openAllBtn = page.locator(".atlas-platform-open-all-btn");
  if (await openAllBtn.isVisible()) {
    console.log("Open all button text:", await openAllBtn.textContent());
  }

  const screenshotPath = "/Users/feng/.gemini/antigravity/brain/688efe34-71bf-4b5a-b98a-e6ebe121d112/all-platforms-search-aggregated.png";
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log("Screenshot saved to:", screenshotPath);

  await browser.close();
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
