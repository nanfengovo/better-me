import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Window } from "happy-dom";
import type { LocalRuntimeInfo } from "../src/services/agent-client";

registerHooks({ load(url, context, nextLoad) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : nextLoad(url, context); } });
const dom = new Window({ url: "http://studio-agent-fixture.invalid" });
const React = await import("react");
for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, Event: dom.Event, CustomEvent: dom.CustomEvent, React, IS_REACT_ACT_ENVIRONMENT: true })) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import("react-dom/client");
const { LocalAgentRuntimeProvider, useLocalAgentRuntime } = await import("../src/lib/local-agent-runtime");
const { UiPreferencesProvider } = await import("../src/lib/ui-preferences");
const { AutopilotStudioWorkspace } = await import("../src/components/AutopilotStudioWorkspace");
const { AgentBrandIcon } = await import("../src/components/AgentBrandIcon");
const { createElement: h, act } = React;
let state: ReturnType<typeof useLocalAgentRuntime>;
function SettingsProbe() {
  state = useLocalAgentRuntime();
  return h("div", { id: "settings-icon" }, h(AgentBrandIcon, { id: state.selectedRuntimeId || "unconfigured" }));
}
async function flush(action: () => void | Promise<void> = () => {}) {
  await act(async () => { await action(); await nextTurn(); await nextTurn(); });
}

test("studio and settings share runtime identity, availability and neutral state", async () => {
  const names = [["claude-code", "Claude Code"], ["opencode", "OpenCode"], ["gemini-cli", "Gemini CLI"], ["codex", "Codex"], ["deepseek-harness", "DeepSeek Harness"], ["pi", "Pi"], ["antigravity", "Antigravity"]];
  let runtimes: LocalRuntimeInfo[] = names.map(([id, name]) => ({ id: id!, name: name!, status: "not-installed", capabilities: [] }));
  let offline = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { if (offline) throw new Error("offline"); return Response.json({ runtimes }); }) as typeof fetch;
  const container = dom.document.createElement("main"); dom.document.body.append(container);
  const root = createRoot(container);
  try {
    await flush(() => root.render(h(LocalAgentRuntimeProvider, null,
      h(UiPreferencesProvider, { initialPreferences: { locale: "zh", theme: "light" } }, h(SettingsProbe), h(AutopilotStudioWorkspace)))));
    assert.match(container.querySelector(".studio-agent-trigger")!.textContent, /未配置 Agent/);
    assert.equal(container.querySelector('[data-testid="studio-agent-courier"]')!.hasAttribute("hidden"), true);
    assert.equal(container.querySelectorAll('[data-node-id]').length, 20);
    runtimes = runtimes.map(runtime => ({ ...runtime, status: "available" }));
    await flush(() => state.refresh(true));
    for (const [id, name] of names) {
      await flush(() => state.setSelectedRuntimeId(id!));
      assert.match(container.querySelector(".studio-agent-trigger")!.textContent, new RegExp(name!));
      assert.match(container.querySelector('[data-node-id="1"]')!.textContent, new RegExp(name!));
      for (const icon of container.querySelectorAll("[data-studio-agent]")) assert.equal(icon.getAttribute("data-studio-agent"), id);
      assert.equal(container.querySelector("#settings-icon")!.innerHTML, container.querySelector(".studio-agent-trigger [data-studio-agent]")!.innerHTML);
    }
    let section = "";
    const listener = (event: Event) => { section = (event as CustomEvent<string>).detail; };
    window.addEventListener("betterme:open-settings", listener);
    await flush(() => (container.querySelector(".studio-agent-trigger") as unknown as HTMLButtonElement).click());
    assert.equal(section, "tools");
    window.removeEventListener("betterme:open-settings", listener);
    offline = true;
    await flush(() => state.refresh(true));
    assert.equal(state.ready, false);
    assert.equal(state.selectedRuntimeId, "antigravity");
    assert.match(container.querySelector('[role="status"]')!.textContent, /Host 未连接/);
    offline = false;
    runtimes = runtimes.map(runtime => runtime.id === "antigravity" ? { ...runtime, status: "not-installed" } : runtime);
    await flush(() => state.refresh(true));
    assert.equal(state.selectedRuntimeId, "antigravity");
    assert.equal(state.ready, false);
    await flush(() => state.setSelectedRuntimeId("antigravity"));
    assert.equal(state.ready, false);
    await flush(() => state.setSelectedRuntimeId(""));
    assert.match(container.querySelector(".studio-agent-trigger")!.textContent, /未配置 Agent/);
    assert.equal(state.ready, false);
    assert.equal(container.querySelector('[data-testid="studio-agent-courier"]')!.hasAttribute("hidden"), true);
  } finally { await flush(() => root.unmount()); globalThis.fetch = originalFetch; container.remove(); await dom.happyDOM.cancelAsync(); }
});
