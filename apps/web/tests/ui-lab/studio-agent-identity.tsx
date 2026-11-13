import { createRoot } from "react-dom/client";
import { SWRConfig } from "swr";
import { AutopilotStudioWorkspace } from "../../src/components/AutopilotStudioWorkspace";
import { AgentBrandIcon } from "../../src/components/AgentBrandIcon";
import { LocalAgentRuntimeProvider, useLocalAgentRuntime } from "../../src/lib/local-agent-runtime";
import { UiPreferencesProvider } from "../../src/lib/ui-preferences";
import "../../src/index.css";
import "../../src/theme.css";
import "../../src/components/agent-companion.css";

// Test-only fixture: render production components without authentication or real CLI requests.
const runtimes = [
  ["claude-code", "Claude Code"], ["opencode", "OpenCode"], ["gemini-cli", "Gemini CLI"],
  ["codex", "Codex"], ["deepseek-harness", "DeepSeek Harness"], ["pi", "Pi"], ["antigravity", "Antigravity"],
].map(([id, name]) => ({ id, name, status: "available", capabilities: [] }));
const originalFetch = window.fetch.bind(window);
window.fetch = (input, init) => String(input).includes("/api/v1/agent/runtimes")
  ? Promise.resolve(Response.json({ runtimes })) : originalFetch(input, init);
function Fixture() {
  const { selectedRuntimeId, setSelectedRuntimeId } = useLocalAgentRuntime();
  return <><header style={{ display: "flex", alignItems: "center", gap: 16, padding: 12, background: "#eef4f1", color: "#173e31" }}>
    <strong>隔离验证 · 非真实运行</strong><label>设置中的 Agent <select aria-label="设置中的 Agent" value={selectedRuntimeId} onChange={event => setSelectedRuntimeId(event.target.value)}>
      <option value="">未配置</option>{runtimes.map(runtime => <option key={runtime.id} value={runtime.id}>{runtime.name}</option>)}
    </select></label><span style={{ width: 30, height: 30 }}><AgentBrandIcon id={selectedRuntimeId || "unconfigured"} /></span>
  </header><div style={{ height: "calc(100dvh - 64px)", minHeight: 650 }}><AutopilotStudioWorkspace /></div></>;
}
createRoot(document.getElementById("root")!).render(<SWRConfig value={{ revalidateOnFocus: false }}><LocalAgentRuntimeProvider><UiPreferencesProvider initialPreferences={{ locale: "zh", theme: "light" }}><Fixture /></UiPreferencesProvider></LocalAgentRuntimeProvider></SWRConfig>);
