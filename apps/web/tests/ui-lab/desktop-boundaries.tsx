import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentSidebarProvider, useAgentSidebar } from "../../src/components/AgentSidebar";
import { BetterMeAgentCenter } from "../../src/components/BetterMeAgentCenter";
import { BetterMeAgentProvider } from "../../src/lib/betterme-agent/react";
import { createMemoryAgentRepository, emptyAgentState } from "../../src/lib/betterme-agent/storage";
import { DesktopShell } from "../../src/components/desktop/DesktopShell";
import type { DesktopPage } from "../../src/components/desktop/DesktopDock";
import { UiPreferencesProvider } from "../../src/lib/ui-preferences";
import "../../src/index.css";
import "../../src/theme.css";
import "../../src/themes/workspace-theme.css";
import "../../src/components/desktop/desktop.css";

// Real Shell, window modes, sidebar and memory cards; synthetic editor/tasks only.
// No account/provider, Host, document store, real source or model is mounted.
window.fetch = async () => Response.json({ status: "unavailable", syntheticOnly: true });
const repository = createMemoryAgentRepository();
const state = emptyAgentState("isolated-panel-polish"); state.revision = 1;
state.tasks = [
  { id: "qa-first", origin: "companion", label: "核对 C# / .NET 经历表达", destination: "本机 Codex", status: "completed", detail: "结果已返回；候选和事实仍需你核对。", memoryIds: [], at: "2026-11-11T05:10:00Z", updatedAt: "2026-11-11T05:12:00Z" },
  { id: "qa-second", origin: "writing", label: "梳理项目中的本人贡献", destination: "本机 Codex", status: "completed", detail: "保留职责边界与原始事实，未自动采用候选表达。\n这是合成任务记录，不是真实简历。", memoryIds: [], at: "2026-11-11T05:13:00Z", updatedAt: "2026-11-11T05:14:00Z" },
  { id: "qa-third", origin: "understanding", label: "项目理解 · 待本人确认", destination: "当前模型", status: "waiting", detail: "请先核对系统边界和项目阶段，再继续认领贡献。", memoryIds: [], at: "2026-11-11T05:15:00Z", updatedAt: "2026-11-11T05:16:00Z" },
];
await repository.save(state, 0);

function Lab() {
  const [page, setPage] = useState<DesktopPage>("agent");
  const [draft, setDraft] = useState("合成草稿：调整窗口边界，不更改任务、授权或简历。");
  const sidebar = useAgentSidebar()!;
  return <>
    <DesktopShell page={page} onNavigate={setPage} onDesign={() => {}} onHistory={() => {}} onAiConfig={() => {}} onNetwork={() => {}}>
      <main style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--ui-canvas)", color: "var(--ui-text)" }}>
        <header style={{ padding: "22px 28px", borderBottom: "1px solid var(--ui-border)", background: "var(--ui-surface)" }}>
          <h1 style={{ margin: "0 0 6px", fontSize: 22 }}>简历与经历</h1>
          <span style={{ color: "var(--ui-text-muted)", fontSize: 13 }}>隔离 UI 验收 · 全部为合成数据</span>
        </header>
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "24px 28px" }}>
          <button type="button" onClick={() => sidebar.show("memory")}>查看合成任务</button>
          <section style={{ marginTop: 24, padding: 24, border: "1px solid var(--ui-border)", borderRadius: 14, background: "var(--ui-surface)" }}>
            <h2 style={{ margin: "0 0 8px", fontSize: 19 }}>修改建议</h2>
            <p style={{ color: "var(--ui-text-muted)", lineHeight: 1.7 }}>保留编辑器与侧栏内容，只核对铺满窗口和工作区的接缝。</p>
            <label htmlFor="boundary-draft" style={{ display: "block", margin: "24px 0 12px", fontWeight: 600 }}>合成编辑器</label>
            <textarea id="boundary-draft" value={draft} onChange={event => setDraft(event.target.value)} style={{ width: "100%", minHeight: 150, padding: 16, border: "1px solid var(--ui-border)", borderRadius: 10, color: "inherit", background: "var(--ui-canvas)" }} />
          </section>
          <div style={{ height: 360, paddingTop: 24, color: "var(--ui-text-muted)" }}>内容滚动区域</div>
        </div>
        <footer style={{ padding: "12px 28px", borderTop: "1px solid var(--ui-border)", background: "var(--ui-surface)", fontSize: 12 }}>合成页脚 · 应贴齐工作区底边</footer>
      </main>
    </DesktopShell>
    <BetterMeAgentCenter onNavigate={() => {}} />
  </>;
}

createRoot(document.getElementById("root")!).render(<UiPreferencesProvider><BetterMeAgentProvider workspaceKey="isolated-panel-polish" repository={repository}><AgentSidebarProvider><Lab /></AgentSidebarProvider></BetterMeAgentProvider></UiPreferencesProvider>);
