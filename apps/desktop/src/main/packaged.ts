import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createMainWindow, setupNativeMenu } from "./window.js";
import { externalUrl, validateSmokeProfile } from "./launch-policy.js";

export function startPackagedApp() {
  const smoke = app.commandLine.hasSwitch("betterme-smoke-test");
  if (smoke) {
    try { app.setPath("userData", validateSmokeProfile(app.commandLine.getSwitchValue("betterme-smoke-profile"))); }
    catch (error) { console.error("Smoke profile rejected:", String(error)); app.exit(1); return; }
  }
  const userData = app.getPath("userData");
  const trace = (phase: string) => { if (smoke) appendFileSync(path.join(userData, "smoke-phases.txt"), phase + "\n", { mode: 0o600 }); };
  trace("profile-validated");
  // Do not silently import a developer browser/old Electron profile.
  for (const [key, name] of [["sessionData", "sessions"], ["logs", "logs"], ["crashDumps", "crashes"]] as const) {
    const directory = path.join(userData, name); mkdirSync(directory, { recursive: true, mode: 0o700 }); app.setPath(key, directory);
  }
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  trace("user-data-ready");
  let child: ChildProcess | undefined, window: BrowserWindow | null = null;
  let ready: { origin: string; endpoint: string; token: string; port: number; runtimePid: number; node: string } | undefined;
  let opening: Promise<void> | undefined, quitting = false, stopped = false;
  const resources = path.join(process.resourcesPath, "runtime");
  const preloadPath = path.resolve(__dirname, "../preload/index.cjs");
  const trusted = (event: Electron.IpcMainInvokeEvent) => !!window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
  ipcMain.handle("desktop:get-agent-info", event => {
    if (!trusted(event) || !ready) throw new Error("Workspace is not ready.");
    return { endpoint: ready.endpoint, token: ready.token, port: ready.port };
  });
  ipcMain.handle("desktop:open-external", async (event, input: unknown) => {
    const url = externalUrl(input); if (trusted(event) && url) await shell.openExternal(url);
  });
  const explainHud = () => { void dialog.showMessageBox({ type: "info", message: "请先在工作台准备并核对面试材料。", detail: "此版本不展示预置的个人经历、指标或未经核对的防守话术。" }); };
  ipcMain.handle("desktop:toggle-hud", event => { if (trusted(event)) explainHud(); });
  nativeTheme.on("updated", () => window?.webContents.send("desktop:theme-changed", nativeTheme.shouldUseDarkColors ? "dark" : "light"));

  async function runtime() {
    trace("runtime-spawn");
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) if (["NODE_OPTIONS", "NODE_PATH", "NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE"].includes(key.toUpperCase())) delete environment[key];
    child = spawn(process.execPath, [path.join(app.getAppPath(), "dist/runtime/server.mjs")], {
      cwd: resources, env: { ...environment, ELECTRON_RUN_AS_NODE: "1", NODE_ENV: "production", BETTERME_DESKTOP_DATA: path.join(userData, "runtime"), BETTERME_DESKTOP_SMOKE: smoke ? "1" : "0" }, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
    });
    // Never relay tokens, URLs containing credentials or model payloads to the UI.
    let diagnostics = "";
    child.stdout?.resume();
    child.stderr?.on("data", data => { diagnostics = (diagnostics + String(data)).slice(-6000); });
    await new Promise<void>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error("Bundled services did not become ready in time.")), 30_000);
      const fail = () => { clearTimeout(timer); reject(new Error("Bundled services failed to start. " + diagnostics.replace(/Bearer\s+\S+/gi, "Bearer <REDACTED>"))); };
      child!.once("error", fail); child!.once("exit", fail);
      child!.on("message", (message: unknown) => {
        const value = message as Record<string, unknown>;
        if (value?.type !== "betterme:ready") return;
        try {
          const origin = new URL(String(value.origin)), endpoint = new URL(String(value.agentEndpoint));
          if (origin.hostname !== "127.0.0.1" || origin.protocol !== "http:" || origin.pathname !== "/" || !smoke && origin.port !== "32741"
            || endpoint.hostname !== "127.0.0.1" || endpoint.protocol !== "http:" || !/^[A-Za-z0-9_-]{43,128}$/.test(String(value.agentToken))) throw new Error("Invalid bundled service handshake.");
          ready = { origin: origin.origin, endpoint: endpoint.origin, token: String(value.agentToken), port: Number(value.port), runtimePid: Number(value.runtimePid), node: String(value.node) };
          clearTimeout(timer); child!.removeListener("error", fail); child!.removeListener("exit", fail); accept();
          trace("runtime-ready");
        } catch (error) { clearTimeout(timer); reject(error); }
      });
    });
    child!.once("exit", () => { ready = undefined; if (!quitting) { dialog.showErrorBox("本机服务已停止", "已保存的资料仍保留。请重新打开 BetterMe；不会接管其他进程或重置资料。"); app.quit(); } });
  }
  async function open() {
    if (window) { window.show(); window.focus(); return; }
    if (!ready) await runtime();
    trace("window-create");
    setupNativeMenu(explainHud);
    window = createMainWindow({ preloadPath, workspaceUrl: ready!.origin + "/?workspace=autopilot", restrictOrigin: true, iconPath: path.join(resources, "icon.png") });
    window.on("closed", () => { window = null; });
    if (smoke) {
      const current = window;
      await new Promise<void>((accept, reject) => { current.webContents.once("did-finish-load", () => accept()); current.webContents.once("did-fail-load", (_event, _code, message) => reject(new Error(message))); });
      trace("renderer-loaded");
      let rendered = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        rendered = await current.webContents.executeJavaScript("Boolean(document.querySelector('#root')?.childElementCount)");
        if (rendered) break;
        await new Promise(accept => setTimeout(accept, 100));
      }
      if (!rendered) throw new Error("The packaged renderer did not mount.");
      trace("renderer-mounted");
      const health = await fetch(ready!.origin + "/healthz");
      if (!health.ok) throw new Error("Packaged runtime health check failed.");
      const state = { version: app.getVersion(), platform: process.platform, arch: process.arch, rendererMounted: rendered, node: ready!.node, runtimePid: ready!.runtimePid, origin: ready!.origin };
      writeFileSync(path.join(userData, "smoke-result.json"), JSON.stringify(state, null, 2), { flag: "wx", mode: 0o600 });
      app.quit();
    }
  }
  const bootstrap = () => opening ??= open().catch(error => {
    if (smoke) { writeFileSync(path.join(userData, "smoke-error.txt"), String(error), { mode: 0o600 }); process.exitCode = 1; }
    else dialog.showErrorBox("无法打开 BetterMe", "本机服务无法启动。没有替换其他服务或清除资料。请检查端口占用，并重新打开应用。");
    app.quit();
  }).finally(() => { opening = undefined; });
  app.whenReady().then(() => { trace("app-ready"); return bootstrap(); });
  app.on("activate", () => { if (!quitting) void bootstrap(); });
  app.on("second-instance", () => { if (!quitting) void bootstrap(); });
  app.on("window-all-closed", () => { if (process.platform !== "darwin" || smoke) app.quit(); });
  app.on("before-quit", event => {
    if (stopped || !child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    event.preventDefault(); if (quitting) return; quitting = true;
    trace("runtime-shutdown");
    const owned = child;
    const deadline = setTimeout(() => owned.kill("SIGKILL"), 20_000);
    owned.once("exit", () => { trace("runtime-exited"); clearTimeout(deadline); stopped = true; app.quit(); });
    if (owned.connected) owned.send({ type: "shutdown" }); else owned.kill("SIGTERM");
  });
}
