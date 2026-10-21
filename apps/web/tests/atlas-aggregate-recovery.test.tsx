import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, afterEach, mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Window, type HTMLButtonElement } from "happy-dom";
import type { AtlasSourceSync } from "../src/components/atlas/service-client.ts";
import { createAtlasDemo } from "../src/components/atlas/demo.ts";
import { atlasAggregateRecoveryScope, beginAtlasAggregateRecovery, endAtlasAggregateRecovery, readAtlasAggregateRecovery, retainAtlasAggregateRequest, saveAtlasAggregateReceipt, settleAtlasAggregateReceipt, type AtlasAggregateRecoveryEntry } from "../src/components/atlas/aggregate-recovery.ts";

const dom = new Window({ url: "http://synthetic-aggregate-recovery.invalid" });
const React = await import("react"), { act, createElement: h } = React;
const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const hooks = registerHooks({ load(url, context, nextLoad) { return url.endsWith(".css") ? { source: "export {};", format: "module", shortCircuit: true } : nextLoad(url, context); } });
const { createRoot } = await import("react-dom/client"), { AtlasAggregateRecoveryControls } = await import("../src/components/atlas/AtlasAggregateRecoveryControls.tsx");
type Props = React.ComponentProps<typeof AtlasAggregateRecoveryControls>;
type Call = { path: string; body?: unknown; key: string | null; signal?: AbortSignal | null };
const at = "2026-10-22T08:00:00.000Z", endpoint = "http://127.0.0.1:5178";
let root: ReturnType<typeof createRoot> | undefined, next = 0;
const scopes: string[] = [];
function fixture(): Props { const token = `synthetic-aggregate-${++next}`; scopes.push(atlasAggregateRecoveryScope(endpoint, token)); return { endpoint, token, onSnapshot() {} }; }
function entry(sourceId = "source-one"): AtlasAggregateRecoveryEntry {
  return { sourceId, label: `Synthetic ${sourceId}`, input: { scope: { roles: ["C#"], regions: ["Shanghai"], companyNames: [], countryCodes: ["CN"] }, maxRecords: 17, maxPages: 2 }, key: `original-${sourceId}-${crypto.randomUUID()}` };
}
function receipt(value: AtlasAggregateRecoveryEntry, status: AtlasSourceSync["run"]["status"] = "completed"): AtlasSourceSync {
  const scope = value.input.scope!;
  return { run: { runId: `run-${value.sourceId}`, sourceId: value.sourceId, actorScope: "synthetic-owner", generation: 1, status, startedAt: at,
    scope: { keywords: scope.roles, regions: scope.regions, companies: scope.companyNames, countryCodes: scope.countryCodes },
    ...(status === "running" ? {} : { finishedAt: at }), summary: { records: 1, added: 1, pages: 1 } }, localFilters: scope, warnings: [] };
}
const response = (value: unknown) => new Response(JSON.stringify({ ok: true, requestId: "synthetic-aggregate-recovery", value }));
function install(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { path: new URL(String(url)).pathname, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}), key: new Headers(init?.headers).get("Idempotency-Key"), signal: init?.signal };
    calls.push(call); return handler(call);
  }); return calls;
}
async function render(props: Props) {
  if (!root) { dom.document.body.innerHTML = "<main></main>"; root = createRoot(dom.document.querySelector("main")! as unknown as Element); }
  await act(async () => { root!.render(h(AtlasAggregateRecoveryControls, props)); await delay(1); });
}
function button(label: string) { const result = [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === label); assert.ok(result, `Missing ${label}`); return result; }
async function settle() { const deadline = performance.now() + 4000; while (dom.document.querySelector('[aria-busy="true"]')) { assert.ok(performance.now() < deadline, dom.document.body.textContent!); await act(async () => { await delay(5); }); } }
async function click(label: string) { await act(async () => button(label).click()); await settle(); }
async function unmount() { if (root) await act(async () => root!.unmount()); root = undefined; }
afterEach(async () => {
  await unmount();
  for (const scope of scopes.splice(0)) for (const saved of readAtlasAggregateRecovery(scope).entries) {
    const result = receipt(saved); saveAtlasAggregateReceipt(scope, saved.key, result); settleAtlasAggregateReceipt(scope, saved.key, saved.receipt?.run.runId ?? result.run.runId);
  }
  mock.restoreAll(); dom.document.body.replaceChildren();
});
after(() => { hooks.deregister(); void dom.happyDOM.abort(); for (const [key, descriptor] of descriptors) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });

test("lost aggregate replies retain original per-source requests; trusted terminal receipts only retry a failed index read across remount", async () => {
  const props = fixture(), scope = scopes.at(-1)!, first = entry(), second = entry("source-two"), snapshots: number[] = [];
  props.onSnapshot = data => snapshots.push(data.revision);
  retainAtlasAggregateRequest(scope, first); retainAtlasAggregateRequest(scope, second); let exports = 0;
  const calls = install(call => {
    if (call.path.endsWith("/export")) { if (++exports === 1) throw new Error("Synthetic index outage"); return response({ ...createAtlasDemo(), revision: 8 }); }
    const original = call.path.includes(first.sourceId) ? first : second; return response(receipt(original));
  });
  await render(props); await click("核对原聚合搜索回执");
  assert.equal(calls.length, 3); assert.ok(readAtlasAggregateRecovery(scope).entries.every(value => value.receipt?.run.status === "completed"));
  for (const original of [first, second]) { const call = calls.find(value => value.path.includes(original.sourceId))!; assert.deepEqual(call.body, original.input); assert.equal(call.key, original.key); }
  assert.deepEqual(snapshots, []); await unmount(); await render(props); await click("重新读取聚合搜索索引");
  assert.equal(calls.filter(value => value.path.endsWith("/sync")).length, 2, "saved final receipts never redispatch writes");
  assert.deepEqual(snapshots, [8]); assert.equal(readAtlasAggregateRecovery(scope).entries.length, 0);
});

test("running receipts retain their original request and key until a later terminal receipt and matching snapshot", async () => {
  const props = fixture(), scope = scopes.at(-1)!, original = entry(); retainAtlasAggregateRequest(scope, original); let writes = 0;
  const calls = install(call => response(call.path.endsWith("/export") ? createAtlasDemo() : receipt(original, ++writes === 1 ? "running" : "partial")));
  await render(props); await click("核对原聚合搜索回执");
  assert.equal(readAtlasAggregateRecovery(scope).entries[0]!.receipt!.run.status, "running"); assert.equal(calls.length, 1);
  await unmount(); await render(props); await click("核对原聚合搜索回执");
  assert.deepEqual(calls.slice(0, 2).map(call => ({ body: call.body, key: call.key })), [1, 2].map(() => ({ body: original.input, key: original.key })));
  assert.equal(readAtlasAggregateRecovery(scope).entries.length, 0);
});

test("an authenticated definitive rejection becomes a read-only index recovery instead of permanently trapping this connection", async () => {
  const props = fixture(), scope = scopes.at(-1)!, original = entry(); retainAtlasAggregateRequest(scope, original); let exports = 0;
  const calls = install(call => {
    if (call.path.endsWith("/export")) { if (++exports === 1) throw new Error("Synthetic index temporarily offline"); return response(createAtlasDemo()); }
    return new Response(JSON.stringify({ ok: false, requestId: "synthetic-rejection", error: { code: "stale-version", message: "Synthetic source changed before run creation" } }), { status: 409 });
  });
  await render(props); await click("核对原聚合搜索回执");
  assert.equal(readAtlasAggregateRecovery(scope).entries[0]!.rejected, true); assert.equal(calls.length, 2);
  await unmount(); await render(props); await click("重新读取聚合搜索索引");
  assert.equal(calls.length, 3); assert.equal(calls.filter(call => call.path.endsWith("/sync")).length, 1); assert.equal(readAtlasAggregateRecovery(scope).entries.length, 0);
});

test("a shared connection lease blocks competing surfaces while other identities remain independent", async () => {
  const props = fixture(), scope = scopes.at(-1)!, original = entry(); retainAtlasAggregateRequest(scope, original);
  const owner = beginAtlasAggregateRecovery(scope)!; assert.ok(owner); assert.equal(beginAtlasAggregateRecovery(scope), undefined);
  await render(props); assert.equal(button("核对原聚合搜索回执").disabled, true);
  const other = fixture(), otherScope = scopes.at(-1)!, lease = beginAtlasAggregateRecovery(otherScope)!; assert.ok(lease);
  endAtlasAggregateRecovery(otherScope, lease); await render(other); assert.equal(dom.document.body.textContent, "");
  endAtlasAggregateRecovery(scope, "foreign-owner"); assert.equal(readAtlasAggregateRecovery(scope).active, true);
  await act(async () => endAtlasAggregateRecovery(scope, owner)); await render(props); assert.equal(button("核对原聚合搜索回执").disabled, false);
});

test("closing an ignored-abort recovery releases its lease, retains original request and prevents late UI writes", async () => {
  const props = fixture(), scope = scopes.at(-1)!, original = entry(); retainAtlasAggregateRequest(scope, original);
  const pending = Promise.withResolvers<Response>(); const snapshots: number[] = []; props.onSnapshot = data => snapshots.push(data.revision);
  const calls = install(() => pending.promise);
  await render(props); await act(async () => button("核对原聚合搜索回执").click());
  assert.equal(readAtlasAggregateRecovery(scope).active, true); await unmount(); await delay(1);
  assert.equal(readAtlasAggregateRecovery(scope).active, false); assert.equal(readAtlasAggregateRecovery(scope).entries[0]!.key, original.key);
  await act(async () => { pending.resolve(response(receipt(original))); await delay(5); }); assert.deepEqual(snapshots, []); assert.equal(calls.length, 1);
});
