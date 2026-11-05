import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { activatePrincipal, IdentityBoundaryError } from "../src/lib/identity";
import { createCapabilityClient } from "../src/services/capability-client";
import { syntheticEvidenceReview } from "@better-me/agent-contracts";
const alice = { id: "11111111-1111-4111-8111-111111111111", username: "alice", displayName: "Alice" };
const bob = { id: "22222222-2222-4222-8222-222222222222", username: "bob", displayName: "Bob" };
afterEach(() => activatePrincipal(undefined));
test("capability response body arriving after A→B→A cannot populate a new account generation", async () => {
  activatePrincipal(alice); const late = Promise.withResolvers<Response>();
  const client = createCapabilityClient(async () => late.promise);
  const result = client.load(); const rejected = assert.rejects(result, IdentityBoundaryError);
  activatePrincipal(bob); activatePrincipal(alice);
  late.resolve(new Response(JSON.stringify({ ownerId: alice.id, catalogRevision: 1, tasks: [{ private: "LATE-ALICE" }], versions: [] })));
  await rejected; await assert.rejects(client.load(), IdentityBoundaryError);
});
test("concurrent clients send their captured authenticated owner, not model/task arguments", async () => {
  activatePrincipal(alice); let header = "";
  const client = createCapabilityClient(async (_url, init) => { header = new Headers(init?.headers).get("X-BetterMe-Owner") ?? "";
    return new Response(JSON.stringify({ ownerId: alice.id, catalogRevision: 0, tasks: [], versions: [] })); });
  assert.equal((await client.load()).ownerId, alice.id); assert.equal(header, alice.id);
  activatePrincipal(bob); await assert.rejects(client.load(), IdentityBoundaryError);
});
test("evidence task captures its own input scope and rejects its response after A→B→A", async () => {
  activatePrincipal(alice); const late = Promise.withResolvers<Response>(); let submitted: unknown;
  const client = createCapabilityClient(async (_url, init) => { submitted = JSON.parse(String(init?.body)); return late.promise; });
  const sample = syntheticEvidenceReview();
  const operation = client.startEvidenceReview(sample.input, sample.evidence, 1, "scoped-evidence-operation");
  const rejected = assert.rejects(operation, IdentityBoundaryError);
  assert.deepEqual(submitted, { input: sample.input, evidence: sample.evidence, intent: "prepare-evidence-review", consent: true,
    expectedCatalogRevision: 1, idempotencyKey: "scoped-evidence-operation" });
  activatePrincipal(bob); activatePrincipal(alice);
  late.resolve(new Response(JSON.stringify({ ownerId: alice.id, task: { evidence: "LATE-EVIDENCE" } })));
  await rejected;
});
for (const action of ["reviewEvidence", "proposeEvidence"] as const) test(`Workspace ${action} carries explicit command scope and rejects a late A→B→A result`, async () => {
  activatePrincipal(alice); const late = Promise.withResolvers<Response>(); let submitted: unknown;
  const client = createCapabilityClient(async (_url, init) => { submitted = JSON.parse(String(init?.body)); return late.promise; });
  const common = { expectedRevision: 0, idempotencyKey: "explicit-workspace-operation", consent: true as const };
  const review = { ...common, taskId: alice.id, reportReceiptId: bob.id, reportHash: "a".repeat(64), itemIndex: 1,
    decision: { kind: "unknown" as const, note: "暂不认领" } };
  const proposal = { ...common, reviewId: alice.id };
  const operation = action === "reviewEvidence" ? client.reviewEvidence(review) : client.proposeEvidence(proposal);
  const rejected = assert.rejects(operation, IdentityBoundaryError);
  assert.deepEqual(submitted, action === "reviewEvidence" ? review : proposal);
  activatePrincipal(bob); activatePrincipal(alice); late.resolve(new Response(JSON.stringify({ ownerId: alice.id, private: "LATE-WORKSPACE-PROPOSAL" })));
  await rejected;
});

for (const action of ["create", "preview", "save", "revoke-preview"] as const) test(`resume ${action} binds the captured identity generation and rejects a late response`, async () => {
  activatePrincipal(alice); const late = Promise.withResolvers<Response>(); let submitted: unknown;
  const client = createCapabilityClient(async (_url, init) => { submitted = JSON.parse(String(init?.body)); return late.promise; });
  const preview = { kind: "adopt" as const, assetId: alice.id, expectedVersionId: bob.id, proposalId: alice.id, resumeId: "synthetic-resume", experienceId: "synthetic-experience-1" };
  const create = { name: "合成简历", expectedRevision: 0, idempotencyKey: "create-explicit-synthetic", consent: true as const };
  const save = { preview, previewHash: "a".repeat(64), idempotencyKey: "save-explicit-synthetic", consent: true as const };
  const revoke = { assetId: alice.id, expectedAuthorizationRevision: 0, idempotencyKey: "revoke-explicit-synthetic" };
  const command = action === "create" ? create : action === "preview" ? preview : action === "save" ? save : revoke;
  const pending = action === "create" ? client.createSyntheticResume(create) : action === "preview" ? client.previewResumeChange(preview)
    : action === "save" ? client.saveResumeChange(save) : client.revokeResumePreview(revoke);
  const rejected = assert.rejects(pending, IdentityBoundaryError); assert.deepEqual(submitted, command);
  activatePrincipal(bob); activatePrincipal(alice);
  late.resolve(new Response(JSON.stringify({ ownerId: alice.id, private: "LATE-BUSINESS-RESUME", preview: {} })));
  await rejected;
});
