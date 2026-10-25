import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const artifactDir = "/Users/feng/.gemini/antigravity/brain/1c53dd12-c792-4c43-987e-d0f16f35a0f6";

async function main() {
  console.log("Launching browser to verify AI penetration filter and UI...");
  const browser = await chromium.launch({
    headless: true,
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  console.log("Navigating to http://localhost:5173...");
  await page.goto("http://localhost:5173", { waitUntil: "networkidle" });

  // Navigate to 岗位地图
  const atlasTab = page.locator("button:has-text('岗位地图'), a:has-text('岗位地图')").first();
  if (await atlasTab.isVisible()) {
    await atlasTab.click();
    await page.waitForTimeout(1000);
  }

  // Switch to live data mode
  const modeSelect = page.locator("select[aria-label='岗位数据视图']");
  if (await modeSelect.isVisible()) {
    await modeSelect.selectOption("live");
    await page.waitForTimeout(1500);
  }

  // Check connection status
  const banner = page.locator(".atlas-data-banner");
  console.log("Data banner text:", await banner.innerText());

  // Input search keyword "C#"
  const searchInput = page.locator("input[placeholder*='搜索职位'], input[placeholder*='关键词'], input[type='search'], .atlas-search-input input, input[name='search']").first();
  if (await searchInput.isVisible()) {
    console.log("Entering search keyword 'C#'...");
    await searchInput.fill("C#");
    await searchInput.press("Enter");
    await page.waitForTimeout(2000);
  }

  // Check if AI penetration banner is visible
  const aiBanner = page.locator(".atlas-ai-penetration-banner");
  await aiBanner.waitFor({ state: "visible", timeout: 5000 }).catch(() => console.log("AI banner not immediately found"));

  if (await aiBanner.isVisible()) {
    console.log("AI Penetration Banner text:", await aiBanner.innerText());
  }

  // Click on "仅看 AI 穿透岗位" toggle button
  const toggleBtn = page.locator(".atlas-ai-filter-toggle-btn");
  if (await toggleBtn.isVisible()) {
    console.log("Clicking toggle button to filter by AI penetrated jobs only...");
    await toggleBtn.click();
    await page.waitForTimeout(1500);
  }

  // Capture screenshot of the filtered cards list
  const filterActiveScreenshot = path.join(artifactDir, "ai-penetration-filter-active.png");
  await page.screenshot({ path: filterActiveScreenshot });
  console.log(`Saved screenshot to: ${filterActiveScreenshot}`);

  // Find a job card with .atlas-ai-penetration-tag and click it
  const penetratedCard = page.locator(".atlas-job-card:has(.atlas-ai-penetration-tag)").first();
  if (await penetratedCard.isVisible()) {
    const cardTitle = await penetratedCard.locator("strong").innerText();
    const company = await penetratedCard.locator(".atlas-company-line").innerText();
    console.log(`Clicking penetrated card: [${company.trim()}] ${cardTitle.trim()}`);
    await penetratedCard.click();
    await page.waitForTimeout(1500);

    // Verify AI Deep Insight Box in detail pane
    const insightBox = page.locator(".atlas-ai-deep-insight-box");
    if (await insightBox.isVisible()) {
      console.log("AI Deep Insight Box found! Text snippet:", (await insightBox.innerText()).slice(0, 200));
    }

    const detailScreenshot = path.join(artifactDir, "ai-penetration-deep-insight.png");
    await page.screenshot({ path: detailScreenshot });
    console.log(`Saved screenshot to: ${detailScreenshot}`);
  } else {
    console.log("No card with .atlas-ai-penetration-tag found on current view");
  }

  await browser.close();
  console.log("Verification finished successfully!");
}

main().catch(err => {
  console.error("Verification failed:", err);
  process.exit(1);
});
