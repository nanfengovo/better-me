/* eslint-disable @typescript-eslint/no-require-imports -- Manual, passive real-converter QA; no automatic inference. */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createRequire } = require("node:module");
const { setTimeout: delay } = require("node:timers/promises");
const repo = path.resolve(__dirname, "../../..");
const { _electron } = createRequire(path.join(repo, "apps/agent-host/package.json"))("playwright-core");
const executablePath = createRequire(path.join(repo, "apps/desktop/package.json"))("electron");
const origin = "http://127.0.0.1:5338";
const output = path.join(repo, "output/translation-real");
const state = async () => (await fetch(origin + "/__growth-loop-qa/state")).json();
const writes = entries => entries.filter(item => /^POST .*\/growth\//.test(item));
let app;

async function receipt(page, directory, id) {
  const filename = path.join(directory, "downloads/betterme-translation-receipt.json");
  await fs.unlink(filename).catch(error => { if (error.code !== "ENOENT") throw error; });
  await page.getByRole("button", { name: "导出当前作业回执", exact: true }).click();
  for (let index = 0; index < 100; index++) {
    try {
      const value = JSON.parse(await fs.readFile(filename, "utf8"));
      if (value.id === id) return value;
    } catch {}
    await delay(50);
  }
  throw new Error("Fresh native receipt not delivered");
}
async function launch(directory, web, preview) {
  const before = await state();
  app = await _electron.launch({ executablePath, cwd: repo,
    args: [path.join(repo, "apps/desktop/tests/learning-path-entry.cjs"), `--directory=${directory}`,
      `--preload=${path.join(repo, "apps/desktop/dist/preload/index.cjs")}`, "--port=5338"],
    env: { PATH: process.env.PATH, LANG: "en_US.UTF-8", TMPDIR: "/private/tmp" }, timeout: 30_000 });
  const page = await app.firstWindow(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.getByText("PDF 中译英 · 独立试点", { exact: true }).click();
  await page.getByRole("button", { name: "只读刷新引擎与记录", exact: true }).click();
  await page.getByRole("combobox", { name: "转换作业", exact: true }).selectOption(web.id);
  const restored = await receipt(page, directory, web.id);
  for (const key of ["id", "ownerId", "request", "usage", "artifacts", "state", "review"]) assert.deepEqual(restored[key], web[key], key);
  assert.equal(await page.getByRole("checkbox", { name: /仅授权本原件版本与术语表/ }).isChecked(), false);
  const silent = await page.evaluate(() => ({ speaking: speechSynthesis.speaking, pending: speechSynthesis.pending }));
  assert.deepEqual(silent, { speaking: false, pending: false });
  if (preview) {
    const escaped = web.materialName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await page.getByRole("button", { name: new RegExp(`^${escaped} ${web.sourcePages} 页`) }).click();
    await page.getByRole("button", { name: "查看单语候选", exact: true }).click();
    await page.getByLabel("原 PDF 第 1 页", { exact: true }).waitFor();
    await page.getByLabel("待审阅候选 · 第 1 页", { exact: true }).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll(".translation-compare canvas")].length === 2 &&
      [...document.querySelectorAll(".translation-compare canvas")].every(canvas => canvas.width > 0));
    await page.locator(".translation-preview").screenshot({ path: path.join(repo, "output/playwright/translation-real-native-preview.png") });
  }
  const version = await app.evaluate(() => process.versions.electron);
  const after = await state();
  assert.deepEqual(writes(after.paths.slice(before.paths.length)), []);
  assert.equal(after.translationAdapterRuns, before.translationAdapterRuns);
  assert.equal(after.translationModelRequests, before.translationModelRequests);
  assert.deepEqual(errors, []);
  await app.close(); app = undefined;
  return { version, restored, silent, writes: [], before, after, errors };
}
async function main() {
  assert.ok(process.argv[2], "Explicit real Web receipt required; this script never starts a translation");
  const web = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
  assert.equal(web.backend.simulation, false);
  assert.ok(["review_required", "accepted", "rejected"].includes(web.state));
  assert.ok(web.usage.modelCalls > 0);
  assert.ok(web.artifacts.some(item => item.kind === "mono"));
  await fs.mkdir(output, { recursive: true });
  await fs.mkdir(path.join(repo, "output/playwright"), { recursive: true });
  const directory = await fs.mkdtemp("/private/tmp/betterme-learning-electron-");
  const first = await launch(directory, web, true);
  const reopen = await launch(directory, web, false);
  assert.equal((await fetch(origin + "/__growth-loop-qa/restart-host", { method: "POST" })).status, 200);
  const hostRestart = await launch(directory, web, false);
  await fs.writeFile(path.join(output, "native-observed-summary.json"), JSON.stringify({ directory, first, reopen, hostRestart }, null, 2));
  console.log(JSON.stringify({ directory, electron: first.version, jobId: web.id, firstWrites: 0, reopenWrites: 0,
    hostRestartWrites: 0, inferenceDelta: 0, silent: first.silent }));
}
main().catch(async error => { if (app) await app.close().catch(() => {}); console.error(error); process.exitCode = 1; });
