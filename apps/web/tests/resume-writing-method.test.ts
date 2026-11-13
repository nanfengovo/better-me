import assert from "node:assert/strict";
import test from "node:test";
import { resumeWritingMethod, type LlmConfig } from "@better-me/core";
import { generateWritingReply, writingMessages, type WritingSource } from "../src/lib/resume-copilot.ts";
import { sendAgentChat, startJdMatch } from "../src/services/agent-client.ts";
import {chatHost} from "./fixtures/free-chat-host";

const config: LlmConfig = { provider: "ollama", model: "synthetic", baseUrl: "http://fixture.invalid/v1", temperature: 0 };
const field: WritingSource = { targetRef: { kind: "claim_text", locale: "zh", experienceId: "fixture", claimId: "c" }, text: "维护导入工具。", label: "合成条目" };

test("a single field gets the appropriate writing method, not the other fields, CV examples or layout assumptions", () => {
  const headline: WritingSource = { ...field, targetRef: { kind: "profile_headline", locale: "zh" } };
  for (const [source, scope] of [[headline, "headline"], [field, "claim"]] as const) {
    const [system, data] = writingMessages(source, "");
    assert.ok(system!.content.includes(resumeWritingMethod(scope)));
    assert.ok(!system!.content.includes(resumeWritingMethod("review")));
    assert.doesNotMatch(system!.content, /https?:\/\/|Henry Bettany|Bill Ryan|导入表校验必填列/);
    assert.deepEqual(JSON.parse(data!.content), { originalText: source.text, confirmedSupplement: "" });
  }
});

test("scripted model: ask first, then an evidenced nonnumeric draft; neither turn mutates its source", async () => {
  const before = structuredClone(field), signal = new AbortController().signal;
  const first = await generateWritingReply(config, field, "", signal, async () => ({ content: JSON.stringify({
    proposedText: "维护并改进导入工具。", questions: [], rationale: "模型试图提前改写", evidenceQuotes: [field.text],
  }) }));
  assert.equal(first.proposedText, undefined);
  assert.ok(first.questions.length);
  const answer = "我为导入文件校验必填列，缺列时显示列名。";
  const draft = "为导入文件校验必填列，缺列时显示列名。";
  const second = await generateWritingReply(config, field, answer, signal, async (_config, messages) => {
    assert.deepEqual(JSON.parse(String(messages[1]!.content)), { originalText: field.text, confirmedSupplement: answer });
    return { content: JSON.stringify({ questions: [], rationale: "明确了对象与异常行为，不推断收益。", evidenceQuotes: [answer], proposedText: draft }) };
  });
  assert.equal(second.proposedText, draft);
  assert.deepEqual(second.evidenceQuotes, [answer]);
  assert.deepEqual(field, before);
});

test("advisor kernel transport gets the editorial method without adding evidence to the user's request", async t => {
  let prompt="";
  await chatHost(t,async value=>{prompt=value;return JSON.stringify({kind:"reply",content:"请先补充你的动作。"});});
  const message = "帮我整理一条经历";
  const result = await sendAgentChat({ llmConfig: {...config,baseUrl:"http://127.0.0.1:1/v1"}, messages: [{ role: "user", id: "fixture-chat", content: message }] });
  assert.equal(result.meta?.source, "agent-host");
  assert.ok(prompt.includes(resumeWritingMethod("review")));
  assert.deepEqual(JSON.parse(prompt.split("\n\n").at(-1)!).conversation.messages,[{role:"user",id:"fixture-chat",content:message}]);
});

test("offline JD advice neither invents a job from a URL nor promotes a keyword hit to verified work", async t => {
  t.mock.method(globalThis, "fetch", () => { throw Error("offline path must not call a model"); });
  const request = {
    threadId: "fixture-thread", allowedProfileEntryIds: ["unrelated-allowed-id"], sessionClaims: { "another-id": "用 C# 编写文件校验器。" },
    llmConfig: { ...config, provider: "openai-compatible" as const, apiKey: "" },
  };
  const missing = await startJdMatch({ ...request, rawJd: "https://example.invalid/no-job-body" });
  assert.deepEqual(missing.proposals, []);
  assert.deepEqual(missing.structuredJd?.techStack, []);
  assert.ok(missing.errors?.length);
  const line = "维护 C# 导入工具。";
  const actual = await startJdMatch({ ...request, rawJd: "岗位职责\n" + line + "\n任职要求\n了解纸张裁切工艺。" });
  const hit = actual.proposals.find(p => p.jdItem === line);
  assert.equal(hit?.evidenceType, "claimed");
  assert.equal(hit?.profileEntryId, undefined);
  assert.equal(actual.proposals.find(p => p.jdItem === "了解纸张裁切工艺。")?.evidenceType, "gap");
  assert.ok(actual.proposals.every(p => p.evidenceType !== "verified"));
  const inline = await startJdMatch({ ...request, rawJd: "岗位职责：" + line });
  assert.deepEqual(inline.proposals.map(p => p.jdItem), [line]);
});
