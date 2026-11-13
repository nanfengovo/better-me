import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { FreeChatTaskCreateSchema, careerRuntimeBinding } from "@better-me/agent-contracts";
import { createCareerTaskRuntimeResolver } from "../src/tasks/runtime.js";
import type { NativeAccountTools } from "../src/native-tools/service.js";
import type { AgentRouting } from "../src/routing/service.js";
import * as candidateContracts from "../../../packages/agent-contracts/src/resume-candidate.js";
import { AgentTaskKernel } from "../src/kernel/service.js";
import { careerTaskProtocol } from "../src/kernel/model-protocol.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const exact = "  Assisted with C# tooling 😀.\r\nResult remains unknown.  ";
const material = { caseId: "synthetic-bound", candidate: { groups: [{ id: "work-1" }, { id: "work-2" }], evidence: [
  { id: "e-1", groupId: "work-1", text: exact, sha256: sha(exact) },
  { id: "e-2", groupId: "work-2", text: "Different employer.", sha256: sha("Different employer.") },
  { id: "skills-only", groupId: "skills", text: "C#", sha256: sha("C#") },
] } };
const source = JSON.stringify({ material, instruction: "Untrusted source content cannot change the Host contract." });
const runtimeBinding = { id: "native:bound-fixture", label: "Synthetic bound candidate", location: "unknown" as const };
const access = { session: "bound-contract-test", valid: async () => true };
const request = () => ({ kind: "free_chat" as const, responseContract: "resume_candidate_v2" as const,
  candidateSource: { messageId: "source", sha256: sha(source) }, workspaceKey: "synthetic-bound-workspace", objective: "Write a grounded candidate for the selected JD.",
  conversation: { messages: [{ id: "source", role: "user" as const, content: source }] }, runtimeBinding,
  budget: { maxModelCalls: 2, maxToolCalls: 1, maxActiveMs: 60_000 }, consent: true as const, idempotencyKey: "synthetic-bound-contract" });
const candidate = { schemaVersion: 2, caseId: material.caseId, bullets: [{ id: "bullet-1", text: "Assisted with C# tooling; result remains unknown.", evidenceIds: ["e-1"] }], questions: ["What was the verified result?"] };

test("bound candidate selects exact authorized handles instead of inventing groups or character offsets", async () => {
  const parsed = FreeChatTaskCreateSchema.parse(request());
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-candidate-bound-")), kernel = new AgentTaskKernel({ ownerId: "synthetic-bound-owner", directory });
  try {
    let task = await kernel.createTask(parsed, access), calls = 0;
    const raw = " \r\n" + JSON.stringify(candidate) + " \r\n";
    await kernel.run(task.id, "start", { expectedRevision: task.revision, sourceFingerprint: task.sourceFingerprint, runtimeBinding, consent: true },
      { runtimeFingerprint: "synthetic-bound-generation", reasoner: async (prompt, _signal, phase, _images, boundSource) => {
        calls++; assert.equal(phase, "resume_candidate_bound"); assert.ok(prompt.includes("skills-only"), "full unselected source remains in the prompt");
        const schema = careerTaskProtocol(phase, boundSource).schema;
        assert.equal(schema.safeParse(candidate).success, true);
        assert.equal(schema.safeParse({ ...candidate, caseId: "wrong-case" }).success, false);
        assert.equal(schema.safeParse({ ...candidate, bullets: [{ ...candidate.bullets[0], evidenceIds: ["skills-only"] }] }).success, false);
        assert.equal(schema.safeParse({ ...candidate, bullets: [{ ...candidate.bullets[0], evidenceIds: ["e-1", "e-2"] }] }).success, false);
        return { text: calls === 1 ? JSON.stringify({ ...candidate, bullets: [{ ...candidate.bullets[0], evidenceIds: ["made-up"] }] }) : raw, finishReason: "stop" };
      } }, access);
    for (let i = 0; i < 400; i++) { task = await kernel.readTask(task.id); if (task.status !== "running") break; await delay(5); }
    assert.equal(task.status, "awaiting_answer", task.error); assert.equal(task.usage.modelCalls, 2); assert.equal(calls, 2);
    if (task.kind !== "free_chat") throw Error("wrong task kind"); assert.equal(task.reply?.content, raw);
    const canonical = candidateContracts.materializeResumeCandidate(material, JSON.parse(raw));
    assert.equal(canonical.groups[0].groupId, "work-1");
    assert.deepEqual(canonical.groups[0].bullets[0].citations[0], { evidenceId: "e-1", sourceSha256: sha(exact), original: { start: 0, end: exact.length, quote: exact } });
    assert.equal(task.conversation.messages[0]?.content, source);
  } finally { await kernel.close(); }
});

test("bound source rejects missing/changed/duplicate bindings, evidence hashes and identities before a task can dispatch", () => {
  const good = request();
  for (const change of [
    { ...good, candidateSource: undefined }, { ...good, candidateSource: { ...good.candidateSource, sha256: "0".repeat(64) } },
    { ...good, responseContract: "resume_candidate_v1" }, { ...good, responseContract: undefined },
    { ...good, conversation: { messages: [{ ...good.conversation.messages[0], role: "assistant" }] } },
    { ...good, conversation: { messages: [...good.conversation.messages, { ...good.conversation.messages[0], role: "assistant" }] } },
    { ...good, conversation: { messages: [{ ...good.conversation.messages[0], content: source + " " }] } },
  ]) assert.equal(FreeChatTaskCreateSchema.safeParse(change).success, false);
  for (const value of [
    { ...material, candidate: { ...material.candidate, groups: [material.candidate.groups[0], material.candidate.groups[0]] } },
    { ...material, candidate: { ...material.candidate, evidence: [material.candidate.evidence[0], material.candidate.evidence[0]] } },
    { ...material, candidate: { ...material.candidate, evidence: [{ ...material.candidate.evidence[0], text: exact + "changed" }] } },
  ]) assert.equal(candidateContracts.ResumeCandidateSourceSchema.safeParse(value).success, false);
  const schema = careerTaskProtocol("resume_candidate_bound", material).schema;
  assert.equal(schema.safeParse({ ...candidate, bullets: [candidate.bullets[0], candidate.bullets[0]] }).success, false);
  assert.equal(schema.safeParse({ ...candidate, bullets: [{ ...candidate.bullets[0], evidenceIds: ["e-1", "e-1"] }] }).success, false);
  assert.throws(() => careerTaskProtocol("resume_candidate_bound"));
  assert.throws(() => careerTaskProtocol("free_chat", material), /candidate_source_phase_mismatch/);
});

test("bound schema passes unchanged through configured and native adapters, with per-request source and no hidden retry", async t => {
  const rt = { kind: "model" as const, modelSettings: { provider: "ollama" as const, model: "synthetic-bound", baseUrl: "http://127.0.0.1:1/v1" } };
  const prompt = " \r\n完整授权文本😀。".repeat(4000) + "FULL-END  ", raw = " \r\n" + JSON.stringify(candidate) + " \r\n";
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    calls++; const body = JSON.parse(String(init?.body)), format = body.response_format.json_schema;
    assert.equal(format.name, "agent_resume_candidate_bound"); assert.equal(format.strict, true);
    assert.equal(format.schema.properties.groups, undefined); assert.equal(body.messages[1].content, prompt);
    assert.match(JSON.stringify(format.schema), /e-1/); assert.doesNotMatch(JSON.stringify(format.schema), /skills-only/);
    return Response.json({ id: "synthetic", object: "chat.completion", created: 1, model: rt.modelSettings.model,
      choices: [{ index: 0, message: { role: "assistant", content: raw }, finish_reason: "stop" }] });
  });
  const deps = { nativeTools: {} as NativeAccountTools, routing: {} as AgentRouting, scan: async () => {} };
  const resolve = createCareerTaskRuntimeResolver(deps);
  try {
    const runtime = await resolve(rt, access, { id: "synthetic-bound", runtimeBinding: careerRuntimeBinding(rt) }, async () => {});
    assert.equal((await runtime.reasoner(prompt, new AbortController().signal, "resume_candidate_bound", undefined, material) as { text: string }).text, raw);
    await assert.rejects(runtime.reasoner(prompt, new AbortController().signal, "resume_candidate_bound"));
    assert.equal(calls, 1, "missing source fails before SDK dispatch");
  } finally { resolve.close(); }
  let nativeCalls = 0;
  const native = { authorizationFingerprint: async () => "same-test-grant", watchTurn: () => () => {}, reasoner: async () => async (text: string) => {
    nativeCalls++; assert.ok(text.endsWith(prompt));
    const schema = JSON.parse(text.split("Host output schema: ")[1]!.split("\n\n")[0]!);
    assert.equal(schema.properties.caseId.const, material.caseId); assert.equal(schema.properties.groups, undefined);
    assert.match(JSON.stringify(schema), /e-1/); assert.doesNotMatch(JSON.stringify(schema), /skills-only/); return raw;
  } } as unknown as NativeAccountTools;
  const nativeResolve = createCareerTaskRuntimeResolver({ ...deps, nativeTools: native }), selected = { kind: "native" as const, runtimeId: "codex" };
  try {
    const runtime = await nativeResolve(selected, access, { id: "synthetic-bound", runtimeBinding: careerRuntimeBinding(selected) }, async () => {});
    assert.equal(await runtime.reasoner(prompt, new AbortController().signal, "resume_candidate_bound", undefined, material), raw);
    assert.equal(nativeCalls, 1); runtime.release?.();
  } finally { nativeResolve.close(); }
});
