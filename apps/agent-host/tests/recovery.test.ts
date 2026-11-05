import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInitialDocument } from "@better-me/storage";
import { RecoveryCatalog } from "../src/identity/recovery.js";
import { once } from "node:events";
import { MemorySaver } from "@langchain/langgraph";
import { createAgentServer } from "../src/server.js";
import { registerTestIdentity } from "./fixtures/identity.js";

test("confirmed recovery appends an immutable account archive, is idempotent, and does not expose another owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "betterme-recovery-"));
  const alice = "11111111-1111-4111-8111-111111111111", bob = "22222222-2222-4222-8222-222222222222";
  const catalog = new RecoveryCatalog(path.join(root, alice), alice);
  const id = "1".repeat(32), document = createInitialDocument("2026-01-01T00:00:00.000Z");
  const plan = { id, ownerId: alice, label: "Synthetic legacy archive", createdAt: "2026-01-01T00:00:00.000Z",
    documents: [{ key: "main", label: "Recovered original", source: "fixture", document }],
    artifacts: [{ label: "older version", bytes: Buffer.from("original bytes") }], continuity: [], sessions: [] };
  try {
    await catalog.install(plan);
    assert.equal((await catalog.list()).length, 1);
    assert.deepEqual(await catalog.document(id, "main"), document);
    assert.equal((await catalog.artifact(id, 0)).toString(), "original bytes");
    await Promise.all([catalog.install(plan), catalog.install(plan)]);
    assert.equal((await catalog.list()).length, 1);
    await assert.rejects(catalog.install({ ...plan, label: "conflicting replacement" }), /recovery_conflict/);
    assert.equal((await catalog.list())[0]!.label, "Synthetic legacy archive");
    const other = new RecoveryCatalog(path.join(root, bob), bob);
    assert.deepEqual(await other.list(), []);
    await assert.rejects(other.document(id, "main"), /recovery_not_found/);
    await assert.rejects(other.install(plan), /recovery_owner_mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("recovered documents and Agent archives are authenticated per owner, CAS protected, and never re-execute tasks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "betterme-recovery-http-"));
  const server = createAgentServer({ port: 0, host: "127.0.0.1", allowedOrigins: ["http://fixture.invalid"], authToken: "fixture",
    checkpointer: new MemorySaver() as never, identityDirectory: root, runtimeDefinitions: [] });
  await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const alice = await registerTestIdentity(origin, "fixture", "alice", "http://fixture.invalid");
    const bob = await registerTestIdentity(origin, "fixture", "bob", "http://fixture.invalid");
    const doc = createInitialDocument(); doc.documentId = "recovered-fixture";
    const id = "2".repeat(32), catalog = new RecoveryCatalog(path.join(root, "owners", alice.principal.id), alice.principal.id);
    await catalog.install({ id, ownerId: alice.principal.id, label: "Alice archive", createdAt: "2026-01-01T00:00:00.000Z",
      documents: [{ key: "main", label: "Alice recovered", source: "fixture", document: doc }], artifacts: [], sessions: [],
      continuity: [{ version: 1, workspaceKey: "recovered-fixture", revision: 99, messages: [{ id: "old-message", text: "Alice legacy" }],
        memories: [{ id: "old-memory", shared: true, valid: true }], tasks: [{ id: "old-task", status: "running", remote: { sessionId: "old" } }] }] });
    const call = (headers: Record<string, string>, route: string, body?: unknown) => fetch(origin + "/api/v1/agent" + route, {
      method: body === undefined ? "GET" : "POST", headers: { ...headers, Authorization: "Bearer fixture", Origin: "http://fixture.invalid", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal((await call({}, "/recovery")).status, 401);
    assert.equal((await call(bob.headers, `/recovery/${id}/documents/main`)).status, 404);
    assert.equal((await (await call(alice.headers, `/recovery/${id}/documents/main`)).json()).document.documentId, "recovered-fixture");
    const route = "/records/continuity?key=recovered-fixture";
    const recovered = await (await call(alice.headers, route)).json();
    assert.equal(recovered.value.messages[0].text, "Alice legacy");
    assert.equal(recovered.value.memories[0].shared, false); assert.equal(recovered.value.memories[0].valid, false);
    assert.equal(recovered.value.tasks[0].status, "interrupted"); assert.equal(recovered.value.tasks[0].remote, undefined);
    assert.equal((await (await call(bob.headers, route)).json()).value, null);
    const writes = await Promise.all(Array.from({ length: 8 }, (_, index) => call(alice.headers, route, {
      expectedRevision: 1, value: { ...recovered.value, revision: 2, goal: `new-${index}` } })));
    assert.equal(writes.filter(result => result.status === 200).length, 1);
    assert.equal(writes.filter(result => result.status === 409).length, 7);
    assert.equal((await catalog.continuity("recovered-fixture") as {revision:number}).revision, 1, "immutable original is not replaced by later working writes");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
