import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { registerHooks } from "node:module";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Window } from "happy-dom";
import type { UnderstandingSession } from "@better-me/agent-contracts";
import type { UnderstandingClient, UnderstandingTurnRequest } from "../src/services/understanding-client";
import { UnderstandingClientError } from "../src/services/understanding-client";
import type { ConfirmedWritingProjectContext } from "../src/lib/resume-copilot";
import { fixtureSession, fixtureUnderstanding } from "./fixtures/project-understanding";
import { contributionSupplement, emptyContributionDraft } from "../src/lib/project-contribution";

registerHooks({ load(url, context, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context); } });
const dom = new Window({ url: "https://understanding-fixture.invalid" });
const React = await import("react");
const originals = new Map<string, PropertyDescriptor | undefined>();
let externalRequests = 0;
for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, HTMLTextAreaElement: dom.HTMLTextAreaElement, HTMLInputElement: dom.HTMLInputElement,
  Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true,
  fetch: async () => { externalRequests++; throw new Error("Synthetic panel tests must not use the network"); } })) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { act, createElement: h } = React;
const { createRoot } = await import("react-dom/client");
const { ProjectUnderstandingPanel, understandingScope } = await import("../src/components/ProjectUnderstandingPanel");
const config = { provider: "ollama" as const, model: "synthetic", baseUrl: "http://model-fixture.invalid/v1", temperature: 0 };
const sourceText = fixtureSession().sourceText;
const projectKey = "synthetic-field";

function fakeClient() {
  let server = fixtureSession();
  const turns: UnderstandingTurnRequest[] = [];
  const confirmations: Array<{ expectedRevision: number; summaryHash: string }> = [];
  const updates: Array<{ expectedRevision: number; sourceText: string }> = [];
  let creates = 0, gets = 0;
  const copy = () => structuredClone(server);
  const change = (patch: Partial<UnderstandingSession>) => { server = { ...server, revision: server.revision + 1, ...patch }; return copy(); };
  const client: UnderstandingClient = {
    createSession: async input => { creates++; server = fixtureSession(input); return copy(); },
    getSession: async () => { gets++; return copy(); },
    updateSource: async (_id, input) => { updates.push(input); return change({ sourceText: input.sourceText, phase: "idle", confirmation: undefined }); },
    getCapabilities: async () => [{ id: "unsupported", name: "未支持工具", available: true, supported: false, reason: "未验证只读工具边界" }],
    addGrant: async (_id, path) => change({ grants: [{ id: "grant", path, label: "合成授权", createdAt: new Date().toISOString() }], confirmation: undefined }),
    revokeGrant: async () => change({ grants: [], phase: "idle", confirmation: undefined }),
    startTurn: async (_id, input) => {
      turns.push(input);
      const question = { id: `q-${server.turnCount + 1}`, text: `动态追问 ${server.turnCount + 1}：这个词在项目中是什么意思？`, why: "先对齐语义", allowMultiple: false,
        options: [{ id: "a", label: "业务任务协调" }, { id: "b", label: "车辆路线规划" }] };
      return change({ phase: "awaiting-answer", turnCount: server.turnCount + 1, understanding: fixtureUnderstanding, summaryHash: "draft-hash", confirmation: undefined, question,
        messages: [...server.messages, { id: `user-${server.turnCount}`, role: "user", text: input.answer, selectedOptionIds: input.selectedOptionIds, at: new Date().toISOString() },
          { id: `agent-${server.turnCount}`, role: "agent", text: "先理解边界，不假定个人贡献。", question, at: new Date().toISOString() }] });
    },
    confirm: async (_id, input) => { confirmations.push(input); return change({ phase: "confirmed", confirmation: { revision: server.revision + 1, summaryHash: input.summaryHash, confirmedAt: new Date().toISOString() } }); },
    cancel: async () => change({ phase: "cancelled", confirmation: undefined }),
  };
  return { client, turns, confirmations, updates, change, get server() { return server; }, set server(value) { server = value; }, get creates() { return creates; }, get gets() { return gets; } };
}
type Fake = ReturnType<typeof fakeClient>;
async function seed(fake: Fake, patch: Partial<UnderstandingSession> = {}, answer = "") {
  const scope = await understandingScope("synthetic-workspace", projectKey);
  fake.server = fixtureSession({ projectKey: scope.projectKey, ...patch });
  dom.localStorage.setItem(scope.storageKey, JSON.stringify({ sessionId: fake.server.id, answer, options: [], questionId: fake.server.question?.id }));
  return scope;
}
let root: ReturnType<typeof createRoot> | undefined;
async function flush(action: () => void = () => {}) { await act(async () => { action(); await nextTurn(); await nextTurn(); await nextTurn(); }); }
async function waitFor(predicate: () => boolean) {
  for (let index = 0; index < 100; index++) { if (predicate()) return; await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); }
  assert.ok(predicate(), dom.document.body.textContent ?? "condition not met");
}
async function render(fake: Fake, patch: Partial<React.ComponentProps<typeof ProjectUnderstandingPanel>> = {}) {
  if (!root) { const main = dom.document.createElement("main"); dom.document.body.append(main); root = createRoot(main as unknown as Element); }
  await flush(() => root!.render(h(ProjectUnderstandingPanel, { workspaceKey: "synthetic-workspace", projectKey, label: "合成项目", sourceText, config,
    client: fake.client, onClose() {}, onConfirmed() {}, pollIntervalMs: 10, ...patch })));
  await waitFor(() => !dom.document.body.textContent?.includes("正在恢复本地对话"));
}
function button(text: RegExp) { const found = [...dom.document.querySelectorAll("button")].find(node => text.test(node.textContent ?? "")); assert.ok(found, `${text}: ${dom.document.body.textContent}`); return found; }
async function click(text: RegExp) { await flush(() => button(text).click()); }
async function toggle(text: RegExp) {
  const input = [...dom.document.querySelectorAll('input[type="checkbox"]')].find(node => text.test(node.parentElement?.textContent ?? ""));
  assert.ok(input, `Missing checkbox ${text}`); await flush(() => (input as unknown as HTMLInputElement).click());
}
async function fill(value: string) {
  const field = dom.document.querySelector("textarea")!;
  await flush(() => { Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!.call(field, value); field.dispatchEvent(new dom.Event("input", { bubbles: true })); });
}
async function unmount() { await act(async () => { root?.unmount(); root = undefined; }); dom.document.body.replaceChildren(); }
afterEach(async () => { await unmount(); dom.localStorage.clear(); assert.equal(externalRequests, 0); });
after(() => { dom.happyDOM.abort(); for (const [key, value] of originals) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } });

test("contribution handoff excludes hypotheses, unknown ownership and private client notes by construction", () => {
  const draft = { ...emptyContributionDraft(), answer: "我设计了任务接口", customerPrivate: "PRIVATE_CUSTOMER", publicContext: "半导体现场" };
  assert.equal(contributionSupplement({ ...draft, stage: "unknown" }), undefined);
  assert.equal(contributionSupplement({ ...draft, stage: "not-mine" }), undefined);
  const privateOnly = contributionSupplement({ ...draft, stage: "design" })!;
  assert.match(privateOnly, /设计方案，未声明已实现或上线/);
  assert.equal(privateOnly.includes("PRIVATE_CUSTOMER"), false);
  assert.equal(privateOnly.includes("半导体现场"), false);
  const publicText = contributionSupplement({ ...draft, stage: "design", disclose: true })!;
  assert.match(publicText, /半导体现场/); assert.equal(publicText.includes("PRIVATE_CUSTOMER"), false);
});

test("partial checkpoint labels the old card and shows exactly which evidence survived", async () => {
  const fake = fakeClient();
  await seed(fake, { phase: "error", understanding: fixtureUnderstanding,
    checkpoint: { turn: 7, status: "partial", used: 12, budget: 12, reusedDirectories: 8, evidenceIds: ["ev_doc"] },
    evidence: [{ id: "ev_doc", grantId: "grant", path: "proposal.md", hash: "fixture", startLine: 1, endLine: 20, excerpt: "Design only", collectedAt: "2026-11-01" }],
  });
  await render(fake);
  assert.match(dom.document.body.textContent ?? "", /上次理解 · 本轮尚未更新/);
  assert.match(dom.document.body.textContent ?? "", /读取操作 12 \/ 12 · 材料 1 段 · 目录复用 8 次/);
  assert.match(dom.document.body.textContent ?? "", /proposal.md · 1–20 行/);
  assert.equal(fake.turns.length, 0);
});

test("a grounded lead needs separate personal confirmation, retains drafts, and rechecks the server before handoff", async () => {
  const fake = fakeClient(); let supplements: string[] = [];
  const understanding = { ...fixtureUnderstanding, contributionLeads: [{ id: "role", title: "接口与职责", hypothesis: "可能负责接口，但尚未确认", category: "responsibility" as const, evidenceIds: ["msg-user"], question: "你实现还是设计了这个接口？", options: ["我做了接口设计", "不是我做的"] }] };
  await seed(fake, { phase: "confirmed", revision: 3, summaryHash: "lead-hash", confirmation: { revision: 3, summaryHash: "lead-hash", confirmedAt: "2026-11-01" }, understanding });
  const props = { onContribution: (value: string) => { supplements.push(value); } };
  await render(fake, props);
  assert.equal(button(/带入伴写/).disabled, true);
  await click(/^我做了接口设计$/);
  await flush(() => { const input = dom.document.querySelector('select[id$="-stage"]')!; (input as unknown as HTMLSelectElement).value = "design"; input.dispatchEvent(new dom.Event("change", { bubbles: true })); });
  await unmount(); await render(fake, props);
  assert.equal((dom.document.querySelector('textarea[id$="-answer"]') as unknown as HTMLTextAreaElement).value, "我做了接口设计");
  assert.equal(button(/带入伴写/).disabled, true, "restored draft is not implicitly confirmed");
  await toggle(/我确认这些是我的实际经历/);
  await click(/带入伴写/);
  assert.equal(supplements.length, 1); assert.match(supplements[0]!, /设计方案/);
  assert.equal(fake.turns.length, 0);
  supplements = []; fake.change({ phase: "idle", confirmation: undefined });
  await click(/带入伴写/);
  assert.equal(supplements.length, 0);
  assert.match(dom.document.body.textContent ?? "", /项目理解或授权已变化/);
});

test("opening does not create or send; dynamic choices are unselected and free correction has no round cap", async () => {
  const fake = fakeClient(); await render(fake);
  assert.equal(fake.creates, 0); assert.equal(fake.turns.length, 0); assert.equal(button(/让 Agent 继续理解/).disabled, true);
  assert.match(dom.document.body.textContent ?? "", /本机原生 Agent 也可能调用云模型/);
  const unsupported = dom.document.querySelector('option[value="unsupported"]')!; assert.equal(unsupported.getAttribute("disabled"), "");
  await toggle(/允许本轮/); await click(/让 Agent 继续理解/);
  assert.equal(fake.creates, 1); assert.equal(fake.turns.length, 1); assert.equal(fake.turns[0]?.answer, "");
  assert.equal(dom.document.querySelectorAll('input[type="radio"]:checked').length, 0);
  await flush(() => (dom.document.querySelector('input[type="radio"][value="a"]') as unknown as HTMLInputElement).click());
  await fill("这里是订单任务协调，不是车辆路径规划。"); await toggle(/允许本轮/); await click(/让 Agent 继续理解/);
  assert.deepEqual(fake.turns[1]?.selectedOptionIds, ["a"]); assert.match(fake.turns[1]?.answer ?? "", /不是车辆/);
  assert.equal(dom.document.querySelectorAll('input[type="radio"]:checked').length, 0);
  fake.change({ turnCount: 40 }); await click(/刷新状态/);
  await fill("第 41 轮仍需进一步纠正术语。"); await toggle(/允许本轮/);
  assert.equal(button(/让 Agent 继续理解/).disabled, false); await click(/让 Agent 继续理解/);
  assert.equal(fake.server.turnCount, 41); assert.equal(fake.turns.length, 3);
});

test("account understanding sends the selected profile/model only and selection changes require fresh consent", async () => {
  const fake = fakeClient();
  await render(fake);
  await toggle(/允许本轮/);
  await render(fake, { chatGpt: { profileId: "fictional-profile", model: "fictional-gpt", ready: true } });
  const picker = dom.document.querySelector<HTMLSelectElement>('select[id$="-runtime"]')!;
  assert.equal(picker.value, "chatgpt"); assert.equal(button(/让 Agent 继续理解/).disabled, true, "changing Agent clears prior API consent");
  await toggle(/允许本轮/); await click(/让 Agent 继续理解/);
  assert.deepEqual(fake.turns[0]?.runtime, { kind: "chatgpt", profileId: "fictional-profile", model: "fictional-gpt" });
  assert.equal(JSON.stringify(fake.turns[0]).includes("modelSettings"), false);
  await render(fake, { chatGpt: { profileId: "fictional-profile", model: "other-model", ready: false } });
  await toggle(/允许本轮/); assert.equal(button(/让 Agent 继续理解/).disabled, true); assert.equal(fake.turns.length, 1);
});

test("confirmation submits the displayed revision/hash and conflict requires fresh confirmation", async () => {
  const fake = fakeClient(); const received: Array<ConfirmedWritingProjectContext | undefined> = [];
  await seed(fake, { phase: "awaiting-confirmation", revision: 7, understanding: fixtureUnderstanding, summaryHash: "hash-7" });
  const originalConfirm = fake.client.confirm;
  let first = true;
  fake.client.confirm = async (id, input, signal) => {
    if (first) { first = false; fake.confirmations.push(input); fake.change({ summaryHash: "hash-8" }); throw new UnderstandingClientError("记录已变化", 409); }
    return originalConfirm(id, input, signal);
  };
  await render(fake, { onConfirmed: value => received.push(value) });
  assert.equal(button(/确认共同理解/).disabled, true);
  await toggle(/我已核对本版/); await click(/确认共同理解/);
  assert.deepEqual(fake.confirmations[0], { expectedRevision: 7, summaryHash: "hash-7" });
  assert.equal(button(/确认共同理解/).disabled, true); assert.equal(received.at(-1), undefined);
  await toggle(/我已核对本版/); await click(/确认共同理解/);
  assert.deepEqual(fake.confirmations[1], { expectedRevision: 8, summaryHash: "hash-8" });
  assert.equal(received.at(-1)?.revision, 9);
  await fill("我还需要纠正一个边界。"); await toggle(/允许本轮/); await click(/继续纠正/);
  assert.equal(received.at(-1), undefined); assert.equal(fake.server.confirmation, undefined);
});

test("source changes retain stable history and draft, block old confirmation, and update only explicitly", async () => {
  const fake = fakeClient(); const received: Array<ConfirmedWritingProjectContext | undefined> = [];
  const scope = await seed(fake, { phase: "confirmed", revision: 4, understanding: fixtureUnderstanding, summaryHash: "hash-4", confirmation: { revision: 4, summaryHash: "hash-4", confirmedAt: new Date().toISOString() },
    messages: [{ id: "history", role: "user", text: "已积累的术语解释", at: new Date().toISOString() }] }, "未发送的纠正草稿");
  await render(fake, { onConfirmed: value => received.push(value) }); assert.equal(received.at(-1)?.revision, 4);
  await render(fake, { sourceText: "已编辑的新原文", onConfirmed: value => received.push(value) });
  assert.equal(received.at(-1), undefined); assert.match(dom.document.body.textContent ?? "", /原文已变化，旧共识暂不可用于伴写/);
  assert.equal(fake.updates.length, 0); assert.equal(fake.creates, 0);
  assert.equal(dom.document.querySelector("textarea")?.value, "未发送的纠正草稿");
  await click(/以新原文继续/); assert.deepEqual(fake.updates, [{ expectedRevision: 4, sourceText: "已编辑的新原文" }]);
  assert.equal(fake.server.messages[0]?.text, "已积累的术语解释");
  assert.equal(JSON.parse(dom.localStorage.getItem(scope.storageKey)!).sessionId, fake.server.id);
  await unmount(); await render(fake, { sourceText: "已编辑的新原文" });
  assert.equal(dom.document.querySelector("textarea")?.value, "未发送的纠正草稿"); assert.match(dom.document.body.textContent ?? "", /已积累的术语解释/);
});

test("ambiguous submission preserves draft and reuses its idempotency key only after explicit refresh", async () => {
  const fake = fakeClient(); await seed(fake);
  const start = fake.client.startTurn; let failed: UnderstandingTurnRequest | undefined;
  fake.client.startTurn = async (id, input, signal) => { if (!failed) { failed = input; throw new UnderstandingClientError("等待超时，状态尚未确认", undefined, "timeout"); } return start(id, input, signal); };
  await render(fake); await fill("超时也不能丢失这段纠正。"); await toggle(/允许本轮/); await click(/让 Agent 继续理解/);
  assert.equal(dom.document.querySelector("textarea")?.value, "超时也不能丢失这段纠正。"); assert.equal(button(/让 Agent 继续理解/).disabled, true);
  await click(/刷新状态/); await toggle(/允许本轮/); await click(/让 Agent 继续理解/);
  assert.equal(fake.turns[0]?.idempotencyKey, failed?.idempotencyKey); assert.equal(fake.turns.length, 1);
});

test("running shows last progress and elapsed time; cancellation ignores a late poll and retains draft", async () => {
  const fake = fakeClient(); const received: Array<ConfirmedWritingProjectContext | undefined> = [];
  await seed(fake, { phase: "running", events: [{ sequence: 1, kind: "thinking", label: "正在整理合成术语", at: new Date(Date.now() - 45_000).toISOString() }] }, "正在编辑的下一条补充");
  const get = fake.client.getSession; let calls = 0; let resolvePoll: ((value: UnderstandingSession) => void) | undefined;
  fake.client.getSession = async (id, signal) => { calls++; return calls === 1 ? get(id, signal) : new Promise(resolve => { resolvePoll = resolve; }); };
  await render(fake, { onConfirmed: value => received.push(value) }); await waitFor(() => Boolean(resolvePoll));
  assert.match(dom.document.body.textContent ?? "", /正在整理合成术语/); assert.match(dom.document.body.textContent ?? "", /暂时没有新的进度/);
  await click(/停止本轮/); assert.match(dom.document.body.textContent ?? "", /本轮已停止/);
  const late = fixtureSession({ ...fake.server, phase: "confirmed", revision: 9, understanding: fixtureUnderstanding, summaryHash: "late", confirmation: { revision: 9, summaryHash: "late", confirmedAt: new Date().toISOString() } });
  await flush(() => resolvePoll?.(late));
  assert.equal(received.at(-1), undefined); assert.match(dom.document.body.textContent ?? "", /本轮已停止/);
  assert.equal(dom.document.querySelector("textarea")?.value, "正在编辑的下一条补充");
});

test("revoked context is labelled as continued history and selections keep their original server labels", async () => {
  const fake = fakeClient();
  const at = new Date().toISOString();
  await seed(fake, { phase: "idle", turnCount: 3,
    grants: [{ id: "revoked", path: "/synthetic/only", label: "Fixture", createdAt: at, revokedAt: at }],
    evidence: [{ id: "ev_fixture", grantId: "revoked", path: "flow.ts", hash: "synthetic", startLine: 1, endLine: 2, excerpt: "", collectedAt: at }],
    messages: [{ id: "old-question", role: "agent", text: "Earlier question", at, question: { id: "old", text: "Earlier wording", why: "", allowMultiple: false, options: [{ id: "a", label: "WRONG_REUSED_LABEL" }] } },
      { id: "answer", role: "user", text: "已选择（服务端核对选项）：CORRECT_ORIGINAL_LABEL", at, selectedOptionIds: ["a"] }],
  });
  await render(fake);
  assert.match(dom.document.body.textContent ?? "", /等待继续对齐/);
  assert.match(dom.document.body.textContent ?? "", /此材料已撤销或不再用于后续推理/);
  assert.match(dom.document.body.textContent ?? "", /CORRECT_ORIGINAL_LABEL/);
  assert.doesNotMatch(dom.document.body.textContent ?? "", /WRONG_REUSED_LABEL/);
});
