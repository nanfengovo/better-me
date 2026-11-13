/** Opt-in real Electron restart test against the synthetic UI lab only.
 * Start the isolated ui-lab Vite server on 5294, then run:
 * node apps/desktop/tests/workspace-recovery-smoke.cjs
 * Never launches BetterMe.app, its account profile, a backend or a real model.
 */
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const assert = require("node:assert/strict");
const origin = "http://127.0.0.1:5294";
const url = origin + "/tests/ui-lab/workspace-recovery.html?workspace=agent";
const argument = name => process.argv.find(value => value.startsWith(name + "="))?.slice(name.length + 1);

if (!process.versions.electron) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "betterme-electron-recovery-")));
  const env = {};
  for (const key of ["PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SystemRoot", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"])
    if (process.env[key]) env[key] = process.env[key];
  const executable = require("electron");
  for (const stage of ["seed", "verify"]) {
    const child = require("node:child_process").spawnSync(executable, [
      "--user-data-dir=" + path.join(dir, "userData"), "--crash-dumps-dir=" + path.join(dir, "crashDumps"),
      "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-breakpad",
      "--use-mock-keychain", "--password-store=basic", __filename, "--fixture-dir=" + dir, "--stage=" + stage,
    ], { env, cwd: dir, stdio: "inherit", timeout: 30000 });
    if (child.error) throw child.error;
    if (child.status !== 0) { process.exitCode = child.status ?? 1; break; }
  }
} else {
  const { app, BrowserWindow, session } = require("electron");
  const dir = argument("--fixture-dir"), stage = argument("--stage");
  assert.ok(dir && ["seed", "verify"].includes(stage));
  assert.ok(path.basename(dir).startsWith("betterme-electron-recovery-") && fs.realpathSync(dir) === dir);
  assert.equal(app.commandLine.getSwitchValue("user-data-dir"), path.join(dir, "userData"));
  app.setName("betterme-recovery-smoke");
  for (const key of ["userData", "sessionData", "crashDumps", "logs"]) {
    const location = path.join(dir, key); fs.mkdirSync(location, { recursive: true }); app.setPath(key, location);
  }
  app.disableHardwareAcceleration();
  if (process.platform === "darwin") app.setActivationPolicy("accessory");
  const question = "Electron 重启后必须保留的合成问题", draft = "Electron 尚未发送的合成草稿";
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let blockedRequests = 0;
  async function run() {
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(false));
    session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
      const target = new URL(details.url), allowed = target.origin === origin || ["about:", "data:", "blob:"].includes(target.protocol);
      if (!allowed) blockedRequests++; cb({ cancel: !allowed });
    });
    const window = new BrowserWindow({ show: false, width: 1440, height: 1000,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    await window.loadURL(url);
    async function waitFor(source) {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await window.webContents.executeJavaScript(source)) return;
        await sleep(100);
      }
      throw Error("synthetic recovery UI did not reach the expected state");
    }
    await waitFor('window.__recoveryQa?.syntheticOnly && !!document.querySelector(".agent-chat-textarea")');
    if (stage === "seed") {
      await window.webContents.executeJavaScript(`(() => {
        const field = document.querySelector(".agent-chat-textarea");
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, ${JSON.stringify(question)});
        field.dispatchEvent(new Event("input", { bubbles: true }));
      })()`);
      await waitFor('!![...document.querySelectorAll("button")].find(button => button.textContent.trim() === "发送" && !button.disabled)');
      await window.webContents.executeJavaScript('[...document.querySelectorAll("button")].find(button => button.textContent.trim() === "发送").click()');
      await waitFor('document.body.textContent.includes("合成回答：你的交互记录会留在本机")');
      await window.webContents.executeJavaScript(`(() => {
        const field = document.querySelector(".agent-chat-textarea");
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, ${JSON.stringify(draft)});
        field.dispatchEvent(new Event("input", { bubbles: true }));
      })()`);
      await waitFor(`Object.keys(localStorage).some(key => key.includes("recovery.v1:advisor:") && localStorage.getItem(key).includes(${JSON.stringify(draft)}))`);
      assert.equal(await window.webContents.executeJavaScript("window.__recoveryQa.calls"), 1);
    } else {
      const state = await window.webContents.executeJavaScript(`({
        question: document.body.textContent.includes(${JSON.stringify(question)}),
        answer: document.body.textContent.includes("合成回答：你的交互记录会留在本机"),
        draft: document.querySelector(".agent-chat-textarea").value,
        newModelRequests: window.__recoveryQa.calls + window.__recoveryQa.matchingCalls,
        restored: document.body.textContent.includes("已恢复本机记录")
      })`);
      assert.equal(state.question, true); assert.equal(state.answer, true); assert.equal(state.restored, true);
      assert.equal(state.draft, draft); assert.equal(state.newModelRequests, 0);
      const evidence = { ...state, electron: process.versions.electron, fullProcessRestart: true, syntheticOnly: true,
        profileIsolated: app.getPath("userData") === path.join(dir, "userData"), blockedRequests,
        summary: path.join(dir, "summary.json") };
      fs.writeFileSync(evidence.summary, JSON.stringify(evidence, null, 2) + "\n");
      console.log("BETTERME_ELECTRON_RECOVERY " + JSON.stringify(evidence));
    }
    session.defaultSession.flushStorageData();
    await session.defaultSession.cookies.flushStore();
    window.destroy();
  }
  const fail = error => { console.error("BETTERME_ELECTRON_RECOVERY_FAILED", error?.message ?? String(error)); app.exit(1); };
  const timer = setTimeout(() => fail(Error("timeout")), 25000);
  app.whenReady().then(run).then(() => { clearTimeout(timer); app.exit(0); }, fail);
}
