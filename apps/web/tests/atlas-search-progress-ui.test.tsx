import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, afterEach } from "node:test";
import { Window } from "happy-dom";
import type { AtlasAggregateProgress, AtlasAggregateSource } from "../src/components/atlas/aggregate-search.ts";
import type { AtlasSourceSync } from "../src/components/atlas/service-client.ts";

const dom = new Window({ url: "http://source-progress-fixture.invalid" });
const React = await import("react");
const { createElement: h, act } = React;
const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement,
  Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const hooks = registerHooks({ load(url, context, nextLoad) {
  return url.endsWith(".css") ? { source: "export {};", format: "module", shortCircuit: true } : nextLoad(url, context);
} });
const { createRoot } = await import("react-dom/client");
const { AtlasSearchProgress } = await import("../src/components/atlas/AtlasSearchProgress.tsx");
type Props = Parameters<typeof AtlasSearchProgress>[0];
let root: ReturnType<typeof createRoot> | undefined;
async function render(props: Props) {
  if (!root) { dom.document.body.innerHTML = "<main></main>"; root = createRoot(dom.document.querySelector("main")! as unknown as Element); }
  await act(async () => root!.render(h(AtlasSearchProgress, props)));
}
function receipt(sourceId: string, status: AtlasSourceSync["run"]["status"]): AtlasSourceSync {
  return { run: { runId: `run-${sourceId}`, sourceId, actorScope: "synthetic-owner", generation: 1, scope: {}, status,
    startedAt: "2026-10-19T00:00:00.000Z" }, localFilters: { roles: [], regions: [], companyNames: [] }, warnings: [] };
}
function state(sourceId: string, overrides: Partial<AtlasAggregateSource> = {}): AtlasAggregateSource {
  return { sourceId, label: `Synthetic ${sourceId}`, status: "completed", settled: true, outcomeUnknown: false, ...overrides };
}
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; dom.document.body.replaceChildren(); });
after(() => {
  hooks.deregister(); dom.happyDOM.abort();
  for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
});

test("cancelled work reports received receipts separately from settled sources and retains partial-source evidence", async () => {
  const partial = receipt("partial", "partial"); partial.run.summary = { records: 7, pages: 2, added: 3, needsHuman: 1 };
  partial.warnings = ["Synthetic upstream detail coverage is limited."];
  partial.sourceError = { code: "rate-limited", retryAfterSeconds: 45 };
  const progress: AtlasAggregateProgress = { total: 4, settled: 4, queued: 0, running: 0, cancelled: true, sources: [
    state("completed", { receipt: receipt("completed", "completed") }), state("partial", { status: "partial", receipt: partial }),
    state("cancelled", { status: "cancelled", outcomeUnknown: true }), state("queued-cancelled", { status: "cancelled" }),
  ] };
  await render({ progress, busy: false, onCancel() { assert.fail("cancel must not fire after settlement"); } });
  const status = dom.document.querySelector('[role="status"]')!.textContent!;
  assert.match(status, /本轮等待已取消/); assert.match(status, /已返回 2 \/ 4 个来源回执/);
  const bar = dom.document.querySelector('[role="progressbar"]')!;
  assert.equal(bar.getAttribute("aria-valuenow"), "4"); assert.equal(bar.getAttribute("aria-valuemax"), "4");
  assert.match(bar.getAttribute("aria-valuetext")!, /包含完成、失败或取消/);
  assert.equal(dom.document.querySelectorAll("button").length, 0);
  assert.match(dom.document.body.textContent!, /部分岗位可能已保存/);
  assert.match(dom.document.body.textContent!, /读取 7 条 · 2 页 · 新增 3 · 待人工核对 1/);
  const details = dom.document.querySelector("details")!;
  assert.equal(details.hasAttribute("open"), false);
  assert.match(details.textContent!, /rate-limited/); assert.match(details.textContent!, /来源建议 45 秒后重试/);
  assert.match(details.textContent!, /Synthetic upstream detail coverage is limited/);
});

test("preparation is indeterminate, cancellation is actionable and elapsed time is never a remaining-time estimate", async () => {
  let cancellations = 0;
  await render({ progress: null, busy: true, onCancel() { cancellations++; } });
  const bar = dom.document.querySelector('[role="progressbar"]')!;
  assert.equal(bar.hasAttribute("aria-valuenow"), false);
  assert.match(dom.document.body.textContent!, /正在准备来源搜索/);
  assert.match(dom.document.body.textContent!, /已用时 0 秒/);
  assert.doesNotMatch(dom.document.body.textContent!, /剩余|预计|ETA/);
  await act(async () => dom.document.querySelector("button")!.click()); assert.equal(cancellations, 1);
  await render({ progress: null, busy: false, onCancel() {} });
  assert.equal(dom.document.querySelector("section"), null, "idle and unstarted progress should not occupy the page");
});

test("server-side running receipts remain pending verification and absent counters are not presented as zero records", async () => {
  const progress: AtlasAggregateProgress = { total: 1, settled: 1, queued: 0, running: 0, cancelled: false,
    sources: [state("server-running", { status: "running", receipt: receipt("server-running", "running") })] };
  await render({ progress, busy: false, onCancel() {} });
  assert.match(dom.document.body.textContent!, /服务端仍在运行 · 待核对/);
  assert.match(dom.document.body.textContent!, /尚不能确认最终结果/);
  assert.doesNotMatch(dom.document.body.textContent!, /读取 0 条|新增 0/);
  assert.match(dom.document.querySelector('[role="status"]')!.textContent!, /已返回 1 \/ 1 个来源回执/);
});
