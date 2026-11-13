import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { FreeChatTaskCreateSchema, resumeCandidateWorkInventory, reviewResumeCandidateWorkCoverage } from "@better-me/agent-contracts";
import { AgentTaskKernel } from "../src/kernel/service.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const runtimeBinding = { id: "native:synthetic-career-coverage", label: "Synthetic coverage fixture", location: "unknown" as const };
const access = { session: "synthetic-coverage", valid: async () => true };
const material = { caseId: "synthetic-current-role", candidate: {
  groups: [
    { id: "current", title: "Engineer", organization: "Synthetic A", originalPeriod: "2024-03 - present", kind: "employment" },
    { id: "old", title: "Engineer", organization: "Synthetic B", originalPeriod: "2017 - 2020", kind: "employment" },
    { id: "portfolio", title: "Training demo", organization: "Personal", originalPeriod: "Not stated", kind: "portfolio" },
  ], evidence: [
    { id: "current-action", groupId: "current", text: "Assisted the team with C# device integration." },
    { id: "old-action", groupId: "old", text: "Built a Vue monitoring page." },
    { id: "demo-action", groupId: "portfolio", text: "Built a personal monitoring demo with Vue." },
  ].map(e => ({ ...e, sha256: sha(e.text) })),
} };
const source = JSON.stringify({ material });
const raw = " \r\n" + JSON.stringify({ schemaVersion: 2, caseId: material.caseId,
  bullets: [{ id: "demo", text: material.candidate.evidence[2]!.text, evidenceIds: ["demo-action"] }], questions: [] }) + " \r\n";

test("ongoing work inventory keeps original dates, exposes uncertainty, and never promotes projects or guesses the newest former role", () => {
  for (const period of ["Since 2024", "Since 2024-03", "2025-06 - present", "2024 – Current", "Jan 2017 - Present", "January 2017 - Present",
    "2024.03—至今", "2024年3月-至今", "Present", "至今", "Until Now / 10,2022 (original fields; chronology unresolved)"]) {
    const copy = structuredClone(material); copy.candidate.groups[0]!.originalPeriod = period;
    const before = JSON.stringify(copy), inventory = resumeCandidateWorkInventory(copy);
    assert.deepEqual(inventory.requiredGroups.map(g => g.id), ["current"], period);
    assert.equal(inventory.requiredGroups[0]!.originalPeriod, period); assert.equal(JSON.stringify(copy), before);
  }
  for (const period of ["2024", "2020 - 2024", "2024-13 - present", "Not stated", "2024?", "not current", "former: 2024 - present",
    "08.2022 / 01,2020 (original fields; chronology unresolved)", "Until Now / unknown", "2024 - 2025 / present?"]) {
    const copy = structuredClone(material); copy.candidate.groups[0]!.originalPeriod = period;
    assert.equal(resumeCandidateWorkInventory(copy).requiredGroups.length, 0, period);
    assert.ok(resumeCandidateWorkInventory(copy).unassessedGroups.some(g => g.id === "current"));
  }
  for (const kind of ["portfolio", "project", "training", "academic", "fictional_practice"]) {
    const copy = structuredClone(material); copy.candidate.groups[0]!.kind = kind;
    assert.equal(resumeCandidateWorkInventory(copy).requiredGroups.length, 0, kind);
  }
  const noSource = structuredClone(material); noSource.candidate.evidence = noSource.candidate.evidence.filter(e => e.groupId !== "current");
  const noSourceInventory = resumeCandidateWorkInventory(noSource);
  assert.equal(noSourceInventory.requiredGroups.length, 0);
  assert.equal(noSourceInventory.unassessedGroups.find(g => g.id === "current")?.reason, "no_citable_source_unit");
  const wire = JSON.parse(raw), review = reviewResumeCandidateWorkCoverage(material, wire);
  assert.deepEqual(review.missingCurrentGroups.map(g => g.id), ["current"]);
  assert.deepEqual(review.selectedGroupIds, ["portfolio"]); assert.equal(review.overallQualityPassed, null);
  wire.questions = ["Should I include current work?"];
  assert.equal(reviewResumeCandidateWorkCoverage(material, wire).missingCurrentGroups.length, 1, "questions do not erase available current work");
  wire.bullets.push({ id: "ongoing", text: material.candidate.evidence[0]!.text, evidenceIds: ["current-action"] });
  assert.equal(reviewResumeCandidateWorkCoverage(material, wire).missingCurrentGroups.length, 0);
  assert.deepEqual(reviewResumeCandidateWorkCoverage(material, wire).unassessedGroups.map(g => g.id), ["old"], "older work is not forced into one page");
  const multiple = structuredClone(material); multiple.candidate.groups[1]!.originalPeriod = "Since 2023";
  assert.deepEqual(reviewResumeCandidateWorkCoverage(multiple, wire).missingCurrentGroups.map(g => g.id), ["old"], "parallel current source roles remain distinct");
});

test("a full resume cannot silently replace explicitly ongoing work with portfolio-only bullets", async () => {
  const request = FreeChatTaskCreateSchema.parse({ kind: "free_chat", responseContract: "resume_candidate_v5",
    candidateSource: { messageId: "source", sha256: sha(source) }, workspaceKey: "synthetic-current-role", objective: "Write a full source-grounded resume.",
    conversation: { messages: [{ id: "source", role: "user", content: source }] }, runtimeBinding,
    budget: { maxModelCalls: 1, maxToolCalls: 1, maxActiveMs: 60000 }, consent: true, idempotencyKey: "synthetic-current-role" });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-current-role-"));
  const kernel = new AgentTaskKernel({ ownerId: "synthetic-coverage", directory }); let calls = 0;
  try {
    let task = await kernel.createTask(request, access);
    await kernel.run(task.id, "start", { expectedRevision: task.revision, sourceFingerprint: task.sourceFingerprint, runtimeBinding, consent: true },
      { runtimeFingerprint: "synthetic-coverage", reasoner: async () => { calls++; return { text: raw, finishReason: "stop" }; } }, access);
    for (let i = 0; i < 400; i++) { task = await kernel.readTask(task.id); if (task.status !== "running") break; await delay(5); }
    assert.equal(task.status, "budget_exhausted", "explicitly ongoing employment must not disappear from a full resume candidate");
    assert.equal(task.reply, undefined); assert.equal(calls, 1); assert.equal(task.usage.modelCalls, 1);
    const stored = JSON.parse(await fs.readFile(path.join(directory, `${task.id}.json`), "utf8"));
    assert.equal(stored.recent.find((r: { kind: string }) => r.kind === "free_chat_output").output, raw);
    assert.equal(stored.recent.find((r: { kind: string }) => r.kind === "free_chat_rejected").code, "candidate_current_work_omitted");
    assert.equal(task.conversation.messages[0]?.content, source);
  } finally { await kernel.close(); }
});

test("same-root repair receives the complete source, rejected wire and current-group inventory without forcing older work or fabricating results", async () => {
  const request = FreeChatTaskCreateSchema.parse({ kind: "free_chat", responseContract: "resume_candidate_v5",
    candidateSource: { messageId: "source", sha256: sha(source) }, workspaceKey: "synthetic-current-repair", objective: "Write a full source-grounded resume.",
    conversation: { messages: [{ id: "source", role: "user", content: source }] }, runtimeBinding,
    budget: { maxModelCalls: 2, maxToolCalls: 1, maxActiveMs: 60000 }, consent: true, idempotencyKey: "synthetic-current-repair" });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-current-repair-"));
  const kernel = new AgentTaskKernel({ ownerId: "synthetic-coverage", directory }); let calls = 0;
  const good = " \r\n" + JSON.stringify({ schemaVersion: 2, caseId: material.caseId,
    bullets: [{ id: "ongoing", text: "Assisted the team with C# device integration.", evidenceIds: ["current-action"] }],
    questions: ["What device integration result can you confirm for Synthetic A?"] }) + " \r\n";
  try {
    let task = await kernel.createTask(request, access);
    await kernel.run(task.id, "start", { expectedRevision: task.revision, sourceFingerprint: task.sourceFingerprint, runtimeBinding, consent: true },
      { runtimeFingerprint: "synthetic-coverage-repair", reasoner: async (prompt, _signal, phase) => {
        calls++; assert.equal(phase, "resume_candidate_bound");
        const state = JSON.parse(prompt.split("\n\n").at(-1)!);
        assert.equal(state.conversation.messages[0].content, source);
        assert.deepEqual(state.currentWorkInventory.requiredGroups.map((g: { id: string }) => g.id), ["current"]);
        if (calls === 1) return { text: raw, finishReason: "stop" };
        assert.equal(state.observations.find((r: { kind: string }) => r.kind === "free_chat_output").output, raw);
        const rejection = state.observations.find((r: { kind: string }) => r.kind === "free_chat_rejected");
        assert.equal(rejection.code, "candidate_current_work_omitted");
        assert.deepEqual(rejection.workCoverage.missingCurrentGroups.map((g: { id: string }) => g.id), ["current"]);
        assert.equal(rejection.workCoverage.requiredGroups[0].originalPeriod, material.candidate.groups[0]!.originalPeriod);
        return { text: good, finishReason: "stop" };
      } }, access);
    for (let i = 0; i < 400; i++) { task = await kernel.readTask(task.id); if (task.status !== "running") break; await delay(5); }
    assert.equal(task.status, "awaiting_answer", task.error); assert.equal(task.reply?.content, good);
    assert.equal(calls, 2); assert.equal(task.usage.modelCalls, 2); assert.equal(task.usage.toolCalls, 0);
    assert.equal(task.rootLedger?.usage.modelCalls, 2); assert.equal(task.budget.maxModelCalls, 2);
    const stored = JSON.parse(await fs.readFile(path.join(directory, `${task.id}.json`), "utf8"));
    assert.deepEqual(stored.recent.filter((r: { kind: string }) => r.kind === "free_chat_output").map((r: { output: string }) => r.output), [raw, good]);
    await kernel.close();
    const restored = new AgentTaskKernel({ ownerId: "synthetic-coverage", directory });
    try { assert.equal((await restored.readTask(task.id)).reply?.content, good); assert.equal(calls, 2); } finally { await restored.close(); }
  } finally { await kernel.close(); }
});

test("historical v4 preserves its accepted output and prompt, without silently applying the v5 career-presence policy", async () => {
  const request = FreeChatTaskCreateSchema.parse({ kind: "free_chat", responseContract: "resume_candidate_v4",
    candidateSource: { messageId: "source", sha256: sha(source) }, workspaceKey: "synthetic-current-historical", objective: "Write a full source-grounded resume.",
    conversation: { messages: [{ id: "source", role: "user", content: source }] }, runtimeBinding,
    budget: { maxModelCalls: 1, maxToolCalls: 1, maxActiveMs: 60000 }, consent: true, idempotencyKey: "synthetic-current-historical" });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-current-historical-"));
  const kernel = new AgentTaskKernel({ ownerId: "synthetic-coverage", directory }); let calls = 0;
  try {
    let task = await kernel.createTask(request, access);
    await kernel.run(task.id, "start", { expectedRevision: task.revision, sourceFingerprint: task.sourceFingerprint, runtimeBinding, consent: true },
      { runtimeFingerprint: "synthetic-coverage-historical", reasoner: async prompt => {
        calls++; assert.doesNotMatch(prompt, /Current-work presence policy v1/);
        assert.equal(JSON.parse(prompt.split("\n\n").at(-1)!).currentWorkInventory, undefined);
        return { text: raw, finishReason: "stop" };
      } }, access);
    for (let i = 0; i < 400; i++) { task = await kernel.readTask(task.id); if (task.status !== "running") break; await delay(5); }
    assert.equal(task.status, "awaiting_answer"); assert.equal(task.reply?.content, raw); assert.equal(calls, 1);
  } finally { await kernel.close(); }
});
