import { BrowserWindow, shell, nativeTheme, Menu, app } from "electron";
import path from "node:path";
import { externalUrl } from "./launch-policy.js";

export interface MainWindowOptions {
  preloadPath: string;
  devServerUrl?: string;
  distPath?: string;
  iconPath?: string;
}

export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const isMac = process.platform === "darwin";

  const win = new BrowserWindow({
    width: 1540,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    title: "BetterMe · 职业工作台",
    icon: options.iconPath,
    titleBarStyle: isMac ? "hiddenInset" : "default",
    trafficLightPosition: isMac ? { x: 18, y: 18 } : undefined,
    vibrancy: isMac ? "under-window" : undefined,
    visualEffectState: "active",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0B0F13" : "#F8FAFC",
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  win.once("ready-to-show", () => {
    win.show();
    win.focus();
  });

  // Open external links in default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    const safe = externalUrl(url);
    if (safe) void shell.openExternal(safe);
    return { action: "deny" };
  });

  if (app.isPackaged && options.devServerUrl) {
    const origin = new URL(options.devServerUrl).origin;
    const restrict = (event: { preventDefault(): void }, destination: string) => {
      try { if (new URL(destination).origin === origin) return; } catch { /* deny invalid navigation */ }
      event.preventDefault();
    };
    win.webContents.on("will-navigate", restrict);
    win.webContents.on("will-redirect", restrict);
    win.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === "clipboard-sanitized-write"));
  }

  // Load URL
  if (options.devServerUrl) {
    console.log("[desktop:window] Loading dev server:", options.devServerUrl);
    win.loadURL(options.devServerUrl);
  } else if (options.distPath) {
    console.log("[desktop:window] Loading bundled web:", options.distPath);
    win.loadFile(options.distPath);
  } else {
    // Default dev fallback
    win.loadURL("http://localhost:5173/?workspace=autopilot");
  }

  return win;
}

export function setupNativeMenu(onToggleHud: () => void): void {
  const isMac = process.platform === "darwin";

  const template: any[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              {
                label: "STAR 实时提词悬浮窗 (HUD)",
                accelerator: "CommandOrControl+Shift+H",
                click: onToggleHud,
              },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: "编辑",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "reload", accelerator: "CommandOrControl+R" },
        { role: "forceReload", accelerator: "CommandOrControl+Shift+R" },
        { role: "toggleDevTools", accelerator: "Alt+CommandOrControl+I" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        {
          label: "STAR 面试提词 HUD 悬浮窗",
          accelerator: "CommandOrControl+Shift+H",
          click: onToggleHud,
        },
        ...(isMac
          ? [{ type: "separator" }, { role: "front" }, { type: "separator" }, { role: "window" }]
          : [{ role: "close" }]),
      ],
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "访问 BetterMe 官方文档",
          click: () => shell.openExternal("https://github.com/nanfengovo/better-me"),
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
