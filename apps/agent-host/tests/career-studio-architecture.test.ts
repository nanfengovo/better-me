import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CareerStudio } from "../src/career-studio/service.js";
import { createCareerStudioHttp } from "../src/career-studio/http.js";
import { EvidenceBroker } from "../src/understanding/evidence-broker.js";
import { studioArchitectureKey } from "../src/career-studio/architecture-artifacts.js";
import { createStudioCommitteeHarness, committeeSchema } from "./fixtures/studio-committee.js";
import type { LocalCompletionRequest, LocalOllamaClient } from "../src/privacy/local-ollama.js";
import type { StudioContext, StudioContextInput, StudioOperation } from "../src/career-studio/contracts.js";
import { applyArchitectureCommand, createArchitectureDocument, newArchitectureNode, simulateArchitectureFault,
  type ArchitectureBinding, type ArchitectureDocument, type ArchitectureEvidence } from "../../web/src/lib/architecture-lab/index.ts";

const runtime = { model: "synthetic-architecture-protocol", modelDigest: "a".repeat(64) };
const sourceFingerprint = "b".repeat(64);
const input = (): StudioContextInput => ({ workspaceKey: "workspace-architecture", resumeId: "stable-resume", sourceFingerprint, consent: true,
  claims: [{ id: "claim-1", text: "实现本地事务边界，独立作者和生产部署仍需确认。", contribution: "unknown", confirmedByUser: false, confirmedNumericTokens: [], skillIds: ["sqlite"] }], jobs: [] });
type RecordResponse = { record: null | { id: string; revision: number; value: { contextId: string; ownerId: string; workspaceKey: string; resumeId: string; sourceFingerprint: string; mode: string; value: ArchitectureDocument } } };
type EvidenceResponse = { contextId: string; receiptId: string; evidence: ArchitectureEvidence[]; limitations: string[] };
const contextBinding = (context: StudioContext, generation = 1): ArchitectureBinding => ({ ownerId: context.ownerId, sessionGeneration: generation,
  projectId: context.resumeId, revision: context.sourceFingerprint, contentHash: context.sourceFingerprint });
function graph(context: StudioContext, evidence: ArchitectureEvidence[], generation = 1) {
  let document = createArchitectureDocument(contextBinding(context, generation), evidence, "synthetic-graph");
  const node = newArchitectureNode("store-1", "store", 100, 100); node.evidenceIds = evidence.map(item => item.id);
  document = applyArchitectureCommand(document, { type: "add-node", node }); return document;
}
function modelResponse(request: LocalCompletionRequest): string {
  request.signal.throwIfAborted();
  const selected = JSON.parse(request.prompt.match(/^SELECTED_SNAPSHOT=(.*)$/m)![1]!) as { claims: Array<{ id: string }>; evidenceCatalog: Array<{ id: string; startLine: number; endLine: number }> };
  const role = request.prompt.match(/Role=(\w+);/)![1]!, schema = committeeSchema(request);
  if (schema.properties.kind.const === "request_evidence") return JSON.stringify({ kind: "request_evidence", requests: selected.evidenceCatalog.map(item => ({ evidenceId: item.id, startLine: item.startLine, endLine: item.endLine })) });
  const citations = JSON.parse(request.prompt.match(/^HOST_CITATION_CATALOG=(.*)$/m)![1]!);
  return JSON.stringify({ kind: "assessment", role, summary: "合成协议，仅核对所选片段。", claims: selected.claims.map(claim => ({ claimId: claim.id, support: citations.length ? "supported" : "unknown", citations,
    counterCitations: [], risks: [], missing: [], questions: ["事务失败的边界在哪里？"], defense: [] })) });
}
async function setup(t: test.TestContext) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "betterme-architecture-http-")));
  const sourceRoot = path.join(temporary, "synthetic-project"), privateRoots = [path.join(temporary, "private-a"), path.join(temporary, "private-b")];
  await fs.mkdir(sourceRoot); const sourceFile = path.join(sourceRoot, "transaction.ts");
  await fs.writeFile(sourceFile, "export const beginTransaction = true;\nexport const rollbackOnError = true;\n", { mode: 0o600 });
  let grantCalls = 0, readCalls = 0;
  class CountingBroker extends EvidenceBroker {
    override async grant(root: string) { grantCalls++; return super.grant(root); }
    override async execute(...args: Parameters<EvidenceBroker["execute"]>) { readCalls++; return super.execute(...args); }
  }
  const broker = new CountingBroker({ forbiddenRoots: privateRoots });
  const handlers = new Map<string, ReturnType<typeof createCareerStudioHttp>>(), studios = new Map<string, CareerStudio>();
  const harnesses = new Map<string, ReturnType<typeof createStudioCommitteeHarness>>();
  const sessions = new Map([["owner-a:session-a", true], ["owner-a:new-session", true], ["owner-b:session-b", true]]);
  const readBody = async (request: IncomingMessage) => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; };
  const server = createServer(async (request, response) => {
    const owner = String(request.headers["x-fixture-owner"] ?? "owner-a"), session = String(request.headers["x-fixture-session"] ?? "session-a");
    const handler = handlers.get(owner);
    if (!handler || !await handler.handleOwner(request, response, new URL(request.url ?? "/", "http://127.0.0.1").pathname,
      { session, valid: async () => sessions.get(`${owner}:${session}`) === true })) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const open = (ownerId: string) => {
    const client: LocalOllamaClient = { binding: async () => ({ id: "synthetic-local-binding", version: "fixture-v1", location: "local", endpointFingerprint: "c".repeat(64), ...runtime }), complete: async request => modelResponse(request) };

    const harness = createStudioCommitteeHarness({ ownerId, directory: path.join(privateRoots[ownerId === "owner-a" ? 0 : 1]!, "tasks"), broker, studio: () => studio, complete: request => client.complete(request) });
    const studio: CareerStudio = new CareerStudio({ ownerId, directory: privateRoots[ownerId === "owner-a" ? 0 : 1]!, broker, localClient: () => client, committeeTasks: harness.tasks });
    harnesses.set(ownerId, harness);
    const handler = createCareerStudioHttp({ studio, ownerId, baseURL: origin, allowedOrigins: [origin], readBody,
      sendJson: (response, status, data) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(data)); } });
    studios.set(ownerId, studio); handlers.set(ownerId, handler); return studio;
  };
  open("owner-a"); open("owner-b");
  const request = async <T = Record<string, unknown>>(route: string, body: unknown, owner = "owner-a", session = "session-a") => {
    const response = await fetch(`${origin}/api/v1/agent/career-studio${route}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Fixture-Owner": owner, "X-Fixture-Session": session },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: response.status, data: await response.json() as T };
  };
  const createContext = async (override: Partial<StudioContextInput> = {}, owner = "owner-a", session = "session-a") => {
    const result = await request<{ context: StudioContext }>("/context/create", { ...input(), ...override }, owner, session); assert.equal(result.status, 200); return result.data.context;
  };
  const committee = async (context: StudioContext) => {
    assert.equal((await request("/runtime/select", { contextId: context.id, runtime, consent: true })).status, 200);
    const pending = { status: 200, data: await harnesses.get("owner-a")!.start({ contextId: context.id, idempotencyKey: "synthetic-committee", runtime, consent: true,
      claimIds: ["claim-1"], statements: [], code: [{ root: sourceRoot, files: [{ path: "transaction.ts", startLine: 1, endLine: 2 }] }] }, { session: "session-a", valid: async () => sessions.get("owner-a:session-a") === true }) };
    assert.equal(pending.status, 200);
    for (let step = 0; step < 300; step++) {
      const operation = await request<StudioOperation>("/operation/read", { contextId: context.id, operationId: pending.data.id });
      assert.equal(operation.status, 200);
      if (operation.data.status !== "running") { assert.equal(operation.data.status, "completed", operation.data.errorCode); return operation.data; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error("Synthetic committee exceeded bounded polling.");
  };
  t.after(async () => { for (const harness of harnesses.values()) await harness.close(); for (const handler of handlers.values()) await handler.close(); server.closeIdleConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await fs.rm(temporary, { recursive: true, force: true }); });
  return { request, createContext, committee, studios, handlers, harnesses, open, sourceFile, sessions, counts: () => ({ grantCalls, readCalls }) };
}
const saveBody = (context: StudioContext, document: ArchitectureDocument, expectedRevision = 0) => ({ contextId: context.id, kind: "architecture", id: context.resumeId, expectedRevision, value: document });
const loadBody = (context: StudioContext) => ({ contextId: context.id, kind: "architecture", id: context.resumeId });

test("real SQLite/HTTP CAS preserves history, restores a stable resume across reauthorization/restart, and never inherits old model authority", async t => {
  const f = await setup(t), context = await f.createContext();
  const original = graph(context, [{ id: "claim-1", label: "本人选择的原句（自述，非独立源码证据）", excerpt: context.claims[0]!.text }]);
  original.faults.push(simulateArchitectureFault(original, { kind: "disk-full", targetNodeId: "store-1" }, { id: "fault-1" }));
  const saved = await f.request<RecordResponse>("/artifact/save", saveBody(context, original)); assert.equal(saved.status, 200); assert.equal(saved.data.record?.revision, 1);
  assert.deepEqual(saved.data.record?.value.value, original);
  assert.equal((await f.request("/artifact/save", saveBody(context, original))).status, 409);
  const changed = { ...original, title: "保留历史的第二版", revision: original.revision + 1 };
  const second = await f.request<RecordResponse>("/artifact/save", saveBody(context, changed, 1)); assert.equal(second.status, 200); assert.equal(second.data.record?.revision, 2);
  const history = f.studios.get("owner-a")!.store.list<{ record: { revision: number; value: { value: ArchitectureDocument } } }>("architecture-history");
  assert.equal(history.length, 1); assert.equal(history[0]!.value.record.revision, 1); assert.deepEqual(history[0]!.value.record.value.value, original);
  const fresh = await f.createContext();
  const restored = await f.request<RecordResponse>("/artifact/load", loadBody(fresh)); assert.equal(restored.status, 200);
  assert.equal(restored.data.record?.revision, 2); assert.equal(restored.data.record?.value.mode, "graph-draft");
  assert.equal(restored.data.record?.value.contextId, fresh.id); assert.equal(restored.data.record?.value.value.nodes.length, 1); assert.equal(restored.data.record?.value.value.faults.length, 0);
  assert.equal(f.studios.get("owner-a")!.store.get<{ value: ArchitectureDocument }>("architecture", studioArchitectureKey(context))!.value.value.faults.length, 1, "load does not rewrite original historical authority");
  await f.harnesses.get("owner-a")!.close(); await f.handlers.get("owner-a")!.close(); f.open("owner-a");
  assert.equal((await f.request("/artifact/load", loadBody(fresh))).status, 409, "old process consent is revoked");
  const afterRestart = await f.createContext();
  const persisted = await f.request<RecordResponse>("/artifact/load", loadBody(afterRestart)); assert.equal(persisted.status, 200); assert.equal(persisted.data.record?.value.value.title, changed.title);
  assert.equal(f.studios.get("owner-a")!.store.list("architecture-history").length, 1);
});

test("owner, session, workspace, resume and source are independent server-side artifact boundaries", async t => {
  const f = await setup(t), context = await f.createContext();
  const original = graph(context, []); assert.equal((await f.request("/artifact/save", saveBody(context, original))).status, 200);
  for (const changed of [{ workspaceKey: "other-workspace" }, { resumeId: "other-resume" }, { sourceFingerprint: "d".repeat(64) }]) {
    const selected = await f.createContext(changed); const result = await f.request<RecordResponse>("/artifact/load", loadBody(selected)); assert.equal(result.status, 200); assert.equal(result.data.record, null);
  }
  const ownerB = await f.createContext({}, "owner-b", "session-b");
  const other = await f.request<RecordResponse>("/artifact/load", loadBody(ownerB), "owner-b", "session-b"); assert.equal(other.status, 200); assert.equal(other.data.record, null);
  assert.equal((await f.request("/artifact/load", loadBody(context), "owner-b", "session-b")).status, 409);
  assert.equal((await f.request("/artifact/load", loadBody(context), "owner-a", "new-session")).status, 409);
  assert.equal((await f.request("/artifact/load", { ...loadBody(context), id: "unselected-project" })).status, 403);
  const forged = structuredClone(original); forged.binding.ownerId = "owner-b";
  assert.equal((await f.request("/artifact/save", saveBody(context, forged, 1))).status, 403);
  f.sessions.set("owner-a:session-a", false); assert.equal((await f.request("/artifact/load", loadBody(context))).status, 403);
});

test("explicit source import only rereads completed authorized committee ranges, and stale or forged evidence cannot save", async t => {
  const f = await setup(t), context = await f.createContext();
  assert.equal((await f.request("/architecture/evidence", { contextId: context.id, operationId: "missing", consent: true })).status, 403);
  const operation = await f.committee(context), counts = f.counts();
  assert.equal((await f.request("/architecture/evidence", { contextId: context.id, operationId: operation.id, consent: false })).status, 400);
  assert.equal((await f.request("/architecture/evidence", { contextId: context.id, operationId: operation.id, consent: true, path: "other.ts" })).status, 400);
  const imported = await f.request<EvidenceResponse>("/architecture/evidence", { contextId: context.id, operationId: operation.id, consent: true });
  assert.equal(imported.status, 200); assert.equal(imported.data.evidence.length, 2); assert.match(imported.data.receiptId, /^[a-f0-9]{64}$/);
  assert.equal(f.counts().grantCalls, counts.grantCalls, "no new source grant is created"); assert.equal(f.counts().readCalls, counts.readCalls + 1);
  const code = imported.data.evidence.find(item => item.path)!; assert.equal(code.path, "transaction.ts"); assert.equal(code.startLine, 1); assert.equal(code.endLine, 2); assert.match(code.excerpt, /rollbackOnError/);
  assert.equal(JSON.stringify(imported.data).includes(path.dirname(f.sourceFile)), false, "private grant root is never sent back");
  const document = graph(context, imported.data.evidence);
  assert.equal((await f.request("/artifact/save", saveBody(context, document))).status, 200);
  const forged = structuredClone(document); forged.evidence.find(item => item.path)!.excerpt = "The model claims this is real source.";
  assert.equal((await f.request("/artifact/save", saveBody(context, forged, 1))).status, 403);
  const fresh = await f.createContext();
  const restored = await f.request<RecordResponse>("/artifact/load", loadBody(fresh)); assert.equal(restored.status, 200);
  assert.equal(restored.data.record?.value.value.evidence.some(item => item.path), false, "old private code requires new explicit authorization");
  assert.deepEqual(restored.data.record?.value.value.nodes[0]!.evidenceIds, ["claim-1"]);
  const wrongContext = await f.request("/architecture/evidence", { contextId: fresh.id, operationId: operation.id, consent: true });
  assert.equal(wrongContext.status, 404); assert.equal(wrongContext.data.error, "studio_operation_not_found");
  await fs.writeFile(f.sourceFile, "export const changedSource = true;\nexport const rollbackOnError = false;\n", { mode: 0o600 });
  assert.equal((await f.request("/architecture/evidence", { contextId: context.id, operationId: operation.id, consent: true })).status, 409);
  assert.equal((await f.request("/artifact/save", saveBody(context, document, 1))).status, 409);
  assert.equal(f.studios.get("owner-a")!.store.get("architecture", studioArchitectureKey(context))!.revision, 1);
});
