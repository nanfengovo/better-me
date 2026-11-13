import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { setImmediate as next, setTimeout as delay } from "node:timers/promises";
import test, { after, afterEach, beforeEach } from "node:test";
import { Window } from "happy-dom";
import { createDefaultResumeView, createDemoFactBase, projectResume } from "@better-me/core";
import type { StudioContext, StudioContextInput, StudioOperation } from "@better-me/agent-contracts/career-studio";
import { StudioCommitteeTaskSchema, type StudioCommitteeTask } from "@better-me/agent-contracts";
import type { CareerStudioWorkspaceProps } from "../src/components/CareerStudioWorkspace";
import { buildCareerEvidenceStatement, type CareerEvidenceEntry } from "../src/lib/career-studio-evidence";

const cssHook = registerHooks({ load(url, context, fallback) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : fallback(url, context); } });
const win = new Window({ url: "https://studio-workspace-fixture.invalid" }), React = await import("react");
const originals = new Map<string, PropertyDescriptor | undefined>();
type FetchCall = { route: string; body: Record<string, unknown>; owner: string | null; method: string; signal?: AbortSignal | null };
let transport: (call: FetchCall) => Promise<unknown> = async () => { throw Error("No external network permitted in Studio workspace test"); };
const calls: FetchCall[] = [];
const fetcher: typeof fetch = async (input, init = {}) => {
  const route = new URL(String(input)).pathname.replace("/api/v1/agent/career-studio", ""), call: FetchCall = { route,
    body: init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}, owner: new Headers(init.headers).get("X-BetterMe-Owner"), method: init.method ?? "GET", signal: init.signal };
  calls.push(call); return new Response(JSON.stringify(await transport(call)), { headers: { "Content-Type": "application/json" } });
};
for (const [key, value] of Object.entries({ window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage,
  HTMLElement: win.HTMLElement, HTMLInputElement: win.HTMLInputElement, HTMLSelectElement: win.HTMLSelectElement, HTMLTextAreaElement: win.HTMLTextAreaElement,
  Element: win.Element, Node: win.Node, React, IS_REACT_ACT_ENVIRONMENT: true, fetch: fetcher })) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import("react-dom/client"), { CareerStudioWorkspace } = await import("../src/components/CareerStudioWorkspace");
const { activatePrincipal } = await import("../src/lib/identity"), { createResumeAgentContext } = await import("../src/lib/resume-agent-context");
const ownerA = "11111111-1111-4111-8111-111111111111", ownerB = "22222222-2222-4222-8222-222222222222";
const runtime = { model: "synthetic-workspace-local", modelDigest: "a".repeat(64) }, claimText = "参与实现本机单写者租约并明确失败边界。";
const asOf = "2026-11-09T00:00:00.000Z";
let root: ReturnType<typeof createRoot> | undefined;
let props: CareerStudioWorkspaceProps;
let strictMode = false;
function fixtureProps(): CareerStudioWorkspaceProps {
  const base = createDemoFactBase(asOf), view = createDefaultResumeView(base, asOf);
  base.profile.displayName = { zh: "不应发送的合成联系人" };
  base.experiences[0]!.claims[0]!.text = { zh: claimText };
  return { active: true, workspaceKey: "workspace-ui", resumeId: view.id, sourceFingerprint: "b".repeat(64), resume: projectResume(base, view), resumeEditContext: createResumeAgentContext(base, view) };
}
async function settle(action = () => {}) { await React.act(async () => { action(); await next(); await next(); await next(); }); }
async function mounted(update: Partial<CareerStudioWorkspaceProps> = {}) {
  props = { ...props, ...update };
  if (!root) { const host = win.document.createElement("div"); win.document.body.append(host); root = createRoot(host as unknown as HTMLElement); }
  await settle(() => { const element = React.createElement(CareerStudioWorkspace, props); root!.render(strictMode ? React.createElement(React.StrictMode, null, element) : element); });
}
function button(pattern: RegExp) { const result = [...win.document.querySelectorAll("button")].find(item => pattern.test(item.textContent ?? "")); assert.ok(result, `missing button ${pattern}`); return result; }
async function click(pattern: RegExp) { await settle(() => button(pattern).click()); }
function field(pattern: RegExp, selector = "input:not([type=checkbox]),textarea,select") {
  const label = [...win.document.querySelectorAll("label")].find(item => pattern.test(item.textContent ?? "") && item.querySelector(selector));
  const result = label?.querySelector(selector); assert.ok(result, `missing field ${pattern}`); return result;
}
async function check(pattern: RegExp) { const result = field(pattern, "input[type=checkbox]"); await settle(() => (result as unknown as HTMLInputElement).click()); }
async function choose(pattern: RegExp, value: string) { const result = field(pattern, "select") as InstanceType<typeof win.HTMLSelectElement>; await settle(() => { result.value = value; result.dispatchEvent(new win.Event("change", { bubbles: true })); }); }
async function fill(pattern: RegExp, value: string) {
  const result = field(pattern), prototype = result.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
  await settle(() => { Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(result, value); result.dispatchEvent(new win.Event("input", { bubbles: true })); });
}
async function waitFor(predicate: () => boolean) { for (let turn = 0; turn < 80; turn++) { if (predicate()) return; await settle(); } assert.ok(predicate(), "bounded UI wait did not converge"); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function operation(contextId: string, status: StudioOperation["status"] = "running"): StudioOperation { return { id: "c".repeat(64), contextId, kind: "committee", inputHash: "d".repeat(64), status, startedAt: asOf, updatedAt: asOf }; }
const taskPath = "/api/v1/agent/tasks", isCreate = (call: FetchCall) => call.route === taskPath && call.method === "POST";
function basicTransport() {
  let selected: StudioContext | undefined;
  let task: StudioCommitteeTask | undefined;
  return async (call: FetchCall): Promise<unknown> => {
    if (call.route === "/runtimes") return { runtimes: [runtime] };
    if (call.route === "/context/create") {
      const input = call.body as unknown as StudioContextInput;
      selected = { ...input, id: "context-ui", ownerId: ownerA, session: "session-ui", createdAt: asOf, expiresAt: "2099-01-01T00:00:00.000Z", revoked: false };
      Reflect.deleteProperty(selected, "consent");
      return { context: selected, revision: 1, claimHashes: {}, limitations: ["synthetic selected snapshot"] };
    }
    if (call.route === "/runtime/select") return { selected: true, runtime };
    if (call.route === "/context/revoke") return { revoked: true };
    if (call.route === taskPath && call.method === "GET") return { tasks: task ? [task] : [] };
    if (isCreate(call)) {
      task = StudioCommitteeTaskSchema.parse({ kind: "studio_committee", workspaceKey: call.body.workspaceKey, rootScopeKey: call.body.rootScopeKey, objective: call.body.objective, request: call.body.request, runtimeBinding: call.body.runtimeBinding,
        id: `ct_${"c".repeat(32)}`, ownerId: ownerA, sourceFingerprint: "d".repeat(64), rootTaskId: `ct_${"c".repeat(32)}`,
        status: "ready", revision: 1, createdAt: asOf, updatedAt: asOf, budget: { maxModelCalls: 12, maxToolCalls: 30, maxActiveMs: 600000 }, usage: { modelCalls: 0, toolCalls: 0, activeMs: 0 }, events: [], turn: 1,
      }); return { task };
    }
    if (task && call.route === `${taskPath}/${task.id}/start`) { task = { ...task, status: "running", revision: task.revision + 1 }; return { task }; }
    if (task && call.route === `${taskPath}/${task.id}/pause`) { task = { ...task, status: "paused", revision: task.revision + 1 }; return { task }; }
    if (task && call.route === `${taskPath}/${task.id}`) return { task };
    throw Error(`unhandled fixture route ${call.route}`);
  };
}
async function selectScope() {
  await click(/^读取已安装的本地模型$/); await choose(/^明确选择本地模型/, runtime.model);
  await check(new RegExp(claimText)); await choose(/^本人贡献边界/, "implementation"); await check(/^本人明确确认这条原话/);
  await check(/^同意创建当前账号30分钟/); await click(/建立本次演练范围$/);
}
beforeEach(() => { props = fixtureProps(); strictMode = false; calls.length = 0; win.localStorage.clear(); activatePrincipal({ id: ownerA, username: "synthetic-a", displayName: "Synthetic A" }); transport = basicTransport(); });
afterEach(async () => { await settle(() => { root?.unmount(); root = undefined; }); win.document.body.replaceChildren(); activatePrincipal(undefined); });
after(async () => { cssHook.deregister(); await win.happyDOM.abort(); for (const [key, original] of originals) { if (original) Object.defineProperty(globalThis, key, original); else Reflect.deleteProperty(globalThis, key); } });

test("normal form explicitly selects local runtime and claims, pins the scope, polls and cancels without sending contacts or adopting facts", async () => {
  await mounted(); assert.equal(calls.length, 0); assert.equal(button(/建立本次演练范围$/).disabled, true);
  await selectScope(); await waitFor(() => win.document.body.textContent!.includes("只读快照已锁定"));
  assert.deepEqual(calls.map(call => call.route), ["/runtimes", "/context/create", "/runtime/select"]);
  const selected = calls.find(call => call.route === "/context/create")!.body as unknown as StudioContextInput;
  assert.equal(selected.claims.length, 1); assert.equal(selected.claims[0]!.text, claimText); assert.equal(selected.claims[0]!.confirmedByUser, true);
  assert.equal(selected.claims[0]!.contribution, "implementation"); assert.equal(selected.jobs.length, 0);
  assert.equal(JSON.stringify(selected).includes("不应发送的合成联系人"), false); assert.ok(!("factBase" in selected));
  assert.deepEqual(calls.find(call => call.route === "/runtime/select")!.body, { contextId: "context-ui", runtime, consent: true });
  await fill(/^补充本人陈述/, "仅参与租约实现，未核实生产规模。"); await check(/^确认仅授权以上目录/); await click(/^开始有界抗压测试$/);
  await waitFor(() => !!win.document.querySelector(".cs-operation"));
  const started = calls.find(isCreate)!.body.request as Record<string, unknown>;
  assert.deepEqual(started.runtime, runtime); assert.deepEqual(started.statements, [{ kind: "user_statement", label: "本人已确认的陈述（非独立核验）", text: claimText }, { kind: "user_statement", label: "本次补充的本人陈述", text: "仅参与租约实现，未核实生产规模。" }]);
  await React.act(async () => { await delay(1300); }); await waitFor(() => calls.some(call => call.route === `${taskPath}/ct_${"c".repeat(32)}`));
  await click(/^取消本次分析$/); await waitFor(() => win.document.body.textContent!.includes("分析状态：paused"));
  assert.equal(calls.filter(isCreate).length, 1); assert.ok(calls.every(call => call.owner === ownerA));
  assert.equal(calls.some(call => call.route === "/committee/start"), false);
  assert.equal(calls.some(call => /handoff|publication\/review|apply|adopt/.test(call.route)), false);
});

test("a source change while runtime pinning is pending revokes the new context and cannot expose an old locked scope", async () => {
  const pin = deferred<unknown>(), fallback = basicTransport();
  transport = async call => call.route === "/runtime/select" ? pin.promise : fallback(call);
  await mounted(); await selectScope(); await waitFor(() => calls.some(call => call.route === "/runtime/select"));
  await mounted({ sourceFingerprint: "e".repeat(64) }); await settle(() => pin.resolve({ selected: true, runtime }));
  await settle();
  assert.equal(win.document.body.textContent!.includes("只读快照已锁定"), false, "a stale context must not become the active UI after the source-change effect already ran");
  assert.ok(calls.some(call => call.route === "/context/revoke" && call.body.contextId === "context-ui"));
  assert.equal(calls.some(call => call.route === "/committee/start"), false);
});

test("changing source after dispatch revokes the context, aborts the client wait and refuses a late old-branch analysis", async () => {
  const pending = deferred<unknown>(), fallback = basicTransport();
  transport = async call => { if (isCreate(call)) await pending.promise; return fallback(call); };
  await mounted(); await selectScope(); await check(/^确认仅授权以上目录/); await click(/^开始有界抗压测试$/);
  await waitFor(() => calls.some(isCreate));
  await mounted({ sourceFingerprint: "f".repeat(64) });
  assert.ok(calls.find(isCreate)!.signal?.aborted);
  assert.ok(calls.some(call => call.route === "/context/revoke"));
  await settle(() => pending.resolve({ ...operation("context-ui", "completed"), output: { status: "completed", roles: [], claims: [], usage: { modelCalls: 1, toolCalls: 0, elapsedMs: 1 }, limitations: ["OLD_ANALYSIS_SENTINEL"] } }));
  assert.equal(win.document.body.textContent!.includes("只读快照已锁定"), false); assert.equal(win.document.body.textContent!.includes("OLD_ANALYSIS_SENTINEL"), false);
  assert.match(win.document.body.textContent!, /原稿已变化/); assert.equal(calls.filter(isCreate).length, 1);
});

test("an account generation change discards an in-flight response and never relays old claims to the new owner", async () => {
  const pending = deferred<unknown>(), fallback = basicTransport();
  transport = async call => { if (isCreate(call)) await pending.promise; return fallback(call); };
  await mounted(); await selectScope(); await check(/^确认仅授权以上目录/); await click(/^开始有界抗压测试$/);
  await waitFor(() => calls.some(isCreate));
  activatePrincipal({ id: ownerB, username: "synthetic-b", displayName: "Synthetic B" });
  await settle(() => pending.resolve({ ...operation("context-ui", "completed"), output: { status: "completed", roles: [], claims: [], usage: { modelCalls: 1, toolCalls: 0, elapsedMs: 1 }, limitations: ["OLD_OWNER_SENTINEL"] } }));
  await waitFor(() => !!win.document.querySelector('[role="alert"]'));
  assert.equal(win.document.body.textContent!.includes("OLD_OWNER_SENTINEL"), false); assert.match(win.document.querySelector('[role="alert"]')!.textContent!, /身份已失效/);
  assert.ok(calls.filter(isCreate).every(call => call.owner === ownerA));
  assert.equal(calls.some(call => call.owner === ownerB && JSON.stringify(call.body).includes(claimText)), false);
});

test("source range is an ordinary bounded form and invalid or oversized ranges never reach the Host", async () => {
  await mounted(); await selectScope(); await fill(/^授权源码目录/, "/synthetic-explicit-project"); await fill(/^目录内源码文件/, "src/lease.ts");
  await fill(/^起始行/, "2"); await fill(/^结束行/, "82"); await check(/^确认仅授权以上目录/); await click(/^开始有界抗压测试$/);
  assert.match(win.document.querySelector('[role="alert"]')!.textContent!, /最多80行/); assert.equal(calls.some(isCreate), false);
  await fill(/^结束行/, "81"); await check(/^确认仅授权以上目录/); await click(/^开始有界抗压测试$/); await waitFor(() => calls.some(isCreate));
  assert.deepEqual((calls.find(isCreate)!.body.request as Record<string, unknown>).code, [{ root: "/synthetic-explicit-project", files: [{ path: "src/lease.ts", startLine: 2, endLine: 81 }] }]);
});

test("micro-card form requires a personal quote and a separate reviewed adoption; generated summary never becomes a career statement", async () => {
  const personalQuote = "我仅参与本地租约恢复实现，尚未上线。", base = createDemoFactBase(asOf), before = structuredClone(base);
  let current: CareerEvidenceEntry = { id: "entry-ui", subscriptionId: "subscription-ui", repositoryId: "repository-ui", commit: "a".repeat(40), generation: 1, status: "awaiting_review", personalContribution: "unknown",
    title: "合成微卡片", summary: "MODEL_SUMMARY_SHOULD_NOT_BECOME_A_FACT_300%", contributionQuestion: "请确认本人的实际实现与部署边界。",
    citations: [{ evidenceId: "evidence-ui", path: "src/lease.ts", version: "after", sourceHash: "e".repeat(64), startLine: 1, endLine: 1, quote: "const lease = true;" }], limitations: ["作者与生产规模未知"], createdAt: asOf, updatedAt: asOf };
  let adopted: Awaited<ReturnType<typeof buildCareerEvidenceStatement>> | undefined, adoptions = 0;
  const fallback = basicTransport();
  transport = async call => {
    if (call.route === "/harvest/inbox") return { subscriptions: [], entries: [current], proposals: [] };
    if (call.route === "/harvest/review") { current = { ...current, status: "reviewed", review: call.body.review as CareerEvidenceEntry["review"] }; return current; }
    if (call.route === "/harvest/propose") { current = { ...current, status: "proposal_created", proposalReceipt: { id: "receipt-ui", proposalId: "proposal-ui", status: "pending_business_review" } }; return current; }
    return fallback(call);
  };
  await mounted({ onAdoptEvidence: async (entryId, expectedReviewHash) => { assert.equal(entryId, current.id); adoptions++; adopted = await buildCareerEvidenceStatement(base, current, expectedReviewHash); return { versionId: "readback-version-ui", statementId: adopted.statementId }; } });
  await selectScope(); await click(/^高光收件箱06$/); assert.equal(calls.some(call => call.route === "/harvest/inbox"), false);
  await click(/^刷新收件箱与订阅状态$/); await click(/^打开卡片并核对来源$/); await choose(/^本人贡献边界/, "implementation");
  await fill(/^本人实际贡献原话/, personalQuote); await fill(/^角色边界/, "参与实现"); await fill(/^部署\/未上线说明/, "仅本地，未上线");
  await click(/^保存这次贡献审阅$/); await waitFor(() => !button(/^生成待审长期陈述提案/).disabled); assert.equal(adoptions, 0);
  await click(/^生成待审长期陈述提案/); await waitFor(() => !!win.document.querySelector('input[type=checkbox]'));
  assert.equal(button(/^单独批准长期本人陈述$/).disabled, true); assert.equal(adoptions, 0);
  await check(/^本人确认原话和来源/); await click(/^单独批准长期本人陈述$/); await waitFor(() => adoptions === 1 && win.document.body.textContent!.includes("readback-version-ui"));
  assert.equal(adopted!.factBase.personalStatements!.at(-1)!.text, personalQuote); assert.equal(JSON.stringify(adopted!.factBase.personalStatements).includes(current.summary!), false);
  assert.deepEqual(base, before); assert.deepEqual(adopted!.factBase.experiences, before.experiences); assert.equal(button(/^单独批准长期本人陈述$/).disabled, true);
});

test("React StrictMode effect replay permits a fresh explicit scope without retaining the cleanup-aborted lifetime", async () => {
  strictMode = true; await mounted(); await selectScope(); await waitFor(() => win.document.body.textContent!.includes("只读快照已锁定"));
  assert.equal(calls.filter(call => call.route === "/context/create").length, 1); assert.equal(calls.filter(call => call.route === "/runtime/select").length, 1);
  assert.equal(win.document.querySelector('[role="alert"]'), null);
});

test("StrictMode does not allow a pending runtime pin to activate an abandoned context after real unmount", async () => {
  strictMode = true; const pin = deferred<unknown>(), fallback = basicTransport(); transport = async call => call.route === "/runtime/select" ? pin.promise : fallback(call);
  await mounted(); await selectScope(); await waitFor(() => calls.some(call => call.route === "/runtime/select"));
  await settle(() => { root!.unmount(); root = undefined; }); await settle(() => pin.resolve({ selected: true, runtime }));
  await waitFor(() => calls.some(call => call.route === "/context/revoke" && call.body.contextId === "context-ui"));
  assert.equal(win.document.body.textContent!.includes("只读快照已锁定"), false); assert.equal(calls.some(call => call.route === "/committee/start"), false);
});
