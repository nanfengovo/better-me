import { createRoot } from "react-dom/client";
import { AgentWorkspace } from "../../src/components/AgentWorkspace";
import { UiPreferencesProvider } from "../../src/lib/ui-preferences";
import { useWorkspaceNavigation } from "../../src/lib/workspace-navigation";
import { projectResume } from "@better-me/core";
import { createInitialDocument } from "@better-me/storage";
import "../../src/index.css";
import "../../src/theme.css";
import "../../src/themes/workspace-theme.css";

// Full real UI, synthetic replies only. No service, account, model, user data,
// credentials or external fetch is touched by this fixture.
let calls = Number(sessionStorage.getItem("synthetic-recovery-calls") ?? "0");
let matchingCalls = Number(sessionStorage.getItem("synthetic-recovery-matching-calls") ?? "0");
Object.assign(window, { __recoveryQa: { get calls() { return calls; }, get matchingCalls() { return matchingCalls; }, syntheticOnly: true } });
window.fetch = async input => {
  const pathname = new URL(String(input), window.location.href).pathname;
  if (pathname.endsWith("/start")) {
    matchingCalls++; sessionStorage.setItem("synthetic-recovery-matching-calls", String(matchingCalls));
    return Response.json({ status: "awaiting_review", threadId: "synthetic-matching-thread", proposals: [], errors: [], backend: "agent-host" });
  }
  if (pathname.endsWith("/chat")) {
    calls++; sessionStorage.setItem("synthetic-recovery-calls", String(calls));
    return Response.json({ reply: { id: `synthetic-reply-${calls}`, role: "assistant", content: "合成回答：你的交互记录会留在本机，恢复时不会重新请求模型。", createdAt: new Date().toISOString() } });
  }
  return Response.json({ status: "ok" });
};
const document = createInitialDocument();
const resume = projectResume(document.factBase, document.resumeViews[0]!);
const job = { title: "合成 TypeScript 工程师", company: "隔离验收公司", description: "负责合成页面的交互状态与恢复机制。" };
function Lab() {
  const navigation = useWorkspaceNavigation();
  return <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "var(--ui-canvas)", color: "var(--ui-text)" }}>
    <header style={{ padding: 12, borderBottom: "1px solid var(--ui-border)", display: "flex", gap: 16 }}><strong>隔离验收 · 全部为合成数据</strong><button onClick={() => navigation.setPage("agent")}>打开 AI 顾问</button><button onClick={() => navigation.setPage("resume")}>回到简历页</button></header>
    {navigation.page === "agent" ? <AgentWorkspace workspaceKey="synthetic-browser-recovery" job={job} resume={resume}
      llmConfig={{ provider: "ollama", baseUrl: "https://synthetic.invalid", model: "synthetic-only", apiKey: "" }}
      onOpenConfig={() => {}} onNavigateToResume={() => navigation.setPage("resume")} onApplyToResume={() => { throw new Error("fixture never writes a resume"); }} />
      : <main style={{ padding: 40 }}><h1>合成简历页</h1><p>返回 AI 顾问可恢复刚才的输入与交互；这里未打开真实简历。</p></main>}
  </div>;
}
createRoot(window.document.getElementById("root")!).render(<UiPreferencesProvider initialPreferences={{ locale: "zh", theme: "light" }}><Lab /></UiPreferencesProvider>);
