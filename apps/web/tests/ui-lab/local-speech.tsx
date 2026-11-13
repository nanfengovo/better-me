import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { LlmConfig } from "@better-me/core";
import type { ChatMessage } from "../../src/services/agent-client";
import { AgentCompanion } from "../../src/components/AgentCompanion";
import { AgentWorkspace } from "../../src/components/AgentWorkspace";
import { initialAdvisorRecovery } from "../../src/lib/advisor-recovery";
import { activatePrincipal } from "../../src/lib/identity";
import { privateStorage } from "../../src/lib/private-storage";
import { UiPreferencesProvider } from "../../src/lib/ui-preferences";
import "../../src/index.css";
import "../../src/theme.css";
import "../../src/themes/workspace-theme.css";

const qa = { modelCalls: 0, network: [] as string[], speech: [] as Array<Record<string, unknown>> };
Object.assign(window, { __localSpeechQA: qa });
// Observe, do not replace, the actual OS-backed synthesis engine.
if (window.speechSynthesis) {
  const nativeSpeak = window.speechSynthesis.speak.bind(window.speechSynthesis);
  const nativeCancel = window.speechSynthesis.cancel.bind(window.speechSynthesis);
  window.speechSynthesis.speak = utterance => {
    qa.speech.push({ type: "call", text: utterance.text, local: utterance.voice?.localService, lang: utterance.lang });
    for (const type of ["start", "end", "error", "boundary"]) utterance.addEventListener(type, event => {
      qa.speech.push({ type, text: utterance.text, ...(event instanceof SpeechSynthesisErrorEvent ? { error: event.error } : {}) });
    });
    nativeSpeak(utterance);
  };
  window.speechSynthesis.cancel = () => { qa.speech.push({ type: "cancel" }); nativeCancel(); };
}
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  qa.network.push(`${init?.method ?? "GET"} ${url.pathname}`);
  if (url.pathname.endsWith("/runtimes")) return Response.json({ runtimes: [] });
  return Response.json({ status: "unavailable", profiles: [], tasks: [], syntheticOnly: true });
};
activatePrincipal({ id: "00000000-0000-4000-8000-000000000426", username: "synthetic-speech-only", displayName: "合成语音验收" });
const providers = ["DeepSeek", "Ollama", "OpenAI", "Google"] as const;
const messages: ChatMessage[] = [{ id: "synthetic-user", role: "user", content: "模拟回复只验证本机朗读，不包含个人经历。" }, ...providers.map((provider, index) => ({
  id: `synthetic-${provider}`, role: "assistant" as const,
  content: `**${provider} 模拟回复**\n\n先确认目标，再做一个小练习。保存断点后，可以关闭再继续。\n\nThis is a synthetic ${provider} reply. Save your checkpoint, then continue when you are ready.`,
  meta: { provider: index === 1 ? "ollama" as const : index === 3 ? "gemini" as const : "openai-compatible" as const,
    providerLabel: provider, model: `synthetic-${provider}`, source: "agent-host" as const, status: "ready" as const, completeness: "complete" as const, observedAt: "2026-11-13T00:00:00Z" },
})), { id: "synthetic-error", role: "assistant", content: "⚠️ 合成错误：这条不应出现朗读按钮。" }];
const seed = (key: string, value: unknown) => {
  if (!privateStorage.getItem(key)) privateStorage.setItem(key, JSON.stringify({ version: 1, value }));
};
seed("betterme.recovery.v1:companion:synthetic-speech", { messages, draft: "合成未发送草稿，朗读和重开都应保留。", references: [], attachments: [], prompt: "", pending: false });
const job = { title: "合成测试岗位", company: "合成项目", description: "只用于朗读界面验收，不是求职数据。" };
seed("betterme.recovery.v1:advisor:synthetic-speech", { ...initialAdvisorRecovery(job), messages, inputMessage: "合成未发送草稿，朗读和重开都应保留。" });
const llmConfig: LlmConfig = { provider: "ollama", model: "synthetic-no-model", baseUrl: "http://127.0.0.1:1/v1" };
const noSend = async (): Promise<ChatMessage> => { qa.modelCalls++; throw new Error("隔离朗读验收不允许模型请求。"); };

function Lab() {
  const [pane, setPane] = useState(new URLSearchParams(location.search).get("pane") ?? "companion");
  const [mounted, setMounted] = useState(true);
  return <UiPreferencesProvider initialPreferences={{ theme: new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light" }}>
    <div style={{ height: "100dvh", display: "flex", flexDirection: "column", color: "var(--ui-text)", background: "var(--ui-canvas)" }}>
      <header style={{ padding: "12px 20px", borderBottom: "1px solid var(--ui-border)", display: "flex", flexWrap: "wrap", gap: 16, fontSize: 12 }}>
        <strong>本机朗读 · 四种模型模拟回复</strong><button onClick={() => setPane("companion")}>伴侣入口</button><button onClick={() => setPane("advisor")}>工作区入口</button>
        <button onClick={() => setMounted(value => !value)}>{mounted ? "卸载会话" : "恢复会话"}</button>
      </header>
      <main style={{ flex: 1, minHeight: 0, position: "relative", display: "flex", flexDirection: "column" }}>
        {mounted && (pane === "companion" ? <AgentCompanion workspaceKey="synthetic-speech" llmConfig={llmConfig} sendChat={noSend} onOpenWorkspace={() => {}} onOpenAiConfig={() => {}} /> :
          <AgentWorkspace workspaceKey="synthetic-speech" llmConfig={llmConfig} job={job} sendChat={noSend} onOpenConfig={() => {}} onNavigateToResume={() => {}} onApplyToResume={() => {}} />)}
      </main>
    </div>
  </UiPreferencesProvider>;
}
createRoot(document.getElementById("root")!).render(<Lab />);
