import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemorySaver } from "@langchain/langgraph";
import { buildCareerOrchestrator } from "../src/graphs/career/graph.js";

describe("Career Orchestrator graph", () => {
  it("builds the default worker plan and pauses before any commit", async () => {
    const graph = buildCareerOrchestrator(new MemorySaver());
    const threadId = "career-orchestrator-test";
    const initial = await graph.invoke({ task: "查找上海 TypeScript 岗位并核实办公地址", workspaceId: "run-test" }, { configurable: { thread_id: threadId } });
    const state = await graph.getState({ configurable: { thread_id: threadId } });
    assert.ok(state.next.includes("approvalGate"));
    assert.equal(initial.workers.length, 5);
    assert.equal(initial.artifacts[0]?.type, "SearchPlan");
    assert.equal(initial.artifacts.at(-1)?.type, "CoverageReceipt");
    assert.equal(initial.coverage.completed, 0);

    const completed = await graph.invoke({ approval: { status: "approved", actorScope: "user", idempotencyKey: "career-test-12345678" } }, { configurable: { thread_id: threadId } });
    const finalState = await graph.getState({ configurable: { thread_id: threadId } });
    assert.equal(finalState.next.length, 0);
    assert.ok(completed.stepLog.some((item) => item.includes("deterministic business tools")));
  });

  it("fails closed when a run is explicitly rejected", async () => {
    const graph = buildCareerOrchestrator(new MemorySaver());
    const threadId = "career-orchestrator-reject";
    await graph.invoke({ task: "准备公司调研", workspaceId: "run-test" }, { configurable: { thread_id: threadId } });
    const result = await graph.invoke({ approval: { status: "rejected", actorScope: "user", idempotencyKey: "career-reject-12345678" } }, { configurable: { thread_id: threadId } });
    assert.ok(result.stepLog.some((item) => item.includes("rejected")));
    assert.ok(result.errors.some((item) => item.includes("approval is required")));
  });
});
