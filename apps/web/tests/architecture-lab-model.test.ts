import assert from "node:assert/strict";
import test from "node:test";
import {
  applyArchitectureCommand, architectureDocumentFingerprint, architectureGraphFingerprint, clientToArchitecturePoint,
  createArchitectureDocument, exportArchitectureArtifact, newArchitectureNode, runArchitectureOperation,
  rebindArchitectureGraphDraft,
  simulateArchitectureFault, validateArchitectureDocument, validateArchitectureInterviewEnvelope,
  validateArchitectureSaveReceipt, validateArchitectureStoredRecord,
  type ArchitectureBinding, type ArchitectureDocument, type ArchitectureEdge, type ArchitectureQuestion,
} from "../src/lib/architecture-lab";

const binding: ArchitectureBinding = { ownerId: "synthetic-owner", sessionGeneration: 1, projectId: "synthetic-project", revision: "1", contentHash: "synthetic-authorized-source" };
function graph(): ArchitectureDocument {
  let document = createArchitectureDocument(binding, [{ id: "ev1", label: "已授权设计节选", excerpt: "SYNTHETIC_SOURCE_EXCERPT", path: "/private/synthetic/source.ts", startLine: 3, endLine: 8 }]);
  for (const [id, kind, x] of [["client", "client", 50], ["service", "service", 350], ["db", "store", 650]] as const) {
    const node = newArchitectureNode(id, kind, x, 100); node.guards = { diskFull: "no", sessionEpoch: "no", idempotency: "no" }; node.evidenceIds = ["ev1"];
    document = applyArchitectureCommand(document, { type: "add-node", node });
  }
  for (const [id, from, to] of [["request", "client", "service"], ["write", "service", "db"]]) {
    document = applyArchitectureCommand(document, { type: "add-edge", edge: { id: id!, from: from!, to: to!, label: "调用", kind: "write", failurePolicy: "propagate", sessionPolicy: "forward", evidenceIds: ["ev1"] } });
  }
  return document;
}

test("editing creates new graph revisions; deleting nodes removes associated edges without changing the input", () => {
  const document = graph(), original = JSON.stringify(document);
  const next = applyArchitectureCommand(document, { type: "remove-node", id: "service" });
  assert.equal(next.nodes.length, 2); assert.equal(next.edges.length, 0);
  assert.equal(next.revision, document.revision + 1); assert.equal(next.graphRevision, document.graphRevision + 1);
  assert.equal(JSON.stringify(document), original);
});

test("node names accept ordinary clear-and-type input but invalid drafts cannot be saved or simulated", () => {
  const empty = applyArchitectureCommand(graph(), { type: "update-node", id: "service", patch: { label: "" } });
  assert.equal(empty.nodes.find(node => node.id === "service")?.label, "");
  assert.ok(validateArchitectureDocument(empty).length > 0);
  assert.throws(() => simulateArchitectureFault(empty, { kind: "disk-full", targetNodeId: "db" }));
});

test("pointer coordinates normalize actual SVG scale and reject unmeasurable boxes", () => {
  assert.deepEqual(clientToArchitecturePoint(250, 230, { left: 100, top: 40, width: 600, height: 380 }), { x: 300, y: 380 });
  assert.equal(clientToArchitecturePoint(0, 0, { left: 0, top: 0, width: 0, height: 0 }), undefined);
});

test("disk-full propagates back to callers, not forward as though the database called its client", () => {
  const result = simulateArchitectureFault(graph(), { kind: "disk-full", targetNodeId: "db" });
  assert.equal(result.simulated, true);
  assert.deepEqual(result.outcomes.map(outcome => [outcome.nodeId, outcome.state]), [["client", "at-risk"], ["service", "at-risk"], ["db", "failed"]]);
  assert.equal(result.propagation[0]?.from, "db");
  assert.match(result.assumptions[0]!, /没有操作真实系统/);
});

test("explicit isolation contains a fault while missing protection stays unknown", () => {
  const document = graph();
  document.edges.find(edge => edge.id === "write")!.failurePolicy = "isolate";
  const isolated = simulateArchitectureFault(document, { kind: "disk-full", targetNodeId: "db" });
  assert.equal(isolated.outcomes.find(outcome => outcome.nodeId === "service")?.state, "contained");
  assert.equal(isolated.outcomes.find(outcome => outcome.nodeId === "client")?.state, "unaffected");
  document.edges.find(edge => edge.id === "write")!.failurePolicy = "unknown";
  const unknown = simulateArchitectureFault(document, { kind: "disk-full", targetNodeId: "db" });
  assert.equal(unknown.outcomes.find(outcome => outcome.nodeId === "service")?.state, "unknown");
  assert.equal(unknown.outcomes.find(outcome => outcome.nodeId === "client")?.state, "unknown");
});

test("session-switch risk follows outgoing flow and a session epoch check blocks stale writes in the model", () => {
  const document = graph();
  const risky = simulateArchitectureFault(document, { kind: "session-switch", targetNodeId: "client" });
  assert.equal(risky.outcomes.find(outcome => outcome.nodeId === "db")?.state, "at-risk");
  document.edges.find(edge => edge.id === "write")!.sessionPolicy = "validate";
  const checked = simulateArchitectureFault(document, { kind: "session-switch", targetNodeId: "client" });
  assert.equal(checked.outcomes.find(outcome => outcome.nodeId === "db")?.state, "contained");
  assert.match(checked.outcomes.find(outcome => outcome.nodeId === "db")!.detail, /尚待引用核对/);
});

test("duplicate events use explicit idempotency assumptions and cycle traversal is bounded", () => {
  const document = graph();
  document.nodes.find(node => node.id === "service")!.guards.idempotency = "yes";
  const duplicate = simulateArchitectureFault(document, { kind: "duplicate-event", targetNodeId: "service" });
  assert.equal(duplicate.outcomes.find(outcome => outcome.nodeId === "service")?.state, "contained");
  document.edges.push({ ...document.edges[0]!, id: "cycle", from: "db", to: "client" });
  const bounded = simulateArchitectureFault(document, { kind: "network-timeout", targetNodeId: "db" }, { maxSteps: 1 });
  assert.equal(bounded.truncated, true); assert.equal(bounded.steps, 1);
  assert.equal(bounded.outcomes.some(outcome => outcome.state === "unaffected"), false);
  assert.throws(() => simulateArchitectureFault(document, { kind: "disk-full", targetNodeId: "client" }));
});

test("faults, malformed references, off-canvas boxes and old account records are rejected on restore", () => {
  const document = graph();
  document.nodes[0]!.x = 1199;
  assert.ok(validateArchitectureDocument(document).length > 0);
  const foreign = graph(); foreign.binding.ownerId = "other-owner";
  assert.ok(validateArchitectureStoredRecord({ document: foreign, storageVersion: "1" }, binding));
  const poisoned = graph(); const run = simulateArchitectureFault(poisoned, { kind: "disk-full", targetNodeId: "db" });
  run.binding.ownerId = "other-owner"; poisoned.faults.push(run);
  assert.ok(validateArchitectureDocument(poisoned).length > 0);
  const badReference = graph(); badReference.edges[0]!.evidenceIds = ["not-authorized"];
  assert.ok(validateArchitectureDocument(badReference).length > 0);
  const prototypeKind = graph(); prototypeKind.nodes[0]!.kind = "toString" as typeof prototypeKind.nodes[number]["kind"];
  assert.ok(validateArchitectureDocument(prototypeKind).length > 0, "prototype names are not valid node types");
  const prototypeFault = graph(), poisonedRun = simulateArchitectureFault(prototypeFault, { kind: "disk-full", targetNodeId: "db" });
  poisonedRun.fault.kind = "constructor" as typeof poisonedRun.fault.kind; prototypeFault.faults.push(poisonedRun);
  assert.ok(validateArchitectureDocument(prototypeFault).length > 0, "prototype names are not valid fault types");
});

test("export excludes identity leases, source excerpts, absolute paths and source-bearing payload keys", () => {
  const document = graph();
  const run = simulateArchitectureFault(document, { kind: "disk-full", targetNodeId: "db" }); document.faults.push(run);
  const artifact = exportArchitectureArtifact(document);
  for (const secret of ["synthetic-owner", "sessionGeneration", "SYNTHETIC_SOURCE_EXCERPT", "/private/synthetic/source.ts", "graphFingerprint"]) assert.equal(artifact.text.includes(secret), false, secret);
  assert.match(artifact.text, /仍可能包含用户输入的敏感内容/);
  assert.equal(JSON.parse(artifact.text).source.projectId, binding.projectId);
});

test("CAS receipts must identify the full artifact, not merely say success", () => {
  const document = graph();
  const valid = { status: "saved" as const, binding, documentId: document.id, documentRevision: document.revision, fingerprint: architectureDocumentFingerprint(document), storageVersion: "stored-1" };
  assert.equal(validateArchitectureSaveReceipt(valid, document), undefined);
  assert.ok(validateArchitectureSaveReceipt({ ...valid, fingerprint: "old" }, document));
  assert.ok(validateArchitectureSaveReceipt({ ...valid, binding: { ...binding, sessionGeneration: 2 } }, document));
  assert.equal(validateArchitectureSaveReceipt({ status: "conflict", detail: "CAS mismatch" }, document), undefined);
});

test("model envelopes bind request, graph, owner and authorized references; no evidence cannot claim support", () => {
  const document = graph(), requestId = "request-1";
  const envelope = { requestId, binding, graphFingerprint: architectureGraphFingerprint(document), value: { id: "q", text: "磁盘满后哪一条写入会失败？", evidenceIds: ["ev1"], unknowns: [] } satisfies ArchitectureQuestion };
  assert.equal(validateArchitectureInterviewEnvelope(envelope, document, requestId), undefined);
  assert.ok(validateArchitectureInterviewEnvelope({ ...envelope, requestId: "other" }, document, requestId));
  assert.ok(validateArchitectureInterviewEnvelope({ ...envelope, value: { ...envelope.value, evidenceIds: ["unread"] } }, document, requestId));
  const review = { ...envelope, value: { support: "supported" as const, summary: "没有证据也声称通过", strengths: [], gaps: [], followUps: [], evidenceIds: [] } };
  assert.ok(validateArchitectureInterviewEnvelope(review, document, requestId));
  assert.equal(validateArchitectureInterviewEnvelope({ ...review, value: { ...review.value, support: "unknown" } }, document, requestId), undefined);
});

test("late operations do not adopt after owner, graph, or session version changes", async () => {
  let current = binding, fingerprint = "original";
  let resolve!: (value: number) => void;
  const pending = runArchitectureOperation({ binding, fingerprint, getCurrentBinding: () => current, getCurrentFingerprint: () => fingerprint,
    invoke: async () => new Promise<number>(done => { resolve = done; }), validate: () => undefined });
  await Promise.resolve(); current = { ...binding, sessionGeneration: 2 }; fingerprint = "changed"; resolve(1);
  const result = await pending;
  assert.equal(result.status, "stale"); assert.equal("value" in result, false);
});

test("cancel before dispatch never calls the Adapter; hung calls stop at the deadline without retry", async () => {
  let calls = 0;
  const controller = new AbortController();
  const cancelled = runArchitectureOperation({ binding, fingerprint: "f", getCurrentBinding: () => binding, getCurrentFingerprint: () => "f", signal: controller.signal,
    invoke: async () => { calls++; return 1; }, validate: () => undefined });
  controller.abort();
  assert.equal((await cancelled).status, "cancelled"); assert.equal(calls, 0);
  let adapterSignal: AbortSignal | undefined;
  const timed = await runArchitectureOperation({ binding, fingerprint: "f", getCurrentBinding: () => binding, getCurrentFingerprint: () => "f", timeoutMs: 10,
    invoke: async signal => { calls++; adapterSignal = signal; return new Promise<number>(() => {}); }, validate: () => undefined });
  assert.equal(timed.status, "timeout"); assert.equal(calls, 1); assert.equal(adapterSignal?.aborted, true);
});

test("restored old turns remain history but cannot impersonate current graph results", () => {
  let document = graph();
  const key = architectureGraphFingerprint(document);
  document.turns.push({ id: "turn-1", graphRevision: document.graphRevision, graphFingerprint: key, question: { id: "q", text: "问题", evidenceIds: ["ev1"], unknowns: [] }, draftAnswer: "尚未提交的答复", createdAt: "2026-11-09T00:00:00Z" });
  document = applyArchitectureCommand(document, { type: "update-node", id: "service", patch: { notes: "新的边界假设" } });
  assert.deepEqual(validateArchitectureDocument(document), []);
  assert.notEqual(architectureGraphFingerprint(document), key);
  assert.equal(document.turns[0]?.draftAnswer, "尚未提交的答复");
});

test("the graph model permits loops, but retains a finite editor payload", () => {
  const document = graph();
  const edge: ArchitectureEdge = { ...document.edges[0]!, id: "loop", from: "service", to: "service" };
  assert.deepEqual(validateArchitectureDocument(applyArchitectureCommand(document, { type: "add-edge", edge })), []);
  assert.throws(() => applyArchitectureCommand(document, { type: "add-edge", edge: { ...edge, id: "bad-endpoint", to: "missing" } }));
});

test("reauthorization restores only an unsaved stable-project graph draft, with fresh evidence and no inherited model/fault authority", () => {
  const old = graph(); old.faults.push(simulateArchitectureFault(old, { kind: "disk-full", targetNodeId: "db" }));
  old.turns.push({ id: "turn-old", graphRevision: old.graphRevision, graphFingerprint: architectureGraphFingerprint(old),
    question: { id: "q-old", text: "旧会话问题", evidenceIds: ["ev1"], unknowns: [] }, answer: "旧答复", createdAt: "2026-11-09T00:00:00Z" });
  const original = JSON.stringify(old), nextBinding = { ...binding, sessionGeneration: 3, revision: "reauthorized-2" };
  const restored = rebindArchitectureGraphDraft(old, nextBinding, old.evidence);
  assert.deepEqual(restored.binding, nextBinding); assert.equal(restored.revision, old.revision + 1); assert.equal(restored.graphRevision, old.graphRevision + 1);
  assert.deepEqual(restored.nodes, old.nodes); assert.deepEqual(restored.edges, old.edges); assert.deepEqual(restored.faults, []); assert.deepEqual(restored.turns, []);
  assert.equal(JSON.stringify(old), original, "historical graph and old questions stay unchanged"); assert.deepEqual(validateArchitectureDocument(restored), []);
  const changedEvidence = rebindArchitectureGraphDraft(old, nextBinding, [{ ...old.evidence[0]!, excerpt: "新的授权库存，不是旧节选" }]);
  assert.deepEqual(changedEvidence.nodes[0]!.evidenceIds, []); assert.deepEqual(changedEvidence.edges[0]!.evidenceIds, []);
  assert.equal(changedEvidence.evidence[0]!.excerpt, "新的授权库存，不是旧节选");
  const missingEvidence = rebindArchitectureGraphDraft(old, nextBinding, []); assert.deepEqual(missingEvidence.evidence, []); assert.deepEqual(missingEvidence.nodes[0]!.evidenceIds, []);
  for (const foreign of [{ ...nextBinding, ownerId: "other" }, { ...nextBinding, projectId: "different-resume" }, { ...nextBinding, contentHash: "new-source" }]) {
    assert.throws(() => rebindArchitectureGraphDraft(old, foreign, old.evidence), /不符/);
  }
});
