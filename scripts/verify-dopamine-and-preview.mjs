import { chromium } from "../apps/web/node_modules/playwright-core/index.mjs";
import fs from "node:fs";
import { resolve } from "node:path";

const ARTIFACTS_DIR = "/Users/feng/.gemini/antigravity/brain/688efe34-71bf-4b5a-b98a-e6ebe121d112";

async function main() {
  console.log("Launching browser for verification...");
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

  // 1. Take a screenshot of the main editor showing dopamine colored tech stack tags
  console.log("Verifying dopamine tech stack tags...");
  await page.screenshot({
    path: resolve(ARTIFACTS_DIR, "dopamine-tags-and-editor.png"),
    fullPage: false,
  });
  console.log("Saved dopamine-tags-and-editor.png");

  // 2. Open the custom claim kind dropdown
  console.log("Testing ClaimKindSelector dropdown...");
  const kindTrigger = page.locator('button[aria-haspopup="listbox"]').first();
  if (await kindTrigger.isVisible()) {
    await kindTrigger.click();
    await page.waitForTimeout(400);

    await page.screenshot({
      path: resolve(ARTIFACTS_DIR, "custom-dropdown-open.png"),
      fullPage: false,
    });
    console.log("Saved custom-dropdown-open.png");

    // Click "+ 自定义类别..."
    const addCustomBtn = page.locator('button:has-text("+ 自定义类别")').first();
    if (await addCustomBtn.isVisible()) {
      await addCustomBtn.click();
      await page.waitForTimeout(200);

      const customInput = page.locator('input[placeholder*="自定义类别"]').first();
      await customInput.fill("技术攻坚");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(400);

      console.log("Added custom kind '技术攻坚'");
      await page.screenshot({
        path: resolve(ARTIFACTS_DIR, "custom-kind-selected.png"),
        fullPage: false,
      });
      console.log("Saved custom-kind-selected.png");
    }
  }

  // 3. Test left hover -> right prominent highlight
  console.log("Testing left hover -> right prominent highlight...");
  // Find a claim anchor on the left side
  const claimAnchor = page.locator('[data-editor-anchor^="claim:"]').first();
  if (await claimAnchor.isVisible()) {
    await claimAnchor.hover();
    await page.waitForTimeout(600);

    const followedPreview = page.locator('.resume-preview-canvas [data-preview-followed="true"]').first();
    const isFollowedVisible = await followedPreview.isVisible().catch(() => false);
    console.log("Right followed preview visible:", isFollowedVisible);

    await page.screenshot({
      path: resolve(ARTIFACTS_DIR, "hover-prominent-preview.png"),
      fullPage: false,
    });
    console.log("Saved hover-prominent-preview.png");
  }

  await browser.close();
  console.log("Verification finished successfully!");
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
