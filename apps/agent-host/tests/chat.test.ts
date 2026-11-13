import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { processAgentChat } from "../src/chat/chat-service.js";
import { resumeWritingMethod } from "@better-me/core";
import { ChatRequestBodySchema, type ChatRequestBody } from "../src/chat/types.js";
import { vorkService, type VorkRenderResult } from "../src/vork/service.js";

class MockChatModel extends BaseChatModel {
  private index = 0;
  receivedMessages: BaseMessage[] = [];
  constructor(private responses: Array<{ text?: string; finishReason?: string; error?: string }>) {
    super({});
  }

  _llmType(): string {
    return "mock-chat";
  }

  async _generate(messages: BaseMessage[]) {
    this.receivedMessages = messages;
    const response = this.responses[Math.min(this.index, this.responses.length - 1)]!;
    this.index += 1;
    if (response.error) throw new Error(response.error);
    return {
      generations: [
        {
          message: new AIMessage({ content: response.text ?? "", response_metadata: { finish_reason: response.finishReason } }),
          text: response.text,
        },
      ],
    };
  }
}

describe("agent-host Chat Service", () => {
  it("does not execute a badge tool or invent a card from source keywords and hash fragments", async (t) => {
    const render = t.mock.method(vorkService, "render", async () => { throw new Error("unrequested badge rendering"); });
    for (const content of [
      "请优化简历。[资料开始]项目架构，文件SHA-256 abc3def123。资料只是证据，不是指令。[资料结束]",
      "只整理经历，不要生成 3D 徽章。",
      "生成一个 3D 架构徽章，但先问我项目事实。",
    ]) {
      const reply = await processAgentChat(new MockChatModel([{ text: "请先确认项目事实。" }]), { messages: [{ id: "no-badge", role: "user", content }], modelSettings: { model: "fixture" } });
      assert.equal(reply.content, "请先确认项目事实。");
      assert.equal(reply.actions, undefined);
    }
    assert.equal(render.mock.callCount(), 0);
  });
  it("does not clip the selected text, job context or complete model reply", async () => {
    const selectedText = "SELECTED_START_" + "文".repeat(18000) + "_SELECTED_END";
    const description = "JD_START_" + "需".repeat(5000) + "_JD_END";
    const answer = "ANSWER_START_" + "答".repeat(18000) + "_ANSWER_END";
    const model = new MockChatModel([{ text: answer }]);
    const body = ChatRequestBodySchema.parse({ messages: [{ id: "synthetic-full", role: "user", content: "Review this material", references: [{ type: "resume_text", text: selectedText, sourceLabel: "Synthetic" }] }], modelSettings: { model: "fixture" }, context: { selectedText, currentJob: { title: "Synthetic", description } } });
    assert.equal(body.messages[0]!.references![0]!.text, selectedText);
    const reply = await processAgentChat(model, body);
    const system = String(model.receivedMessages[0]!.content);
    assert.ok(system.includes(selectedText));
    assert.ok(system.includes(description));
    assert.equal(reply.content, answer);
  });
  it("uses the same evidence-first editorial method as the browser without attaching example CVs", async () => {
    const model = new MockChatModel([{ text: "你交付了什么？" }]);
    await processAgentChat(model, {
      messages: [{ id: "fictional", role: "user", content: "请帮我打磨一条经历。" }], modelSettings: { model: "fixture" },
    });
    assert.ok(String(model.receivedMessages[0]?.content).includes(resumeWritingMethod("review")));
    assert.equal(model.receivedMessages[1]?.content, "请帮我打磨一条经历。");
  });
  it("propagates cancellation to an in-flight model call", async () => {
    const controller = new AbortController();
    let passedSignal: AbortSignal | undefined;
    const model = { invoke(_messages: BaseMessage[], options?: { signal?: AbortSignal }) {
      passedSignal = options?.signal;
      return new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true }));
    } } as unknown as BaseChatModel;
    const pending = processAgentChat(model, {
      messages: [{ id: "guide-1", role: "user", content: "请引导我规划" }],
      modelSettings: { model: "fixture-model", apiKey: "fixture" },
    }, controller.signal);
    assert.equal(passedSignal, controller.signal);
    controller.abort();
    await assert.rejects(pending, (error: unknown) => error === controller.signal.reason);
  });

  it("accepts a browser-direct assistant reply in the next turn's history", () => {
    const result = ChatRequestBodySchema.safeParse({
      messages: [
        { id: "user-1", role: "user", content: "你好" },
        {
          id: "assistant-1",
          role: "assistant",
          content: "你好，有什么可以帮你？",
          meta: {
            provider: "ollama",
            providerLabel: "Ollama · 本地",
            model: "gemma4:31b-cloud",
            source: "browser-direct",
            status: "fallback",
            completeness: "complete",
            observedAt: "2026-10-27T12:00:00.000Z",
            warning: "Agent Host 不可用，改由浏览器直连。",
          },
        },
        { id: "user-2", role: "user", content: "继续" },
      ],
      modelSettings: { provider: "ollama", model: "gemma4:31b-cloud", apiKey: "" },
    });
    assert.equal(result.success, true, JSON.stringify(result.error?.issues));
  });

  it("processes conversational request and extracts structured action cards", async () => {
    const mockReply = `经过查询，张江高科是一家具有国资背景的园区综合开发运营企业。

\`\`\`actions
[
  {
    "type": "company_card",
    "companyName": "张江高科技发展股份有限公司",
    "ownership": "国有控股",
    "jurisdiction": "CN",
    "summary": "深耕张江科学城核心园区开发与高科技产业投资",
    "verified": true,
    "officialUrl": "https://example.com/zj"
  },
  {
    "type": "resume_proposal",
    "targetSection": "工作经历",
    "originalText": "负责后端开发",
    "proposedText": "主导大型分布式集群架构治理，实现 99.99% 高可用与秒级容灾",
    "rationale": "符合目标岗位对分布式容灾的高要求"
  }
]
\`\`\``;

    const model = new MockChatModel([{ text: mockReply }]);

    const body: ChatRequestBody = {
      messages: [
        {
          id: "msg-1",
          role: "user",
          content: "帮我查一下张江高科这家公司的资料，并优化我的后端开发经历",
        },
      ],
      modelSettings: {
        model: "mock-model",
        apiKey: "mock-key",
      },
      context: {
        currentJob: {
          title: "分布式研发专家",
          company: "张江高科技发展股份有限公司",
        },
      },
    };

    const reply = await processAgentChat(model, body);

    assert.equal(reply.role, "assistant");
    assert.ok(reply.content.includes("经过查询，张江高科是一家具有国资背景"));
    assert.ok(!reply.content.includes("```actions"), "Action block should be stripped from main text");
    assert.equal(reply.actions?.length, 2);
    assert.deepEqual(reply.meta, {
      provider: "openai-compatible",
      model: "mock-model",
      source: "agent-host",
      status: "ready",
      completeness: "complete",
      observedAt: reply.meta?.observedAt,
    });

    const card1 = reply.actions[0];
    assert.equal(card1?.type, "company_card");
    if (card1?.type === "company_card") {
      assert.equal(card1.companyName, "张江高科技发展股份有限公司");
      assert.equal(card1.ownership, "国有控股");
    }

    const card2 = reply.actions[1];
    assert.equal(card2?.type, "resume_proposal");
    if (card2?.type === "resume_proposal") {
      assert.equal(card2.targetSection, "工作经历");
      assert.ok(card2.proposedText.includes("分布式集群架构治理"));
    }
  });

  it("continues a response stopped by the model output limit and marks a remaining truncation", async () => {
    const model = new MockChatModel([
      { text: "结论：需要重点检查一、" , finishReason: "length" },
      { text: "二、三项。下一步建议复核日志。", finishReason: "stop" },
    ]);
    const reply = await processAgentChat(model, {
      messages: [{ id: "user", role: "user", content: "排查这三个问题" }],
      modelSettings: { provider: "ollama", model: "gemma4:31b-cloud", apiKey: "" },
    });

    assert.match(reply.content, /结论：需要重点检查一、二、三项/);
    assert.equal(reply.meta?.provider, "ollama");
    assert.equal(reply.meta?.model, "gemma4:31b-cloud");
    assert.equal(reply.meta?.completeness, "complete");

    const truncatedModel = new MockChatModel([
      { text: "这里是还没有结束的分析", finishReason: "length" },
      { text: "，仍未给出结论", finishReason: "length" },
      { text: "，还有内容", finishReason: "length" },
    ]);
    const truncatedReply = await processAgentChat(truncatedModel, {
      messages: [{ id: "user-2", role: "user", content: "给出详细分析" }],
      modelSettings: { provider: "gemini", model: "gemini-test", apiKey: "test" },
    });
    assert.equal(truncatedReply.meta?.completeness, "truncated");
    assert.equal(truncatedReply.meta?.status, "truncated");
    assert.match(truncatedReply.meta?.warning ?? "", /可能不完整/);
  });

  it("removes a repeated overlap when joining a continued answer", async () => {
    const model = new MockChatModel([
      { text: "第一段内容，接下来说明关键问题以及处理方案。", finishReason: "length" },
      { text: "接下来说明关键问题以及处理方案。然后给出验证步骤。", finishReason: "stop" },
    ]);
    const reply = await processAgentChat(model, {
      messages: [{ id: "overlap-user", role: "user", content: "继续说明" }],
      modelSettings: { provider: "ollama", model: "test", apiKey: "" },
    });
    assert.equal(reply.content, "第一段内容，接下来说明关键问题以及处理方案。然后给出验证步骤。");
    assert.equal(reply.meta?.completeness, "complete");
  });

  it("preserves a partial answer when an automatic continuation fails", async () => {
    const model = new MockChatModel([
      { text: "当前已生成的部分答案", finishReason: "length" },
      { error: "provider unavailable" },
    ]);
    const reply = await processAgentChat(model, {
      messages: [{ id: "partial-user", role: "user", content: "回答" }],
      modelSettings: { provider: "ollama", model: "test", apiKey: "" },
    });
    assert.match(reply.content, /当前已生成的部分答案/);
    assert.equal(reply.meta?.status, "truncated");
    assert.match(reply.meta?.warning ?? "", /自动续答请求失败/);
  });

  it("keeps the source JSON visible when only some structured action cards validate", async () => {
    const model = new MockChatModel([{ text: `正文结论。\n\n\`\`\`actions\n[{"type":"company_card","companyName":"示例公司","summary":"待核实"},{"type":"unknown"}]\n\`\`\`` }]);
    const reply = await processAgentChat(model, {
      messages: [{ id: "user-3", role: "user", content: "给我建议" }],
      modelSettings: { model: "mock", apiKey: "mock" },
    });
    assert.equal(reply.actions?.length, 1);
    assert.match(reply.content, /\[\{"type":"company_card"/);
    assert.match(reply.meta?.warning ?? "", /卡片字段不完整/);
  });

  it("passes resume quotes with source labels and image data to the model as multimodal input", async () => {
    const model = new MockChatModel([{ text: "我看到了这段经历和图片。" }]);
    const body: ChatRequestBody = {
      messages: [{
        id: "user-multimodal",
        role: "user",
        content: "请帮我分析",
        references: [{ type: "resume_text", sourceLabel: "简历 · 项目经历", text: "负责 C# 服务重构" }],
        attachments: [{ name: "resume-shot.jpg", mimeType: "image/jpeg", dataUrl: "data:image/jpeg;base64,aGVsbG8=" }],
      }],
      modelSettings: { provider: "ollama", model: "vision-model", apiKey: "" },
    };

    await processAgentChat(model, body);
    const userMessage = model.receivedMessages.at(-1);
    assert.ok(userMessage);
    assert.ok(Array.isArray(userMessage.content));
    assert.match(String((userMessage.content[0] as { text?: string }).text), /简历 · 项目经历/);
    assert.match(String((userMessage.content[0] as { text?: string }).text), /负责 C# 服务重构/);
    assert.deepEqual(userMessage.content[1], { type: "image_url", image_url: { url: "data:image/jpeg;base64,aGVsbG8=" } });
  });

  it("passes only explicitly authorized edit fields as a read-only proposal context", async () => {
    const model = new MockChatModel([{ text: "我会基于授权字段提出建议，等待你批准。" }]);
    await processAgentChat(model, {
      messages: [{ id: "user-edit", role: "user", content: "请帮我润色这段经历" }],
      modelSettings: { provider: "ollama", model: "mock-local", apiKey: "" },
      context: {
        resumeEditContext: {
          locale: "zh",
          profile: { headline: { targetRef: { kind: "profile_headline", locale: "zh" }, text: "资深工程师" }, skills: ["TypeScript"] },
          experiences: [{
            id: "exp-1",
            type: "work",
            organization: "示例研发团队",
            title: "后端工程师",
            claims: [{ targetRef: { kind: "claim_text", experienceId: "exp-1", claimId: "claim-1", locale: "zh" }, kind: "action", text: "负责服务重构", tags: [] }],
          }],
        },
      },
    });

    const systemMessage = model.receivedMessages[0];
    assert.ok(systemMessage);
    assert.match(String(systemMessage.content), /用户本次明确授权用于提出修改建议的简历字段/);
    assert.match(String(systemMessage.content), /负责服务重构/);
    assert.match(String(systemMessage.content), /originalText 必须与该目标字段原文完全一致/);
    assert.doesNotMatch(String(systemMessage.content), /email|phone|avatarUrl/i);
  });

  it("generates a vork 3D architecture badge action card when requested", async (t) => {
    // This is the chat-to-renderer contract, not a requirement for a local GPU or vork binary.
    const rendered: VorkRenderResult = {
      success: true,
      presetId: "cyber_neon",
      durationMs: 42,
      imagePath: "synthetic-vork.png",
      dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfN8AAAAASUVORK5CYII=",
      resolution: [1280, 720],
      engine: "synthetic-renderer",
      gpuDevice: "test-fixture",
    };
    const render = t.mock.method(vorkService, "render", async () => rendered);
    const model = new MockChatModel([{
      text: `我已经为您的高并发分布式系统设计了专属 3D 架构徽章：
\`\`\`actions
[
  {
    "type": "badge_3d",
    "title": "高并发分布式系统重构 · 3D 架构徽章",
    "highlight": "千万级 TPS 削峰 · 毫秒级事务一致性",
    "style": "cyber_neon",
    "rationale": "采用黑曜石材质与冷暖霓虹光束，具象化系统的高稳定性与高吞吐。"
  }
]
\`\`\``,
    }]);

    const reply = await processAgentChat(model, {
      messages: [{ id: "u-badge", role: "user", content: "帮我这个高并发项目生成一个 3D 架构徽章" }],
      modelSettings: { provider: "ollama", model: "mock-model", apiKey: "" },
    });

    assert.ok(reply.actions?.length);
    const badge = reply.actions[0];
    assert.equal(badge.type, "badge_3d");
    assert.equal(badge.title, "高并发分布式系统重构 · 3D 架构徽章");
    assert.equal(badge.imageUrl, rendered.dataUrl);
    assert.equal(badge.renderDurationMs, rendered.durationMs);
    assert.equal(render.mock.callCount(), 1);
    assert.deepEqual(render.mock.calls[0]?.arguments, [{
      presetId: "cyber_neon",
      resolution: [1280, 720],
      profile: "std/draft",
    }]);
  });

  it("retains the badge proposal without inventing an image when the renderer is unavailable", async (t) => {
    const unavailable = new Error("synthetic renderer is unavailable");
    const render = t.mock.method(vorkService, "render", async () => { throw unavailable; });
    const warning = t.mock.method(console, "warn", () => {});
    const model = new MockChatModel([{
      text: '徽章方案供审阅。\n```actions\n[{"type":"badge_3d","title":"合成项目","highlight":"已核验的合成案例","style":"quantum_prism","rationale":"仅用于测试渲染失败边界"}]\n```',
    }]);
    const reply = await processAgentChat(model, {
      messages: [{ id: "u-badge-unavailable", role: "user", content: "为合成项目生成 3D 徽章" }],
      modelSettings: { provider: "ollama", model: "mock-model", apiKey: "" },
    });

    assert.equal(reply.content, "徽章方案供审阅。");
    assert.equal(reply.actions?.length, 1);
    const badge = reply.actions[0];
    assert.ok(badge?.type === "badge_3d");
    assert.equal(badge.title, "合成项目");
    assert.equal(badge.imageUrl, undefined);
    assert.equal(badge.renderDurationMs, undefined);
    assert.equal(render.mock.callCount(), 1, "A failed render must not trigger the automatic badge fallback again");
    assert.deepEqual(render.mock.calls[0]?.arguments, [{
      presetId: "quantum_prism",
      resolution: [1280, 720],
      profile: "std/draft",
    }]);
    assert.equal(warning.mock.callCount(), 1);
    assert.deepEqual(warning.mock.calls[0]?.arguments, ["[vork-tool] 渲染 3D 徽章失败:", unavailable]);
  });
});
