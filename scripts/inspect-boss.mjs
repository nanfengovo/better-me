import { chromium } from "../apps/web/node_modules/playwright-core/index.mjs";
import fs from "node:fs";
import path from "node:path";

const profileDir = path.resolve("./data/recruitment-browser/boss/profile");
for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
  try { fs.unlinkSync(path.join(profileDir, f)); } catch {}
}

async function main() {
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless: false,
    timeout: 15000,
    args: ["--disable-blink-features=AutomationControlled", "--no-proxy-server"],
  });
  const page = await context.newPage();
  const url = "https://www.zhipin.com/job_detail/789ad05bba32b1b60nV72du4GFtQ.html";
  console.log("Navigating to:", url);
  await page.goto(url, { waitUntil: "networkidle", timeout: 25000 });
  await page.waitForTimeout(3000);
  console.log("Final URL:", page.url());
  console.log("Title:", await page.title());

  const screenshotPath = path.resolve("./boss-page-actual.png");
  await page.screenshot({ path: screenshotPath });
  console.log("Saved screenshot to:", screenshotPath);

  const evaluation = await page.evaluate(() => {
    return {
      bodyLength: document.body ? document.body.innerHTML.length : 0,
      bodyText: document.body ? document.body.innerText.slice(0, 500) : "",
    };
  });
  console.log("Eval:", evaluation);
  await context.close();
}

main().catch(console.error);
