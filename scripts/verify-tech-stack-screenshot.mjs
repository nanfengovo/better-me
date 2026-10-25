import { chromium } from "../apps/web/node_modules/playwright-core/index.mjs";
import fs from "node:fs";

async function main() {
  const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const browser = await chromium.launch({
    executablePath: fs.existsSync(chromePath) ? chromePath : undefined,
    headless: true,
  });

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto("http://localhost:5173", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".fact-editor", { timeout: 10000 });

  const expTab = page.locator('button:has-text("经历与成果")');
  await expTab.click();
  await page.waitForTimeout(400);

  const addTagBtn = page.locator('button:has-text("+ 标签")').first();
  await addTagBtn.click();
  await page.waitForTimeout(300);

  const artifactPath = "/Users/feng/.gemini/antigravity/brain/688efe34-71bf-4b5a-b98a-e6ebe121d112/tech-stack-inline-editor.png";
  await page.screenshot({ path: artifactPath, fullPage: false });
  console.log("Screenshot with inline input open saved to", artifactPath);

  await browser.close();
}

main().catch(console.error);
