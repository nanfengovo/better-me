import test from "node:test";
import assert from "node:assert/strict";
import { createInitialDocument } from "@better-me/storage";
import { FactBaseSchema, projectResume } from "@better-me/core";
import type { CareerTask } from "@better-me/agent-contracts";
import { approveCareerTaskStatement } from "../src/lib/career-task-facts.ts";
import { isCareerTailoringRequest } from "../src/lib/career-task-intent.ts";

function fixture(): CareerTask {
  return { id: "ct_synthetic", ownerId: "synthetic-owner", workspaceKey: "synthetic-workspace", objective: "synthetic", revision: 3,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", status: "awaiting_review",
    job: { title: "Synthetic engineer", company: "Fixture", description: "Synthetic JD" },
    resume: { id: "synthetic-resume", name: "Fixture", sourceFingerprint: "synthetic", fields: [] }, materials: [], directories: [],
    budget: { maxModelCalls: 12, maxToolCalls: 30, maxActiveMs: 600000 }, usage: { modelCalls: 3, toolCalls: 2, activeMs: 10 },
    runtimeBinding: { id: "fixture", label: "Offline fixture", location: "local" }, events: [],
    evidence: [{ id: "answer-1", kind: "user_statement", sourceId: "answer:1", hash: "fixture-hash", label: "本人本次回答", excerpt: "我负责测试。" }],
    facts: [{ id: "fact-1", text: "我负责测试。", evidenceIds: ["answer-1"], status: "proposed" }],
  };
}
test("independent fact approval preserves provenance without rewriting resume claims or projecting statements", () => {
  const document = createInitialDocument(), before = structuredClone(document.factBase);
  const rendered = projectResume(document.factBase, document.resumeViews[0]!);
  const next = approveCareerTaskStatement(document.factBase, fixture(), "fact-1", "2026-01-02T00:00:00.000Z");
  assert.deepEqual(document.factBase, before);
  assert.deepEqual(next.experiences, before.experiences);
  assert.deepEqual(next.profile, before.profile);
  assert.equal(next.personalStatements?.[0]?.kind, "user_statement");
  assert.equal(next.personalStatements?.[0]?.evidence[0]?.hash, "fixture-hash");
  assert.equal(FactBaseSchema.parse(next).personalStatements?.length, 1);
  assert.deepEqual(projectResume(next, document.resumeViews[0]!), rendered);
  assert.equal(approveCareerTaskStatement(next, fixture(), "fact-1"), next);
});
test("facts fail closed on missing/foreign proposal or non-personal sources, corrections retain previous statements", () => {
  const base = createInitialDocument().factBase, task = fixture();
  assert.throws(() => approveCareerTaskStatement(base, task, "missing"));
  task.evidence[0]!.kind = "design";
  assert.throws(() => approveCareerTaskStatement(base, task, "fact-1"));
  task.evidence[0]!.kind = "user_statement";
  const first = approveCareerTaskStatement(base, task, "fact-1");
  task.id = "ct_correction"; task.facts[0]!.text = "我参与测试。"; task.evidence[0]!.excerpt = "我参与测试。";
  const next = approveCareerTaskStatement(first, task, "fact-1", "2026-01-03T00:00:00.000Z", first.personalStatements![0]!.id);
  assert.equal(next.personalStatements?.length, 2);
  assert.equal(next.personalStatements?.[0]?.text, "我负责测试。");
  assert.equal(next.personalStatements?.[1]?.supersedes, first.personalStatements![0]!.id);
});
test("tailoring intent opens consent only for explicit preparation, not ordinary chat or architecture advice", () => {
  for (const text of ["针对这个岗位，帮我准备定制简历", "请根据这个职位优化简历", "Tailor my resume for this job"]) assert.equal(isCareerTailoringRequest(text), true);
  for (const text of ["如何设计定制简历Agent系统？", "解释一下这个岗位", "聊聊我的简历", "帮我改这一句话"]) assert.equal(isCareerTailoringRequest(text), false);
});
