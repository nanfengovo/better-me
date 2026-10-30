import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { registerHooks } from "node:module";
import { Window } from "happy-dom";
import { createInitialDocument } from "@better-me/storage";
import { applyResumeProposal, createResumeAgentContext } from "../src/lib/resume-agent-context";
import {
  generateWritingReply, inspectWriting, newWritingNote, parseWritingReply, readWritingSession,
  reconcileWritingNotes, saveWritingSession, writingSources, writingTargetKey, writingProposal, type WritingSource,
} from "../src/lib/resume-copilot";
import { quoteWritingText } from "../src/lib/writing-anchor";

// Finish installing the DOM before registering any tests. Otherwise a fast
// pure async test can let Node run teardown while React is still importing.
registerHooks({ load(url, context, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context); } });
const dom = new Window({ url: "http://writing-fixture.invalid" });
const React = await import("react");
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, HTMLTextAreaElement: dom.HTMLTextAreaElement, Element: dom.Element, Node: dom.Node,
  ResizeObserver: dom.ResizeObserver, MutationObserver: dom.MutationObserver,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), React, IS_REACT_ACT_ENVIRONMENT: true })) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { act, createElement: h } = React;
const { createRoot } = await import("react-dom/client");
const { ResumeWritingCopilot } = await import("../src/components/ResumeWritingCopilot");
const { observeResumeWriting } = await import("../src/lib/resume-writing-observer");

const source: WritingSource = { targetRef: { kind: "claim_text", experienceId: "fixture-exp", claimId: "fixture-claim", locale: "zh" }, text: "负责接口开发，参与系统维护", label: "虚构测试经历 · 要点 1" };
const issue = inspectWriting(source, [source])!;
test("local writing rules distinguish duties, repetition, evidence and useful action", () => {
  assert.equal(issue.kind, "duties");
  assert.equal(inspectWriting({ ...source, text: "完成相关工作和日常工作" }, [])?.kind, "vague");
  assert.equal(inspectWriting({ ...source, text: "优化响应时间，提高效率30%" }, [])?.kind, "evidence");
  assert.equal(inspectWriting(source, [source, { ...source, targetRef: { ...source.targetRef, kind: "claim_text", claimId: "other", experienceId: "other" } }])?.kind, "duplicate");
  assert.equal(inspectWriting({ ...source, text: "将订单接入流程拆成校验、重试与回执三个步骤，使用日志核对失败请求，保留异常上下文以便定位。" }, []) , undefined);
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
  await assert.rejects(generateWritingReply({ provider: "ollama", baseUrl: "http://localhost:11434/v1", model: "fixture", temperature: 0 }, source, "", controller.signal, async (_config, messages) => {
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
const config = { provider: "ollama" as const, baseUrl: "http://localhost:11434/v1", model: "test", temperature: 0 };
async function render(options: Partial<React.ComponentProps<typeof ResumeWritingCopilot>> = {}) {
  if (!root) { const container = dom.document.createElement("main"); dom.document.body.append(container); root = createRoot(container as unknown as Element); }
  await act(async () => root!.render(h(ResumeWritingCopilot, { sessionKey: "test", sources: [source], config, active: true, onApply: async () => ({ ok: true, message: "已采用" }), onFocus() {}, children: h("div", null, "示例预览"), ...options })));
}
async function click(text: string) {
  const button = [...dom.document.querySelectorAll("button")].find(b => b.textContent?.includes(text)); assert.ok(button, text);
  await act(async () => button.click());
}
afterEach(async () => { await act(async () => { root?.unmount(); root = undefined; }); dom.document.body.replaceChildren(); dom.localStorage.clear(); });
after(() => { dom.happyDOM.abort(); for (const [key, value] of originals) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } });
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
test("changing the source closes stale annotation and a fresh scan binds only new text", async () => {
  await render(); await click("检查当前简历"); await render({ sources: [{ ...source, text: "参与模块开发，负责接口维护" }] });
  assert.equal(dom.document.querySelector('[aria-label="Agent 伴写批注"]'), null);
  await click("检查当前简历"); assert.match(dom.document.querySelector('.writing-note blockquote')?.textContent ?? "", /参与模块/);
});
test("IME input is suppressed until compositionend; caret events request no analysis", () => {
  const editor = dom.document.createElement("div"), input = dom.document.createElement("textarea");
  input.dataset.writingKey = writingTargetKey(source.targetRef); editor.append(input); dom.document.body.append(editor);
  const events: boolean[] = []; const close = observeResumeWriting(editor as unknown as HTMLElement, (_activity, check) => events.push(check));
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
