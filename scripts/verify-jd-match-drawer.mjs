import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require("/Users/feng/Documents/Private/简历/简历Agent/better-me/node_modules/.pnpm/playwright-core@1.64.1/node_modules/playwright-core/index.js");

async function main() {
  console.log("Launching browser to verify JdMatchDrawer...");
  
  // Find Chrome/Chromium executable
  const possiblePaths = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  const executablePath = possiblePaths.find((p) => fs.existsSync(p));
  if (!executablePath) {
    console.log("No chrome/edge executable found directly, skipping visual screenshot.");
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

  console.log("Waiting for header...");
  await page.waitForSelector(".studio-header", { timeout: 10000 });

  console.log("Clicking AI Agent 助手 button...");
  const agentButton = await page.$('button:has-text("AI Agent 助手")');
  if (agentButton) {
    await agentButton.click();
    console.log("Clicked AI Agent 助手 button.");
    await page.waitForTimeout(1000);

    // Check if drawer dialog appeared
    const drawer = await page.$('[role="dialog"]');
    if (drawer) {
      console.log("Drawer dialog found!");
      const screenshotPath = "/Users/feng/.gemini/antigravity/brain/688efe34-71bf-4b5a-b98a-e6ebe121d112/jd-match-drawer.png";
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log("Saved screenshot to", screenshotPath);

      // Now switch to Chat tab
      const chatTab = await page.$('button:has-text("助理协同对话")');
      if (chatTab) {
        await chatTab.click();
        await page.waitForTimeout(500);
        const chatScreenshotPath = "/Users/feng/.gemini/antigravity/brain/688efe34-71bf-4b5a-b98a-e6ebe121d112/jd-match-drawer-chat.png";
        await page.screenshot({ path: chatScreenshotPath, fullPage: true });
        console.log("Saved chat screenshot to", chatScreenshotPath);
      }

      // Close drawer
      const closeBtn = await page.$('button[aria-label="关闭"]');
      if (closeBtn) await closeBtn.click();
      await page.waitForTimeout(500);

      // Now click the invite banner in the editor
      const inviteBtn = await page.$(".jd-workspace-invite");
      if (inviteBtn) {
        console.log("Found .jd-workspace-invite button, clicking...");
        await inviteBtn.click();
        await page.waitForTimeout(500);
        const inviteScreenshotPath = "/Users/feng/.gemini/antigravity/brain/688efe34-71bf-4b5a-b98a-e6ebe121d112/jd-match-drawer-invite.png";
        await page.screenshot({ path: inviteScreenshotPath, fullPage: true });
        console.log("Saved invite screenshot to", inviteScreenshotPath);
      }
    } else {
      console.error("Drawer dialog not found after clicking button!");
    }
  } else {
    console.error("AI Agent 助手 button not found in header!");
  }

  await browser.close();
  console.log("Done.");
}

main().catch((err) => {
  console.error("Verification script error:", err);
  process.exit(1);
});
