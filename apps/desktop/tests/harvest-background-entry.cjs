/* eslint-disable @typescript-eslint/no-require-imports -- Opt-in isolated Electron acceptance entry. */
// Launch through Playwright only. No production app, account, Host or browser profile.
const { app, BrowserWindow, session } = require("electron");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict");
const directory = process.argv.find(value => value.startsWith("--directory="))?.slice(12);
assert.ok(directory);
assert.equal(fs.realpathSync(directory), directory);
assert.equal(path.dirname(directory), fs.realpathSync(os.tmpdir()));
assert.match(path.basename(directory), /^betterme-harvest-qa-[A-Za-z0-9_-]+$/);
app.setName("BetterMe Harvest Acceptance");
for (const name of ["userData", "sessionData", "crashDumps", "logs"]) {
  const target = path.join(directory, name);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 }); app.setPath(name, target);
}
for (const flag of ["disable-background-networking", "disable-component-update", "disable-sync", "disable-breakpad", "use-mock-keychain"]) app.commandLine.appendSwitch(flag);
app.commandLine.appendSwitch("password-store", "basic");
app.whenReady().then(async () => {
  const origin = "http://127.0.0.1:5297";
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_c, _p, callback) => callback(false));
  session.defaultSession.on("will-download", event => event.preventDefault());
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    callback({ cancel: (url.origin !== origin && !["data:", "blob:", "about:"].includes(url.protocol))
      || (url.pathname.startsWith("/api/") && url.pathname !== "/api/jd/search-session") || url.pathname.startsWith("/__better-me/") });
  });
  const window = new BrowserWindow({ width: 1440, height: 1000, title: "BetterMe · 后台采集合成验收",
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => { if (!url.startsWith(origin + "/")) event.preventDefault(); });
  await window.loadURL(origin + "/tests/ui-lab/harvest-clarity.html?scenario=verification");
});
app.on("window-all-closed", () => app.quit());
