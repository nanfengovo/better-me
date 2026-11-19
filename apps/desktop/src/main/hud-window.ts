import { BrowserWindow } from "electron";
import path from "node:path";

let hudWindow: BrowserWindow | null = null;

export function toggleStarHud(preloadPath: string): BrowserWindow {
  if (hudWindow && !hudWindow.isDestroyed()) {
    if (hudWindow.isVisible()) {
      hudWindow.hide();
      return hudWindow;
    } else {
      hudWindow.show();
      hudWindow.focus();
      return hudWindow;
    }
  }

  hudWindow = new BrowserWindow({
    width: 480,
    height: 380,
    minWidth: 360,
    minHeight: 260,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    hasShadow: true,
    resizable: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  hudWindow.setAlwaysOnTop(true, "floating", 1);
  hudWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  const hudHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  :root {
    --bg: rgba(15, 23, 42, 0.92);
    --border: rgba(56, 189, 248, 0.35);
    --text: #f1f5f9;
    --muted: #94a3b8;
    --accent: #38bdf8;
    --accent-ink: #03131e;
    --warn: #f59e0b;
  }
  *{box-sizing:border-box;margin:0;padding:0;user-select:none}
  body{background:transparent;color:var(--text);font-family:-apple-system,system-ui,sans-serif;padding:8px;font-size:12px;height:100vh;overflow:hidden}
  .window{background:var(--bg);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);border:1.5px solid var(--border);border-radius:14px;height:100%;display:flex;flex-direction:column;box-shadow:0 16px 36px rgba(0,0,0,0.6);overflow:hidden}
  .drag-header{-webkit-app-region:drag;display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.03)}
  .title{font-weight:750;font-size:12px;color:var(--accent);display:flex;align-items:center;gap:6px}
  .controls{-webkit-app-region:no-drag;display:flex;gap:6px}
  .ctrl-btn{cursor:pointer;background:transparent;border:none;color:var(--muted);font-size:13px;padding:2px 6px;border-radius:4px}
  .ctrl-btn:hover{color:#fff;background:rgba(255,255,255,0.1)}
  .tabs{-webkit-app-region:no-drag;display:flex;gap:6px;padding:8px 12px;background:rgba(0,0,0,0.2)}
  .tab-btn{cursor:pointer;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:var(--text);padding:4px 10px;border-radius:6px;font:700 11px monospace}
  .tab-btn.active{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
  .content{-webkit-app-region:no-drag;flex:1;overflow-y:auto;padding:12px 14px;font-size:12.5px;line-height:1.6}
  .defense-box{margin-top:10px;background:rgba(245,158,11,0.1);border:1px dashed var(--warn);padding:8px 10px;border-radius:8px;font-size:11.5px}
  .defense-q{color:var(--warn);font-weight:600;margin-bottom:4px}
  .defense-a{color:var(--muted)}
</style>
</head>
<body>
  <div class="window">
    <div class="drag-header">
      <div class="title"><span>🎙 STAR 实时面试浮动提词 HUD</span></div>
      <div class="controls">
        <button class="ctrl-btn" onclick="window.desktopApi?.toggleStarPrompterHud()">✕</button>
      </div>
    </div>
    <div id="body" class="content"></div>
  </div>
<script>
  const bodyEl = document.getElementById('body');
  const titleEl = document.createElement('b');
  titleEl.textContent = '请先在工作台准备并核对面试材料';
  const descEl = document.createElement('p');
  descEl.style.margin = '6px 0 10px';
  descEl.textContent = '此版本不展示预置的个人经历、指标或未经核对的防守话术，所有面试防御卡片仅来自本人已核对的 FactBase 记录。';
  bodyEl.replaceChildren(titleEl, descEl);
</script>
</body>
</html>`;

  hudWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(hudHtml)}`);
  hudWindow.on("closed", () => {
    hudWindow = null;
  });

  return hudWindow;
}
