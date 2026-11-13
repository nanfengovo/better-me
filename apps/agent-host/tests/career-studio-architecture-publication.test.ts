import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CareerStudio } from "../src/career-studio/service.js";
import { createCareerStudioHttp } from "../src/career-studio/http.js";
import { EvidenceBroker } from "../src/understanding/evidence-broker.js";
import { createStudioCommitteeHarness, committeeSchema } from "./fixtures/studio-committee.js";
import type { LocalCompletionRequest, LocalOllamaClient } from "../src/privacy/local-ollama.js";
import type { StudioContext, StudioOperation } from "../src/career-studio/contracts.js";
import type { CandidateCapsule, TwinPreview } from "../src/candidate-twin/types.js";
import { applyArchitectureCommand, createArchitectureDocument, newArchitectureNode, type ArchitectureDocument } from "../../web/src/lib/architecture-lab/index.ts";

const runtime = { model: "synthetic-design-publication", modelDigest: "a".repeat(64) };
const claim = "Drafted a data flow design; deployment and implementation remain unknown.";
type Source = { id: string; revision: number; hash: string };
type Catalog = { source: null | Source & { title: string; nodes: { id: string; label: string }[]; edges: { id: string; from: string; to: string; label: string }[] }; publications: { id: string; hash: string; statement: string }[]; limitations: string[] };
type Preview = { previewId: string; previewHash: string; expiresAt: string; source: Source; publicContent: { design: string; diagram: { nodes: { id: string; label: string }[]; edges: { from: string; to: string; label: string }[] }; limitations: string }; redactions: { category: string; count: number }[] };
type Confirmed = { publication: { id: string; revision: number; hash: string; fact: { id: string; statement: string; design: string; limitations: string; evidence: unknown[]; diagram: Preview["publicContent"]["diagram"] } }; adopted: false; published: false };
function protocol(request: LocalCompletionRequest): string {
  request.signal.throwIfAborted();
  const selected = JSON.parse(request.prompt.match(/^SELECTED_SNAPSHOT=(.*)$/m)![1]!) as { claims: { id: string }[]; evidenceCatalog: { id: string; startLine: number; endLine: number }[] };
  const role = request.prompt.match(/Role=(\w+);/)![1]!, schema = committeeSchema(request);
  if (schema.properties.kind.const === "request_evidence") return JSON.stringify({ kind: "request_evidence", requests: selected.evidenceCatalog.map(item => ({ evidenceId: item.id, startLine: item.startLine, endLine: item.endLine })) });
  const citations: unknown[] = JSON.parse(request.prompt.match(/^HOST_CITATION_CATALOG=(.*)$/m)![1]!);
  return JSON.stringify({ kind: "assessment", role, summary: "Synthetic protocol: selected design self-statement only.", claims: selected.claims.map(item => ({ claimId: item.id, support: "supported", citations,
    counterCitations: [], risks: [], missing: [], questions: ["What remains unknown?"], defense: [] })) });
}
function drawing(context: StudioContext): ArchitectureDocument {
  let document = createArchitectureDocument({ ownerId: context.ownerId, sessionGeneration: 1, projectId: context.resumeId, revision: context.sourceFingerprint, contentHash: context.sourceFingerprint }, [], "private-drawing-id");
  document.title = "PrivateTeam data flow";
  const gateway = newArchitectureNode("private-gateway-id", "service", 100, 100); gateway.label = "PrivateTeam Gateway"; gateway.notes = "PRIVATE_NOTES_CANARY; never publish this note.";
  const store = newArchitectureNode("private-store-id", "store", 300, 100); store.label = "SQLite";
  document = applyArchitectureCommand(document, { type: "add-node", node: gateway });
  document = applyArchitectureCommand(document, { type: "add-node", node: store });
  document.edges.push({ id: "private-edge-id", from: gateway.id, to: store.id, label: "PRIVATE_EDGE_LABEL_CANARY", kind: "write", failurePolicy: "unknown", sessionPolicy: "unknown", evidenceIds: [] });
  return document;
}
async function setup(t: test.TestContext) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "betterme-design-publication-")));
  const sourceRoot = path.join(temporary, "synthetic-source"); await fs.mkdir(sourceRoot);
  await fs.writeFile(path.join(sourceRoot, "private-module.ts"), "export const INTERNAL_SOURCE_CANARY = true;\nreturn42;\n", { mode: 0o600 });
  const handlers = new Map<string, ReturnType<typeof createCareerStudioHttp>>();
  const harnesses = new Map<string, ReturnType<typeof createStudioCommitteeHarness>>();
  const sessions = new Map([["owner-a:session-a", true], ["owner-a:new-session", true], ["owner-b:session-b", true]]);
  let validationHook: (() => void | Promise<void>) | undefined;
  let brokerCalls = 0;
  class NoSourceBroker extends EvidenceBroker {
    override async execute(...args: Parameters<EvidenceBroker["execute"]>) { brokerCalls++; return super.execute(...args); }
    override async grant(root: string) { brokerCalls++; return super.grant(root); }
  }
  const readBody = async (request: IncomingMessage) => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; };
  const server = createServer(async (request, response) => {
    const owner = String(request.headers["x-fixture-owner"] ?? "owner-a"), session = String(request.headers["x-fixture-session"] ?? "session-a");
    const handler = handlers.get(owner), pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (handler && (await handler.handlePublic(request, response, pathname) || await handler.handleOwner(request, response, pathname, { session, valid: async () => { await validationHook?.(); return sessions.get(`${owner}:${session}`) === true; } }))) return;
    response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const open = (ownerId: string) => {
    const client: LocalOllamaClient = { binding: async () => ({ id: "synthetic-local", version: "fixture-v1", location: "local", endpointFingerprint: "c".repeat(64), ...runtime }), complete: async request => protocol(request) };
    const broker = new NoSourceBroker();
    const harness = createStudioCommitteeHarness({ ownerId, directory: path.join(temporary, ownerId, "tasks"), broker, studio: () => studio, complete: request => client.complete(request) });
    const studio: CareerStudio = new CareerStudio({ ownerId, directory: path.join(temporary, ownerId), broker, localClient: () => client, committeeTasks: harness.tasks });
    harnesses.set(ownerId, harness);
    const handler = createCareerStudioHttp({ studio, ownerId, baseURL: origin, allowedOrigins: [origin], readBody, sendJson: (response, status, data) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(data)); } });
    handlers.set(ownerId, handler); return handler;
  };
  open("owner-a"); open("owner-b");
  const request = async <T = Record<string, unknown>>(route: string, body: unknown, owner = "owner-a", session = "session-a") => {
    const response = await fetch(`${origin}/api/v1/agent/career-studio${route}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Fixture-Owner": owner, "X-Fixture-Session": session }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: response.status, data: await response.json() as T };
  };
  const context = async (owner = "owner-a", session = "session-a") => {
    const created = await request<{ context: StudioContext }>("/context/create", { workspaceKey: "design-workspace", resumeId: "design-resume", sourceFingerprint: "b".repeat(64), consent: true,
      claims: [{ id: "private-claim-id", text: claim, skillIds: ["sqlite"], contribution: "design", confirmedByUser: true, confirmedNumericTokens: [] }], jobs: [] }, owner, session);
    assert.equal(created.status, 200); return created.data.context;
  };
  const reviewed = async (selected: StudioContext, withCode = false) => {
    assert.equal((await request("/runtime/select", { contextId: selected.id, runtime, consent: true })).status, 200);
    const pending = { data: await harnesses.get("owner-a")!.start({ contextId: selected.id, runtime, consent: true, idempotencyKey: "base-committee", claimIds: ["private-claim-id"], statements: [{ label: "Selected design self-statement", kind: "design", text: claim }], code: withCode ? [{ root: sourceRoot, files: [{ path: "private-module.ts", startLine: 1, endLine: 2 }] }] : [] }, { session: "session-a", valid: async () => sessions.get("owner-a:session-a") === true }) };
    let operation = pending.data;
    for (let step = 0; step < 300 && operation.status === "running"; step++) { await new Promise(resolve => setTimeout(resolve, 5)); operation = (await request<StudioOperation>("/operation/read", { contextId: selected.id, operationId: operation.id })).data; }
    assert.equal(operation.status, "completed", JSON.stringify(operation));
    const sidecar = (operation.output as { claims: { claimHash: string }[] }).claims[0]!;
    const publication = await request<{ id: string }>("/publication/review", { contextId: selected.id, operationId: operation.id, claimId: "private-claim-id", expectedClaimHash: sidecar.claimHash, disclosure: "publishable", review: { kind: "design", action: "Drafted the selected design", role: "Personal self-statement", deployment: "Unknown" }, consent: true, idempotencyKey: "base-review" }); assert.equal(publication.status, 200); return { ...publication.data, operationId: operation.id };
  };
  const save = (selected: StudioContext, document: ArchitectureDocument, expectedRevision = 0) => request("/artifact/save", { contextId: selected.id, kind: "architecture", id: selected.resumeId, expectedRevision, value: document });
  const selection = (selected: StudioContext, catalog: Catalog) => ({ contextId: selected.id, publicationId: catalog.publications[0]!.id, expectedPublicationHash: catalog.publications[0]!.hash,
    source: { id: catalog.source!.id, revision: catalog.source!.revision, hash: catalog.source!.hash }, nodeIds: ["private-gateway-id", "private-store-id"], edgeIds: ["private-edge-id"], fields: ["title", "node.label"], privateTerms: ["PrivateTeam"], consent: true });
  t.after(async () => { for (const harness of harnesses.values()) await harness.close(); for (const handler of handlers.values()) await handler.close(); server.closeIdleConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await fs.rm(temporary, { recursive: true, force: true }); });
  return { request, context, reviewed, save, selection, handlers, harnesses, open, sessions, brokerCalls: () => brokerCalls, onValidation: (hook?: () => void | Promise<void>) => { validationHook = hook; } };
}

test("owner previews an exact saved graph and separately freezes only approved public fields into a publishable capsule", async t => {
  const f = await setup(t), context = await f.context(); await f.reviewed(context);
  const document = drawing(context); assert.equal((await f.save(context, document)).status, 200);
  const catalog = await f.request<Catalog>("/architecture/publication/catalog", { contextId: context.id }); assert.equal(catalog.status, 200); assert.equal(catalog.data.source?.revision, 1); assert.equal(catalog.data.publications.length, 1);
  const selected = f.selection(context, catalog.data), preview = await f.request<Preview>("/architecture/publication/preview", selected); assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.deepEqual(preview.data.source, selected.source);
  assert.deepEqual(preview.data.publicContent.diagram, { nodes: [{ id: "node-1", label: "[REDACTED_PRIVATE] Gateway" }, { id: "node-2", label: "SQLite" }], edges: [{ from: "node-1", to: "node-2", label: "" }] });
  assert.match(preview.data.publicContent.design, /设计/); assert.match(preview.data.publicContent.limitations, /不证明/);
  assert.deepEqual(preview.data.redactions, [{ category: "private_term", count: 2 }]);
  assert.deepEqual((await f.request<{ capsules: unknown[] }>("/capsules/list", {})).data.capsules, []);
  const confirmation = { contextId: context.id, previewId: preview.data.previewId, expectedPreviewHash: preview.data.previewHash, confirmed: true, consent: true, idempotencyKey: "diagram-confirm" };
  const result = await f.request<Confirmed>("/architecture/publication/confirm", confirmation); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.adopted, false); assert.equal(result.data.published, false); assert.equal(result.data.publication.revision, 1);
  assert.deepEqual(result.data.publication.fact.diagram, preview.data.publicContent.diagram); assert.deepEqual(result.data.publication.fact.evidence, []);
  assert.notEqual(result.data.publication.id, selected.publicationId); assert.deepEqual((await f.request<Confirmed>("/architecture/publication/confirm", confirmation)).data, result.data, "confirmation retry returns the same immutable derivative");
  assert.equal((await f.request<Catalog>("/architecture/publication/catalog", { contextId: context.id })).data.publications.length, 2);
  assert.deepEqual((await f.request<{ capsules: unknown[] }>("/capsules/list", {})).data.capsules, [], "diagram confirmation does not publish or issue a token");
  const facts = await f.request<{ revision: number }>("/publication/list", {});
  const twin = await f.request<TwinPreview>("/twin/preview", { expectedWorkspaceRevision: facts.data.revision, factIds: [result.data.publication.id], selectedFields: ["statement", "design", "limitations", "evidence", "diagram"], displayName: "Synthetic candidate", privateTerms: [], expiresAt: new Date(Date.now() + 60_000).toISOString() }); assert.equal(twin.status, 200, JSON.stringify(twin.data));
  assert.deepEqual(twin.data.capsule.facts[0]!.diagram, preview.data.publicContent.diagram);
  for (const privateValue of ["PrivateTeam", "private-gateway-id", "private-store-id", "private-edge-id", "private-drawing-id", "private-claim-id", "statement-1", "PRIVATE_NOTES_CANARY", "PRIVATE_EDGE_LABEL_CANARY"]) assert.equal(JSON.stringify(twin.data.capsule).includes(privateValue), false, privateValue);
  const published = await f.request<CandidateCapsule>("/twin/publish", { previewId: twin.data.id, expectedPreviewHash: twin.data.previewHash, consent: true }); assert.equal(published.status, 200); assert.deepEqual(published.data.facts[0]!.diagram, preview.data.publicContent.diagram);
  assert.equal((await f.request<{ capsules: unknown[] }>("/capsules/list", {})).data.capsules.length, 1);
  const capability = await f.request<{ token: string; capabilityUrl: string }>("/twin/token-issue", { target: "capsule", scopes: ["capsule:read"], capsuleId: published.data.id, capsuleHash: published.data.hash, expiresAt: new Date(Date.now() + 30_000).toISOString(), maxCalls: 3 }); assert.equal(capability.status, 200);
  const recipientURL = new URL(capability.data.capabilityUrl); recipientURL.hash = "";
  const recipient = await fetch(recipientURL, { credentials: "omit", headers: { Authorization: `Bearer ${capability.data.token}` } }); assert.equal(recipient.status, 200);
  const html = await recipient.text(); assert.match(html, /<svg\b/); assert.match(html, /Approved architecture design — not proof of implementation or authorship/); assert.match(html, /\[REDACTED_PRIVATE\] Gateway/); assert.match(html, /SQLite/);
  for (const privateValue of ["private-gateway-id", "private-store-id", "private-edge-id", "PRIVATE_NOTES_CANARY", "statement-1"]) assert.equal(html.includes(privateValue), false);
  assert.equal((await f.request("/twin/revoke", { capsuleId: published.data.id, expectedHash: published.data.hash })).status, 200);
  assert.equal((await fetch(recipientURL, { credentials: "omit", headers: { Authorization: `Bearer ${capability.data.token}` } })).status, 403);
  assert.equal(f.brokerCalls(), 0, "publishing an explicit saved design never renews a source grant or rereads code");
});

test("catalog never offers a historical graph or another context's reviewed claim as current publication authority", async t => {
  const f = await setup(t), original = await f.context(); await f.reviewed(original);
  assert.equal((await f.save(original, drawing(original))).status, 200);
  const previous = await f.request<Catalog>("/architecture/publication/catalog", { contextId: original.id }); assert.equal(previous.status, 200);
  const fresh = await f.context();
  const catalog = await f.request<Catalog>("/architecture/publication/catalog", { contextId: fresh.id });
  assert.equal(catalog.status, 200); assert.equal(catalog.data.source, null); assert.deepEqual(catalog.data.publications, []);
  assert.equal((await f.request("/architecture/publication/preview", { ...f.selection(original, previous.data), contextId: fresh.id })).status, 409);
  assert.equal(f.brokerCalls(), 0);
});

test("even a short known private source line copied into a selected label cannot become a public design field", async t => {
  const f = await setup(t), context = await f.context(), publication = await f.reviewed(context, true);
  const inventory = await f.request<{ evidence: ArchitectureDocument["evidence"] }>("/architecture/evidence", { contextId: context.id, operationId: publication.operationId, consent: true }); assert.equal(inventory.status, 200);
  const document = drawing(context); document.evidence = inventory.data.evidence; document.nodes[0]!.label = "return42;";
  assert.equal((await f.save(context, document)).status, 200);
  const catalog = await f.request<Catalog>("/architecture/publication/catalog", { contextId: context.id }), readsBefore = f.brokerCalls();
  const preview = await f.request("/architecture/publication/preview", f.selection(context, catalog.data));
  assert.equal(preview.status, 400); assert.equal(f.brokerCalls(), readsBefore, "guard inspects the already saved private inventory without exercising old code grants");
  assert.equal((await f.request<Catalog>("/architecture/publication/catalog", { contextId: context.id })).data.publications.length, 1);
});

test("exact hashes, selected graph endpoints, fields and separate affirmative confirmation are enforced over HTTP", async t => {
  const f = await setup(t), context = await f.context(); await f.reviewed(context); assert.equal((await f.save(context, drawing(context))).status, 200);
  const catalog = (await f.request<Catalog>("/architecture/publication/catalog", { contextId: context.id })).data, selected = f.selection(context, catalog);
  for (const body of [
    { ...selected, consent: false }, { ...selected, nodeIds: [] }, { ...selected, nodeIds: ["missing-node"] },
    { ...selected, nodeIds: ["private-gateway-id"] }, { ...selected, edgeIds: ["missing-edge"] },
    { ...selected, nodeIds: ["private-gateway-id", "private-gateway-id"] }, { ...selected, fields: ["title"] },
    { ...selected, fields: ["node.label", "notes"] }, { ...selected, rawSource: "forbidden field" },
  ]) assert.equal((await f.request("/architecture/publication/preview", body)).status, 400, JSON.stringify(body));
  for (const body of [
    { ...selected, expectedPublicationHash: "0".repeat(64) },
    { ...selected, source: { ...selected.source, hash: "0".repeat(64) } },
    { ...selected, source: { ...selected.source, revision: 2 } },
    { ...selected, source: { ...selected.source, id: "other-project" } },
  ]) assert.equal((await f.request("/architecture/publication/preview", body)).status, 409);
  const preview = (await f.request<Preview>("/architecture/publication/preview", selected)).data;
  const confirmation = { contextId: context.id, previewId: preview.previewId, expectedPreviewHash: preview.previewHash, confirmed: true, consent: true, idempotencyKey: "confirm-selection" };
  assert.equal((await f.request("/architecture/publication/confirm", { ...confirmation, confirmed: false })).status, 400);
  assert.equal((await f.request("/architecture/publication/confirm", { ...confirmation, consent: false })).status, 400);
  assert.equal((await f.request("/architecture/publication/confirm", { ...confirmation, expectedPreviewHash: "0".repeat(64) })).status, 409);
  assert.equal((await f.request<Catalog>("/architecture/publication/catalog", { contextId: context.id })).data.publications.length, 1);
  assert.equal((await f.request("/architecture/publication/confirm", confirmation)).status, 200);
  const different = (await f.request<Preview>("/architecture/publication/preview", { ...selected, fields: ["node.label", "edge.label"] })).data;
  assert.equal((await f.request("/architecture/publication/confirm", { ...confirmation, previewId: different.previewId, expectedPreviewHash: different.previewHash })).status, 409, "same idempotency key cannot freeze a different disclosure");
  assert.equal(f.brokerCalls(), 0);
});

test("a saved version change invalidates an already reviewed preview without altering the base publication", async t => {
  const f = await setup(t), context = await f.context(); await f.reviewed(context); const document = drawing(context); assert.equal((await f.save(context, document)).status, 200);
  const catalog = (await f.request<Catalog>("/architecture/publication/catalog", { contextId: context.id })).data, preview = (await f.request<Preview>("/architecture/publication/preview", f.selection(context, catalog))).data;
  document.nodes[0]!.label = "Changed design after preview"; assert.equal((await f.save(context, document, 1)).status, 200);
  assert.equal((await f.request("/architecture/publication/confirm", { contextId: context.id, previewId: preview.previewId, expectedPreviewHash: preview.previewHash, confirmed: true, consent: true, idempotencyKey: "late-confirm" })).status, 409);
  const current = (await f.request<Catalog>("/architecture/publication/catalog", { contextId: context.id })).data;
  assert.equal(current.source?.revision, 2); assert.equal(current.publications.length, 1); assert.equal(current.publications[0]!.hash, catalog.publications[0]!.hash);
});

test("owner, session, revoked scope, restart and preview expiry cannot inherit a prior diagram disclosure", async t => {
  const f = await setup(t), context = await f.context(); await f.reviewed(context); assert.equal((await f.save(context, drawing(context))).status, 200);
  const catalog = (await f.request<Catalog>("/architecture/publication/catalog", { contextId: context.id })).data, selected = f.selection(context, catalog), preview = (await f.request<Preview>("/architecture/publication/preview", selected)).data;
  const confirmation = { contextId: context.id, previewId: preview.previewId, expectedPreviewHash: preview.previewHash, confirmed: true, consent: true, idempotencyKey: "scope-confirm" };
  assert.equal((await f.request("/architecture/publication/confirm", confirmation, "owner-b", "session-b")).status, 409);
  assert.equal((await f.request("/architecture/publication/confirm", confirmation, "owner-a", "new-session")).status, 409);
  const future = Date.now() + 300_001; const timer = t.mock.method(Date, "now", () => future);
  assert.equal((await f.request("/architecture/publication/confirm", confirmation)).status, 409); timer.mock.restore();
  f.sessions.set("owner-a:session-a", false); assert.equal((await f.request("/architecture/publication/confirm", confirmation)).status, 403); f.sessions.set("owner-a:session-a", true);
  assert.equal((await f.request("/context/revoke", { contextId: context.id })).status, 200);
  for (const route of ["catalog", "preview", "confirm"]) assert.equal((await f.request(`/architecture/publication/${route}`, route === "catalog" ? { contextId: context.id } : route === "preview" ? selected : confirmation)).status, 409);
  await f.harnesses.get("owner-a")!.close(); await f.handlers.get("owner-a")!.close(); f.open("owner-a");
  assert.equal((await f.request("/architecture/publication/confirm", confirmation)).status, 409);
  const fresh = await f.context(); assert.equal((await f.request("/architecture/publication/confirm", { ...confirmation, contextId: fresh.id })).status, 409);
  const freshCatalog = await f.request<Catalog>("/architecture/publication/catalog", { contextId: fresh.id }); assert.equal(freshCatalog.status, 200); assert.equal(freshCatalog.data.source, null); assert.deepEqual(freshCatalog.data.publications, []);
});

test("secrets, absolute private paths, source syntax and internal evidence identifiers are rejected even if explicit terms request redaction", async t => {
  const f = await setup(t), context = await f.context(); await f.reviewed(context); const document = drawing(context);
  document.evidence = [{ id: "private-claim-id", label: "本人选择的原句（自述，非独立源码证据）", excerpt: claim }];
  const unsafe = ["sk-proj-SYNTHETIC_PRIVATE_CANARY_123456789", "/synthetic-private/repository.ts", "C:\\SyntheticPrivate\\repository.ts", "export const SECRET_SOURCE = true;", "private-claim-id"];
  for (const [index, value] of unsafe.entries()) {
    document.nodes[0]!.label = value; assert.equal((await f.save(context, document, index)).status, 200);
    const catalog = (await f.request<Catalog>("/architecture/publication/catalog", { contextId: context.id })).data;
    const preview = await f.request<{ error?: string }>("/architecture/publication/preview", { ...f.selection(context, catalog), privateTerms: [value] }); assert.equal(preview.status, 400, value);
    assert.equal(JSON.stringify(preview.data).includes(value), false, "error bodies do not echo sensitive input");
  }
  assert.equal((await f.request<Catalog>("/architecture/publication/catalog", { contextId: context.id })).data.publications.length, 1);
  assert.deepEqual((await f.request<{ capsules: unknown[] }>("/capsules/list", {})).data.capsules, []);
});

test("a preview that expires during the final asynchronous identity check cannot be frozen", async t => {
  const f = await setup(t), context = await f.context(); await f.reviewed(context); assert.equal((await f.save(context, drawing(context))).status, 200);
  const catalog = (await f.request<Catalog>("/architecture/publication/catalog", { contextId: context.id })).data, preview = (await f.request<Preview>("/architecture/publication/preview", f.selection(context, catalog))).data;
  const before = Date.now(), after = Date.parse(preview.expiresAt) + 1; let checks = 0, advanced = false;
  const clock = t.mock.method(Date, "now", () => advanced ? after : before);
  f.onValidation(() => { if (++checks === 3) advanced = true; });
  const result = await f.request("/architecture/publication/confirm", { contextId: context.id, previewId: preview.previewId, expectedPreviewHash: preview.previewHash, confirmed: true, consent: true, idempotencyKey: "expires-during-authority" }); f.onValidation(); clock.mock.restore();
  assert.ok(advanced, "the external identity check advanced the clock after initial preview validation");
  assert.equal(result.status, 409);
  assert.equal((await f.request<Catalog>("/architecture/publication/catalog", { contextId: context.id })).data.publications.length, 1);
});

test("source edits, scope withdrawal and account invalidation during the final identity await leave no diagram publication", async t => {
  for (const mode of ["source", "scope", "identity"] as const) {
    const f = await setup(t), context = await f.context(); await f.reviewed(context); const document = drawing(context); assert.equal((await f.save(context, document)).status, 200);
    const catalog = (await f.request<Catalog>("/architecture/publication/catalog", { contextId: context.id })).data, preview = (await f.request<Preview>("/architecture/publication/preview", f.selection(context, catalog))).data;
    let checks = 0, changed = false;
    f.onValidation(async () => {
      if (++checks !== 3) return;
      f.onValidation();
      if (mode === "source") { document.title = "Concurrent changed version"; assert.equal((await f.save(context, document, 1)).status, 200); }
      else if (mode === "scope") assert.equal((await f.request("/context/revoke", { contextId: context.id })).status, 200);
      else f.sessions.set("owner-a:session-a", false);
      changed = true;
    });
    const result = await f.request("/architecture/publication/confirm", { contextId: context.id, previewId: preview.previewId, expectedPreviewHash: preview.previewHash, confirmed: true, consent: true, idempotencyKey: `concurrent-${mode}` });
    f.onValidation(); f.sessions.set("owner-a:session-a", true);
    assert.equal(changed, true); assert.equal(result.status, mode === "identity" ? 403 : 409);
    assert.equal((await f.request<{ facts: unknown[] }>("/publication/list", {})).data.facts.length, 1, mode);
    assert.deepEqual((await f.request<{ capsules: unknown[] }>("/capsules/list", {})).data.capsules, []);
  }
});
