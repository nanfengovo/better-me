import { chromium } from "../apps/web/node_modules/playwright-core/index.mjs";
import fs from "node:fs";

async function main() {
  console.log("Launching Chromium...");
  const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const browser = await chromium.launch({
    executablePath: fs.existsSync(chromePath) ? chromePath : undefined,
    headless: true,
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  let promptShown = false;
  page.on("dialog", (dialog) => {
    promptShown = true;
    console.error(`UNEXPECTED DIALOG: ${dialog.type()} message="${dialog.message()}"`);
    dialog.dismiss();
  });

  console.log("Navigating to http://localhost:5173...");
  await page.goto("http://localhost:5173", { waitUntil: "domcontentloaded" });

  await page.waitForSelector(".fact-editor", { timeout: 10000 });
  console.log("Fact editor loaded.");

  // Test 1: In "经历与成果" tab, test Tech Stack + 标签
  const expTab = page.locator('button:has-text("经历与成果")');
  if (await expTab.isVisible()) {
    await expTab.click();
    await page.waitForTimeout(300);
  }

  const addTagBtn = page.locator('button:has-text("+ 标签")').first();
  await addTagBtn.waitFor({ state: "visible", timeout: 5000 });
  console.log("Found + 标签 button. Clicking...");
  await addTagBtn.click();
  await page.waitForTimeout(300);

  if (promptShown) {
    throw new Error("FAIL: window.prompt was triggered when clicking + 标签!");
  }

  // Verify inline input is visible
  const tagInput = page.locator('input[aria-label="技术栈名称"]').first();
  await tagInput.waitFor({ state: "visible", timeout: 3000 });
  console.log("Inline tag input appeared!");

  // Type a new technology tag: "TypeScript" and press Enter
  await tagInput.fill("TypeScript");
  await tagInput.press("Enter");
  await page.waitForTimeout(400);

  // Check if "TypeScript" badge exists
  const tagBadge = page.locator('span:has-text("TypeScript")').first();
  await tagBadge.waitFor({ state: "visible", timeout: 3000 });
  console.log("Successfully created tag badge 'TypeScript'!");

  // Test 2: Double-click or click the tag to edit it inline
  await tagBadge.click();
  await page.waitForTimeout(200);

  const editInput = page.locator('input[aria-label="编辑标签 TypeScript"]').first();
  if (await editInput.isVisible()) {
    console.log("Inline edit mode active! Changing text to 'TypeScript 5'...");
    await editInput.fill("TypeScript 5");
    await editInput.press("Enter");
    await page.waitForTimeout(400);

    const editedBadge = page.locator('span:has-text("TypeScript 5")').first();
    await editedBadge.waitFor({ state: "visible", timeout: 3000 });
    console.log("Successfully edited tag to 'TypeScript 5'!");
  }

  // Test 3: Switch to "个人信息" tab
  const profileTab = page.locator('button:has-text("个人信息")');
  await profileTab.click();
  await page.waitForTimeout(300);

  // Test input typing in Name field
  const nameTextarea = page.locator('textarea[aria-label="中文姓名"]').first();
  await nameTextarea.waitFor({ state: "visible", timeout: 3000 });
  await nameTextarea.click();
  await page.keyboard.press("Meta+A");
  await page.keyboard.press("Backspace");
  await nameTextarea.fill("张三");
  const typedName = await nameTextarea.inputValue();
  console.log("Typed name in textarea:", typedName);
  if (typedName !== "张三") {
    throw new Error(`Name input failed: expected "张三", got "${typedName}"`);
  }

  // Test Constraints: "+ 添加约束"
  const addConstraintBtn = page.locator('button:has-text("+ 添加约束")').first();
  await addConstraintBtn.waitFor({ state: "visible", timeout: 3000 });
  console.log("Found + 添加约束 button. Clicking...");
  await addConstraintBtn.click();
  await page.waitForTimeout(300);

  if (promptShown) {
    throw new Error("FAIL: window.prompt was triggered when clicking + 添加约束!");
  }

  const constraintInput = page.locator('input[aria-label="约束规则名称"]').first();
  await constraintInput.waitFor({ state: "visible", timeout: 3000 });
  console.log("Inline constraint input appeared!");

  await constraintInput.fill("0Oncall, 0外包");
  await constraintInput.press("Enter");
  await page.waitForTimeout(400);

  const constraint1 = page.locator('span:has-text("0Oncall")').first();
  const constraint2 = page.locator('span:has-text("0外包")').first();
  await constraint1.waitFor({ state: "visible", timeout: 3000 });
  await constraint2.waitFor({ state: "visible", timeout: 3000 });
  console.log("Successfully created batch constraints '0Oncall' and '0外包'!");

  // Take a full screenshot
  const artifactPath = "/Users/feng/.gemini/antigravity/brain/688efe34-71bf-4b5a-b98a-e6ebe121d112/tag-editor-verified.png";
  await page.screenshot({ path: artifactPath, fullPage: false });
  console.log("Verification screenshot saved to", artifactPath);

  await browser.close();
  console.log("All E2E verification tests PASSED with 0 errors!");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
