import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require("/Users/feng/Documents/Private/简历/简历Agent/better-me/node_modules/.pnpm/playwright-core@1.64.1/node_modules/playwright-core/index.js");

async function main() {
  console.log("Launching browser for Agent Workspace visual verification...");

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

  // Pre-seed Graphite theme in light mode (user's setting)
  await page.addInitScript(() => {
    localStorage.setItem(
      "betterme.ui.preferences.v1",
      JSON.stringify({ locale: "zh", theme: "light", workspaceThemeId: "graphite" })
    );
  });

  console.log("Navigating to http://localhost:5173...");
  await page.goto("http://localhost:5173", { waitUntil: "networkidle", timeout: 15000 });
  await page.waitForSelector(".studio-header", { timeout: 10000 });

  // 1. Click rail button '顾问' to enter full-page Agent Workspace
  console.log("Locating rail button '顾问'...");
  const railAgentBtn = await page.$('.studio-rail button:has-text("顾问")');
  if (!railAgentBtn) {
    throw new Error("Rail button '顾问' not found");
  }
  await railAgentBtn.click();
  await page.waitForTimeout(1000);

  // 2. Click '载入范例岗位 JD' to fill sample data
  const loadSampleBtn = await page.$('button:has-text("载入范例岗位 JD")');
  if (loadSampleBtn) {
    console.log("Clicking '载入范例岗位 JD'...");
    await loadSampleBtn.click();
    await page.waitForTimeout(500);
  }

  // 3. Click '开始智能拆解与匹配分析'
  const startMatchBtn = await page.$('button:has-text("开始智能拆解与匹配分析")');
  if (startMatchBtn) {
    console.log("Clicking '开始智能拆解与匹配分析'...");
    await startMatchBtn.click();
    // Wait for matching analysis to complete
    await page.waitForTimeout(3500);
  }

  // Screenshot 1: Light mode matched dashboard (Full JD reader + proposals + dial)
  const screenshot1 = "/Users/feng/.gemini/antigravity/brain/688efe34-71bf-4b5a-b98a-e6ebe121d112/agent-workspace-light-matched.png";
  await page.screenshot({ path: screenshot1, fullPage: true });
  console.log("Saved Light mode matched dashboard screenshot to", screenshot1);

  // 4. Click 'JD' toggle pill to see Full JD view (100% height left column)
  const jdPill = page.locator('button[title="仅看完整 JD"]');
  if (await jdPill.isVisible()) {
    console.log("Clicking 'JD' toggle pill for Full-height JD reader view...");
    await jdPill.click();
    await page.waitForTimeout(500);

    const screenshotFullJd = "/Users/feng/.gemini/antigravity/brain/688efe34-71bf-4b5a-b98a-e6ebe121d112/agent-workspace-full-jd-view.png";
    await page.screenshot({ path: screenshotFullJd, fullPage: true });
    console.log("Saved Full JD view screenshot to", screenshotFullJd);

    // Switch back to '协同' split mode
    const splitPill = page.locator('button[title="协同并排视图"]');
    if (await splitPill.isVisible()) {
      await splitPill.click();
      await page.waitForTimeout(500);
    }
  }

  // 5. Test clicking '定位' on first proposal to open animated Diff popover
  const locateBtn = page.locator('button:has-text("定位")').first();
  if (await locateBtn.isVisible()) {
    console.log("Clicking '定位' on first proposal to open animated diff preview popover...");
    await locateBtn.click();
    await page.waitForTimeout(800);

    const screenshotDiff = "/Users/feng/.gemini/antigravity/brain/688efe34-71bf-4b5a-b98a-e6ebe121d112/agent-workspace-diff-popover.png";
    await page.screenshot({ path: screenshotDiff, fullPage: true });
    console.log("Saved Diff popover screenshot to", screenshotDiff);
  }

  // 6. Test Chat message submission
  const chatInput = await page.$('input[placeholder*="向 Agent 提问"]');
  if (chatInput) {
    console.log("Typing in copilot chat input...");
    await chatInput.fill("请结合本 JD 职责，评估我的微服务架构经验是否对口");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2500);

    const screenshotChat = "/Users/feng/.gemini/antigravity/brain/688efe34-71bf-4b5a-b98a-e6ebe121d112/agent-workspace-chat-interaction.png";
    await page.screenshot({ path: screenshotChat, fullPage: true });
    console.log("Saved chat interaction screenshot to", screenshotChat);
  }

  // 7. Test Dark Mode theme adaptation
  console.log("Switching theme to Dark mode...");
  await page.evaluate(() => {
    const nextPref = { locale: "zh", theme: "dark", workspaceThemeId: "graphite" };
    localStorage.setItem("betterme.ui.preferences.v1", JSON.stringify(nextPref));
    window.dispatchEvent(new StorageEvent("storage", {
      key: "betterme.ui.preferences.v1",
      newValue: JSON.stringify(nextPref)
    }));
  });
  await page.waitForTimeout(1000);

  const screenshotDark = "/Users/feng/.gemini/antigravity/brain/688efe34-71bf-4b5a-b98a-e6ebe121d112/agent-workspace-dark-matched.png";
  await page.screenshot({ path: screenshotDark, fullPage: true });
  console.log("Saved Dark mode matched dashboard screenshot to", screenshotDark);

  // Switch back to light theme for normal user flow
  await page.evaluate(() => {
    const nextPref = { locale: "zh", theme: "light", workspaceThemeId: "graphite" };
    localStorage.setItem("betterme.ui.preferences.v1", JSON.stringify(nextPref));
    window.dispatchEvent(new StorageEvent("storage", {
      key: "betterme.ui.preferences.v1",
      newValue: JSON.stringify(nextPref)
    }));
  });
  await page.waitForTimeout(500);

  // 8. Click '采纳' on first proposal and test '一键应用到当前定制简历'
  const acceptBtn = page.getByRole("button", { name: "采纳", exact: true }).first();
  if (await acceptBtn.isVisible()) {
    console.log("Clicking '采纳' on first proposal...");
    await acceptBtn.click();
    await page.waitForTimeout(600);
  }

  const applyBtn = page.locator('button:has-text("一键应用到当前定制简历")').first();
  if (await applyBtn.isVisible()) {
    console.log("Clicking '一键应用到当前定制简历'...");
    await applyBtn.click();
    await page.waitForTimeout(2000);

    const screenshotApplied = "/Users/feng/.gemini/antigravity/brain/688efe34-71bf-4b5a-b98a-e6ebe121d112/agent-workspace-applied-resume.png";
    await page.screenshot({ path: screenshotApplied, fullPage: true });
    console.log("Saved applied resume screenshot to", screenshotApplied);
  }

  await browser.close();
  console.log("Agent Workspace visual verification completed successfully!");
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
