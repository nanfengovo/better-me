import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import type { ConfirmOfficeAddressInput, PreviewOfficeConfirmationInput, RevokeOfficeAddressInput } from "@better-me/opportunities";
import { AtlasSourceServiceError, createAtlasSourceClient } from "../src/components/atlas/service-client.ts";
import { officeCandidates, officeConfirmed, officeJobId, officePreview, officeProposal, officeReason, officeReceipt, officeRevocation, officeRoutes, officeSource } from "./fixtures/atlas-office-address.ts";

const client = createAtlasSourceClient("http://127.0.0.1:5178", "synthetic-office-client-token");
const previewInput: PreviewOfficeConfirmationInput = { jobId: officeJobId, locationId: officeSource.id, expectedRevision: 11, proposal: officeProposal, reason: officeReason };
const confirmInput: ConfirmOfficeAddressInput = { ...previewInput, previewFingerprint: "b".repeat(64), reviewed: true };
const revokeInput: RevokeOfficeAddressInput = { jobId: officeJobId, locationId: officeSource.id, expectedRevision: 11, decisionId: officeReceipt.decisionId, reason: "Synthetic revoke reason", reviewed: true };
const candidateInput = { jobId: officeJobId, locationId: officeSource.id, expectedRevision: 11, query: "Synthetic Example Road 10" };
function respond(value: unknown) { return new Response(JSON.stringify({ ok: true, requestId: "synthetic-office-client", value })); }
const invalid = (error: unknown) => error instanceof AtlasSourceServiceError && error.code === "invalid-response";
afterEach(() => mock.restoreAll());

test("office tools use authenticated explicit routes and keep writes bound to their original key, input and abort signal", async () => {
  const calls: Array<{ path: string; body: unknown; headers: Headers; signal?: AbortSignal | null }> = [];
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers), signal: init?.signal });
    return respond(path === officeRoutes.candidates ? officeCandidates : path === officeRoutes.preview ? officePreview() : path === officeRoutes.confirm ? officeReceipt : officeRevocation);
  });
  const controller = new AbortController(), key = "office-synthetic-stable-key";
  assert.deepEqual(await client.officeAddressCandidates(candidateInput, { signal: controller.signal }), officeCandidates);
  await client.previewOfficeConfirmation(previewInput);
  await client.confirmOfficeAddress(confirmInput, { idempotencyKey: key, signal: controller.signal });
  await client.confirmOfficeAddress(confirmInput, { idempotencyKey: key, signal: controller.signal });
  await client.revokeOfficeAddress(revokeInput, { idempotencyKey: "office-synthetic-revoke" });
  assert.deepEqual(calls.map(call => call.path), [officeRoutes.candidates, officeRoutes.preview, officeRoutes.confirm, officeRoutes.confirm, officeRoutes.revoke]);
  assert.deepEqual(calls[0]!.body, candidateInput); assert.equal(calls[0]!.signal, controller.signal);
  assert.deepEqual(calls[2]!.body, confirmInput); assert.deepEqual(calls[3]!.body, confirmInput);
  assert.equal(calls[2]!.headers.get("Idempotency-Key"), key); assert.equal(calls[3]!.headers.get("Idempotency-Key"), key);
  assert.ok(calls.every(call => call.headers.get("Authorization") === "Bearer synthetic-office-client-token"));
  assert.equal(calls[0]!.headers.has("Idempotency-Key"), false);
});

test("candidate responses must match the job, location, revision and explicit external-query scope", async () => {
  let response: unknown = officeCandidates;
  mock.method(globalThis, "fetch", async () => respond(response));
  for (const changed of [
    { ...officeCandidates, jobId: "synthetic-other-job" }, { ...officeCandidates, locationId: "synthetic-other-location" },
    { ...officeCandidates, revision: 10 }, { ...officeCandidates, sourceLocation: { ...officeSource, id: "synthetic-other-location" } },
    { ...officeCandidates, candidates: [officeCandidates.candidates[0], officeCandidates.candidates[0]] },
    { ...officeCandidates, configured: false }, { ...officeCandidates, status: "no-address-match" },
    { ...officeCandidates, sourceLocation: { ...officeSource, kind: "remote-region" } },
  ]) { response = changed; await assert.rejects(client.officeAddressCandidates(candidateInput), invalid); }
  response = officeCandidates;
  const { query: _query, ...withoutQuery } = candidateInput;
  await assert.rejects(client.officeAddressCandidates(withoutQuery), invalid);
  response = { ...officeCandidates, candidates: [], status: "manual-available" };
  assert.equal((await client.officeAddressCandidates(withoutQuery)).status, "manual-available");
  response = { ...officeCandidates, configured: false, candidates: [], status: "not-configured" };
  assert.equal((await client.officeAddressCandidates(candidateInput)).status, "not-configured");
});

test("preview rejects different coordinates, address facts, provenance, active decision, source identity and revision", async () => {
  let response: unknown;
  mock.method(globalThis, "fetch", async () => respond(response));
  const base = officePreview();
  const proposed = (change: Record<string, unknown>) => ({ ...base, proposed: { ...officeConfirmed, ...change } });
  const resolution = officeConfirmed.officeResolution!;
  for (const changed of [
    { ...base, expectedRevision: 10 }, { ...base, locationId: "synthetic-other-location" }, { ...base, jobId: "synthetic-other-job" },
    { ...base, current: { ...officeSource, id: "synthetic-other-location" } }, { ...base, activeDecisionId: "synthetic-unrelated-decision" },
    proposed({ coordinates: { ...officeProposal.coordinates, latitude: 20 } }), proposed({ countryCode: "US" }),
    proposed({ raw: "Other source text" }), proposed({ streetAddress: "Other street" }), proposed({ evidence: [] }),
    proposed({ postalCode: "999999" }), proposed({ officeResolution: { ...resolution, formattedAddress: "Another address" } }),
    proposed({ officeResolution: { ...resolution, evidenceUrl: "https://other.example.invalid/place" } }),
    proposed({ officeResolution: { ...resolution, coordinateMeaning: "entrance" } }),
    proposed({ resolvedAt: "2026-10-18T12:00:00.000Z" }),
  ]) { response = changed; await assert.rejects(client.previewOfficeConfirmation(previewInput), invalid); }
  response = base; assert.deepEqual(await client.previewOfficeConfirmation(previewInput), base);
});

test("confirm and revoke receipts must represent the exact next revision and the returned active office decision", async () => {
  let response: unknown;
  mock.method(globalThis, "fetch", async () => respond(response));
  for (const changed of [
    { ...officeReceipt, revision: 11 }, { ...officeReceipt, revision: 13 }, { ...officeReceipt, jobId: "synthetic-other-job" },
    { ...officeReceipt, activeDecisionId: "synthetic-other-decision" }, { ...officeReceipt, decisionId: "synthetic-other-decision" },
    { ...officeReceipt, location: { ...officeConfirmed, coordinates: { ...officeProposal.coordinates, longitude: 120 } } },
  ]) { response = changed; await assert.rejects(client.confirmOfficeAddress(confirmInput, { idempotencyKey: "office-synthetic-save" }), invalid); }
  for (const changed of [
    { ...officeRevocation, revision: 13 }, { ...officeRevocation, decisionId: revokeInput.decisionId },
    { ...officeRevocation, locationId: "synthetic-other-location" }, { ...officeRevocation, activeDecisionId: revokeInput.decisionId, location: officeConfirmed },
    { ...officeRevocation, activeDecisionId: "synthetic-other-active" },
  ]) { response = changed; await assert.rejects(client.revokeOfficeAddress(revokeInput, { idempotencyKey: "office-synthetic-revoke" }), invalid); }
  response = officeRevocation; assert.deepEqual(await client.revokeOfficeAddress(revokeInput, { idempotencyKey: "office-synthetic-revoke" }), officeRevocation);
});

test("invalid proposals, missing explicit review and invalid keys never reach the service", async () => {
  let requests = 0; mock.method(globalThis, "fetch", async () => { requests++; return respond(officeReceipt); });
  const invalidInput = (error: unknown) => error instanceof AtlasSourceServiceError && error.code === "invalid-input";
  await assert.rejects(client.previewOfficeConfirmation({ ...previewInput, proposal: { ...officeProposal, coordinates: { ...officeProposal.coordinates, latitude: 91 } } }), invalidInput);
  await assert.rejects(client.previewOfficeConfirmation({ ...previewInput, proposal: { ...officeProposal, evidenceUrl: "javascript:alert(1)" } }), invalidInput);
  await assert.rejects(client.confirmOfficeAddress({ ...confirmInput, reviewed: false } as unknown as ConfirmOfficeAddressInput, { idempotencyKey: "office-synthetic-save" }), invalidInput);
  await assert.rejects(client.revokeOfficeAddress(revokeInput, { idempotencyKey: "bad key" }), invalidInput);
  assert.equal(requests, 0);
});
