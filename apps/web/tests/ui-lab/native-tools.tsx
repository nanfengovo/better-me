import { StrictMode, useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { UnderstandingCapability } from "@better-me/agent-contracts";
import { NativeToolConnections } from "../../src/components/NativeToolConnections";
import { nativeToolStatus } from "../../src/lib/native-tool-status";
import type { UnderstandingClient, NativeLoginState } from "../../src/services/understanding-client";
import { UiPreferencesProvider, useUiPreferences } from "../../src/lib/ui-preferences";
import "../../src/index.css";
import "../../src/studio.css";
import "../../src/theme.css";
import "../../src/themes/workspace-theme.css";

const initial: UnderstandingCapability[] = [
  { id: "codex", name: "Codex", available: true, supported: false, code: "managed_policy_unavailable", authMethods: ["device", "api-key"], reason: "已安装，但当前 Codex 在强制隔离中无法完成 macOS 管理策略同步。未跳过管理员策略，也未发送资料。" },
  { id: "opencode", name: "OpenCode", available: true, supported: false, code: "needs_authorization", authMethods: ["api-key"], reason: "已安装且隔离协议通过；请为本 BetterMe 账号提供独立 API 授权。" },
  { id: "gemini-cli", name: "Gemini CLI", available: true, supported: false, code: "needs_authorization", authMethods: ["api-key"], reason: "已安装且隔离协议通过；不会复制电脑上的共享登录。" },
  { id: "claude-code", name: "Claude Code", available: true, supported: false, code: "needs_authorization", authMethods: ["api-key"], reason: "真实隔离运行与输出协议通过；临时文件也写入账号独立目录。请提供本账号独立 API 授权。" },
  ...["DeepSeek Harness", "Pi", "Antigravity"].map(name => ({ id: name, name, available: false, supported: false, code: "not_installed" as const, authMethods: [], reason: "未找到本机可执行文件；不会自动安装。" })),
];
function App() {
  const [account, setAccount] = useState("合成账号 A"), [version, setVersion] = useState(0), [compatible, setCompatible] = useState(false);
  const states = useMemo(() => new Map<string, UnderstandingCapability[]>(), []);
  const { theme, setTheme } = useUiPreferences();
  const refresh = useCallback(() => setVersion(value => value + 1), []);
  void version;
  const client = useMemo(() => {
    let login: NativeLoginState = { state: "failed" };
    const own = () => states.get(account) ?? structuredClone(initial);
    const unused = async (): Promise<never> => { throw new Error("合成验收禁止业务记录和模型请求"); };
    const result: UnderstandingClient = { createSession: unused, getSession: unused, updateSource: unused, addGrant: unused, revokeGrant: unused, startTurn: unused, confirm: unused, cancel: unused, getCapabilities: async () => own(),
      authorizeNative: async (id, input) => { states.set(account, own().map(item => item.id === id ? { ...item, code: "needs_verification", supported: true, authorized: true, model: input.model, reason: "仅合成凭据已保存；没有模型调用。" } : item)); },
      disconnectNative: async id => { states.set(account, own().map(item => item.id === id ? { ...item, code: "needs_authorization", supported: false, authorized: false, model: undefined } : item)); },
      startNativeLogin: async () => { login = { state: "pending", verificationUrl: "https://auth.openai.com/codex/device", userCode: "DEMO-ONLY" }; return login; },
      getNativeLogin: async () => login,
      cancelNativeLogin: async () => { login = { state: "failed" }; },
    }; return result;
  }, [account, states]);
  const items = (states.get(account) ?? initial).map(item => compatible && item.id === "codex" ? { ...item, code: "needs_authorization" as const, reason: "合成兼容版本场景：用于检查设备登录交互，不是真实授权。" } : item);
  return <main style={{ maxWidth: 720, margin: "0 auto", padding: "24px 16px", color: "var(--ui-text)" }}>
    <h1>本账号工具授权与状态</h1><p>独立合成页面 · 不连接真实账号、简历、记录或模型服务</p>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "16px 0" }}>
      <button onClick={() => setAccount(account === "合成账号 A" ? "合成账号 B" : "合成账号 A")}>切换合成账号</button>
      <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>切换深浅主题</button>
      <button onClick={() => setCompatible(value => !value)}>切换兼容版本场景</button>
    </div><p>当前：{account}</p>
    <label>项目阅读运行方式<select style={{ display: "block", width: "100%", margin: "10px 0 20px" }} defaultValue="model"><option value="model">统一 Agent 所选模型</option>{items.map(item => <option key={item.id} value={item.id} disabled={!item.supported}>{item.name} · {nativeToolStatus(item)}</option>)}</select></label>
    <NativeToolConnections key={`${account}:${compatible}`} items={items} client={client} onChange={refresh} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><UiPreferencesProvider initialPreferences={{ locale: "zh", theme: "light" }}><App /></UiPreferencesProvider></StrictMode>);
