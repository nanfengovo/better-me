import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { registerHooks } from "node:module";
import { readFile } from "node:fs/promises";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Window } from "happy-dom";
import type { StatusItem, UsageSnapshot } from "../src/services/system-status-client";

const dom = new Window({ url: "http://audit-regression.invalid" });
const React = await import("react");
for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage, HTMLElement: dom.HTMLElement, Element: dom.Element, HTMLInputElement: dom.HTMLInputElement, HTMLTextAreaElement: dom.HTMLTextAreaElement, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom) })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
let issue: StatusItem | undefined;
let usage: UsageSnapshot | undefined = { day: "2026-11-14", since: "2026-11-14T00:00:00Z", models: [], active: [] };
let usageState = "ready";
Object.defineProperty(globalThis, "__auditStatus", { configurable: true, value: () => ({
  groups: [{ id: "engines", label: "引擎", items: issue ? [issue] : [{ id: "host", label: "Agent 服务", health: "ok", badge: "在线", detail: "在线" }] }],
  issues: issue ? [{ ...issue }] : [], overall: issue?.health ?? "ok", loading: false, usage, usageState,
  totals: { input: usage?.models.reduce((sum, model) => sum + model.inputTokens, 0) ?? 0, output: 0, calls: 0 }, retry: async () => {}, refreshing: false,
}) });
const hooks = registerHooks({ load(url, context, next) {
  if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
  if (url.endsWith("/src/lib/use-system-status.ts")) return { format: "module", source: "export const useSystemStatus = () => globalThis.__auditStatus();", shortCircuit: true };
  return next(url, context);
} });
const { createRoot } = await import("react-dom/client");
const { DynamicIsland } = await import("../src/components/desktop/DynamicIsland");
const { OpportunityCard3D } = await import("../src/components/OpportunityCard3D");
const { ResourceLibrary } = await import("../src/components/ResourceLibrary");
const { UiPreferencesProvider } = await import("../src/lib/ui-preferences");
const { createOpportunity } = await import("../src/lib/opportunities");
const { worstHealth, modelStatus } = await import("../src/services/system-status-client");
const { createDemoFactBase, createDefaultResumeView } = await import("@better-me/core");
const { ResumeDesignPanel } = await import("../src/components/ResumeDesignPanel");
const { FactEditor } = await import("../src/components/FactEditor");
const { ConfirmationProvider } = await import("../src/components/ConfirmationDialog");
const { resolveResumeTemplate } = await import("../src/components/template-catalog");
const { h, act } = { h: React.createElement, act: React.act };
let root: ReturnType<typeof createRoot> | undefined;
async function flush(fn: () => void = () => {}) { await act(async () => { fn(); await nextTurn(); }); }
async function mount(element: React.ReactNode) {
  const host = dom.document.createElement("main"); dom.document.body.append(host); root = createRoot(host);
  await flush(() => root!.render(element));
  return host;
}
afterEach(async () => { if (root) await flush(() => root!.unmount()); root = undefined; dom.document.body.replaceChildren(); issue = undefined; usageState = "ready"; usage = { day: "2026-11-14", since: "2026-11-14T00:00:00Z", models: [], active: [] }; });
after(async () => { hooks.deregister(); await dom.happyDOM.abort(); });

test("F07: focus then activation opens once; Escape closes", async () => {
  const host = await mount(h(DynamicIsland)); const pill = host.querySelector<HTMLButtonElement>(".os-island-pill")!;
  await flush(() => pill.focus()); assert.equal(pill.getAttribute("aria-expanded"), "false");
  await flush(() => pill.click()); assert.equal(pill.getAttribute("aria-expanded"), "true");
  await flush(() => pill.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(pill.getAttribute("aria-expanded"), "false");
});

test("F05: anomaly timer survives fresh issues arrays and dismisses exactly once", async () => {
  const host = await mount(h(DynamicIsland));
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  const pending = new Map<number, () => void>(); let next = 900000;
  globalThis.setTimeout = ((fn: () => void, ms: number, ...args: unknown[]) => { if (ms === 4000) { const id = next++; pending.set(id, fn); return id; } return originalSet(fn, ms, ...args); }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { pending.delete(Number(id)); originalClear(id); }) as typeof clearTimeout;
  try {
    issue = { id: "host", label: "Agent 服务", health: "down", detail: "离线", badge: "离线" };
    await flush(() => root!.render(h(DynamicIsland)));
    assert.equal(host.querySelector<HTMLElement>(".os-island")!.dataset.state, "alert"); assert.equal(pending.size, 1);
    await flush(() => root!.render(h(DynamicIsland))); assert.equal(pending.size, 1);
    await flush(() => [...pending.values()][0]!());
    assert.equal(host.querySelector<HTMLElement>(".os-island")!.dataset.state, "idle");
    await flush(() => root!.render(h(DynamicIsland))); assert.equal(pending.size, 0);
  } finally { globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; }
});

test("F06/F14/F21: hidden face is inert, focus follows flip, next step is visible and motion preference applies", async () => {
  const job = createOpportunity({ company: "合成公司", title: "长岗位名称".repeat(12), description: "长正文".repeat(50) }); job.application.nextAction = "核对来源后准备材料";
  const host = await mount(h(UiPreferencesProvider, { initialPreferences: { locale: "zh", theme: "light", reduceMotion: true } }, h(OpportunityCard3D, { job, location: "未披露", modeLabel: "未知", statusLabel: "未知", stageLabel: "已收藏", salaryFallback: "未披露", nextActionFallback: "下一步待补", detailsLabel: "详情", frontLabel: "正面", backLabel: "背面", deadlineLabel: "截止", disabled: false, stageOptions: [["saved", "已收藏"]], onOpen() {}, onStageChange() {} })));
  assert.match(host.querySelector(".opportunity-card-front")!.textContent, /核对来源后准备材料/);
  assert.equal(host.querySelector("article")!.getAttribute("data-reduce-motion"), "true");
  const trigger = host.querySelector<HTMLButtonElement>(".opportunity-card-front .opportunity-card-flip")!;
  await flush(() => trigger.click());
  assert.equal(host.querySelector(".opportunity-card-front")!.hasAttribute("inert"), true);
  assert.equal(dom.document.activeElement, host.querySelector(".opportunity-card-detail"));
  await flush(() => host.querySelector<HTMLButtonElement>(".opportunity-card-back .opportunity-card-flip")!.click());
  assert.equal(dom.document.activeElement, trigger); assert.equal(host.querySelector(".opportunity-card-back")!.hasAttribute("inert"), true);
});

test("F08/F22: failed usage is not zero and model bars use the reported total without a minimum", async () => {
  usage = undefined; usageState = "error";
  const host = await mount(h(DynamicIsland));
  assert.equal(host.querySelector(".os-island-meter-total strong")!.textContent, "—");
  assert.match(host.textContent, /读取失败/); assert.doesNotMatch(host.textContent, /今日暂无模型调用记录/);
  usageState = "ready"; usage = { day: "2026-11-14", since: "2026-11-14T00:00:00Z", active: [], models: [99, 1, 0].map((inputTokens, i) => ({ label: `model-${i}`, metered: true, calls: 1, failures: 0, inputTokens, outputTokens: 0, lastAt: "2026-11-14T00:00:00Z" })) };
  await flush(() => root!.render(h(DynamicIsland)));
  assert.deepEqual([...host.querySelectorAll<HTMLElement>(".os-island-model-bar span")].map(node => node.style.width), ["99%", "1%"]);
  assert.equal(worstHealth([{ id: "a", label: "a", detail: "", health: "ok" }, { id: "b", label: "b", detail: "", health: "unknown" }]), "unknown");
  assert.notEqual(modelStatus(undefined)[0]!.detail, modelStatus(null)[0]!.detail);
});

test("F11/F13: fallback ID has one selected card and advanced details retain mounted controls", async () => {
  const facts = createDemoFactBase(); const view = { ...createDefaultResumeView(), templateId: "legacy-unknown" };
  const host = await mount(h(ResumeDesignPanel, { view, factBase: facts, onChange: () => assert.fail("opening does not rewrite settings") }));
  assert.equal(host.querySelectorAll('[data-template-choice][aria-pressed="true"]').length, 1);
  assert.equal(host.querySelector('[data-template-choice][aria-pressed="true"]')!.getAttribute("data-template-choice"), resolveResumeTemplate(view.templateId));
  const details = host.querySelector<HTMLDetailsElement>(".design-advanced")!; const control = details.querySelector("input")!;
  assert.equal(details.open, false); await flush(() => { details.open = true; }); assert.equal(details.querySelector("input"), control);
});

test("F12: undo restores the complete claim in place without overwriting other edits", async () => {
  const facts = createDemoFactBase(); let latest = facts;
  function Harness() { const [value, setValue] = React.useState(facts); return h(ConfirmationProvider, null, h(FactEditor, { factBase: value, onChange(next) { latest = next; setValue(next); } })); }
  const host = await mount(h(Harness));
  const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")];
  const remove = buttons.find(button => /删除.*要点|删除此条/.test(button.getAttribute("aria-label") ?? button.getAttribute("title") ?? ""));
  assert.ok(remove, "claim delete control must be labelled");
  const before = JSON.stringify(facts.experiences);
  await flush(() => remove.click()); assert.notEqual(JSON.stringify(latest.experiences), before);
  await flush(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "撤销上次删除")!.click());
  assert.equal(JSON.stringify(latest.experiences), before);
});

test("F16: resources filter by purpose and every outbound link names its resource", async () => {
  const host = await mount(h(ResourceLibrary)); const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
  await flush(() => { Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, "Python"); input.dispatchEvent(new dom.Event("input", { bubbles: true })); });
  assert.equal(host.querySelectorAll(".resource-card").length, 1); assert.match(host.textContent, /JobSpy/);
  assert.match(host.querySelector(".resource-card a")!.getAttribute("aria-label")!, /JobSpy.*新窗口/);
});

test("F01: saved jobs never inherit demo salary, ATS scores or company research", async () => {
  const { SWRConfig } = await import("swr");
  const { AutopilotStudioWorkspace } = await import("../src/components/AutopilotStudioWorkspace");
  const job = createOpportunity({ company: "合成未披露公司", title: "合成待核验岗位" });
  const host = await mount(h(SWRConfig, { value: { provider: () => new Map(), revalidateOnMount: false, isPaused: () => true, fallback: { "studio:opportunity-library": { library: { schemaVersion: 1, revision: 1, updatedAt: job.updatedAt, jobs: [job] } } } } }, h(AutopilotStudioWorkspace)));
  assert.match(host.textContent, /合成待核验岗位/); assert.match(host.textContent, /事实库共 0 条/);
  assert.match(host.querySelector("[data-job-id]")!.textContent, /未披露/);
  assert.doesNotMatch(host.textContent, /35k|525k|99\.2|100%|ATS 核验通过|S级|09:00/);
  assert.equal(host.querySelector(".studio-workshop"), null);
});

test("F03: every submit keyboard handler rejects both native composition and Safari 229", async () => {
  for (const name of ["AgentWorkspace", "AgentCompanion"]) {
    const source = await readFile(new URL(`../src/components/${name}.tsx`, import.meta.url), "utf8");
    const handlers = [...source.matchAll(/onKeyDown=\{\((e|event)\) => \{([\s\S]*?)\}\}/g)].filter(match => match[2]!.includes('key === "Enter"'));
    assert.equal(handlers.length, name === "AgentWorkspace" ? 3 : 1);
    for (const [, parameter, body] of handlers) {
      assert.match(body!, /nativeEvent\.isComposing/); assert.match(body!, /nativeEvent\.keyCode === 229/);
      assert.ok(body!.indexOf("isComposing") < body!.indexOf('key === "Enter"'));
      const handler = new Function(parameter!, "isExtractingLink", "handleExtractLink", "handleSubmitJobSetup", "handleSendMessage", "handleSendChat", body!);
      let sends = 0; const send = () => { sends++; };
      for (const nativeEvent of [{ isComposing: true, keyCode: 13 }, { isComposing: false, keyCode: 229 }]) handler({ key: "Enter", ctrlKey: true, shiftKey: false, nativeEvent, preventDefault() {} }, false, send, send, send, send);
      assert.equal(sends, 0);
      handler({ key: "Enter", ctrlKey: true, shiftKey: false, nativeEvent: { isComposing: false, keyCode: 13 }, preventDefault() {} }, false, send, send, send, send);
      assert.equal(sends, 1);
      if (!body!.includes("metaKey")) {
        handler({ key: "Enter", shiftKey: true, nativeEvent: { isComposing: false, keyCode: 13 }, preventDefault() { assert.fail("Shift+Enter must remain a newline"); } }, false, send, send, send, send);
        assert.equal(sends, 1);
      }
    }
  }
});
