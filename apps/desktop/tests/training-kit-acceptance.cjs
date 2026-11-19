/* Isolated, opt-in UI acceptance. No installed profile, account, or cloud credentials. */
const assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");
const { createRequire } = require("node:module");
const repo = path.resolve(__dirname, "../../.."),
  hostRequire = createRequire(path.join(repo, "apps/agent-host/package.json"));
const { chromium, _electron } = hostRequire("playwright-core");
const electron = createRequire(path.join(repo, "apps/desktop/package.json"))(
  "electron",
);
const url = "http://127.0.0.1:5336",
  pagePath = "/tests/ui-lab/learning-path.html";
const state = async () => {
  const r = await fetch(url + "/__growth-loop-qa/state");
  assert.ok(r.ok);
  const s = await r.json();
  assert.match(path.basename(s.directory), /^betterme-growth-browser-/);
  assert.equal(
    await fs.realpath(path.dirname(s.directory)),
    await fs.realpath(os.tmpdir()),
  );
  return s;
};
const qa = async (route) => {
  await state();
  assert.ok(
    (await fetch(url + "/__growth-loop-qa/" + route, { method: "POST" })).ok,
  );
};
const button = (page, name) => page.getByRole("button", { name, exact: true });
const panel = (page) => page.getByRole("region", { name: "按需训练工坊" });
const click = async (page, name) => {
  await button(page, name).click();
};
async function workshop(p) {
  await click(p, "按需训练工坊");
  await panel(p).waitFor();
}
async function waitForStep(p, label, timeout) {
  await Promise.race([
    button(p, label).waitFor({ timeout }),
    panel(p)
      .getByRole("alert")
      .waitFor({ timeout })
      .then(async () => {
        throw Error(
          "Training did not advance: " +
            (await panel(p).getByRole("alert").innerText()),
        );
      }),
  ]);
}
async function newKit(p, kind) {
  await panel(p).getByText("只体验，不调用模型", { exact: true }).click();
  await click(p, kind === "canvas" ? "一分钟汇报" : kind === "rewrite" ? "英文邮件改写" : "项目排期推演");
  await click(p, "试用示例工具");
  await waitForStep(p, "保留此版本", 220000);
  return (await panel(p).getByRole("heading", { level: 2 }).innerText()).trim();
}
// Exercise the authored controls as delivered. Real local models can choose a
// different interaction for the same learning goal on another verified model build.
async function newStudio(p) {
  await p.getByLabel("想提升什么？").fill("希望按现场约束安排舞台换景、遮幕和灯光交接，每次换情境再练一次");
  await click(p, "同意并分析难点");
  await waitForStep(p, "认可方向，构建试用版", 150000);
  await click(p, "认可方向，构建试用版");
  await waitForStep(p, "保留此版本", 220000);
  const region = panel(p);
  for (const order of await region.getByRole("button", { name: "采用当前顺序" }).all()) await order.click();
  for (const input of await region.getByRole("spinbutton").all()) await input.fill("10");
  for (const input of await region.getByRole("textbox").all()) {
    const isCode = await input.evaluate(el => el.classList.contains("training-code"));
    await input.fill(isCode ? "input => input" : "先对照遮幕、灯光与换景的交接要求，核对在场人员。");
  }
  await click(p, "提交本次作答");
  await region.getByRole("region", { name: "逐项反馈" }).waitFor();
  await click(p, "保留此版本");
  await region.getByRole("button", { name: "按这条建议继续练" }).first().waitFor();
  return (await region.getByRole("heading", { level: 2 }).innerText()).trim();
}
async function openSaved(p, title) {
  const b = panel(p)
    .getByRole("button")
    .filter({ hasText: title + " · v" });
  await b.click();
  await panel(p).getByRole("heading", { name: title, exact: true }).waitFor();
}
(async () => {
  assert.ok(
    process.argv.includes("--isolated"),
    "Pass --isolated with the dedicated learning-path lab running.",
  );
  const real = process.argv.includes("--real-local");
  await state();
  const dir = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "betterme-learning-electron-"),
  );
  const output = await fs.mkdtemp(
    path.join(
      await fs
        .mkdir(path.join(repo, "output/playwright"), { recursive: true })
        .then(() => path.join(repo, "output/playwright")),
      "training-kits-",
    ),
  );
  let browser, desktop;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1040, height: 810 },
    });
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === url
        ? route.continue()
        : route.abort(),
    );
    const web = await context.newPage();
    await web.goto(url + pagePath);
    await workshop(web);
    const email = await newKit(web, "rewrite");
    const text = panel(web).getByRole("textbox", { name: "你的英文邮件" });
    const originalEmail = await panel(web)
      .locator(".training-data li")
      .first()
      .innerText();
    assert.doesNotMatch(originalEmail, /\bthe the\b/i);
    await text.fill("Could you please send the report by Friday?");
    await click(web, "提交本次作答");
    await web.getByText(/换题复测开放于/).waitFor();
    await click(web, "保留此版本");
    await web.getByText(/已保留这个版本/).waitFor();
    await panel(web).screenshot({ path: path.join(output, "web-email.png") });
    const before = (await state()).paths.length;
    desktop = await _electron.launch({
      executablePath: electron,
      cwd: repo,
      args: [
        path.join(__dirname, "learning-path-entry.cjs"),
        "--directory=" + dir,
        "--preload=" + path.join(repo, "apps/desktop/dist/preload/index.cjs"),
        "--port=5336",
      ],
    });
    const native = await desktop.firstWindow();
    await workshop(native);
    await openSaved(native, email);
    await native.getByText(/换题复测开放于/).waitFor();
    assert.equal(
      (await state()).paths
        .slice(before)
        .filter((s) => s.startsWith("POST ") && s.includes("/growth/")).length,
      0,
    );
    await qa("advance-week");
    await click(native, "查看是否到期");
    await native.getByRole("heading", { name: /换题复测 ·/ }).waitFor();
    assert.notEqual(
      await panel(native).locator(".training-data li").first().innerText(),
      originalEmail,
    );
    await panel(native)
      .getByRole("textbox")
      .fill("Please confirm the budget by Monday.");
    await click(native, "提交本次作答");
    await panel(native).getByText("原答与练习记录 · 2").waitFor();
    await click(native, "返回工坊");
    const schedule = await newKit(native, "dependency");
    const slider = panel(native).getByRole("slider");
    await slider.press("Home");
    for (let i = 0; i < 5; i++) await slider.press("ArrowRight");
    await panel(native)
      .getByRole("spinbutton", { name: /多少天/ })
      .fill("9");
    await click(native, "试算反馈（记录使用提示）");
    await native
      .getByText(/你的预测：9 天/)
      .first()
      .waitFor();
    await click(native, "提交本次作答");
    await native.getByText(/换题复测开放于/).waitFor();
    await click(native, "保留此版本");
    await native.getByText(/已保留这个版本/).waitFor();
    await panel(native).screenshot({
      path: path.join(output, "desktop-schedule.png"),
    });
    await qa("restart-host");
    const restoredAt = (await state()).paths.length;
    await web.reload();
    await workshop(web);
    await openSaved(web, schedule);
    await web.getByText(/换题复测开放于/).waitFor();
    assert.equal(
      (await state()).paths
        .slice(restoredAt)
        .filter((s) => s.startsWith("POST ") && s.includes("/growth/")).length,
      0,
    );
    assert.equal(await panel(web).getByRole("slider").inputValue(), "5");
    assert.equal(await panel(web).getByRole("spinbutton").inputValue(), "9");
    await web.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await web.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await panel(web).screenshot({
      path: path.join(output, "narrow-schedule.png"),
    });
    await click(web, "舍弃此版本");
    await click(web, "确认停用此版本");
    await web.getByText("此版本已移出，不再可运行。").waitFor();
    await openSaved(web, email);
    await panel(web).getByText("原答与练习记录 · 2").waitFor();
    await click(web, "返回工坊");
    await web.setViewportSize({ width: 1040, height: 810 });
    const canvas = await newKit(web, "canvas");
    const writers = panel(web).getByRole("textbox"),
      choices = panel(web).getByRole("combobox");
    assert.ok((await writers.count()) > 0);
    for (const writer of await writers.all())
      await writer.fill("先说一句话，再用手边的书作比喻。");
    for (const choice of await choices.all())
      await choice.selectOption({ index: 1 });
    await click(web, "提交本次作答");
    await panel(web)
      .getByText(/不评分专业能力/)
      .first()
      .waitFor();
    await click(web, "保留此版本");
    await web.getByText(/已保留这个版本/).waitFor();
    await panel(web).screenshot({ path: path.join(output, "web-canvas.png") });
    let studio;
    if (real) {
      await click(web, "返回工坊");
      studio = await newStudio(web);
      await panel(web).screenshot({ path: path.join(output, "web-studio.png") });
      await click(web, "返回工坊");
      await openSaved(web, studio);
      await panel(web).getByRole("button", { name: "按这条建议继续练" }).first().click();
      await panel(web).getByText("移除作答引用", { exact: true }).waitFor();
    }
    const receipt = {
      engine: real ? "built-in-examples-and-local-studio" : "built-in-examples",
      studio,
      email,
      schedule,
      canvas,
      web: true,
      nativeElectron: true,
      restoredSubmittedInputs: true,
      restoredWithoutGrowthPost: true,
      changedRetest: true,
      retiredOnlySelectedVersion: true,
      viewport390: true,
      output,
    };
    await fs.writeFile(
      path.join(output, "receipt.json"),
      JSON.stringify(receipt, null, 2),
    );
    console.log(JSON.stringify(receipt));
  } finally {
    await desktop?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
