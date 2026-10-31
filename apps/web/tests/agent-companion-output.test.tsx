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
  FileReader: dom.FileReader,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { createElement: h, act } = React;
const { createRoot } = await import("react-dom/client");
const { UiPreferencesProvider } = await import("../src/lib/ui-preferences.tsx");
const { AgentCompanion } = await import("../src/components/AgentCompanion.tsx");
const originalFetch = globalThis.fetch;

function event(sequence: number, type: string, payload: Record<string, unknown>) {
  return {
    id: `run_1:${sequence}:fixture`,
    runId: "run_1",
    sequence,
    type,
    timestamp: "2026-10-27T12:00:00.000Z",
    payload,
  };
}

function responseStream(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const frames = [
    event(1, "text.delta", { text: "临时流式片段" }),
    event(2, "text.delta", { text: "最终完整答复", replace: true }),
    event(3, "run.completed", { status: "completed" }),
  ].map((item) => `id: ${item.id}\nevent: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames.join("")));
      controller.close();
    },
  });
}

async function flush(action: () => void = () => {}) {
  await act(async () => {
    action();
    await nextTurn();
    await nextTurn();
  });
}

test("Agent Companion replaces interim run chunks with the CLI's authoritative final answer", async () => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/v1/agent/runtimes")) {
      return Response.json({ runtimes: [{ id: "codex", name: "Codex", status: "available", version: "fixture", capabilities: ["text"] }] });
    }
    if (url.endsWith("/api/v1/agent/runs") && init?.method === "POST") {
      const now = "2026-10-27T12:00:00.000Z";
      return Response.json({
        run: { id: "run_1", workflow: "companion-run", runtimeId: "codex", status: "running", createdAt: now, startedAt: now, runDirectory: "/tmp/run_1", outputDirectory: "/tmp/run_1/output", isolation: "process" },
        eventsUrl: "/events",
        statusUrl: "/status",
      }, { status: 202 });
    }
    if (url.includes("/api/v1/agent/runs/run_1/events")) {
      return new Response(responseStream(), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    if (url.includes("/api/v1/agent/runs/run_1")) return new Response("unavailable", { status: 503 });
    return Response.json({ ok: true });
  }) as typeof fetch;

  dom.document.body.innerHTML = '<main id="fixture"></main>';
  const root = createRoot(dom.document.getElementById("fixture")!);
  const llmConfig: LlmConfig = {
    provider: "openai-compatible",
    baseUrl: "https://api.example.invalid/v1",
    apiKey: "",
    model: "fixture-model",
    temperature: 0.3,
  };
  try {
    await flush(() => root.render(
      h(UiPreferencesProvider, { initialPreferences: { locale: "zh", theme: "light" } },
        h(AgentCompanion, { onOpenWorkspace: () => {}, llmConfig, onOpenAiConfig: () => {} }),
      ),
    ));
    await flush(() => dom.document.querySelector<HTMLButtonElement>('[aria-label="打开 Agent 伴侣"]')?.click());
    const chatPanel = dom.document.querySelector<HTMLElement>(".agent-companion-chat");
    const toolsToggle = dom.document.querySelector<HTMLButtonElement>('[data-testid="agent-companion-tools-toggle"]');
    const toolsContent = dom.document.getElementById("agent-companion-tools-content");
    assert.ok(chatPanel && toolsToggle && toolsContent);
    assert.match(chatPanel.textContent ?? "", /Agent 对话/, "the conversation should be the primary visible workflow");
    assert.equal(toolsToggle.getAttribute("aria-expanded"), "false");
    assert.equal(toolsContent.hidden, true, "secondary local tools should stay collapsed by default");
    await flush(() => toolsToggle.click());
    const quickRunToggle = dom.document.querySelector<HTMLButtonElement>('[data-testid="agent-companion-quick-run-toggle"]');
    const quickRunContent = dom.document.getElementById("agent-companion-quick-run-content");
    assert.ok(quickRunToggle && quickRunContent);
    assert.equal(quickRunToggle.getAttribute("aria-expanded"), "false");
    assert.equal(quickRunContent.hidden, true, "the one-off CLI runner should be secondary and collapsed by default");
    await flush(() => quickRunToggle.click());
    assert.equal(quickRunContent.hidden, false, "the local CLI runner should expand on demand");
    assert.match(quickRunContent.textContent ?? "", /不会自动带入本对话\/简历上下文/);
    assert.match(quickRunContent.textContent ?? "", /默认不保证 OS 沙箱/);
    const textarea = dom.document.querySelector<HTMLTextAreaElement>(".agent-companion-field textarea");
    assert.ok(textarea);
    assert.equal(textarea.placeholder, "先粘贴岗位描述或其他文本，再写明任务");
    await flush(() => {
      Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "帮我总结岗位要求");
      textarea.dispatchEvent(new dom.Event("input", { bubbles: true }));
    });
    const runButton = [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("开始运行"));
    assert.ok(runButton);
    await flush(() => runButton.click());
    for (let attempt = 0; attempt < 10 && !dom.document.querySelector(".agent-output-text"); attempt += 1) {
      await flush();
    }
    const answer = dom.document.querySelector(".agent-output-text")?.textContent ?? "";
    assert.match(answer, /最终完整答复/);
    assert.doesNotMatch(answer, /临时流式片段/);
    assert.match(dom.document.querySelector(".agent-companion-run-status")?.textContent ?? "", /进程运行 · 无 OS 沙箱/, "show the actual process isolation level instead of a generic isolated badge");
  } finally {
    await flush(() => root.unmount());
    globalThis.fetch = originalFetch;
  }
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
    if (url.endsWith("/api/v1/agent/chat") && init?.method === "POST") {
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
        h(AgentCompanion, {
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
    if (url.endsWith("/api/v1/agent/chat")) {
      requests.push({ body: JSON.parse(String(init?.body)), signal: init?.signal ?? undefined });
      if (requests.length > 1) return Response.json({ reply: { id: "guided-answer", role: "assistant", content: "先确认目标岗位，再逐步拆解。" } });
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
    }
    return Response.json({ success: true });
  }) as typeof fetch;
  dom.document.body.innerHTML = '<main id="fixture"></main>';
  const root = createRoot(dom.document.getElementById("fixture")!);
  try {
    await flush(() => root.render(h(UiPreferencesProvider, { initialPreferences: { locale: "zh", theme: "light" } }, h(AgentCompanion, {
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
    if (url.endsWith("/api/v1/agent/chat") && init?.method === "POST") {
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
        h(AgentCompanion, { onOpenWorkspace: () => {}, llmConfig, onOpenAiConfig: () => {}, resume }),
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

test("Companion previews and removes local images, then sends them only with the selected chat message", async () => {
  const requests: Array<Record<string, unknown>> = [];
  let replyNumber = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/v1/agent/runtimes")) {
      return Response.json({ runtimes: [{ id: "codex", name: "Codex", status: "available", version: "fixture", capabilities: ["text"] }] });
    }
    if (url.endsWith("/api/v1/agent/chat") && init?.method === "POST") {
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
    await flush(() => input.dispatchEvent(new dom.Event("change", { bubbles: true })));
    for (let attempt = 0; attempt < 10 && !dom.document.querySelector(".agent-companion-chat-image-card") && !dom.document.querySelector(".agent-companion-chat-attachment-error"); attempt += 1) await flush();
  }

  try {
    await flush(() => root.render(
      h(UiPreferencesProvider, { initialPreferences: { locale: "zh", theme: "light" } },
        h(AgentCompanion, { onOpenWorkspace: () => {}, llmConfig, onOpenAiConfig: () => {} }),
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
    assert.ok(followupMessages.every((message) => !message.attachments), "previous images are not resent with later turns");
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
    if (url.endsWith("/api/v1/agent/chat") && init?.method === "POST") chatRequests += 1;
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
        h(AgentCompanion, { onOpenWorkspace: () => {}, llmConfig, onOpenAiConfig: () => { openConfigCount += 1; } }),
      ),
    ));
    await flush(() => dom.document.querySelector<HTMLButtonElement>('[aria-label="打开 Agent 伴侣"]')?.click());

    const input = dom.document.querySelector<HTMLInputElement>('input[aria-label="选择对话图片"]');
    assert.ok(input);
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new dom.File(["fixture-image"], "resume.png", { type: "image/png" })],
    });
    await flush(() => input.dispatchEvent(new dom.Event("change", { bubbles: true })));
    for (let attempt = 0; attempt < 10 && !dom.document.querySelector(".agent-companion-chat-image-capability"); attempt += 1) await flush();

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
    if (url.endsWith("/api/v1/agent/chat") && init?.method === "POST") chatRequests += 1;
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
        h(AgentCompanion, { onOpenWorkspace: () => {}, llmConfig, onOpenAiConfig: () => {} }),
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
    await flush(() => textarea.dispatchEvent(pasteEvent));
    for (let attempt = 0; attempt < 10 && !dom.document.querySelector('.agent-companion-chat-image-card img[alt="待发送图片：clipboard.png"]'); attempt += 1) await flush();

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
    if (String(input).endsWith("/api/v1/agent/chat") && init?.method === "POST") chatRequests++;
    return Response.json({ runtimes: [] });
  }) as typeof fetch;
  dom.document.body.innerHTML = '<main id="fixture"></main>';
  const root = createRoot(dom.document.getElementById("fixture")!);
  const llmConfig: LlmConfig = { provider: "ollama", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "", model: "fixture", temperature: 0.3 };
  try {
    await flush(() => root.render(h(UiPreferencesProvider, { initialPreferences: { locale: "zh", theme: "light" } },
      h(AgentCompanion, { onOpenWorkspace: () => {}, llmConfig, onOpenAiConfig: () => {},
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
