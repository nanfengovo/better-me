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
const { AutopilotStudioWorkspace } = await import("../src/components/AutopilotStudioWorkspace");
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
    assert.ok(container.querySelector(".studio-real-workspace"));
    assert.match(container.textContent, /真实岗位控制台/);
    assert.doesNotMatch(container.textContent, /隔离演示|示例，非真实招聘/);
    assert.equal(container.querySelector(".studio-workshop"), null);
    await flush(() => [...container.querySelectorAll("button")].find(button => button.textContent.includes("接入真实岗位"))!.click());
    assert.equal(opened, 1);
  } finally { await flush(() => root.unmount()); globalThis.fetch = originalFetch; container.remove(); await dom.happyDOM.cancelAsync(); }
});
