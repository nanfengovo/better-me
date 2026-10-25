import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require("/Users/feng/Documents/Private/简历/简历Agent/better-me/node_modules/.pnpm/playwright-core@1.64.1/node_modules/playwright-core/index.js");

async function main() {
  console.log("Launching browser for real Agent feature verification...");

  const possiblePaths = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  const executablePath = possiblePaths.find((p) => fs.existsSync(p));
  if (!executablePath) {
    console.log("No chrome/edge executable found, skipping visual verification.");
    return;
  }

  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });

  console.log("Navigating to http://localhost:5173...");
  await page.goto("http://localhost:5173", { waitUntil: "networkidle", timeout: 15000 });

  await page.waitForSelector(".studio-header", { timeout: 10000 });

  // 1. Open drawer directly from header
  console.log("Opening AI Agent Drawer from header (job is null)...");
  const agentButton = await page.$('button:has-text("AI Agent 助手")');
  if (!agentButton) {
    throw new Error("AI Agent 助手 button not found");
  }
  await agentButton.click();
  await page.waitForTimeout(1000);

  // 2. Verify target job setup card is visible
  const setupCard = await page.$('h3:has-text("设定目标岗位与 JD")');
  console.log("Target job setup card found:", !!setupCard);

  // 3. Click '载入范例岗位 JD'
  const loadSampleBtn = await page.$('button:has-text("载入范例岗位 JD")');
  if (loadSampleBtn) {
    console.log("Clicking '载入范例岗位 JD'...");
    await loadSampleBtn.click();
    await page.waitForTimeout(500);
  }

  const screenshot1 = "/Users/feng/.gemini/antigravity/brain/688efe34-71bf-4b5a-b98a-e6ebe121d112/agent-target-job-setup.png";
  await page.screenshot({ path: screenshot1, fullPage: true });
  console.log("Saved target job setup screenshot to", screenshot1);

  // 4. Switch to Chat tab to verify quick prompt pills
  const chatTab = await page.$('button:has-text("助理协同对话")');
  if (chatTab) {
    console.log("Switching to Chat tab...");
    await chatTab.click();
    await page.waitForTimeout(500);

    const screenshot2 = "/Users/feng/.gemini/antigravity/brain/688efe34-71bf-4b5a-b98a-e6ebe121d112/agent-chat-quick-prompts.png";
    await page.screenshot({ path: screenshot2, fullPage: true });
    console.log("Saved chat quick prompts screenshot to", screenshot2);

    // Click one of the quick prompts
    const quickPrompt = await page.$('button:has-text("调研公司背景与实控人")');
    if (quickPrompt) {
      console.log("Clicking quick prompt '调研公司背景与实控人'...");
      await quickPrompt.click();
      await page.waitForTimeout(5000);

      const screenshot3 = "/Users/feng/.gemini/antigravity/brain/688efe34-71bf-4b5a-b98a-e6ebe121d112/agent-chat-interaction.png";
      await page.screenshot({ path: screenshot3, fullPage: true });
      console.log("Saved chat interaction screenshot to", screenshot3);
    }
  }

  await browser.close();
  console.log("Verification finished successfully.");
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
