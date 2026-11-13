import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { FreeChatTaskCreateSchema, reviewResumeCandidateAttribution } from "@better-me/agent-contracts";
import { AgentTaskKernel } from "../src/kernel/service.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const research = "Developed a suite of utilities to semi-automate the X-ray astronomical data analysis.";
const material = { caseId: "synthetic-attribution", candidate: {
  groups: [{ id: "internship", title: "Data Engineer", organization: "Synthetic employer", originalPeriod: "2018", kind: "internship" }],
  evidence: [
    { id: "amazon", groupId: "internship", text: "Data Engineer internship. Search and scrape Amazon data using Python/Requests/BeautifulSoup." },
    { id: "research", groupId: "academic", kind: "academic", text: "Research Achievements. Developed a suite of utilities to semi-automate the X-ray astronomical data analysis: Research project B." },
  ].map(e => ({ ...e, sha256: sha(e.text) })),
} };
const source = JSON.stringify({ material });
const runtimeBinding = { id: "native:synthetic-attribution", label: "Synthetic attribution", location: "unknown" as const };
const access = { session: "synthetic-attribution", valid: async () => true };

const candidate = (text = research, evidenceIds = ["amazon"]) => ({ schemaVersion: 2, caseId: material.caseId,
  bullets: [{ id: "bullet-1", text, evidenceIds }], questions: [] });

test("source conflict review retains full uncited provenance, never substitutes a citation or certifies a paraphrase", () => {
  const wire = candidate(), before = JSON.stringify({ material, wire });
  const findings = reviewResumeCandidateAttribution(material, wire);
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0]?.matchingSources, [material.candidate.evidence[1]]);
  assert.equal(findings[0]?.citedGroupId, "internship");
  assert.deepEqual(findings[0]?.citedEvidenceIds, ["amazon"]);
  assert.equal(JSON.stringify({ material, wire }), before);
  assert.equal(reviewResumeCandidateAttribution(material, candidate("  DEVELOPED a suite of utilities to\nsemi-automate the X-ray astronomical data analysis!  ")).length, 1);
  assert.deepEqual(reviewResumeCandidateAttribution(material, candidate(material.candidate.evidence[0]!.text)), []);
  assert.deepEqual(reviewResumeCandidateAttribution(material, candidate("Invented Kafka outcome 99999.")), [], "absence of an exact source conflict is not semantic approval");
  assert.throws(() => reviewResumeCandidateAttribution(material, candidate(research, ["research"])), "non-delivery sources cannot become legal work handles");
  const sameGroup = structuredClone(material); sameGroup.candidate.evidence[1]!.groupId = "internship";
  assert.equal(reviewResumeCandidateAttribution(sameGroup, wire).length, 1, "a wrong unit within the same role still needs an accurate citation");
  assert.deepEqual(reviewResumeCandidateAttribution(sameGroup, candidate(research, ["research"])), []);
  const duplicatedSupport = structuredClone(material);
  duplicatedSupport.candidate.evidence[0]!.text = "Internship. " + research;
  duplicatedSupport.candidate.evidence[0]!.sha256 = sha(duplicatedSupport.candidate.evidence[0]!.text);
  assert.deepEqual(reviewResumeCandidateAttribution(duplicatedSupport, wire), [], "a cited matching unit is not invalid just because wording also occurs elsewhere");
});

test("candidate cannot turn an exact academic contribution into internship work by choosing a valid internship handle", async () => {
  const request = FreeChatTaskCreateSchema.parse({ kind: "free_chat", responseContract: "resume_candidate_v4",
    candidateSource: { messageId: "source", sha256: sha(source) }, workspaceKey: "synthetic-attribution", objective: "Write a source-grounded resume.",
    conversation: { messages: [{ id: "source", role: "user", content: source }] }, runtimeBinding,
    budget: { maxModelCalls: 1, maxToolCalls: 1, maxActiveMs: 60000 }, consent: true, idempotencyKey: "synthetic-attribution" });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-candidate-attribution-"));
  const kernel = new AgentTaskKernel({ ownerId: "synthetic-attribution", directory });
  const raw = " \r\n" + JSON.stringify({ schemaVersion: 2, caseId: material.caseId,
    bullets: [{ id: "bullet-1", text: research, evidenceIds: ["amazon"] }], questions: [] }) + " \r\n";
  let calls = 0;
  try {
    let task = await kernel.createTask(request, access);
    await kernel.run(task.id, "start", { expectedRevision: task.revision, sourceFingerprint: task.sourceFingerprint, runtimeBinding, consent: true },
      { runtimeFingerprint: "synthetic-attribution", reasoner: async () => { calls++; return { text: raw, finishReason: "stop" }; } }, access);
    for (let i = 0; i < 400; i++) { task = await kernel.readTask(task.id); if (task.status !== "running") break; await delay(5); }
    assert.equal(task.status, "budget_exhausted", "valid handle must not bypass the attribution conflict guard");
    assert.equal(task.reply, undefined); assert.equal(calls, 1); assert.equal(task.usage.modelCalls, 1);
    const stored = JSON.parse(await fs.readFile(path.join(directory, `${task.id}.json`), "utf8"));
    assert.equal(stored.recent.find((r: { kind: string }) => r.kind === "free_chat_output").output, raw);
    assert.equal(stored.recent.find((r: { kind: string }) => r.kind === "free_chat_rejected").code, "candidate_source_attribution_conflict");
    assert.equal(task.conversation.messages[0]?.content, source);
  } finally { await kernel.close(); }
});

test("attribution repair receives complete rejected wire and full conflicting sources, and consumes only the original root budget", async () => {
  const request = FreeChatTaskCreateSchema.parse({ kind: "free_chat", responseContract: "resume_candidate_v4",
    candidateSource: { messageId: "source", sha256: sha(source) }, workspaceKey: "synthetic-attribution-repair", objective: "Write a source-grounded resume.",
    conversation: { messages: [{ id: "source", role: "user", content: source }] }, runtimeBinding,
    budget: { maxModelCalls: 2, maxToolCalls: 1, maxActiveMs: 60000 }, consent: true, idempotencyKey: "synthetic-attribution-repair" });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-candidate-attribution-repair-"));
  const kernel = new AgentTaskKernel({ ownerId: "synthetic-attribution", directory });
  const bad = " \r\n" + JSON.stringify(candidate()) + " \r\n";
  const good = " \r\n" + JSON.stringify({ ...candidate("Search and scrape Amazon data using Python/Requests/BeautifulSoup."),
    questions: ["Should the academic X-ray research be presented in a separately confirmed academic section?"] }) + " \r\n";
  let calls = 0;
  try {
    let task = await kernel.createTask(request, access);
    await kernel.run(task.id, "start", { expectedRevision: task.revision, sourceFingerprint: task.sourceFingerprint, runtimeBinding, consent: true },
      { runtimeFingerprint: "synthetic-attribution-repair", reasoner: async (prompt, _signal, phase) => {
        calls++; assert.equal(phase, "resume_candidate_bound");
        const state = JSON.parse(prompt.split("\n\n").at(-1)!);
        assert.equal(state.conversation.messages[0].content, source);
        if (calls === 1) return { text: bad, finishReason: "stop" };
        assert.equal(state.observations.find((r: { kind: string }) => r.kind === "free_chat_output").output, bad);
        const rejection = state.observations.find((r: { kind: string }) => r.kind === "free_chat_rejected");
        assert.equal(rejection.code, "candidate_source_attribution_conflict");
        assert.deepEqual(rejection.attribution[0].matchingSources, [material.candidate.evidence[1]]);
        return { text: good, finishReason: "stop" };
      } }, access);
    for (let i = 0; i < 400; i++) { task = await kernel.readTask(task.id); if (task.status !== "running") break; await delay(5); }
    assert.equal(task.status, "awaiting_answer", task.error); assert.equal(task.reply?.content, good);
    assert.equal(calls, 2); assert.equal(task.usage.modelCalls, 2); assert.equal(task.usage.toolCalls, 0);
    const stored = JSON.parse(await fs.readFile(path.join(directory, `${task.id}.json`), "utf8"));
    assert.deepEqual(stored.recent.filter((r: { kind: string }) => r.kind === "free_chat_output").map((r: { output: string }) => r.output), [bad, good]);
    assert.equal(stored.task.budget.maxModelCalls, 2);
    await kernel.close();
    const restored = new AgentTaskKernel({ ownerId: "synthetic-attribution", directory });
    try { assert.equal((await restored.readTask(task.id)).reply?.content, good); assert.equal(calls, 2); } finally { await restored.close(); }
  } finally { await kernel.close(); }
});

test("historical v3 retains its original acceptance policy, not silently regraded as v4", async () => {
  const request = FreeChatTaskCreateSchema.parse({ kind: "free_chat", responseContract: "resume_candidate_v3",
    candidateSource: { messageId: "source", sha256: sha(source) }, workspaceKey: "synthetic-attribution-historical", objective: "Write a source-grounded resume.",
    conversation: { messages: [{ id: "source", role: "user", content: source }] }, runtimeBinding,
    budget: { maxModelCalls: 1, maxToolCalls: 1, maxActiveMs: 60000 }, consent: true, idempotencyKey: "synthetic-attribution-historical" });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-candidate-attribution-historical-"));
  const kernel = new AgentTaskKernel({ ownerId: "synthetic-attribution", directory });
  const raw = JSON.stringify(candidate()); let calls = 0;
  try {
    let task = await kernel.createTask(request, access);
    await kernel.run(task.id, "start", { expectedRevision: task.revision, sourceFingerprint: task.sourceFingerprint, runtimeBinding, consent: true },
      { runtimeFingerprint: "synthetic-attribution-historical", reasoner: async prompt => {
        calls++; assert.doesNotMatch(prompt, /Source-attribution policy v1/); return { text: raw, finishReason: "stop" };
      } }, access);
    for (let i = 0; i < 400; i++) { task = await kernel.readTask(task.id); if (task.status !== "running") break; await delay(5); }
    assert.equal(task.status, "awaiting_answer"); assert.equal(task.reply?.content, raw); assert.equal(calls, 1);
  } finally { await kernel.close(); }
});
