import assert from "node:assert/strict";
import test from "node:test";
import type { LlmConfig } from "@better-me/core";
import { getModelImageCapability, modelImageCapabilityDescription, modelImageCapabilityLabel } from "../src/lib/model-image-capability.ts";
import { chatMessagesForRequest, type ChatMessage } from "../src/services/agent-client.ts";

function config(provider: LlmConfig["provider"], baseUrl: string, model: string) {
  return { provider, baseUrl, model };
}

test("image capability recognizes documented model families without trusting custom endpoints", () => {
  assert.equal(getModelImageCapability(config("openai-compatible", "https://api.openai.com/v1", "gpt-4o")), "supported");
  assert.equal(getModelImageCapability(config("openai-compatible", "https://api.openai.com/v1", "gpt-3.5-turbo")), "unsupported");
  assert.equal(getModelImageCapability(config("openai-compatible", "https://api.deepseek.com/v1", "deepseek-chat")), "unsupported");
  assert.equal(getModelImageCapability(config("gemini", "", "gemini-2.5-flash")), "supported");
  assert.equal(getModelImageCapability(config("gemini", "", "text-embedding-004")), "unsupported");
  assert.equal(getModelImageCapability(config("ollama", "http://localhost:11434", "qwen2.5vl:7b")), "supported");
  assert.equal(getModelImageCapability(config("ollama", "http://localhost:11434", "gemma2:9b")), "unknown");
  assert.equal(getModelImageCapability(config("openai-compatible", "https://gateway.example/v1", "gpt-4o")), "unknown");
});

test("image capability copy distinguishes unsupported models from unverified models", () => {
  const translate = (zh: string) => zh;
  assert.match(modelImageCapabilityLabel("unsupported", translate), /不支持/);
  assert.match(modelImageCapabilityDescription("unsupported", translate), /切换/);
  assert.match(modelImageCapabilityLabel("unknown", translate), /未验证/);
  assert.match(modelImageCapabilityDescription("unknown", translate), /可能被拒绝/);
});

test("chat request retains images for the active turn and omits image bytes from earlier turns", () => {
  const firstImage: NonNullable<ChatMessage["attachments"]>[number] = {
    name: "resume.png",
    mimeType: "image/png",
    dataUrl: "data:image/png;base64,private-image-bytes",
  };
  const activeImage: NonNullable<ChatMessage["attachments"]>[number] = {
    name: "diagram.webp",
    mimeType: "image/webp",
    dataUrl: "data:image/webp;base64,current-image-bytes",
  };
  const prior: ChatMessage = { id: "u1", role: "user", content: "看这张简历图片", attachments: [firstImage] };
  const active: ChatMessage = { id: "u2", role: "user", content: "再看这张图", attachments: [activeImage] };
  const messages: ChatMessage[] = [prior, { id: "a1", role: "assistant", content: "已分析" }, active];

  const requestMessages = chatMessagesForRequest(messages);

  assert.equal(requestMessages[0]?.attachments, undefined);
  assert.deepEqual(requestMessages[2]?.attachments, [activeImage]);
  assert.deepEqual(prior.attachments, [firstImage], "filtering must not mutate the visible transcript");

  const nextTurn = chatMessagesForRequest([...messages, { id: "u3", role: "user", content: "只问个文字问题" }]);
  assert.ok(nextTurn.every((message) => !message.attachments), "images from earlier turns are not resent with a later text-only question");
});
