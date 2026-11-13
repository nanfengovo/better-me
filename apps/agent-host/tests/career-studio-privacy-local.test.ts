import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type IncomingMessage } from "node:http";
import test from "node:test";
import { CareerStudio } from "../src/career-studio/service.js";
import { createCareerStudioHttp } from "../src/career-studio/http.js";
import { EvidenceBroker } from "../src/understanding/evidence-broker.js";
import { createLocalOllamaClient } from "../src/privacy/local-ollama.js";
import type { CloudDisclosureEnvelope } from "../src/privacy/types.js";
import type { StudioContext } from "../src/career-studio/contracts.js";
import { createStudioCommitteeHarness } from "./fixtures/studio-committee.js";

const runtime = { model: "synthetic-generate", modelDigest: "a".repeat(64) }, embedding = { model: "synthetic-embed", modelDigest: "b".repeat(64) };
const marker = "LOCAL_ONLY_SYNTHETIC_CANARY_1726389", sourceA = `export const lease = "${marker}";`, sourceB = "export const recovery = true;";
async function readBody(request: IncomingMessage): Promise<unknown> { const parts: Buffer[] = []; for await (const part of request) parts.push(Buffer.from(part)); return JSON.parse(Buffer.concat(parts).toString()); }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function listen(server: ReturnType<typeof createServer>) { await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address === "object"); return `http://127.0.0.1:${address.port}`; }
async function stop(server: ReturnType<typeof createServer>) { server.closeIdleConnections(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
async function fixture(t: test.TestContext, input: { waitEmbed?: Promise<void>; searchCalls?: number; invalidEmbedding?: boolean } = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "betterme-privacy-local-"))), project = path.join(directory, "synthetic-project"); await fs.mkdir(project);
  await fs.writeFile(path.join(project, "lease.ts"), sourceA); await fs.writeFile(path.join(project, "recovery.ts"), sourceB);
  const generatePrompts: string[] = [], embedBodies: Array<{ model: string; input: string[] }> = [], cloudBodies: CloudDisclosureEnvelope[] = [], started = deferred();
  let allowed = true, embedDigest = embedding.modelDigest;
  const local = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/version") { response.end(JSON.stringify({ version: "0.40.15" })); return; }
    if (request.url === "/api/tags") { response.end(JSON.stringify({ models: [{ name: runtime.model, digest: runtime.modelDigest }, { name: embedding.model, digest: embedDigest }] })); return; }
    const body = await readBody(request) as { model: string; prompt?: string; input?: string[]; format?: { anyOf?: Array<{ properties: { kind: { const: string } } }>; properties: { kind: { const: string } } } };
    if (request.url === "/api/embed") { embedBodies.push({ model: body.model, input: body.input! }); started.resolve(); await input.waitEmbed; response.end(JSON.stringify(input.invalidEmbedding ? { response: "generated words are NOT embeddings", done: true } : { model: body.model, embeddings: body.input!.map((_, index) => index < 2 ? [1, 0, 1] : [0, 1, 1]) })); return; }
    const prompt = body.prompt!; generatePrompts.push(prompt); let answer: unknown;
    if (prompt.includes("SELECTED_SNAPSHOT=")) {
      const snapshot = JSON.parse(prompt.match(/^SELECTED_SNAPSHOT=(.*)$/m)![1]!) as { claims: Array<{ id: string }>; evidenceCatalog: Array<{ id: string; startLine: number; endLine: number }> };
      if ((body.format?.anyOf?.[0] ?? body.format)?.properties.kind.const === "request_evidence") answer = { kind: "request_evidence", requests: snapshot.evidenceCatalog.map(e => ({ evidenceId: e.id, startLine: e.startLine, endLine: e.endLine })) };
      else { const citations = JSON.parse(prompt.match(/^HOST_CITATION_CATALOG=(.*)$/m)![1]!); answer = { kind: "assessment", role: prompt.match(/Role=(\w+);/)![1]!, summary: "合成项目资料，不是作者认证。", claims: snapshot.claims.map(claim => ({ claimId: claim.id, support: "supported", citations, counterCitations: [], risks: [], missing: [], questions: [], defense: [] })) }; }
    } else { const summarySources = JSON.parse(prompt.match(/BEGIN_UNTRUSTED_SOURCES\n([\s\S]*)\nEND_UNTRUSTED_SOURCES/)![1]!) as Array<{ id: string }>;
      answer = { fields: [{ name: "evidence_summary", text: "InternalName 实现本机租约机制，个人归属为本人自述。", sourceIds: [summarySources[0]!.id] }, { name: "limitations", text: "生产规模及独立作者认证未知。", sourceIds: [summarySources[0]!.id] }] }; }
    response.end(JSON.stringify({ response: JSON.stringify(answer), done: true, done_reason: "stop", model: runtime.model }));
  });
  const localURL = await listen(local), broker = new EvidenceBroker({ forbiddenRoots: [path.join(directory, "private")] });
  const localClient = () => createLocalOllamaClient({ endpoint: localURL, model: runtime.model, expectedDigest: runtime.modelDigest });

  const harness = createStudioCommitteeHarness({ ownerId: "owner-1", directory: path.join(directory, "private", "tasks"), broker, studio: () => studio, complete: request => localClient().complete(request) });
  const studio: CareerStudio = new CareerStudio({ ownerId: "owner-1", directory: path.join(directory, "private"), broker, localClient, committeeTasks: harness.tasks });
  const ownerAccess = { session: "session-1", valid: async () => allowed };
  const server = createServer(async (request, response) => { const access = { session: String(request.headers["x-fixture-session"] ?? "session-1"), valid: async () => allowed };
    if (!await api.handleOwner(request, response, new URL(request.url!, "http://127.0.0.1").pathname, access)) response.writeHead(404).end(); });
  const origin = await listen(server), api = createCareerStudioHttp({ ownerId: "owner-1", studio, privacyBroker: broker, baseURL: origin, allowedOrigins: [origin], readBody,
    localEmbeddingClient: (generated, embedded) => createLocalOllamaClient({ endpoint: localURL, model: generated.model, expectedDigest: generated.modelDigest, embeddingModel: embedded.model, expectedEmbeddingDigest: embedded.modelDigest }),
    cloud: { binding: async () => ({ id: "synthetic-cloud", version: "v1", location: "cloud", recipientOrigin: "https://synthetic.invalid", endpointFingerprint: "e".repeat(64), model: "synthetic-reasoner" }),
      dispatch: async envelope => { cloudBodies.push(envelope); return { text: "仅摘要中所述的租约实践，非作者认证。", sourceIds: envelope.sources.map(item => item.id), unknowns: ["生产规模未知"] }; } },
    sendJson: (response, status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); } });
  const post = async (route: string, body: unknown, session = "session-1") => { const response = await fetch(`${origin}/api/v1/agent/career-studio${route}`, { method: "POST", headers: { "content-type": "application/json", "x-fixture-session": session }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) }); return { status: response.status, data: await response.json() as Record<string, any> }; };
  const created = await post("/context/create", { workspaceKey: "workspace-1", resumeId: "resume-1", sourceFingerprint: "c".repeat(64), claims: [{ id: "claim-1", text: "本人实现本机租约机制。", contribution: "implementation", confirmedByUser: true, confirmedNumericTokens: [], skillIds: ["sqlite"] }], jobs: [], consent: true });
  const context = created.data.context as StudioContext; await post("/runtime/select", { contextId: context.id, runtime, consent: true });
  const completeCommittee = async () => {
    const started = { data: await harness.start({ contextId: context.id, runtime, consent: true, idempotencyKey: "synthetic-committee", claimIds: ["claim-1"], statements: [{ label: "本人原话", kind: "user_statement", text: "本人实现本机租约机制。" }], code: [{ root: project, files: [{ path: "lease.ts", startLine: 1, endLine: 1 }, { path: "recovery.ts", startLine: 1, endLine: 1 }] }] }, ownerAccess) };
    for (let turn = 0; turn < 2000; turn++) { const done = await post("/operation/read", { contextId: context.id, operationId: started.data.id }); if (done.data.status !== "running") { assert.equal(done.data.status, "completed"); assert.equal(done.data.output.status, "completed"); return; } await new Promise(resolve => setTimeout(resolve, 5)); }
    throw Error("synthetic committee did not converge");
  };
  const catalog = () => post("/privacy/local/catalog", { contextId: context.id });
  const configure = async (withEmbedding = false, selectionsCount = 2) => { const current = await catalog(); assert.equal(current.status, 200); return post("/privacy/local/configure", { contextId: context.id, expectedRevision: current.data.revision,
    selections: current.data.sources.slice(0, selectionsCount).map(({ operationId, evidenceId }: { operationId: string; evidenceId: string }) => ({ operationId, evidenceId })), privateTerms: ["InternalName"], maxSearchCalls: input.searchCalls ?? 4, consent: true, ...(withEmbedding ? { embeddingRuntime: embedding, embeddingConsent: true } : {}) }); };
  t.after(async () => { await harness.close(); await api.close(); await stop(server); await stop(local); await fs.rm(directory, { recursive: true, force: true }); });
  return { studio, broker, harness, ownerAccess, context, project, directory, api, post, catalog, completeCommittee, configure, generatePrompts, embedBodies, cloudBodies, started,
    invalidate: async () => { allowed = false; await api.invalidateSession("session-1"); }, driftEmbedding: () => { embedDigest = "f".repeat(64); } };
}

test("production privacy catalog accepts only a completed committee's original grant/range; HTTP cannot add a root/path or local body", async t => {
  const f = await fixture(t); assert.equal((await f.catalog()).data.sources.length, 0); await f.completeCommittee(); const catalog = await f.catalog();
  assert.equal(catalog.data.sources.length, 2); assert.equal(catalog.data.revision, 0); assert.equal(JSON.stringify(catalog.data).includes(marker), false); assert.equal(JSON.stringify(catalog.data).includes(f.project), false);
  assert.ok(catalog.data.sources.every((item: Record<string, unknown>) => item.classification === "local_only" && item.startLine === 1 && item.endLine === 1));
  const selection = { operationId: catalog.data.sources[0].operationId, evidenceId: catalog.data.sources[0].evidenceId };
  assert.equal((await f.post("/privacy/local/configure", { contextId: f.context.id, expectedRevision: 0, selections: [{ ...selection, path: "new.ts" }], privateTerms: [], consent: true })).status, 400);
  assert.equal((await f.post("/privacy/local/configure", { contextId: f.context.id, expectedRevision: 0, selections: [{ ...selection, evidenceId: "not-authorized" }], privateTerms: [], consent: true })).status, 403);
  assert.equal((await f.post("/privacy/local/catalog", { contextId: f.context.id }, "different-session")).status, 409);
  const accepted = await f.configure(false, 1); assert.equal(accepted.status, 200); assert.equal(accepted.data.privateTermCount, 1); assert.equal(accepted.data.privateTerms, undefined); assert.equal(accepted.data.embeddingRuntime, undefined);
});

test("actual local prepare/redaction/cloud seam excludes selected local_only source and private names from both generator prompt and cloud body", async t => {
  const f = await fixture(t); await f.completeCommittee(); assert.equal((await f.configure(false)).status, 200); const before = f.generatePrompts.length;
  const metadata = await f.post("/privacy/context", { contextId: f.context.id }); assert.equal(metadata.status, 200); assert.equal(metadata.data.localOnlySourceCount, 2);
  const prepared = await f.post("/privacy/prepare", { contextId: f.context.id, expectedTaskRevision: metadata.data.taskRevision, requestedFields: ["evidence_summary", "limitations"] });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.data)); assert.equal(f.generatePrompts.length, before + 1); assert.equal(f.generatePrompts.at(-1)!.includes(marker), false);
  assert.equal(JSON.stringify(prepared.data).includes("InternalName"), false); assert.ok(prepared.data.draft.redactions.length);
  const approved = await f.post("/privacy/approve", { operationId: prepared.data.operationId, expectedDraftHash: prepared.data.draft.hash, approvedFields: prepared.data.draft.requestedFields, expectedRecipientFingerprint: prepared.data.recipientFingerprint, consent: true }); assert.equal(approved.status, 200);
  const sent = await f.post("/privacy/dispatch", { operationId: prepared.data.operationId, approvalId: approved.data.approval.id, expectedDraftHash: prepared.data.draft.hash, expectedRecipientFingerprint: prepared.data.recipientFingerprint });
  assert.equal(sent.status, 200, JSON.stringify(sent.data)); assert.equal(f.cloudBodies.length, 1); assert.equal(JSON.stringify(f.cloudBodies).includes(marker), false); assert.equal(JSON.stringify(f.cloudBodies).includes("InternalName"), false);
  assert.ok(f.cloudBodies[0]!.sources.every(source => /^fact-[a-f0-9]{48}$/.test(source.id))); assert.equal(JSON.stringify(f.cloudBodies).includes("claim-1"), false); assert.equal(f.embedBodies.length, 0);
});

test("explicit exact-pinned embedding uses real Ollama /api/embed vectors, metered SQLite CAS, idempotent no-replay and no source/query persistence", async t => {
  const f = await fixture(t, { searchCalls: 1 }); await f.completeCommittee(); const configured = await f.configure(true); assert.equal(configured.status, 200); assert.equal(f.embedBodies.length, 0);
  const body = { contextId: f.context.id, expectedRevision: configured.data.revision, operationId: "search-1", query: "synthetic query never persist 1726", topK: 2, consent: true };
  const searched = await f.post("/privacy/local/search", body); assert.equal(searched.status, 200, JSON.stringify(searched.data)); assert.equal(searched.data.operation.phase, "completed"); assert.equal(searched.data.usedCalls, 1); assert.equal(searched.data.operation.results.length, 2);
  assert.equal(f.embedBodies.length, 1); assert.equal(f.embedBodies[0]!.model, embedding.model); assert.equal(f.embedBodies[0]!.input[0], body.query); assert.ok(f.embedBodies[0]!.input.includes(sourceA));
  assert.equal((await f.post("/privacy/local/search", body)).status, 200); assert.equal(f.embedBodies.length, 1);
  assert.equal((await f.post("/privacy/local/search", { ...body, query: "changed" })).status, 409);
  assert.equal((await f.post("/privacy/local/search", { ...body, operationId: "search-2" })).status, 429); assert.equal(f.embedBodies.length, 1);
  const stored = JSON.stringify(f.studio.store.get("privacy-local-search", f.context.id)); assert.equal(stored.includes(marker), false); assert.equal(stored.includes(body.query), false); assert.equal(stored.includes('"embeddings"'), false); assert.equal(f.cloudBodies.length, 0);
});

test("no implicit embedding, missing separate consent, forged model digest, source drift and CAS changes stop before vector transport", async t => {
  const f = await fixture(t); await f.completeCommittee(); const configured = await f.configure(false);
  const request = { contextId: f.context.id, expectedRevision: configured.data.revision, operationId: "denied-1", query: "lease", consent: true };
  assert.equal((await f.post("/privacy/local/search", request)).status, 422);
  const current = await f.catalog(), configure = { contextId: f.context.id, expectedRevision: current.data.revision, selections: current.data.selected, privateTerms: [], consent: true, embeddingRuntime: embedding };
  assert.equal((await f.post("/privacy/local/configure", configure)).status, 400);
  assert.notEqual((await f.post("/privacy/local/configure", { ...configure, embeddingConsent: true, embeddingRuntime: { ...embedding, modelDigest: "d".repeat(64) } })).status, 200);
  assert.equal(f.embedBodies.length, 0); const pinned = await f.configure(true); assert.equal(pinned.status, 200);
  assert.equal((await f.post("/privacy/local/configure", { ...configure, embeddingConsent: true })).status, 409);
  await fs.writeFile(path.join(f.project, "lease.ts"), "export const lease = 'changed';");
  assert.notEqual((await f.post("/privacy/local/search", { ...request, expectedRevision: pinned.data.revision })).status, 200);
  assert.notEqual((await f.post("/privacy/context", { contextId: f.context.id })).status, 200); assert.equal(f.embedBodies.length, 0);
});

test("online cancellation aborts local vector transport and refuses delayed results; digest/session drift never adopts vectors", async t => {
  const wait = deferred(), f = await fixture(t, { waitEmbed: wait.promise }); await f.completeCommittee(); const configured = await f.configure(true);
  const pending = f.post("/privacy/local/search", { contextId: f.context.id, expectedRevision: configured.data.revision, operationId: "cancel-1", query: "lease", consent: true }); await f.started.promise;
  const cancelled = await f.post("/privacy/local/cancel", { contextId: f.context.id, operationId: "cancel-1" }); assert.equal(cancelled.status, 200); assert.equal(cancelled.data.operation.phase, "cancelled"); wait.resolve();
  assert.notEqual((await pending).status, 200); assert.equal(f.studio.store.get<any>("privacy-local-search", f.context.id)!.value.operations[0].results, undefined);
  f.driftEmbedding(); assert.notEqual((await f.post("/privacy/local/search", { contextId: f.context.id, expectedRevision: configured.data.revision, operationId: "drift-2", query: "lease", consent: true })).status, 200); assert.equal(f.embedBodies.length, 1);
  await f.invalidate(); assert.equal((await f.post("/privacy/local/catalog", { contextId: f.context.id })).status, 403); assert.equal(f.cloudBodies.length, 0);
});

test("selected original source changed while embedding is pending invalidates the entire late result", async t => {
  const wait = deferred(), f = await fixture(t, { waitEmbed: wait.promise }); await f.completeCommittee(); const configured = await f.configure(true);
  const pending = f.post("/privacy/local/search", { contextId: f.context.id, expectedRevision: configured.data.revision, operationId: "stale-1", query: "lease", consent: true }); await f.started.promise;
  await fs.writeFile(path.join(f.project, "lease.ts"), "export const lease = 'late-change';"); wait.resolve(); assert.notEqual((await pending).status, 200);
  const operation = f.studio.store.get<any>("privacy-local-search", f.context.id)!.value.operations[0]; assert.equal(operation.phase, "stopped"); assert.equal(operation.results, undefined); assert.equal(operation.claimed, true); assert.equal(f.embedBodies.length, 1);
});

test("changing the exact source/private-term policy invalidates old cloud approval and never silently preserves embedding authority", async t => {
  const f = await fixture(t); await f.completeCommittee(); const configured = await f.configure(true); assert.equal(configured.status, 200);
  const metadata = await f.post("/privacy/context", { contextId: f.context.id }), prepared = await f.post("/privacy/prepare", { contextId: f.context.id, expectedTaskRevision: metadata.data.taskRevision, requestedFields: ["evidence_summary", "limitations"] }); assert.equal(prepared.status, 200);
  const replacement = await f.post("/privacy/local/configure", { contextId: f.context.id, expectedRevision: configured.data.revision, selections: configured.data.selected.slice(0, 1), privateTerms: ["NewInternalName"], consent: true });
  assert.equal(replacement.status, 200); assert.equal(replacement.data.embeddingRuntime, undefined);
  const approved = await f.post("/privacy/approve", { operationId: prepared.data.operationId, expectedDraftHash: prepared.data.draft.hash, approvedFields: prepared.data.draft.requestedFields, expectedRecipientFingerprint: prepared.data.recipientFingerprint, consent: true });
  assert.notEqual(approved.status, 200); assert.equal(f.cloudBodies.length, 0);
  assert.equal((await f.post("/privacy/local/search", { contextId: f.context.id, expectedRevision: replacement.data.revision, operationId: "old-embedding", query: "lease", consent: true })).status, 422); assert.equal(f.embedBodies.length, 0);
});

test("revoking the context aborts a pending local search and no new session can resurrect its old grant or result", async t => {
  const wait = deferred(), f = await fixture(t, { waitEmbed: wait.promise }); await f.completeCommittee(); const configured = await f.configure(true);
  const pending = f.post("/privacy/local/search", { contextId: f.context.id, expectedRevision: configured.data.revision, operationId: "revoke-1", query: "lease", consent: true }); await f.started.promise;
  assert.equal((await f.post("/context/revoke", { contextId: f.context.id })).status, 200); wait.resolve(); assert.notEqual((await pending).status, 200);
  assert.equal((await f.catalog()).status, 409); assert.equal((await f.post("/privacy/local/catalog", { contextId: f.context.id }, "session-2")).status, 409);
  const operation = f.studio.store.get<any>("privacy-local-search", f.context.id)!.value.operations[0]; assert.equal(operation.phase, "cancelled"); assert.equal(operation.results, undefined); assert.equal(f.embedBodies.length, 1);
});

test("a generation-only or malformed embedding response cannot become vectors, similarity or a fallback generation call", async t => {
  const f = await fixture(t, { invalidEmbedding: true }); await f.completeCommittee(); const configured = await f.configure(true), generations = f.generatePrompts.length;
  const searched = await f.post("/privacy/local/search", { contextId: f.context.id, expectedRevision: configured.data.revision, operationId: "invalid-vector", query: "lease", consent: true });
  assert.notEqual(searched.status, 200); assert.equal(f.generatePrompts.length, generations); assert.equal(f.embedBodies.length, 1); assert.equal(f.cloudBodies.length, 0);
  const operation = f.studio.store.get<any>("privacy-local-search", f.context.id)!.value.operations[0]; assert.equal(operation.phase, "stopped"); assert.equal(operation.results, undefined);
});

test("real SQLite restart retains hashed search receipts but revokes old context/source/embedding authorization instead of restoring it", async t => {
  const f = await fixture(t); await f.completeCommittee(); const configured = await f.configure(true);
  assert.equal((await f.post("/privacy/local/search", { contextId: f.context.id, expectedRevision: configured.data.revision, operationId: "durable-1", query: "lease", consent: true })).status, 200);
  const before = f.studio.store.get("privacy-local-search", f.context.id)!; await f.api.close();
  const restored = new CareerStudio({ ownerId: "owner-1", directory: path.join(f.directory, "private"), broker: f.broker, localClient: () => { throw Error("restart must not restore a model call"); } });
  try {
    assert.equal(restored.store.get("privacy-local-search", f.context.id)!.hash, before.hash);
    await assert.rejects(restored.getContext(f.context.id, f.ownerAccess)); assert.equal(f.embedBodies.length, 1);
    assert.equal(JSON.stringify(restored.store.get("privacy-local-search", f.context.id)).includes(marker), false);
  } finally { restored.close(); }
});
