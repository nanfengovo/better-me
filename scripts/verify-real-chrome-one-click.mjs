import { chromium } from "../apps/web/node_modules/playwright-core/index.mjs";
import fs from "node:fs";

async function main() {
  const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const browser = await chromium.launch({
    executablePath: fs.existsSync(chromePath) ? chromePath : undefined,
    headless: true,
  });

  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage();

  console.log("Navigating to http://localhost:5173/ ...");
  await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
  await page.waitForSelector(".studio-rail", { timeout: 15000 });

  // Click on "地图"
  const atlasBtn = page.locator("aside.studio-rail button:has-text('地图')").first();
  await atlasBtn.click();
  await page.waitForTimeout(2000);

  // Click summary of 51JOB · BOSS · 猎聘 ...
  console.log("Clicking '51JOB · BOSS · 猎聘' summary...");
  const summary = page.locator("details.atlas-platform-search summary");
  await summary.click();
  await page.waitForTimeout(1500);

  // Click "一键启动真实 Chrome 接管"
  const launchBtn = page.locator("button.btn-chrome-launch-primary");
  console.log("Clicking '一键启动真实 Chrome 接管' button...");
  await launchBtn.click();

  // Wait 3 seconds for launch and connection
  await page.waitForTimeout(3500);

  const launchBar = page.locator(".real-chrome-launch-bar");
  console.log("Launch bar text after click:\n", await launchBar.innerText());

  const screenshotPath = "/Users/feng/.gemini/antigravity/brain/688efe34-71bf-4b5a-b98a-e6ebe121d112/real-chrome-connected-bar.png";
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log("Screenshot saved to:", screenshotPath);

  await browser.close();
}

main().catch(console.error);
