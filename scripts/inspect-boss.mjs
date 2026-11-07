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
  const url = "https://www.zhipin.com/job_detail/fb798685269e3fb10nN40tS8GFdZ.html";
  console.log("Navigating to:", url);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
  await page.waitForTimeout(4000);
  console.log("Final URL:", page.url());
  console.log("Title:", await page.title());

  const evaluation = await page.evaluate(() => {
    return {
      bodyLength: document.body ? document.body.innerHTML.length : 0,
      bodyText: document.body ? document.body.innerText : "",
    };
  });
  console.log("Text length:", evaluation.bodyText.length);
  fs.writeFileSync(path.resolve("./data/boss-job-full.txt"), evaluation.bodyText, "utf8");
  console.log("Saved full text to ./data/boss-job-full.txt");
  await context.close();
}

main().catch(console.error);
