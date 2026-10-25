import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemorySaver } from "@langchain/langgraph";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import { buildJdMatchGraph } from "../src/graphs/jd-match/graph.js";

// Mock Chat Model that returns predefined JSON outputs
class MockChatModel extends BaseChatModel {
  private callCount = 0;

  constructor() {
    super({});
  }

  _llmType(): string {
    return "mock";
  }

  async _generate(messages: any[]) {
    this.callCount++;
    if (this.callCount === 1) {
      // 1st call: structureJd
      const structuredJd = {
        title: "全栈架构师",
        company: "测试创新科技",
        location: "上海",
        requirements: ["熟练掌握 TypeScript 与 Node.js", "5年以上大型分布式系统经验"],
        preferences: ["熟悉 LangGraph 或 Agent 编排"],
        compensationRaw: "40k-60k",
        techStack: ["TypeScript", "Node.js", "LangGraph"],
      };
      return {
        generations: [{ message: new AIMessage(JSON.stringify(structuredJd)), text: JSON.stringify(structuredJd) }],
      };
    } else {
      // 2nd call: matchProfile
      const proposals = [
        {
          jdItem: "熟练掌握 TypeScript 与 Node.js",
          evidenceType: "verified",
          profileEntryId: "entry-ts-01",
          suggestion: "8年 TypeScript/Node.js 全栈深耕经验，主导微服务治理",
          rationale: "候选人有明确的技术栈履历支持",
        },
        {
          jdItem: "熟悉 LangGraph 或 Agent 编排",
          evidenceType: "claimed",
          suggestion: "曾基于 LangGraph 设计多智能体流转系统",
          rationale: "本次会话提供的工作流草稿证据",
        },
      ];
      return {
        generations: [{ message: new AIMessage(JSON.stringify(proposals)), text: JSON.stringify(proposals) }],
      };
    }
  }
}

describe("JD Match LangGraph Workflow", () => {
  it("structures JD, generates proposals, interrupts for confirmation, and resumes with decisions", async () => {
    const model = new MockChatModel();
    const checkpointer = new MemorySaver();
    const graph = buildJdMatchGraph(model, checkpointer);

    const threadId = "test-thread-hil-01";

    // 1. Initial invoke — should stop at confirmProposals breakpoint
    const initialResult = await graph.invoke(
      {
        rawJd: "招募高级全栈架构师，要求精通 TypeScript 与 Node.js，有分布式系统经验。",
        allowedProfileEntryIds: ["entry-ts-01"],
        sessionClaims: { agent: "熟悉 LangGraph 编排" },
      },
      { configurable: { thread_id: threadId } }
    );

    // Verify structured JD was extracted
    assert.ok(initialResult.structuredJd);
    assert.equal(initialResult.structuredJd.title, "全栈架构师");
    assert.equal(initialResult.structuredJd.requirements.length, 2);

    // Verify proposals were generated
    assert.equal(initialResult.proposals.length, 2);
    assert.equal(initialResult.proposals[0]?.evidenceType, "verified");
    assert.equal(initialResult.proposals[1]?.evidenceType, "claimed");

    // 2. Inspect state in checkpointer
    const threadState = await graph.getState({ configurable: { thread_id: threadId } });
    assert.ok(threadState.next.includes("confirmProposals"), "Graph must pause before confirmProposals");

    // 3. Resume by providing human decisions
    const resumeResult = await graph.invoke(
      {
        decisions: {
          [initialResult.proposals[0]!.id]: { status: "accepted" },
          [initialResult.proposals[1]!.id]: { status: "rejected", reason: "未在正式简历中体现" },
        },
      },
      { configurable: { thread_id: threadId } }
    );

    // Graph should have completed
    const finalState = await graph.getState({ configurable: { thread_id: threadId } });
    assert.equal(finalState.next.length, 0, "Graph should be finished (at END)");

    // Verify decisions were recorded
    assert.equal(resumeResult.decisions[initialResult.proposals[0]!.id]?.status, "accepted");
    assert.equal(resumeResult.decisions[initialResult.proposals[1]!.id]?.status, "rejected");

    // Verify step log
    assert.ok(resumeResult.stepLog.some((log) => log.includes("structureJd")));
    assert.ok(resumeResult.stepLog.some((log) => log.includes("matchProfile")));
  });
});
