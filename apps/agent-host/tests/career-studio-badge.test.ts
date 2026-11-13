import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BadgeObservationSchema, compileEvidenceBadge, createSkillJobLinks, renderEvidenceBadge, type BadgeObservation } from "../src/career-studio/evidence-badge.js";
import { StudioArtifactStore, StudioError } from "../src/career-studio/storage.js";
const sourceHash = "a".repeat(64);
const input = (): BadgeObservation => ({ schemaVersion: 1, artifactId: "synthetic-state", sourceHash,
  receipt: { id: "verification-receipt", targetHash: sourceHash, status: "passed", verifierVersion: "synthetic-inspection-v1", checks: ["synthetic bounded state observations"], at: new Date().toISOString() },
  metrics: {}, skillIds: ["cas", "sqlite"], personalContribution: "unknown" });
test("badge is deterministically receipt-bound and unknown metrics stay neutral", () => {
  const badge = compileEvidenceBadge(input()), again = compileEvidenceBadge(input());
  // at is a receipt's immutable field; lock it when comparing a snapshot.
  assert.equal(badge.sceneHash, again.sceneHash); assert.equal(badge.parameters.facets, 6); assert.equal(badge.parameters.ior, 1.4);
  assert.ok(badge.mapping.every(item => item.value === null)); assert.match(badge.limitations.join(" "), /不是能力分/);
  assert.equal(BadgeObservationSchema.safeParse({ ...input(), receipt: { ...input().receipt, status: "failed" } }).success, false);
  assert.throws(() => compileEvidenceBadge({ ...input(), receipt: { ...input().receipt, targetHash: "b".repeat(64) } }), /badge_receipt_source_mismatch/);
});
test("engineering metric maps are explainable, bounded and source-scoped, never fabricated coverage", () => {
  const metric = (value: number) => ({ value, sourceHash, method: "synthetic-counter-v1", scope: "only this fixture" });
  const badge = compileEvidenceBadge({ ...input(), metrics: { evolutionDays: metric(365), stateTransitions: metric(100), testCoveragePercent: metric(80) } });
  assert.ok(Math.abs(badge.parameters.ior - 1.56) < 1e-10); assert.equal(badge.parameters.facets, 12); assert.ok(badge.parameters.radius <= 1.3);
  assert.throws(() => compileEvidenceBadge({ ...input(), metrics: { testCoveragePercent: metric(101) } }));
  assert.throws(() => compileEvidenceBadge({ ...input(), metrics: { evolutionDays: { ...metric(100), sourceHash: "b".repeat(64) } } }), /badge_receipt_source_mismatch/);
  assert.ok(JSON.stringify(badge.scene).length < 30_000); assert.doesNotMatch(JSON.stringify(badge.scene), /path|texture|url|file:/i);
});
test("skill links require personal implementation plus indexed persisted exact office observations", () => {
  const good = { id: "job", sourceHash, persisted: true, indexed: true, skillIds: ["cas", "other"], coordinates: { longitude: 121.1, latitude: 31.1, precision: "office" as const, verified: true } };
  assert.equal(createSkillJobLinks(compileEvidenceBadge(input()), [good]).links.length, 0);
  const badge = compileEvidenceBadge({ ...input(), personalContribution: "implementation" });
  const report = createSkillJobLinks(badge, [good, { ...good, id: "city", coordinates: { ...good.coordinates, precision: "city" } }, { ...good, id: "unpersisted", persisted: false }, { ...good, id: "out-of-world", coordinates: { ...good.coordinates, longitude: 1000 } }]);
  assert.equal(report.links.length, 1); assert.equal(report.links[0]?.strength, .5); assert.equal(report.excludedJobs, 3); assert.match(report.limitations.join(" "), /不是个人住址/);
});
test("unavailable/revoked renderer and caller-tampered scenes never launch", async () => {
  const badge = compileEvidenceBadge(input());
  await assert.rejects(renderEvidenceBadge(badge, { binaryPath: "/synthetic-no-vork", ownerId: "owner", signal: new AbortController().signal, isCurrent: async () => true }), /badge_renderer_unavailable/);
  await assert.rejects(renderEvidenceBadge({ ...badge, scene: { nodes: [{ file: "/private/no" }] } }, { binaryPath: "/synthetic-no-vork", ownerId: "owner", signal: new AbortController().signal, isCurrent: async () => true }), /badge_scene_changed/);
});
test("artifact SQLite persists CAS revisions across instances without a memory fallback", async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "betterme-studio-store-"))), store = new StudioArtifactStore("owner", directory);
  t.after(async () => { store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const value = { source: "synthetic", unknown: true }, saved = store.put("analysis", "item", 0, value);
  assert.equal(saved.revision, 1); assert.equal(store.list("analysis")[0]?.hash, saved.hash);
  assert.throws(() => store.put("analysis", "item", 0, value), (error: unknown) => error instanceof StudioError && error.code === "studio_revision_conflict");
  assert.throws(() => new StudioArtifactStore("other-owner", directory), /studio_owner_mismatch/);
  store.close(); const second = new StudioArtifactStore("owner", directory); t.after(() => second.close());
  assert.deepEqual(second.get("analysis", "item")?.value, value); assert.equal(second.put("analysis", "item", 1, { unknown: false }).revision, 2);
});
test("opt-in LIVE: real Vork renders a private receipt-bound badge without fake GPU claims", { skip: process.env["BETTERME_TEST_VORK"] !== "1", timeout: 310_000 }, async t => {
  const binary = process.env["BETTERME_TEST_VORK_BINARY"]; assert.ok(binary);
  const result = await renderEvidenceBadge(compileEvidenceBadge(input()), { binaryPath: await fs.realpath(binary), ownerId: "synthetic-owner", signal: new AbortController().signal, isCurrent: async () => true, timeoutMs: 300_000, onProgress: phase => t.diagnostic(`vork:${phase}`) });
  assert.match(result.dataUrl, /^data:image\/png;base64,/); assert.equal(result.receipt.hardware, "not_measured"); assert.equal(result.receipt.sourceHash, sourceHash);
  t.diagnostic(JSON.stringify({ hash: result.receipt.artifactHash, elapsedMs: result.receipt.elapsedMs, resolution: result.receipt.resolution, hardware: result.receipt.hardware }));
});
