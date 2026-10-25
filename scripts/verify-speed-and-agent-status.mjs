import { chromium } from "../apps/web/node_modules/playwright-core/index.mjs";
import fs from "node:fs";

async function run() {
  const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const browser = await chromium.launch({
    executablePath: fs.existsSync(chromePath) ? chromePath : undefined,
    headless: true,
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });

  const page = await context.newPage();

  console.log("1. Navigating to BetterMe Atlas...");
  await page.goto("http://localhost:5173/?workspace=atlas", { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);

  // Take screenshot of default top bar with unconfigured AI Agent status
  console.log("2. Inspecting top bar AI Agent status (unconfigured)...");
  await page.screenshot({
    path: "/Users/feng/.gemini/antigravity/brain/1c53dd12-c792-4c43-987e-d0f16f35a0f6/agent-status-unconfigured.png",
  });

  // Open the status dropdown
  console.log("3. Opening AI Agent status dropdown...");
  const toggleBtn = page.locator(".agent-top-bar-toggle-btn");
  if (await toggleBtn.isVisible()) {
    await toggleBtn.click();
    await page.waitForTimeout(400);
    await page.screenshot({
      path: "/Users/feng/.gemini/antigravity/brain/1c53dd12-c792-4c43-987e-d0f16f35a0f6/agent-status-dropdown.png",
    });
    // Close dropdown
    await page.click("body", { position: { x: 10, y: 10 } });
    await page.waitForTimeout(300);
  }

  // Now set a configured LLM in localStorage and mock successful models response
  console.log("4. Setting configured LLM in localStorage with mocked healthy connection...");
  await page.route("**/api.deepseek.com/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        object: "list",
        data: [{ id: "deepseek-chat", object: "model" }],
      }),
    });
  });

  await page.evaluate(() => {
    localStorage.setItem(
      "better-me:llm-config",
      JSON.stringify({
        provider: "openai-compatible",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "sk-valid-deepseek-key",
        model: "deepseek-chat",
        temperature: 0.3,
      }),
    );
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1000);

  console.log("5. Inspecting top bar AI Agent status (configured & ready)...");
  await page.screenshot({
    path: "/Users/feng/.gemini/antigravity/brain/1c53dd12-c792-4c43-987e-d0f16f35a0f6/agent-status-ready.png",
  });

  // Open the dropdown for configured state
  const toggleBtnReady = page.locator(".agent-top-bar-toggle-btn");
  if (await toggleBtnReady.isVisible()) {
    await toggleBtnReady.click();
    await page.waitForTimeout(500);
    await page.screenshot({
      path: "/Users/feng/.gemini/antigravity/brain/1c53dd12-c792-4c43-987e-d0f16f35a0f6/agent-status-dropdown-ready.png",
    });
    await page.click("body", { position: { x: 10, y: 10 } });
    await page.waitForTimeout(300);
  }

  // Trigger search to verify collection speed and animated live harvest progress bar
  console.log("6. Testing search speed and animated progress bar...");
  const searchInput = page.locator(".atlas-search input");
  await searchInput.fill("Golang");
  await page.waitForTimeout(500);

  // Check if live batch search button or quick search is available
  const batchBtn = page.locator(".atlas-live-btn-batch-primary").first();
  if (await batchBtn.isVisible()) {
    console.log("Clicking live capture button...");
    const t0 = Date.now();
    await batchBtn.click();
    // Wait briefly to capture the animated live searching banner
    await page.waitForTimeout(700);
    await page.screenshot({
      path: "/Users/feng/.gemini/antigravity/brain/1c53dd12-c792-4c43-987e-d0f16f35a0f6/atlas-live-harvest-in-progress.png",
    });
  }

  // Capture final overview
  await page.waitForTimeout(3000);
  await page.screenshot({
    path: "/Users/feng/.gemini/antigravity/brain/1c53dd12-c792-4c43-987e-d0f16f35a0f6/atlas-live-harvest-speed-optimized.png",
  });

  await browser.close();
  console.log("Done! Screenshots saved to artifact directory.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
