import { app, BrowserWindow, ipcMain, shell, nativeTheme } from "electron";
import path from "node:path";
import { existsSync } from "node:fs";
import { AgentHostManager } from "./agent-host-manager.js";
import { WebServerManager } from "./web-server-manager.js";
import { createMainWindow, setupNativeMenu } from "./window.js";
import { toggleStarHud } from "./hud-window.js";

const isDev = !app.isPackaged;

// In CommonJS, __dirname is already a global variable.
const preloadPath = path.resolve(__dirname, "../preload/index.cjs");

const agentHostManager = new AgentHostManager();
const webServerManager = new WebServerManager();
let mainWindow: BrowserWindow | null = null;

async function bootstrap() {
  console.log("[desktop:main] Starting BetterMe Desktop application...");

  // 1. Ensure backend agent-host and web server are healthy/started
  await agentHostManager.ensureStarted();
  await webServerManager.ensureStarted();

  // 2. Setup Native Menu
  setupNativeMenu(() => {
    toggleStarHud(preloadPath);
  });

  // 3. Create Main Window
  const devUrl = process.env.VITE_DEV_SERVER_URL || "http://localhost:5173/?workspace=autopilot";
  const distCandidates = [
    path.resolve(__dirname, "../../../web/dist/index.html"),
    path.resolve(app.getAppPath(), "../web/dist/index.html"),
    path.resolve(app.getAppPath(), "../../../../better-me-agent-os/apps/web/dist/index.html"),
    path.resolve(process.cwd(), "better-me-agent-os/apps/web/dist/index.html"),
    path.resolve(process.cwd(), "apps/web/dist/index.html"),
    path.resolve(process.cwd(), "../web/dist/index.html"),
  ];
  const prodDistPath = distCandidates.find((p) => existsSync(p)) || distCandidates[0];

  mainWindow = createMainWindow({
    preloadPath,
    devServerUrl: isDev ? devUrl : undefined,
    distPath: !isDev ? prodDistPath : undefined,
  });

  // 4. Setup IPC Handlers
  ipcMain.handle("desktop:get-agent-info", async () => {
    return agentHostManager.getConfig();
  });

  ipcMain.handle("desktop:toggle-hud", async () => {
    toggleStarHud(preloadPath);
  });

  ipcMain.handle("desktop:open-external", async (_, url: string) => {
    if (typeof url === "string" && (url.startsWith("http:") || url.startsWith("https:"))) {
      await shell.openExternal(url);
    }
  });

  // Theme change sync
  nativeTheme.on("updated", () => {
    const current = nativeTheme.shouldUseDarkColors ? "dark" : "light";
    mainWindow?.webContents.send("desktop:theme-changed", current);
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
