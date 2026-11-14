/* eslint-disable @typescript-eslint/no-require-imports -- Manual opt-in GUI acceptance, never the ordinary desktop test glob. */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createRequire } = require("node:module");
const { setTimeout: delay } = require("node:timers/promises");
const repo = path.resolve(__dirname, "../../..");
const requireHost = createRequire(
  path.join(repo, "apps/agent-host/package.json"),
);
const requireDesktop = createRequire(
  path.join(repo, "apps/desktop/package.json"),
);
const { _electron } = requireHost("playwright-core");
const executablePath = requireDesktop("electron");
const origin = "http://127.0.0.1:5337";
const output = path.join(repo, "output/translation-acceptance");
const screenshots = path.join(repo, "output/playwright");
const state = async () =>
  (await fetch(origin + "/__growth-loop-qa/state")).json();
const writes = (entries) =>
  entries.filter((item) => /^POST .*\/growth\//.test(item));
const consent = (page) =>
  page.getByRole("checkbox", { name: /仅授权本原件版本与术语表/ });
let app;

async function receipt(page, directory) {
  await page
    .getByRole("button", { name: "导出当前作业回执", exact: true })
    .click();
  const filename = path.join(
    directory,
    "downloads/betterme-translation-receipt.json",
  );
  for (let index = 0; index < 100; index++) {
    try {
      const value = JSON.parse(await fs.readFile(filename, "utf8"));
      if (
        value.id ===
        (await page
          .getByRole("combobox", { name: "转换作业", exact: true })
          .inputValue())
      )
        return value;
    } catch {}
    await delay(50);
  }
  throw new Error("Native receipt download not delivered");
}
async function launch(directory) {
  app = await _electron.launch({
    executablePath,
    cwd: repo,
    args: [
      path.join(repo, "apps/desktop/tests/learning-path-entry.cjs"),
      `--directory=${directory}`,
      `--preload=${path.join(repo, "apps/desktop/dist/preload/index.cjs")}`,
      "--port=5337",
    ],
    env: {
      PATH: process.env.PATH,
      LANG: "en_US.UTF-8",
      TMPDIR: "/private/tmp",
    },
    timeout: 30_000,
  });
  const page = await app.firstWindow();
  await page.getByText("PDF 中译英 · 独立试点", { exact: true }).waitFor();
  await page.getByText("PDF 中译英 · 独立试点", { exact: true }).click();
  await page.getByRole("combobox", { name: "转换作业", exact: true }).waitFor();
  await page
    .getByRole("button", { name: "只读刷新引擎与记录", exact: true })
    .click();
  return page;
}
async function main() {
  await fs.mkdir(output, { recursive: true });
  await fs.mkdir(screenshots, { recursive: true });
  const web = JSON.parse(
    await fs.readFile(process.argv[2] ?? path.join(output, "web-job-receipt.json"), "utf8"),
  );
  assert.equal(web.backend.simulation, true);
  const directory = await fs.mkdtemp(
    "/private/tmp/betterme-learning-electron-",
  );
  const before = await state();
  let page = await launch(directory);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page
    .getByRole("combobox", { name: "转换作业", exact: true })
    .selectOption(web.id);
  const restored = await receipt(page, directory);
  assert.equal(restored.ownerId, web.ownerId);
  assert.equal(restored.id, web.id);
  assert.deepEqual(restored.request, web.request);
  assert.deepEqual(restored.usage, web.usage);
  assert.equal(await consent(page).isChecked(), false);
  const after = await state();
  assert.deepEqual(writes(after.paths.slice(before.paths.length)), []);
  assert.equal(after.translationAdapterRuns, before.translationAdapterRuns);
  assert.equal(after.translationModelRequests, before.translationModelRequests);
  await page
    .getByRole("button", { name: new RegExp(`^${web.materialName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} ${web.sourcePages} 页`) })
    .click();
  await page.getByRole("button", { name: "查看单语候选", exact: true }).click();
  await page.getByLabel("原 PDF 第 1 页", { exact: true }).waitFor();
  await page
    .getByLabel("模拟件，不是译文 · 第 1 页", { exact: true })
    .waitFor();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".translation-compare canvas")].length ===
        2 &&
      [...document.querySelectorAll(".translation-compare canvas")].every(
        (canvas) => canvas.width > 0,
      ),
  );
  await page
    .getByText("本页可提取文本（不代表阅读顺序正确）", { exact: true })
    .click();
  await page
    .locator(".translation-preview")
    .screenshot({
      path: path.join(screenshots, "translation-native-preview.png"),
    });
  const nativeVersion = await app.evaluate(() => process.versions.electron);
  const silent = await page.evaluate(() => ({
    speaking: speechSynthesis.speaking,
    pending: speechSynthesis.pending,
  }));
  assert.deepEqual(silent, { speaking: false, pending: false });
  await app.close();
  app = undefined;

  const reopenBefore = await state();
  page = await launch(directory);
  assert.equal(await consent(page).isChecked(), false);
  assert.equal((await receipt(page, directory)).id, web.id);
  const reopenAfter = await state();
  assert.deepEqual(
    writes(reopenAfter.paths.slice(reopenBefore.paths.length)),
    [],
  );
  await page
    .getByRole("combobox", { name: "本次本机模型", exact: true })
    .selectOption("synthetic-local-no-inference");
  await page
    .getByRole("checkbox", { name: "同时生成逐页双语对照", exact: true })
    .uncheck();
  await consent(page).check();
  await page
    .getByRole("button", { name: "开始本次中译英", exact: true })
    .click();
  // The previous result may already show 2/32. Read the new job's meter first.
  await page
    .getByRole("button", { name: "只读刷新引擎与记录", exact: true })
    .click();
  await page.getByText(/模型请求 [12]\/32/).waitFor();
  await page.getByRole("button", { name: "停止本次转换", exact: true }).click();
  await page.getByRole("heading", { name: "已停止", exact: true }).waitFor();
  const cancelled = await receipt(page, directory);
  assert.notEqual(cancelled.id, web.id);
  assert.equal(cancelled.state, "cancelled");
  assert.ok(cancelled.usage.modelCalls >= 1);
  assert.deepEqual(cancelled.artifacts, []);
  await page
    .locator(".translation-result")
    .screenshot({
      path: path.join(screenshots, "translation-native-cancelled.png"),
    });
  await app.close();
  app = undefined;

  const restart = await fetch(origin + "/__growth-loop-qa/restart-host", {
    method: "POST",
  });
  assert.equal(restart.status, 200);
  const hostBefore = await state();
  page = await launch(directory);
  assert.equal(await consent(page).isChecked(), false);
  const hostRestored = await receipt(page, directory);
  assert.equal(hostRestored.id, cancelled.id);
  assert.deepEqual(hostRestored.usage, cancelled.usage);
  const hostAfter = await state();
  assert.deepEqual(writes(hostAfter.paths.slice(hostBefore.paths.length)), []);
  assert.equal(
    hostBefore.translationAdapterRuns,
    hostAfter.translationAdapterRuns,
  );
  assert.equal(
    hostBefore.translationModelRequests,
    hostAfter.translationModelRequests,
  );
  assert.equal(hostAfter.externalModelCalls, 0);
  assert.deepEqual(errors, []);
  const summary = {
    nativeVersion,
    directory,
    webJobId: web.id,
    ownerId: web.ownerId,
    restored,
    cancelled,
    hostRestored,
    firstRestoreWrites: writes(after.paths.slice(before.paths.length)),
    reopenWrites: writes(reopenAfter.paths.slice(reopenBefore.paths.length)),
    hostRestartWrites: writes(hostAfter.paths.slice(hostBefore.paths.length)),
    before,
    after,
    reopenBefore,
    reopenAfter,
    hostBefore,
    hostAfter,
    silent,
    errors,
  };
  await fs.writeFile(
    path.join(output, "native-observed-summary.json"),
    JSON.stringify(summary, null, 2),
  );
  console.log(
    JSON.stringify({
      nativeVersion,
      directory,
      webJobId: web.id,
      cancelledJobId: cancelled.id,
      firstRestoreWrites: 0,
      reopenWrites: 0,
      hostRestartWrites: 0,
      externalModelCalls: 0,
    }),
  );
}
main()
  .catch(async (error) => {
    console.error(error);
    process.exitCode = 1;
    try {
      const page = await app?.firstWindow();
      if (page)
        await page.screenshot({
          path: path.join(screenshots, "translation-native-failure.png"),
        });
    } catch {}
  })
  .finally(async () => {
    if (app) await app.close();
  });
