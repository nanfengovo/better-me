import assert from "node:assert/strict";
import test from "node:test";
import { sendAgentChat } from "../src/services/agent-client.ts";
import { generateWritingReply } from "../src/lib/resume-copilot.ts";
import type { LlmConfig } from "@better-me/core";

const config: LlmConfig = { provider: "openai-compatible", baseUrl: "https://api.deepseek.com", apiKey: "synthetic-only", model: "deepseek-flash", temperature: 0.3, thinkingMode: "enabled", reasoningEffort: "low", maxTokens: 16384 };

test("browser Agent chat forwards all DeepSeek controls to the host", async t => {
  let body: Record<string, unknown> | undefined;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ reply: { id: "synthetic-answer", role: "assistant", content: "Synthetic reply" } });
  });
  const reply = await sendAgentChat({ llmConfig: config, messages: [{ id: "synthetic-user", role: "user", content: "Synthetic request" }] });
  assert.equal(reply.content, "Synthetic reply");
  assert.deepEqual(body?.modelSettings, config);
});

test("real resume-writing transport uses DeepSeek JSON object mode and retains original source", async () => {
  const source = { targetRef: { kind: "profile_headline" as const, locale: "zh" as const }, text: "负责开发接口", label: "Synthetic field" };
  const original = structuredClone(source);
  const reply = await generateWritingReply(config, source, "", new AbortController().signal, async (_config, messages, options) => {
    assert.deepEqual(options?.responseFormat, { type: "json_object" });
    assert.ok(messages.some(message => typeof message.content === "string" && message.content.includes("JSON")));
    return { content: JSON.stringify({ questions: ["具体开发了什么接口？"], rationale: "需要动作与对象", evidenceQuotes: [source.text] }), finishReason: "stop" };
  });
  assert.equal(reply.questions.length, 1);
  assert.equal(reply.proposedText, undefined);
  assert.deepEqual(source, original);
});

test("known DeepSeek provider failures do not silently duplicate a generation in the browser", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ error: "model_provider_error", message: "DeepSeek (402)：账户余额不足。" }, { status: 402 }); });
  const reply = await sendAgentChat({ llmConfig: config, messages: [{ id: "synthetic-user", role: "user", content: "Synthetic request" }] });
  assert.equal(reply.meta?.status, "error");
  assert.match(reply.content, /余额不足/);
  assert.equal(calls, 1);
});
