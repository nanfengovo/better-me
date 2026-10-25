import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import { processAgentChat } from "../src/chat/chat-service.js";
import type { ChatRequestBody } from "../src/chat/types.js";

class MockChatModel extends BaseChatModel {
  constructor(private responseText: string) {
    super({});
  }

  _llmType(): string {
    return "mock-chat";
  }

  async _generate() {
    return {
      generations: [
        {
          message: new AIMessage(this.responseText),
          text: this.responseText,
        },
      ],
    };
  }
}

describe("agent-host Chat Service", () => {
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

    const model = new MockChatModel(mockReply);

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
});
