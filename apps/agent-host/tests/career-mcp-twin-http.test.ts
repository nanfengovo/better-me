import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpTwinHttp } from "../src/career-studio/mcp-twin-http.js";
import type { CandidateCapsuleStore, StoredCapsule, TwinAuthStamp, TwinWorkspaceAdapter } from "../src/candidate-twin/index.js";
import type { CareerMcpWorkspaceAdapter } from "../src/career-mcp/index.js";

const readBody = async (request: IncomingMessage) => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString("utf8")); };
const sendJson = (response: ServerResponse, status: number, data: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(data)); };
async function fixture(t: { after(fn: () => Promise<void> | void): void }) {
  const urls: string[] = [], runtimes: ReturnType<typeof createMcpTwinHttp<TwinAuthStamp>>[] = [];
  const server = createServer(async (request, response) => {
    urls.push(request.url!); const pathname = new URL(request.url!, "http://127.0.0.1").pathname;
    for (const runtime of runtimes) if (await runtime.handlePublic(request, response, pathname)) return;
    const owner = request.headers["x-synthetic-owner"] === "owner-2" ? "owner-2" : "owner-1", runtime = runtimes[owner === "owner-1" ? 0 : 1]!;
    if (await runtime.handleOwner(request, response, pathname, { ownerId: owner, sessionId: `${owner}-session`, sessionGeneration: 1, authorizationGeneration: 1 })) return;
    sendJson(response, 404, { error: "route_unknown" });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`, live = new Map([["owner-1", true], ["owner-2", true]]);
  const stores: Map<string, StoredCapsule>[] = [];
  for (const ownerId of ["owner-1", "owner-2"]) {
    const records = new Map<string, StoredCapsule>(); stores.push(records);
    const workspace: TwinWorkspaceAdapter = { currentRevision: async () => 1, snapshot: async () => ({ ownerId, revision: 1, facts: [{ id: "fact-1", revision: "v1", status: "verified", disclosure: "publishable", verificationReceiptHash: "f".repeat(64), statement: `${ownerId} synthetic CAS idempotency implementation.`, design: "Exclusive transaction gates concurrent writers." }] }), publicationEligible: async () => true };
    const capsuleStore: CandidateCapsuleStore = {
      read: async id => { const value = records.get(id); return value && structuredClone(value); },
      publish: async input => { if (input.auth.ownerId !== ownerId || !live.get(ownerId) || input.expectedWorkspaceRevision !== 1 || records.has(input.capsule.id)) return false; records.set(input.capsule.id, { ownerId, capsule: structuredClone(input.capsule) }); return true; },
      revoke: async input => { const value = records.get(input.capsuleId); if (!value || input.auth.ownerId !== ownerId || value.capsule.hash !== input.expectedHash || !live.get(ownerId)) return false; value.revokedAt = input.at; return true; },
    };
    const mcpWorkspace: CareerMcpWorkspaceAdapter = { listFacts: async input => ({ revision: 1, facts: [{ id: "fact-1", text: `${input.ownerId} synthetic public evidence.`, status: "verified", evidenceIds: [] }] }), proposeEvidence: async () => { throw new Error("not available"); }, matchTargetJd: async () => ({ revision: 1, status: "unknown", evidence: [], gaps: [], limitations: [] }), reserve: async () => true };
    runtimes.push(createMcpTwinHttp({ ownerId, workspace, mcpWorkspace, capsuleStore, identityValid: async auth => auth.ownerId === ownerId && auth.sessionGeneration === 1 && !!live.get(ownerId), translateAccess: auth => ({ ...auth, valid: async () => !!live.get(auth.ownerId) }), readBody, sendJson, baseURL: base }));
  }
  t.after(async () => { for (const runtime of runtimes) runtime.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const post = async (operation: string, body: unknown, owner = "owner-1") => { const response = await fetch(`${base}/api/v1/agent/career-studio/twin/${operation}`, { method: "POST", headers: { "content-type": "application/json", "x-synthetic-owner": owner }, body: JSON.stringify(body) }); return { status: response.status, data: await response.json() as Record<string, any> }; };
  const publish = async (owner = "owner-1") => { const preview = await post("preview", { expectedWorkspaceRevision: 1, factIds: ["fact-1"], selectedFields: ["statement", "design"], displayName: "Synthetic Candidate", expiresAt: new Date(Date.now() + 120_000).toISOString() }, owner); assert.equal(preview.status, 200); const published = await post("publish", { previewId: preview.data.id, expectedPreviewHash: preview.data.previewHash, consent: true }, owner); assert.equal(published.status, 200); return published.data; };
  return { base, urls, runtimes, live, stores, post, publish };
}

test("MCP/twin HTTP actual publication -> fragment capability -> authenticated read/Q&A -> call limit", async t => {
  const f = await fixture(t), capsule = await f.publish();
  const issued = await f.post("token-issue", { target: "capsule", capsuleId: capsule.id, capsuleHash: capsule.hash, scopes: ["capsule:read", "capsule:ask"], expiresAt: new Date(Date.now() + 60_000).toISOString(), maxCalls: 3 });
  assert.equal(issued.status, 200); const url = new URL(issued.data.capabilityUrl), token = new URLSearchParams(url.hash.slice(1)).get("access_token")!;
  assert.equal(url.search, ""); assert.equal(url.pathname.includes("owner-1"), false);
  const bootstrap = await fetch(url), shell = await bootstrap.text();
  assert.match(shell, /history.replaceState/); assert.equal(shell.includes(token), false); assert.equal(shell.includes("synthetic CAS idempotency"), false); assert.equal(bootstrap.headers.get("referrer-policy"), "no-referrer"); assert.match(bootstrap.headers.get("content-security-policy")!, /sha256-/);
  const headers = { authorization: `Bearer ${token}` }, page = await fetch(`${url.origin}${url.pathname}`, { headers }); assert.equal(page.status, 200); assert.match(await page.text(), /owner-1 synthetic CAS idempotency/);
  const answer = await fetch(`${url.origin}${url.pathname}/ask`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ question: "CAS idempotency" }) }); assert.equal(answer.status, 200); assert.equal((await answer.json() as { unknown: boolean }).unknown, false);
  const unknown = await fetch(`${url.origin}${url.pathname}/ask`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ question: "salary compensation" }) }); assert.equal((await unknown.json() as { unknown: boolean }).unknown, true);
  assert.equal((await fetch(`${url.origin}${url.pathname}`, { headers })).status, 403);
  assert.equal(f.urls.some(request => request.includes(token)), false);
});

test("MCP/twin multi-owner public tags route independently and cross-owner capability/owner grants fail closed", async t => {
  const f = await fixture(t), a = await f.publish(), b = await f.publish("owner-2");
  const issue = async (capsule: Record<string, any>, owner: string) => f.post("token-issue", { target: "capsule", capsuleId: capsule.id, capsuleHash: capsule.hash, scopes: ["capsule:read"], expiresAt: new Date(Date.now() + 60_000).toISOString(), maxCalls: 10 }, owner);
  const tokenA = await issue(a, "owner-1"), tokenB = await issue(b, "owner-2");
  const bUrl = new URL(tokenB.data.capabilityUrl), response = await fetch(`${bUrl.origin}${bUrl.pathname}`, { headers: { authorization: `Bearer ${tokenB.data.token}` } }); assert.equal(response.status, 200); assert.match(await response.text(), /owner-2 synthetic/);
  assert.equal((await fetch(`${bUrl.origin}${bUrl.pathname}`, { headers: { authorization: `Bearer ${tokenA.data.token}` } })).status, 403);
  const forbiddenIssue = await issue(a, "owner-2"); assert.equal(forbiddenIssue.status, 403);
  assert.notEqual(f.runtimes[0]!.ownerTag, f.runtimes[1]!.ownerTag);
  assert.equal((await fetch(`${f.base}/api/v1/agent/career-studio/public/unknown-owner/twin/${a.id}`)).status, 404);
});

test("MCP/twin actual opaque scoped token works with official StreamableHTTP and revocation stops further reads", async t => {
  const f = await fixture(t), issued = await f.post("token-issue", { target: "mcp", scopes: ["career:facts:read"], expiresAt: new Date(Date.now() + 60_000).toISOString(), maxCalls: 2 }); assert.equal(issued.status, 200);
  const client = new Client({ name: "synthetic-wrapper-client", version: "1" }), transport = new StreamableHTTPClientTransport(new URL(issued.data.mcpEndpoint), { requestInit: { headers: { authorization: `Bearer ${issued.data.token}` } }, reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 0, initialReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 } });
  await client.connect(transport); t.after(() => client.close());
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ["list_career_facts"]);
  const result = await client.callTool({ name: "list_career_facts", arguments: { expectedRevision: 1 } }); assert.match(JSON.stringify(result), /owner-1 synthetic public/);
  assert.equal((await f.post("token-revoke", { tokenId: issued.data.tokenId })).status, 200);
  await assert.rejects(client.callTool({ name: "list_career_facts", arguments: { expectedRevision: 1 } }));
});

test("MCP/twin online capsule revocation and session invalidation leave frozen artifacts but deny serving", async t => {
  const f = await fixture(t), capsule = await f.publish(), issued = await f.post("token-issue", { target: "capsule", capsuleId: capsule.id, capsuleHash: capsule.hash, scopes: ["capsule:read"], expiresAt: new Date(Date.now() + 60_000).toISOString(), maxCalls: 10 });
  const url = new URL(issued.data.capabilityUrl), headers = { authorization: `Bearer ${issued.data.token}` };
  assert.equal((await f.post("revoke", { capsuleId: capsule.id, expectedHash: capsule.hash })).status, 200);
  assert.equal((await fetch(`${url.origin}${url.pathname}`, { headers })).status, 403); assert.equal(f.stores[0]!.get(capsule.id)?.capsule.hash, capsule.hash);
  const another = await f.publish(), token = await f.post("token-issue", { target: "capsule", capsuleId: another.id, capsuleHash: another.hash, scopes: ["capsule:read"], expiresAt: new Date(Date.now() + 60_000).toISOString(), maxCalls: 10 });
  f.runtimes[0]!.invalidateSession("owner-1-session"); const next = new URL(token.data.capabilityUrl);
  assert.equal((await fetch(`${next.origin}${next.pathname}`, { headers: { authorization: `Bearer ${token.data.token}` } })).status, 403);
});
