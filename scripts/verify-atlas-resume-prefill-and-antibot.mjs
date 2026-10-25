import { chromium } from "../apps/web/node_modules/playwright-core/index.mjs";

async function main() {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();

  console.log("Navigating to http://localhost:5173/?workspace=atlas ...");
  await page.goto("http://localhost:5173/?workspace=atlas", { waitUntil: "networkidle", timeout: 25000 });
  await page.waitForTimeout(1000);

  // 1. Check for the resume prefill bar
  const prefillBar = page.locator(".atlas-resume-prefill-bar");
  const isPrefillVisible = await prefillBar.isVisible().catch(() => false);
  console.log("Is resume prefill bar visible:", isPrefillVisible);

  if (isPrefillVisible) {
    const prefillBtnText = await page.locator(".atlas-prefill-btn").textContent();
    console.log("Prefill button text:", prefillBtnText?.trim());

    const chips = await page.locator(".atlas-chip-btn").allTextContents();
    console.log("Recommendation chips:", chips.map(c => c.trim()));

    // Capture initial Atlas view with prefill bar
    await page.screenshot({
      path: "/Users/feng/.gemini/antigravity/brain/688efe34-71bf-4b5a-b98a-e6ebe121d112/atlas-prefill-bar-initial.png",
      fullPage: false,
    });

    // 2. Click the prefill button
    console.log("Clicking '参考当前简历自动填入' button...");
    await page.locator(".atlas-prefill-btn").click();
    await page.waitForTimeout(800);

    const searchInputValue = await page.locator('input[aria-label="搜索地图岗位"]').inputValue();
    console.log("Search input value after prefill:", searchInputValue);

    // Capture state after auto prefill
    await page.screenshot({
      path: "/Users/feng/.gemini/antigravity/brain/688efe34-71bf-4b5a-b98a-e6ebe121d112/atlas-prefilled-applied.png",
      fullPage: false,
    });

    // 3. Click one of the chips
    if (chips.length > 1) {
      console.log("Clicking secondary chip:", chips[1].trim());
      await page.locator(".atlas-chip-btn").nth(1).click();
      await page.waitForTimeout(600);
      const switchedInputValue = await page.locator('input[aria-label="搜索地图岗位"]').inputValue();
      console.log("Search input value after chip click:", switchedInputValue);
    }
  }

  // 4. Open and inspect the Anti-Bot Commercial Platform Aggregator
  console.log("Toggling full-platform anti-bot aggregator...");
  const platformTrigger = page.locator(".atlas-platform-trigger");
  await platformTrigger.waitFor({ state: "visible", timeout: 10000 });
  await platformTrigger.click();
  await page.waitForTimeout(800);

  const antibotCard = page.locator(".atlas-antibot-feature-card");
  console.log("Is antibot feature card open:", await antibotCard.isVisible());

  // Capture anti-bot aggregator overview
  await page.screenshot({
    path: "/Users/feng/.gemini/antigravity/brain/688efe34-71bf-4b5a-b98a-e6ebe121d112/atlas-antibot-aggregator-overview.png",
    fullPage: false,
  });

  console.log("Verification finished successfully!");
  await browser.close();
}

main().catch((err) => {
  console.error("Verification script error:", err);
  process.exit(1);
});
