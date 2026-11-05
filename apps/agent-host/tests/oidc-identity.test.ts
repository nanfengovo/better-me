import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { IdentityService } from "../src/identity/service.js";

test("verified issuer/subject binding preserves the existing owner; equal names never merge, concurrent links cannot steal ownership", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-oidc-binding-"));
  const service = new IdentityService(directory);
  try {
    const alice = await service.signIn({ username: "alice", password: "synthetic-only-password" }, true, "alice");
    const bob = await service.signIn({ username: "bob", password: "synthetic-only-password" }, true, "bob");
    const proof = { issuer: "https://idp.example", subject: "alice-subject", displayName: "alice" };
    const linked = await service.linkExternal(service.cookie(alice.token, false), alice.principal.id, proof, () => true);
    assert.equal(linked.id, alice.principal.id);
    const sessions = await Promise.all(Array.from({ length: 8 }, () => service.signInExternal(proof, () => true)));
    assert.ok(sessions.every(session => session.principal.id === alice.principal.id));
    await assert.rejects(service.linkExternal(service.cookie(bob.token, false), bob.principal.id, proof, () => true), /external_identity_already_linked/);
    const sameName = await service.signInExternal({ ...proof, subject: "another-person" }, () => true);
    assert.notEqual(sameName.principal.id, alice.principal.id);
    const otherIssuer = await service.signInExternal({ ...proof, issuer: "https://other-idp.example" }, () => true);
    assert.notEqual(otherIssuer.principal.id, alice.principal.id);
    await service.signOut(service.cookie(alice.token, false));
    await assert.rejects(service.linkExternal(service.cookie(alice.token, false), alice.principal.id, { ...proof, subject: "late" }, () => true), /identity_required/);
    await assert.rejects(service.signInExternal({ ...proof, subject: "cancelled" }, () => false), /oidc_flow_cancelled/);
    const restarted = new IdentityService(directory);
    assert.equal((await restarted.signInExternal(proof, () => true)).principal.id, alice.principal.id);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
