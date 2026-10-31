import { useEffect, useMemo, useRef, useState } from "react";
import type { LlmConfig } from "@better-me/core";
import { sendAgentChat } from "../../services/agent-client";
import { getRealChromeStatus } from "../../lib/real-chrome-client";
import type { HarvestIssue } from "./harvest-issue-presentation";
import { buildHarvestTriage, createHarvestAgentPrompt } from "./harvest-agent-triage";

function isLocalModel(config?: LlmConfig): boolean {
  if (config?.provider !== "ollama") return false;
  try { return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(config.baseUrl).hostname); }
  catch { return false; }
}

/** The assistant may inspect local health and interpret limited receipts, never start a crawl or edit user data. */
export function AtlasHarvestAdvisor({ issues, saved, config, active, onAskAgent }: {
  issues: readonly HarvestIssue[]; saved?: number; config?: LlmConfig; active: boolean; onAskAgent?: (prompt: string) => void;
}) {
  const triage = buildHarvestTriage(issues, saved);
  const [chromeHealth, setChromeHealth] = useState<"checking" | "ready" | "offline" | null>(null);
  const [analysis, setAnalysis] = useState<{ key: string; state: "working" | "ready" | "error"; text: string } | null>(null);
  const [requested, setRequested] = useState(false);
  const [retry, setRetry] = useState(0);
  const requestRef = useRef<AbortController | null>(null);
  const local = isLocalModel(config);
  const prompt = useMemo(() => createHarvestAgentPrompt(issues, saved), [issues, saved]);
  const analysisKey = `${config?.provider ?? "none"}:${config?.model ?? ""}:${prompt}`;

  useEffect(() => {
    if (!active || !issues.length) return;
    let cancelled = false;
    setChromeHealth("checking");
    void getRealChromeStatus().then(status => { if (!cancelled) setChromeHealth(status.running ? "ready" : "offline"); });
    return () => { cancelled = true; };
  }, [active, issues.length]);

  useEffect(() => {
    if (!active || !issues.length || !config || (!local && !requested)) return;
    const controller = new AbortController();
    requestRef.current?.abort();
    requestRef.current = controller;
    const timer = setTimeout(() => {
      setAnalysis({ key: analysisKey, state: "working", text: "" });
      void sendAgentChat({
        llmConfig: config, signal: controller.signal,
        messages: [{ id: `atlas-triage-${Date.now()}`, role: "user", content: prompt, createdAt: new Date().toISOString() }],
      }).then(reply => {
        if (!controller.signal.aborted) setAnalysis({ key: analysisKey, state: "ready", text: reply.content.trim().slice(0, 900) });
      }).catch(() => {
        if (!controller.signal.aborted) setAnalysis({ key: analysisKey, state: "error", text: "模型暂不可用；上面的回执判断与已保存结果不受影响。" });
      });
    }, 700);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [active, analysisKey, config, issues.length, local, prompt, requested, retry]);

  if (!issues.length) return null;
  const current = analysis?.key === analysisKey ? analysis : null;
  return <div className="atlas-harvest-advisor" aria-label="Agent 采集诊断与建议">
    <strong>Agent 已整理本轮异常</strong>
    <p>{triage.summary}</p>
    <p>下一步：{triage.nextStep}</p>
    <small>已自动检查本机浏览器接管：{chromeHealth === "ready" ? "已连接" : chromeHealth === "offline" ? "未连接，可检查独立 Chrome" : "检查中"}。不会自动重试平台、登录、处理验证码或改写简历。</small>
    {config && (local || requested) && <details className="atlas-harvest-advisor-model">
      <summary aria-live="polite">{current?.state === "ready" ? "查看 Agent 的补充建议" : current?.state === "error" ? "Agent 模型暂不可用 · 查看说明" : "Agent 正在补充分析 · 查看状态"}{local ? "（本地 Ollama）" : "（当前配置）"}</summary>
      <p>{current?.state === "ready" ? current.text || "模型未返回建议，请按上面的回执继续。" : current?.state === "error" ? current.text : "正在根据结构化回执分析，不发送原始页面、令牌或简历…"}</p>
    </details>}
    {current?.state === "working" && <button type="button" onClick={() => {
      requestRef.current?.abort();
      setAnalysis({ key: analysisKey, state: "error", text: "已停止模型分析；上面的回执判断与已保存结果不受影响。" });
    }}>停止模型分析</button>}
    {current?.state === "error" && <button type="button" onClick={() => setRetry(count => count + 1)}>重新分析</button>}
    {config && !local && !requested && <button type="button" onClick={() => setRequested(true)}>让当前模型补充分析</button>}
    {onAskAgent && <button type="button" onClick={() => onAskAgent(`${prompt}\n请先问我一个最关键的核对问题，等我回答后再提出下一步。`)}>在 Agent 对话里继续排查</button>}
  </div>;
}
