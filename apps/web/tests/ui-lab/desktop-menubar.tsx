import { useState } from "react";
import { createRoot } from "react-dom/client";
import { DesktopShell } from "../../src/components/desktop/DesktopShell";
import type { DesktopPage } from "../../src/components/desktop/DesktopDock";
import { UiPreferencesProvider } from "../../src/lib/ui-preferences";
import "../../src/index.css";
import "../../src/theme.css";
import "../../src/themes/workspace-theme.css";
import "../../src/components/desktop/desktop.css";

// Real desktop shell and settings, synthetic app body. No account, Host,
// model, real document, service proxy, or remote resource is needed.
window.fetch = async () => Response.json({ status: "unavailable", syntheticOnly: true });
const titles: Record<DesktopPage, string> = {
  resume: "简历工作室", agent: "AI 顾问", opportunities: "岗位与投递",
  atlas: "岗位地图", resources: "资料库", autopilot: "自动化工坊",
};
function Lab() {
  const [page, setPage] = useState<DesktopPage>("resume");
  const [draft, setDraft] = useState("合成验收草稿：隐藏菜单不卸载应用，也不改变简历内容。");
  return <DesktopShell page={page} onNavigate={setPage} onDesign={() => {}} onHistory={() => {}} onAiConfig={() => {}} onNetwork={() => {}}>
    <main style={{ height: "100%", overflow: "auto", padding: "clamp(16px, 3vw, 40px)", background: "var(--ui-surface)", color: "var(--ui-text)" }}>
      <h1 style={{ margin: "0 0 10px", fontSize: 26 }}>{titles[page]}</h1>
      <p style={{ color: "var(--ui-muted)" }}>隔离验收 · 全部为合成数据</p>
      <label style={{ display: "block", margin: "28px 0 12px", fontWeight: 600 }} htmlFor="synthetic-desktop-draft">合成编辑器</label>
      <textarea id="synthetic-desktop-draft" value={draft} onChange={event => setDraft(event.target.value)} style={{ width: "100%", minHeight: 150, padding: 16, border: "1px solid var(--ui-border)", borderRadius: 12, background: "var(--ui-canvas)", color: "inherit", resize: "vertical" }} />
      <div style={{ marginTop: 28, display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,240px),1fr))" }}>
        {["工作区真实扩展", "各 App 共用偏好", "移到顶边唤出"].map((title, i) => <section key={title} style={{ padding: 24, border: "1px solid var(--ui-border)", borderRadius: 16 }}><span style={{ color: "var(--ui-muted)", fontVariantNumeric: "tabular-nums" }}>0{i + 1}</span><h2 style={{ fontSize: 17 }}>{title}</h2><p style={{ lineHeight: 1.7 }}>只改变桌面菜单的显示，不授予执行权限，不保存或发送职业资料。</p></section>)}
      </div>
    </main>
  </DesktopShell>;
}
createRoot(document.getElementById("root")!).render(<UiPreferencesProvider><Lab /></UiPreferencesProvider>);
