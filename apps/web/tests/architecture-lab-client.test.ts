import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createCareerArchitectureAdapters } from "../src/services/career-architecture-client";
import { architectureDocumentFingerprint, architectureGraphFingerprint, createArchitectureDocument, newArchitectureNode,
  simulateArchitectureFault, type ArchitectureBinding, type ArchitectureDocument } from "../src/lib/architecture-lab";
import type { StudioRequest } from "../src/services/career-studio-client";

const binding: ArchitectureBinding = { ownerId: "synthetic-owner", sessionGeneration: 2, projectId: "stable-resume", revision: "b".repeat(64), contentHash: "b".repeat(64) };
const evidence = [{ id: "self-1", label: "本人选择的原句（自述，非独立源码证据）", excerpt: "本人选择的事务设计自述。" }];
const runtime = { model: "synthetic-local", modelDigest: "c".repeat(64) };
const signal = () => new AbortController().signal;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function record(document: ArchitectureDocument, revision = 1, mode: "current" | "graph-draft" = "current") {
  return { id: binding.projectId, revision, value: { schemaVersion: 1, contextId: "current-context", ownerId: binding.ownerId, workspaceKey: "synthetic-workspace", resumeId: binding.projectId,
    sourceFingerprint: binding.contentHash, mode, ...(mode === "graph-draft" ? { historicalContextId: "old-context" } : {}), value: structuredClone(document) } };
}
function adapters(request: StudioRequest, overrides: Partial<Parameters<typeof createCareerArchitectureAdapters>[0]> = {}) {
  return createCareerArchitectureAdapters({ contextId: "current-context", workspaceKey: "synthetic-workspace", request, getCurrentBinding: () => binding, getCurrentEvidence: () => evidence, ...overrides });
}
function graph() {
  const document = createArchitectureDocument(binding, evidence, "synthetic-graph"); document.nodes.push(newArchitectureNode("store", "store", 50, 50));
  document.nodes[0]!.evidenceIds = ["self-1"]; return document;
}

test("valid empty validation arrays no longer reject save/load; genuine metadata and exact CAS readback are required", async () => {
  const document = graph(), requests: { route: string; body: unknown }[] = [];
  const api = adapters(async (route, body) => { requests.push({ route, body }); return { record: record(document) }; });
  assert.equal(api.interview, undefined, "graph persistence does not depend on selecting a model");
  const saved = await api.storage.save({ binding, document, expectedVersion: null, fingerprint: architectureDocumentFingerprint(document) }, signal());
  assert.equal(saved.status, "saved"); assert.equal(saved.status === "saved" && saved.storageVersion, "1");
  const loaded = await api.storage.load(binding, signal()); assert.deepEqual(loaded?.document, document); assert.equal(loaded?.restoredGraphOnly, false);
  assert.deepEqual(requests.map(item => item.route), ["/artifact/save", "/artifact/load"]);
  assert.deepEqual((requests[0]!.body as { expectedRevision: number }).expectedRevision, 0);
  await assert.rejects(api.storage.save({ binding, document, expectedVersion: "01", fingerprint: architectureDocumentFingerprint(document) }, signal()), /CAS版本无效/);
  assert.equal(requests.length, 2, "invalid CAS never dispatches");
});

test("cross-context restores only graph drafts, prunes non-exact code references, and preserves the storage CAS token", async () => {
  const old = graph(); old.binding = { ...binding, sessionGeneration: 1 };
  old.evidence.push({ id: "old-code", label: "旧授权源码", excerpt: "PRIVATE_OLD_SOURCE", path: "old.ts", startLine: 1, endLine: 1 });
  old.nodes[0]!.evidenceIds.push("old-code"); old.faults.push(simulateArchitectureFault(old, { kind: "disk-full", targetNodeId: "store" }, { id: "old-fault" }));
  const oldText = JSON.stringify(old);
  const loaded = await adapters(async () => ({ record: record(old, 7, "graph-draft") })).storage.load(binding, signal());
  assert.equal(loaded?.storageVersion, "7"); assert.equal(loaded?.restoredGraphOnly, true);
  assert.deepEqual(loaded?.document.binding, binding); assert.deepEqual(loaded?.document.nodes[0]!.evidenceIds, ["self-1"]);
  assert.equal(loaded?.document.faults.length, 0); assert.equal(loaded?.document.turns.length, 0); assert.deepEqual(loaded?.document.evidence, evidence);
  assert.equal(JSON.stringify(old), oldText, "historical source is immutable");
});

test("foreign owner/workspace/context/source metadata and mismatching storage payloads are rejected without retry", async () => {
  const document = graph();
  for (const key of ["ownerId", "workspaceKey", "contextId", "resumeId", "sourceFingerprint"] as const) {
    const wrong = record(document); wrong.value[key] = "foreign";
    await assert.rejects(adapters(async () => ({ record: wrong })).storage.load(binding, signal()), /不匹配/);
  }
  let requests = 0;
  const wrong = { ...document, title: "其他载荷" };
  await assert.rejects(adapters(async () => { requests++; return { record: record(wrong) }; }).storage.save({ binding, document, expectedVersion: null, fingerprint: architectureDocumentFingerprint(document) }, signal()), /禁止重试/);
  assert.equal(requests, 1);
  const forged = graph(); forged.evidence[0]!.excerpt = "模型补写的无授权事实";
  await assert.rejects(adapters(async () => { throw Error("must not dispatch"); }).storage.save({ binding, document: forged, expectedVersion: null, fingerprint: architectureDocumentFingerprint(forged) }, signal()), /不属于当前授权/);
});

test("source import sends only current context, a completed operation reference and explicit consent, and rejects stale scopes", async () => {
  let sent: unknown, current = binding;
  const fresh = [...evidence, { id: "code-1", label: "已核对代码节选", excerpt: "const synthetic = true;", path: "transaction.ts", startLine: 1, endLine: 1 }];
  const api = adapters(async (route, body) => { assert.equal(route, "/architecture/evidence"); sent = body; return { contextId: "current-context", ownerId: binding.ownerId, workspaceKey: "synthetic-workspace",
    resumeId: binding.projectId, sourceFingerprint: binding.contentHash, receiptId: "a".repeat(64), evidence: fresh, limitations: ["不证明独立作者身份"] }; }, { getCurrentBinding: () => current });
  const result = await api.importEvidence(binding, "completed-committee", signal()); assert.deepEqual(result.evidence, fresh);
  assert.deepEqual(sent, { contextId: "current-context", operationId: "completed-committee", consent: true });
  current = { ...binding, sessionGeneration: 3 };
  await assert.rejects(api.importEvidence(binding, "completed-committee", signal()), /已变化/);
});

test("independent architecture calls verify actual payload SHA-256 and runtime; model/owner changes discard late results", async () => {
  const document = graph(), context = { requestId: "question-1", binding, graphFingerprint: architectureGraphFingerprint(document), document };
  const output = { id: "question", text: "请解释事务失败的恢复边界。", evidenceIds: ["self-1"], unknowns: ["生产部署未知"] };
  let current = binding, selectedRuntime: typeof runtime | undefined = runtime;
  const api = adapters(async (_route, body) => {
    const request = body as { purpose: string; payload: unknown }; assert.equal(request.purpose, "architecture_question");
    const contract = (request.payload as { contract: { properties: { evidenceIds: { items: { enum: string[] }; maxItems: number; uniqueItems: boolean } } } }).contract.properties.evidenceIds;
    assert.deepEqual(contract.items.enum, ["self-1"]); assert.equal(contract.maxItems, 1); assert.equal(contract.uniqueItems, true);
    return { output, contextId: "current-context", inputHash: digest(request.payload), runtime, adopted: false };
  }, { runtime, getCurrentBinding: () => current, getCurrentRuntime: () => selectedRuntime });
  const result = await api.interview!.ask(context, signal()); assert.deepEqual(result.value, output);
  await assert.rejects(adapters(async () => ({ output, contextId: "current-context", inputHash: "a".repeat(64), runtime, adopted: false }), { runtime }).interview!.ask(context, signal()), /回执不匹配/);
  const pending = adapters(async (_route, body) => {
    selectedRuntime = undefined;
    return { output, contextId: "current-context", inputHash: digest((body as { payload: unknown }).payload), runtime, adopted: false };
  }, { runtime, getCurrentRuntime: () => selectedRuntime });
  await assert.rejects(pending.interview!.ask(context, signal()), /模型已变化/);
  current = { ...binding, ownerId: "new-owner" };
  await assert.rejects(api.interview!.ask(context, signal()), /已变化/);
});

test("an empty authorized evidence inventory requires an empty model citation list", async () => {
  const document = createArchitectureDocument(binding, [], "empty-evidence-graph");
  const api = adapters(async (_route, body) => {
    const payload = (body as { payload: { contract: { properties: { evidenceIds: { maxItems: number; items: { enum?: string[] } } } } } }).payload;
    assert.equal(payload.contract.properties.evidenceIds.maxItems, 0);
    assert.equal(payload.contract.properties.evidenceIds.items.enum, undefined);
    return { output: { id: "question", text: "哪些边界目前仍缺少证据？", evidenceIds: [], unknowns: ["无授权引用"] }, contextId: "current-context", inputHash: digest(payload), runtime, adopted: false };
  }, { runtime, getCurrentEvidence: () => [] });
  const result = await api.interview!.ask({ requestId: "question-empty", binding, graphFingerprint: architectureGraphFingerprint(document), document }, signal());
  assert.deepEqual(result.value.evidenceIds, []);
});

test("late save/load results cannot cross cancellation or an account session advance", async () => {
  const document = graph(); let current = binding;
  const api = adapters(async () => { current = { ...binding, sessionGeneration: 3 }; return { record: record(document) }; }, { getCurrentBinding: () => current });
  await assert.rejects(api.storage.load(binding, signal()), /已变化/);
  current = binding;
  await assert.rejects(api.storage.save({ binding, document, expectedVersion: null, fingerprint: architectureDocumentFingerprint(document) }, signal()), /已变化/);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(adapters(async () => { throw Error("must not dispatch"); }).storage.load(binding, aborted.signal));
});
