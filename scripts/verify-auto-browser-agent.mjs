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

  // Switch to Agent Workspace
  console.log("Switching to Agent Workspace...");
  const agentNavBtn = page.locator('button[aria-label*="AI 顾问工作台"], button:has-text("AI Agent 助手"), button:has-text("顾问")').first();
  await agentNavBtn.click();
  await page.waitForTimeout(1000);

  // If in matched state, click "更换岗位 / 编辑 JD"
  const editJdBtn = page.locator('button:has-text("更换岗位 / 编辑 JD")');
  if (await editJdBtn.isVisible()) {
    console.log("Clicking 更换岗位 / 编辑 JD...");
    await editJdBtn.click();
    await page.waitForTimeout(500);
  }

  // Open "读取链接填入"
  const linkImportBtn = page.locator('button:has-text("读取链接填入")');
  await linkImportBtn.waitFor({ state: "visible", timeout: 5000 });
  await linkImportBtn.click();
  await page.waitForTimeout(500);

  // Input the user's exact short BOSS URL
  const inputSelector = 'textarea[placeholder*="粘贴 BOSS直聘"], textarea[placeholder*="粘贴岗位链接"]';
  const linkInput = page.locator(inputSelector);
  await linkInput.waitFor({ state: "visible", timeout: 5000 });

  const rawUserLink = "job/789ad05bba32b1b60nV72du4GFtQ?date8=20261021&sid=tosee_jd_2f369260e93318930nJy3t69EItV&openWeapp=1&fromSource=2";
  console.log("Entering user short BOSS link:", rawUserLink);
  await linkInput.fill(rawUserLink);
  await page.waitForTimeout(400);

  // Take screenshot of panel with the new "自动操作浏览器" button
  const panelPath = path.join(ARTIFACTS_DIR, "auto-browser-agent-panel.png");
  await page.screenshot({ path: panelPath });
  console.log("Saved panel screenshot:", panelPath);

  // Check the "自动操作浏览器" button is present
  const autoBrowserBtn = page.locator('button:has-text("自动操作浏览器")');
  await autoBrowserBtn.waitFor({ state: "visible", timeout: 3000 });
  console.log("Found '自动操作浏览器' button! Clicking it...");
  await autoBrowserBtn.click();

  // Wait for extraction to complete (up to 30s)
  console.log("Waiting for auto-browser extraction to populate form...");
  const titleInput = page.locator('input[placeholder*="例如：资深前端工程师"]');
  
  // Wait until title input has value
  await page.waitForFunction(() => {
    const input = document.querySelector('input[placeholder*="例如：资深前端工程师"]');
    return input && input.value && input.value.trim().length > 0;
  }, { timeout: 35000 });

  const titleVal = await titleInput.inputValue();
  const companyVal = await page.locator('input[placeholder*="例如：字节跳动"]').inputValue();
  const salaryVal = await page.locator('input[placeholder*="例如：35k-50k"]').inputValue();
  const locationVal = await page.locator('input[placeholder*="例如：上海"]').inputValue();
  const descVal = await page.locator('textarea[placeholder*="请在此粘贴招聘 JD"]').inputValue();

  console.log("\n=== SUCCESS! AUTO-BROWSER EXTRACTED DATA ===");
  console.log(`- 职位名称: ${titleVal}`);
  console.log(`- 目标公司: ${companyVal}`);
  console.log(`- 薪资待遇: ${salaryVal || "(面议/平台未公开)"}`);
  console.log(`- 工作地点: ${locationVal}`);
  console.log(`- JD 详情长度: ${descVal.length} 字符`);
  console.log(`- JD 正文预览: ${descVal.slice(0, 150)}...\n`);

  // Capture screenshot of light mode populated
  const lightPath = path.join(ARTIFACTS_DIR, "auto-browser-populated-light.png");
  await page.screenshot({ path: lightPath });
  console.log("Saved light mode screenshot:", lightPath);

  // Switch to dark mode
  await page.evaluate(() => {
    document.documentElement.classList.add("dark");
  });
  await page.waitForTimeout(500);

  // Capture screenshot of dark mode populated
  const darkPath = path.join(ARTIFACTS_DIR, "auto-browser-populated-dark.png");
  await page.screenshot({ path: darkPath });
  console.log("Saved dark mode screenshot:", darkPath);

  await browser.close();
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
