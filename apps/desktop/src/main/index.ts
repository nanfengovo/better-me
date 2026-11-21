import { Notification, app, BrowserWindow, dialog, ipcMain, shell, nativeTheme } from "electron";
import path from "node:path";
import { AgentHostManager } from "./agent-host-manager.js";
import { WebServerManager } from "./web-server-manager.js";
import { createMainWindow, setupNativeMenu } from "./window.js";
import { exportWindowToPdf } from "./pdf-export.js";
import { prepareDesktopQaProfile, resolveDesktopQaConfig } from "./isolated-qa-config.js";
import { startPackagedApp } from "./packaged.js";

// The adjacent, source-linked legacy app remains a deliberate development shell.
// Distributable builds always use the bundled, persistent runtime; a missing
// release runtime must never silently fall back to a developer service.
if (app.isPackaged && app.getName?.() !== "better-me-desktop") {
  startPackagedApp();
} else {

const isDev = !app.isPackaged;
const qaConfig = resolveDesktopQaConfig({ environment: process.env, isPackaged: app.isPackaged });
if (qaConfig) {
  const paths = prepareDesktopQaProfile(qaConfig, app.getPath("temp"));
  for (const key of ["userData", "sessionData", "logs", "crashDumps"] as const) app.setPath(key, paths[key]);
}

// In CommonJS, __dirname is already a global variable.
const preloadPath = path.resolve(__dirname, "../preload/index.cjs");

const agentHostManager = new AgentHostManager(qaConfig ? { ...qaConfig.host, externalOnly: true } : undefined);
const webServerManager = new WebServerManager(qaConfig ? { ...qaConfig.web, externalOnly: true } : undefined);
let mainWindow: BrowserWindow | null = null;
let opening: Promise<void> | undefined;

function parseExternalHttpUrl(input: unknown): string | undefined {
  if (typeof input !== "string" || input.length > 4096) return;
  try {
    const parsed = new URL(input);
    if ((parsed.protocol === "https:" || parsed.protocol === "http:") && !parsed.username && !parsed.password) {
      return parsed.href;
    }
  } catch { /* malformed external URL is not opened */ }
}

const trusted = (event?: Electron.IpcMainInvokeEvent): boolean =>
  Boolean(mainWindow && event && event.sender === mainWindow.webContents && event.senderFrame === mainWindow.webContents.mainFrame);

const explainHud = (): void => {
  void dialog.showMessageBox({
    type: "info",
    message: "请先在工作台准备并核对面试材料。",
    detail: "此版本不展示预置的个人经历、指标或未经核对的防守话术。",
  });
};

// These belong to the Host lifetime, not a window lifetime. macOS can close
// every window while a granted task continues, then reopen the same Host.
ipcMain.handle("desktop:get-agent-info", async (event) => {
  if (!trusted(event)) throw new Error("Untrusted agent info request.");
  return agentHostManager.getConfig();
});
let lastJobWatchNotice = 0;
ipcMain.handle("desktop:notify-job-watch", event => {
  if (!trusted(event) || !Notification.isSupported() || Date.now() - lastJobWatchNotice < 10_000) return;
  lastJobWatchNotice = Date.now();
  // A system banner omits account, resume and posting content.
  const notification = new Notification({ title: "BetterMe · 后台寻岗", body: "有新的官网岗位等待审阅。" });
  notification.on("click", () => { mainWindow?.show(); mainWindow?.focus(); mainWindow?.webContents.send("desktop:open-job-watch"); });
  notification.show();
});
ipcMain.handle("desktop:toggle-hud", (event) => {
  if (trusted(event)) explainHud();
});
ipcMain.handle("desktop:open-external", async (event, url: unknown) => {
  const safe = parseExternalHttpUrl(url);
  if (trusted(event) && safe) await shell.openExternal(safe);
});
ipcMain.handle("desktop:export-pdf", async (event, suggestedFilename?: unknown) => {
  if (!trusted(event)) throw new Error("Untrusted PDF export request.");
  return exportWindowToPdf(mainWindow, suggestedFilename);
});
nativeTheme.on("updated", () => {
  mainWindow?.webContents.send("desktop:theme-changed", nativeTheme.shouldUseDarkColors ? "dark" : "light");
});

function bootstrap(): Promise<void> {
  opening ??= openWorkspace().catch((error: unknown) => {
    dialog.showErrorBox("无法打开 BetterMe 工作台", error instanceof Error ? error.message : "本机工作台服务未就绪。没有打开其他网站或运行任务。");
  }).finally(() => { opening = undefined; });
  return opening;
}
async function openWorkspace() {
  if (mainWindow) return;
  console.log("[desktop:main] Starting BetterMe Desktop application...");

  // 1. Ensure backend agent-host and web server are healthy/started
  await agentHostManager.ensureStarted();
  await webServerManager.ensureStarted();

  // 2. Setup Native Menu
  setupNativeMenu(explainHud);

  // 3. Create Main Window
  // Vite root assets and the Agent API proxy require the same HTTP origin.
  // A packaged window never uses arbitrary dev URLs or falls back to file://.
  const workspaceUrl = qaConfig?.workspaceUrl ?? (isDev ? process.env.VITE_DEV_SERVER_URL || "http://localhost:5173/?workspace=resume"
    : new URL("/?workspace=resume", webServerManager.getEndpoint()).href);
  mainWindow = createMainWindow({
    preloadPath, workspaceUrl, restrictOrigin: !!qaConfig || !isDev,
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// App lifecycle
app.whenReady().then(bootstrap);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    agentHostManager.stop();
    webServerManager.stop();
    app.quit();
  }
});

app.on("before-quit", () => {
  agentHostManager.stop();
  webServerManager.stop();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    bootstrap();
  }
});
}
