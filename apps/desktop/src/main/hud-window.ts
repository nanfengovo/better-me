import { BrowserWindow } from "electron";
import path from "node:path";

let hudWindow: BrowserWindow | null = null;

export function toggleStarHud(preloadPath: string, initialTab: string = "S"): BrowserWindow {
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
    <div class="tabs">
      <button class="tab-btn active" onclick="setTab('S')">S · 情境</button>
      <button class="tab-btn" onclick="setTab('T')">T · 任务</button>
      <button class="tab-btn" onclick="setTab('A')">A · 行动</button>
      <button class="tab-btn" onclick="setTab('R')">R · 成果</button>
    </div>
    <div id="body" class="content"></div>
  </div>
<script>
  let cur = 'S';
  const data = {
    S: { t: 'Situation 情境', c: '高并发仓储自动化中枢 (RCS) 在多机抢道时偶发死锁，吞吐骤降 32%。', q: '「如何避免高并发下的竞态条件？」', a: '采用无锁分段拓扑与动态死锁周期探测，FB-02 详载纳秒级延迟断言。' },
    T: { t: 'Task 任务', c: '负责核心调度引擎重构，需在 0 停机与纳秒级锁粒度约束下消解死锁瓶颈。', q: '「重构周期内如何保障旧系统平稳过渡？」', a: '双写验证与回滚开关，通过影子流量进行 72 小时全真比对。' },
    A: { t: 'Action 行动', c: '采用无锁分段通道设计，拆解为拓扑前向依赖图与环路动态探测，引入 SIMD 批量权重。', q: '「SIMD 矢量优化对硬件有何特定依赖？」', a: '自适应探测 AVX-512/Neon，缺失时无缝回退至标量批处理通道。' },
    R: { t: 'Result 成果', c: '死锁率降至 0，单节点吞吐提升 4.2x，99.9 分位调度延迟压降至 1.8ms。', q: '「压测基准与生产真实指标差异多大？」', a: '全链路灰度实测与压测一致性达 98.4%，已全量稳定运行 6 个月。' }
  };
  function render() {
    const item = data[cur];
    document.getElementById('body').innerHTML = '<b>' + item.t + '</b><p style="margin:4px 0 8px">' + item.c + '</p>' +
      '<div class="defense-box"><div class="defense-q">🛡 考官高频追问防线：' + item.q + '</div><div class="defense-a">✦ 预置防御话术：' + item.a + '</div></div>';
    document.querySelectorAll('.tab-btn').forEach((b, idx) => {
      b.classList.toggle('active', ['S','T','A','R'][idx] === cur);
    });
  }
  function setTab(k) { cur = k; render(); }
  render();
</script>
</body>
</html>`;

  hudWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(hudHtml)}`);
  hudWindow.on("closed", () => {
    hudWindow = null;
  });

  return hudWindow;
}
