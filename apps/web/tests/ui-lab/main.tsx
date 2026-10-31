import { useState } from "react";
import { createRoot } from "react-dom/client";
import AtlasWorkspace from "../../src/components/AtlasWorkspace";
import { UiPreferencesProvider, useUiPreferences } from "../../src/lib/ui-preferences";
import { ConfirmationProvider } from "../../src/components/ConfirmationDialog";
import { AgentCompanion } from "../../src/components/AgentCompanion";
import { AgentTopBarStatus } from "../../src/components/AgentTopBarStatus";
import { WorkspacePreferences } from "../../src/components/WorkspacePreferences";
import { installCompanionFixture } from "./companion-fixture";
import { createLabMetrics } from "./metrics";
import "../../src/index.css";
import "../../src/studio.css";
import "../../src/theme.css";
import "../../src/atelier.css";
import "../../src/themes/workspace-theme.css";
import "../../src/components/confirmation.css";
import "./ui-lab.css";

const parameters = new URLSearchParams(location.search);
const size = parameters.get("size") === "15000" ? 15000 : 5000;
const scenario = parameters.get("scenario") ?? "ready";
const compact = parameters.get("controls") === "hidden";
const companion = parameters.get("companion") === "1";
const shell = parameters.get("shell") === "1";
if (companion) installCompanionFixture();
// A unique origin and token, with no imported cookies or user browser profile.
sessionStorage.removeItem("better-me:atlas-connection-session:v1");
sessionStorage.removeItem("better-me:atlas-dev-autoconnect-suppressed:v1");
const session = fetch("/__atlas-ui-lab/session", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ size, scenario }) }).then(async response => {
    if (!response.ok) throw new Error(`Lab session failed: ${response.status}`);
    return response.json() as Promise<{ token: string; size: number; scenario: string }>;
  });
let labToken: string | undefined;
void session.then(({ token }) => { labToken = token; });
window.addEventListener("pagehide", event => {
  if (event.persisted || !labToken) return;
  void fetch("/__atlas-ui-lab/close", { method: "POST", keepalive: true,
    headers: { authorization: `Bearer ${labToken}`, "content-type": "application/json" }, body: "{}" }).catch(() => {});
});
const metrics = createLabMetrics();
async function command(action: string) {
  const { token } = await session;
  const response = await fetch("/__atlas-ui-lab/control", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ action }) });
  if (!response.ok) throw new Error(`Lab command failed: ${response.status}`);
  return (await response.json()).value;
}
async function state() {
  const { token } = await session;
  return (await (await fetch("/__atlas-ui-lab/state", { headers: { authorization: `Bearer ${token}` } })).json()).value;
}
const bootstrap = async (signal: AbortSignal) => {
  const { token } = await session; signal.throwIfAborted();
  return { ok: true as const, endpoint: location.origin, token };
};
const lab = { metrics, command, state, session: session.then(({ size, scenario }) => ({ size, scenario })),
  description: "Isolated synthetic fixture, real AtlasWorkspace/Worker/MapLibre. No private data, real collection or AI." };
Object.assign(window, { __atlasUiLab: lab });

function Lab() {
  const { theme, setTheme } = useUiPreferences();
  const [streaming, setStreaming] = useState(false);
  const [message, setMessage] = useState("");
  const [measuring, setMeasuring] = useState(false);
  const [measurement, setMeasurement] = useState("");
  const act = (action: string) => void command(action).then(value => {
    setStreaming(value.streaming); setMessage(`${value.jobs.toLocaleString("zh-CN")} 岗 · revision ${value.revision} · ${value.scenario}`);
  }).catch(error => setMessage(error.message));
  return <div className={`atlas-ui-lab ${shell ? "studio-workspace" : ""}`}>
    {shell && <header className="studio-header no-print"><div className="studio-brand"><strong>BetterMe</strong><span>岗位地图</span></div><div className="header-actions"><WorkspacePreferences /><span className="save-indicator" role="status">✓ <span>合成简历 · 不读写真实档案</span></span><AgentTopBarStatus config={null} active={false} onNavigateToAgent={() => setMessage("隔离验收不打开真实工作台")} onOpenAiConfig={() => setMessage("隔离验收不修改模型配置")} /><button className="studio-button subtle" type="button">AI 配置</button><div className="studio-user">测</div></div></header>}
    <header className={`atlas-ui-lab-toolbar ${compact ? "is-compact" : ""}`}>
      <div><strong>BetterMe</strong><span>隔离 UI 验收 · {size.toLocaleString("zh-CN")} 岗合成样本 · 不连接真实岗位 / 简历</span></div>
      {!compact && <div className="atlas-ui-lab-actions">
        <button type="button" onClick={() => setTheme(theme === "light" ? "dark" : "light")}>{theme === "light" ? "深色验收" : "浅色验收"}</button>
        <button type="button" onClick={() => act(streaming ? "stop" : "start")}>{streaming ? "停止合成增量" : "开始合成增量"}</button>
        <button type="button" onClick={() => act("attention")}>模拟补全异常</button>
        <button type="button" onClick={() => act("ready")}>恢复正常</button>
        <button type="button" onClick={() => { if (measuring) { setMeasurement(JSON.stringify(metrics.stop(), null, 2)); setMeasuring(false); } else { metrics.start(`${size} jobs, Cesium scene interaction`); setMeasurement(""); setMeasuring(true); } }}>{measuring ? "结束性能记录" : "开始性能记录"}</button>
        <output aria-live="polite">{message}</output>
      </div>}
    </header>
    {measurement && <details className="atlas-ui-lab-measurement" open><summary>浏览器性能记录（实验室采样，非生产 INP）</summary><pre>{measurement}</pre></details>}
    <main className={shell ? "secondary-workspace" : undefined}><AtlasWorkspace active devJobIndex={bootstrap} onSaveOpportunity={() => setMessage("隔离验收不写入机会库")}
      onAnalyze={() => setMessage("隔离验收不调用 AI")} /></main>
    {companion && <AgentCompanion llmConfig={{provider:"gemini",model:"gemini-ui-fixture",baseUrl:"https://synthetic-model.invalid",apiKey:"",temperature:.3}}
      onOpenWorkspace={()=>setMessage("隔离验收不打开真实 Agent 工作台")} onOpenAiConfig={()=>setMessage("隔离验收不修改模型配置")} />}
  </div>;
}

createRoot(document.getElementById("root")!).render(<UiPreferencesProvider initialPreferences={{ locale: "zh", theme: parameters.get("theme") === "dark" ? "dark" : "light", workspaceThemeId: "graphite" }}>
  <ConfirmationProvider><Lab /></ConfirmationProvider>
</UiPreferencesProvider>);
