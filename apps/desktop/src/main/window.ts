import { BrowserWindow, shell, nativeTheme, Menu, app, dialog } from "electron";

export interface MainWindowOptions {
  preloadPath: string;
  workspaceUrl: string;
  restrictOrigin: boolean;
}

export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const isMac = process.platform === "darwin";

  const win = new BrowserWindow({
    width: 1540,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    title: "BetterMe · 自动化工坊",
    titleBarStyle: isMac ? "hiddenInset" : "default",
    trafficLightPosition: isMac ? { x: 18, y: 18 } : undefined,
    vibrancy: isMac ? "under-window" : undefined,
    visualEffectState: "active",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0B0F13" : "#F8FAFC",
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
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
    if (url.startsWith("http:") || url.startsWith("https:")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  if (options.restrictOrigin) {
    const origin = new URL(options.workspaceUrl).origin;
    const stayOnWorkspace = (event: { preventDefault(): void }, destination: string) => {
      try { if (new URL(destination).origin === origin) return; } catch { /* deny invalid destinations */ }
      event.preventDefault();
    };
    win.webContents.on("will-navigate", stayOnWorkspace);
    win.webContents.on("will-redirect", stayOnWorkspace);
  }
  void win.loadURL(options.workspaceUrl).catch(() => {
    if (win.isDestroyed()) return;
    dialog.showErrorBox("无法打开 BetterMe 工作台", "本机工作台页面加载失败。请检查本机 BetterMe Web 服务后重新打开窗口。");
    win.close();
  });

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
          click: () => shell.openExternal("https://github.com/"),
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
