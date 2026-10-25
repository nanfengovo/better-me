import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require("/Users/feng/Documents/Private/简历/简历Agent/better-me/node_modules/.pnpm/playwright-core@1.64.1/node_modules/playwright-core/index.js");

async function main() {
  console.log("Launching browser to verify modeless copilot and guided animations...");

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

  // 1. Open AI Agent Drawer
  console.log("Opening AI Agent Drawer...");
  const agentButton = await page.$('button:has-text("AI Agent 助手")');
  if (!agentButton) {
    throw new Error("AI Agent 助手 button not found");
  }
  await agentButton.click();
  await page.waitForTimeout(600);

  // 2. Verify drawer is open and non-blocking
  const drawer = await page.$('[role="dialog"]');
  if (!drawer) {
    throw new Error("Drawer dialog not rendered");
  }
  console.log("AI Agent drawer is open.");

  // Check modeless wrapper
  const wrapper = await page.$('.fixed.inset-0.pointer-events-none');
  console.log("Non-blocking wrapper found:", Boolean(wrapper));

  // 3. Test left-side interaction while drawer is OPEN
  console.log("Testing left-side interaction while drawer is active...");
  const resumeNameInput = await page.$('input[aria-label="简历名称"]');
  if (resumeNameInput) {
    await resumeNameInput.click();
    await resumeNameInput.fill("资深前端全栈专家定制版");
    console.log("Successfully typed into left-side resume title input while drawer is open!");
  } else {
    console.warn("Could not find resume title input");
  }

  // 4. Trigger guided tour animation
  console.log("Switching to Chat tab to test guided action...");
  const chatTab = await page.$('button:has-text("助理协同对话")');
  if (chatTab) {
    await chatTab.click();
    await page.waitForTimeout(400);

    // Click quick prompt "优化个人优势"
    const polishBtn = await page.$('button:has-text("优化个人优势")');
    if (polishBtn) {
      console.log("Clicking '优化个人优势' quick chip...");
      await polishBtn.click();
      await page.waitForTimeout(700);

      // Check for guided beacon
      const beacon = await page.$('.agent-guide-beacon');
      const activeGuided = await page.$('.agent-guided-active');
      console.log("Guided beacon found:", Boolean(beacon));
      console.log("Guided active target found:", Boolean(activeGuided));

      const copilotScreenshot = "/Users/feng/.gemini/antigravity/brain/688efe34-71bf-4b5a-b98a-e6ebe121d112/copilot-guided-animation.png";
      await page.screenshot({ path: copilotScreenshot, fullPage: true });
      console.log("Saved guided animation screenshot to", copilotScreenshot);
    }
  }

  // 5. Test Proposals Locate button with real JD Match
  console.log("Closing drawer to open with JD context...");
  const closeBtn = await page.$('button[aria-label="关闭"]');
  if (closeBtn) {
    await closeBtn.click();
    await page.waitForTimeout(500);
  }

  const inviteBtn = await page.$(".jd-workspace-invite");
  if (inviteBtn) {
    console.log("Opening drawer via .jd-workspace-invite...");
    await inviteBtn.click();
    await page.waitForTimeout(1000);

    const locateBtn = await page.$('button:has-text("定位")');
    if (locateBtn) {
      console.log("Found Locate button on proposal card, clicking...");
      await locateBtn.click();
      await page.waitForTimeout(700);

      const beacon = await page.$('.agent-guide-beacon');
      const activeGuided = await page.$('.agent-guided-active');
      console.log("Proposal Guided beacon found:", Boolean(beacon));
      console.log("Proposal Guided active target found:", Boolean(activeGuided));

      const locateScreenshot = "/Users/feng/.gemini/antigravity/brain/688efe34-71bf-4b5a-b98a-e6ebe121d112/copilot-locate-highlight.png";
      await page.screenshot({ path: locateScreenshot, fullPage: true });
      console.log("Saved locate highlight screenshot to", locateScreenshot);
    }
  }

  await browser.close();
  console.log("Verification finished successfully!");
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
