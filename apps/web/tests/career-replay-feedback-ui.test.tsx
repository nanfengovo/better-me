import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { setImmediate as next, setTimeout as delay } from "node:timers/promises";
import test, { after, afterEach } from "node:test";
import { Window } from "happy-dom";
import { createReplayFeedback, type ReplayFeedbackContext, type StudioReplayLocalRequest } from "../../agent-host/src/career-studio/replay-feedback.js";
import { StudioArtifactStore } from "../../agent-host/src/career-studio/storage.js";
import type { ReplayStepResult } from "@better-me/core/career-intelligence";
import type { CareerReplayFeedbackPanelProps } from "../src/components/CareerReplayFeedbackPanel";

const cssHook = registerHooks({ load(url, context, fallback) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : fallback(url, context); } });
const win = new Window({ url: "https://career-feedback-fixture.invalid" }), React = await import("react"), originals = new Map<string, PropertyDescriptor | undefined>();
let attemptedNetwork = 0;
for (const [key, value] of Object.entries({ window: win, document: win.document, navigator: win.navigator, HTMLElement: win.HTMLElement, HTMLTextAreaElement: win.HTMLTextAreaElement,
  HTMLInputElement: win.HTMLInputElement, HTMLSelectElement: win.HTMLSelectElement, Element: win.Element, Node: win.Node, React, IS_REACT_ACT_ENVIRONMENT: true,
  fetch: async () => { attemptedNetwork++; throw Error("No network in isolated replay-feedback UI fixtures"); } })) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import("react-dom/client");
const { default: Panel, parseFeedbackTranscript } = await import("../src/components/CareerReplayFeedbackPanel");
const runtime = { model: "synthetic-ui-local", modelDigest: "a".repeat(64) };
const selected = (): ReplayFeedbackContext => ({ id: "context-ui", ownerId: "synthetic-ui-owner", session: "session-ui", workspaceKey: "workspace-ui", resumeId: "resume-ui", sourceFingerprint: "b".repeat(64),
  createdAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00.000Z", revoked: false,
  claims: [{ id: "claim-1", text: "实现本机单写者租约，保留失败边界。", contribution: "implementation", confirmedByUser: true, confirmedNumericTokens: [], skillIds: ["sqlite"] }], jobs: [] });
const access = { session: "session-ui", valid: async () => true };
const local = async (request: StudioReplayLocalRequest): Promise<ReplayStepResult> => ({ kind: "analysis", summary: `公开分析摘要：${request.step.id}`, artifact: { type: "report", data: { selected: true } } });
let root: ReturnType<typeof createRoot> | undefined;
const cleanups: Array<() => Promise<void>> = [];
async function settle(action = () => {}) { await React.act(async () => { action(); await next(); await next(); await next(); }); }
async function mounted(props: Partial<CareerReplayFeedbackPanelProps> & { request: CareerReplayFeedbackPanelProps["request"] }) {
  if (!root) { const host = win.document.createElement("div"); win.document.body.append(host); root = createRoot(host as unknown as HTMLElement); }
  await settle(() => root!.render(React.createElement(Panel, { contextId: "context-ui", runtime, ...props })));
}
function button(pattern: RegExp) { const item = [...win.document.querySelectorAll("button")].find(element => pattern.test(element.textContent ?? "")); assert.ok(item, `missing button ${pattern}`); return item; }
async function click(pattern: RegExp) { await settle(() => button(pattern).click()); }
function field(pattern: RegExp, selector = "textarea,input:not([type=checkbox],[type=radio],[type=file]),select") {
  const label = [...win.document.querySelectorAll("label")].find(element => pattern.test(element.firstChild?.textContent ?? "") && element.querySelector(selector));
  const item = label?.querySelector(selector); assert.ok(item, `missing field ${pattern}`); return item;
}
async function fill(pattern: RegExp, value: string) {
  const item = field(pattern); await settle(() => {
    const prototype = item.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(item, value); item.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
}
async function check(pattern: RegExp) {
  const label = [...win.document.querySelectorAll("label")].find(element => pattern.test(element.textContent ?? "") && element.querySelector("input[type=checkbox]"));
  const item = label?.querySelector("input[type=checkbox]"); assert.ok(item, `missing checkbox ${pattern}`); await settle(() => (item as unknown as HTMLInputElement).click());
}
async function choose(pattern: RegExp, value: string) { const item = field(pattern, "select") as InstanceType<typeof win.HTMLSelectElement>; await settle(() => { item.value = value; item.dispatchEvent(new win.Event("change", { bubbles: true })); }); }
async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  // Real SQLite replay validation awaits several WebCrypto jobs. Immediate
  // turns are not a time budget: 50 spins can finish before a valid async job,
  // especially while other test files compete for workers. Yield to timers
  // and judge the observable condition against a monotonic bounded deadline.
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    const alert = win.document.querySelector('[role="alert"]');
    if (alert) assert.fail(`UI reported an error while waiting: ${alert.textContent ?? ""}`);
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) break;
    await React.act(async () => { await delay(Math.min(5, remainingMs)); });
  }
  assert.ok(predicate(), `bounded UI wait timed out after ${timeoutMs}ms; busy=${win.document.querySelector('[aria-busy="true"]')?.getAttribute("aria-label") ?? "none"}`);
}
async function fixture(model = local) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "betterme-feedback-ui-"))), store = new StudioArtifactStore("synthetic-ui-owner", directory), context = selected();
  cleanups.push(async () => { store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const helper = createReplayFeedback({ store, ownerId: context.ownerId, getContext: id => { if (id !== context.id) throw Error("context not selected"); return context; }, localModel: model }), calls: Array<{ route: string; body: Record<string, unknown> }> = [];
  const request: CareerReplayFeedbackPanelProps["request"] = async (route, body) => {
    const payload = body as Record<string, unknown>; calls.push({ route, body: structuredClone(payload) });
    if (route === "/feedback/identity") return helper.feedbackIdentity(String(payload.contextId), access);
    if (route === "/replay/get") return helper.replayGet(String(payload.runId), String(payload.contextId), access);
    if (route === "/rules/runtime") return helper.runtimeRules(String(payload.contextId), access);
    const method = ({ "/replay/create": "replayCreate", "/replay/continue": "replayContinue", "/replay/fork": "replayFork", "/feedback/save": "feedbackSave", "/feedback/analyze": "feedbackAnalyze", "/rules/propose": "rulePropose", "/rules/apply": "ruleApply", "/rules/revert": "ruleRevert", "/rules/export": "ruleExport" } as const)[route as "/replay/create"];
    if (!method) throw Error(`unsupported fixture route ${route}`);
    return helper[method](body, access);
  };
  return { context, helper, calls, request, store };
}
afterEach(async () => { await settle(() => { root?.unmount(); root = undefined; }); win.document.body.replaceChildren(); for (const cleanup of cleanups.splice(0)) await cleanup(); assert.equal(attemptedNetwork, 0); });
after(async () => { cssHook.deregister(); await win.happyDOM.abort(); for (const [key, original] of originals) { if (original) Object.defineProperty(globalThis, key, original); else Reflect.deleteProperty(globalThis, key); } });

test("initial/empty UI uses accessible ordinary forms, no automatic writes or fabricated success", async () => {
  const setup = await fixture(); await mounted({ request: setup.request });
  assert.equal(setup.calls.length, 0); assert.equal(button(/^执行选定分析$/).disabled, true); assert.equal(button(/^保存并分析反馈$/).disabled, true);
  assert.match(win.document.body.textContent!, /不自动投递、不改简历/);
  await click(/^载入当前版本$/); await waitFor(() => win.document.body.textContent!.includes("内容快照引用"));
  assert.equal(setup.calls.length, 1); assert.equal(field(/^映射到选定简历条目/, "select").textContent?.includes("实现本机单写者租约"), true);
  assert.ok(win.document.querySelector('[aria-label="回放与求职反馈工作台"]'));
  assert.equal(win.document.querySelector("input[type=file]")?.getAttribute("accept"), ".txt,.md,.srt,.vtt,text/plain");
});

test("UI wait gives a pending asynchronous operation timer an opportunity to finish rather than counting immediate turns", async () => {
  const setup = await fixture(); await mounted({ request: setup.request });
  let operationFinished = false;
  const completion = delay(30).then(() => { operationFinished = true; });
  try { await waitFor(() => operationFinished); }
  finally { await completion; }
  assert.equal(operationFinished, true);
});

test("UI wait remains bounded and fails immediately on an observable UI error instead of masking business failures", async () => {
  const setup = await fixture(); await mounted({ request: setup.request });
  await assert.rejects(waitFor(() => false, 20), /bounded UI wait timed out after 20ms/);
  const alert = win.document.createElement("p"); alert.setAttribute("role", "alert"); alert.textContent = "synthetic-checkpoint-hash-mismatch"; win.document.body.append(alert);
  await assert.rejects(waitFor(() => false), /UI reported an error while waiting: synthetic-checkpoint-hash-mismatch/);
});

test("clear-and-type replay input creates real SQLite timeline; exact N fork skips earlier analysis and verifies original branch hashes", async () => {
  const seen: string[] = [], setup = await fixture(async request => { seen.push(request.step.id); return local(request); });
  await mounted({ request: setup.request }); await click(/^载入当前版本$/);
  await fill(/^本次假设/, ""); await fill(/^本次假设/, "仅设计，尚未上线。"); await check(/^岗位差异分析/); await check(/^仅授权本次本地分析/);
  await click(/^执行选定分析$/); await waitFor(() => win.document.querySelectorAll(".crfp-timeline li").length === 5);
  assert.deepEqual(seen, ["resume-review", "job-gap-review"]); assert.match(win.document.body.textContent!, /公开分析摘要/);
  const originalId = String(setup.calls.find(call => call.route === "/replay/get")!.body.runId), before = await setup.helper.replayGet(originalId, setup.context.id, access);
  const exact = win.document.querySelectorAll('.crfp-timeline input[type=radio]')[2]!;
  await settle(() => (exact as unknown as HTMLInputElement).click());
  await fill(/^本次假设/, "修正：仅新增评测假设，不重写事实。"); await check(/^仅授权本次本地分析/); await click(/^从所选检查点分叉$/);
  await waitFor(() => win.document.body.textContent!.includes("已复核父分支原检查点未变"));
  assert.deepEqual(seen, ["resume-review", "job-gap-review", "job-gap-review"]);
  const request = setup.calls.find(call => call.route === "/replay/fork")!;
  assert.equal(request.body.parentCheckpointId, before.checkpoints[2]!.id); assert.equal(request.body.assumptions, "修正：仅新增评测假设，不重写事实。");
  assert.deepEqual(await setup.helper.replayGet(originalId, setup.context.id, access), before);
  await waitFor(() => !button(/^查看原分支$/).disabled); await click(/^查看原分支$/); await waitFor(() => String((field(/^已存分支ID/) as unknown as HTMLInputElement).value) === originalId);
  assert.equal(win.document.querySelectorAll(".crfp-timeline li").length, 5);
});

test("stop-waiting and context replacement discard late UI results instead of claiming server cancellation/success", async () => {
  let release!: () => void, started = false;
  const gate = new Promise<void>(resolve => { release = resolve; }), setup = await fixture(async request => { started = true; await gate; return local(request); });
  await mounted({ request: setup.request }); await click(/^载入当前版本$/); await check(/^仅授权本次本地分析/); await click(/^执行选定分析$/); await waitFor(() => started);
  await click(/^停止等待$/); assert.match(win.document.body.textContent!, /服务端是否完成可能未知/);
  await mounted({ contextId: "another-context", request: setup.request }); await settle(release); await settle();
  assert.equal(win.document.body.textContent!.includes("公开分析摘要"), false); assert.equal(win.document.body.textContent!.includes("内容快照引用"), false);
  assert.equal(win.document.querySelector(".crfp-timeline"), null); assert.equal(button(/^执行选定分析$/).disabled, true);
});

test("normal feedback form binds exact content/claim hashes and flows through reviewed runtime-only rule apply and revert", async () => {
  const modelRequests: StudioReplayLocalRequest[] = [];
  const setup = await fixture(async request => { modelRequests.push(request); return local(request); }); await mounted({ request: setup.request }); await click(/^载入当前版本$/);
  await check(/^仅授权本次本地分析/); await click(/^执行选定分析$/); await waitFor(() => modelRequests.length === 1 && !win.document.querySelector('[aria-busy=true]'));
  assert.equal(modelRequests[0]!.reviewedRuntimeRules.rules.length, 0);
  await fill(/^投递记录标识/, "application-real-reference"); await choose(/^观察到的结果/, "no_response"); await choose(/^记录来源/, "platform_receipt"); await fill(/^所选回执编号/, "user-imported-receipt"); await click(/^加入事件草稿$/);
  await fill(/^复盘笔记/, "[18:00-18:30] 面试官请我解释本人负责的并发恢复边界。"); await check(/^我确认笔记/); await check(/^授权保存本次所选事件/); await click(/^保存并分析反馈$/);
  await waitFor(() => !!win.document.querySelector(".crfp-patch")); assert.match(win.document.body.textContent!, /结果未知 1/);
  const saved = setup.calls.find(call => call.route === "/feedback/save")!.body, payload = saved.payload as { events: Array<{ resumeContentHash: string; receiptVerification: string }>; notes: Array<{ claimLinks: Array<{ claimHash: string }> }> };
  assert.equal(payload.events[0]!.resumeContentHash, setup.context.sourceFingerprint); assert.equal(payload.events[0]!.receiptVerification, "unverified"); assert.equal(payload.notes[0]!.claimLinks[0]!.claimHash.length, 64);
  await settle(() => (win.document.querySelector('.crfp-patch input[type=checkbox]') as unknown as HTMLInputElement).click());
  await click(/^预览1条规则建议$/); await waitFor(() => !!win.document.querySelector('[aria-label="个人规则补丁预览"]'));
  assert.equal(button(/^确认采用规则补丁$/).disabled, true);
  assert.match((win.document.querySelector('[aria-label="个人规则补丁预览"]') as unknown as HTMLTextAreaElement).value, /先确认实现、设计、非本人和不确定/);
  await check(/^我已核对预览与当前版本/); await click(/^确认采用规则补丁$/); await waitFor(() => win.document.body.textContent!.includes("已确认个人运行时侧写v1"));
  const active = await setup.helper.runtimeRules(setup.context.id, access); assert.equal(active.rules[0]!.sidecar.current.revision, 1);
  assert.equal(modelRequests.length, 1, "applying a rule does not automatically call the model"); assert.equal(button(/^执行选定分析$/).disabled, true);
  await check(/^仅授权本次本地分析/); await click(/^执行选定分析$/); await waitFor(() => modelRequests.length === 2 && !win.document.querySelector('[aria-busy=true]'));
  const createCalls = setup.calls.filter(call => call.route === "/replay/create"); assert.notEqual(createCalls[0]!.body.idempotencyKey, createCalls[1]!.body.idempotencyKey);
  assert.equal(modelRequests[1]!.reviewedRuntimeRules.rules[0]!.sidecar.current.hash, active.rules[0]!.sidecar.current.hash);
  await check(/^我已核对预览与当前版本/); await click(/^确认回退最近采用$/); await waitFor(() => win.document.body.textContent!.includes("已追加回退版本v2"));
  const restored = await setup.helper.runtimeRules(setup.context.id, access); assert.equal(restored.rules[0]!.sidecar.current.content, ""); assert.equal(restored.rules[0]!.sidecar.history.length, 2);
  assert.equal(modelRequests.length, 2, "reverting a rule does not automatically rerun analysis"); assert.equal(button(/^执行选定分析$/).disabled, true);
  await check(/^仅授权本次本地分析/); await click(/^执行选定分析$/); await waitFor(() => modelRequests.length === 3 && !win.document.querySelector('[aria-busy=true]'));
  assert.equal(modelRequests[2]!.reviewedRuntimeRules.rules.length, 0); assert.equal(modelRequests[2]!.reviewedRuntimeRules.versions[0]!.active, false);
  assert.notEqual(setup.calls.filter(call => call.route === "/replay/create")[2]!.body.idempotencyKey, createCalls[1]!.body.idempotencyKey);
  assert.ok(!setup.calls.some(call => /global|\.agent-memory|install/.test(call.route)));
});

test("unavailable model/storage and mismatched server version never produce a false completion", async () => {
  await mounted({ request: async () => { throw Error("studio_replay_local_model_unavailable"); } });
  await check(/^仅授权本次本地分析/); await click(/^执行选定分析$/); await waitFor(() => !!win.document.querySelector('[role=alert]'));
  assert.match(win.document.querySelector('[role=alert]')!.textContent!, /unavailable/); assert.equal(win.document.querySelector(".crfp-timeline"), null);
  await fill(/^已存分支ID/, "replay-unknown"); await click(/^加载分支对账$/); await waitFor(() => !win.document.querySelector('[aria-busy=true]'));
  assert.equal(win.document.body.textContent!.includes("已完成本次分析"), false);
});

test("selected transcript file imports through the real file control, and export is separately confirmed/hash-checked without installing Skill", async () => {
  const setup = await fixture(); await mounted({ request: async (...args) => {
    if (args[0] === "/feedback/identity") await delay(60);
    return setup.request(...args);
  } }); await click(/^载入当前版本$/);
  // A user cannot select a file while identity loading disables this fieldset.
  // Dispatch only after that prerequisite actually commits, not three turns.
  await waitFor(() => win.document.body.textContent!.includes("内容快照引用") && !win.document.querySelector('[aria-busy="true"]'));
  const imported = "1\n00:18:00,000 --> 00:18:30,000\n请解释个人贡献边界。\n", file = new win.File([imported], "interview-review.srt", { type: "text/plain" });
  const input = win.document.querySelector('input[type=file][accept^=".txt"]')!;
  assert.equal(input.closest("fieldset")?.hasAttribute("disabled"), false);
  await settle(() => { Object.defineProperty(input, "files", { configurable: true, value: [file] }); input.dispatchEvent(new win.Event("change", { bubbles: true })); });
  await waitFor(() => (field(/^复盘笔记/) as unknown as HTMLTextAreaElement).value === imported);
  assert.match(win.document.body.textContent!, /interview-review.srt/);
  await check(/^我确认笔记/); await check(/^授权保存本次所选事件/); await click(/^保存并分析反馈$/); await waitFor(() => !!win.document.querySelector(".crfp-patch"));
  await settle(() => (win.document.querySelector('.crfp-patch input[type=checkbox]') as unknown as HTMLInputElement).click());
  await choose(/^规则目标/, "skill"); await click(/^预览1条规则建议$/); await waitFor(() => !!win.document.querySelector('[aria-label="个人规则补丁预览"]'));
  assert.equal(button(/^确认导出规则文件$/).disabled, true);
  assert.equal(setup.calls.some(call => call.route === "/rules/apply"), false, "preview alone does not adopt rules");
  await check(/^我已核对预览与当前版本/); await click(/^确认采用规则补丁$/); await waitFor(() => win.document.body.textContent!.includes("已确认个人运行时侧写v1"));
  const downloaded: Array<{ href: string; filename: string }> = [], originalClick = win.HTMLAnchorElement.prototype.click;
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
  try {
    URL.createObjectURL = () => "blob:synthetic-reviewed-export"; URL.revokeObjectURL = () => {};
    win.HTMLAnchorElement.prototype.click = function () { downloaded.push({ href: this.href, filename: this.download }); };
    await check(/^我已检查将导出的当前规则文本/); await click(/^确认导出规则文件$/); await waitFor(() => downloaded.length === 1);
    assert.equal(downloaded[0]!.filename, "betterme-career-SKILL.patch.md");
    assert.equal(setup.calls.filter(call => call.route === "/rules/export").length, 1);
    assert.equal(setup.calls.filter(call => call.route === "/rules/apply").length, 1, "export does not create a second automatic rule write");
    assert.match(win.document.body.textContent!, /没有安装或覆盖任何全局Skill/);
  } finally { URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; win.HTMLAnchorElement.prototype.click = originalClick; }
});

test("transcript import preserves exact timed text, handles SRT/VTT, rejects bad times and does not fabricate untimed minutes", () => {
  const plain = parseFeedbackTranscript("普通复盘笔记，没有时间戳。"); assert.equal(plain.timed, false); assert.equal(plain.segments[0]!.startMs, 0);
  const inline = parseFeedbackTranscript("[18:00-18:30] 请解释并发边界。"); assert.equal(inline.segments[0]!.startMs, 1080000); assert.equal(inline.segments[0]!.text, "请解释并发边界。");
  const srt = parseFeedbackTranscript("1\n00:18:00,500 --> 00:18:30,250\n请解释并发边界。\n\n2\n00:19:00,000 --> 00:19:10,000\n请说明证据。\n");
  assert.equal(srt.segments.length, 2); assert.equal(srt.segments[0]!.startMs, 1080500); assert.equal(srt.segments[1]!.text, "请说明证据。");
  const vtt = parseFeedbackTranscript("WEBVTT\n\n00:18:00.500 --> 00:18:30.250\n第一行\n第二行\n"); assert.equal(vtt.segments[0]!.text, "第一行\n第二行");
  assert.throws(() => parseFeedbackTranscript("[18:99-19:00] 时间无效。"), /小于60/);
  assert.throws(() => parseFeedbackTranscript("[19:00-18:00] 起止倒置。"), /起止顺序/);
  assert.throws(() => parseFeedbackTranscript("x".repeat(64001)), /过大/);
});

test("component styles stay scoped, responsive and keyboard/reduced-motion safe", () => {
  const css = readFileSync(new URL("../src/components/CareerReplayFeedbackPanel.css", import.meta.url), "utf8"), sheet = new win.CSSStyleSheet(); sheet.replaceSync(css);
  assert.ok(sheet.cssRules.length > 20); assert.match(css, /max-width:480px/); assert.match(css, /focus-visible/); assert.match(css, /prefers-reduced-motion/); assert.match(css, /forced-colors/);
  assert.doesNotMatch(css, /transition:\s*all|animation:|!important|\.resume-sheet|\.resume-paper/);
});
