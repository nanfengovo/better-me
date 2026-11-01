import test from "node:test";
import assert from "node:assert/strict";
import { createChatGptClient, ChatGptClientError } from "../src/services/chatgpt-client";
import { generateChatGptWritingReply } from "../src/lib/chatgpt-writing";

const choice = { profileId: "synthetic-account", model: "synthetic-gpt" };
test("account writing sends one field and explicit consent, never an API key/configuration", async () => {
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  const client = createChatGptClient({ baseUrl: "https://fixture.invalid", fetch: async (url, options) => {
    calls.push({ url: String(url), options });
    return Response.json({ ...choice, text: JSON.stringify({ questions: [], rationale: "仅整理本人补充", evidenceQuotes: ["编写了重试逻辑"], proposedText: "编写了重试逻辑" }) });
  } });
  const source = { targetRef: { kind: "profile_headline" as const, locale: "zh" as const }, text: "参与接口开发", label: "虚构字段" };
  const result = await generateChatGptWritingReply(client, choice, source, "编写了重试逻辑", new AbortController().signal);
  assert.equal(result.proposedText, "编写了重试逻辑"); assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://fixture.invalid/api/v1/agent/chatgpt/response");
  const body = JSON.parse(String(calls[0]?.options?.body)); assert.equal(body.consentToSend, true); assert.equal(body.profileId, choice.profileId);
  assert.equal(body.apiKey, undefined); assert.equal(body.modelSettings, undefined); assert.equal(body.input.length, 1);
  assert.doesNotMatch(JSON.stringify(body), /displayName|phone|email|factBase/);
});
test("quota failures surface their typed state and never cause a second provider request", async () => {
  let calls = 0;
  const issue = { kind: "limit", code: "subscription_sharing_usage_limit_exceeded", message: "额度受限；未切换付费 API。", status: 429 };
  const client = createChatGptClient({ fetch: async () => { calls++; return Response.json({ issue }, { status: 429 }); } });
  await assert.rejects(client.respond({ ...choice, instructions: "Synthetic", input: [{ role: "user", content: "Synthetic" }], consentToSend: true }), (error: unknown) => error instanceof ChatGptClientError && error.issue?.kind === "limit");
  assert.equal(calls, 1);
});
test("wrong account/model response is rejected before proposal parsing", async () => {
  const client = createChatGptClient({ fetch: async () => Response.json({ profileId: "other", model: choice.model, text: "{}" }) });
  await assert.rejects(generateChatGptWritingReply(client, choice, { targetRef: { kind: "profile_headline", locale: "zh" }, text: "虚构内容", label: "虚构" }, "", new AbortController().signal), /不一致/);
});
