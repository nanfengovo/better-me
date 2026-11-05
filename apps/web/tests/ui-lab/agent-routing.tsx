import { StrictMode, useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { defaultAgentRoutingPolicy, type AgentRoutingPolicy, type AgentRoutingTrace, type UnderstandingCapability } from "@better-me/agent-contracts";
import { NativeToolConnections } from "../../src/components/NativeToolConnections";
import { AgentBaseControls } from "../../src/components/AgentBaseControls";
import { AgentTopBarStatus } from "../../src/components/AgentTopBarStatus";
import { AgentRoutingProvider, useAgentRouting } from "../../src/lib/agent-routing";
import type { AgentRoutingClient } from "../../src/services/agent-routing-client";
import { AgentRoutingClientError } from "../../src/services/agent-routing-client";
import type { UnderstandingClient, NativeLoginState } from "../../src/services/understanding-client";
import { UiPreferencesProvider, useUiPreferences } from "../../src/lib/ui-preferences";
import "../../src/index.css";
import "../../src/studio.css";
import "../../src/theme.css";
import "../../src/themes/workspace-theme.css";

const initial: UnderstandingCapability[] = [
  { id: "codex", name: "Codex", available: true, supported: false, code: "managed_policy_unavailable", authMethods: ["device", "api-key"], reason: "已安装；强制隔离中无法完成 macOS 管理策略同步。未绕过限制，自动模式可继续检查已批准备选。" },
  { id: "claude-code", name: "Claude Code", available: true, supported: false, code: "needs_authorization", authMethods: ["browser", "api-key"], reason: "优先为本 BetterMe 账号独立登录 Claude 订阅；不会复制电脑上的共享登录。" },
  { id: "opencode", name: "OpenCode", available: true, supported: false, code: "needs_authorization", authMethods: ["api-key"], reason: "已安装并支持隔离适配；当前原生交互登录尚未接入，可明确选择独立 API 授权。" },
  { id: "gemini-cli", name: "Gemini CLI", available: true, supported: false, code: "needs_authorization", authMethods: ["api-key"], reason: "已安装并支持隔离适配；当前原生交互登录尚未接入，可明确选择独立 API 授权。" },
  ...["deepseek-harness", "pi", "antigravity"].map(id => ({ id, name: id, available: false, supported: false, code: "not_installed" as const, authMethods: [], reason: "未找到可执行文件，不自动安装。" })),
];
type Demo = { items: UnderstandingCapability[]; policy: AgentRoutingPolicy; trace?: AgentRoutingTrace; login: NativeLoginState };
function Execute() {
  const routing = useAgentRouting()!, [notice, setNotice] = useState("");
  return <section style={{ margin: "20px 0" }}><button disabled={!routing.enabled} onClick={() => void routing.respond("仅合成验收，不含业务资料", [{ role: "user", content: "请解释合成任务边界。" }], new AbortController().signal).then(reply => setNotice(reply.text), failure => setNotice(failure.message))}>发送合成任务</button><p role="status">{notice}</p></section>;
}
function App() {
  const [account, setAccount] = useState("合成账号 A"), [version, setVersion] = useState(0);
  const states = useMemo(() => new Map<string, Demo>(), []);
  const { theme, setTheme } = useUiPreferences();
  const refresh = useCallback(() => { setVersion(value => value + 1); window.dispatchEvent(new Event("betterme:native-tools-changed")); }, []);
  void version;
  if (!states.has(account)) states.set(account, { items: structuredClone(initial), policy: { ...structuredClone(defaultAgentRoutingPolicy), preferred: "codex", backups: ["claude-code", "opencode", "gemini-cli"] }, login: { state: "failed" } });
  const demo = states.get(account)!;
  const tools = useMemo(() => {
    const own = () => states.get(account)!;
    const unused = async (): Promise<never> => { throw new Error("合成验收禁止业务记录和真实模型请求"); };
    const result: UnderstandingClient = { createSession: unused, getSession: unused, updateSource: unused, addGrant: unused, revokeGrant: unused, startTurn: unused, confirm: unused, cancel: unused, getCapabilities: async () => own().items,
      authorizeNative: async (id, input) => { own().items = own().items.map(item => item.id === id ? { ...item, code: "needs_verification", supported: true, authorized: true, authorizationMode: "api-key", model: input.model, reason: "仅合成凭据已保存，尚未调用真实模型。" } : item); },
      disconnectNative: async id => { own().items = own().items.map(item => item.id === id ? { ...item, code: "needs_authorization", supported: false, authorized: false, authorizationMode: undefined, model: undefined } : item); },
      startNativeLogin: async () => { own().login = { state: "pending", runtimeId: "claude-code", acceptsCode: true, verificationUrl: "https://claude.com/cai/oauth/authorize?response_type=code&state=LAB-STATE" }; return own().login; },
      getNativeLogin: async () => own().login,
      submitNativeCode: async code => { if (code !== "LAB-CODE#LAB-STATE") throw new Error("合成页仅接受 LAB-CODE#LAB-STATE，不接受真实授权码"); own().items = own().items.map(item => item.id === "claude-code" ? { ...item, supported: true, authorized: true, authorizationMode: "native", code: "needs_verification", reason: "仅演示原生授权已保存；不是实际云端登录。" } : item); own().login = { state: "complete", runtimeId: "claude-code" }; },
      cancelNativeLogin: async () => { own().login = { state: "failed" }; },
    }; return result;
  }, [account, states]);
  const client = useMemo((): AgentRoutingClient => ({
    status: async () => ({ policy: structuredClone(demo.policy), trace: demo.trace }),
    update: async next => { if (next.revision !== demo.policy.revision) throw new Error("配置已变化"); demo.policy = { ...next, revision: next.revision + 1 }; return structuredClone(demo.policy); },
    respond: async input => {
      const trace: AgentRoutingTrace = { id: input.id, policyRevision: input.expectedRevision, state: "running", at: new Date().toISOString(), attempts: [] };
      for (const id of demo.policy.mode === "auto" ? [demo.policy.preferred, ...demo.policy.backups] : [demo.policy.preferred]) {
        const item = demo.items.find(value => value.id === id)!;
        if (!item.supported || demo.policy.mode === "auto" && item.authorizationMode === "api-key" && !demo.policy.allowApiBackups) { trace.attempts.push({ runtimeId: id, status: "skipped", code: item.code ?? "not_installed", reason: item.reason ?? "当前不可用" }); continue; }
        trace.runtimeId = id; trace.state = "completed"; trace.attempts.push({ runtimeId: id, status: "completed", code: "completed", reason: "按本账号已批准顺序选择可用底座，原生订阅优先；未切换付费 API。" }); demo.trace = trace;
        return { text: `合成任务由 ${item.name} 完成；未调用模型，未写入简历或业务记录。`, trace };
      }
      trace.state = "failed"; demo.trace = trace; throw new AgentRoutingClientError("no_approved_runtime", trace);
    },
  }), [demo]);
  return <main style={{ maxWidth: 760, margin: "0 auto", padding: "24px 16px", color: "var(--ui-text)" }}>
    <h1>BetterMe · 统一 Agent 底座</h1><p>独立合成验收 · 不连接真实账号、简历、记录或模型服务</p>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "16px 0" }}><button onClick={() => setAccount(account === "合成账号 A" ? "合成账号 B" : "合成账号 A")}>切换合成账号</button><button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>切换深浅主题</button></div><p>当前：{account} · 演示授权码：LAB-CODE#LAB-STATE（不要输入真实凭据）</p>
    <AgentRoutingProvider key={account} client={client}><AgentTopBarStatus config={null} active={false} onNavigateToAgent={() => {}} onOpenAiConfig={() => {}} /><AgentBaseControls model="原有模型保持不变" legacy="current" onLegacy={() => {}} client={tools} /><Execute />
      <h2>已安装底座 · 本账号独立授权</h2><NativeToolConnections key={account} items={demo.items} client={tools} onChange={refresh} />
    </AgentRoutingProvider>
  </main>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><UiPreferencesProvider initialPreferences={{ locale: "zh", theme: "light" }}><App /></UiPreferencesProvider></StrictMode>);
