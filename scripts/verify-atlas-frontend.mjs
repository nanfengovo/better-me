import { chromium } from "../apps/web/node_modules/playwright-core/index.mjs";
import fs from "node:fs";

async function main() {
  const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const browser = await chromium.launch({
    executablePath: fs.existsSync(chromePath) ? chromePath : undefined,
    headless: true,
  });

  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  console.log("Navigating to http://localhost:5173/?workspace=atlas...");
  await page.goto("http://localhost:5173/?workspace=atlas", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  // Check concurrency selector
  const concurrencySelect = page.locator("select[aria-label='并发同步数量']");
  const hasConcurrencySelect = await concurrencySelect.isVisible();
  console.log("Has concurrency selector:", hasConcurrencySelect);
  if (hasConcurrencySelect) {
    const val = await concurrencySelect.inputValue();
    console.log("Current concurrency setting:", val);
  }

  // Click "从来源获取岗位"
  const fetchSourcesBtn = page.locator("button.atlas-source-search").first();
  const hasFetchBtn = await fetchSourcesBtn.isVisible();
  console.log("Has '从来源获取岗位' button:", hasFetchBtn);

  if (hasFetchBtn) {
    console.log("Clicking '从来源获取岗位'...");
    await fetchSourcesBtn.click();

    // Check progress text 1 second after click to see how many are "读取中" vs "排队"
    await page.waitForTimeout(1200);
    const progressText = await page.locator(".atlas-acquisition-explanation").innerText().catch(() => "");
    console.log("Realtime acquisition progress text:", progressText);

    // Take screenshot during concurrent execution
    await page.screenshot({ path: "/Users/feng/.gemini/antigravity/brain/688efe34-71bf-4b5a-b98a-e6ebe121d112/atlas-concurrent-running.png" });
    console.log("Captured atlas-concurrent-running.png");

    // Wait for sync to settle
    console.log("Waiting for batch to settle...");
    await page.waitForSelector(".atlas-acquisition.is-settled", { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const endText = await page.locator("body").innerText();
    const noticeMatch = endText.match(/(?:本次配置来源读取已结束[^\n]*|本轮来源读取已结束[^\n]*)/);
    if (noticeMatch) console.log("Final Notice:", noticeMatch[0]);

    const summaryText = await page.locator(".atlas-acquisition-summary").innerText().catch(() => "");
    if (summaryText) console.log("Acquisition Summary:", summaryText);

    await page.screenshot({ path: "/Users/feng/.gemini/antigravity/brain/688efe34-71bf-4b5a-b98a-e6ebe121d112/atlas-concurrent-finished.png" });
    console.log("Captured atlas-concurrent-finished.png");
  }

  await browser.close();
}

main().catch(console.error);
