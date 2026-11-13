import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { PrivacyPipeline, createJsonHttpCloudAdapter, privacyDigest, privacyRuntimeFingerprint, privacySourceSnapshotHash } from "../src/privacy/index.js";
import type { CloudPrivacyAdapter, DisclosureDraft, LocalPrivacyAdapter, PrivacyAccess, PrivacyAuditEvent, PrivacyLifecycle, PrivacySource, PrivacyTaskBinding } from "../src/privacy/index.js";

const localBinding = { id: "local-test", version: "v1", location: "local" as const, endpointFingerprint: "d".repeat(64), model: "synthetic-local", modelDigest: "e".repeat(64) };
const canaries = ["LOCAL_ONLY_CANARY_6743", "sk-proj-SYNTHETIC_CANARY_123456789012345", "/Users/synthetic-private-repo/private.ts"];
const sources: PrivacySource[] = [
  { id: "fact-1", revision: "r1", classification: "summary_allowed", kind: "fact", text: "Implemented lease-based idempotent state restoration with CAS checks." },
  { id: "private-1", revision: "r2", classification: "local_only", kind: "source", text: canaries.join("\n") },
];
const summary = "Implemented lease-based idempotent state restoration with CAS checks.";
const code = (expected: string) => (error: unknown) => error instanceof Error && error.message === expected;
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; };

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}/reason`;
}
async function stop(server: Server): Promise<void> { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }

class SyntheticLifecycle implements PrivacyLifecycle {
  state!: PrivacyTaskBinding;
  auditEvents: PrivacyAuditEvent[] = [];
  localCalls = 0;
  localClaims = new Set<string>();
  claimed = new Set<string>();
  async current() { return structuredClone(this.state); }
  async reserveLocal(input: Parameters<PrivacyLifecycle["reserveLocal"]>[0]) {
    const key = `${input.taskId}:${input.operationId}:${input.stage}`;
    if (this.localClaims.has(key) || privacyDigest(input.budget) !== privacyDigest(this.state.budget) || this.localCalls >= this.state.budget.maxLocalCalls) return false;
    this.localClaims.add(key);
    this.localCalls++; return true;
  }
  async reserveDispatch(input: Parameters<PrivacyLifecycle["reserveDispatch"]>[0]) {
    const key = `${input.taskId}:${input.operationId}`;
    if (this.claimed.has(key) || privacyDigest(input.budget) !== privacyDigest(this.state.budget)) return false;
    this.claimed.add(key); return true;
  }
  async audit(event: PrivacyAuditEvent) { this.auditEvents.push(structuredClone(event)); }
}

async function fixture(t: { after(fn: () => Promise<void> | void): void }, options: { reply?: unknown; wait?: Promise<void> } = {}) {
  const captured: string[] = [], started = deferred<void>();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    captured.push(Buffer.concat(chunks).toString("utf8")); started.resolve();
    await options.wait;
    if (!response.destroyed) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(options.reply ?? { text: "Evidence supports idempotent state restoration.", sourceIds: ["fact-1"], unknowns: ["No throughput metric supplied."] })); }
  });
  const endpoint = await listen(server); t.after(() => stop(server));
  const cloud = createJsonHttpCloudAdapter({ endpoint, recipientId: "synthetic-cloud", model: "reasoner-fixture", allowLoopbackHttpFixture: true });
  const lifecycle = new SyntheticLifecycle();
  lifecycle.state = { ownerId: "owner-1", sessionId: "session-1", sessionGeneration: 1, authorizationGeneration: 1, taskRevision: 1, sourceSnapshotHash: privacySourceSnapshotHash(sources), policyVersion: "policy-v1", localRuntimeFingerprint: privacyRuntimeFingerprint(localBinding), cloudRuntimeFingerprint: privacyRuntimeFingerprint(await cloud.binding()), status: "active", budget: { revision: 1, maxLocalCalls: 20, maxCloudCalls: 1, maxInputBytes: 100_000, maxOutputBytes: 16_000, maxActiveMs: 10_000 } };
  let valid = true, localText = summary, raw: string | undefined;
  const inspected: PrivacySource[][] = [], summarized: PrivacySource[][] = [];
  const local: LocalPrivacyAdapter = {
    binding: async () => structuredClone(localBinding),
    inspect: async input => { inspected.push(structuredClone([...input])); return { inspectedSourceIds: input.map(source => source.id), findings: [] }; },
    summarize: async input => { summarized.push(structuredClone([...input.sources])); return raw ?? JSON.stringify({ fields: input.requestedFields.map(name => ({ name, text: localText, sourceIds: ["fact-1"] })) }); },
  };
  const access: PrivacyAccess = { ownerId: "owner-1", sessionId: "session-1", sessionGeneration: 1, authorizationGeneration: 1, valid: async () => valid };
  const pipeline = new PrivacyPipeline(lifecycle); t.after(() => pipeline.close());
  let operation = 0;
  const prepare = () => pipeline.prepare({ taskId: "task-1", operationId: `operation-${++operation}`, access, sources, local, policy: { version: "policy-v1", allowedFields: ["evidence"], privateTerms: ["SyntheticCompany"], maxFieldCharacters: 4000 }, requestedFields: ["evidence"] });
  const approve = async (draft: DisclosureDraft) => pipeline.approve({ draftId: draft.id, expectedDraftHash: draft.hash, approvedFields: ["evidence"], access, recipient: await cloud.binding(), consent: true });
  return { pipeline, cloud, lifecycle, access, local, captured, inspected, summarized, started, prepare, approve, setLocalText: (value: string) => { localText = value; }, setRaw: (value: string) => { raw = value; }, invalidate: () => { valid = false; } };
}

test("privacy actual HTTP egress sends only immutable exact approved redacted fields; no local-only inputs or audit leaks", async t => {
  const f = await fixture(t);
  f.setLocalText(`${summary} Contact person@example.test or 13800138000 at SyntheticCompany.`);
  const draft = await f.prepare();
  assert.equal(f.captured.length, 0);
  assert.equal(f.inspected[0]?.length, 2);
  assert.equal(f.summarized[0]?.length, 1);
  assert.equal(f.summarized[0]?.[0]?.id, "fact-1");
  assert.match(draft.fields[0]!.text, /REDACTED_EMAIL/);
  assert.match(draft.fields[0]!.text, /REDACTED_PHONE/);
  assert.match(draft.fields[0]!.text, /REDACTED_PRIVATE/);
  const approved = await f.approve(draft);
  draft.fields[0]!.text = canaries.join(" "); // Caller cannot mutate vault preview.
  const reply = await f.pipeline.dispatch({ approvalId: approved.id, expectedDraftHash: approved.draftHash, access: f.access, cloud: f.cloud });
  assert.match(reply.text, /Evidence supports/);
  assert.equal(f.captured.length, 1);
  const body = JSON.parse(f.captured[0]!);
  assert.deepEqual(Object.keys(body.summary), ["evidence"]);
  assert.deepEqual(body.sources.map((source: { id: string }) => source.id), ["fact-1"]);
  const allObservable = f.captured.join("") + JSON.stringify(f.lifecycle.auditEvents) + JSON.stringify(reply);
  for (const sensitive of [...canaries, "person@example.test", "13800138000", "SyntheticCompany", "owner-1", "session-1"]) assert.equal(allObservable.includes(sensitive), false, sensitive);
  assert.equal(f.lifecycle.claimed.size, 1);
  assert.equal(f.lifecycle.auditEvents.at(-1)?.code, "cloud_result_ready_not_adopted");
});

test("privacy exact consent required: hash, fields, recipient, owner and expiry", async t => {
  const f = await fixture(t), draft = await f.prepare(), recipient = await f.cloud.binding();
  const base = { draftId: draft.id, expectedDraftHash: draft.hash, approvedFields: ["evidence"], access: f.access, recipient, consent: true as const };
  await assert.rejects(f.pipeline.approve({ ...base, consent: false as unknown as true }), code("explicit_disclosure_consent_required"));
  await assert.rejects(f.pipeline.approve({ ...base, expectedDraftHash: "a".repeat(64) }), code("disclosure_consent_mismatch"));
  await assert.rejects(f.pipeline.approve({ ...base, approvedFields: ["raw_source"] }), code("disclosure_consent_mismatch"));
  await assert.rejects(f.pipeline.approve({ ...base, recipient: { ...recipient, model: "different-recipient-runtime" } }), code("cloud_recipient_changed"));
  await assert.rejects(f.pipeline.approve({ ...base, access: { ...f.access, ownerId: "owner-2" } }), code("authorization_changed"));
  await assert.rejects(f.pipeline.dispatch({ approvalId: "not-approved", expectedDraftHash: draft.hash, access: f.access, cloud: f.cloud }), code("disclosure_not_approved"));
  assert.equal(f.captured.length, 0);
  let clock = 1000;
  const expires = new PrivacyPipeline(f.lifecycle, { now: () => clock, draftTtlMs: 2 }); t.after(() => expires.close());
  const expiring = await expires.prepare({ taskId: "task-1", operationId: "operation-2", access: f.access, sources, local: f.local, policy: { version: "policy-v1", allowedFields: ["evidence"], privateTerms: [], maxFieldCharacters: 4000 }, requestedFields: ["evidence"] });
  clock = 1003;
  await assert.rejects(expires.approve({ ...base, draftId: expiring.id, expectedDraftHash: expiring.hash }), code("disclosure_not_found_or_expired"));
});

test("privacy source, task, policy, budget, session and authorization version drift all block egress", async t => {
  for (const mutate of [
    (state: PrivacyTaskBinding) => { state.sourceSnapshotHash = "f".repeat(64); },
    (state: PrivacyTaskBinding) => { state.taskRevision++; },
    (state: PrivacyTaskBinding) => { state.policyVersion = "policy-v2"; },
    (state: PrivacyTaskBinding) => { state.budget.revision++; },
    (state: PrivacyTaskBinding) => { state.sessionGeneration++; },
    (state: PrivacyTaskBinding) => { state.authorizationGeneration++; },
    (state: PrivacyTaskBinding) => { state.status = "revoked"; },
    (state: PrivacyTaskBinding) => { state.cloudRuntimeFingerprint = "f".repeat(64); },
    (state: PrivacyTaskBinding) => { state.localRuntimeFingerprint = "f".repeat(64); },
  ]) {
    const f = await fixture(t), approved = await f.approve(await f.prepare());
    mutate(f.lifecycle.state);
    await assert.rejects(f.pipeline.dispatch({ approvalId: approved.id, expectedDraftHash: approved.draftHash, access: f.access, cloud: f.cloud }), /authorization_changed|privacy_binding_changed/);
    assert.equal(f.captured.length, 0);
  }
});

test("privacy changed recipient endpoint/runtime blocks before transport even with approved model", async t => {
  const f = await fixture(t), approved = await f.approve(await f.prepare());
  const original = await f.cloud.binding(); let calls = 0;
  const altered: CloudPrivacyAdapter = { binding: async () => ({ ...original, endpointFingerprint: "f".repeat(64) }), dispatch: async () => { calls++; return {}; } };
  await assert.rejects(f.pipeline.dispatch({ approvalId: approved.id, expectedDraftHash: approved.draftHash, access: f.access, cloud: altered }), code("cloud_recipient_changed"));
  assert.equal(calls, 0); assert.equal(f.captured.length, 0);
});

test("privacy revocation after actual HTTP dispatch aborts and rejects late result; never replays", async t => {
  const wait = deferred<void>(), f = await fixture(t, { wait: wait.promise });
  const approved = await f.approve(await f.prepare());
  const dispatch = f.pipeline.dispatch({ approvalId: approved.id, expectedDraftHash: approved.draftHash, access: f.access, cloud: f.cloud });
  const rejection = assert.rejects(dispatch, /privacy_cancelled|disclosure_revoked_or_expired/);
  await f.started.promise;
  await f.pipeline.revokeApproval(approved.id, f.access);
  wait.resolve(); await rejection;
  await assert.rejects(f.pipeline.dispatch({ approvalId: approved.id, expectedDraftHash: approved.draftHash, access: f.access, cloud: f.cloud }), code("disclosure_not_approved"));
  assert.equal(f.captured.length, 1);
  assert.equal(f.lifecycle.auditEvents.some(event => event.stage === "cloud_result"), false);
});

test("privacy session generation changes during HTTP request reject late result even without abort notification", async t => {
  const wait = deferred<void>(), f = await fixture(t, { wait: wait.promise }), approved = await f.approve(await f.prepare());
  const dispatch = f.pipeline.dispatch({ approvalId: approved.id, expectedDraftHash: approved.draftHash, access: f.access, cloud: f.cloud });
  const rejection = assert.rejects(dispatch, code("authorization_changed"));
  await f.started.promise; f.lifecycle.state.sessionGeneration++; wait.resolve(); await rejection;
  assert.equal(f.captured.length, 1);
  assert.equal(f.lifecycle.auditEvents.some(event => event.stage === "cloud_result"), false);
});

test("privacy explicit caller cancellation and invalidateSession stop work, even adapter ignores signal", async t => {
  const f = await fixture(t), approved = await f.approve(await f.prepare()), wait = deferred<unknown>(), started = deferred<void>();
  const ignoresAbort: CloudPrivacyAdapter = { binding: () => f.cloud.binding(), dispatch: async () => { started.resolve(); return wait.promise; } };
  const dispatch = f.pipeline.dispatch({ approvalId: approved.id, expectedDraftHash: approved.draftHash, access: f.access, cloud: ignoresAbort });
  const rejection = assert.rejects(dispatch, code("privacy_cancelled"));
  await started.promise; f.pipeline.invalidateSession(f.access.sessionId); await rejection;
  wait.resolve({ text: "late", sourceIds: ["fact-1"], unknowns: [] });
  assert.equal(f.lifecycle.auditEvents.some(event => event.stage === "cloud_result"), false);
  const g = await fixture(t), second = await g.approve(await g.prepare()), controller = new AbortController(); controller.abort();
  await assert.rejects(g.pipeline.dispatch({ approvalId: second.id, expectedDraftHash: second.draftHash, access: g.access, cloud: g.cloud, signal: controller.signal }), code("privacy_cancelled"));
  assert.equal(g.captured.length, 0); assert.equal(g.lifecycle.claimed.size, 0);
});

test("privacy exactly one dispatch claim survives concurrent attempts and a failed unknown outcome", async t => {
  const f = await fixture(t), approved = await f.approve(await f.prepare());
  const results = await Promise.allSettled([1, 2].map(() => f.pipeline.dispatch({ approvalId: approved.id, expectedDraftHash: approved.draftHash, access: f.access, cloud: f.cloud })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1); assert.equal(f.captured.length, 1);
  const g = await fixture(t), other = await g.approve(await g.prepare()); let attempts = 0;
  const broken: CloudPrivacyAdapter = { binding: () => g.cloud.binding(), dispatch: async () => { attempts++; throw new Error(canaries.join(" ")); } };
  await assert.rejects(g.pipeline.dispatch({ approvalId: other.id, expectedDraftHash: other.draftHash, access: g.access, cloud: broken }), code("privacy_adapter_failed"));
  await assert.rejects(g.pipeline.dispatch({ approvalId: other.id, expectedDraftHash: other.draftHash, access: g.access, cloud: broken }), code("cloud_dispatch_already_claimed_or_budget_exhausted"));
  assert.equal(attempts, 1);
  assert.equal(JSON.stringify(g.lifecycle.auditEvents).includes(canaries[0]!), false);
});

test("privacy rejects raw source, diff, keys, paths and local-only canaries from hostile local model", async t => {
  for (const unsafe of [...canaries, "diff --git a/src.ts b/src.ts\n@@ -1 +1 @@\n+const state = 1;", "const secretValue = 'not-for-cloud';", "See /opt/private-repo/design.md for details."]) {
    const f = await fixture(t); f.setLocalText(unsafe);
    await assert.rejects(f.prepare(), code("unsafe_local_summary"));
    assert.equal(f.captured.length, 0);
    assert.equal(JSON.stringify(f.lifecycle.auditEvents).includes(unsafe), false);
  }
});

test("privacy rejects forged source references, incomplete scans, disallowed fields and malformed JSON without fallback", async t => {
  const f = await fixture(t);
  f.setRaw(JSON.stringify({ fields: [{ name: "evidence", text: summary, sourceIds: ["private-1"] }] }));
  await assert.rejects(f.prepare(), code("invalid_summary_evidence"));
  f.setRaw('{"fields": ['); await assert.rejects(f.prepare(), code("invalid_local_json"));
  f.local.inspect = async () => ({ inspectedSourceIds: [], findings: [] });
  await assert.rejects(f.prepare(), code("incomplete_local_inspection"));
  assert.equal(f.captured.length, 0);
  const g = await fixture(t); g.lifecycle.state.budget.maxLocalCalls = 1;
  await assert.rejects(g.prepare(), code("local_budget_exhausted"));
  assert.equal(g.summarized.length, 0);
});

test("privacy bounded JSON repairs are traceable in exact approved draft", async t => {
  const f = await fixture(t);
  f.setRaw('```json\n{"fields":[{"name":"evidence","text":"Bounded protocol repair retained verified facts.","sourceIds":["fact-1"],}],}\n```');
  const draft = await f.prepare();
  assert.deepEqual(draft.repairs.map(repair => repair.kind), ["transport_fence", "trailing_comma"]);
  for (const repair of draft.repairs) { assert.match(repair.beforeHash, /^[a-f0-9]{64}$/); assert.notEqual(repair.beforeHash, repair.afterHash); }
  await f.approve(draft); assert.equal(f.captured.length, 0);
});

test("privacy local embedding retrieval is injectable, local-only, metered and revocation checked", async t => {
  const f = await fixture(t); let embedded: readonly string[] = [];
  f.local.embed = async texts => { embedded = texts; return [[1, 0], [0.9, 0.1], [0, 1]]; };
  const result = await f.pipeline.searchLocal({ taskId: "task-1", operationId: "search-1", access: f.access, sources, query: "CAS idempotent state", local: f.local, topK: 1 });
  assert.equal(result[0]?.sourceId, "fact-1"); assert.equal(embedded[2], sources[1]!.text); assert.equal(f.captured.length, 0); assert.equal(f.lifecycle.localCalls, 1);
  assert.equal(JSON.stringify(f.lifecycle.auditEvents).includes(canaries[0]!), false);
  f.local.embed = async () => { f.lifecycle.state.authorizationGeneration++; return [[1], [1], [1]]; };
  await assert.rejects(f.pipeline.searchLocal({ taskId: "task-1", operationId: "search-2", access: f.access, sources, query: "CAS", local: f.local }), code("authorization_changed"));
});

test("privacy cloud result must use disclosed evidence and cannot reintroduce sensitive text", async t => {
  for (const reply of [{ text: summary, sourceIds: ["private-1"], unknowns: [] }, { text: canaries[0], sourceIds: ["fact-1"], unknowns: [] }, { text: summary, sourceIds: ["fact-1"], unknowns: ["person@example.test"] }]) {
    const f = await fixture(t, { reply }), approved = await f.approve(await f.prepare());
    await assert.rejects(f.pipeline.dispatch({ approvalId: approved.id, expectedDraftHash: approved.draftHash, access: f.access, cloud: f.cloud }), code("unsafe_cloud_result"));
    assert.equal(f.lifecycle.auditEvents.some(event => event.stage === "cloud_result"), false);
  }
});

test("privacy HTTP cloud adapter disallows non-TLS non-fixture endpoints, credentials and redirects", async t => {
  for (const endpoint of ["http://example.test/reason", "https://user:pass@example.test/reason", "https://example.test/reason?secret=test", "http://127.0.0.1:1/reason"]) assert.throws(() => createJsonHttpCloudAdapter({ endpoint, recipientId: "test", model: "test" }), code("invalid_cloud_endpoint"));
  let redirected = 0;
  const server = createServer((_request, response) => { redirected++; response.writeHead(302, { location: "/forbidden" }); response.end(); });
  const endpoint = await listen(server); t.after(() => stop(server));
  const adapter = createJsonHttpCloudAdapter({ endpoint, recipientId: "redirect-test", model: "test", allowLoopbackHttpFixture: true });
  await assert.rejects(adapter.dispatch({ protocol: "betterme.disclosure.v1", taskId: "test", operationId: "test", model: "test", summary: { evidence: summary }, sources: [] }, new AbortController().signal), code("cloud_transport_failed"));
  assert.equal(redirected, 1);
});
