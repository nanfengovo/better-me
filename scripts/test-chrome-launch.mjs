import { chromium } from "../apps/web/node_modules/playwright-core/index.mjs";
import fs from "node:fs";
import path from "node:path";

const profileDir = path.resolve("./data/recruitment-browser/boss/profile");
fs.mkdirSync(profileDir, { recursive: true });

// Clean stale singleton files
for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
  try {
    fs.unlinkSync(path.join(profileDir, f));
  } catch {}
}

async function main() {
  console.log("Launching Chrome...");
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless: false,
    timeout: 15000,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-proxy-server",
    ],
  });

  const page = await context.newPage();
  console.log("Navigating to target URL...");
  try {
    const url = "https://www.zhipin.com/job_detail/789ad05bba32b1b60nV72du4GFtQ.html";
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    console.log("Page loaded. Current URL:", page.url());
    console.log("Page title:", await page.title());
    await page.waitForTimeout(3000);
    const content = await page.content();
    console.log("Content length:", content.length);
  } catch (err) {
    console.error("Navigation error:", err.message);
  } finally {
    await context.close();
    console.log("Context closed cleanly.");
  }
}

main().catch(console.error);
