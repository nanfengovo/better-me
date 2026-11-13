/* eslint-disable @typescript-eslint/no-require-imports -- Explicit isolated Electron acceptance entry. */
// Launch only through Playwright with a fresh temp directory and built preload.
// Uses the actual shared React surfaces and actual OS speech, never real services.
const { app, BrowserWindow, session, ipcMain } = require("electron");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const assert = require("node:assert/strict");
const argument = name => process.argv.find(value => value.startsWith(name + "="))?.slice(name.length + 1);
const directory = argument("--directory"), preload = argument("--preload");
assert.ok(directory && preload);
assert.equal(fs.realpathSync(directory), directory);
assert.equal(path.dirname(directory), fs.realpathSync(os.tmpdir()));
assert.match(path.basename(directory), /^betterme-local-speech-[A-Za-z0-9_-]+$/);
assert.ok(fs.statSync(preload).isFile());
app.setName("betterme-local-speech-acceptance");
for (const name of ["userData", "sessionData", "crashDumps", "logs"]) {
  const location = path.join(directory, name); fs.mkdirSync(location, { recursive: true, mode: 0o700 }); app.setPath(name, location);
}
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("disable-sync");
app.commandLine.appendSwitch("use-mock-keychain");
app.commandLine.appendSwitch("password-store", "basic");
const origin = "http://127.0.0.1:5326";
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(origin + "/") }));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.on("will-download", event => event.preventDefault());
  ipcMain.handle("desktop:get-agent-info", () => ({ endpoint: origin, token: "synthetic-speech-only", port: 5326 }));
  const window = new BrowserWindow({ width: 1320, height: 940, title: "BetterMe · 本机朗读隔离验收",
    webPreferences: { preload, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => { if (!url.startsWith(origin + "/")) event.preventDefault(); });
  await window.loadURL(origin + "/tests/ui-lab/local-speech.html");
});
app.on("window-all-closed", () => app.quit());
