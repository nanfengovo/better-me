import { chromium } from "../apps/web/node_modules/playwright-core/index.mjs";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-clean-profile-"));
  console.log("Using clean temp profile:", tempDir);

  const browser = await chromium.launch({
    channel: "chrome",
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const page = await browser.newPage();
  const url = "https://www.zhipin.com/job_detail/789ad05bba32b1b60nV72du4GFtQ.html";
  console.log("Navigating to:", url);

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForTimeout(3000);

  console.log("Current URL:", page.url());
  console.log("Page title:", await page.title());

  const data = await page.evaluate(() => {
    return {
      title: document.querySelector(".name h1")?.textContent || document.title,
      company: document.querySelector(".company-info a")?.textContent || "",
      salary: document.querySelector(".name .salary")?.textContent || "",
      jd: document.querySelector(".job-sec-text")?.textContent || "",
      bodyText: document.body ? document.body.innerText.slice(0, 500) : "",
    };
  });

  console.log("Extracted Data:", JSON.stringify(data, null, 2));
  await browser.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

main().catch(console.error);
