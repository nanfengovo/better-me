import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Window } from "happy-dom";

registerHooks({ load(url, context, nextLoad) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : nextLoad(url, context); } });
const dom = new Window({ url: "http://studio-agent-fixture.invalid" });
const React = await import("react");
for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, Event: dom.Event, CustomEvent: dom.CustomEvent, React, IS_REACT_ACT_ENVIRONMENT: true })) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import("react-dom/client");
const { LocalAgentRuntimeProvider } = await import("../src/lib/local-agent-runtime");
const { UiPreferencesProvider } = await import("../src/lib/ui-preferences");
const { AutopilotStudioWorkspace, STUDIO_20_NODES } = await import("../src/components/AutopilotStudioWorkspace");
const { AutopilotNodeInspector } = await import("../src/components/autopilot/AutopilotNodeInspector");
const { EMPTY_AUTOPILOT_TELEMETRY } = await import("../src/components/autopilot/autopilot-telemetry");
const { createElement: h, act } = React;
async function flush(action: () => void | Promise<void> = () => {}) {
  await act(async () => { await action(); await nextTurn(); await nextTurn(); });
}

test("autopilot exposes the real opportunity pipeline without a demo branch", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ runtimes: [] })) as typeof fetch;
  const container = dom.document.createElement("main"); dom.document.body.append(container);
  const root = createRoot(container);
  let opened = 0;
  try {
    await flush(() => root.render(h(LocalAgentRuntimeProvider, null,
      h(UiPreferencesProvider, { initialPreferences: { locale: "zh", theme: "light" } }, h(AutopilotStudioWorkspace, { onOpenOpportunitySources: () => { opened += 1; } })))));
    assert.ok(container.querySelector(".studio-workshop"));
    assert.match(container.textContent, /求职全链路自动化工坊/);
    assert.match(container.textContent, /当前还没有接入真实岗位/);
    assert.match(container.textContent, /能力流程/);
    assert.doesNotMatch(container.textContent, /实时终端树|待执行|待运行/);
    assert.doesNotMatch(container.textContent, /35k|525k|99\.2|99\.4|100%|ATS 核验通过|S级|09:00|16:30|西门子|具身智能|隔离演示|示例，非真实招聘|FB-01|18\.8k/);
    await flush(() => [...container.querySelectorAll("button")].find(button => button.textContent.includes("接入真实岗位"))!.click());
    assert.equal(opened, 1);
  } finally { await flush(() => root.unmount()); globalThis.fetch = originalFetch; container.remove(); await dom.happyDOM.cancelAsync(); }
});


test("inspector labels global counts and shows only task kinds belonging to the stage", async () => {
  const container = dom.document.createElement("main");
  dom.document.body.append(container);
  const root = createRoot(container);
  const node = STUDIO_20_NODES.find(candidate => candidate.tag === "SOURCING")!;
  const tasks = [
    { id: "unrelated", kind: "free_chat" as const, status: "running" as const, title: "Unrelated task", updatedAt: "2026-11-20T02:00:00Z" },
    { id: "ready", kind: "jd_intake" as const, status: "ready" as const, title: "Real intake", updatedAt: "2026-11-20T01:00:00Z" },
  ];
  const render = (telemetry: Parameters<typeof AutopilotNodeInspector>[0]["telemetry"]) =>
    root.render(h(UiPreferencesProvider, { initialPreferences: { locale: "zh", theme: "light" } },
      h(AutopilotNodeInspector, { node, theme: "light", savedJobsCount: 0, claimCount: 0, telemetry })));
  try {
    await flush(() => render({ ...EMPTY_AUTOPILOT_TELEMETRY, authenticated: true, totalTasks: 2, readyCount: 1, runningCount: 1, tasks, recentByKind: tasks }));
    assert.match(container.textContent, /全局 1 运行中 · 1 待开始/);
    assert.match(container.textContent, /此阶段近期任务（全局）/);
    assert.match(container.textContent, /Real intake/);
    assert.doesNotMatch(container.textContent, /Unrelated task/);
    await flush(() => render(EMPTY_AUTOPILOT_TELEMETRY));
    assert.match(container.textContent, /任务概览不可用/);
    assert.doesNotMatch(container.textContent, /全局 0 运行中|Real intake/);
  } finally {
    await flush(() => root.unmount());
    container.remove();
    await dom.happyDOM.cancelAsync();
  }
});
