import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { createPrivacyHttp, PRIVACY_OPERATION_KIND } from "../src/career-studio/privacy-http.js";
import type { PrivacyStudioContext, StoredPrivacyOperation } from "../src/career-studio/privacy-http.js";
import { StudioArtifactStore } from "../src/career-studio/storage.js";
import { createJsonHttpCloudAdapter, createLocalOllamaClient, createOllamaPrivacyAdapter } from "../src/privacy/index.js";

const digest = "e".repeat(64), localOnly = "PRIVATE_LOCAL_ONLY_CANARY_819743";
const auth = { ownerId: "owner-1", sessionId: "session-1", sessionGeneration: 1, authorizationGeneration: 1 };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; };
async function listen(server: Server) { server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address === "object"); return `http://127.0.0.1:${address.port}`; }
async function stop(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
async function fixture(t: { after(fn: () => Promise<void> | void): void }, input: { noCloud?: boolean; wait?: Promise<void>; localCalls?: number } = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "betterme-privacy-http-"))), store = new StudioArtifactStore("owner-1", directory);
  const cloudBodies: string[] = [], modelPrompts: string[] = [], started = deferred<void>();
  const cloudServer = createServer(async (request, response) => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); cloudBodies.push(Buffer.concat(chunks).toString("utf8")); started.resolve(); await input.wait; if (!response.destroyed) { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ text: "CAS evidence supports idempotent state restoration.", sourceIds: ["fact-1"], unknowns: ["No performance metric supplied."] })); } });
  const cloudBase = await listen(cloudServer);
  const localServer = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/version") { response.end(JSON.stringify({ version: "0.40.15" })); return; }
    if (request.url === "/api/tags") { response.end(JSON.stringify({ models: [{ name: "synthetic-local", digest }] })); return; }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")); modelPrompts.push(body.prompt);
    response.end(JSON.stringify({ done: true, done_reason: "stop", model: "synthetic-local", response: JSON.stringify({ fields: [{ name: "evidence", text: "Implemented CAS guarded idempotent state restoration.", sourceIds: ["fact-1"] }] }) }));
  });
  const localBase = await listen(localServer), client = createLocalOllamaClient({ endpoint: localBase, model: "synthetic-local", expectedDigest: digest });
  const local = createOllamaPrivacyAdapter(client, { budget: { maxInputBytes: 100_000, maxOutputBytes: 16_000, maxActiveMs: 5000 } });
  const configuredCloud = input.noCloud ? undefined : createJsonHttpCloudAdapter({ endpoint: `${cloudBase}/reason`, recipientId: "synthetic-cloud", model: "synthetic-reasoner", allowLoopbackHttpFixture: true });
  let revision = 1, generation = 1;
  const context: PrivacyStudioContext = { taskRevision: 1, policy: { version: "policy-v1", allowedFields: ["evidence"], privateTerms: [], maxFieldCharacters: 4000 }, sources: [{ id: "fact-1", revision: "v1", classification: "summary_allowed", kind: "fact", text: "Implemented CAS guarded idempotent state restoration." }, { id: "raw-1", revision: "v1", classification: "local_only", kind: "source", text: `${localOnly}\napi_key="SYNTHETIC_SECRET_1928364"\n/Users/synthetic/private.ts` }], budget: { revision: 1, maxLocalCalls: input.localCalls ?? 3, maxCloudCalls: 1, maxInputBytes: 100_000, maxOutputBytes: 16_000, maxActiveMs: 5000 } };
  const makeRuntime = () => createPrivacyHttp({ ownerId: "owner-1", store, translateAccess: async (stamp: typeof auth) => ({ ...stamp, valid: async () => stamp.sessionGeneration === generation }), getContext: async () => ({ ...structuredClone(context), taskRevision: revision }), selectedLocal: async () => local, configuredCloud, readBody: async request => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString("utf8")); }, sendJson: (response, status, data) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(data)); } });
  let runtime = makeRuntime();
  const server = createServer(async (request, response) => { if (!await runtime.handleOwner(request, response, new URL(request.url!, "http://127.0.0.1").pathname, auth)) { response.writeHead(404); response.end(); } });
  const base = await listen(server);
  t.after(async () => { runtime.close(); await stop(server); await stop(localServer); await stop(cloudServer); store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const post = async (operation: string, data: unknown) => { const response = await fetch(`${base}/api/v1/agent/career-studio/privacy/${operation}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) }); return { status: response.status, data: await response.json() as Record<string, any> }; };
  const prepare = () => post("prepare", { contextId: "explicit-source-context", expectedTaskRevision: 1, requestedFields: ["evidence"] });
  const approve = (prepared: Record<string, any>) => post("approve", { operationId: prepared.operationId, expectedDraftHash: prepared.draft.hash, approvedFields: ["evidence"], expectedRecipientFingerprint: prepared.recipientFingerprint, consent: true });
  const dispatch = (prepared: Record<string, any>, approved: Record<string, any>) => post("dispatch", { operationId: prepared.operationId, approvalId: approved.approval.id, expectedDraftHash: prepared.draft.hash, expectedRecipientFingerprint: prepared.recipientFingerprint });
  return { store, post, prepare, approve, dispatch, modelPrompts, cloudBodies, started, restart: () => { runtime.close(); runtime = makeRuntime(); }, bumpRevision: () => revision++, switchSession: () => generation++, runtime: () => runtime };
}

test("privacy context metadata reveals only allowed fields and pinned runtime, not source bodies or private terms", async t => {
  const f = await fixture(t), metadata = await f.post("context", { contextId: "explicit-source-context" });
  assert.equal(metadata.status, 200); assert.equal(metadata.data.taskRevision, 1); assert.deepEqual(metadata.data.allowedFields, ["evidence"]);
  assert.equal(metadata.data.localOnlySourceCount, 1); assert.equal(metadata.data.cloudAvailable, true);
  assert.equal(metadata.data.runtime.local.model, "synthetic-local"); assert.equal(metadata.data.runtime.local.modelDigest, digest);
  assert.match(metadata.data.sourceSnapshotHash, /^[a-f0-9]{64}$/); assert.match(metadata.data.localRuntimeFingerprint, /^[a-f0-9]{64}$/);
  assert.match(metadata.data.recipientFingerprint, /^[a-f0-9]{64}$/); assert.equal(metadata.data.sources, undefined); assert.equal(metadata.data.privateTerms, undefined);
  assert.equal(JSON.stringify(metadata.data).includes(localOnly), false); assert.equal(JSON.stringify(metadata.data).includes("SYNTHETIC_SECRET"), false);
  assert.equal(f.modelPrompts.length, 0); assert.equal(f.cloudBodies.length, 0);
  f.switchSession(); assert.equal((await f.post("context", { contextId: "explicit-source-context" })).status, 403);
});

test("privacy persistent actual HTTP local-model prepare -> exact consent -> cloud capture -> private derived artifact", async t => {
  const f = await fixture(t), prepared = await f.prepare(); assert.equal(prepared.status, 200); assert.equal(f.modelPrompts.length, 1); assert.equal(f.modelPrompts[0]!.includes(localOnly), false); assert.equal(f.cloudBodies.length, 0);
  assert.equal(prepared.data.runtime.local.location, "local"); assert.match(prepared.data.runtime.local.endpointFingerprint, /^[a-f0-9]{64}$/);
  const approved = await f.approve(prepared.data); assert.equal(approved.status, 200); assert.equal(f.cloudBodies.length, 0);
  const result = await f.dispatch(prepared.data, approved.data); assert.equal(result.status, 200); assert.equal(result.data.adopted, false); assert.equal(f.cloudBodies.length, 1); assert.equal(f.cloudBodies[0]!.includes(localOnly), false);
  const operation = f.store.get<StoredPrivacyOperation>(PRIVACY_OPERATION_KIND, prepared.data.operationId)!.value;
  assert.equal(operation.dispatchClaim?.status, "completed"); assert.equal(operation.localCalls, 2); assert.equal(operation.localClaims.length, 2); assert.equal(JSON.stringify(operation).includes(localOnly), false); assert.equal(JSON.stringify(operation).includes("SYNTHETIC_SECRET"), false);
  assert.equal((await f.post("read", { operationId: prepared.data.operationId })).data.continuation, "completed_no_replay");
  assert.equal((await f.dispatch(prepared.data, approved.data)).status, 409); assert.equal(f.cloudBodies.length, 1);
});

test("privacy absent configured cloud is explicitly unavailable after local prepare and never selects fallback", async t => {
  const f = await fixture(t, { noCloud: true }), prepared = await f.prepare(); assert.equal(prepared.status, 200); assert.equal(prepared.data.cloudAvailable, false); assert.equal(f.modelPrompts.length, 1);
  const approved = await f.approve(prepared.data); assert.equal(approved.status, 503); assert.equal(approved.data.error, "privacy_cloud_not_configured"); assert.equal(f.cloudBodies.length, 0);
});

test("privacy restart invalidates old preview consent; fresh operation must preview and consent again", async t => {
  const f = await fixture(t), prepared = await f.prepare(); f.restart();
  const old = await f.approve(prepared.data); assert.equal(old.status, 409); assert.equal(old.data.error, "privacy_restart_requires_fresh_preview");
  assert.equal((await f.post("read", { operationId: prepared.data.operationId })).data.continuation, "fresh_preview_required");
  const fresh = await f.prepare(); assert.equal(fresh.status, 200); assert.notEqual(fresh.data.operationId, prepared.data.operationId); assert.notEqual(fresh.data.draft.hash, prepared.data.draft.hash); assert.equal(f.cloudBodies.length, 0);
});

test("privacy persisted unknown dispatch claim survives restart and refuses replay or late adoption", async t => {
  const wait = deferred<void>(), f = await fixture(t, { wait: wait.promise }), prepared = await f.prepare(), approved = await f.approve(prepared.data);
  const dispatch = f.dispatch(prepared.data, approved.data); await f.started.promise;
  assert.equal(f.store.get<StoredPrivacyOperation>(PRIVACY_OPERATION_KIND, prepared.data.operationId)!.value.dispatchClaim?.status, "unknown");
  f.restart(); wait.resolve(); const late = await dispatch; assert.notEqual(late.status, 200);
  const read = await f.post("read", { operationId: prepared.data.operationId }); assert.equal(read.data.continuation, "unknown_dispatch_no_replay"); assert.equal(read.data.operation.result, undefined);
  const again = await f.dispatch(prepared.data, approved.data); assert.equal(again.status, 409); assert.equal(again.data.error, "privacy_dispatch_already_claimed_no_replay"); assert.equal(f.cloudBodies.length, 1);
});

test("privacy storage failure and exhausted local budget stop before cloud/model dispatch without fallback", async t => {
  const f = await fixture(t, { localCalls: 1 }), exhausted = await f.prepare(); assert.equal(exhausted.status, 409); assert.equal(exhausted.data.error, "local_budget_exhausted"); assert.equal(f.modelPrompts.length, 0); assert.equal(f.cloudBodies.length, 0);
  const g = await fixture(t), prepared = await g.prepare(), approved = await g.approve(prepared.data), original = g.store.put;
  g.store.put = () => { throw new Error('disk full api_key="SYNTHETIC_CANARY_17823"'); };
  const denied = await g.dispatch(prepared.data, approved.data); assert.equal(denied.status, 409); assert.equal(denied.data.error, "cloud_dispatch_gate_unavailable"); assert.equal(JSON.stringify(denied).includes("SYNTHETIC_CANARY"), false); assert.equal(g.cloudBodies.length, 0);
  g.store.put = original;
});

test("privacy context version drift and online revoke reject sends/results but preserve unknown history", async t => {
  const f = await fixture(t), prepared = await f.prepare(); f.bumpRevision(); assert.notEqual((await f.approve(prepared.data)).status, 200); assert.equal(f.cloudBodies.length, 0);
  const wait = deferred<void>(), g = await fixture(t, { wait: wait.promise }), draft = await g.prepare(), approved = await g.approve(draft.data);
  const dispatch = g.dispatch(draft.data, approved.data); await g.started.promise;
  assert.equal((await g.post("revoke", { operationId: draft.data.operationId })).status, 200); wait.resolve(); assert.notEqual((await dispatch).status, 200);
  const record = g.store.get<StoredPrivacyOperation>(PRIVACY_OPERATION_KIND, draft.data.operationId)!.value; assert.equal(record.phase, "revoked"); assert.equal(record.result, undefined); assert.equal(record.dispatchClaim?.status, "unknown");
});
