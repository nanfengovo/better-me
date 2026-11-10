/** Opt-in real Electron desktop-chrome check. Serve the isolated UI lab on
 * 56373, then: node apps/desktop/tests/menubar-smoke.cjs
 * Uses a fresh private profile, synthetic body and bridge marker only.
 * Does not launch BetterMe.app, its Host, accounts or model services.
 */
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const assert = require("node:assert/strict");
const origin = "http://127.0.0.1:56373", url = origin + "/tests/ui-lab/desktop-menubar.html";
if (!process.versions.electron) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "betterme-electron-menubar-")));
  const env = {};
  for (const key of ["PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SystemRoot", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"])
    if (process.env[key]) env[key] = process.env[key];
  const child = require("node:child_process").spawnSync(require("electron"), [
    "--user-data-dir=" + path.join(dir, "userData"), "--crash-dumps-dir=" + path.join(dir, "crashDumps"),
    "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-breakpad",
    "--use-mock-keychain", "--password-store=basic", __filename, "--fixture-dir=" + dir,
  ], { env, cwd: dir, stdio: "inherit", timeout: 30000 });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
} else {
  const { app, BrowserWindow, session } = require("electron");
  const dir = process.argv.find(value => value.startsWith("--fixture-dir="))?.slice(14);
  assert.ok(dir && path.basename(dir).startsWith("betterme-electron-menubar-") && fs.realpathSync(dir) === dir);
  assert.equal(app.commandLine.getSwitchValue("user-data-dir"), path.join(dir, "userData"));
  app.setName("betterme-menubar-smoke"); app.disableHardwareAcceleration();
  for (const key of ["userData", "sessionData", "crashDumps", "logs"]) {
    const location = path.join(dir, key); fs.mkdirSync(location, { recursive: true }); app.setPath(key, location);
  }
  if (process.platform === "darwin") app.setActivationPolicy("accessory");
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let blockedRequests = 0;
  async function run() {
    const s = session.defaultSession;
    s.setPermissionCheckHandler(() => false); s.setPermissionRequestHandler((_w, _p, cb) => cb(false));
    s.webRequest.onBeforeRequest((details, cb) => {
      const u = new URL(details.url), allowed = (u.origin === origin && !u.pathname.startsWith("/api/")) || ["about:", "data:", "blob:"].includes(u.protocol);
      if (!allowed) blockedRequests++; cb({ cancel: !allowed });
    });
    const w = new BrowserWindow({ show: false, width: 1440, height: 1000, titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
      trafficLightPosition: { x: 18, y: 18 }, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    const evaluate = code => w.webContents.executeJavaScript(code);
    async function waitFor(code) {
      for (let i = 0; i < 80; i++) { if (await evaluate(code)) return; await sleep(80); }
      throw Error("menu UI did not reach expected state: " + code);
    }
    const mouse = (type, x, y, button = "left") => w.webContents.sendInputEvent({ type, x, y, button, clickCount: 1 });
    await w.loadURL(url); await waitFor('!!document.querySelector(".os-menubar")');
    await evaluate(`window.desktopApi={isElectron:true};localStorage.setItem("betterme.ui.preferences.v1",'{"theme":"dark"}');window.dispatchEvent(new StorageEvent("storage",{key:"betterme.ui.preferences.v1"}));`);
    await waitFor('document.querySelector(".os-desktop").dataset.electron==="true"');
    const before = await evaluate('window.__menubarQa={height:document.querySelector(".os-stage").getBoundingClientRect().height,editor:document.querySelector("textarea")};window.__menubarQa.height');
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".os-menubar")).getPropertyValue("-webkit-app-region")'), "no-drag");
    mouse("mouseDown", 1000, 18, "right"); mouse("mouseUp", 1000, 18, "right");
    await waitFor('!!document.querySelector("[role=menuitemcheckbox]")');
    await evaluate('document.querySelector("[role=menuitemcheckbox]").click()');
    mouse("mouseMove", 700, 400);
    await waitFor('document.querySelector(".os-menubar-system").dataset.visible==="false"');
    const hidden = await evaluate(`({height:document.querySelector(".os-stage").getBoundingClientRect().height,editorSame:window.__menubarQa.editor===document.querySelector("textarea"),toolbarPadding:parseFloat(getComputedStyle(document.querySelector(".os-business-window>.os-window-toolbar")).paddingLeft)})`);
    assert.equal(hidden.height - before, 34); assert.equal(hidden.editorSame, true); assert.ok(hidden.toolbarPadding >= 84);
    mouse("mouseMove", 700, 1); await waitFor('document.querySelector(".os-menubar-system").dataset.visible==="true"');
    assert.equal(await evaluate('document.querySelector(".os-stage").getBoundingClientRect().height'), hidden.height);
    mouse("mouseDown", 1000, 18, "right"); mouse("mouseUp", 1000, 18, "right");
    await waitFor('document.querySelector("[role=menuitemcheckbox]")?.getAttribute("aria-checked")==="true"');
    await evaluate('document.querySelector("[role=menuitemcheckbox]").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))');
    await waitFor('!document.querySelector("[role=menuitemcheckbox]")');
    const evidence = { electron: process.versions.electron, syntheticOnly: true, nativeStyleWindow: true, inputRightClicks: 2,
      stageBefore: before, stageAfter: hidden.height, reclaimedPixels: 34, revealDoesNotReflow: true, nativeControlsClearance: hidden.toolbarPadding,
      editorSame: hidden.editorSame, externalServiceOrModelCalls: 0, blockedRequests, profileIsolated: app.getPath("userData") === path.join(dir, "userData"), summary: path.join(dir, "summary.json") };
    assert.ok(evidence.profileIsolated); fs.writeFileSync(evidence.summary, JSON.stringify(evidence, null, 2) + "\n");
    console.log("BETTERME_ELECTRON_MENUBAR " + JSON.stringify(evidence)); w.destroy();
  }
  const fail = error => { console.error("BETTERME_ELECTRON_MENUBAR_FAILED", error?.stack ?? String(error)); app.exit(1); };
  const timer = setTimeout(() => fail(Error("timeout")), 25000);
  app.whenReady().then(run).then(() => { clearTimeout(timer); app.exit(0); }, fail);
}
