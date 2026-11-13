import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { careerRuntimeBinding, studioAnalysisRuntime, type AgentTask } from "@better-me/agent-contracts";
import { StudioOperationSchema, type StudioContext, type StudioOperation } from "@better-me/agent-contracts/career-studio";
import { CareerAnalysisPanel } from "../../src/components/CareerAnalysisPanel";
import { createCareerStudioClient } from "../../src/services/career-studio-client";
import { activatePrincipal, ownedFetch } from "../../src/lib/identity";
import { readRuntimeConnection } from "../../src/lib/runtime-connection";
import "../../src/index.css";
import "../../src/theme.css";
import "../../src/components/CareerStudioWorkspace.css";

const model = { model: "synthetic-committee-browser", modelDigest: "a".repeat(64) }, runtime = studioAnalysisRuntime(model.model), client = createCareerStudioClient();
const headers = () => ({ Authorization: `Bearer ${readRuntimeConnection()!.agentToken}`, "Content-Type": "application/json" });
async function taskRequest(path: string, body?: unknown) {
  const response = await ownedFetch(`/api/v1/agent/tasks${path}`, { headers: headers(), ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
  const result = await response.json(); if (!response.ok) throw Error(JSON.stringify(result)); return result;
}
function Lab() {
  const [context, setContext] = useState<StudioContext>(), [operation, setOperation] = useState<StudioOperation>(), [error, setError] = useState(""), [metrics, setMetrics] = useState("");
  useEffect(() => { const timer = setInterval(() => void fetch("/__committee-task-qa/state").then(row => row.text()).then(setMetrics), 500); return () => clearInterval(timer); }, []);
  useEffect(() => { if (operation?.status !== "running" || !context) return;
    const abort = new AbortController(), timer = setInterval(() => void client.operation(context.id, operation.id, abort.signal).then(setOperation).catch(cause => { if (!abort.signal.aborted) setError(String(cause)); }), 250);
    return () => { abort.abort(); clearInterval(timer); };
  }, [operation?.id, operation?.status, context]);
  const initialize = async () => { try {
    let task = (await taskRequest("", { kind: "free_chat", workspaceKey: "browser-prior-chat", rootScopeKey: "browser-committee-workspace", objective: "合成原根，不共享旧聊天",
      conversation: { messages: [{ id: "first", role: "user", content: "PRIVATE-PRIOR-CHAT" }] }, runtimeBinding: careerRuntimeBinding(runtime),
      budget: { maxModelCalls: 30, maxToolCalls: 500, maxActiveMs: 120000 }, consent: true, idempotencyKey: "synthetic-browser-committee-root" })).task as AgentTask;
    if (task.status === "ready") await taskRequest(`/${task.id}/start`, { expectedRevision: task.revision, sourceFingerprint: task.sourceFingerprint, runtimeBinding: task.runtimeBinding, consent: true, runtime });
    for (let i = 0; i < 100; i++) { task = (await taskRequest(`/${task.id}`)).task; if (task.status !== "running") break; await new Promise(resolve => setTimeout(resolve, 20)); }
    const selected = await client.context({ workspaceKey: "browser-committee-workspace", resumeId: "synthetic-resume", sourceFingerprint: "b".repeat(64), consent: true,
      claims: [{ id: "claim-a", text: "参与合成租约设计；本人主导和生产部署未知。", skillIds: [], contribution: "design", confirmedByUser: false, confirmedNumericTokens: [] }], jobs: [] });
    await client.request("/runtime/select", { contextId: selected.context.id, runtime: model, consent: true }); setContext(selected.context);
  } catch (cause) { setError(String(cause)); } };
  return <main className="career-studio" style={{ minHeight: "100dvh", height: "auto", padding: 24, overflow: "auto", background: "var(--ui-canvas)", color: "var(--ui-text)" }}>
    <h1>委员会 · 真实 tasks HTTP</h1><p>仅合成账号、源码与脚本模型；第4次委员会回复故意部分结束。不会接触真实账号、简历或模型。</p>
    {!context && <button onClick={() => void initialize()}>明确建立合成审查范围</button>}
    {context && <CareerAnalysisPanel kind="committee" context={context} runtime={model} request={client.request} operation={operation} onOperation={value => setOperation(StudioOperationSchema.parse(value))} claimTargets={{}} />}
    {error && <pre role="alert">{error}</pre>}<details open><summary>独立 Host 观测</summary><pre id="qa-metrics">{metrics}</pre></details>
  </main>;
}
async function start() {
  const current = await (await fetch("/api/v1/agent/identity/session", { headers: headers() })).json();
  const account = current.principal ? current : await (await fetch("/api/v1/agent/identity/register", { method: "POST", headers: headers(), body: JSON.stringify({ username: "synthetic-committee-browser", displayName: "隔离委员会验收", password: "synthetic-only-browser-2026" }) })).json();
  if (!account.principal) throw Error("synthetic login failed"); activatePrincipal(account.principal); createRoot(document.getElementById("root")!).render(<Lab />);
}
void start().catch(error => { document.getElementById("root")!.textContent = String(error); });
