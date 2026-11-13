import {widgetChat} from "./fixtures/widget-chat";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Window } from "happy-dom";
import { projectResume, type LlmConfig } from "@better-me/core";
import { createInitialDocument } from "@better-me/storage";

registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : nextLoad(url, context);
  },
});

const dom = new Window({ url: "http://agent-companion-output-fixture.invalid" });
// Keep real FileReader decoding, but gate its start so image assertions cannot
// accidentally depend on setImmediate winning a race with platform timers.
const pendingImageReads: Array<() => Promise<void>> = [];
class DeferredFileReader extends dom.FileReader {
  override readAsDataURL(blob: Parameters<InstanceType<typeof dom.FileReader>["readAsDataURL"]>[0]) {
    pendingImageReads.push(() => new Promise<void>((resolve) => {
      this.addEventListener("loadend", () => resolve(), { once: true });
      super.readAsDataURL(blob);
    }));
  }
}
let reduceMotionPreference = false;
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: () => ({ get matches() { return reduceMotionPreference; }, addEventListener() {}, removeEventListener() {} }),
});
const React = await import("react");
for (const [key, value] of Object.entries({
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  FileReader: DeferredFileReader,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { createElement: h, act } = React;
const { createRoot } = await import("react-dom/client");
const { UiPreferencesProvider } = await import("../src/lib/ui-preferences.tsx");
const { AgentCompanion } = await import("../src/components/AgentCompanion.tsx");
const originalFetch = globalThis.fetch;


async function flush(action: () => void = () => {}) {
  await act(async () => {
    action();
    await nextTurn();
    await nextTurn();
  });
}

async function flushImageRead(action: () => void) {
  await flush(action);
  await act(async () => {
    while (pendingImageReads.length) await pendingImageReads.shift()!();
  });
}
test.afterEach(() => dom.localStorage.clear());

test("four provider replies expose local-only read/stop controls; hide, page exit and remount never replay or lose the draft", async () => {
  const spoken: Array<{text:string;voice?:{localService:boolean};onstart?:()=>void;onend?:()=>void}> = [];
  let cancels=0,calls=0;
  const engine={getVoices:()=>[{lang:"zh-CN",localService:true},{lang:"en-US",localService:true},{lang:"zh-CN",localService:false}],
    speak:(utterance:typeof spoken[number])=>{spoken.push(utterance);utterance.onstart?.();},cancel:()=>{cancels++;}};
  Object.defineProperty(dom,"speechSynthesis",{configurable:true,value:engine});
  Object.defineProperty(dom,"SpeechSynthesisUtterance",{configurable:true,value:class {constructor(readonly text:string){}}});
  const messages=["DeepSeek","Ollama","OpenAI","Google"].map((provider,index)=>({id:`speech-${provider}`,role:"assistant",content:`${provider} 合成回复。 Keep your draft.`,
    meta:{provider:index===1?"ollama":index===3?"gemini":"openai-compatible",providerLabel:provider,model:"synthetic",source:"agent-host",status:"ready",completeness:"complete",observedAt:"2026-11-13T00:00:00Z"}}));
  dom.localStorage.setItem("betterme.recovery.v1:companion:synthetic-speech-unit",JSON.stringify({version:1,value:{messages:[...messages,{id:"speech-error",role:"assistant",content:"⚠️ 错误，不应朗读"}],draft:"  原草稿😀  ",references:[],attachments:[],prompt:"",pending:false}}));
  globalThis.fetch=async()=>Response.json({runtimes:[]});
  dom.document.body.innerHTML='<main id="fixture"></main>';
  let root=createRoot(dom.document.getElementById("fixture")!);
  const render=()=>root.render(h(UiPreferencesProvider,null,h(AgentCompanion,{workspaceKey:"synthetic-speech-unit",llmConfig:{provider:"ollama",model:"fixture",baseUrl:"http://127.0.0.1:1/v1"},onOpenWorkspace(){},onOpenAiConfig(){},sendChat:async()=>{calls++;throw Error("must not send");}})));
  const click=(label:string,index=0)=>flush(()=>dom.document.querySelectorAll<HTMLButtonElement>(`[aria-label="${label}"]`)[index]!.click());
  try {
    await flush(render);await click("打开 Agent 伴侣");assert.equal(spoken.length,0);
    assert.equal(dom.document.querySelectorAll('[aria-label="本机朗读"]').length,4,"error assistant is not a model reply");
    for(let index=0;index<4;index++){
      await click("本机朗读",index);assert.equal(spoken.at(-1)?.voice?.localService,true);await click("停止朗读");
      const count=spoken.length;await flush(()=>spoken.at(-1)?.onend?.());assert.equal(spoken.length,count,"late end after stop cannot enqueue");
    }
    await click("本机朗读");const beforeHide=cancels;await click("关闭 Agent 伴侣");assert.equal(cancels,beforeHide+1);
    const beforeOpen=spoken.length;await click("打开 Agent 伴侣");assert.equal(spoken.length,beforeOpen);
    await click("本机朗读");const beforeExit=cancels;await flush(()=>dom.dispatchEvent(new dom.Event("pagehide")));assert.equal(cancels,beforeExit+1);
    await flush(()=>root.unmount());root=createRoot(dom.document.getElementById("fixture")!);const beforeRemount=spoken.length;
    await flush(render);await click("打开 Agent 伴侣");assert.equal(spoken.length,beforeRemount);
    assert.ok([...dom.document.querySelectorAll("textarea")].some(field=>field.value==="  原草稿😀  "));assert.equal(calls,0);
    engine.getVoices=()=>[];await click("本机朗读");assert.match(dom.document.body.textContent??"",/本机音色尚未就绪/);assert.equal(spoken.length,beforeRemount);
  } finally {
    await flush(()=>root.unmount());globalThis.fetch=originalFetch;
    Reflect.deleteProperty(dom,"speechSynthesis");Reflect.deleteProperty(dom,"SpeechSynthesisUtterance");
  }
});

test("companion restores all saved turns and the unfinished question after remount without sending", async () => {
  const llmConfig: LlmConfig = { provider: "ollama", baseUrl: "https://synthetic.invalid", apiKey: "", model: "fixture" };
  const messages = Array.from({ length: 30 }, (_, index) => ({ id: `synthetic-${index}`, role: index % 2 ? "assistant" : "user", content: `保留的第${index}轮` }));
  dom.localStorage.setItem("betterme.recovery.v1:companion:synthetic-reopen", JSON.stringify({ version: 1,
    value: { messages, draft: "尚未发送的伴侣草稿", references: [], attachments: [], prompt: "", pending: true } }));
  let calls = 0; let received: string[] = [];
  globalThis.fetch = async () => Response.json({ runtimes: [] });
  dom.document.body.innerHTML = '<main id="fixture"></main>';
  const root = createRoot(dom.document.getElementById("fixture")!);
  const render = () => root.render(h(UiPreferencesProvider, null, h(AgentCompanion, {...{sendChat:widgetChat},
    workspaceKey: "synthetic-reopen", llmConfig, onOpenAiConfig() {}, onOpenWorkspace() {},
    sendChat: async ({ messages }) => { calls++; received = messages.map(message => message.content); return { id: "full-history-reply", role: "assistant", content: "完整历史已收到" }; },
  })));
  try {
    await flush(render);
    await flush(() => dom.document.querySelector<HTMLButtonElement>('[aria-label="打开 Agent 伴侣"]')!.click());
    assert.match(dom.document.body.textContent ?? "", /保留的第0轮/);
    assert.match(dom.document.body.textContent ?? "", /保留的第29轮/);
    assert.match(dom.document.body.textContent ?? "", /上次请求已中断/);
    assert.ok([...dom.document.querySelectorAll("textarea")].some(field => field.value === "尚未发送的伴侣草稿"));
    assert.equal(calls, 0);
    await flush(() => dom.document.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click());
    assert.equal(calls, 1);
    assert.equal(received.length, 31);
    assert.deepEqual(received.slice(0, 30), messages.map(message => message.content));
    assert.equal(received[30], "尚未发送的伴侣草稿");
  } finally { await flush(() => root.unmount()); globalThis.fetch = originalFetch; }
});

test("the single text task is secondary, explicitly authorized and has no independent runtime selector", async () => {
  let posts=0;
  globalThis.fetch=async(_input,init)=>{if(init?.method==="POST")posts++;return Response.json({runtimes:[{id:"codex",name:"Codex",status:"available",capabilities:["text"]}]});};
  dom.document.body.innerHTML='<main id="fixture"></main>';
  const root=createRoot(dom.document.getElementById("fixture")!);
  try{
    await flush(()=>root.render(h(UiPreferencesProvider,null,h(AgentCompanion,{sendChat:widgetChat,llmConfig:{provider:"ollama",baseUrl:"http://127.0.0.1:1/v1",model:"fixture"},onOpenWorkspace(){},onOpenAiConfig(){}}))));
    await flush(()=>dom.document.querySelector<HTMLButtonElement>('[aria-label="打开 Agent 伴侣"]')!.click());
    const tools=dom.document.querySelector<HTMLButtonElement>('[data-testid="agent-companion-tools-toggle"]')!;
    assert.equal(tools.getAttribute("aria-expanded"),"false");await flush(()=>tools.click());
    const toggle=dom.document.querySelector<HTMLButtonElement>('[data-testid="agent-companion-quick-run-toggle"]')!,content=dom.document.getElementById("agent-companion-quick-run-content")!;
    assert.equal(toggle.getAttribute("aria-expanded"),"false");assert.equal(content.hidden,true);await flush(()=>toggle.click());assert.equal(content.hidden,false);
    assert.match(content.textContent??"",/共用底座和工作区总额度/);assert.match(content.textContent??"",/不自动附加对话、简历或文件/);
    assert.equal(dom.document.querySelector("button.agent-runtime-tile"),null,"capability discovery must not silently replace the shared runtime");
    const field=content.querySelector<HTMLTextAreaElement>("textarea")!;
    await flush(()=>{Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype,"value")!.set!.call(field,"  完整任务提示😀  ");field.dispatchEvent(new dom.Event("input",{bubbles:true}));});
    assert.equal(field.value,"  完整任务提示😀  ");assert.equal(content.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked,false);
    assert.ok([...content.querySelectorAll<HTMLButtonElement>("button")].find(item=>item.textContent?.includes("开始运行"))!.disabled);assert.equal(posts,0);
    // Full authoritative answer / copy / remount are exercised against actual
    // authenticated HTTP and production defaults in one-off-task-http.test.tsx.
  }finally{await flush(()=>root.unmount());globalThis.fetch=originalFetch;}
});

test("a resume quote opens the companion and is sent as an in-panel model chat", async () => {
  let chatBody: Record<string, unknown> | undefined;
  let resolveChatResponse: ((response: Response) => void) | undefined;
  let workspaceOpenCount = 0;
  let referenceConsumedCount = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/v1/agent/runtimes")) {
      return Response.json({ runtimes: [{ id: "codex", name: "Codex", status: "available", version: "fixture", capabilities: ["text"] }] });
    }
    if (url.endsWith("/ui-chat-fixture") && init?.method === "POST") {
      chatBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return await new Promise<Response>((resolve) => { resolveChatResponse = resolve; });
    }
    return Response.json({ success: true, message: "ready" });
  }) as typeof fetch;

  dom.document.body.innerHTML = '<main id="fixture"></main>';
  const root = createRoot(dom.document.getElementById("fixture")!);
  const llmConfig: LlmConfig = {
    provider: "openai-compatible",
    baseUrl: "https://api.example.invalid/v1",
    apiKey: "fixture-key",
    model: "fixture-model",
    temperature: 0.3,
  };
  const reference = { type: "resume_text" as const, sourceLabel: "工作经历 · 项目成果", text: "将接口 P99 延迟降低 60%。" };
  try {
    await flush(() => root.render(
      h(UiPreferencesProvider, { initialPreferences: { locale: "zh", theme: "light" } },
        h(AgentCompanion, {...{sendChat:widgetChat},
          onOpenWorkspace: () => { workspaceOpenCount += 1; },
          llmConfig,
          onOpenAiConfig: () => {},
          initialReference: reference,
          onReferenceConsumed: () => { referenceConsumedCount += 1; },
        }),
      ),
    ));

    const dialog = dom.document.querySelector<HTMLElement>('[role="dialog"][aria-label="Agent 运行控制台"]');
    assert.ok(dialog, "receiving a resume quote should open the Agent Companion");
    assert.match(dialog.textContent ?? "", /工作经历 · 项目成果/);
    assert.equal(referenceConsumedCount, 1);
    assert.equal(workspaceOpenCount, 0, "the quote action should not route to the full Agent workspace");
    const toolsToggle = dom.document.querySelector<HTMLButtonElement>('[data-testid="agent-companion-tools-toggle"]');
    const toolsContent = dom.document.getElementById("agent-companion-tools-content");
    assert.ok(toolsToggle && toolsContent);
    assert.equal(toolsToggle.getAttribute("aria-expanded"), "false");
    assert.equal(toolsContent.hidden, true, "secondary local tools should start collapsed");
    await flush(() => toolsToggle.click());
    assert.equal(toolsContent.hidden, false, "local tools should expand on demand");
    await flush(() => toolsToggle.click());
    const providerToggle = dom.document.querySelector<HTMLButtonElement>('[aria-controls="agent-provider-details"]');
    const providerDetails = dom.document.getElementById("agent-provider-details");
    assert.ok(providerToggle && providerDetails);
    await flush(() => providerToggle.click());
    assert.equal(providerDetails.hidden, false, "connection actions should remain available in provider details");

    const textarea = dom.document.querySelector<HTMLTextAreaElement>('textarea[aria-label="发送给 Agent"]');
    assert.ok(textarea, "the companion should provide a local chat composer for the quote");
    await flush(() => {
      Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "这项成果如何说得更可信？");
      textarea.dispatchEvent(new dom.Event("input", { bubbles: true }));
    });
    const sendButton = [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label") === "发送消息");
    assert.ok(sendButton);
    await flush(() => sendButton.click());
    assert.ok(dom.document.querySelector('[role="status"].agent-companion-chat-loading'), "waiting for the model should be explicit and accessible");
    assert.ok(dom.document.querySelector('[aria-label="停止生成并编辑问题"]'), "the running chat must offer a stop action");
    assert.equal(dom.document.querySelector('[aria-label="发送消息"]'), null, "the composer should not submit duplicate messages while waiting");
    assert.ok(resolveChatResponse);
    resolveChatResponse(Response.json({ reply: { id: "reply_fixture", role: "assistant", content: "已在 Agent 伴侣中完成引用回复。这段较长的附加内容用于确认打字机动画有足够时间展示，并且用户可以随时跳过动画查看完整格式化回复。" } }));

    for (let attempt = 0; attempt < 10 && !dom.document.body.textContent?.includes("已在 Agent 伴侣中完成引用回复"); attempt += 1) {
      await flush();
    }
    const messages = chatBody?.messages as Array<Record<string, unknown>> | undefined;
    const userMessage = messages?.at(-1);
    assert.equal(userMessage?.content, "这项成果如何说得更可信？");
    assert.deepEqual(userMessage?.references, [reference]);
    const typewriter = dom.document.querySelector<HTMLElement>('[data-testid="agent-companion-typewriter"]');
    assert.ok(typewriter, "a new model reply should reveal progressively with a typewriter effect");
    const skipButton = typewriter.querySelector<HTMLButtonElement>("button");
    assert.ok(skipButton, "the user can skip the reply animation");
    await flush(() => skipButton.click());
    assert.equal(dom.document.querySelector('[data-testid="agent-companion-typewriter"]'), null);
    assert.match(dom.document.body.textContent ?? "", /已在 Agent 伴侣中完成引用回复/);

    await flush(() => {
      Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "再问一个问题");
      textarea.dispatchEvent(new dom.Event("input", { bubbles: true }));
    });
    await flush(() => dom.document.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')?.click());
    assert.ok(resolveChatResponse);
    reduceMotionPreference = true;
    resolveChatResponse(Response.json({ reply: {
      id: "reply_reduced_motion",
      role: "assistant",
      content: "## 直接完整显示\n\n这里是 **完整 Markdown**，不会逐字播放。",
    } }));
    for (let attempt = 0; attempt < 10 && !dom.document.body.textContent?.includes("直接完整显示"); attempt += 1) {
      await flush();
    }
    assert.equal(dom.document.querySelector('[data-testid="agent-companion-typewriter"]'), null, "reduced motion should bypass the typewriter");
    assert.equal(dom.document.querySelector(".agent-companion-chat-skip-typing"), null, "reduced motion should not offer a skip control for an animation that is not running");
    assert.ok(dom.document.querySelector(".agent-companion-chat-message.is-assistant .agent-markdown-content"), "the complete answer should render as Markdown when reduced motion is enabled");
    const emphasizedText = dom.document.querySelector<HTMLElement>(".agent-companion-chat-message.is-assistant .agent-markdown-content strong");
    assert.ok(emphasizedText, "Markdown bold should remain semantic emphasis");
    assert.match(emphasizedText.className, /font-semibold/);
    assert.doesNotMatch(emphasizedText.className, /border|inline-block|bg-/i, "inline bold terms should not become outlined badge chips");
    assert.match(dom.document.body.textContent ?? "", /完整 Markdown/);
    assert.equal(workspaceOpenCount, 0);
  } finally {
    await flush(() => root.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("a stopped chat restores its prompt and quote, and guided prompts stay editable before sending", async () => {
  const requests: Array<{ body: { messages: Array<{ role: string; content: string }> }; signal?: AbortSignal }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/v1/agent/runtimes")) return Response.json({ runtimes: [] });
    if (url.endsWith("/ui-chat-fixture")) {
      requests.push({ body: JSON.parse(String(init?.body)), signal: init?.signal ?? undefined });
      if (requests.length > 1) return Response.json({ reply: { id: "guided-answer", role: "assistant", content: "先确认目标岗位，再逐步拆解。" } });
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
    }
    return Response.json({ success: true });
  }) as typeof fetch;
  dom.document.body.innerHTML = '<main id="fixture"></main>';
  const root = createRoot(dom.document.getElementById("fixture")!);
  try {
    await flush(() => root.render(h(UiPreferencesProvider, { initialPreferences: { locale: "zh", theme: "light" } }, h(AgentCompanion, {...{sendChat:widgetChat},
      onOpenWorkspace: () => {}, onOpenAiConfig: () => {},
      llmConfig: { provider: "ollama", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "", model: "fixture", temperature: 0.3 },
      initialReference: { type: "resume_text", sourceLabel: "工作经历", text: "只读的简历引用" },
    }))));
    const composer = dom.document.querySelector<HTMLTextAreaElement>('textarea[aria-label="发送给 Agent"]')!;
    await flush(() => {
      Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!.call(composer, "请分析这一段");
      composer.dispatchEvent(new dom.Event("input", { bubbles: true }));
    });
    await flush(() => dom.document.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')?.click());
    assert.equal(requests.length, 1);
    const stop = dom.document.querySelector<HTMLButtonElement>('[aria-label="停止生成并编辑问题"]');
    assert.ok(stop, "the running chat needs a stop action beside the composer");
    await flush(() => stop.click());
    assert.equal(requests[0]?.signal?.aborted, true);
    assert.equal(composer.value, "请分析这一段");
    assert.match(dom.document.querySelector(".agent-companion-chat-pending-reference")?.textContent ?? "", /只读的简历引用/);
    assert.equal(dom.document.querySelectorAll(".agent-companion-chat-message.is-user").length, 0, "a cancelled question is a draft, not a completed turn");
    assert.equal(dom.document.querySelectorAll(".agent-companion-chat-message.is-assistant").length, 0);
    const guide = dom.document.querySelector<HTMLButtonElement>('[data-testid="agent-guide-plan"]');
    assert.ok(guide, "guided conversation should offer an editable next step");
    await flush(() => guide.click());
    assert.match(composer.value, /规划/);
    assert.equal(requests.length, 1, "choosing a guide must not send a private request on its own");
    await flush(() => dom.document.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')?.click());
    assert.equal(requests.length, 2);
    assert.equal(requests[1]?.body.messages.length, 1, "the stopped question must not be replayed as a prior chat turn");
  } finally {
    await flush(() => root.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("Companion sends no resume context by default and shares only the sanitized summary after consent", async () => {
  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/v1/agent/runtimes")) {
      return Response.json({ runtimes: [{ id: "codex", name: "Codex", status: "available", version: "fixture", capabilities: ["text"] }] });
    }
    if (url.endsWith("/ui-chat-fixture") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      requests.push(body);
      return Response.json({ reply: { id: `reply_${requests.length}`, role: "assistant", content: "收到。" } });
    }
    return Response.json({ success: true, message: "ready" });
  }) as typeof fetch;

  const document = createInitialDocument("2026-10-27T12:00:00.000Z");
  document.factBase.profile.displayName = { zh: "绝不可发送的姓名", en: "Private Name" };
  document.factBase.profile.email = "private@example.com";
  document.factBase.profile.phone = "+1-555-0100";
  document.factBase.profile.avatarUrl = "data:image/png;base64,private";
  const resume = projectResume(document.factBase, document.resumeViews[0]!);
  dom.document.body.innerHTML = '<main id="fixture"></main>';
  const root = createRoot(dom.document.getElementById("fixture")!);
  const llmConfig: LlmConfig = {
    provider: "openai-compatible",
    baseUrl: "https://api.example.invalid/v1",
    apiKey: "fixture-key",
    model: "fixture-model",
    temperature: 0.3,
  };

  async function send(text: string) {
    const textarea = dom.document.querySelector<HTMLTextAreaElement>('textarea[aria-label="发送给 Agent"]');
    assert.ok(textarea);
    await flush(() => {
      Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text);
      textarea.dispatchEvent(new dom.Event("input", { bubbles: true }));
    });
    const sendButton = dom.document.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]');
    assert.ok(sendButton);
    await flush(() => sendButton.click());
    for (let attempt = 0; attempt < 10 && requests.length < (text === "普通问题" ? 1 : text === "授权后问题" ? 2 : 3); attempt += 1) await flush();
  }

  try {
    await flush(() => root.render(
      h(UiPreferencesProvider, { initialPreferences: { locale: "zh", theme: "light" } },
        h(AgentCompanion, {...{sendChat:widgetChat}, onOpenWorkspace: () => {}, llmConfig, onOpenAiConfig: () => {}, resume }),
      ),
    ));
    await flush(() => dom.document.querySelector<HTMLButtonElement>('[aria-label="打开 Agent 伴侣"]')?.click());

    const consent = dom.document.querySelector<HTMLButtonElement>('[aria-label="允许 Agent 读取简历字段"]');
    assert.ok(consent);
    assert.equal(consent.getAttribute("aria-pressed"), "false");
    await send("普通问题");
    assert.equal(requests[0]?.context, undefined, "ordinary chat sends no resume fields without consent");

    await flush(() => consent.click());
    assert.equal(dom.document.querySelector<HTMLButtonElement>('[aria-label="已授权 Agent 读取简历字段"]')?.getAttribute("aria-pressed"), "true");
    await send("授权后问题");
    const shared = requests[1]?.context as { resumeSummary?: Record<string, unknown> } | undefined;
    assert.ok(shared?.resumeSummary?.headline || shared?.resumeSummary?.skills || shared?.resumeSummary?.recentExperience);
    const serialized = JSON.stringify(shared);
    assert.ok(!serialized.includes("绝不可发送的姓名"));
    assert.ok(!serialized.includes("Private Name"));
    assert.ok(!serialized.includes("private@example.com"));
    assert.ok(!serialized.includes("555-0100"));
    assert.ok(!serialized.includes("data:image"));

    const enabledConsent = dom.document.querySelector<HTMLButtonElement>('[aria-label="已授权 Agent 读取简历字段"]');
    assert.ok(enabledConsent);
    await flush(() => enabledConsent.click());
    await send("撤销后问题");
    assert.equal(requests[2]?.context, undefined, "revoking consent takes effect on the next request");
  } finally {
    await flush(() => root.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("Companion previews/removes local images and preserves authorized historical images on later turns", async () => {
  const requests: Array<Record<string, unknown>> = [];
  let replyNumber = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/v1/agent/runtimes")) {
      return Response.json({ runtimes: [{ id: "codex", name: "Codex", status: "available", version: "fixture", capabilities: ["text"] }] });
    }
    if (url.endsWith("/ui-chat-fixture") && init?.method === "POST") {
      requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      replyNumber += 1;
      return Response.json({ reply: { id: `image_reply_${replyNumber}`, role: "assistant", content: "我看到了这张图片。" } });
    }
    return Response.json({ success: true, message: "ready" });
  }) as typeof fetch;

  dom.document.body.innerHTML = '<main id="fixture"></main>';
  const root = createRoot(dom.document.getElementById("fixture")!);
  const llmConfig: LlmConfig = {
    provider: "openai-compatible",
    baseUrl: "https://api.example.invalid/v1",
    apiKey: "fixture-key",
    model: "fixture-model",
    temperature: 0.3,
  };

  async function chooseImage(name: string, type: string, size = "small-fixture-image") {
    const input = dom.document.querySelector<HTMLInputElement>('input[aria-label="选择对话图片"]');
    assert.ok(input);
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new dom.File([size], name, { type })],
    });
    await flushImageRead(() => input.dispatchEvent(new dom.Event("change", { bubbles: true })));
  }

  try {
    await flush(() => root.render(
      h(UiPreferencesProvider, { initialPreferences: { locale: "zh", theme: "light" } },
        h(AgentCompanion, {...{sendChat:widgetChat}, onOpenWorkspace: () => {}, llmConfig, onOpenAiConfig: () => {} }),
      ),
    ));
    await flush(() => dom.document.querySelector<HTMLButtonElement>('[aria-label="打开 Agent 伴侣"]')?.click());

    await chooseImage("large.png", "image/png", "x".repeat(2_000_001));
    assert.match(dom.document.querySelector(".agent-companion-chat-attachment-error")?.textContent ?? "", /2 MB/);
    assert.equal(dom.document.querySelector(".agent-companion-chat-image-card"), null, "oversized images must not be staged");
    await chooseImage("unsupported.svg", "image/svg+xml");
    assert.match(dom.document.querySelector(".agent-companion-chat-attachment-error")?.textContent ?? "", /PNG、JPEG 或 WebP/);

    await chooseImage("draft.png", "image/png");
    const preview = dom.document.querySelector<HTMLImageElement>(".agent-companion-chat-image-card img");
    assert.ok(preview, "the selected image should be previewed locally before sending");
    assert.equal(requests.length, 0, "choosing an image must not contact the model");
    const removeButton = dom.document.querySelector<HTMLButtonElement>('button[aria-label="移除图片 draft.png"]');
    assert.ok(removeButton);
    await flush(() => removeButton.click());
    assert.equal(dom.document.querySelector(".agent-companion-chat-image-card"), null);

    await chooseImage("architecture.webp", "image/webp");
    assert.ok(dom.document.querySelector(".agent-companion-chat-image-card img"));
    assert.match(dom.document.querySelector(".agent-companion-chat-privacy-note")?.textContent ?? "", /完整对话历史随本轮及后续问题/);
    assert.doesNotMatch(dom.document.body.textContent ?? "", /图片只随本条消息|不会附加到后续问题/);
    const textarea = dom.document.querySelector<HTMLTextAreaElement>('textarea[aria-label="发送给 Agent"]');
    assert.ok(textarea);
    await flush(() => {
      Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "请帮我解读这张架构图");
      textarea.dispatchEvent(new dom.Event("input", { bubbles: true }));
    });
    await flush(() => dom.document.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')?.click());
    for (let attempt = 0; attempt < 10 && !requests.length; attempt += 1) await flush();

    assert.equal(requests.length, 1);
    const messages = requests[0]?.messages as Array<Record<string, unknown>>;
    const sent = messages.at(-1);
    assert.equal(sent?.content, "请帮我解读这张架构图");
    const attachments = sent?.attachments as Array<{ name: string; mimeType: string; dataUrl: string }>;
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0]?.name, "architecture.webp");
    assert.equal(attachments[0]?.mimeType, "image/webp");
    assert.match(attachments[0]?.dataUrl ?? "", /^data:image\/webp;base64,/);
    assert.equal(dom.document.querySelector(".agent-companion-chat-image-attachments"), null, "a successful send clears the staged image");
    assert.ok(dom.document.querySelector('.agent-companion-chat-message.is-user .agent-companion-chat-sent-images img'), "sent image remains visible in the chat transcript");

    const followup = dom.document.querySelector<HTMLTextAreaElement>('textarea[aria-label="发送给 Agent"]');
    assert.ok(followup);
    await flush(() => {
      Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!.call(followup, "再问一个不相关的问题");
      followup.dispatchEvent(new dom.Event("input", { bubbles: true }));
    });
    await flush(() => dom.document.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')?.click());
    for (let attempt = 0; attempt < 10 && requests.length < 2; attempt += 1) await flush();
    assert.equal(requests.length, 2);
    const followupMessages = requests[1]?.messages as Array<Record<string, unknown>>;
    assert.deepEqual(followupMessages.find(message=>Array.isArray(message.attachments))?.attachments,attachments,"earlier authorized image bytes remain exact");
    assert.equal(followupMessages.at(-1)?.attachments,undefined,"the followup does not fabricate a new attachment");
    assert.equal(followupMessages.at(-1)?.content, "再问一个不相关的问题");
  } finally {
    await flush(() => root.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("Companion explains when a known text-only model cannot receive an image", async () => {
  let chatRequests = 0;
  let openConfigCount = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/v1/agent/runtimes")) return Response.json({ runtimes: [] });
    if (url.endsWith("/ui-chat-fixture") && init?.method === "POST") chatRequests += 1;
    return Response.json({ ok: true });
  }) as typeof fetch;

  dom.document.body.innerHTML = '<main id="fixture"></main>';
  const root = createRoot(dom.document.getElementById("fixture")!);
  const llmConfig: LlmConfig = {
    provider: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "fixture-key",
    model: "deepseek-chat",
    temperature: 0.3,
  };

  try {
    await flush(() => root.render(
      h(UiPreferencesProvider, { initialPreferences: { locale: "zh", theme: "light" } },
        h(AgentCompanion, {...{sendChat:widgetChat}, onOpenWorkspace: () => {}, llmConfig, onOpenAiConfig: () => { openConfigCount += 1; } }),
      ),
    ));
    await flush(() => dom.document.querySelector<HTMLButtonElement>('[aria-label="打开 Agent 伴侣"]')?.click());

    const input = dom.document.querySelector<HTMLInputElement>('input[aria-label="选择对话图片"]');
    assert.ok(input);
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new dom.File(["fixture-image"], "resume.png", { type: "image/png" })],
    });
    await flushImageRead(() => input.dispatchEvent(new dom.Event("change", { bubbles: true })));

    assert.match(dom.document.querySelector(".agent-companion-chat-image-capability")?.textContent ?? "", /当前模型不支持图片输入/);
    const sendButton = dom.document.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]');
    assert.ok(sendButton?.disabled, "sending is disabled for a known text-only model");
    const changeModel = [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("更换模型"));
    assert.ok(changeModel);
    await flush(() => changeModel.click());
    assert.equal(openConfigCount, 1);
    assert.equal(chatRequests, 0, "an unsupported image is never posted to the chat endpoint");
  } finally {
    await flush(() => root.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("Companion opens the image picker and stages pasted images without sending them", async () => {
  let chatRequests = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/v1/agent/runtimes")) return Response.json({ runtimes: [] });
    if (url.endsWith("/ui-chat-fixture") && init?.method === "POST") chatRequests += 1;
    return Response.json({ ok: true });
  }) as typeof fetch;

  dom.document.body.innerHTML = '<main id="fixture"></main>';
  const root = createRoot(dom.document.getElementById("fixture")!);
  const llmConfig: LlmConfig = {
    provider: "openai-compatible",
    baseUrl: "https://api.example.invalid/v1",
    apiKey: "fixture-key",
    model: "fixture-model",
    temperature: 0.3,
  };
  let pickerRequests = 0;
  let fallbackClicks = 0;

  try {
    await flush(() => root.render(
      h(UiPreferencesProvider, { initialPreferences: { locale: "zh", theme: "light" } },
        h(AgentCompanion, {...{sendChat:widgetChat}, onOpenWorkspace: () => {}, llmConfig, onOpenAiConfig: () => {} }),
      ),
    ));
    await flush(() => dom.document.querySelector<HTMLButtonElement>('[aria-label="打开 Agent 伴侣"]')?.click());

    const input = dom.document.querySelector<HTMLInputElement>('input[aria-label="选择对话图片"]');
    const attachButton = dom.document.querySelector<HTMLButtonElement>('button[aria-label="添加图片"]');
    assert.ok(input);
    assert.ok(attachButton);
    Object.defineProperty(input, "showPicker", {
      configurable: true,
      value: () => { pickerRequests += 1; throw new Error("picker unavailable"); },
    });
    input.click = () => { fallbackClicks += 1; };

    await flush(() => attachButton.click());
    assert.equal(pickerRequests, 1, "the user gesture should request the native picker");
    assert.equal(fallbackClicks, 1, "a blocked/unsupported showPicker call should fall back to input.click()");

    const textarea = dom.document.querySelector<HTMLTextAreaElement>('textarea[aria-label="发送给 Agent"]');
    assert.ok(textarea);
    const pastedFile = new dom.File(["clipboard-image"], "clipboard.png", { type: "image/png" });
    const pasteEvent = new dom.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      configurable: true,
      value: {
        items: [{
          kind: "file",
          type: "image/png",
          getAsFile: () => pastedFile,
        }],
        files: [pastedFile],
      },
    });
    await flushImageRead(() => textarea.dispatchEvent(pasteEvent));

    assert.equal(pasteEvent.defaultPrevented, true, "image paste should not insert an empty string into the textarea");
    assert.ok(dom.document.querySelector('.agent-companion-chat-image-card img[alt="待发送图片：clipboard.png"]'), "pasted image should appear in the local preview");
    assert.equal(chatRequests, 0, "pasting an image must not send it to the model automatically");

    const textPaste = new dom.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(textPaste, "clipboardData", {
      configurable: true,
      value: { items: [{ kind: "string", type: "text/plain", getAsFile: () => null }], files: [] },
    });
    await flush(() => textarea.dispatchEvent(textPaste));
    assert.equal(textPaste.defaultPrevented, false, "ordinary text paste must remain untouched");
  } finally {
    await flush(() => root.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("an Atlas diagnosis opens guided Agent chat as an editable draft without sending or sharing the resume", async () => {
  let chatRequests = 0;
  let consumed = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/ui-chat-fixture") && init?.method === "POST") chatRequests++;
    return Response.json({ runtimes: [] });
  }) as typeof fetch;
  dom.document.body.innerHTML = '<main id="fixture"></main>';
  const root = createRoot(dom.document.getElementById("fixture")!);
  const llmConfig: LlmConfig = { provider: "ollama", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "", model: "fixture", temperature: 0.3 };
  try {
    await flush(() => root.render(h(UiPreferencesProvider, { initialPreferences: { locale: "zh", theme: "light" } },
      h(AgentCompanion, {...{sendChat:widgetChat}, onOpenWorkspace: () => {}, llmConfig, onOpenAiConfig: () => {},
        initialPrompt: "已保存 9 张，2 个来源未完成。先问我一个核对问题。", onPromptConsumed: () => { consumed++; } }))));
    const draft = dom.document.querySelector<HTMLTextAreaElement>('textarea[aria-label="发送给 Agent"]');
    assert.ok(draft);
    assert.match(draft.value, /已保存 9 张.*先问我一个核对问题/);
    assert.equal(consumed, 1);
    assert.equal(chatRequests, 0, "the user decides whether to send the draft");
    assert.equal(dom.document.querySelector('[aria-label="已引用简历片段"]'), null);
  } finally {
    await flush(() => root.unmount());
    globalThis.fetch = originalFetch;
  }
});
