import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { registerHooks } from "node:module";
import { Window, type HTMLButtonElement, type HTMLTextAreaElement, type HTMLSelectElement, type HTMLOptionElement, type HTMLInputElement, type HTMLElement, type HTMLDialogElement } from "happy-dom";
import { readFileSync } from "node:fs";
import { createMemoryAgentRepository } from "../src/lib/betterme-agent/storage";
import type { WritingReply, WritingSource } from "../src/lib/resume-copilot";
import { defaultUnderstandingClient, type UnderstandingClient } from "../src/services/understanding-client";
registerHooks({ load(url, context, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context); } });
const dom = new Window({ url: "http://sidebar-fixture.invalid" });
const React = await import("react");
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, Event: dom.Event, CustomEvent: dom.CustomEvent,
  ResizeObserver: dom.ResizeObserver, MutationObserver: dom.MutationObserver,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), React, IS_REACT_ACT_ENVIRONMENT: true,
  fetch: async () => Response.json({ runtimes: [], data: [{ id: "fixture" }] }),
})) { originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); }
const { createRoot } = await import("react-dom/client");
const { act } = React;
const { AgentSidebarProvider } = await import("../src/components/AgentSidebar");
const { ResumeWritingCopilot } = await import("../src/components/ResumeWritingCopilot");
const { AgentCompanion } = await import("../src/components/AgentCompanion");
const { BetterMeAgentCenter, AgentContinuityButton } = await import("../src/components/BetterMeAgentCenter");
const { BetterMeAgentProvider } = await import("../src/lib/betterme-agent/react");
const { UiPreferencesProvider } = await import("../src/lib/ui-preferences");
const { AgentTopBarStatus } = await import("../src/components/AgentTopBarStatus");
const source: WritingSource = { targetRef: { kind: "claim_text", experienceId: "fictional", claimId: "claim", locale: "zh" }, text: "参与接口开发，负责项目维护。", label: "隔离经历" };
const config = { provider: "ollama" as const, baseUrl: "http://fixture.invalid/v1", model: "fixture", apiKey: "", temperature: 0 };
let root: ReturnType<typeof createRoot> | undefined;
let active = true;
let repository = createMemoryAgentRepository();
let resolveWriting: (reply: WritingReply) => void;
let resolveChat: () => void;
let writingSignal: AbortSignal | undefined, chatSignal: AbortSignal | undefined;
let writingMemory: string | undefined, chatInput: string | undefined;
async function render(understandingClient?: UnderstandingClient) {
  if (!root) { const element = dom.document.createElement("div"); dom.document.body.append(element); root = createRoot(element as unknown as Element); }
  await act(async () => root!.render(<UiPreferencesProvider><BetterMeAgentProvider workspaceKey="isolated-sidebar" repository={repository}><AgentSidebarProvider understandingClient={understandingClient}>
    <div hidden={!active} id="resume-page"><ResumeWritingCopilot sessionKey="sidebar" active={active} sources={[source]} config={config} onFocus={() => {}} onApply={async () => ({ ok: true, message: "isolated" })}
      generate={async (_config, _source, _answer, signal, _fetch, _context, shared) => { writingSignal = signal; writingMemory = shared; return new Promise(resolve => { resolveWriting = resolve; }); }}><div className="fixture-paper">纸张</div></ResumeWritingCopilot></div>
    <AgentTopBarStatus config={null} active={false} onNavigateToAgent={() => assert.fail("must open the single sidebar")} onOpenAiConfig={() => assert.fail("must not open a separate modal")} />
    <AgentContinuityButton /><BetterMeAgentCenter onNavigate={() => {}} />
    <AgentCompanion llmConfig={config} onOpenWorkspace={() => {}} onOpenAiConfig={() => {}} sendChat={async input => {
      chatSignal = input.signal; chatInput = JSON.stringify(input.messages); await new Promise<void>(resolve => { resolveChat = resolve; });
      return { id: crypto.randomUUID(), role: "assistant", content: "同一侧栏的完整回复", createdAt: new Date().toISOString() };
    }} />
  </AgentSidebarProvider></BetterMeAgentProvider></UiPreferencesProvider>));
}
async function click(text: string) {
  const button = [...dom.document.querySelectorAll("button")].find(item => item.textContent?.trim() === text || item.getAttribute("aria-label") === text);
  assert.ok(button, text); await act(async () => button.click());
}
async function fill(selector: string, value: string) {
  await act(async () => { const field = dom.document.querySelector(selector); assert.ok(field, selector); Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!.call(field, value); field.dispatchEvent(new dom.Event("input", { bubbles: true })); });
}
afterEach(async () => { await act(async () => { root?.unmount(); root = undefined; }); dom.document.body.replaceChildren(); dom.localStorage.clear(); repository = createMemoryAgentRepository(); active = true; writingSignal = undefined; chatSignal = undefined; });
after(() => { dom.happyDOM.abort(); for (const [key, value] of originals) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } });

test("one sidebar owns writing, memory and tools; preview never contains the conversation", async () => {
  dom.localStorage.setItem("autosave-sentinel", "disabled");
  await render(); await click("检查当前简历");
  assert.equal(dom.document.querySelectorAll(".agent-sidebar").length, 1);
  assert.equal(dom.document.querySelectorAll('[role="dialog"]').length, 0);
  assert.equal(dom.document.querySelector(".writing-shell .writing-agent-pane"), null);
  assert.ok(dom.document.querySelector(".agent-sidebar .writing-agent-pane"));
  assert.equal(dom.document.querySelectorAll(".writing-document .fixture-paper").length, 1);
  assert.equal(dom.document.querySelector(".writing-shell.has-agent-pane"), null);
  await click("模型与工具");
  assert.ok(dom.document.querySelector(".agent-sidebar-settings .agent-companion-tools"));
  assert.ok(dom.document.querySelector(".agent-sidebar-settings .writing-settings"));
  const companion = dom.document.querySelector(".agent-companion-chat");
  await click("共识与进度"); await click("持续成长"); await fill(".betterme-agent-center textarea", "尚未提交的个人目标");
  await click("收起 BetterMe Agent"); await click("打开 BetterMe Agent"); await click("共识与进度");
  assert.equal(dom.document.querySelector<HTMLTextAreaElement>(".betterme-agent-center textarea")?.value, "尚未提交的个人目标");
  assert.ok(dom.document.querySelector(".agent-companion-chat") === companion);
  assert.equal(dom.localStorage.getItem("autosave-sentinel"), "disabled");
  assert.equal(dom.document.querySelector<HTMLSelectElement>('[aria-label="统一 Agent 来源"]')?.value, "current");
  assert.equal(await repository.load("isolated-sidebar"), undefined, "layout changes do not create or modify Agent settings");
});

test("writing and free-chat consent have distinct scopes and concurrent requests never borrow each other's grant", async () => {
  await render(); await click("检查当前简历"); await click("共识与进度"); await click("持续成长");
  await fill(".betterme-agent-center textarea", "仅合成目标：隔离授权哨兵"); await click("确认目标（不替换已有计划）");
  await click("模型与工具");
  const consent = (scope: string) => [...dom.document.querySelectorAll<HTMLInputElement>('.betterme-agent-consent input')].find(input => input.parentElement?.textContent?.includes(scope));
  const writing = consent("仅简历伴写"), companion = consent("仅自由对话");
  assert.ok(writing, "writing memory grant names its own entry point");
  assert.ok(companion, "free chat memory grant names a different entry point");
  assert.equal(writing.checked, false); assert.equal(companion.checked, false);
  await act(async () => writing.click()); assert.equal(companion.checked, false);
  await click("伴写对话"); await click("一起完善这条经历"); await click("请 Agent 进一步追问");
  assert.match(writingMemory ?? "", /隔离授权哨兵/);
  await click("自由对话"); await fill('[aria-label="发送给 Agent"]', "合成问题：不使用其他入口的授权"); await click("发送消息");
  assert.doesNotMatch(chatInput ?? "", /隔离授权哨兵/);
  assert.equal(writingSignal?.aborted, false, "switching to a second conversation keeps the first task alive");
  await act(async () => { resolveWriting({ questions: ["合成追问"], rationale: "隔离测试", evidenceQuotes: [] }); resolveChat(); });
  await click("模型与工具"); await act(async () => { writing.click(); companion.click(); });
  assert.equal(writing.checked, false); assert.equal(companion.checked, true);
  await click("伴写对话"); await click("自由对话"); await fill('[aria-label="发送给 Agent"]', "合成问题：这一次明确共享"); await click("发送消息");
  assert.match(chatInput ?? "", /隔离授权哨兵/);
  await act(async () => resolveChat());
  assert.equal((await repository.load("isolated-sidebar"))?.tasks.filter(task => task.status === "completed").length, 3);
});

test("writing feedback and candidate comparison scroll independently of its input and send controls", async () => {
  await render(); await click("检查当前简历"); await click("一起完善这条经历");
  const composer = dom.document.querySelector('[role="region"][aria-label="伴写输入"]');
  const discussion = dom.document.querySelector('[role="region"][aria-label="伴写建议与修改对照"]');
  assert.ok(composer); assert.ok(discussion);
  const input = dom.document.querySelector("#writing-answer"); assert.ok(input);
  assert.ok(composer.contains(input));
  assert.equal(discussion.contains(input), false);
  assert.ok([...composer.querySelectorAll("button")].some(button => button.textContent?.includes("请 Agent 进一步追问")));
});

test("running writing preserves exact DOM draft through route, tab, hide and completion", async () => {
  await render(); await click("检查当前简历"); await click("一起完善这条经历");
  await fill("#writing-answer", "本人编写了接口重试校验");
  const answer = dom.document.querySelector("#writing-answer");
  await act(async () => [...dom.document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(item => item.parentElement?.textContent?.includes("我确认这段补充"))!.click());
  await click("请 Agent 整理候选表达");
  await click("模型与工具"); await click("共识与进度"); active = false; await render(); await click("收起 BetterMe Agent");
  assert.equal(writingSignal?.aborted, false); assert.ok(dom.document.querySelector("#writing-answer") === answer);
  await act(async () => resolveWriting({ questions: ["如何验证接口重试？"], rationale: "隔离返回", evidenceQuotes: [] }));
  assert.equal(dom.document.querySelector<HTMLElement>(".agent-sidebar")?.hidden, true);
  assert.equal((await repository.load("isolated-sidebar"))?.tasks.at(-1)?.status, "completed");
  active = true; await render(); await click("打开 BetterMe Agent"); await click("当前经历");
  assert.equal(dom.document.querySelector<HTMLTextAreaElement>("#writing-answer")?.value, "本人编写了接口重试校验");
  assert.match(dom.document.querySelector(".writing-note")?.textContent ?? "", /如何验证接口重试/);
});

test("companion draft and request survive all sidebar surfaces without a second console", async () => {
  await render(); await click("打开 BetterMe Agent"); await click("自由对话");
  const composer = dom.document.querySelector(".agent-companion-chat-compose textarea");
  await fill(".agent-companion-chat-compose textarea", "未发送的上下文问题");
  await click("模型与工具"); await click("伴写对话"); await click("当前经历"); await click("自由对话");
  assert.ok(dom.document.querySelector(".agent-companion-chat-compose textarea") === composer);
  assert.equal(dom.document.querySelector<HTMLTextAreaElement>(".agent-companion-chat-compose textarea")?.value, "未发送的上下文问题");
  await click("发送消息"); await click("共识与进度"); await click("收起 BetterMe Agent"); active = false; await render();
  assert.equal(chatSignal?.aborted, false);
  await act(async () => resolveChat());
  assert.equal(dom.document.querySelector<HTMLElement>(".agent-sidebar")?.hidden, true);
  await click("打开 BetterMe Agent");
  assert.match(dom.document.querySelector(".agent-companion-chat")?.textContent ?? "", /同一侧栏的完整回复/);
  assert.equal((await repository.load("isolated-sidebar"))?.tasks.at(-1)?.status, "completed");
});

test("sidebar tabs support arrow navigation and closing returns focus to the opener", async () => {
  await render(); const opener = dom.document.querySelector<HTMLButtonElement>(".agent-sidebar-launcher")!;
  await act(async () => { opener.focus(); opener.click(); });
  const tabs = dom.document.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  await act(async () => tabs[0]!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  assert.equal(tabs[1]!.getAttribute("aria-selected"), "true");
  assert.ok(dom.document.activeElement === tabs[1]);
  await act(async () => tabs[1]!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(dom.document.querySelector<HTMLElement>(".agent-sidebar")?.hidden, true);
  assert.ok(dom.document.activeElement === opener);
});

test("contextual tutorial keeps writing drafts and stable portal nodes through every chapter", async () => {
  await render(); await click("检查当前简历"); await click("一起完善这条经历"); await fill("#writing-answer", "教程前的未发送草稿");
  const answer = dom.document.querySelector("#writing-answer");
  await click("Agent 协作教程");
  assert.equal(dom.document.querySelectorAll('.agent-workflow-guide').length, 1);
  assert.equal(dom.document.querySelector<HTMLDialogElement>('dialog.agent-workflow-guide')?.open, true);
  assert.equal(dom.document.querySelector<HTMLElement>('.agent-sidebar-work')?.hidden, false, "real controls stay visible behind the spotlight");
  for (let index = 0; index < 7; index++) await click("下一步");
  assert.match(dom.document.querySelector('.agent-workflow-guide')?.textContent ?? "", /没响应时，不猜测进度/);
  await click("完成引导，返回工作");
  assert.ok(dom.document.querySelector("#writing-answer") === answer);
  assert.equal(dom.document.querySelector<HTMLTextAreaElement>("#writing-answer")?.value, "教程前的未发送草稿");
  assert.equal(await repository.load("isolated-sidebar"), undefined);
});

test("tutorial resumes its last chapter, restores focus and locates without sending requests", async () => {
  await render(); await click("打开 BetterMe Agent");
  const help = dom.document.querySelector<HTMLButtonElement>('[aria-label="Agent 协作教程"]')!;
  await act(async () => help.focus()); await click("Agent 协作教程");
  await click("第 6 节：收起继续，重载先核对"); await click("返回工作"); assert.ok(dom.document.activeElement === help);
  await click("Agent 协作教程"); assert.match(dom.document.querySelector("h2#agent-tutorial-title")?.textContent ?? "", /收起继续/);
  assert.equal(dom.document.querySelector('[role="tab"][aria-selected=true]')?.textContent, "共识与进度", "resuming prepares the real lesson surface without executing it");
  await click("找到备份与历史");
  assert.equal(dom.document.querySelector('[role="tab"][aria-selected=true]')?.textContent, "共识与进度");
  assert.equal(dom.document.activeElement?.className, "agent-guide-coach");
  await click("伴写对话"); assert.match(dom.document.querySelector(".agent-guide-coach")?.textContent ?? "", /你已切换视图/);
  await click("回到本节入口"); await click("返回本节教程");
  assert.match(dom.document.querySelector("h2#agent-tutorial-title")?.textContent ?? "", /收起继续/);
  assert.equal(await repository.load("isolated-sidebar"), undefined, "teaching and locating do not create actual Agent tasks");
});

test("an active writing task completes behind a tutorial without losing the exact draft", async () => {
  await render(); await click("检查当前简历"); await click("一起完善这条经历"); await fill("#writing-answer", "运行中仍保留的草稿");
  const answer = dom.document.querySelector("#writing-answer");
  await act(async () => [...dom.document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(item => item.parentElement?.textContent?.includes("我确认这段补充"))!.click());
  await click("请 Agent 整理候选表达"); await click("Agent 协作教程"); await click("下一步");
  assert.equal(writingSignal?.aborted, false); active = false; await render(); await click("收起 BetterMe Agent");
  await act(async () => resolveWriting({ questions: ["测试已完成，继续核对"], rationale: "隔离返回", evidenceQuotes: [] }));
  assert.ok(dom.document.querySelector("#writing-answer") === answer);
  assert.equal(dom.document.querySelector<HTMLTextAreaElement>("#writing-answer")?.value, "运行中仍保留的草稿");
  assert.equal((await repository.load("isolated-sidebar"))?.tasks.at(-1)?.status, "completed");
});

test("real-control spotlight follows the visible target, hides across tabs and never executes it", async () => {
  await render(); await click("打开 BetterMe Agent");
  const target = dom.document.querySelector<HTMLElement>('[data-agent-guide="agent-backup"]')!;
  Object.defineProperty(target, "getClientRects", { configurable: true, value: () => [new dom.DOMRect(100, 200, 250, 30)] });
  Object.defineProperty(target, "getBoundingClientRect", { configurable: true, value: () => new dom.DOMRect(100, 200, 250, 30) });
  await click("Agent 协作教程"); await click("第 6 节：收起继续，重载先核对"); await click("找到备份与历史");
  const ring = dom.document.querySelector<HTMLElement>(".agent-guide-spotlight")!;
  assert.ok(ring); assert.equal(ring.style.left, "96px"); assert.equal(ring.style.top, "196px");
  assert.equal(ring.style.width, "258px"); assert.equal(ring.getAttribute("aria-hidden"), "true");
  await click("重新定位入口"); assert.ok(dom.document.activeElement === target);
  const details = target.closest("details"); assert.ok(details instanceof dom.HTMLDetailsElement);
  assert.equal(details.open, false, "locating focuses, but does not open or execute a real control");
  await click("伴写对话"); assert.equal(dom.document.querySelector(".agent-guide-spotlight"), null);
  await click("结束本次定位"); assert.equal(dom.document.querySelector(".agent-guide-coach"), null);
  assert.equal(await repository.load("isolated-sidebar"), undefined);
});

test("selected and primary hover states pair foreground/background instead of transparent white text", () => {
  const css = readFileSync(new URL("../src/components/agent-sidebar.css", import.meta.url), "utf8");
  assert.match(css, /--color-soft:var\(--ui-canvas\)/);
  assert.match(css, /button\[aria-pressed=true\]:hover:not\(:disabled\)[^{]*\{background:var\(--ui-action\);color:var\(--ui-on-action\)/);
  assert.match(css, /hover:hover/);
});

test("reader choice is explicit, scoped and disabled during a task without changing its model", async () => {
  let checks = 0;
  const client: UnderstandingClient = { ...defaultUnderstandingClient, getCapabilities: async () => {
    checks++; return [{ id: "compatible-reader", name: "Compatible fixture", available: true, supported: true }, { id: "unsupported-reader", name: "Unsupported fixture", available: true, supported: false, reason: "No controlled protocol" }];
  } };
  await render(client);
  assert.equal(checks, 0, "hidden settings do not query or launch tools");
  await click("打开 BetterMe Agent"); await click("模型与工具");
  const select = dom.document.querySelector<HTMLSelectElement>('[aria-label="项目阅读运行方式"]')!;
  assert.equal(select.value, "model");
  assert.equal(select.querySelector<HTMLOptionElement>('option[value="unsupported-reader"]')?.disabled, true);
  await act(async () => { select.value = "compatible-reader"; select.dispatchEvent(new dom.Event("change", { bubbles: true })); });
  assert.equal(dom.localStorage.getItem("betterme.project-reader.v1:isolated-sidebar"), "compatible-reader");
  assert.equal(await repository.load("isolated-sidebar"), undefined, "selecting a reader does not execute or change the model");
  await click("检查当前简历"); await click("一起完善这条经历"); await fill("#writing-answer", "本人实现回执校验");
  await act(async () => [...dom.document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(item => item.parentElement?.textContent?.includes("我确认这段补充"))!.click());
  await click("请 Agent 整理候选表达"); await click("模型与工具");
  assert.equal(select.disabled, true); assert.equal(writingSignal?.aborted, false);
  assert.equal(dom.document.querySelector<HTMLSelectElement>('[aria-label="统一 Agent 来源"]')?.value, "current");
  await act(async () => resolveWriting({ questions: ["如何核对？"], rationale: "隔离返回", evidenceQuotes: [] }));
  assert.equal(select.disabled, false); assert.equal(select.value, "compatible-reader");
});

test("formal App installs the stable shell and its CSS never reserves a vertical conversation track", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /<AgentSidebarProvider><DesktopShell\b/);
  assert.match(app, /<DesktopShell[^\n]*><div className="studio-app compact-chrome">/);
  assert.equal((app.match(/<AgentSidebarProvider>/g) ?? []).length, 1);
  assert.match(app, /<\/DesktopShell>\s*<div className="no-print">\s*<NetworkSettingsModal/);
  const css = readFileSync(new URL("../src/components/agent-sidebar.css", import.meta.url), "utf8");
  assert.match(css, /\.writing-shell\.is-docked\{[^}]*grid-template-rows:auto minmax\(0,1fr\)/);
});
