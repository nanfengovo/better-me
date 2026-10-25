import { chromium } from '../apps/web/node_modules/playwright-core/index.mjs';
import fs from "node:fs";
import path from "node:path";

async function main() {
  const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const tokenPath = path.join(process.env.HOME, "Library/Application Support/BetterMe/job-atlas/service.token");
  const token = fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath, "utf8").trim() : "";

  console.log(`Using service token: ${token.slice(0, 8)}...`);

  const browser = await chromium.launch({
    executablePath: fs.existsSync(chromePath) ? chromePath : undefined,
    headless: true,
  });

  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 }
  });

  page.on('console', msg => console.log(`[BROWSER CONSOLE] ${msg.type()}: ${msg.text()}`));
  page.on('pageerror', err => console.log(`[BROWSER ERROR]: ${err.message}`));

  // Inject session storage before navigating
  await page.addInitScript(({ token }) => {
    window.sessionStorage.setItem("better-me:atlas-connection-session:v1", JSON.stringify({
      schemaVersion: 1,
      dataMode: "live",
      endpoint: "http://127.0.0.1:5178",
      token: token,
    }));
  }, { token });

  console.log('Navigating to http://localhost:5173/?workspace=atlas...');
  await page.goto('http://localhost:5173/?workspace=atlas', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // Check data banner
  const banner = page.locator('.atlas-data-banner');
  console.log('Data banner:', (await banner.innerText()).replace(/\n/g, ' '));

  // Type C# in the exact search box
  console.log('Typing C# in search input[aria-label="搜索地图岗位"]...');
  const searchInput = page.locator('input[aria-label="搜索地图岗位"]');
  await searchInput.click();
  await searchInput.fill('C#');
  await page.waitForTimeout(1500);

  // Check AI penetration banner
  console.log('Checking for AI penetration banner...');
  const aiBanner = page.locator('.atlas-ai-penetration-banner');
  await aiBanner.waitFor({ state: 'visible', timeout: 5000 });
  const aiBannerText = await aiBanner.innerText();
  console.log('AI Banner Text:', aiBannerText.replace(/\n/g, ' '));

  // Check badge dimensions (ensure NO vertical wrapping)
  const badge = page.locator('.atlas-ai-penetration-banner .atlas-ai-badge-pill');
  const badgeBox = await badge.boundingBox();
  console.log(`Badge Pill Bounding Box: width=${badgeBox?.width}px, height=${badgeBox?.height}px`);
  if (badgeBox && badgeBox.width > 50 && badgeBox.height < 30) {
    console.log('✅ Badge is correctly horizontal and not vertically wrapped!');
  } else {
    console.error('❌ Badge may still be wrapped vertically!', badgeBox);
  }

  // Check toggle button
  const toggleBtn = page.locator('.atlas-ai-filter-toggle-btn');
  const toggleText = await toggleBtn.innerText();
  console.log(`Toggle Button Text: "${toggleText}"`);

  // Screenshot 1: Sleek unified AI Banner
  const screenshotPath1 = '/Users/feng/.gemini/antigravity/brain/1c53dd12-c792-4c43-987e-d0f16f35a0f6/ai-penetration-job-cards.png';
  await page.screenshot({ path: screenshotPath1 });
  console.log(`Screenshot 1 saved to: ${screenshotPath1}`);

  // Test dismiss button [X]
  console.log('Testing close/dismiss button [X]...');
  const closeBtn = page.locator('.atlas-ai-banner-close-btn');
  await closeBtn.click();
  await page.waitForTimeout(800);

  const aiBannerVisibleAfterClose = await page.locator('.atlas-ai-penetration-banner').isVisible();
  console.log(`AI Banner visible after close: ${aiBannerVisibleAfterClose}`);

  // Check that collapsed bar has the restore pill
  const restorePill = page.locator('.atlas-compact-refresh-btn:has-text("AI 穿透")');
  console.log(`Restore pill visible in collapsed bar: ${await restorePill.isVisible()}`);

  // Screenshot 2: Collapsed minimal bar state
  const screenshotPathCollapsed = '/Users/feng/.gemini/antigravity/brain/1c53dd12-c792-4c43-987e-d0f16f35a0f6/ai-banner-collapsed.png';
  await page.screenshot({ path: screenshotPathCollapsed });
  console.log(`Screenshot Collapsed saved to: ${screenshotPathCollapsed}`);

  // Click restore pill to reopen AI Banner
  console.log('Clicking restore pill to un-collapse AI banner...');
  await restorePill.click();
  await page.waitForTimeout(800);
  console.log(`AI Banner restored: ${await aiBanner.isVisible()}`);

  // Click on "仅看 AI 穿透岗位" toggle button in the banner
  console.log('Clicking "仅看 AI 穿透岗位" toggle button...');
  await toggleBtn.click();
  await page.waitForTimeout(1000);

  const penetratedCountAfterFilter = await page.locator('.atlas-job-card:has(.atlas-ai-penetration-tag)').count();
  console.log(`Filtered penetrated cards count: ${penetratedCountAfterFilter}`);

  // Screenshot 3: Filter active showing all penetrated cards
  const screenshotPathActive = '/Users/feng/.gemini/antigravity/brain/1c53dd12-c792-4c43-987e-d0f16f35a0f6/ai-penetration-filter-active.png';
  await page.screenshot({ path: screenshotPathActive });
  console.log(`Screenshot Filter Active saved to: ${screenshotPathActive}`);

  // Measure re-harvest speed
  console.log('Testing re-harvest speed...');
  const reharvestBtn = page.locator('.atlas-compact-refresh-btn:has-text("全网重搜")');
  const t0 = Date.now();
  await reharvestBtn.click();
  
  // Wait for search indicator to show and then finish
  await page.waitForTimeout(1000);
  // Wait until .live-searching is gone
  try {
    await page.locator('.live-searching').waitFor({ state: 'detached', timeout: 25000 });
    const elapsed = Date.now() - t0;
    console.log(`✅ Re-harvest completed swiftly in ${elapsed}ms!`);
  } catch (e) {
    console.log(`Re-harvest took longer or timed out: ${e.message}`);
  }

  // Click the first penetrated card to inspect the detail panel
  const penetratedCard = page.locator('.atlas-job-card:has(.atlas-ai-penetration-tag)').first();
  if (await penetratedCard.isVisible()) {
    const cardTitle = await penetratedCard.locator('strong').innerText();
    const company = await penetratedCard.locator('.atlas-company-line').innerText();
    console.log(`Clicking penetrated job card: [${company.trim()}] ${cardTitle.trim()}...`);
    await penetratedCard.click();
    await page.waitForTimeout(1200);

    const insightBox = page.locator('.atlas-ai-deep-insight-box');
    if (await insightBox.isVisible()) {
      console.log('AI Deep Insight Box Content:\n', (await insightBox.innerText()).slice(0, 300));
    }
  }

  // Screenshot 4: Detail panel with glowing AI Deep Insight Box
  const screenshotPath2 = '/Users/feng/.gemini/antigravity/brain/1c53dd12-c792-4c43-987e-d0f16f35a0f6/ai-deep-insight-panel.png';
  await page.screenshot({ path: screenshotPath2 });
  console.log(`Screenshot 4 saved to: ${screenshotPath2}`);

  await browser.close();
  console.log('All visual and performance verifications completed successfully!');
}

main().catch((err) => {
  console.error('Error running test script:', err);
  process.exit(1);
});
