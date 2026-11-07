import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import { applyCompanyControlReviewConfirmation, validateCompanyControlReviewProposal } from "@better-me/opportunities";
import { createAtlasSourceClient, AtlasSourceServiceError } from "../src/components/atlas/service-client.ts";
import { companyControlCompanyId, companyControlJobId, companyControlProposal, companyControlReason } from "./fixtures/atlas-company-control.ts";
import { companyData, companyDecision, companyRead, companyPreview, companyReceipt, companySavedRead } from "./fixtures/atlas-company-control-web.ts";

const readInput = { jobId: companyControlJobId, companyId: companyControlCompanyId, expectedRevision: 0 };
const previewInput = { ...readInput, proposal: companyControlProposal, reason: companyControlReason };
const confirmInput = { ...previewInput, previewFingerprint: companyPreview.previewFingerprint, reviewed: true as const };
const client = () => createAtlasSourceClient("http://127.0.0.1:5178", "synthetic-company-review-token");
const response = (value: unknown) => new Response(JSON.stringify({ ok: true, requestId: "synthetic-company-review", value }));
const invalidResponse = (error: unknown) => error instanceof AtlasSourceServiceError && error.code === "invalid-response";
afterEach(() => mock.restoreAll());

test("company review client uses all four authenticated POST routes and preserves write keys", async () => {
  const calls: { path: string; method: string | undefined; body: unknown; key: string | null }[] = [];
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, method: init.method, body: JSON.parse(String(init.body)), key: new Headers(init.headers).get("Idempotency-Key") });
    return response(path.endsWith("/read") ? companyRead : path.endsWith("/preview") ? companyPreview : path.endsWith("/confirm") ? companyReceipt
      : { ...companyReceipt, revision: 2, decisionId: "synthetic-revoke", activeDecisionId: undefined, company: companyRead.sourceCompany });
  });
  const service = client(); await service.readCompanyControlReview(readInput); await service.previewCompanyControlReview(previewInput);
  await service.confirmCompanyControlReview(confirmInput, { idempotencyKey: "company-confirm-original" });
  await service.revokeCompanyControlReview({ ...readInput, expectedRevision: 1, decisionId: companyReceipt.decisionId, reason: "Synthetic revoke", reviewed: true }, { idempotencyKey: "company-revoke-original" });
  assert.deepEqual(calls.map(call => call.path), ["read", "preview", "confirm", "revoke"].map(route => `/api/v1/companies/control-review/${route}`));
  assert.ok(calls.every(call => call.method === "POST")); assert.equal(calls[2]!.key, "company-confirm-original"); assert.equal(calls[3]!.key, "company-revoke-original");
  assert.deepEqual(calls[2]!.body, confirmInput);
});

test("company review read replays history and validates archived raw material hashes", async () => {
  let value: unknown = companySavedRead; mock.method(globalThis, "fetch", async () => response(value));
  assert.deepEqual(await client().readCompanyControlReview({ ...readInput, expectedRevision: 1 }), companySavedRead);
  const forged = structuredClone(companySavedRead); if (forged.history[0]!.kind === "confirm") forged.history[0]!.materials[0]!.contentHash = "0".repeat(64); value = forged;
  await assert.rejects(client().readCompanyControlReview({ ...readInput, expectedRevision: 1 }), invalidResponse);
  value = { ...companySavedRead, activeDecisionId: undefined };
  await assert.rejects(client().readCompanyControlReview({ ...readInput, expectedRevision: 1 }), invalidResponse);
});

test("company preview rejects a different employer, controller origin, citation or affected job scope", async () => {
  for (const tamper of [(value: typeof companyPreview) => { value.proposed.ultimateControllers.value[0]!.jurisdictionCode = "US"; },
    (value: typeof companyPreview) => { value.proposed.legalEntity!.value = "Different employer"; },
    (value: typeof companyPreview) => { value.proposed.ultimateControllers.evidence[0]!.quote = "Different citation"; },
    (value: typeof companyPreview) => { value.affectedJobIds = ["another-job"]; }]) {
    const value = structuredClone(companyPreview); tamper(value); mock.restoreAll(); mock.method(globalThis, "fetch", async () => response(value));
    await assert.rejects(client().previewCompanyControlReview(previewInput), invalidResponse);
  }
});

test("company save and revoke receipts reject wrong values and remain untrusted for recovery", async () => {
  const value = structuredClone(companyReceipt); value.company.ultimateControllers.value[0]!.kind = "state";
  mock.method(globalThis, "fetch", async () => response(value));
  await assert.rejects(client().confirmCompanyControlReview(confirmInput, { idempotencyKey: "original-key" }), invalidResponse);
  await assert.rejects(client().revokeCompanyControlReview({ ...readInput, decisionId: companyReceipt.decisionId, reason: "Synthetic revoke", reviewed: true }, { idempotencyKey: "revoke-key" }), invalidResponse);
});

test("company review read rejects a future decision even when its marker and archived material agree", async () => {
  const futureAt = new Date(Date.now() + 86_400_000).toISOString(), forged = structuredClone(companySavedRead);
  forged.history[0]!.at = futureAt; forged.current.controlReview!.at = futureAt;
  mock.method(globalThis, "fetch", async () => response(forged));
  await assert.rejects(client().readCompanyControlReview({ ...readInput, expectedRevision: 1 }), invalidResponse);
  const materialFuture = structuredClone(companySavedRead);
  if (materialFuture.history[0]!.kind === "confirm") {
    materialFuture.history[0]!.proposal.documents[0]!.retrievedAt = futureAt;
    materialFuture.history[0]!.materials[0]!.retrievedAt = futureAt;
  }
  mock.restoreAll(); mock.method(globalThis, "fetch", async () => response(materialFuture));
  await assert.rejects(client().readCompanyControlReview({ ...readInput, expectedRevision: 1 }), invalidResponse);
});

test("preview rejects self-consistent future materials and marker rather than trusting their own timestamps", async () => {
  const proposal = structuredClone(companyControlProposal); proposal.documents[0]!.retrievedAt = new Date(Date.now() + 86_400_000).toISOString();
  const value = { ...companyPreview, proposed: validateCompanyControlReviewProposal(companyData, { jobId: companyControlJobId,
    companyId: companyControlCompanyId, sourceCompany: companyRead.sourceCompany, proposal }) };
  mock.method(globalThis, "fetch", async () => response(value));
  await assert.rejects(client().previewCompanyControlReview({ ...previewInput, proposal }), invalidResponse);
});

test("future company markers are not trusted save or revoke receipts and keep same-key recovery necessary", async () => {
  const proposal = structuredClone(companyControlProposal), futureAt = new Date(Date.now() + 86_400_000).toISOString(); proposal.documents[0]!.retrievedAt = futureAt;
  const company = applyCompanyControlReviewConfirmation(companyRead.sourceCompany, { ...companyDecision, at: futureAt, proposal });
  mock.method(globalThis, "fetch", async () => response({ ...companyReceipt, company }));
  await assert.rejects(client().confirmCompanyControlReview({ ...confirmInput, proposal }, { idempotencyKey: "future-confirm-original-key" }), invalidResponse);
  company.controlReview!.decisionId = "another-active-review";
  mock.restoreAll(); mock.method(globalThis, "fetch", async () => response({ ...companyReceipt, decisionId: "synthetic-revoke-receipt", activeDecisionId: "another-active-review", company }));
  await assert.rejects(client().revokeCompanyControlReview({ ...readInput, decisionId: companyReceipt.decisionId, reason: "Synthetic revoke", reviewed: true }, { idempotencyKey: "future-revoke-original-key" }), invalidResponse);
});
