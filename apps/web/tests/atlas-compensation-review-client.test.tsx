import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import type { ConfirmCompensationReviewInput, RevokeCompensationReviewInput } from "@better-me/opportunities";
import { AtlasSourceServiceError, createAtlasSourceClient } from "../src/components/atlas/service-client.ts";
import { compensationConfirmed, compensationDecision, compensationInput, compensationPreview, compensationRead, compensationReceipt,
  compensationRevokeReceipt, compensationRoutes, compensationSource } from "./fixtures/atlas-compensation-review.ts";

const client = createAtlasSourceClient("http://127.0.0.1:5178", "synthetic-compensation-client-token");
const confirm: ConfirmCompensationReviewInput = { ...compensationInput, previewFingerprint: "c".repeat(64), reviewed: true };
const revoke: RevokeCompensationReviewInput = { jobId: compensationInput.jobId, compensationId: compensationSource.id,
  expectedRevision: 12, decisionId: compensationDecision.id, reason: "撤销合成测试核对。", reviewed: true };
const read = { jobId: compensationInput.jobId, compensationId: compensationSource.id, expectedRevision: 11 };
const respond = (value: unknown) => new Response(JSON.stringify({ ok: true, requestId: "synthetic-compensation-client", value }));
const invalid = (problem: unknown) => problem instanceof AtlasSourceServiceError && problem.code === "invalid-response";
afterEach(() => mock.restoreAll());

test("salary review uses explicit authenticated routes, abort signal and the exact original write/key on recovery", async () => {
  const calls: Array<{ path: string; body: unknown; headers: Headers; signal?: AbortSignal | null }> = [];
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers), signal: init?.signal });
    return respond(path === compensationRoutes.read ? compensationRead() : path === compensationRoutes.preview ? compensationPreview()
      : path === compensationRoutes.confirm ? compensationReceipt : compensationRevokeReceipt);
  });
  const controller = new AbortController();
  assert.deepEqual(await client.readCompensationReview(read, { signal: controller.signal }), compensationRead());
  await client.previewCompensationReview(compensationInput);
  await client.confirmCompensationReview(confirm, { signal: controller.signal, idempotencyKey: "salary-synthetic-original-key" });
  await client.confirmCompensationReview(confirm, { signal: controller.signal, idempotencyKey: "salary-synthetic-original-key" });
  await client.revokeCompensationReview(revoke, { idempotencyKey: "salary-synthetic-revoke" });
  assert.deepEqual(calls.map(value => value.path), [compensationRoutes.read, compensationRoutes.preview, compensationRoutes.confirm, compensationRoutes.confirm, compensationRoutes.revoke]);
  assert.deepEqual(calls[0]!.body, read); assert.equal(calls[0]!.signal, controller.signal);
  assert.deepEqual(calls[2]!.body, confirm); assert.deepEqual(calls[3]!.body, confirm);
  assert.equal(calls[2]!.headers.get("Idempotency-Key"), calls[3]!.headers.get("Idempotency-Key"));
  assert.ok(calls.every(value => value.headers.get("Authorization") === "Bearer synthetic-compensation-client-token"));
  assert.equal(calls[0]!.headers.has("Idempotency-Key"), false);
});

test("read binds exact revision, salary disclosure, listing history and active effective interpretation", async () => {
  let response: unknown; mock.method(globalThis, "fetch", async () => respond(response));
  const valid = compensationRead(true), currentRead = { ...read, expectedRevision: 12 };
  const mutations = [
    { ...valid, revision: 13 }, { ...valid, jobId: "synthetic-unrelated-job" }, { ...valid, compensationId: "synthetic-unrelated-pay" },
    { ...valid, listingId: "synthetic-unrelated-listing" }, { ...valid, sourceCompensation: { ...compensationSource, id: "synthetic-unrelated-pay" } },
    { ...valid, current: { ...compensationConfirmed, min: 99 } }, { ...valid, activeDecisionId: "synthetic-unrelated-decision" },
    { ...valid, activeDecisionId: undefined }, { ...valid, history: [compensationDecision, compensationDecision] },
    { ...valid, history: [{ ...compensationDecision, revision: 13 }] },
    { ...valid, history: [{ ...compensationDecision, compensationId: "synthetic-unrelated-pay" }] },
    { ...valid, history: [{ ...compensationDecision, sourceBinding: { ...compensationDecision.sourceBinding,
      observations: compensationDecision.sourceBinding.observations.map(value => ({ ...value, rawText: "没有这段薪资披露" })) } }] },
  ];
  for (response of mutations) await assert.rejects(client.readCompensationReview(currentRead), invalid);
  response = valid; assert.deepEqual(await client.readCompensationReview(currentRead), valid);
  response = { ...valid, jobId: "synthetic-canonical-after-merge" };
  assert.equal((await client.readCompensationReview({ ...currentRead, jobId: "synthetic-canonical-after-merge" })).activeDecisionId, compensationDecision.id);
});

test("read rejects revoked or invalidated confirmations as active while preserving legitimate source history", async () => {
  let response: unknown; mock.method(globalThis, "fetch", async () => respond(response));
  const decision = { id: "synthetic-revocation", kind: "revoke", revision: 13, at: "2026-10-21T13:00:00Z", actorScope: compensationDecision.actorScope,
    jobId: read.jobId, compensationId: read.compensationId, listingId: compensationDecision.listingId,
    targetDecisionId: compensationDecision.id, sourceCompensation: compensationSource, sourceBinding: compensationDecision.sourceBinding, reason: "合成测试撤销" };
  const valid = { ...compensationRead(), revision: 13, history: [compensationDecision, decision] };
  response = valid; assert.equal((await client.readCompensationReview({ ...read, expectedRevision: 13 })).activeDecisionId, undefined);
  response = { ...valid, activeDecisionId: compensationDecision.id, current: compensationConfirmed };
  await assert.rejects(client.readCompensationReview({ ...read, expectedRevision: 13 }), invalid);
  const invalidate = { id: "synthetic-invalidation", kind: "invalidate", revision: 13, at: "2026-10-21T13:00:00Z", actorScope: "synthetic-system",
    targetDecisionIds: [compensationDecision.id], reason: "source-changed" };
  response = { ...valid, history: [compensationDecision, invalidate] };
  await client.readCompensationReview({ ...read, expectedRevision: 13 });
  response = { ...valid, history: [compensationDecision, { ...invalidate, targetDecisionIds: ["synthetic-unknown-decision"] }] };
  await assert.rejects(client.readCompensationReview({ ...read, expectedRevision: 13 }), invalid);
});

test("preview rejects mismatched monetary values, annualization, provenance and scope before any confirmation", async () => {
  let response: unknown; mock.method(globalThis, "fetch", async () => respond(response));
  const valid = compensationPreview();
  for (const mutated of [
    { ...valid, expectedRevision: 10 }, { ...valid, jobId: "synthetic-other-job" }, { ...valid, compensationId: "synthetic-other-salary" },
    { ...valid, current: { ...compensationSource, raw: "Different source salary" } },
    { ...valid, proposed: { ...compensationConfirmed, min: 19_000 } }, { ...valid, proposed: { ...compensationConfirmed, max: 40_000 } },
    { ...valid, proposed: { ...compensationConfirmed, currency: "USD" } }, { ...valid, proposed: { ...compensationConfirmed, tax: "net" } },
    { ...valid, proposed: { ...compensationConfirmed, kind: "total" } }, { ...valid, proposed: { ...compensationConfirmed, monthsPerYear: 12 } },
    { ...valid, proposed: { ...compensationConfirmed, hoursPerYear: 2080 } }, { ...valid, proposed: { ...compensationConfirmed, verification: "verified" } },
    { ...valid, proposed: { ...compensationConfirmed, raw: "Changed source" } }, { ...valid, proposed: { ...compensationConfirmed, evidence: compensationSource.evidence } },
    { ...valid, proposed: { ...compensationConfirmed, locationIds: [] } },
  ]) { response = mutated; await assert.rejects(client.previewCompensationReview(compensationInput), invalid); }
  response = valid; assert.deepEqual(await client.previewCompensationReview(compensationInput), valid);
});

test("a user can revoke an already invalidated interpretation and its history remains readable", async () => {
  const invalidate = { id: "synthetic-source-invalidated", kind: "invalidate", revision: 13, at: "2026-10-21T13:00:00Z",
    actorScope: "synthetic-system", targetDecisionIds: [compensationDecision.id], reason: "source-changed" };
  const revocation = { id: "synthetic-invalidated-revoke", kind: "revoke", revision: 14, at: "2026-10-21T14:00:00Z", actorScope: compensationDecision.actorScope,
    jobId: read.jobId, compensationId: read.compensationId, listingId: compensationDecision.listingId, targetDecisionId: compensationDecision.id,
    sourceCompensation: compensationSource, sourceBinding: compensationDecision.sourceBinding, reason: "明确撤销先前已失效的合成测试记录" };
  let response: unknown = { ...compensationRead(), revision: 14, history: [compensationDecision, invalidate, revocation] };
  mock.method(globalThis, "fetch", async () => respond(response));
  const result = await client.readCompensationReview({ ...read, expectedRevision: 14 });
  assert.equal(result.activeDecisionId, undefined); assert.equal(result.history.length, 3); assert.deepEqual(result.current, compensationSource);
  response = { ...result, revision: 15, history: [...result.history, { ...revocation, id: "synthetic-duplicate-revoke", revision: 15 }] };
  await assert.rejects(client.readCompensationReview({ ...read, expectedRevision: 15 }), invalid);
});

test("save and revoke require exact next revision, active decision and proposal values rather than a generic success", async () => {
  let response: unknown; mock.method(globalThis, "fetch", async () => respond(response));
  for (const mutated of [
    { ...compensationReceipt, revision: 11 }, { ...compensationReceipt, revision: 13 }, { ...compensationReceipt, jobId: "synthetic-other-job" },
    { ...compensationReceipt, activeDecisionId: "synthetic-other-decision" }, { ...compensationReceipt, compensation: { ...compensationConfirmed, monthsPerYear: 14 } },
    { ...compensationReceipt, compensation: { ...compensationConfirmed, evidence: compensationSource.evidence } },
  ]) { response = mutated; await assert.rejects(client.confirmCompensationReview(confirm, { idempotencyKey: "salary-synthetic-save" }), invalid); }
  for (const mutated of [
    { ...compensationRevokeReceipt, revision: 12 }, { ...compensationRevokeReceipt, decisionId: revoke.decisionId },
    { ...compensationRevokeReceipt, activeDecisionId: revoke.decisionId }, { ...compensationRevokeReceipt, compensationId: "synthetic-other-pay" },
  ]) { response = mutated; await assert.rejects(client.revokeCompensationReview(revoke, { idempotencyKey: "salary-synthetic-revoke" }), invalid); }
});

test("incomplete field evidence, unchecked review and malformed idempotency keys never reach the service", async () => {
  let requests = 0; mock.method(globalThis, "fetch", async () => { requests++; return respond(compensationReceipt); });
  const invalidInput = (problem: unknown) => problem instanceof AtlasSourceServiceError && problem.code === "invalid-input";
  await assert.rejects(client.previewCompensationReview({ ...compensationInput, proposal: { ...compensationInput.proposal, supports: [] } }), invalidInput);
  await assert.rejects(client.previewCompensationReview({ ...compensationInput, proposal: { ...compensationInput.proposal, min: 40_000 } }), invalidInput);
  await assert.rejects(client.confirmCompensationReview({ ...confirm, reviewed: false } as unknown as ConfirmCompensationReviewInput, { idempotencyKey: "salary-synthetic-save" }), invalidInput);
  await assert.rejects(client.confirmCompensationReview(confirm, { idempotencyKey: "bad key" }), invalidInput);
  await assert.rejects(client.revokeCompensationReview({ ...revoke, reviewed: false } as unknown as RevokeCompensationReviewInput, { idempotencyKey: "salary-synthetic-revoke" }), invalidInput);
  assert.equal(requests, 0);
});
