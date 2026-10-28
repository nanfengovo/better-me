import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import type { LlmConfig } from "@better-me/core";
import { sendAgentChat } from "../src/services/agent-client.ts";

afterEach(() => mock.restoreAll());

const config: LlmConfig = {
  provider: "openai-compatible",
  apiKey: "test-key",
  baseUrl: "https://example.invalid/v1",
  model: "test-model",
  temperature: 0.3,
};

function completion(content: string, finishReason: string) {
  return Response.json({ choices: [{ message: { content }, finish_reason: finishReason }] });
}

test("browser-direct chat continues a token-limited answer and records remaining truncation", async () => {
  const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
  const replies = [
    completion("第一部分，", "length"),
    completion("第二部分", "length"),
    completion("仍有后续", "length"),
  ];
  mock.method(globalThis, "fetch", async (input, init) => {
    const url = String(input);
    if (url.includes("127.0.0.1:5179")) return Response.json({ error: "offline" }, { status: 503 });
    requests.push({ url, body: typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined });
    return replies.shift() ?? completion("unexpected", "stop");
  });

  const reply = await sendAgentChat({
    messages: [{ id: "u1", role: "user", content: "请完整回答" }],
    llmConfig: config,
  });

  assert.equal(requests.length, 3, "one initial generation plus two bounded continuations");
  assert.equal(reply.content, "第一部分，第二部分仍有后续");
  assert.equal(reply.meta?.status, "truncated");
  assert.equal(reply.meta?.completeness, "truncated");
  assert.equal(reply.meta?.finishReason, "length");
  assert.match(reply.meta?.warning ?? "", /可能不完整/);
  const continuationMessages = requests[1]?.body?.messages as Array<{ role: string; content: string }>;
  assert.equal(continuationMessages.at(-1)?.role, "user");
  assert.match(continuationMessages.at(-1)?.content ?? "", /继续/);
});

test("browser-direct chat reports complete only when the provider finishes normally", async () => {
  mock.method(globalThis, "fetch", async (input) => {
    if (String(input).includes("127.0.0.1:5179")) return Response.json({ error: "offline" }, { status: 503 });
    return completion("这是完整答案。", "stop");
  });

  const reply = await sendAgentChat({ messages: [{ id: "u1", role: "user", content: "问题" }], llmConfig: config });
  assert.equal(reply.meta?.status, "fallback");
  assert.equal(reply.meta?.completeness, "complete");
  assert.equal(reply.meta?.finishReason, "stop");
});

test("local Ollama chat gives Agent Host enough time for a cold model response", async () => {
  let timeoutMs = 0;
  mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    timeoutMs = milliseconds;
    return new AbortController().signal;
  });
  mock.method(globalThis, "fetch", async () => Response.json({
    reply: {
      id: "host-reply",
      role: "assistant",
      content: "本地模型回复",
      createdAt: "2026-10-27T12:00:00.000Z",
      meta: { provider: "ollama", model: "gemma4:e2b-it-qat", source: "agent-host", status: "ready", completeness: "complete", observedAt: "2026-10-27T12:00:00.000Z" },
    },
  }));

  const reply = await sendAgentChat({
    messages: [{ id: "u1", role: "user", content: "请分析我的简历" }],
    llmConfig: { ...config, provider: "ollama", apiKey: "", baseUrl: "http://127.0.0.1:11434/v1", model: "gemma4:e2b-it-qat" },
  });

  assert.equal(reply.meta?.source, "agent-host");
  assert.equal(timeoutMs, 120_000, "local inference should not be retried after the old 35-second deadline");
});

test("a Host timeout fallback explains the retry without exposing AbortSignal internals", async () => {
  mock.method(AbortSignal, "timeout", () => new AbortController().signal);
  mock.method(globalThis, "fetch", async (input) => {
    if (String(input).includes("127.0.0.1:5179")) throw new DOMException("signal timed out", "TimeoutError");
    return completion("已由浏览器直连完成回复。", "stop");
  });

  const reply = await sendAgentChat({
    messages: [{ id: "u1", role: "user", content: "请分析我的简历" }],
    llmConfig: { ...config, provider: "ollama", apiKey: "", baseUrl: "http://127.0.0.1:11434/v1", model: "gemma4:e2b-it-qat" },
  });

  assert.equal(reply.meta?.status, "fallback");
  assert.match(reply.meta?.warning ?? "", /Agent Host 回复超时.*浏览器直连/);
  assert.doesNotMatch(reply.meta?.warning ?? "", /signal timed out/);
});

test("browser-direct chat sends quoted resume text and selected images as multimodal input", async () => {
  let providerBody: Record<string, unknown> | undefined;
  const dataUrl = "data:image/jpeg;base64,aGVsbG8=";
  mock.method(globalThis, "fetch", async (input, init) => {
    if (String(input).includes("127.0.0.1:5179")) return Response.json({ error: "offline" }, { status: 503 });
    providerBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return completion("我会结合引用和图片分析。", "stop");
  });

  await sendAgentChat({
    messages: [{
      id: "u-image",
      role: "user",
      content: "请帮我分析这段经历和图片",
      references: [{ type: "resume_text", text: "负责订单系统架构升级", sourceLabel: "简历 · 工作经历" }],
      attachments: [{ name: "project.jpg", mimeType: "image/jpeg", dataUrl }],
    }],
    llmConfig: config,
  });

  const providerMessages = providerBody?.messages as Array<{ role: string; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }>
    | undefined;
  const userMessage = providerMessages?.at(-1);
  assert.equal(userMessage?.role, "user");
  assert.ok(Array.isArray(userMessage?.content));
  if (!Array.isArray(userMessage?.content)) return;
  assert.match(userMessage.content[0]?.text ?? "", /简历引用 · 简历 · 工作经历/);
  assert.match(userMessage.content[0]?.text ?? "", /负责订单系统架构升级/);
  assert.equal(userMessage.content[1]?.type, "image_url");
  assert.equal(userMessage.content[1]?.image_url?.url, dataUrl);
});

test("browser-direct chat keeps the partial answer if an automatic continuation fails", async () => {
  let completionCount = 0;
  mock.method(globalThis, "fetch", async (input) => {
    if (String(input).includes("127.0.0.1:5179")) return Response.json({ error: "offline" }, { status: 503 });
    completionCount += 1;
    if (completionCount === 1) return completion("已经生成的部分内容", "length");
    return Response.json({ error: { message: "provider unavailable" } }, { status: 503 });
  });

  const reply = await sendAgentChat({ messages: [{ id: "u1", role: "user", content: "问题" }], llmConfig: config });
  assert.equal(reply.content, "已经生成的部分内容");
  assert.equal(reply.meta?.status, "truncated");
  assert.equal(reply.meta?.completeness, "truncated");
  assert.match(reply.meta?.warning ?? "", /自动续答请求失败/);
});

test("preserves an Agent Host truncation warning and status for the UI", async () => {
  mock.method(globalThis, "fetch", async () => Response.json({
    reply: {
      id: "host-reply",
      role: "assistant",
      content: "尚未完成的长答案",
      meta: {
        provider: "ollama",
        providerLabel: "Ollama · 本地",
        model: "gemma4:31b-cloud",
        source: "agent-host",
        status: "truncated",
        completeness: "truncated",
        finishReason: "length",
        observedAt: "2026-10-27T12:00:00.000Z",
        warning: "模型输出仍触及长度上限，回复可能不完整。",
      },
    },
  }));

  const reply = await sendAgentChat({ messages: [{ id: "u1", role: "user", content: "问题" }], llmConfig: config });
  assert.equal(reply.meta?.source, "agent-host");
  assert.equal(reply.meta?.status, "truncated");
  assert.equal(reply.meta?.completeness, "truncated");
  assert.equal(reply.meta?.finishReason, "length");
  assert.match(reply.meta?.warning ?? "", /回复可能不完整/);
});
