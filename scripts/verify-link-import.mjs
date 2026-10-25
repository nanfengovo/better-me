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
  await page.waitForTimeout(1200);

  // If already in matched state, click "更换岗位 / 编辑 JD"
  const editJdBtn = page.locator('button:has-text("更换岗位 / 编辑 JD")');
  if (await editJdBtn.isVisible()) {
    console.log("Clicking 更换岗位 / 编辑 JD...");
    await editJdBtn.click();
    await page.waitForTimeout(500);
  }

  // Verify the "读取链接填入" button is visible
  const linkImportBtn = page.locator('button:has-text("读取链接填入")');
  await linkImportBtn.waitFor({ state: "visible", timeout: 5000 });
  console.log("Found '读取链接填入' button!");

  // Click "读取链接填入"
  await linkImportBtn.click();
  await page.waitForTimeout(600);

  // Capture screenshot of the opened Link Import panel
  const panelOpenScreenshotPath = path.join(ARTIFACTS_DIR, "link-import-panel-opened.png");
  await page.screenshot({ path: panelOpenScreenshotPath, fullPage: false });
  console.log(`Saved screenshot: ${panelOpenScreenshotPath}`);

  // Find link textarea and enter share text
  const linkInput = page.locator('textarea[placeholder*="粘贴 BOSS直聘"], textarea[placeholder*="粘贴岗位链接"]');
  await linkInput.waitFor({ state: "visible", timeout: 5000 });

  const shareText = `【杭州】高级前端技术架构师 某头部创新科技集团
薪资范围：40k-65k · 16薪
工作地点：杭州 · 余杭区梦想小镇
岗位职责：
1. 负责新一代 AI Agent 架构体系建设与全栈工程落地；
2. 推进微前端平台与高并发中台治理，核心页面秒开率达 99.8%；
3. 带领核心前端攻坚团队，主导技术方案评审与技术演进路线。

任职要求：
1. 5 年以上前端/全栈架构研发经验，深入理解 React/TypeScript/Node.js 生态；
2. 具备优秀的高并发与工程化架构设计能力；
3. 有大型知名互联网或前沿 AI 公司核心架构背景者优先。`;

  console.log("Filling in link input with share text...");
  await linkInput.fill(shareText);
  await page.waitForTimeout(300);

  // Click "读取并自动填入"
  const extractBtn = page.locator('button:has-text("读取并自动填入")');
  console.log("Clicking '读取并自动填入'...");
  await extractBtn.click();
  await page.waitForTimeout(1200);

  // Verify fields
  const titleVal = await page.locator('input[placeholder*="例如：资深前端工程师"]').inputValue();
  const companyVal = await page.locator('input[placeholder*="例如：字节跳动"]').inputValue();
  const salaryVal = await page.locator('input[placeholder*="例如：35k-50k"]').inputValue();
  const locationVal = await page.locator('input[placeholder*="例如：上海"]').inputValue();
  const descVal = await page.locator('textarea[placeholder*="请在此粘贴招聘 JD"]').inputValue();

  console.log("Auto-populated fields:");
  console.log(`- 职位名称: ${titleVal}`);
  console.log(`- 目标公司: ${companyVal}`);
  console.log(`- 薪资范围: ${salaryVal}`);
  console.log(`- 工作地点: ${locationVal}`);
  console.log(`- JD 长度: ${descVal.length} 字符`);

  // Capture screenshot of light mode with populated fields
  const lightFilledScreenshotPath = path.join(ARTIFACTS_DIR, "link-import-populated-light.png");
  await page.screenshot({ path: lightFilledScreenshotPath, fullPage: false });
  console.log(`Saved screenshot: ${lightFilledScreenshotPath}`);

  // Switch to Dark mode to verify theme adaptation
  console.log("Testing Dark Mode...");
  await page.evaluate(() => {
    document.documentElement.classList.add("dark");
    const pref = localStorage.getItem("betterme.ui-preferences.v1");
    if (pref) {
      try {
        const parsed = JSON.parse(pref);
        parsed.theme = "dark";
        localStorage.setItem("betterme.ui-preferences.v1", JSON.stringify(parsed));
      } catch {}
    }
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(600);

  const darkAgentNavBtn = page.locator('button[aria-label*="AI 顾问工作台"], button:has-text("AI Agent 助手"), button:has-text("顾问")').first();
  await darkAgentNavBtn.click();
  await page.waitForTimeout(800);

  const darkEditBtn = page.locator('button:has-text("更换岗位 / 编辑 JD")');
  if (await darkEditBtn.isVisible()) {
    await darkEditBtn.click();
    await page.waitForTimeout(500);
  }

  const darkLinkImportBtn = page.locator('button:has-text("读取链接填入")');
  if (await darkLinkImportBtn.isVisible()) {
    await darkLinkImportBtn.click();
    await page.waitForTimeout(500);
  }

  const darkFilledScreenshotPath = path.join(ARTIFACTS_DIR, "link-import-populated-dark.png");
  await page.screenshot({ path: darkFilledScreenshotPath, fullPage: false });
  console.log(`Saved screenshot: ${darkFilledScreenshotPath}`);

  await browser.close();
  console.log("Verification completed successfully!");
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
