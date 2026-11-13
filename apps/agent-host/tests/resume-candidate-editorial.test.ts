import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { FreeChatTaskCreateSchema, FreeChatTaskSchema } from "@better-me/agent-contracts";
import { freeChatPrompt } from "../src/kernel/free-chat.js";
import { resumeWritingMethod } from "@better-me/core/resume-writing-method";

const source = JSON.stringify({ material: { caseId: "editorial-fixture", candidate: {
  groups: [{ id: "recent-work", title: "Engineer", organization: "Synthetic", originalPeriod: "2024", kind: "employment" }],
  evidence: [{ id: "source-1", groupId: "recent-work", text: "Assisted with C# tooling.", sha256: createHash("sha256").update("Assisted with C# tooling.").digest("hex") }],
} } });
const request = { kind: "free_chat", workspaceKey: "editorial-fixture", objective: "Write a complete candidate for the selected JD.",
  responseContract: "resume_candidate_v3", candidateSource: { messageId: "source", sha256: createHash("sha256").update(source).digest("hex") },
  conversation: { messages: [{ id: "source", role: "user", content: source }] }, runtimeBinding: { id: "synthetic-editorial", label: "Synthetic", location: "unknown" },
  budget: { maxModelCalls: 1, maxToolCalls: 1, maxActiveMs: 60000 }, consent: true, idempotencyKey: "synthetic-editorial-contract" };

test("whole-resume candidate uses the shared writing method, not only a citation grammar", () => {
  const parsed = FreeChatTaskCreateSchema.parse(request);
  const task = FreeChatTaskSchema.parse({ ...parsed, id: "ct_" + "1".repeat(32), ownerId: "synthetic", revision: 1, status: "ready",
    createdAt: "2026-11-12T00:00:00.000Z", updatedAt: "2026-11-12T00:00:00.000Z", sourceFingerprint: "synthetic",
    turn: 1, events: [], usage: { modelCalls: 0, toolCalls: 0, activeMs: 0 } });
  const prompt = freeChatPrompt(task, []);
  assert.ok(prompt.includes(resumeWritingMethod("tailor")), "the same evidence-bound contribution method must reach the actual reasoner prompt");
  assert.match(prompt, /recent.*experience/i);
  assert.match(prompt, /delivery object/i);
  assert.match(prompt, /JD.*not.*personal evidence/i);
  assert.ok(prompt.includes(source.replace(/"/g, '\\"')), "complete original source is retained, not replaced by an editorial summary");
  const historical = freeChatPrompt({ ...task, responseContract: "resume_candidate_v2" }, []);
  assert.ok(!historical.includes(resumeWritingMethod("tailor")), "old v2 is an explicit historical policy, not silently regraded as v3");
});
