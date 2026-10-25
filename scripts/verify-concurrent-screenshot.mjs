import { chromium } from "../apps/web/node_modules/playwright-core/index.mjs";
import fs from "node:fs";

async function main() {
  const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const browser = await chromium.launch({
    executablePath: fs.existsSync(chromePath) ? chromePath : undefined,
    headless: true,
  });

  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await context.newPage();

  console.log("Navigating to http://localhost:5173/?workspace=atlas...");
  await page.goto("http://localhost:5173/?workspace=atlas", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  // Click "从来源获取岗位"
  const fetchSourcesBtn = page.locator("button.atlas-source-search").first();
  await fetchSourcesBtn.click();

  // Wait 1.5s for sync to be actively running
  await page.waitForTimeout(1500);

  // Scroll to acquisition progress component
  const progressEl = page.locator(".atlas-acquisition");
  await progressEl.scrollIntoViewIfNeeded().catch(() => {});

  const runningText = await progressEl.innerText().catch(() => "");
  console.log("Progress component text:\n", runningText);

  await page.screenshot({ path: "/Users/feng/.gemini/antigravity/brain/688efe34-71bf-4b5a-b98a-e6ebe121d112/atlas-9-sources-concurrent.png" });
  console.log("Captured atlas-9-sources-concurrent.png");

  await browser.close();
}

main().catch(console.error);
