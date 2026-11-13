import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import { MemorySaver } from "@langchain/langgraph";
import { syntheticJobComparison, syntheticEvidenceReview, type CapabilitySnapshot } from "@better-me/agent-contracts";
import { createAgentServer } from "../src/server.js";
import { registerTestIdentity } from "./fixtures/identity.js";
import { fixtureSource } from "./fixtures/capability-source.js";

for (const evidenceMode of [false, true]) test(`authenticated HTTP isolates A/B identical operation IDs, preserves old records and rejects late A→B→A publication (${evidenceMode ? "evidence" : "comparison"})`, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-capability-http-"));
  const buildEntered = Promise.withResolvers<void>(), buildResult = Promise.withResolvers<void>(); let builds = 0;
  const server = createAgentServer({ host: "127.0.0.1", port: 0, authToken: "fixture-token", allowedOrigins: [], runtimeDefinitions: [],
    identityDirectory: path.join(directory, "accounts"), runsDirectory: path.join(directory, "runs"), checkpointer: new MemorySaver() as never,
    capabilityBuilder: async () => { if (++builds === 1) { buildEntered.resolve(); await buildResult.promise; }
      return { source: fixtureSource, provider: "regression-substitute", model: "http-fixture", promptHash: "fixture", durationMs: 0 }; } });
  await once(server, "listening"); const addr = server.address(); assert.ok(addr && typeof addr !== "string"); const base = `http://127.0.0.1:${addr.port}`;
  const auth = { Authorization: "Bearer fixture-token", "Content-Type": "application/json" };
  const call = (headers: Record<string, string>, route: string, body?: unknown) => fetch(`${base}/api/v1/agent${route}`, {
    headers: { ...auth, ...headers }, method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const request = (round = 1) => ({ input: syntheticJobComparison(round), idempotencyKey: "same-operation-id", expectedCatalogRevision: 0, consent: true,
    ...(evidenceMode ? { ...syntheticEvidenceReview(round), intent: "prepare-evidence-review" } : {}) });
  const wait = async (headers: Record<string, string>) => {
    for (let i = 0; i < 200; i++) { const s = await (await call(headers, "/capabilities")).json() as CapabilitySnapshot;
      if (s.tasks.every(task => ["cancelled", "failed", "completed"].includes(task.stage))) return s;
      await new Promise(resolve => setTimeout(resolve, 20)); } throw Error("fixture_deadline");
  };
  try {
    const alice = await registerTestIdentity(base, "fixture-token", "alice"), bob = await registerTestIdentity(base, "fixture-token", "bob");
    assert.equal((await call({}, "/capabilities")).status, 401);
    assert.equal((await call({ ...bob.headers, "X-BetterMe-Owner": alice.principal.id }, "/capabilities")).status, 409);
    const record = { expectedRevision: 0, value: { workspaceKey: "existing", revision: 1, ownerId: alice.principal.id, note: "EXISTING-AGENT-RECORD" } };
    assert.equal((await call(alice.headers, "/records/continuity?key=existing", record)).status, 200);
    const before = await (await call(alice.headers, "/records/continuity?key=existing")).text();
    const a = await (await call(alice.headers, "/capabilities/tasks", request())).json(); await buildEntered.promise;
    const b = await (await call(bob.headers, "/capabilities/tasks", request(2))).json();
    assert.notEqual(a.task.id, b.task.id);
    assert.equal((await call(bob.headers, "/capabilities/revoke", { taskId: a.task.id })).status, 404);
    assert.equal((await call(alice.headers, "/capabilities/tasks", { ...request(), ownerId: bob.principal.id })).status, 400);
    // Changing the browser cookie via login must revoke the OLD interaction, even
    // with unrelated cookies added. Login A again must not revive it.
    const switched = await call({ Cookie: `${alice.cookie}; unrelated=changed` }, "/identity/sign-in", { username: "bob", password: "synthetic-only-password-2026" });
    assert.equal(switched.status, 200);
    const back = await call({ Cookie: switched.headers.getSetCookie()[0]!.split(";")[0]! }, "/identity/sign-in", { username: "alice", password: "synthetic-only-password-2026" });
    assert.equal(back.status, 200);
    buildResult.resolve();
    const aState = await wait(alice.headers), bState = await wait(bob.headers);
    assert.equal(aState.tasks[0]?.stage, "cancelled"); assert.equal(aState.versions.length, 0); assert.equal(aState.tasks[0]?.receipt, undefined);
    assert.equal(bState.tasks[0]?.stage, "completed", `independent owner task error: ${bState.tasks[0]?.error ?? "none"}`); assert.equal(bState.ownerId, bob.principal.id);
    assert.ok(!JSON.stringify(bState).includes("FIRST-ONLY-CANARY-7319"));
    if (evidenceMode) { assert.ok(!JSON.stringify(bState).includes("EVIDENCE-FIRST-ONLY-8421")); assert.ok(bState.tasks[0]?.evidenceReport); }
    assert.equal(await (await call(alice.headers, "/records/continuity?key=existing")).text(), before);
    assert.equal((await call(alice.headers, "/runs", { runtimeId: "codex", workflow: "career", task: "unsafe", workspaceId: "same" })).status, 410);
  } finally {
    buildResult.resolve(); await new Promise<void>(resolve => server.close(() => resolve()));
    // Host close asynchronously joins workers and releases its own lock before cleanup.
    await new Promise(resolve => setTimeout(resolve, 100)); await rm(directory, { recursive: true, force: true });
  }
});

test("real HTTP Workspace commands isolate reviews/proposals, enforce fresh consent/CAS and keep old Agent records intact", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-handoff-http-"));
  const server = createAgentServer({ host: "127.0.0.1", port: 0, authToken: "fixture-token", allowedOrigins: [], runtimeDefinitions: [],
    identityDirectory: path.join(directory, "accounts"), runsDirectory: path.join(directory, "runs"), checkpointer: new MemorySaver() as never,
    capabilityBuilder: async () => ({ source: fixtureSource, provider: "regression-substitute", model: "fixture", promptHash: "fixture", durationMs: 0 }) });
  await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const call = (headers: Record<string, string>, route: string, body?: unknown) => fetch(`${base}/api/v1/agent${route}`, {
    headers: { Authorization: "Bearer fixture-token", "Content-Type": "application/json", ...headers },
    method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    const alice = await registerTestIdentity(base, "fixture-token", "alice"), bob = await registerTestIdentity(base, "fixture-token", "bob");
    const recordRoute = "/records/continuity?key=existing";
    assert.equal((await call(alice.headers, recordRoute, { expectedRevision: 0, value: { workspaceKey: "existing", revision: 1, ownerId: alice.principal.id, note: "OLD-AGENT-SYNTHETIC" } })).status, 200);
    const before = await (await call(alice.headers, recordRoute)).text();
    for (const identity of [alice, bob]) assert.equal((await call(identity.headers, "/capabilities/tasks", {
      ...syntheticEvidenceReview(2), intent: "prepare-evidence-review", idempotencyKey: "same-evidence-task", consent: true, expectedCatalogRevision: 0 })).status, 202);
    const wait = async (headers: Record<string, string>) => {
      for (let n = 0; n < 200; n++) { const state = await (await call(headers, "/capabilities")).json() as CapabilitySnapshot;
        if (state.tasks[0]?.stage === "completed") return state.tasks[0]; await new Promise(resolve => setTimeout(resolve, 20)); }
      throw Error("synthetic_deadline");
    };
    const [a, b] = await Promise.all([wait(alice.headers), wait(bob.headers)]);
    const review = (task: typeof a) => ({ taskId: task.id, reportReceiptId: task.receipt!.id, reportHash: task.outputHash!, itemIndex: 1,
      expectedRevision: 0, idempotencyKey: "same-personal-review", consent: true,
      decision: { kind: "implementation", action: task.id === a.id ? "ALICE-ONLY-ACTION" : "BOB-ONLY-ACTION", role: "合成实现", deployment: "未上线" } });
    assert.equal((await call(bob.headers, "/capabilities/evidence-review", review(a))).status, 404);
    assert.equal((await call(alice.headers, "/capabilities/evidence-review", { ...review(a), ownerId: bob.principal.id })).status, 400);
    assert.equal((await call(alice.headers, "/capabilities/evidence-review", { ...review(a), consent: false })).status, 400);
    const [ar, br] = await Promise.all([call(alice.headers, "/capabilities/evidence-review", review(a)), call(bob.headers, "/capabilities/evidence-review", review(b))]);
    assert.equal(ar.status, 200); assert.equal(br.status, 200);
    const av = await ar.json(), bv = await br.json(); assert.notEqual(av.review.id, bv.review.id);
    const proposal = (id: string) => ({ reviewId: id, expectedRevision: 1, idempotencyKey: "same-proposal-operation", consent: true });
    assert.equal((await call(bob.headers, "/capabilities/evidence-proposal", proposal(av.review.id))).status, 404);
    const [p, q] = await Promise.all([call(alice.headers, "/capabilities/evidence-proposal", proposal(av.review.id)), call(bob.headers, "/capabilities/evidence-proposal", proposal(bv.review.id))]);
    assert.equal(p.status, 200); assert.equal(q.status, 200);
    const pv = await p.json(), qv = await q.json(); assert.notEqual(pv.proposal.id, qv.proposal.id);
    assert.equal(pv.proposal.candidate.action, "ALICE-ONLY-ACTION"); assert.equal(qv.proposal.candidate.action, "BOB-ONLY-ACTION");
    assert.equal((await call(alice.headers, "/capabilities/evidence-proposal", proposal(av.review.id))).status, 200);
    assert.equal((await call(alice.headers, "/capabilities/revoke", { taskId: a.id })).status, 200);
    assert.equal((await call(alice.headers, "/capabilities/evidence-review", { ...review(a), expectedRevision: 2, idempotencyKey: "revoked-new-review" })).status, 403);
    const switched = await call({ Cookie: alice.cookie }, "/identity/sign-in", { username: "bob", password: "synthetic-only-password-2026" });
    assert.equal(switched.status, 200);
    const back = await call({ Cookie: switched.headers.getSetCookie()[0]!.split(";")[0]! }, "/identity/sign-in", { username: "alice", password: "synthetic-only-password-2026" });
    assert.equal(back.status, 200);
    assert.equal((await call(alice.headers, "/capabilities/evidence-proposal", proposal(av.review.id))).status, 403);
    const newHeaders = { Cookie: back.headers.getSetCookie()[0]!.split(";")[0]!, "X-BetterMe-Owner": alice.principal.id };
    const aState = await (await call(newHeaders, "/capabilities")).json() as CapabilitySnapshot;
    const bState = await (await call(bob.headers, "/capabilities")).json() as CapabilitySnapshot;
    assert.equal(aState.workspace?.proposals.length, 1); assert.equal(bState.workspace?.proposals.length, 1);
    assert.ok(!JSON.stringify(aState.workspace).includes("BOB-ONLY-ACTION")); assert.ok(!JSON.stringify(bState.workspace).includes("ALICE-ONLY-ACTION"));
    assert.equal(await (await call(newHeaders, recordRoute)).text(), before);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve())); await new Promise(resolve => setTimeout(resolve, 100));
    await rm(directory, { recursive: true, force: true });
  }
});
