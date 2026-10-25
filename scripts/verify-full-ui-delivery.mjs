import { chromium } from "../apps/web/node_modules/playwright-core/index.mjs";
import fs from "node:fs";
import path from "node:path";

const ARTIFACTS_DIR = "/Users/feng/.gemini/antigravity/brain/688efe34-71bf-4b5a-b98a-e6ebe121d112";

async function main() {
  const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const browser = await chromium.launch({
    executablePath: fs.existsSync(chromePath) ? chromePath : undefined,
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  console.log("Navigating to http://localhost:5173 ...");
  await page.goto("http://localhost:5173", { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);

  // Switch to Agent workspace
  console.log("Switching to Agent Workspace...");
  const agentNavBtn = page.locator('button[aria-label*="AI 顾问工作台"], button:has-text("AI Agent 助手"), button:has-text("顾问")').first();
  await agentNavBtn.click();
  await page.waitForTimeout(1000);

  // If in active matched state, click "更换岗位 / 编辑 JD" or "编辑岗位" to enter setup view
  const editJdBtn = page.locator('button:has-text("更换岗位 / 编辑 JD"), button:has-text("编辑岗位")').first();
  if (await editJdBtn.isVisible()) {
    console.log("Entering Setup/Edit view...");
    await editJdBtn.click();
    await page.waitForTimeout(600);
  }

  // Ensure graphite theme and dark mode
  const themeSelect = page.locator('.workspace-theme-picker select, select:has(option:has-text("石墨工坊"))').first();
  if (await themeSelect.isVisible()) {
    await themeSelect.selectOption("graphite");
    await page.waitForTimeout(400);
  }
  const darkThemeBtn = page.locator('button:has-text("深色")').first();
  if (await darkThemeBtn.isVisible()) {
    await darkThemeBtn.click();
    await page.waitForTimeout(600);
  }

  // Open Link Import panel to showcase comfortable vertical textarea & clear buttons
  const linkToggleBtn = page.locator('button:has-text("读取链接填入")').first();
  if (await linkToggleBtn.isVisible()) {
    await linkToggleBtn.click();
    await page.waitForTimeout(500);
  }

  // 1. Capture Setup View with open Link panel
  const setupShot = path.join(ARTIFACTS_DIR, "agent-workspace-setup-dark.png");
  await page.screenshot({ path: setupShot, fullPage: false });
  console.log(`Saved screenshot: ${setupShot}`);

  // 2. Demonstrate Dragging Splitter
  const splitter = page.locator('[role="separator"]').first();
  if (await splitter.isVisible()) {
    const box = await splitter.boundingBox();
    if (box) {
      console.log("Dragging splitter to 38% width...");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x - 120, box.y + box.height / 2, { steps: 10 });
      await page.waitForTimeout(300);
      const splitDragShot = path.join(ARTIFACTS_DIR, "agent-workspace-drag-split.png");
      await page.screenshot({ path: splitDragShot, fullPage: false });
      console.log(`Saved screenshot: ${splitDragShot}`);
      await page.mouse.up();
      await page.waitForTimeout(400);
    }
  }

  // 3. Demonstrate Collapsing Panels (Pipeline & Inspector)
  const foldPipelineBtn = page.locator('button:has-text("收起指引")').first();
  if (await foldPipelineBtn.isVisible()) {
    await foldPipelineBtn.click();
    await page.waitForTimeout(300);
  }
  const foldInspectorBtn = page.locator('button:has-text("收起视窗")').first();
  if (await foldInspectorBtn.isVisible()) {
    await foldInspectorBtn.click();
    await page.waitForTimeout(300);
  }
  const foldedShot = path.join(ARTIFACTS_DIR, "agent-workspace-folded-panels.png");
  await page.screenshot({ path: foldedShot, fullPage: false });
  console.log(`Saved screenshot: ${foldedShot}`);

  // Restore fold
  if (await foldPipelineBtn.isVisible()) await foldPipelineBtn.click();
  if (await foldInspectorBtn.isVisible()) await foldInspectorBtn.click();

  // Pick a sample job to populate fields
  const sampleCard = page.locator('div:has-text("资深前端/全栈架构师")').last();
  if (await sampleCard.isVisible()) {
    await sampleCard.click();
    await page.waitForTimeout(600);
  }

  const setupPopulatedShot = path.join(ARTIFACTS_DIR, "agent-workspace-setup-populated.png");
  await page.screenshot({ path: setupPopulatedShot, fullPage: false });
  console.log(`Saved screenshot: ${setupPopulatedShot}`);

  // 4. Submit and enter Active View
  const submitBtn = page.locator('button:has-text("开始智能拆解与匹配分析"), button:has-text("保存并重新分析")').first();
  if (await submitBtn.isVisible()) {
    console.log("Submitting JD to enter Active View...");
    await submitBtn.click();
    await page.waitForTimeout(3000);
  }

  // Active View (normal)
  const activeDarkShot = path.join(ARTIFACTS_DIR, "agent-workspace-active-dark.png");
  await page.screenshot({ path: activeDarkShot, fullPage: false });
  console.log(`Saved screenshot: ${activeDarkShot}`);

  // 5. Active View with JD Folded (giving full space to Copilot!)
  const foldJdBtn = page.locator('button:has-text("收起JD")').first();
  if (await foldJdBtn.isVisible()) {
    console.log("Collapsing JD section in Active View...");
    await foldJdBtn.click();
    await page.waitForTimeout(500);
    const activeJdFoldedShot = path.join(ARTIFACTS_DIR, "agent-workspace-active-jd-folded.png");
    await page.screenshot({ path: activeJdFoldedShot, fullPage: false });
    console.log(`Saved screenshot: ${activeJdFoldedShot}`);
  }

  await browser.close();
  console.log("All verification screenshots captured successfully!");
}

main().catch((err) => {
  console.error("Error in delivery verification:", err);
  process.exit(1);
});
