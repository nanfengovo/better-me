import assert from "node:assert/strict";
import { setImmediate as next } from "node:timers/promises";
import test, { after, afterEach } from "node:test";
import { Window } from "happy-dom";
import type { CareerAnalysisPanelProps } from "../src/components/CareerAnalysisPanel";
import { AgentTaskClientError } from "../src/services/agent-task-transport";
const win = new Window(), React = await import("react"), originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: win, document: win.document, navigator: win.navigator, HTMLElement: win.HTMLElement,
  HTMLInputElement: win.HTMLInputElement, HTMLSelectElement: win.HTMLSelectElement, HTMLTextAreaElement: win.HTMLTextAreaElement,
  Element: win.Element, Node: win.Node, React, IS_REACT_ACT_ENVIRONMENT: true })) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import("react-dom/client"), { CareerAnalysisPanel } = await import("../src/components/CareerAnalysisPanel");
let root: ReturnType<typeof createRoot> | undefined;
const at = "2026-11-09T00:00:00.000Z", digest = "a".repeat(64);
const context: CareerAnalysisPanelProps["context"] = { id: "context-ui", ownerId: "synthetic-owner", session: "synthetic-session", workspaceKey: "workspace", resumeId: "resume", sourceFingerprint: digest, createdAt: at, expiresAt: "2099-01-01T00:00:00.000Z", revoked: false, jobs: [],
  claims: [{ id: "claim-1", text: "本人实现SQLite租约。", skillIds: ["sqlite"], contribution: "implementation", confirmedByUser: true, confirmedNumericTokens: [] }] };
async function settle(action = () => {}) { await React.act(async () => { action(); await next(); await next(); }); }
async function mounted(overrides: Partial<CareerAnalysisPanelProps> = {}) {
  const host = win.document.createElement("div"); win.document.body.append(host); root = createRoot(host as unknown as HTMLElement);
  const props: CareerAnalysisPanelProps = { context, kind: "spatial", runtime: { model: "synthetic-local", modelDigest: digest }, claimTargets: {}, request: async () => ({}), onOperation() {}, ...overrides };
  await settle(() => root!.render(React.createElement(CareerAnalysisPanel, props))); return props;
}
function field(label: RegExp, selector = "input,select,textarea") { const result = [...win.document.querySelectorAll("label")].find(node => label.test(node.textContent ?? ""))?.querySelector(selector); assert.ok(result, `missing field ${label}`); return result; }
async function fill(label: RegExp, value: string) { const node = field(label), prototype = node.tagName === "SELECT" ? win.HTMLSelectElement.prototype : node.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
  await settle(() => { Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value); node.dispatchEvent(new win.Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true })); }); }
async function check(label: RegExp) { await settle(() => (field(label, "input[type=checkbox]") as InstanceType<typeof win.HTMLInputElement>).click()); }
async function click(label: RegExp) { const node = [...win.document.querySelectorAll("button")].find(button => label.test(button.textContent ?? "")); assert.ok(node, `missing button ${label}`); await settle(() => node.click()); }
afterEach(async () => { await settle(() => root?.unmount()); root = undefined; win.document.body.innerHTML = ""; });
after(() => { for (const [key, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); win.happyDOM.cancelAsync(); });

test("spatial normal forms send only explicit bounded file/range selections after separate source consent, never numeric metrics", async () => {
  const calls: Array<{ route: string; body: unknown }> = [], operations: unknown[] = [];
  await mounted({ request: async (route, body) => { calls.push({ route, body }); if (route === "/publication/list") return { facts: [{ id: "b".repeat(64), statement: "已审阅的本人陈述" }] };
    return { id: "c".repeat(64), contextId: context.id, kind: "badge", status: "running", inputHash: digest, startedAt: at, updatedAt: at }; }, onOperation: operation => operations.push(operation) });
  await click(/加载已审阅/); await fill(/选择本次资料的核对回执/, "b".repeat(64));
  await check(/读取显式JSON状态转换表/); await check(/读取覆盖率报告/);
  await fill(/指标资料目录/, "/explicit/synthetic-project"); await fill(/转换表文件/, "states.json"); await fill(/转换表起始行/, "2"); await fill(/转换表结束行/, "9");
  await fill(/覆盖率格式/, "lcov"); await fill(/报告文件/, "reports/hits.txt"); await fill(/报告起始行/, "1"); await fill(/报告结束行/, "18");
  await fill(/哈希绑定manifest文件/, "reports/binding.json"); await fill(/manifest起始行/, "1"); await fill(/manifest结束行/, "1");
  await fill(/覆盖率对应源码文件/, "src/service.ts"); await fill(/源码起始行/, "4"); await fill(/源码结束行/, "32");
  const compile = [...win.document.querySelectorAll("button")].find(button => /编译回执徽章/.test(button.textContent ?? ""))!; assert.equal(compile.disabled, true);
  await check(/授权只读以上明确文件/); await click(/编译回执徽章/);
  const body = calls.find(call => call.route === "/badge/start")!.body as Record<string, unknown>;
  assert.deepEqual(body["metricSources"], { root: "/explicit/synthetic-project", transition: { file: { path: "states.json", startLine: 2, endLine: 9 }, format: "json" }, coverage: { format: "lcov", report: { path: "reports/hits.txt", startLine: 1, endLine: 18 }, manifest: { path: "reports/binding.json", startLine: 1, endLine: 1 }, sources: [{ path: "src/service.ts", startLine: 4, endLine: 32 }] } });
  assert.equal(body["metrics"], undefined); assert.equal(operations.length, 1); assert.equal(body["render"], false);
});

test("receipt display states exact source/hash scope without execution certification", async () => {
  const receipt = { schemaVersion: 1, metric: "declaredTransitionEntries", value: 3, targetHash: digest, method: "explicit_json_state_event_target_literal_count", scope: "仅states.json L1-L9", inputs: [{ kind: "broker_excerpt", id: "source-1", path: "states.json", sourceHash: "e".repeat(64), excerptHash: "f".repeat(64), startLine: 1, endLine: 9 }], executionVerified: false, limitations: ["不是运行时状态机复杂度"], hash: "d".repeat(64) };
  await mounted({ operation: { id: "c".repeat(64), contextId: context.id, kind: "badge", status: "completed", inputHash: digest, startedAt: at, updatedAt: at,
    output: { badge: { id: "badge-1", observation: { receipt: { id: "review-1" }, sourceHash: digest, skillIds: ["sqlite"] }, parameters: {}, mapping: [{ channel: "facet_count", metric: "declaredTransitionEntries", value: 3, rule: "literal entries only" }] }, links: { links: [], excludedJobs: 1, limitations: [] }, measurement: { schemaVersion: 1, targetHash: digest, status: "observed", metrics: {}, metricReceipts: [receipt], unknowns: ["evolutionDays:not_selected"], limitations: [] }, limitations: [] } } });
  const text = win.document.body.textContent ?? ""; assert.match(text, /指标读取与测量回执/); assert.match(text, /states.json/); assert.match(text, /e{64}/); assert.match(text, /本轮未执行测试/); assert.match(text, /evolutionDays:not_selected/);
});

test("oversized range never dispatches and editing an authorized selection clears its consent", async () => {
  const calls: string[] = [];
  await mounted({ request: async route => { calls.push(route); return route === "/publication/list" ? { facts: [{ id: "b".repeat(64), statement: "已核对陈述" }] } : {}; } });
  await click(/加载已审阅/); await fill(/选择本次资料的核对回执/, "b".repeat(64)); await check(/读取显式JSON状态转换表/);
  await fill(/指标资料目录/, "/explicit/project"); await fill(/转换表文件/, "states.json"); await fill(/转换表结束行/, "201"); await check(/授权只读以上明确文件/);
  await click(/编译回执徽章/); assert.equal(calls.includes("/badge/start"), false); assert.match(win.document.body.textContent ?? "", /最多200行/);
  await fill(/转换表结束行/, "20");
  assert.equal((field(/授权只读以上明确文件/, "input[type=checkbox]") as InstanceType<typeof win.HTMLInputElement>).checked, false);
  const compile = [...win.document.querySelectorAll("button")].find(button => /编译回执徽章/.test(button.textContent ?? ""))!; assert.equal(compile.disabled, true);
});

test("claim-level core validation issues remain visible even when model risk/defense arrays are empty; no defense card is invented", async () => {
  await mounted({ kind: "committee", operation: { id: "c".repeat(64), contextId: context.id, kind: "committee", status: "partial", inputHash: digest, startedAt: at, updatedAt: at,
    output: { schemaVersion: 1, status: "partial", usage: { modelCalls: 7, toolCalls: 0, elapsedMs: 10 }, roles: [], issues: [{ code: "no_supporting_evidence", claimId: "claim-1", detail: "本句没有读取到可支持实现归属的授权源码。" }, { code: "invalid_protocol", detail: "本次审查未完成全部角色协议。" }], claims: [{ claimId: "claim-1", support: "unknown", riskLevel: "high", questions: [], defense: [], risks: [], missing: [], citations: [], limitations: [], contribution: "unknown" }], limitations: [] } } });
  assert.match(win.document.body.textContent ?? "", /本句没有读取到可支持实现归属的授权源码/); assert.match(win.document.body.textContent ?? "", /本次审查未完成全部角色协议/);
  assert.match(win.document.body.textContent ?? "", /未完成，不能采用为通过/); assert.doesNotMatch(win.document.body.textContent ?? "", /防守底牌已核实|生产能力已认证/);
});

test("committee keeps full supplementary text and reconciles the frozen unknown create instead of sending edited content under a new key", async () => {
  const bodies: unknown[] = [], text = "  本人完整补充😀\r\n不知道生产结果。  ";
  await mounted({ kind: "committee", request: async (_route, body) => { bodies.push(body); if (bodies.length === 1) throw new AgentTaskClientError("合成回执丢失", "outcome_unknown");
    return { id: `ct_${"a".repeat(32)}`, contextId: context.id, kind: "committee", status: "running", taskStatus: "running", inputHash: digest, startedAt: at, updatedAt: at }; } });
  await fill(/补充本人陈述/, text); await check(/确认仅授权以上目录/); await click(/^开始有界抗压测试$/);
  assert.equal((bodies[0] as { statements: Array<{ text: string }> }).statements[1]!.text, text); assert.match(win.document.body.textContent ?? "", /上次创建回执待核对/);
  await fill(/补充本人陈述/, "另一份尚未发送的改动"); await check(/确认仅授权以上目录/); await click(/^开始有界抗压测试$/);
  assert.deepEqual(bodies[1], bodies[0]); assert.equal(win.document.body.textContent?.includes("上次创建回执待核对"), false);
});

test("committee rejects excessive selected claims explicitly; no first-40 truncation reaches the client", async () => {
  let calls = 0;
  await mounted({ kind: "committee", context: { ...context, claims: Array.from({ length: 41 }, (_, index) => ({ ...context.claims[0]!, id: `claim-${index}`, confirmedByUser: false })) }, request: async () => { calls++; return {}; } });
  await check(/确认仅授权以上目录/); await click(/^开始有界抗压测试$/); assert.equal(calls, 0); assert.match(win.document.body.textContent ?? "", /不会截取后发送/);
});

test("committee rejects over-20 complete statements explicitly instead of omitting any confirmed claim or supplement", async () => {
  let calls=0;
  await mounted({kind:"committee",context:{...context,claims:Array.from({length:20},(_,index)=>({...context.claims[0]!,id:`confirmed-${index}`}))},request:async()=>{calls++;return {};}});
  await fill(/补充本人陈述/,"  第21份补充😀，不得丢弃。  ");await check(/确认仅授权以上目录/);await click(/^开始有界抗压测试$/);
  assert.equal(calls,0);assert.match(win.document.body.textContent??"",/不会截取后发送/);
});
