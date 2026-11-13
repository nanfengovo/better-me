import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { Window, type HTMLButtonElement, type HTMLInputElement, type HTMLTextAreaElement, type HTMLSelectElement, type HTMLDetailsElement, type HTMLElement } from "happy-dom";
import { createInitialDocument } from "@better-me/storage";
import { applyResumeProposal, createResumeAgentContext } from "../src/lib/resume-agent-context";
import {
  generateWritingReply, inspectWriting, newWritingNote, parseWritingReply, readWritingSession, writingMessages,
  reconcileWritingNotes, saveWritingSession, writingSources, writingTargetKey, writingProjectSourceKey, writingProposal, confirmedWritingProjectContext, type WritingSource, type WritingReply,
} from "../src/lib/resume-copilot";
import { quoteWritingText } from "../src/lib/writing-anchor";
import { fixtureSession, fixtureUnderstanding } from "./fixtures/project-understanding";
import { BetterMeAgentProvider } from "../src/lib/betterme-agent/react";
import { createMemoryAgentRepository, type AgentRepository } from "../src/lib/betterme-agent/storage";
import type { UnderstandingClient } from "../src/services/understanding-client";
import type { ChatGptState } from "@better-me/agent-contracts";
import type { ChatGptClient } from "../src/services/chatgpt-client";
import { ExperienceRefineTaskError, defaultExperienceRefineTaskClient } from "../src/services/experience-refine-task-client";

// Finish installing the DOM before registering any tests. Otherwise a fast
// pure async test can let Node run teardown while React is still importing.
registerHooks({ load(url, context, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context); } });
const dom = new Window({ url: "http://writing-fixture.invalid" });
const React = await import("react");
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, HTMLTextAreaElement: dom.HTMLTextAreaElement, Element: dom.Element, Node: dom.Node,
  Event: dom.Event, CustomEvent: dom.CustomEvent,
  ResizeObserver: dom.ResizeObserver, MutationObserver: dom.MutationObserver,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), React, IS_REACT_ACT_ENVIRONMENT: true })) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { act, createElement: h } = React;
const { createRoot } = await import("react-dom/client");
const { ResumeWritingCopilot } = await import("../src/components/ResumeWritingCopilot");
const { AgentSidebarProvider, useAgentSidebar } = await import("../src/components/AgentSidebar");
const { observeResumeWriting } = await import("../src/lib/resume-writing-observer");
const { understandingScope } = await import("../src/components/ProjectUnderstandingPanel");

const source: WritingSource = { targetRef: { kind: "claim_text", experienceId: "fixture-exp", claimId: "fixture-claim", locale: "zh" }, text: "负责接口开发，参与系统维护", label: "虚构测试经历 · 要点 1" };
const issue = inspectWriting(source, [source])!;
test("isolated project memories have their own source namespace and cannot reopen another edition's field", async () => {
  const key = writingTargetKey(source.targetRef);
  assert.equal(writingProjectSourceKey(source.targetRef), key);
  const mine = writingProjectSourceKey(source.targetRef, "edition-a");
  const theirs = writingProjectSourceKey(source.targetRef, "edition-b");
  assert.notEqual((await understandingScope("test", mine)).projectKey, (await understandingScope("test", theirs)).projectKey);
  const focused: WritingSource[] = [];
  await render({ isolatedResumeId: "edition-a", onFocus: item => { focused.push(item); } });
  const { openProjectSource } = await import("../src/lib/agent-navigation");
  for (const wrong of [key, theirs]) await act(async () => openProjectSource(wrong));
  assert.equal(focused.length, 0);
  await act(async () => openProjectSource(mine));
  assert.equal(focused[0]?.text, source.text);
});
test("annotation navigation gives concurrent notes matching colors and numbers, and locates the selected source", async () => {
  const sources = [source, ...[2, 3].map(index => ({ ...source,
    targetRef: { kind: "claim_text" as const, experienceId: "fixture-exp", claimId: `fixture-claim-${index}`, locale: "zh" as const },
    text: `负责接口开发，参与系统维护，测试要点${index}`, label: `虚构测试经历 · 要点 ${index}`,
  }))];
  const focused: WritingSource[] = []; let modelCalls = 0, writes = 0;
  await render({ sources, onFocus: item => { focused.push(item); },
    generate: async () => { modelCalls++; return { questions: [], rationale: "", evidenceQuotes: [] }; },
    onApply: async () => { writes++; return { ok: true, message: "unused" }; },
  });
  await click("检查当前简历");
  const buttons = [...dom.document.querySelectorAll<HTMLButtonElement>(".writing-note-index button[data-annotation-id]")];
  assert.equal(buttons.length, 3, "all pending notes need a visible, directly selectable index");
  assert.equal(new Set(buttons.map(button => button.dataset.annotationTone)).size, 3, "nearby notes must not all use the workspace accent");
  assert.equal(buttons.filter(button => button.getAttribute("aria-pressed") === "true").length, 1);
  const tones = buttons.map(button => button.dataset.annotationTone);
  await act(async () => buttons[1]!.click());
  const card = dom.document.querySelector<HTMLElement>(".writing-note")!;
  assert.equal(card.dataset.annotationTone, tones[1]);
  assert.equal(card.querySelector(".writing-note-number")?.textContent, "2");
  assert.equal(focused.length, 0, "browsing notes must not force editor focus or close the mobile sidebar");
  await act(async () => dom.document.querySelector<HTMLButtonElement>(".writing-note .writing-source")!.click());
  const secondTarget = focused.at(-1)?.targetRef;
  assert.equal(secondTarget?.kind === "claim_text" && secondTarget.claimId, "fixture-claim-2");
  await click("下一条批注");
  assert.equal(dom.document.querySelector<HTMLElement>(".writing-note")?.dataset.annotationTone, tones[2]);
  assert.equal(focused.length, 1, "paging reveals the preview without moving focus into the editor");
  assert.equal(modelCalls, 0); assert.equal(writes, 0);
});
test("locating a quoted annotation cannot be replaced by the editor's whole-field focus event", async () => {
  const quoted = { ...source, quote: quoteWritingText(source.text, 0, 6)! };
  const whole = newWritingNote(source, issue), fragment = newWritingNote(quoted, issue);
  saveWritingSession(dom.localStorage as unknown as Storage, "betterme.writing.v1:test", { version: 1, mode: "quiet", notes: [whole, fragment] });
  await render({ children: h("div", { id: "resume-editor-panel" }, h("textarea", { "data-writing-key": writingTargetKey(source.targetRef), defaultValue: source.text })) });
  await act(async () => dom.document.querySelectorAll<HTMLButtonElement>(".writing-note-index button")[1]!.click());
  await act(async () => dom.document.querySelector<HTMLButtonElement>(".writing-note .writing-source")!.click());
  assert.equal(dom.document.querySelector(".writing-note-number")?.textContent, "2");
  assert.equal(dom.document.querySelector(".writing-note blockquote")?.textContent, quoted.quote.exact);
  assert.equal(dom.document.activeElement?.tagName, "TEXTAREA");
});
test("paging retains each note's supplement but never carries its approval to another note", async () => {
  const second: WritingSource = { ...source, targetRef: { kind: "claim_text", experienceId: "fixture-exp", claimId: "second", locale: "zh" }, label: "虚构第二条" };
  const firstNote = { ...newWritingNote(source, issue), answer: "我本人补充的未发送草稿" };
  saveWritingSession(dom.localStorage as unknown as Storage, "betterme.writing.v1:test", { version: 1, mode: "quiet", notes: [firstNote, newWritingNote(second, issue)] });
  await render({ sources: [source, second] }); await click("一起完善");
  await act(async () => (dom.document.querySelector('.writing-review-compose input[type="checkbox"]') as unknown as HTMLInputElement).click());
  await click("下一条批注"); await click("上一条批注"); await click("一起完善");
  assert.equal((dom.document.querySelector("#writing-answer") as unknown as HTMLTextAreaElement).value, firstNote.answer);
  assert.equal((dom.document.querySelector('.writing-review-compose input[type="checkbox"]') as unknown as HTMLInputElement).checked, false);
  assert.equal([...dom.document.querySelectorAll("button")].find(item => item.textContent?.includes("整理候选表达"))!.disabled, true);
});
test("leaving the resume page keeps the annotation composer mounted", async () => {
  await render(); await click("检查当前简历"); await click("一起完善");
  const composer = dom.document.querySelector("#writing-answer");
  assert.ok(composer);
  await render({ active: false });
  assert.ok(dom.document.querySelector("#writing-answer") === composer, "navigation must not destroy the live composer");
});
test("local writing rules distinguish duties, repetition, evidence and useful action", () => {
  assert.equal(issue.kind, "duties");
  assert.equal(inspectWriting({ ...source, text: "完成相关工作和日常工作" }, [])?.kind, "vague");
  assert.equal(inspectWriting({ ...source, text: "优化响应时间，提高效率30%" }, [])?.kind, "evidence");
  assert.equal(inspectWriting(source, [source, { ...source, targetRef: { ...source.targetRef, kind: "claim_text", claimId: "other", experienceId: "other" } }])?.kind, "duplicate");
  assert.equal(inspectWriting({ ...source, text: "将订单接入流程拆成校验、重试与回执三个步骤，使用日志核对失败请求，保留异常上下文以便定位。" }, []) , undefined);
});

test("design-only contribution cannot be upgraded into implementation by a valid-looking model quote", () => {
  const answer = "个人贡献口径：设计方案，未声明已实现或上线。\n本人确认的动作：设计了重试接口。";
  const reply = parseWritingReply(JSON.stringify({ questions: [], rationale: "draft", proposedText: "实现并上线重试接口。", evidenceQuotes: ["设计了重试接口。"] }), source, answer);
  assert.equal(reply.proposedText, undefined);
  assert.match(reply.rationale, /只确认了设计方案/);
  assert.equal(parseWritingReply(JSON.stringify({ questions: [], rationale: "draft", proposedText: "设计重试接口。", evidenceQuotes: ["设计了重试接口。"] }), source, answer).proposedText, "设计重试接口。");
});

test("ChatGPT is an explicit Agent option; disconnected accounts cannot fall back to a configured model", async () => {
  let apiCalls = 0, accountCalls = 0;
  const state: ChatGptState = { profiles: [], usageUrl: "https://chatgpt.com/settings/usage", automaticBillingFallback: false };
  const client: ChatGptClient = { state: async () => state, models: async () => [], respond: async () => { accountCalls++; throw new Error("must not run"); }, signIn: async () => { throw new Error("No real login in a fixture"); },
    cancelSignIn: async () => state, signOut: async () => ({ remoteRevoked: true, state }), retry: async () => state };
  await render({ chatGptClient: client, generate: async () => { apiCalls++; throw new Error("fallback forbidden"); } });
  await act(async () => { const field = dom.document.querySelector('[aria-label="伴写 Agent 来源"]')! as unknown as HTMLSelectElement; field.value = "chatgpt"; field.dispatchEvent(new dom.Event("change", { bubbles: true })); });
  await click("检查当前简历"); await click("一起完善");
  const button = [...dom.document.querySelectorAll("button")].find(node => node.textContent?.includes("进一步追问"))!;
  assert.equal(button.disabled, true); assert.match(dom.document.body.textContent ?? "", /Continue with ChatGPT/);
  assert.equal(accountCalls, 0); assert.equal(apiCalls, 0);
});

test("ChatGPT account/model selection routes writing only to the account and retains supplement on quota failure", async () => {
  let apiCalls = 0, legacyCalls = 0; const sent: Parameters<typeof defaultExperienceRefineTaskClient.refine>[0][] = [];
  const state: ChatGptState = { profiles: [{ id: "synthetic-account", label: "虚构账号", state: "connected" }], usageUrl: "https://chatgpt.com/settings/usage", automaticBillingFallback: false };
  const client: ChatGptClient = { state: async () => structuredClone(state), models: async () => [{ slug: "synthetic-gpt", displayName: "虚构 GPT" }],
    respond: async () => { legacyCalls++; throw new Error("legacy executor forbidden"); },
    signIn: async () => { throw new Error("No real login"); }, cancelSignIn: async () => state, signOut: async () => ({ remoteRevoked: true, state }), retry: async () => state };
  await render({ chatGptClient: client, generate: async () => { apiCalls++; throw new Error("fallback forbidden"); },
    refinementClient:{...defaultExperienceRefineTaskClient,refine:async input=>{sent.push(input);throw new ExperienceRefineTaskError("测试额度达到限制，未切换付费 API。","subscription_sharing_usage_limit_exceeded");}} });
  const select = async (selector: string, value: string) => { await act(async () => { const field = dom.document.querySelector(selector)! as unknown as HTMLSelectElement; field.value = value; field.dispatchEvent(new dom.Event("change", { bubbles: true })); }); };
  await select('[aria-label="伴写 Agent 来源"]', "chatgpt");
  const selects = () => [...dom.document.querySelectorAll<HTMLSelectElement>(".chatgpt-agent-fields select")];
  await act(async () => { const field = selects()[0]!; field.value = "synthetic-account"; field.dispatchEvent(new dom.Event("change", { bubbles: true })); });
  await act(async () => { const field = selects()[1]!; field.value = "synthetic-gpt"; field.dispatchEvent(new dom.Event("change", { bubbles: true })); });
  await click("检查当前简历"); await click("一起完善");
  const text = "我编写了重试逻辑";
  await act(async () => { const field = dom.document.querySelector("#writing-answer")!; Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!.call(field, text); field.dispatchEvent(new dom.Event("input", { bubbles: true })); });
  await act(async () => { const input = [...dom.document.querySelectorAll('input[type="checkbox"]')].find(node => node.parentElement?.textContent?.includes("我确认这段补充"))!; (input as unknown as HTMLInputElement).click(); });
  await click("整理候选表达");
  assert.equal(sent.length, 1); assert.deepEqual(sent[0]?.runtime, {kind:"chatgpt",profileId:"synthetic-account",model:"synthetic-gpt"});
  assert.deepEqual(sent[0]?.refinement.source,source);assert.equal(sent[0]?.supplement,text);assert.equal(sent[0]?.supplementConfirmed,true);
  assert.equal(apiCalls, 0);assert.equal(legacyCalls,0);
  assert.match(dom.document.body.textContent ?? "", /测试额度达到限制/);
  assert.equal((dom.document.querySelector("#writing-answer") as unknown as HTMLTextAreaElement).value, text);
  assert.equal(dom.document.querySelector("#writing-proposal"), null);
});
test("source deletion or edits invalidate open notes while dismissal survives", () => {
  const note = newWritingNote(source, issue);
  assert.equal(reconcileWritingNotes([note], [{ ...source, text: "新的原文" }])[0]?.state, "stale");
  assert.equal(reconcileWritingNotes([note], [])[0]?.state, "stale");
  assert.equal(reconcileWritingNotes([{ ...note, state: "dismissed" }], [])[0]?.state, "dismissed");
});
test("session persistence restores answers and prevents late reopening of dismissed notes", () => {
  const values = new Map<string, string>();
  const store = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const note = { ...newWritingNote(source, issue), answer: "我编写了重试逻辑" };
  saveWritingSession(store, "resume-a", { version: 1, mode: "quiet", notes: [note] });
  assert.equal(readWritingSession(store, "resume-a").notes[0]?.answer, note.answer);
  assert.equal(readWritingSession(store, "resume-b").notes.length, 0);
  saveWritingSession(store, "resume-a", { version: 1, mode: "quiet", notes: [{ ...note, state: "dismissed", updatedAt: note.updatedAt + 1 }] });
  const restored = saveWritingSession(store, "resume-a", { version: 1, mode: "quiet", notes: [{ ...note, updatedAt: note.updatedAt + 2 }] });
  assert.equal(restored.notes[0]?.state, "dismissed");
  values.set("bad", "invalid json"); assert.equal(readWritingSession(store, "bad").notes.length, 0);
});
test("long answers, model output and older notes survive sending and persistence intact", () => {
  const answer = "START_" + "完整补充".repeat(5000) + "_END_我编写了重试逻辑";
  const longSource = { ...source, text: "SOURCE_START_" + "完整原文".repeat(4000) + "_SOURCE_END" };
  const proposedText = "编写重试逻辑。".repeat(2200);
  const rationale = "完整说明".repeat(1000);
  const reply = parseWritingReply(JSON.stringify({ questions: [], proposedText, rationale, evidenceQuotes: ["我编写了重试逻辑"] }), longSource, answer);
  assert.equal(reply.proposedText, proposedText);
  assert.equal(reply.rationale, rationale);
  const sent = JSON.parse(writingMessages(longSource, answer)[1]!.content);
  assert.equal(sent.originalText, longSource.text);
  assert.equal(sent.confirmedSupplement, answer);
  const values = new Map<string, string>();
  const store = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
  const notes = Array.from({ length: 85 }, (_, index) => ({ ...newWritingNote(longSource, { kind: "context", title: "Synthetic", question: "Synthetic" }), id: `full-${index}`, answer, proposedText, rationale }));
  saveWritingSession(store, "full", { version: 1, mode: "quiet", notes });
  const restored = readWritingSession(store, "full");
  assert.equal(restored.notes.length, 85);
  for (const note of restored.notes) { assert.equal(note.answer, answer); assert.equal(note.proposedText, proposedText); assert.equal(note.rationale, rationale); }
});
test("model result must quote supplied evidence and cannot introduce a numeric claim", () => {
  const valid = { questions: [], proposedText: "编写接口重试逻辑", rationale: "明确动作", evidenceQuotes: ["接口开发", "编写了重试逻辑"] };
  assert.equal(parseWritingReply(JSON.stringify(valid), source, "我编写了重试逻辑").proposedText, valid.proposedText);
  assert.throws(() => parseWritingReply(JSON.stringify({ ...valid, proposedText: "性能提升90%" }), source, "我编写了重试逻辑"), /数字/);
  assert.throws(() => parseWritingReply(JSON.stringify({ ...valid, evidenceQuotes: ["主导整个团队"] }), source, "我编写了重试逻辑"), /依据/);
  assert.throws(() => parseWritingReply('{"questions":', source, ""), /完整/);
  assert.equal(parseWritingReply(JSON.stringify({ ...valid, proposedText: "编写重试逻辑，有效提升系统稳定性" }), source, "我编写了重试逻辑").proposedText, undefined);
});
test("model receives one field only and cancellation rejects a late result", async () => {
  const controller = new AbortController();
  await assert.rejects(generateWritingReply({ provider: "ollama", baseUrl: "http://localhost:11434/v1", apiKey: "", model: "fixture", temperature: 0 }, source, "", controller.signal, async (_config, messages) => {
    assert.equal(messages.length, 2); assert.equal(messages[1]?.content, JSON.stringify({ originalText: source.text, confirmedSupplement: "" }));
    controller.abort(); return { content: JSON.stringify({ questions: ["具体做了什么？"], rationale: "待补充", evidenceQuotes: [] }) };
  }), /abort/i);
});
test("incomplete model configuration gives a direct next step without a network request", async () => {
  let calls = 0;
  await assert.rejects(generateWritingReply({ provider: "openai-compatible", baseUrl: "https://example.invalid/v1", model: "fixture", apiKey: "", temperature: 0 }, source, "", new AbortController().signal, async () => {
    calls++; return { content: "" };
  }), /AI 配置/);
  assert.equal(calls, 0);
});
test("reviewed write and undo use exact source CAS, preserving unrelated facts", () => {
  const doc = createInitialDocument(); const context = createResumeAgentContext(doc.factBase, doc.resumeViews[0]!);
  const first = writingSources(context).find(s => s.targetRef.kind === "claim_text")!;
  const proposedText = `${first.text}（测试表达）`;
  const applied = applyResumeProposal(doc, { targetRef: first.targetRef, originalText: first.text, proposedText });
  assert.ok(applied.ok); if (!applied.ok) return;
  assert.equal(applied.document.factBase.profile, doc.factBase.profile);
  const undone = applyResumeProposal(applied.document, { targetRef: first.targetRef, originalText: proposedText, proposedText: first.text });
  assert.ok(undone.ok); if (undone.ok) assert.equal(JSON.stringify(undone.document.factBase.experiences.map(e => e.claims.map(c => c.text))), JSON.stringify(doc.factBase.experiences.map(e => e.claims.map(c => c.text))));
  assert.equal(applyResumeProposal(doc, { targetRef: first.targetRef, originalText: "过期内容", proposedText }).ok, false);
});
test("selected quote patch and undo preserve the rest of the field; reanchoring clears old candidates", () => {
  const text = "背景保持。负责接口开发，参与系统维护。结尾保持。";
  const selected = { ...source, text, quote: quoteWritingText(text, 5, 11)! };
  const note = { ...newWritingNote(selected, issue), answer: "我写了重试逻辑", proposedText: "编写请求重试逻辑" };
  const patch = writingProposal(note)!;
  assert.equal(patch.proposedText, "背景保持。编写请求重试逻辑，参与系统维护。结尾保持。");
  assert.equal(writingProposal(note, true)?.originalText, patch.proposedText);
  const reanchored = reconcileWritingNotes([note], [{ ...source, text: `新增。${text}` }])[0]!;
  assert.equal(reanchored.state, "open"); assert.equal(reanchored.source.quote?.start, 8);
  assert.equal(reanchored.answer, note.answer); assert.equal(reanchored.proposedText, undefined);
  assert.equal(reconcileWritingNotes([note], [{ ...source, text: text.replace("接口开发", "设备调试") }])[0]?.state, "stale");
});

let root: ReturnType<typeof createRoot> | undefined;
const config = { provider: "ollama" as const, baseUrl: "http://localhost:11434/v1", apiKey: "", model: "test", temperature: 0 };
async function render(options: Partial<React.ComponentProps<typeof ResumeWritingCopilot>> = {}, agentRepository?: AgentRepository) {
  if (!root) { const container = dom.document.createElement("main"); dom.document.body.append(container); root = createRoot(container as unknown as Element); }
  const copilot = h(ResumeWritingCopilot, { sessionKey: "test", sources: [source], config, active: true, onApply: async () => ({ ok: true, message: "已采用" }), onFocus() {}, children: h("div", null, "示例预览"), ...options });
  await act(async () => root!.render(agentRepository ? h(BetterMeAgentProvider, { workspaceKey: "isolated-unified-writing", repository: agentRepository, children: copilot }) : copilot));
}
async function click(text: string) {
  const button = [...dom.document.querySelectorAll("button")].find(b => b.textContent?.includes(text) || b.getAttribute("aria-label") === text); assert.ok(button, text);
  await act(async () => button.click());
}
afterEach(async () => { await act(async () => { root?.unmount(); root = undefined; }); dom.document.body.replaceChildren(); dom.localStorage.clear(); });
after(() => { dom.happyDOM.abort(); for (const [key, value] of originals) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } });

test("production lightweight writing button dispatches experience_refine through tasks and continues the same kernel ledger",async t=>{
  const {chatHost}=await import("./fixtures/free-chat-host");let calls=0,writes=0;
  const supplement="本人按任务编号关联日志，定位设备回执问题。";
  const host=await chatHost(t,async(prompt,_signal,phase)=>{
    calls++;assert.equal(phase,"experience_refine");assert.ok(prompt.includes(source.text));
    return JSON.stringify({questions:calls===1?["你亲手做了哪一步？"]:[],rationale:"合成内核回执。",evidenceQuotes:calls===1?[]:[supplement],...(calls===1?{}:{proposedText:"按任务编号关联日志，定位设备回执问题。"})});
  });
  await render({onApply:async()=>{writes++;return {ok:true,message:"unused"};}});
  await click("检查当前简历");await click("一起完善");await click("进一步追问");
  for(let i=0;i<100&&!dom.document.body.textContent?.includes("合成内核回执");i++)await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));});
  assert.equal(calls,1);assert.match(dom.document.body.textContent??"",/合成内核回执/);
  await act(async()=>{const field=dom.document.querySelector("#writing-answer")!;Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype,"value")!.set!.call(field,supplement);field.dispatchEvent(new dom.Event("input",{bubbles:true}));});
  await act(async()=>{[...dom.document.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find(i=>i.parentElement?.textContent?.includes("我确认这段补充"))!.click();});
  await click("整理候选表达");
  for(let i=0;i<100&&!dom.document.querySelector("#writing-proposal");i++)await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));});
  const tasks=await host.kernel.listTasks();assert.equal(tasks.length,1);const task=tasks[0]!;assert.equal(task.kind,"experience_refine");assert.equal(task.usage.modelCalls,2);assert.equal(writes,0);assert.equal(calls,2);
  assert.ok(dom.document.querySelector("#writing-proposal"));assert.ok(host.requests.every(row=>row.path.startsWith("/api/v1/agent/tasks")));
  const {privateStorage}=await import("../src/lib/identity");
  assert.equal(readWritingSession(privateStorage,"betterme.writing.v1:test").notes[0]?.source.text,source.text);
});

test("JD-bound writing hands the exact field and confirmed statement to the shared task, never its old model or write path",async()=>{
  let sidebar:ReturnType<typeof useAgentSidebar>,calls=0,writes=0;
  function Probe(){sidebar=useAgentSidebar();return null;}
  const job={id:"synthetic-job",title:"虚构测试岗",company:"演示",description:"核对接口测试。"};
  const container=dom.document.createElement("main");dom.document.body.append(container);root=createRoot(container as unknown as Element);
  await act(async()=>root!.render(h(AgentSidebarProvider,{children:[h(Probe,{key:"probe"}),h(ResumeWritingCopilot,{key:"writing",sessionKey:"test",sources:[source],config,active:true,
    careerTask:{sourceResumeId:"synthetic-resume",sourceFingerprint:"source-one",job},onFocus(){},onApply:async()=>{writes++;return {ok:true,message:"unused"};},generate:async()=>{calls++;throw Error("legacy path must not run");},children:h("div",null,"合成预览")})]})));
  await click("检查当前简历");await click("一起完善");
  await act(async()=>{const field=dom.document.querySelector("#writing-answer")!;Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype,"value")!.set!.call(field,"我只做接口测试，没有负责上线。");field.dispatchEvent(new dom.Event("input",{bubbles:true}));});
  await act(async()=>{[...dom.document.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find(i=>i.parentElement?.textContent?.includes("我确认这段补充"))!.click();});
  await click("交给岗位任务取证与审阅");
  assert.equal(calls,0);assert.equal(writes,0);assert.equal(sidebar!.conversation,"task");
  assert.equal(sidebar!.taskRequest?.focus?.originalText,source.text);assert.deepEqual(sidebar!.taskRequest?.focus?.targetRef,source.targetRef);
  assert.equal(sidebar!.taskRequest?.focus?.userStatement,"我只做接口测试，没有负责上线。");assert.deepEqual(sidebar!.taskRequest?.job,job);
  assert.ok(!JSON.stringify(sidebar!.taskRequest).includes("apiKey"));assert.equal(sidebar!.taskRequest?.focus?.sourceFingerprint,"source-one");
});

test("project contribution handoff appends to the actual copilot and requires a fresh confirmation before generation or adoption", async () => {
  const scope = await understandingScope("test", writingTargetKey(source.targetRef));
  const session = fixtureSession({ workspaceKey: "test", projectKey: scope.projectKey, sourceText: source.text, revision: 5, phase: "confirmed", summaryHash: "lead-hash", confirmation: { revision: 5, summaryHash: "lead-hash", confirmedAt: "2026-11-01" },
    understanding: { ...fixtureUnderstanding, contributionLeads: [{ id: "role", title: "模块贡献", hypothesis: "可能做过接口", category: "responsibility", evidenceIds: ["msg-user"], question: "这个模块由你实现还是设计？", options: ["我设计了重试接口。"] }] } });
  dom.localStorage.setItem(scope.storageKey, JSON.stringify({ sessionId: session.id, answer: "", options: [] }));
  const existing = { ...newWritingNote(source, issue), answer: "保留原有补充。" };
  saveWritingSession(dom.localStorage as unknown as Storage, "betterme.writing.v1:test", { version: 1, mode: "quiet", notes: [existing] });
  let models = 0, writes = 0; let sentAnswer = "";
  const unexpected = async () => { throw new Error("No session mutation expected"); };
  const client: UnderstandingClient = { createSession: unexpected, updateSource: unexpected, addGrant: unexpected, revokeGrant: unexpected, startTurn: unexpected, confirm: unexpected, cancel: unexpected, getCapabilities: async () => [], getSession: async () => session };
  await render({ understandingClient: client, onApply: async () => { writes++; return { ok: true, message: "fixture" }; }, generate: async (_config, _source, answer) => { models++; sentAnswer = answer; return { questions: [], proposedText: "设计重试接口。", rationale: "只表达设计", evidenceQuotes: ["我设计了重试接口。"] }; } });
  await click("先对齐项目理解");
  for (let index = 0; index < 50 && !dom.document.querySelector(".contribution-lead"); index++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  await click("我设计了重试接口。");
  await act(async () => { const select = dom.document.querySelector('select[id$="-stage"]')!; (select as unknown as HTMLSelectElement).value = "design"; select.dispatchEvent(new dom.Event("change", { bubbles: true })); });
  await act(async () => { const checkbox = [...dom.document.querySelectorAll('input[type="checkbox"]')].find(item => item.parentElement?.textContent?.includes("我确认这些"))!; (checkbox as unknown as HTMLInputElement).click(); });
  await click("带入伴写核对");
  assert.equal(models, 0); assert.equal(writes, 0);
  const answer = (dom.document.querySelector("#writing-answer") as unknown as HTMLTextAreaElement).value;
  assert.match(answer, /^保留原有补充。/); assert.match(answer, /设计方案/); assert.match(answer, /我设计了重试接口/);
  assert.match(dom.document.body.textContent ?? "", /这个模块由你实现还是设计/);
  const generateButton = [...dom.document.querySelectorAll("button")].find(item => item.textContent?.includes("整理候选表达"))!;
  assert.equal(generateButton.disabled, true);
  await act(async () => { const checkbox = [...dom.document.querySelectorAll('input[type="checkbox"]')].find(item => item.parentElement?.textContent?.includes("我确认这段补充"))!; (checkbox as unknown as HTMLInputElement).click(); });
  await click("整理候选表达");
  assert.equal(models, 1); assert.equal(sentAnswer, answer); assert.equal(writes, 0);
  assert.match(dom.document.querySelector(".writing-candidate-evidence")?.textContent ?? "", /我设计了重试接口/);
  assert.equal([...dom.document.querySelectorAll("button")].find(item => item.textContent?.includes("确认采用到简历"))!.disabled, true);
});
test("unified writing keeps its pending task and result when the resume page becomes inactive", async () => {
  const repository = createMemoryAgentRepository(); let resolve!: (reply: WritingReply) => void; let signal: AbortSignal | undefined;
  const generate: typeof generateWritingReply = async (_config, _source, _answer, inputSignal) => { signal = inputSignal; return new Promise(done => { resolve = done; }); };
  await render({ generate }, repository); await click("检查当前简历"); await click("一起完善"); await click("进一步追问");
  await render({ generate, active: false }, repository);
  assert.equal(signal?.aborted, false);
  await act(async () => resolve({ questions: ["换页后继续核对个人动作？"], rationale: "保留上下文", evidenceQuotes: [] }));
  await render({ generate }, repository);
  assert.match(dom.document.body.textContent ?? "", /换页后继续核对个人动作/);
  assert.equal((await repository.load("isolated-unified-writing"))?.tasks.at(-1)?.status, "completed");
});
test("explicit scan and local progressive questions never call a model without a click", async () => {
  let calls = 0;
  await render({ generate: async () => { calls++; return { questions: ["哪个接口？"], rationale: "需要场景", evidenceQuotes: [] }; } });
  await click("检查当前简历"); await click("一起完善");
  assert.match(dom.document.body.textContent ?? "", /具体问题/); assert.equal(calls, 0);
  await click("进一步追问"); assert.equal(calls, 1); assert.match(dom.document.body.textContent ?? "", /哪个接口/);
  await click("本条不再提示").catch(async () => {
    await act(async () => (dom.document.querySelector('[aria-label="本条不再提示"]') as unknown as HTMLElement).click());
  });
  await click("检查当前简历"); assert.equal(dom.document.querySelector('[aria-label="Agent 伴写批注"]'), null);
});
test("stop immediately preserves answer and refuses an uncooperative late response", async () => {
  let resolve!: (value: Awaited<ReturnType<typeof generateWritingReply>>) => void;
  await render({ generate: () => new Promise(done => { resolve = done; }) });
  await click("检查当前简历"); await click("一起完善");
  const button = [...dom.document.querySelectorAll("button")].find(b => b.textContent?.includes("进一步追问"))!;
  await act(async () => { button.click(); }); await click("停止分析");
  await act(async () => { resolve({ questions: ["不得显示的迟到追问"], rationale: "迟到", evidenceQuotes: [] }); });
  assert.doesNotMatch(dom.document.body.textContent ?? "", /不得显示的迟到/); assert.match(dom.document.body.textContent ?? "", /已停止/);
});
test("collapsing the Agent preserves the mounted draft and a running reply without reopening it", async () => {
  let resolve!: (value: Awaited<ReturnType<typeof generateWritingReply>>) => void;
  let signal: AbortSignal | undefined;
  await render({ generate: (_config, _source, _answer, nextSignal) => { signal = nextSignal; return new Promise(done => { resolve = done; }); } });
  await click("检查当前简历"); await click("一起完善");
  const field = dom.document.querySelector("#writing-answer")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!.call(field, "我编写了回执重试逻辑");
    field.dispatchEvent(new dom.Event("input", { bubbles: true }));
    const consent = [...dom.document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(input => input.parentElement?.textContent?.includes("我确认这段补充"))!;
    consent.click();
  });
  await click("整理候选表达");
  const collapse = dom.document.querySelector<HTMLButtonElement>('[aria-label="收起 Agent 对话"]');
  assert.ok(collapse, "Agent needs a separate, non-destructive collapse control");
  await act(async () => collapse.click());
  const pane = dom.document.getElementById(collapse.getAttribute("aria-controls")!)! as HTMLElement;
  assert.equal(pane.hidden, true); assert.equal(collapse.getAttribute("aria-expanded"), "false");
  assert.equal(signal?.aborted, false); assert.equal(dom.document.querySelector("#writing-answer"), field);
  assert.match(dom.document.querySelector(".writing-toolbar")?.textContent ?? "", /分析中/);
  await act(async () => resolve({ questions: ["重试前如何核对回执状态？"], rationale: "区分个人动作", evidenceQuotes: [] }));
  assert.equal(pane.hidden, true, "late results must not steal preview space");
  await click("展开 Agent 对话");
  assert.equal(pane.hidden, false); assert.equal(dom.document.querySelector("#writing-answer"), field);
  assert.equal((field as unknown as HTMLTextAreaElement).value, "我编写了回执重试逻辑");
  assert.match(pane.textContent ?? "", /重试前如何核对回执状态/);
});
test("idle hints stay compact and model/memory settings have one disclosure without starting work", async () => {
  let calls = 0;
  await render({ generate: async () => { calls++; throw new Error("Layout must not start inference"); } }, createMemoryAgentRepository());
  await click("检查当前简历");
  const shell = dom.document.querySelector(".writing-shell")!;
  assert.ok(shell.classList.contains("is-agent-idle"), "a short hint must not reserve a full conversation track");
  const settings = dom.document.querySelector<HTMLDetailsElement>(".writing-settings");
  assert.ok(settings, "settings need a separate disclosure rather than another toolbar row");
  assert.equal(settings.open, false);
  assert.match(settings.querySelector("summary")?.textContent ?? "", /当前配置模型/);
  assert.ok(settings.querySelector('[aria-label="伴写参与方式"]'));
  assert.ok(settings.querySelector(".betterme-agent-consent"));
  assert.equal(dom.document.querySelector(".writing-agent-scroll .betterme-agent-consent"), null);
  const continuity = dom.document.querySelector(".writing-toolbar > .betterme-agent-entry");
  assert.equal(continuity?.textContent, "记忆与进度", "global task history must remain one click away, outside settings");
  const style = dom.document.createElement("style");
  style.textContent = readFileSync(new URL("../src/components/resume-writing-copilot.css", import.meta.url), "utf8");
  dom.document.head.append(style);
  try {
    assert.equal(dom.getComputedStyle(shell).getPropertyValue("--writing-agent-track"), "auto");
    assert.equal(dom.getComputedStyle(shell).gridTemplateRows, "auto auto minmax(0,1fr)", "the idle track must size to content, leaving the flexible track for the resume");
    assert.notEqual(dom.getComputedStyle(dom.document.querySelector(".writing-agent-pane")!).maxHeight, "none");
  } finally { style.remove(); }
  await click("一起完善");
  assert.equal(shell.classList.contains("is-agent-idle"), false);
  const draft = dom.document.querySelector("#writing-answer");
  await act(async () => { settings.open = true; });
  await act(async () => { settings.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  assert.equal(settings.open, false);
  assert.equal(dom.document.querySelector("#writing-answer"), draft);
  assert.equal(calls, 0);
});
test("project understanding collapse retains its mounted panel and unsent answer", async () => {
  let reads = 0;
  const unexpected = async () => { throw new Error("No writes in a layout regression"); };
  const client: UnderstandingClient = { createSession: unexpected, updateSource: unexpected, addGrant: unexpected, revokeGrant: unexpected, startTurn: unexpected, confirm: unexpected, cancel: unexpected,
    getCapabilities: async () => { reads++; return []; }, getSession: unexpected };
  await render({ understandingClient: client }); await click("检查当前简历"); await click("先对齐项目理解");
  await act(async () => { await new Promise(done => setTimeout(done, 20)); });
  const panel = dom.document.querySelector(".understanding-panel")!;
  const field = panel.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!.call(field, "术语尚未对齐，保留这份未发送草稿");
    field.dispatchEvent(new dom.Event("input", { bubbles: true }));
    (panel.querySelector('[aria-label="收起项目理解面板"]') as unknown as HTMLButtonElement).click();
  });
  assert.equal(dom.document.querySelector(".understanding-panel"), panel);
  assert.equal(dom.document.querySelector<HTMLElement>(".writing-agent-pane")?.hidden, true);
  await click("展开 Agent 对话");
  assert.equal(dom.document.querySelector(".understanding-panel"), panel); assert.equal(reads, 1);
  assert.equal((field as unknown as HTMLTextAreaElement).value, "术语尚未对齐，保留这份未发送草稿");
});
test("changing the source closes stale annotation and a fresh scan binds only new text", async () => {
  await render(); await click("检查当前简历"); await render({ sources: [{ ...source, text: "参与模块开发，负责接口维护" }] });
  assert.equal(dom.document.querySelector('[aria-label="Agent 伴写批注"]'), null);
  await click("检查当前简历"); assert.match(dom.document.querySelector('.writing-note blockquote')?.textContent ?? "", /参与模块/);
});
test("IME input is suppressed until compositionend; caret events request no analysis", () => {
  const editor = dom.document.createElement("div"), input = dom.document.createElement("textarea");
  input.dataset.writingKey = writingTargetKey(source.targetRef); editor.append(input); dom.document.body.append(editor);
  const events: boolean[] = []; const close = observeResumeWriting(editor as unknown as Parameters<typeof observeResumeWriting>[0], (_activity, check) => events.push(check));
  input.dispatchEvent(new dom.Event("select", { bubbles: true }));
  input.dispatchEvent(new dom.Event("compositionstart", { bubbles: true })); input.dispatchEvent(new dom.Event("input", { bubbles: true }));
  assert.deepEqual(events, [false]); input.dispatchEvent(new dom.Event("compositionend", { bubbles: true })); assert.deepEqual(events, [false, true]); close();
});
test("selection in the real editor opens scoped guidance without a model request", async () => {
  const editor = dom.document.createElement("div"); editor.id = "resume-editor-panel";
  const input = dom.document.createElement("textarea"); input.dataset.writingKey = writingTargetKey(source.targetRef); input.value = source.text;
  editor.append(input); dom.document.body.append(editor);
  let calls = 0;
  await render({ generate: async () => { calls++; return { questions: [], rationale: "", evidenceQuotes: [] }; } });
  await act(async () => { input.setSelectionRange(0, 6); input.dispatchEvent(new dom.Event("select", { bubbles: true })); });
  await click("完善选中文字");
  assert.equal(dom.document.querySelector('.writing-note blockquote')?.textContent, "负责接口开发");
  assert.ok(dom.document.querySelector("#writing-answer")); assert.equal(calls, 0);
});
test("switching resume keys cancels work and never copies the prior resume's answers", async () => {
  const note = { ...newWritingNote(source, issue), answer: "仅属于第一份简历的补充" };
  dom.localStorage.setItem("betterme.writing.v1:resume-a", JSON.stringify({ version: 1, mode: "quiet", notes: [note] }));
  await render({ sessionKey: "resume-a" }); await click("一起完善");
  assert.equal((dom.document.querySelector("#writing-answer") as unknown as HTMLTextAreaElement).value, note.answer);
  await render({ sessionKey: "resume-b" });
  assert.equal(dom.document.querySelector(".writing-note"), null);
  assert.doesNotMatch(dom.localStorage.getItem("betterme.writing.v1:resume-b") ?? "", /仅属于/);
});
test("autonomous model questions require opt-in and stay disabled for a cloud endpoint", async () => {
  let calls = 0;
  dom.localStorage.setItem("betterme.writing.v1:test", JSON.stringify({ version: 1, mode: "proactive", autoLocalModel: true, notes: [] }));
  const generate = async () => { calls++; return { questions: ["你具体写了哪个接口？"], rationale: "请补充", evidenceQuotes: [] }; };
  await render({ generate, config: { ...config, model: "gemma4:31b-cloud" } });
  await click("检查当前简历"); assert.equal(calls, 0);
  await render({ generate }); assert.equal(calls, 1);
  await click("检查当前简历"); assert.equal(calls, 1);
});
test("apply is disabled until user verifies the candidate; persistence restores the review", async () => {
  const note = { ...newWritingNote(source, issue), answer: "编写请求重试逻辑", proposedText: "编写请求重试逻辑，在失败时保留上下文。", rationale: "已核对补充" };
  dom.localStorage.setItem("betterme.writing.v1:test", JSON.stringify({ version: 1, mode: "quiet", notes: [note] }));
  let writes = 0;
  await render({ onApply: async proposal => { writes++; assert.equal(proposal.originalText, source.text); return { ok: true, message: "已批准" }; } });
  await click("一起完善");
  const accept = [...dom.document.querySelectorAll("button")].find(b => b.textContent === "确认采用到简历")!;
  assert.equal(accept.disabled, true); assert.equal(writes, 0);
  const checkbox = [...dom.document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(input => input.parentElement?.textContent?.includes("逐字核对"))!;
  await act(async () => checkbox.click()); assert.equal(accept.disabled, false);
  await click("确认采用到简历"); assert.equal(writes, 1);
  assert.equal(readWritingSession(dom.localStorage as unknown as Storage, "betterme.writing.v1:test").notes[0]?.state, "applied");
});
test("undo reports restoration rather than another adoption", async () => {
  const note = { ...newWritingNote(source, issue), state: "applied" as const, answer: "编写请求重试逻辑", proposedText: "编写请求重试逻辑，在失败时保留上下文。" };
  dom.localStorage.setItem("betterme.writing.v1:test", JSON.stringify({ version: 1, mode: "quiet", notes: [note] }));
  await render({ sources: [{ ...source, text: note.proposedText }], onApply: async proposal => {
    assert.equal(proposal.originalText, note.proposedText);
    assert.equal(proposal.proposedText, source.text);
    return { ok: true, message: "已批准并提交到简历保存流程" };
  } });
  await click("撤销这次修改");
  assert.match(dom.document.body.textContent ?? "", /已撤销这次伴写修改/);
  assert.doesNotMatch(dom.document.body.textContent ?? "", /已批准并提交/);
});
test("only an exact current confirmation can be reused, and its background never expands contribution evidence", async () => {
  const session = fixtureSession({ phase: "confirmed", revision: 5, understanding: { ...fixtureUnderstanding, summary: "团队协调99个服务。", claims: [{ id: "team", kind: "source", text: "团队主导99个服务", evidenceIds: [] }] },
    summaryHash: "hash-5", confirmation: { revision: 5, summaryHash: "hash-5", confirmedAt: new Date().toISOString() } });
  const context = confirmedWritingProjectContext(session)!; assert.ok(context);
  assert.equal(confirmedWritingProjectContext({ ...session, revision: 6 }), undefined);
  assert.equal(confirmedWritingProjectContext({ ...session, phase: "awaiting-confirmation" }), undefined);
  await assert.rejects(generateWritingReply(config, source, "我编写了重试逻辑", new AbortController().signal, async (_config, messages) => {
    const request = JSON.parse(String(messages[1]?.content));
    assert.equal(request.projectContext.purpose, "terminology-and-boundaries-only");
    assert.equal(request.projectContext.claims, undefined); assert.equal(request.confirmedSupplement, "我编写了重试逻辑");
    assert.match(String(messages[0]?.content), /不是个人贡献证据/);
    return { content: JSON.stringify({ questions: [], rationale: "无依据的候选", evidenceQuotes: [source.text], proposedText: "编写99个服务的重试逻辑" }) };
  }, context), /数字/);
  await assert.rejects(generateWritingReply(config, source, "我编写了重试逻辑", new AbortController().signal, async () => ({
    content: JSON.stringify({ questions: [], rationale: "非法使用项目共识", evidenceQuotes: ["团队协调99个服务。"], proposedText: "编写重试逻辑" }),
  }), context), /本轮材料以外/);
});
test("opt-in project entry makes no model call and a changed confirmed revision blocks later writing", async () => {
  const scope = await understandingScope("test", writingTargetKey(source.targetRef));
  const session = fixtureSession({ workspaceKey: "test", projectKey: scope.projectKey, sourceText: source.text, phase: "confirmed", revision: 5, understanding: fixtureUnderstanding,
    summaryHash: "hash-5", confirmation: { revision: 5, summaryHash: "hash-5", confirmedAt: new Date().toISOString() } });
  dom.localStorage.setItem(scope.storageKey, JSON.stringify({ sessionId: session.id, answer: "", options: [] }));
  dom.localStorage.setItem("betterme.writing.v1:test", JSON.stringify({ version: 1, mode: "quiet", notes: [{ ...newWritingNote(source, issue), answer: "我编写了重试逻辑" }] }));
  let reads = 0, models = 0, mutations = 0;
  const unexpected = async () => { mutations++; throw new Error("Unexpected project mutation"); };
  const client: UnderstandingClient = { createSession: unexpected, updateSource: unexpected, addGrant: unexpected, revokeGrant: unexpected, startTurn: unexpected, confirm: unexpected, cancel: unexpected,
    getCapabilities: async () => [], getSession: async () => { reads++; return reads === 1 ? session : { ...session, revision: 6, phase: "awaiting-confirmation", confirmation: undefined }; } };
  await render({ understandingClient: client, generate: async () => { models++; return { questions: [], rationale: "", evidenceQuotes: [] }; } });
  assert.equal(reads, 0); await click("先对齐项目理解");
  for (let index = 0; index < 100 && !dom.document.querySelector(".understanding-confirmed"); index++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  assert.ok(dom.document.querySelector(".understanding-confirmed"), "wait for the restored confirmation, not elapsed time");
  assert.equal(models, 0); assert.equal(mutations, 0); assert.equal(reads, 1);
  await click("返回伴写建议"); await click("一起完善");
  const share = [...dom.document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(input => input.parentElement?.textContent?.includes("本次携带"))!;
  const actual = [...dom.document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(input => input.parentElement?.textContent?.includes("我确认这段补充"))!;
  assert.ok(share); await act(async () => { share.click(); actual.click(); });
  await click("整理候选表达"); assert.equal(models, 0); assert.equal(reads, 2);
  assert.match(dom.document.body.textContent ?? "", /项目理解已变化或需要重新确认/);
});
test("project confirmation changed during generation cannot become a successful shared Agent task or candidate", async () => {
  const scope = await understandingScope("test", writingTargetKey(source.targetRef));
  const session = fixtureSession({ workspaceKey: "test", projectKey: scope.projectKey, sourceText: source.text, phase: "confirmed", revision: 5, understanding: fixtureUnderstanding,
    summaryHash: "hash-5", confirmation: { revision: 5, summaryHash: "hash-5", confirmedAt: new Date().toISOString() } });
  dom.localStorage.setItem(scope.storageKey, JSON.stringify({ sessionId: session.id, answer: "", options: [] }));
  dom.localStorage.setItem("betterme.writing.v1:test", JSON.stringify({ version: 1, mode: "quiet", notes: [{ ...newWritingNote(source, issue), answer: "我编写了重试逻辑" }] }));
  let reads = 0, models = 0;
  const unexpected = async () => { throw new Error("Unexpected project mutation"); };
  const client: UnderstandingClient = { createSession: unexpected, updateSource: unexpected, addGrant: unexpected, revokeGrant: unexpected, startTurn: unexpected, confirm: unexpected, cancel: unexpected,
    getCapabilities: async () => [], getSession: async () => ++reads <= 2 ? session : { ...session, revision: 6, phase: "awaiting-confirmation", confirmation: undefined } };
  const repository = createMemoryAgentRepository();
  await render({ understandingClient: client, generate: async () => { models++; return { questions: [], rationale: "迟到结果", proposedText: "编写重试逻辑", evidenceQuotes: ["我编写了重试逻辑"] }; } }, repository);
  await click("先对齐项目理解");
  for (let index = 0; index < 100 && !dom.document.querySelector(".understanding-confirmed"); index++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  assert.ok(dom.document.querySelector(".understanding-confirmed"), "the confirmed session must load before returning to writing");
  await click("返回伴写建议"); await click("一起完善");
  await act(async () => {
    for (const input of dom.document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      if (/本次携带|我确认这段补充/.test(input.parentElement?.textContent ?? "")) input.click();
    }
  });
  await click("整理候选表达");
  assert.equal(models, 1); assert.equal(reads, 3);
  assert.equal(dom.document.querySelector("#writing-proposal"), null);
  assert.equal((dom.document.querySelector("#writing-answer") as unknown as HTMLTextAreaElement).value, "我编写了重试逻辑");
  const saved = await repository.load("isolated-unified-writing");
  assert.equal(saved?.tasks.at(-1)?.status, "failed");
  assert.match(saved?.tasks.at(-1)?.detail ?? "", /生成期间项目理解或授权已变化/);
  assert.ok(!saved?.messages.some(message => message.text.includes("迟到结果")));
});
