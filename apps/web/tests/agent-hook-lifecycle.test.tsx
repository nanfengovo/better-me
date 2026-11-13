import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, afterEach } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Window } from "happy-dom";
import type { LlmConfig } from "@better-me/core";

const css = registerHooks({ load(url, context, nextLoad) {
  return url.endsWith(".css") ? { source: "", format: "module", shortCircuit: true } : nextLoad(url, context);
} });
const dom = new Window({ url: "http://agent-hook-lifecycle.invalid" });
const globals = {
  window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, Event: dom.Event,
  CustomEvent: dom.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
};
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createElement: h, act, StrictMode } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AgentWorkspace } = await import("../src/components/AgentWorkspace.tsx");
const { JdMatchDrawer } = await import("../src/components/JdMatchDrawer.tsx");
const { AgentTopBarStatus } = await import("../src/components/AgentTopBarStatus.tsx");
const originalFetch = globalThis.fetch;
const config: LlmConfig = { provider: "openai-compatible", baseUrl: "https://ai-fixture.invalid/v1", apiKey: "fixture-only", model: "fixture-a", temperature: 0.3 };
let root: ReturnType<typeof createRoot> | undefined;
const release: Array<() => void> = [];
async function flush(action: () => void = () => {}) {
  await act(async () => { action(); await nextTurn(); await nextTurn(); });
}
function mountRoot() {
  const container = dom.document.createElement("main"); dom.document.body.append(container);
  root = createRoot(container as unknown as Element);
}
afterEach(async () => {
  await flush(() => { root?.unmount(); root = undefined; for (const resolve of release.splice(0)) resolve(); });
  globalThis.fetch = originalFetch; dom.document.body.replaceChildren(); dom.localStorage.clear();
});
after(async () => {
  css.deregister(); await dom.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});

for (const surface of ["workspace", "drawer"] as const) {
  test(`${surface} never dispatches inference on StrictMode mount, config change, JD change or reopen without task consent`, async () => {
    const mutations: string[] = [];
    globalThis.fetch = async (input, init) => {
      if ((init?.method ?? "GET") !== "GET") mutations.push(String(input));
      return Response.json({ status: "ok" });
    };
    mountRoot();
    const render = (description: string, active = true, model = "fixture-a") => flush(() => {
      const props = { job: { title: "合成岗位", company: "合成公司", description }, resume: null,
        llmConfig: { ...config, model }, onOpenConfig() {}, onApplyToResume() {} };
      const child = surface === "workspace"
        ? h(AgentWorkspace, { ...props, active, onNavigateToResume() {} })
        : h(JdMatchDrawer, { ...props, isOpen: active, onClose() {} });
      root!.render(h(StrictMode, {}, child));
    });
    await render("合成岗位 A");
    assert.deepEqual(mutations, [], "StrictMode mount is not inference consent");
    await render("合成岗位 A", true, "fixture-b");
    assert.deepEqual(mutations, [], "changing configuration is not inference consent");
    await render("合成岗位 A", true, "fixture-b");
    assert.deepEqual(mutations, [], "an empty deterministic result must not trigger inference");
    await render("合成岗位 B", true, "fixture-b");
    assert.deepEqual(mutations, [], "new JD text still needs explicit task consent");
    await render("合成岗位 B", false);
    await render("合成岗位 B", true);
    assert.deepEqual(mutations, [], "reopening must not silently restart retired inference");
  });
}

test("model probes ignore equivalent config objects and abort obsolete credentials before accepting a response", async () => {
  const probes: Array<{ signal: AbortSignal; resolve: () => void }> = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://ai-fixture.invalid/v1/models");
    return new Promise<Response>(resolve => {
      const complete = () => resolve(Response.json({ data: [{ id: "fixture-model" }] }));
      probes.push({ signal: init!.signal!, resolve: complete }); release.push(complete);
    });
  };
  mountRoot();
  const render = (value: LlmConfig | null) => flush(() => root!.render(h(AgentTopBarStatus, {
    config: value, active: false, onNavigateToAgent() {}, onOpenAiConfig() {},
  })));
  await render(config);
  await render({ ...config });
  assert.equal(probes.length, 1, "equivalent render-time objects must not cause repeated probing");
  await render({ ...config, apiKey: "fixture-replacement" });
  assert.equal(probes.length, 2);
  assert.equal(probes[0]?.signal.aborted, true);
  await render(null);
  assert.equal(probes[1]?.signal.aborted, true);
  await flush(() => probes.forEach(probe => probe.resolve()));
  assert.ok(dom.document.querySelector(".dot-unconfigured"));
  assert.equal(dom.document.querySelector(".dot-ready"), null, "a late old probe cannot revive a removed configuration");
});
