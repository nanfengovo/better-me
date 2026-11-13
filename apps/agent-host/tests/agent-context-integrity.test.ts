import assert from "node:assert/strict";
import test from "node:test";
import { CareerTaskSchema } from "@better-me/agent-contracts";
import { taskContext } from "../src/kernel/context.js";
import { NativeOutput } from "../src/native-tools/adapters.js";
import { nativeSandboxProfile } from "../src/native-tools/process.js";
import { evidence } from "../src/tasks/evidence.js";

test("default material reads retain the full text, including long lines and later lines", () => {
  const full = "START_" + "x".repeat(10000) + "\n" + Array.from({ length: 80 }, (_, i) => `LINE_${i}`).join("\n") + "_END";
  assert.equal(evidence("source", "synthetic", "Synthetic", full).excerpt, full);
  assert.equal(evidence("source", "synthetic", "Synthetic", full, 2, 3).excerpt, "LINE_0\nLINE_1");
});

test("Codex keeps multiple complete assistant messages rather than replacing the earlier output", () => {
  const output = new NativeOutput("codex");
  output.feed('{"type":"thread.started"}\n{"type":"turn.started"}\n');
  for (const text of ["FIRST_COMPLETE_MESSAGE", "SECOND_COMPLETE_MESSAGE"]) output.feed(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }) + "\n");
  output.feed('{"type":"turn.completed"}\n');
  assert.equal(output.finish(), "FIRST_COMPLETE_MESSAGE\n\nSECOND_COMPLETE_MESSAGE");
});

test("career retrieval retains full source records/observations and exposes every omitted excerpt for explicit reread", () => {
  const evidence = Array.from({ length: 72 }, (_, i) => ({ id: `ev_${i}`, kind: "source", sourceId: `material:${i}`, label: `Source ${i}`, hash: `hash-${i}`, excerpt: `${i === 0 ? "EARLY_SOURCE_" + "x".repeat(30000) : "source"} END_${i}` }))
    .map(item=>({...item,startOffset:0,endOffset:item.excerpt.length,sourceLength:item.excerpt.length,startLine:1,endLine:1}));
  const task = CareerTaskSchema.parse({ id: "ct_integrity", ownerId: "synthetic", workspaceKey: "synthetic", objective: "Verify complete context", status: "ready", revision: 1, createdAt: "now", updatedAt: "now",
    job: { title: "Synthetic", company: "", description: "Synthetic" }, resume: { id: "synthetic", name: "Synthetic", sourceFingerprint: "hash", fields: [{ id: "headline", targetRef: { kind: "profile_headline", locale: "zh" }, originalText: "Original" }] }, materials: [], directories: [], runtimeBinding: { id: "synthetic", label: "Synthetic", location: "local" }, budget: { maxModelCalls: 1, maxToolCalls: 1, maxActiveMs: 10000 }, usage: { modelCalls: 0, toolCalls: 0, activeMs: 0 }, events: [], evidence, facts: [] });
  const recent = Array.from({ length: 14 }, (_, i) => ({ tool: "read_material", result: "x".repeat(7000) + ` OBSERVATION_END_${i}` }));
  const original=structuredClone(task.evidence);
  const result = taskContext(task, recent);
  assert.equal(result.retrieval.version,"bm25-v1");
  assert.equal(result.retrieval.selected.length,6);
  assert.deepEqual(task.evidence,original,"selection never replaces complete stored excerpts");
  assert.equal(result.evidenceIndex.length, 72);
  assert.equal(result.evidenceManifest.length,72);
  assert.deepEqual(result.recentObservations, recent);
  assert.equal(result.indexTruncated, false);
});

test("Codex's exact pre-turn disabled-helper warning is metadata, not a truncated or tool-enabled result", () => {
  const output = new NativeOutput("codex");
  output.feed(JSON.stringify({ type: "thread.started", thread_id: "synthetic" }) + "\n");
  output.feed(JSON.stringify({ type: "item.completed", item: { id: "warning", type: "error", message: "Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`." } }) + "\n");
  output.feed('{"type":"turn.started"}\n');
  const answer = "START_" + "完整输出".repeat(18000) + "_END";
  output.feed(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: answer } }) + "\n{\"type\":\"turn.completed\"}\n");
  assert.equal(output.finish(), answer);
  for (const item of [{ type: "error", message: "Other failure" }, { type: "command_execution", command: "read_file" }, { type: "function_call", name: "request_user_input", arguments: "{}" }]) {
    const rejected = new NativeOutput("codex"); rejected.feed('{"type":"thread.started"}\n');
    assert.throws(() => rejected.feed(JSON.stringify({ type: "item.completed", item }) + "\n"));
  }
});

test("Codex policy access is opt-in, domain-only and read-only, with no shared-memory wildcard", () => {
  const ordinary = nativeSandboxProfile("/synthetic/run", [], 1);
  assert.doesNotMatch(ordinary, /cfprefs|user-preference/);
  const codex = nativeSandboxProfile("/synthetic/run", [], 1, false, true);
  assert.match(codex, /user-preference-read \(preference-domain "com\.openai\.codex"\)/);
  assert.match(codex, /ipc-posix-shm-read-data/);
  assert.doesNotMatch(codex, /user-preference-write|ipc-posix-name-prefix|allow ipc-posix-shm\)/);
});
