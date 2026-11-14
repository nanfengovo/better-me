/* eslint-disable @typescript-eslint/no-require-imports -- Opt-in isolated Electron acceptance entry. */
const { app, BrowserWindow, session, ipcMain } = require("electron");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const assert = require("node:assert/strict");
const argument = name => process.argv.find(value => value.startsWith(name + "="))?.slice(name.length + 1);
const directory = argument("--directory"), preload = argument("--preload");
const port = Number(argument("--port") ?? "5336");
assert.ok([5336, 5337, 5338].includes(port));
assert.ok(directory && preload);
assert.equal(fs.realpathSync(directory), directory);
assert.equal(path.dirname(directory), fs.realpathSync(os.tmpdir()));
assert.match(path.basename(directory), /^betterme-learning-electron-[A-Za-z0-9_-]+$/);
assert.ok(fs.statSync(preload).isFile());
app.setName("betterme-learning-isolated-acceptance");
for (const name of ["userData", "sessionData", "crashDumps", "logs"]) {
  const location = path.join(directory, name); fs.mkdirSync(location, { recursive: true, mode: 0o700 }); app.setPath(name, location);
}
for (const flag of ["disable-background-networking", "disable-component-update", "disable-sync", "disable-breakpad", "use-mock-keychain"]) app.commandLine.appendSwitch(flag);
app.commandLine.appendSwitch("password-store", "basic");
const origin = `http://127.0.0.1:${port}`, token = "synthetic_growth_only_" + "x".repeat(43);
app.whenReady().then(async () => {
  const downloads = path.join(directory, "downloads");
  fs.mkdirSync(downloads, { recursive: true, mode: 0o700 });
  session.defaultSession.on("will-download", (_event, item) => {
    if ([5337, 5338].includes(port) && ["betterme-translation-receipt.json", ...(port === 5337 ? ["simulation-not-translated-draft.pdf"] : [])].includes(item.getFilename())) {
      item.setSavePath(path.join(downloads, item.getFilename())); return;
    }
    if (!item.getFilename().endsWith(".json")) { item.cancel(); return; }
    item.setSavePath(path.join(downloads, "learning-project-receipt.json"));
  });
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    callback({ cancel: url.origin !== origin && !["data:", "blob:", "about:"].includes(url.protocol) });
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ipcMain.handle("desktop:get-agent-info", () => ({ endpoint: origin, token, port }));
  const window = new BrowserWindow({ width: 1380, height: 980, title: "BetterMe · 资料学习隔离验收",
    webPreferences: { preload, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => { if (!url.startsWith(origin + "/")) event.preventDefault(); });
  await window.loadURL(origin + "/tests/ui-lab/learning-path.html");
});
app.on("window-all-closed", () => app.quit());
