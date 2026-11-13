import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { setImmediate as next, setTimeout as delay } from "node:timers/promises";
import test, { after } from "node:test";
import { Window } from "happy-dom";
import { createDefaultResumeView, createDemoFactBase, projectResume } from "@better-me/core";
import type { StudioContextInput } from "@better-me/agent-contracts/career-studio";
import type { CareerStudioWorkspaceProps } from "../src/components/CareerStudioWorkspace";

// These probes test the real Workspace lifecycle, not layout geometry or Fact
// approval. They isolate the Panel's source-key/remount + abort behavior and the
// Inbox's public business callback; both real child workflows have separate tests.
const hook = registerHooks({ load(url, context, fallback) {
  if (url.endsWith("/CareerLayoutPanel.tsx")) return { format: "module", shortCircuit: true, source: `
    const R = globalThis.React;
    function Session(p) {
      const controller = R.useRef(new AbortController());
      R.useEffect(() => () => controller.current.abort(), []);
      return R.createElement('button', { onClick: () => void p.onAdopt({id:'lifecycle-only',baseScope:p.scope,replacements:[]},
        {operationId:'lifecycle-save',baseScope:p.scope,candidateFingerprint:'f'.repeat(64),signal:controller.current.signal}).catch(()=>{}) }, 'Lifecycle reviewed save');
    }
    export function CareerLayoutPanel(p) { return R.createElement(Session,{...p,key:JSON.stringify(p.resume)}); }
  ` };
  if (url.endsWith("/CareerEvidenceInbox.tsx")) return { format: "module", shortCircuit: true, source: `
    const R = globalThis.React;
    export function CareerEvidenceInbox(p) { return R.createElement('button', { onClick: () => void p.onAdoptEvidence('synthetic-reviewed-entry','e'.repeat(64)).catch(()=>{}) }, 'Lifecycle evidence save'); }
  ` };
  return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : fallback(url, context);
} });
const win = new Window({ url: "https://studio-lifecycle-fixture.invalid" }), React = await import("react");
const originals = new Map<string, PropertyDescriptor | undefined>(), routes: string[] = [];
const owner = "11111111-1111-4111-8111-111111111111", runtime = { model: "synthetic-lifecycle", modelDigest: "a".repeat(64) };
const nextOwner = "22222222-2222-4222-8222-222222222222";
const transportCalls: { route: string; body: unknown; owner: string | null }[] = [], createdContextIds: string[] = [];
let contextSequence = 0;
const fetcher: typeof fetch = async (input, init = {}) => {
  const route = new URL(String(input)).pathname.replace("/api/v1/agent/career-studio", ""); routes.push(route);
  const body = init.body ? JSON.parse(String(init.body)) as StudioContextInput : undefined;
  const requestOwner = new Headers(init.headers).get("X-BetterMe-Owner"); transportCalls.push({ route, body, owner: requestOwner });
  const contextId = route === "/context/create" ? `lifecycle-context-${++contextSequence}` : undefined;
  if (contextId) createdContextIds.push(contextId);
  const value = route === "/runtimes" ? { runtimes: [runtime] } : route === "/context/create" ? {
    context: { ...body, id: contextId, ownerId: requestOwner, session: "lifecycle-session", createdAt: "2026-11-09T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z", revoked: false },
    revision: 1, claimHashes: {}, limitations: [],
  } : route === "/runtime/select" ? { selected: true, runtime } : route === "/context/revoke" ? { revoked: true } : undefined;
  if (!value) throw Error(`No external transport allowed: ${route}`);
  if ("context" in value) Reflect.deleteProperty(value.context, "consent");
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
};
for (const [key, value] of Object.entries({ window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage,
  HTMLElement: win.HTMLElement, Element: win.Element, Node: win.Node, React, IS_REACT_ACT_ENVIRONMENT: true, fetch: fetcher })) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import("react-dom/client"), { CareerStudioWorkspace } = await import("../src/components/CareerStudioWorkspace");
const { activatePrincipal } = await import("../src/lib/identity"), { createResumeAgentContext } = await import("../src/lib/resume-agent-context");
const base = createDemoFactBase("2026-11-09T00:00:00Z"), view = createDefaultResumeView(base, "2026-11-09T00:00:00Z");
let props: CareerStudioWorkspaceProps = { active: true, workspaceKey: "lifecycle-workspace", resumeId: view.id, sourceFingerprint: "b".repeat(64),
  resume: projectResume(base, view), resumeEditContext: createResumeAgentContext(base, view) };
let root: ReturnType<typeof createRoot> | undefined;
async function settle(action = () => {}) { await React.act(async () => { action(); await next(); await next(); }); }
async function render() { if (!root) { const host = win.document.createElement("div"); win.document.body.append(host); root = createRoot(host as unknown as HTMLElement); } await settle(() => root!.render(React.createElement(CareerStudioWorkspace, props))); }
function button(text: RegExp) { const node = [...win.document.querySelectorAll("button")].find(node => text.test(node.textContent ?? "")); assert.ok(node, `Missing button ${text}`); return node; }
async function click(text: RegExp) { await settle(() => button(text).click()); }
async function check(text: RegExp) { const label = [...win.document.querySelectorAll("label")].find(node => text.test(node.textContent ?? "") && node.querySelector("input[type=checkbox]")); assert.ok(label); await settle(() => label.querySelector<HTMLInputElement>("input")!.click()); }
async function choose(text: RegExp, value: string) { const label = [...win.document.querySelectorAll("label")].find(node => text.test(node.textContent ?? "") && node.querySelector("select")); assert.ok(label); await settle(() => { const node = label.querySelector("select")!; node.value = value; node.dispatchEvent(new win.Event("change", { bubbles: true })); }); }
async function reset(overrides: Partial<CareerStudioWorkspaceProps> = {}) {
  if (root) await settle(() => root!.unmount()); root = undefined; win.document.body.replaceChildren(); win.localStorage.clear(); routes.length = 0; transportCalls.length = 0; createdContextIds.length = 0;
  activatePrincipal({ id: owner, username: "synthetic-lifecycle", displayName: "Synthetic lifecycle" });
  props = { active: true, workspaceKey: "lifecycle-workspace", resumeId: view.id, sourceFingerprint: "b".repeat(64), resume: projectResume(base, view),
    resumeEditContext: createResumeAgentContext(base, view), ...overrides };
  await render();
}
async function establishScope() {
  await click(/^读取已安装的本地模型$/); await choose(/^明确选择本地模型/, runtime.model);
  await settle(() => win.document.querySelector<HTMLInputElement>(".cs-selection-row input")!.click());
  await choose(/^本人贡献边界/, "implementation"); await check(/^本人明确确认这条原话/); await check(/^同意创建当前账号30分钟/); await click(/建立本次演练范围$/);
  assert.ok(win.document.querySelector(".cs-snapshot-bar"));
}
after(async () => { if (root) await settle(() => root!.unmount()); activatePrincipal(undefined); hook.deregister(); await win.happyDOM.abort(); for (const [key, original] of originals) { if (original) Object.defineProperty(globalThis, key, original); else Reflect.deleteProperty(globalThis, key); } });

test("an explicitly adopted layout keeps its frozen Panel alive until the formal receipt, then revokes the old source without hiding success", async () => {
  activatePrincipal({ id: owner, username: "synthetic-lifecycle", displayName: "Synthetic lifecycle" });
  let finish!: () => void, saveSignal: AbortSignal | undefined, finished = false;
  const saved = new Promise<void>(resolve => { finish = resolve; });
  props = { ...props, onAdoptLayout: async (_candidate, context) => {
    saveSignal = context.signal; await saved; context.signal.throwIfAborted(); finished = true;
    return { versionId: "formal-layout-readback", baseScope: context.baseScope, candidateFingerprint: context.candidateFingerprint,
      resultScope: { ...context.baseScope, revision: "c".repeat(64), contentHash: "c".repeat(64) } };
  } };
  await render(); await click(/^读取已安装的本地模型$/); await choose(/^明确选择本地模型/, runtime.model);
  await settle(() => win.document.querySelector<HTMLInputElement>(".cs-selection-row input")!.click());
  await choose(/^本人贡献边界/, "implementation"); await check(/^本人明确确认这条原话/); await check(/^同意创建当前账号30分钟/); await click(/建立本次演练范围$/);
  await click(/^排版闭环/); await click(/^Lifecycle reviewed save$/); assert.ok(saveSignal);
  props = { ...props, sourceFingerprint: "c".repeat(64), resume: { ...props.resume, layout: { ...props.resume.layout, pageMargin: 14 } } };
  await render(); assert.equal(saveSignal.aborted, false, "The own-write projection must not remount and cancel the pending formal readback");
  await settle(finish); await React.act(async () => { await delay(130); });
  assert.equal(finished, true); assert.match(win.document.body.textContent ?? "", /formal-layout-readback/);
  assert.ok(routes.includes("/context/revoke")); assert.equal(win.document.querySelector(".cs-snapshot-bar"), null);
});

test("a same-hash receipt with the wrong advanced revision cannot leave a persistent formal-success notice", async () => {
  await settle(() => root!.unmount()); root = undefined; win.document.body.replaceChildren(); win.localStorage.clear(); routes.length = 0;
  activatePrincipal({ id: owner, username: "synthetic-lifecycle", displayName: "Synthetic lifecycle" });
  let finish!: () => void;
  const saved = new Promise<void>(resolve => { finish = resolve; });
  props = { active: true, workspaceKey: "lifecycle-workspace", resumeId: view.id, sourceFingerprint: "b".repeat(64),
    resume: projectResume(base, view), resumeEditContext: createResumeAgentContext(base, view), onAdoptLayout: async (_candidate, context) => {
      await saved;
      return { versionId: "MALFORMED_RECEIPT_MUST_NOT_BE_SUCCESS", baseScope: context.baseScope, candidateFingerprint: context.candidateFingerprint,
        resultScope: { ...context.baseScope, revision: "d".repeat(64), contentHash: "c".repeat(64) } };
    } };
  await render(); await click(/^读取已安装的本地模型$/); await choose(/^明确选择本地模型/, runtime.model);
  await settle(() => win.document.querySelector<HTMLInputElement>(".cs-selection-row input")!.click());
  await choose(/^本人贡献边界/, "implementation"); await check(/^本人明确确认这条原话/); await check(/^同意创建当前账号30分钟/); await click(/建立本次演练范围$/);
  await click(/^排版闭环/); await click(/^Lifecycle reviewed save$/);
  props = { ...props, sourceFingerprint: "c".repeat(64), resume: { ...props.resume, layout: { ...props.resume.layout, pageMargin: 14 } } };
  await render(); await settle(finish); await React.act(async () => { await delay(130); });
  assert.doesNotMatch(win.document.body.textContent ?? "", /MALFORMED_RECEIPT_MUST_NOT_BE_SUCCESS/);
  assert.match(win.document.querySelector('[role="alert"]')?.textContent ?? "", /回执与当前版本不符.*结果可能未知/);
  assert.ok(routes.includes("/context/revoke"));
});

test("revoking a pending adoption then explicitly reauthorizing never relays its old receipt, error or invalidation into the new context or owner", async () => {
  for (const switchedOwner of [false, true]) for (const outcome of ["receipt", "error"] as const) {
    let finish!: () => void, saveSignal: AbortSignal | undefined;
    const saved = new Promise<void>(resolve => { finish = resolve; });
    const oldMarker = `OLD_${switchedOwner ? "OWNER" : "CONTEXT"}_${outcome.toUpperCase()}_MUST_NOT_RELAY`;
    await reset({ onAdoptLayout: async (_candidate, context) => {
      saveSignal = context.signal; await saved;
      // Intentionally emulate an already-dispatched business Adapter that may
      // finish after cancellation. Workspace must reject late authority itself.
      if (outcome === "error") throw new Error(oldMarker);
      return { versionId: oldMarker, baseScope: context.baseScope, candidateFingerprint: context.candidateFingerprint,
        resultScope: { ...context.baseScope, revision: "c".repeat(64), contentHash: "c".repeat(64) } };
    } });
    await establishScope(); const previousContextId = createdContextIds.at(-1)!;
    await click(/^排版闭环/); await click(/^Lifecycle reviewed save$/); assert.ok(saveSignal);
    props = { ...props, sourceFingerprint: "c".repeat(64), resume: { ...props.resume, layout: { ...props.resume.layout, pageMargin: 14 } } };
    await render(); assert.equal(saveSignal.aborted, false);
    await click(/^撤销本次范围并重新选择$/); assert.equal(saveSignal.aborted, true);
    if (switchedOwner) activatePrincipal({ id: nextOwner, username: "synthetic-next-owner", displayName: "Synthetic next owner" });
    await check(/^同意创建当前账号30分钟/); await click(/建立本次演练范围$/);
    const newContextId = createdContextIds.at(-1)!;
    assert.notEqual(newContextId, previousContextId, "each explicit authorization receives a new context identity");
    assert.ok(win.document.querySelector(".cs-snapshot-bar"));
    const newCreation = transportCalls.filter(call => call.route === "/context/create").at(-1)!;
    assert.equal(newCreation.owner, switchedOwner ? nextOwner : owner);
    let finishNew!: () => void, newSignal: AbortSignal | undefined;
    const newSaved = new Promise<void>(resolve => { finishNew = resolve; });
    const newVersion = `NEW_${switchedOwner ? "OWNER" : "CONTEXT"}_${outcome.toUpperCase()}_READBACK`;
    props = { ...props, onAdoptLayout: async (_candidate, newContext) => {
      newSignal = newContext.signal; await newSaved; newContext.signal.throwIfAborted();
      return { versionId: newVersion, baseScope: newContext.baseScope, candidateFingerprint: newContext.candidateFingerprint,
        resultScope: { ...newContext.baseScope, revision: "d".repeat(64), contentHash: "d".repeat(64) } };
    } };
    await render(); await click(/^Lifecycle reviewed save$/); assert.ok(newSignal);
    await settle(finish); await React.act(async () => { await delay(130); });
    assert.ok(win.document.querySelector(".cs-snapshot-bar"), "an old finally timer must not revoke a new authorization");
    assert.doesNotMatch(win.document.body.textContent ?? "", new RegExp(oldMarker));
    assert.equal(win.document.querySelector('[role="alert"]'), null, "an old error cannot appear under a new context or identity lease");
    assert.match(win.document.querySelector(".cs-notice")?.textContent ?? "", /已创建限时只读快照/);
    assert.ok(!transportCalls.some(call => call.route === "/context/revoke" && (call.body as { contextId: string }).contextId === newContextId));
    // The old finally must not clear the *new* adoption's active-write marker.
    // Otherwise this own CAS projection is misclassified as an external edit,
    // unmounting its Panel and losing the new formal receipt a second time.
    props = { ...props, sourceFingerprint: "d".repeat(64), resume: { ...props.resume, layout: { ...props.resume.layout, pageMargin: 12 } } };
    await render(); assert.equal(newSignal.aborted, false, "an old adoption cannot clear a new context's active write and abort its readback");
    await settle(finishNew); await React.act(async () => { await delay(130); });
    assert.match(win.document.querySelector(".cs-notice")?.textContent ?? "", new RegExp(newVersion));
    assert.doesNotMatch(win.document.body.textContent ?? "", new RegExp(oldMarker));
    assert.equal(win.document.querySelector(".cs-snapshot-bar"), null, "only the new adoption may revoke its own completed context");
  }
});

test("changing workspace or resume during a pending adoption rejects even a same-hash receipt and keeps the warning visible after revocation", async () => {
  for (const field of ["workspaceKey", "resumeId"] as const) {
    let finish!: () => void, saveSignal: AbortSignal | undefined, dispatches = 0;
    const saved = new Promise<void>(resolve => { finish = resolve; });
    const marker = `OLD_${field}_RECEIPT_MUST_NOT_BE_SUCCESS`;
    await reset({ onAdoptLayout: async (_candidate, context) => {
      dispatches++; saveSignal = context.signal; await saved;
      return { versionId: marker, baseScope: context.baseScope, candidateFingerprint: context.candidateFingerprint };
    } });
    await establishScope(); await click(/^排版闭环/); await click(/^Lifecycle reviewed save$/); assert.ok(saveSignal);
    // Deliberately leave the source hash identical: changing only the business
    // identity must not borrow an old receipt simply because its text matches.
    props = { ...props, [field]: `different-${field}` };
    await render(); assert.equal(saveSignal.aborted, false, "pending writes retain their signal until their outcome can be reconciled");
    await settle(finish); await React.act(async () => { await delay(130); }); await render();
    assert.equal(dispatches, 1, "a mismatched receipt is not automatically retried");
    assert.equal(win.document.querySelector(".cs-snapshot-bar"), null);
    assert.doesNotMatch(win.document.body.textContent ?? "", new RegExp(marker));
    assert.doesNotMatch(win.document.querySelector(".cs-notice")?.textContent ?? "", /排版候选已写入并回读正式版本/);
    assert.match(win.document.querySelector('[role="alert"]')?.textContent ?? "", /排版授权已变化|回执与当前版本不符/);
    assert.match(win.document.querySelector('[role="alert"]')?.textContent ?? "", /不会自动重试|没有自动重试/);
    assert.ok(routes.includes("/context/revoke"));
  }
});

test("a retired evidence-adoption callback cannot release the active token of a new layout adoption", async () => {
  let finishEvidence!: () => void, finishLayout!: () => void, layoutSignal: AbortSignal | undefined;
  const evidenceSaved = new Promise<void>(resolve => { finishEvidence = resolve; }), layoutSaved = new Promise<void>(resolve => { finishLayout = resolve; });
  await reset({ onAdoptEvidence: async () => { await evidenceSaved; return { versionId: "RETIRED_EVIDENCE_RECEIPT", statementId: "synthetic-statement" }; },
    onAdoptLayout: async (_candidate, context) => {
      layoutSignal = context.signal; await layoutSaved; context.signal.throwIfAborted();
      return { versionId: "NEW_LAYOUT_AFTER_EVIDENCE_READBACK", baseScope: context.baseScope, candidateFingerprint: context.candidateFingerprint,
        resultScope: { ...context.baseScope, revision: "d".repeat(64), contentHash: "d".repeat(64) } };
    } });
  await establishScope(); await click(/^高光收件箱/); await click(/^Lifecycle evidence save$/);
  props = { ...props, sourceFingerprint: "c".repeat(64), resume: { ...props.resume, layout: { ...props.resume.layout, pageMargin: 14 } } };
  await render(); await click(/^撤销本次范围并重新选择$/); await check(/^同意创建当前账号30分钟/); await click(/建立本次演练范围$/);
  await click(/^排版闭环/); await click(/^Lifecycle reviewed save$/); assert.ok(layoutSignal);
  await settle(finishEvidence); await React.act(async () => { await delay(130); });
  assert.ok(win.document.querySelector(".cs-snapshot-bar")); assert.equal(win.document.querySelector('[role="alert"]'), null);
  props = { ...props, sourceFingerprint: "d".repeat(64), resume: { ...props.resume, layout: { ...props.resume.layout, pageMargin: 12 } } };
  await render(); assert.equal(layoutSignal.aborted, false, "a retired Inbox finally cannot cancel the new Panel's own write/readback");
  await settle(finishLayout); await React.act(async () => { await delay(130); });
  assert.match(win.document.querySelector(".cs-notice")?.textContent ?? "", /NEW_LAYOUT_AFTER_EVIDENCE_READBACK/);
  assert.doesNotMatch(win.document.body.textContent ?? "", /RETIRED_EVIDENCE_RECEIPT/);
  assert.equal(win.document.querySelector(".cs-snapshot-bar"), null);
});
