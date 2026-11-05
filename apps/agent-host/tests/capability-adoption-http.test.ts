import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { MemorySaver } from "@langchain/langgraph";
import { syntheticEvidenceReview, type CapabilitySnapshot, type ResumeBusinessAsset, type EvidenceChangeProposal, type ResumeChangeRequest, type ResumeChangePreview, type ResumeBusinessReceipt } from "@better-me/agent-contracts";
import { createAgentServer } from "../src/server.js";
import { registerTestIdentity } from "./fixtures/identity.js";
import { fixtureSource } from "./fixtures/capability-source.js";

test("real authenticated HTTP adopts and undoes only owned synthetic resumes; A/B same keys, old records, stale previews and A→B→A remain isolated", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-adoption-http-"));
  const server = createAgentServer({ host: "127.0.0.1", port: 0, authToken: "fixture-token", allowedOrigins: [], runtimeDefinitions: [],
    identityDirectory: path.join(directory, "accounts"), runsDirectory: path.join(directory, "runs"), checkpointer: new MemorySaver() as never,
    capabilityBuilder: async () => ({ source: fixtureSource, provider: "regression-substitute", model: "fixture", promptHash: "fixture", durationMs: 0 }) });
  await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string"); const base = `http://127.0.0.1:${address.port}`;
  const call = (headers: Record<string, string>, route: string, body?: unknown) => fetch(`${base}/api/v1/agent${route}`, {
    headers: { Authorization: "Bearer fixture-token", "Content-Type": "application/json", ...headers }, method: body === undefined ? "GET" : "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const command = async <T>(headers: Record<string, string>, route: string, body: unknown, status = 200): Promise<T> => {
    const response = await call(headers, `/capabilities/${route}`, body); assert.equal(response.status, status, await response.clone().text()); return response.json() as Promise<T>;
  };
  const snapshot = async (headers: Record<string, string>) => await (await call(headers, "/capabilities")).json() as CapabilitySnapshot;
  try {
    const alice = await registerTestIdentity(base, "fixture-token", "alice"), bob = await registerTestIdentity(base, "fixture-token", "bob");
    const oldRoute = "/records/continuity?key=existing";
    assert.equal((await call(alice.headers, oldRoute, { expectedRevision: 0, value: { workspaceKey: "existing", revision: 1, ownerId: alice.principal.id, note: "PRE-EXISTING-SYNTHETIC-AGENT" } })).status, 200);
    const old = await (await call(alice.headers, oldRoute)).text();
    const setup = async (identity: typeof alice, action: string) => {
      await command(identity.headers, "tasks", { ...syntheticEvidenceReview(2), intent: "prepare-evidence-review", idempotencyKey: "same-source-task", expectedCatalogRevision: 0, consent: true }, 202);
      let state: CapabilitySnapshot = await snapshot(identity.headers);
      for (let n = 0; state.tasks[0]?.stage !== "completed" && n < 200; n++) { await new Promise(resolve => setTimeout(resolve, 20)); state = await snapshot(identity.headers); }
      const task = state.tasks[0]!; assert.equal(task.stage, "completed");
      const { review } = await command<{ review: { id: string } }>(identity.headers, "evidence-review", { taskId: task.id, reportReceiptId: task.receipt!.id, reportHash: task.outputHash!,
        itemIndex: 1, expectedRevision: 0, idempotencyKey: "same-review-key", consent: true, decision: { kind: "implementation", action, role: "合成维护", deployment: "未上线" } });
      const { proposal } = await command<{ proposal: EvidenceChangeProposal }>(identity.headers, "evidence-proposal", { reviewId: review.id, expectedRevision: 1, idempotencyKey: "same-proposal-key", consent: true });
      const { asset } = await command<{ asset: ResumeBusinessAsset }>(identity.headers, "resumes/synthetic", { name: "同名合成简历", expectedRevision: 2, idempotencyKey: "same-create-key", consent: true });
      const target = asset.targets[0]!;
      const request: ResumeChangeRequest = { kind: "adopt", assetId: asset.id, expectedVersionId: asset.headVersionId, proposalId: proposal.id, resumeId: target.resumeId, experienceId: target.experienceId };
      return { task, proposal, asset, request };
    };
    const [a, b] = await Promise.all([setup(alice, "ALICE-ONLY-CACHE-ACTION"), setup(bob, "BOB-ONLY-CACHE-ACTION")]);
    await command({}, "resumes/preview", a.request, 401);
    await command(bob.headers, "resumes/preview", { ...a.request, proposalId: b.proposal.id }, 404);
    await command(alice.headers, "resumes/preview", { ...a.request, ownerId: bob.principal.id }, 400);
    const before = await snapshot(alice.headers);
    const { preview: ap } = await command<{ preview: ResumeChangePreview }>(alice.headers, "resumes/preview", a.request);
    assert.deepEqual(await snapshot(alice.headers), before);
    const { preview: bp } = await command<{ preview: ResumeChangePreview }>(bob.headers, "resumes/preview", b.request);
    const save = (request: ResumeChangeRequest, hash: string) => ({ preview: request, previewHash: hash, idempotencyKey: "same-adopt-key", consent: true });
    await command(alice.headers, "resumes/save", { ...save(a.request, ap.hash), consent: false }, 400);
    await command(alice.headers, "resumes/save", save(a.request, "f".repeat(64)), 409);
    const [av, bv] = await Promise.all([command<{ receipt: ResumeBusinessReceipt }>(alice.headers, "resumes/save", save(a.request, ap.hash)), command<{ receipt: ResumeBusinessReceipt }>(bob.headers, "resumes/save", save(b.request, bp.hash))]);
    assert.notEqual(av.receipt.id, bv.receipt.id);
    const repeated = await command<{ receipt: ResumeBusinessReceipt }>(alice.headers, "resumes/save", save(a.request, ap.hash)); assert.deepEqual(repeated, av);
    await command(alice.headers, "resumes/save", { ...save(a.request, ap.hash), idempotencyKey: "stale-new-operation" }, 409);
    const undo: ResumeChangeRequest = { kind: "undo", assetId: a.asset.id, adoptionReceiptId: av.receipt.id, expectedVersionId: av.receipt.versionId };
    const { preview: oldUndo } = await command<{ preview: ResumeChangePreview }>(alice.headers, "resumes/preview", undo);
    await command(alice.headers, "resumes/revoke-preview", { assetId: a.asset.id, expectedAuthorizationRevision: 0, idempotencyKey: "revoke-old-undo-preview" });
    await command(alice.headers, "resumes/save", { preview: undo, previewHash: oldUndo.hash, idempotencyKey: "revoked-undo-key", consent: true }, 409);
    const { preview: freshUndo } = await command<{ preview: ResumeChangePreview }>(alice.headers, "resumes/preview", undo);
    const switched = await call({ Cookie: alice.cookie }, "/identity/sign-in", { username: "bob", password: "synthetic-only-password-2026" }); assert.equal(switched.status, 200);
    const back = await call({ Cookie: switched.headers.getSetCookie()[0]!.split(";")[0]! }, "/identity/sign-in", { username: "alice", password: "synthetic-only-password-2026" }); assert.equal(back.status, 200);
    const newHeaders = { Cookie: back.headers.getSetCookie()[0]!.split(";")[0]!, "X-BetterMe-Owner": alice.principal.id };
    await command(alice.headers, "resumes/save", { preview: undo, previewHash: freshUndo.hash, idempotencyKey: "old-interaction-undo", consent: true }, 403);
    await command(newHeaders, "resumes/save", { preview: undo, previewHash: freshUndo.hash, idempotencyKey: "new-session-old-preview", consent: true }, 409);
    const { preview: currentUndo } = await command<{ preview: ResumeChangePreview }>(newHeaders, "resumes/preview", undo);
    const undone = await command<{ receipt: ResumeBusinessReceipt }>(newHeaders, "resumes/save", { preview: undo, previewHash: currentUndo.hash, idempotencyKey: "explicit-current-undo", consent: true });
    assert.equal(undone.receipt.undoesReceiptId, av.receipt.id);
    const [as, bs] = await Promise.all([snapshot(newHeaders), snapshot(bob.headers)]);
    assert.equal(as.workspace!.resumeAssets![0]!.versions.length, 3); assert.equal(bs.workspace!.resumeAssets![0]!.versions.length, 2);
    assert.ok(!JSON.stringify(as.workspace).includes("BOB-ONLY-CACHE-ACTION")); assert.ok(!JSON.stringify(bs.workspace).includes("ALICE-ONLY-CACHE-ACTION"));
    assert.deepEqual(as.workspace!.resumeAssets![0]!.versions[0], a.asset.versions[0]);
    assert.equal(await (await call(newHeaders, oldRoute)).text(), old);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve())); await new Promise(resolve => setTimeout(resolve, 100));
    await rm(directory, { recursive: true, force: true });
  }
});
