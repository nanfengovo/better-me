import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require("/Users/feng/Documents/Private/简历/简历Agent/better-me/node_modules/.pnpm/playwright-core@1.64.1/node_modules/playwright-core/index.js");

async function main() {
  console.log("Verifying Version History modal in browser...");

  const possiblePaths = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  const executablePath = possiblePaths.find((p) => fs.existsSync(p));
  if (!executablePath) return;

  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto("http://localhost:5173", { waitUntil: "networkidle", timeout: 15000 });
  await page.waitForSelector(".studio-header", { timeout: 10000 });

  // Locate the '版本' rail button and click it to open Version History modal
  const versionRailBtn = page.locator('.studio-rail button:has-text("版本")');
  console.log("Clicking rail button '版本'...");
  await versionRailBtn.click();

  await page.waitForSelector('h2:has-text("版本时光机")', { timeout: 5000 });
  await page.waitForTimeout(1000);

  // Check if error banner is present
  const errorBanner = page.locator('div[role="alert"]:has-text("The database connection is closing")');
  const hasError = await errorBanner.isVisible().catch(() => false);
  console.log("Has database connection closing error:", hasError);

  const screenshotPath = "/Users/feng/.gemini/antigravity/brain/688efe34-71bf-4b5a-b98a-e6ebe121d112/version-history-verified.png";
  await page.screenshot({ path: screenshotPath });
  console.log("Saved screenshot to", screenshotPath);

  await browser.close();
}

main().catch((err) => {
  console.error("Verification error:", err);
  process.exit(1);
});
