import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, rename, symlink, unlink, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { syntheticJobComparison } from "@better-me/agent-contracts";
import { CareerCapabilities } from "../src/capabilities/service.js";
import { fixtureSource } from "./fixtures/capability-source.js";
const access = { session: "synthetic-session", valid: async () => true };
const input = syntheticJobComparison();
const request = { input, idempotencyKey: "recovery-operation", expectedCatalogRevision: 0, consent: true as const, model: "gemma4:e2b-it-qat" as const };
const builder = async () => ({ source: fixtureSource, provider: "regression-substitute", model: "fixture", promptHash: "fixture", durationMs: 0 });

test("seven assessment outcomes distinguish prerequisites, outage, gap, composition and persistent receipt replay", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-capability-assess-")); let online = false;
  const service = new CareerCapabilities({ directory, ownerId: "synthetic-owner", builder, localModelAvailable: async () => online });
  try {
    assert.equal((await service.assess({ input }, access)).kind, "needs_grant");
    assert.equal((await service.assess({ input: {} }, access)).kind, "missing_input");
    assert.equal((await service.assess({ input, consent: true, intent: "install-untrusted-shell" }, access)).kind, "prohibited");
    assert.equal((await service.assess({ input, consent: true }, access)).kind, "temporary_unavailable");
    online = true; assert.equal((await service.assess({ input, consent: true }, access)).kind, "gap");
    await service.start(request, access); await service.settled();
    assert.equal((await service.assess({ input, consent: true }, access)).kind, "compose");
    assert.equal((await service.assess({ input, consent: true, idempotencyKey: request.idempotencyKey }, access)).kind, "ready");
    assert.equal((await service.snapshot()).tasks[0]?.builderCalls, 1);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("save failure cannot claim completion; explicit save-only recovery creates one receipt without regeneration", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-capability-save-failure-"));
  const filename = path.join(directory, "career-capabilities-v1.json"), backup = path.join(directory, "last-good.json"); let faulted = false;
  const service = new CareerCapabilities({ directory, ownerId: "synthetic-owner", builder, onCheckpoint: async event => {
    if (!faulted && event.detail.startsWith("本次结果通过；")) {
      faulted = true; await rename(filename, backup); await symlink(backup, filename);
    }
  } });
  try {
    const task = await service.start(request, access); await service.settled();
    const failed = await service.snapshot(); assert.ok(failed.storageError); assert.equal(failed.tasks[0]?.stage, "partial");
    assert.equal(failed.tasks[0]?.receipt, undefined); assert.ok(failed.tasks[0]?.output);
    await unlink(filename); await rename(backup, filename);
    const [a, b] = await Promise.all([service.retrySave(task.id, access), service.retrySave(task.id, access)]);
    assert.equal(a.id, b.id); const restored = await service.snapshot();
    assert.equal(restored.tasks[0]?.stage, "completed"); assert.equal(restored.tasks[0]?.builderCalls, 1); assert.equal(restored.storageError, undefined);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("single-writer enforcement, restart receipts and interrupted runs do not blindly replay a paid/build operation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-capability-restart-"));
  const options = { directory, ownerId: "synthetic-owner", builder }; let current = new CareerCapabilities(options);
  try {
    await current.snapshot(); const second = new CareerCapabilities(options);
    await assert.rejects(second.snapshot(), /single_writer_required/); await second.close();
    await current.start(request, access); await current.settled(); const before = (await current.snapshot()).tasks[0]!;
    await current.close();
    current = new CareerCapabilities(options);
    const replay = await current.start(request, access);
    assert.equal(replay.receipt?.id, before.receipt?.id); assert.equal(replay.builderCalls, before.builderCalls);
    await current.close();
    // Crash fixture contains an accepted task with no terminal receipt; recreation
    // must label it interrupted and revoke its old lease, not run it again.
    const filename = path.join(directory, "career-capabilities-v1.json");
    const state = JSON.parse(await readFile(filename, "utf8"));
    const prior = state.tasks[0]; state.tasks.push({ ...prior, id: "interrupted-synthetic-task", logicalKey: "pending-operation",
      stage: "acquiring", receipt: undefined, output: undefined, outputHash: undefined, taskVerification: undefined });
    await writeFile(filename, JSON.stringify(state), { mode: 0o600 });
    current = new CareerCapabilities(options); const after = await current.snapshot();
    assert.equal(after.tasks[1]?.stage, "interrupted"); assert.equal(after.tasks[1]?.grant.revoked, true);
    assert.equal(after.tasks[1]?.builderCalls, before.builderCalls); assert.deepEqual(after.tasks[0]?.receipt, before.receipt);
  } finally { await current.close(); await rm(directory, { recursive: true, force: true }); }
});

test("changed implementation/environment invalidates old qualification without rewriting historical business receipts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-capability-invalidate-"));
  let current = new CareerCapabilities({ directory, ownerId: "synthetic-owner", builder });
  try {
    await current.start(request, access); await current.settled(); const original = (await current.snapshot()).tasks[0]!;
    await current.close();
    const filename = path.join(directory, "career-capabilities-v1.json"), raw = JSON.parse(await readFile(filename, "utf8"));
    raw.versions[0].environment = "old-incompatible-engine"; raw.versions[0].source = "() => []";
    await writeFile(filename, JSON.stringify(raw), { mode: 0o600 });
    current = new CareerCapabilities({ directory, ownerId: "synthetic-owner", builder: async () => ({ source: "() => []", provider: "regression-substitute", model: "bad-upgrade", promptHash: "fixture", durationMs: 0 }) });
    const invalid = await current.snapshot(); assert.equal(invalid.versions[0]?.state, "disabled");
    assert.ok(invalid.tasks[0]?.reviewReason); assert.deepEqual(invalid.tasks[0]?.receipt, original.receipt);
    await assert.rejects(current.revalidate(1, invalid.catalogRevision, access), /immutable_version_incompatible/);
    await current.start({ ...request, idempotencyKey: "failed-upgrade", expectedCatalogRevision: invalid.catalogRevision }, access); await current.settled();
    const after = await current.snapshot(); assert.equal(after.tasks[1]?.stage, "failed"); assert.equal(after.versions.length, 1);
    assert.deepEqual(after.tasks[0]?.receipt, original.receipt); assert.deepEqual(after.tasks[0]?.output, original.output);
  } finally { await current.close(); await rm(directory, { recursive: true, force: true }); }
});
