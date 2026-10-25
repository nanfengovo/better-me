import { chromium } from "../apps/web/node_modules/playwright-core/index.mjs";
import fs from "node:fs";
import { resolve } from "node:path";

const ARTIFACTS_DIR = "/Users/feng/.gemini/antigravity/brain/688efe34-71bf-4b5a-b98a-e6ebe121d112";

async function main() {
  console.log("Launching browser for TagListEditor verification...");
  const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const browser = await chromium.launch({
    executablePath: fs.existsSync(chromePath) ? chromePath : undefined,
    headless: true,
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: 2,
  });

  const page = await context.newPage();

  console.log("Navigating to http://localhost:5173/ ...");
  await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);

  // Switch to "简历工作室" tab if not already on it
  const studioTab = page.locator('button:has-text("简历工作室")').first();
  if (await studioTab.isVisible()) {
    console.log("Clicking '简历工作室' tab...");
    await studioTab.click();
    await page.waitForTimeout(800);
  }

  // Ensure "经历与成果" is visible
  const expTab = page.locator('button:has-text("经历与成果")').first();
  if (await expTab.isVisible()) {
    await expTab.click();
    await page.waitForTimeout(500);
  }

  // 1. Take a screenshot of the normal state (clean + 标签, dopamine tags)
  console.log("Capturing normal state...");
  const techStackGroup = page.locator('div[aria-label="技术栈标签"]').first();
  if (await techStackGroup.isVisible()) {
    await techStackGroup.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
  }

  await page.screenshot({
    path: resolve(ARTIFACTS_DIR, "tag-editor-detail-normal.png"),
    fullPage: false,
  });
  console.log("Saved tag-editor-detail-normal.png");

  // 2. Click on "ABP vNext" to enter editing mode
  console.log("Clicking 'ABP vNext' tag to enter inline editing mode...");
  const abpTag = page.locator('span:has-text("ABP vNext")').first();
  if (await abpTag.isVisible()) {
    await abpTag.click();
    await page.waitForTimeout(400);

    await page.screenshot({
      path: resolve(ARTIFACTS_DIR, "tag-editor-detail-editing.png"),
      fullPage: false,
    });
    console.log("Saved tag-editor-detail-editing.png");
  } else {
    console.warn("ABP vNext tag not found, searching for any tech tag...");
    const anyTag = page.locator('div[aria-label="技术栈标签"] span.cursor-pointer').first();
    if (await anyTag.isVisible()) {
      await anyTag.click();
      await page.waitForTimeout(400);
      await page.screenshot({
        path: resolve(ARTIFACTS_DIR, "tag-editor-detail-editing.png"),
        fullPage: false,
      });
      console.log("Saved fallback tag-editor-detail-editing.png");
    }
  }

  // 3. Test clicking "+ 标签"
  console.log("Testing + 标签 adding mode...");
  // Press Escape to cancel editing first
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  const addTagBtn = page.locator('button:has-text("标签")').first();
  if (await addTagBtn.isVisible()) {
    await addTagBtn.click();
    await page.waitForTimeout(400);

    await page.screenshot({
      path: resolve(ARTIFACTS_DIR, "tag-editor-detail-adding.png"),
      fullPage: false,
    });
    console.log("Saved tag-editor-detail-adding.png");
  }

  await browser.close();
  console.log("Verification completed successfully!");
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
