import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import {
  MergeReviewPreviewSchema, ReconciliationReceiptSchema, RevokeMergeReviewPreviewSchema,
  type MergeCandidate, type MergeDecision, type MergeReviewPreview, type PreviewMergeReviewInput,
  type ReconciliationReceipt, type RevokeMergeReviewPreview,
} from "@better-me/opportunities";
import { AtlasClientError } from "../src/components/atlas/client.ts";
import { createAtlasDemo } from "../src/components/atlas/demo.ts";
import { AtlasSourceServiceError, createAtlasSourceClient } from "../src/components/atlas/service-client.ts";

const client = () => createAtlasSourceClient("http://127.0.0.1:5178", " synthetic-reconciliation-token ");
const dataset = createAtlasDemo(), revision = 11, fingerprint = "b".repeat(64), at = "2026-10-19T12:00:00.000Z";
const targetJobId = dataset.jobs[0]!.id, sourceJobId = dataset.jobs[1]!.id;
const query = { targetJobId, sourceJobId, expectedRevision: revision, reason: "已逐一核对合成岗位原文与雇主身份。", companyIdentityConfirmed: true };
const command = { ...query, previewFingerprint: fingerprint, reviewed: true as const };
const revokeQuery = { decisionId: "synthetic-merge-decision", expectedRevision: 12, reason: "合成原始记录表明是两项不同招聘需求。" };
const revokeCommand = { ...revokeQuery, previewFingerprint: fingerprint, reviewed: true as const };
const candidate: MergeCandidate = { schemaVersion: 1, id: "synthetic-pair", leftJobId: targetJobId, rightJobId: sourceJobId,
  snapshotRevision: revision, strong: false, requiresCompanyConfirmation: true,
  signals: [{ kind: "same-title", strength: "weak", value: "Synthetic engineer", listingIds: [], evidence: [] }], conflicts: [] };
function side(jobId: string): MergeReviewPreview["target"] {
  const job = dataset.jobs.find(value => value.id === jobId)!;
  return { requestedJobId: jobId, canonicalJobId: jobId, job, company: dataset.companies.find(value => value.id === job.companyId)!,
    listings: dataset.listings.filter(value => job.listingIds.includes(value.id)), sources: dataset.sources,
    locations: dataset.locations.filter(value => job.locationIds.includes(value.id)),
    compensations: dataset.compensations.filter(value => job.compensationIds.includes(value.id)) };
}
function preview(): MergeReviewPreview {
  return MergeReviewPreviewSchema.parse({ snapshotRevision: revision, expectedRevision: revision, previewFingerprint: fingerprint,
    input: query, target: side(targetJobId), source: side(sourceJobId), candidate, warnings: ["Synthetic candidate requires explicit review."] });
}
function mergeDecision(): Extract<MergeDecision, { kind: "merge" }> {
  return { id: revokeQuery.decisionId, actorScope: "local-owner", at, revision: 12, reason: query.reason, kind: "merge",
    targetJobId, sourceJobId, companyIdentityConfirmed: true, candidate };
}
function receipt(kind: "merge" | "reject" | "revoke" = "merge"): ReconciliationReceipt {
  const metadata = { id: `synthetic-${kind}-decision`, actorScope: "local-owner", at, revision: kind === "revoke" ? 13 : 12,
    reason: kind === "revoke" ? revokeQuery.reason : query.reason };
  const decision: MergeDecision = kind === "merge" ? mergeDecision() : kind === "reject" ? { ...metadata, kind, leftJobId: targetJobId, rightJobId: sourceJobId, candidate }
    : { ...metadata, kind, targetDecisionId: revokeQuery.decisionId };
  return ReconciliationReceiptSchema.parse({ ok: true, revision: decision.revision, decision,
    aliases: [{ jobId: targetJobId, canonicalJobId: targetJobId }, { jobId: sourceJobId, canonicalJobId: kind === "merge" ? targetJobId : sourceJobId }] });
}
function revokePreview(): RevokeMergeReviewPreview {
  const before = side(targetJobId), other = side(sourceJobId);
  before.job = { ...before.job, listingIds: [...before.job.listingIds, ...other.job.listingIds],
    locationIds: [...before.job.locationIds, ...other.job.locationIds], compensationIds: [...before.job.compensationIds, ...other.job.compensationIds] };
  before.listings = [...before.listings, ...other.listings]; before.locations = [...before.locations, ...other.locations]; before.compensations = [...before.compensations, ...other.compensations];
  return RevokeMergeReviewPreviewSchema.parse({ snapshotRevision: 12, expectedRevision: 12, previewFingerprint: fingerprint, input: revokeQuery,
    decision: mergeDecision(), before: [before], after: [side(targetJobId), side(sourceJobId)], counts: { beforeJobs: 1, afterJobs: 2 }, warnings: [] });
}
const candidates = () => ({ snapshotRevision: revision, candidates: [candidate], limit: 50, scannedCandidateLimit: 1000, truncated: false, warnings: [] });
const history = () => ({ snapshotRevision: 12, items: [{ decision: mergeDecision(), status: "active" }], totalAvailable: 1, limit: 50, truncated: false, warnings: [] });
const response = (value: unknown) => new Response(JSON.stringify({ ok: true, requestId: "synthetic-reconciliation-client", value }));
const invalidResponse = (error: unknown) => error instanceof AtlasSourceServiceError && error.code === "invalid-response";
type Call = { path: string; init?: RequestInit; body: unknown; key: string | null };
function installFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const call = { path: new URL(String(url)).pathname, init, body: JSON.parse(String(init?.body)), key: new Headers(init?.headers).get("Idempotency-Key") };
    calls.push(call); return handler(call);
  });
  return calls;
}
afterEach(() => mock.restoreAll());

test("reconciliation reads use only explicit authenticated POSTs with strict defaults and cancellation identity", async () => {
  const signal = new AbortController().signal;
  const calls = installFetch(call => response(call.path.endsWith("/candidates") ? candidates() : call.path.endsWith("/history") ? history()
    : call.path.endsWith("/preview-revoke") ? revokePreview() : preview()));
  const service = client(); assert.equal(calls.length, 0);
  assert.deepEqual(await service.listMergeCandidates({}, { signal }), candidates());
  assert.deepEqual(await service.listMergeDecisions({}, { signal }), history());
  assert.deepEqual(await service.previewMerge(query, { signal }), preview());
  assert.deepEqual(await service.previewRevokeMerge(revokeQuery, { signal }), revokePreview());
  assert.deepEqual(calls.map(call => call.path), ["candidates", "history", "preview", "preview-revoke"].map(path => `/api/v1/jobs/reconciliation/${path}`));
  assert.deepEqual(calls[0]!.body, { limit: 50 }); assert.deepEqual(calls[1]!.body, { limit: 50 }); assert.deepEqual(calls[2]!.body, query);
  for (const call of calls) {
    assert.equal(call.init?.method, "POST"); assert.equal(call.init?.signal, signal); assert.equal(call.init?.credentials, "omit");
    assert.equal(call.init?.redirect, "error"); assert.equal(call.init?.cache, "no-store"); assert.equal(call.key, null);
    assert.deepEqual(call.init?.headers, { Authorization: "Bearer synthetic-reconciliation-token", "Content-Type": "application/json" });
  }
});

test("merge preview rejects another direction, original request, revision or evidence-side identity", async () => {
  const mutations: Array<(value: MergeReviewPreview) => void> = [
    value => { [value.target, value.source] = [value.source, value.target]; },
    value => { value.input.reason = "Unreviewed replacement reason"; },
    value => { value.input.companyIdentityConfirmed = false; },
    value => { value.input.expectedRevision++; }, value => { value.expectedRevision++; }, value => { value.snapshotRevision++; },
    value => { value.candidate.snapshotRevision++; }, value => { value.candidate.leftJobId = "unrelated-job"; },
    value => { value.target.requestedJobId = "another-requested-job"; }, value => { value.source.canonicalJobId = targetJobId; },
    value => { value.target.company.id = "unrelated-company"; }, value => { value.source.locations = []; },
    value => { value.source.compensations = []; }, value => { value.target.listings = []; }, value => { value.target.sources = []; },
  ];
  for (const mutate of mutations) {
    const result = preview(); mutate(result); assert.equal(MergeReviewPreviewSchema.safeParse(result).success, true);
    const calls = installFetch(() => response(result));
    await assert.rejects(client().previewMerge(query), invalidResponse); assert.equal(calls.length, 1); mock.restoreAll();
  }
});

test("candidate and history pages cannot silently change the read limit or mix snapshot revisions", async () => {
  for (const value of [{ ...candidates(), limit: 4 }, { ...candidates(), candidates: [{ ...candidate, snapshotRevision: 10 }] },
    { ...candidates(), candidates: [candidate, candidate] }, { ...candidates(), candidates: [{ ...candidate, rightJobId: targetJobId }] }]) {
    installFetch(() => response(value)); await assert.rejects(client().listMergeCandidates({}), invalidResponse); mock.restoreAll();
  }
  for (const value of [{ ...history(), limit: 2 }, { ...history(), snapshotRevision: 11 }, { ...history(), totalAvailable: 0 },
    { ...history(), truncated: true }, { ...history(), items: [{ decision: mergeDecision(), status: "revocation" }] },
    { ...history(), items: [{ decision: receipt("revoke").decision, status: "active" }], snapshotRevision: 13 }]) {
    installFetch(() => response(value)); await assert.rejects(client().listMergeDecisions({}), invalidResponse); mock.restoreAll();
  }
});

test("all writes preserve the reviewed caller body and idempotency key and never synthesize a new key", async () => {
  const calls = installFetch(call => response(receipt(call.path.endsWith("/reject") ? "reject" : call.path.endsWith("/revoke") ? "revoke" : "merge")));
  assert.deepEqual(await client().mergeJobs(command, { idempotencyKey: "synthetic-merge-key" }), receipt());
  assert.deepEqual(await client().rejectMerge(command, { idempotencyKey: "synthetic-reject-key" }), receipt("reject"));
  assert.deepEqual(await client().revokeMerge(revokeCommand, { idempotencyKey: "synthetic-revoke-key" }), receipt("revoke"));
  assert.deepEqual(calls.map(call => call.path), ["merge", "reject", "revoke"].map(path => `/api/v1/jobs/reconciliation/${path}`));
  assert.deepEqual(calls.map(call => call.body), [command, command, revokeCommand]);
  assert.deepEqual(calls.map(call => call.key), ["synthetic-merge-key", "synthetic-reject-key", "synthetic-revoke-key"]);
});

test("unreviewed or extra private payloads, unbounded reads and malformed keys stop before fetch", async () => {
  const calls = installFetch(() => { throw new Error("must not request"); });
  const service = client(), options = { idempotencyKey: "synthetic-key" };
  for (const value of [{ ...command, reviewed: false }, { ...command, previewFingerprint: "bad" }, { ...command, actorScope: "other-owner" },
    { ...command, homeAddress: "PRIVATE_ADDRESS" }, { ...command, expectedRevision: -1 }]) {
    await assert.rejects(service.mergeJobs(value as typeof command, options), (error: unknown) => error instanceof AtlasSourceServiceError && error.code === "invalid-input");
    await assert.rejects(service.rejectMerge(value as typeof command, options), (error: unknown) => error instanceof AtlasSourceServiceError && error.code === "invalid-input");
  }
  await assert.rejects(service.previewMerge({ ...query, requisitionLinks: [] } as PreviewMergeReviewInput), AtlasSourceServiceError);
  await assert.rejects(service.listMergeCandidates({ limit: 101 }), AtlasSourceServiceError);
  await assert.rejects(service.listMergeDecisions({ jobId: "bad/id" }), AtlasSourceServiceError);
  await assert.rejects(service.revokeMerge({ ...revokeCommand, reviewed: false } as typeof revokeCommand, options), AtlasSourceServiceError);
  await assert.rejects(service.mergeJobs(command, { idempotencyKey: "bad\nkey" }), AtlasSourceServiceError);
  assert.equal(calls.length, 0);
});

test("write receipts bind action, canonical direction, company confirmation, pair, reason and exact commit revision", async () => {
  const mutations: Array<(value: ReconciliationReceipt) => void> = [
    value => { value.revision++; }, value => { value.decision.revision++; }, value => { value.decision.reason = "Other reason"; },
    value => { if (value.decision.kind === "merge") [value.decision.targetJobId, value.decision.sourceJobId] = [value.decision.sourceJobId, value.decision.targetJobId]; },
    value => { if (value.decision.kind === "merge") value.decision.companyIdentityConfirmed = false; },
    value => { if (value.decision.kind === "merge") value.decision.candidate.snapshotRevision--; },
    value => { if (value.decision.kind === "merge") value.decision.candidate.leftJobId = "unrelated-job"; },
  ];
  for (const mutate of mutations) {
    const value = receipt(); mutate(value); assert.equal(ReconciliationReceiptSchema.safeParse(value).success, true);
    installFetch(() => response(value)); await assert.rejects(client().mergeJobs(command, { idempotencyKey: "synthetic-key" }), invalidResponse); mock.restoreAll();
  }
  installFetch(() => response(receipt("reject"))); await assert.rejects(client().mergeJobs(command, { idempotencyKey: "synthetic-key" }), invalidResponse); mock.restoreAll();
  installFetch(() => response(receipt())); await assert.rejects(client().rejectMerge(command, { idempotencyKey: "synthetic-key" }), invalidResponse); mock.restoreAll();
  const wrongRevoke = receipt("revoke"); if (wrongRevoke.decision.kind === "revoke") wrongRevoke.decision.targetDecisionId = "other-decision";
  installFetch(() => response(wrongRevoke)); await assert.rejects(client().revokeMerge(revokeCommand, { idempotencyKey: "synthetic-key" }), invalidResponse);
});

test("valid historical aliases remain usable without confusing sorted rejection with merge direction", async () => {
  const aliased = { ...command, targetJobId: "old-target-alias", sourceJobId: "old-source-alias" };
  const aliasQuery = { ...query, targetJobId: aliased.targetJobId, sourceJobId: aliased.sourceJobId };
  const aliasedPreview = preview(); aliasedPreview.input = aliasQuery;
  aliasedPreview.target.requestedJobId = aliased.targetJobId; aliasedPreview.source.requestedJobId = aliased.sourceJobId;
  installFetch(() => response(aliasedPreview)); assert.deepEqual(await client().previewMerge(aliasQuery), aliasedPreview); mock.restoreAll();
  const merge = receipt(); merge.aliases.push({ jobId: aliased.targetJobId, canonicalJobId: targetJobId }, { jobId: aliased.sourceJobId, canonicalJobId: targetJobId });
  installFetch(() => response(merge)); assert.deepEqual(await client().mergeJobs(aliased, { idempotencyKey: "synthetic-alias-key" }), merge); mock.restoreAll();
  const reject = receipt("reject"); reject.aliases.push({ jobId: aliased.targetJobId, canonicalJobId: targetJobId }, { jobId: aliased.sourceJobId, canonicalJobId: sourceJobId });
  installFetch(() => response(reject)); assert.deepEqual(await client().rejectMerge(aliased, { idempotencyKey: "synthetic-alias-key" }), reject);
  assert.deepEqual(await client().rejectMerge({ ...command, targetJobId: sourceJobId, sourceJobId: targetJobId }, { idempotencyKey: "synthetic-reverse-reject-key" }), reject);
});

test("lost write acknowledgement can replay the exact old request and key through a fresh client", async () => {
  let attempts = 0;
  const calls = installFetch(() => { if (++attempts === 1) throw new TypeError("Synthetic response lost after commit"); return response(receipt()); });
  const original = structuredClone(command), options = { idempotencyKey: "synthetic-replay-key" };
  await assert.rejects(client().mergeJobs(original, options), (error: unknown) => error instanceof AtlasSourceServiceError && error.code === "transport-error");
  // An unrelated later index revision is deliberately absent from the retry contract.
  assert.deepEqual(await client().mergeJobs(original, options), receipt());
  assert.equal(calls.length, 2); assert.equal(calls[1]!.init?.body, calls[0]!.init?.body); assert.equal(calls[1]!.key, calls[0]!.key);
  assert.deepEqual(original, command);
});

test("revoke preview binds original decision, reason, revision and both source projections", async () => {
  const mutations: Array<(value: RevokeMergeReviewPreview) => void> = [
    value => { value.input.reason = "Other reason"; }, value => { value.expectedRevision++; }, value => { value.snapshotRevision++; },
    value => { value.input.expectedRevision++; }, value => { value.decision.id = "other-decision"; },
    value => { value.decision = receipt("revoke").decision; }, value => { value.before[0]!.canonicalJobId = "unrelated-job"; },
    value => { value.after[0]!.listings = []; },
    value => { value.counts.beforeJobs++; }, value => { value.counts.afterJobs++; },
    value => { value.before.push(structuredClone(value.before[0]!)); value.counts.beforeJobs = 2; },
    value => { value.after[1] = structuredClone(value.after[0]!); },
    value => { value.before = []; value.counts.beforeJobs = 0; }, value => { value.after = []; value.counts.afterJobs = 0; },
  ];
  for (const mutate of mutations) {
    const result = revokePreview(); mutate(result); assert.equal(RevokeMergeReviewPreviewSchema.safeParse(result).success, true);
    installFetch(() => response(result)); await assert.rejects(client().previewRevokeMerge(revokeQuery), invalidResponse); mock.restoreAll();
  }
});

test("strict output envelopes and service errors never expose private response text", async () => {
  for (const value of [{ ...preview(), privateToken: "PRIVATE_RESPONSE" }, { ...preview(), target: { ...preview().target, homeAddress: "PRIVATE_RESPONSE" } }]) {
    installFetch(() => response(value));
    await assert.rejects(client().previewMerge(query), (error: unknown) => invalidResponse(error) && !(error as Error).message.includes("PRIVATE_RESPONSE")); mock.restoreAll();
  }
  installFetch(() => new Response(JSON.stringify({ ok: false, requestId: "synthetic-error", error: { code: "stale-version", message: "PRIVATE_RESPONSE" } }), { status: 409 }));
  await assert.rejects(client().mergeJobs(command, { idempotencyKey: "synthetic-key" }), (error: unknown) => error instanceof AtlasSourceServiceError
    && error.code === "stale-version" && error.status === 409 && !error.message.includes("PRIVATE_RESPONSE"));
});

test("reconciliation never sends a token to an external endpoint, path, credential URL or missing-token connection", async () => {
  const calls = installFetch(() => response(candidates()));
  for (const endpoint of ["https://external.example", "http://localhost/path", "http://user:pass@localhost", "http://127.0.0.1/?query=x"]) {
    await assert.rejects(createAtlasSourceClient(endpoint, "synthetic").listMergeCandidates(), AtlasClientError);
  }
  await assert.rejects(createAtlasSourceClient("http://127.0.0.1", " ").listMergeCandidates(), AtlasClientError); assert.equal(calls.length, 0);
});

test("reconciliation shares bounded response streaming, abort propagation and redirect refusal", async () => {
  let cancelled = false;
  mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new TextEncoder().encode("中文")); }, cancel() { cancelled = true; } })));
  await assert.rejects(client().listMergeCandidates({}, { maxBytes: 8 }), (error: unknown) => error instanceof AtlasSourceServiceError && error.code === "too-large");
  assert.equal(cancelled, true); mock.restoreAll();
  const controller = new AbortController(); cancelled = false;
  mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(init?.signal, controller.signal);
    return new Response(new ReadableStream({ start() { queueMicrotask(() => controller.abort(new DOMException("synthetic cancelled", "AbortError"))); }, cancel() { cancelled = true; } }));
  });
  await assert.rejects(client().previewMerge(query, { signal: controller.signal }), { name: "AbortError" }); assert.equal(cancelled, true); mock.restoreAll();
  const redirected = response(preview()); Object.defineProperty(redirected, "redirected", { value: true });
  mock.method(globalThis, "fetch", async () => redirected);
  await assert.rejects(client().previewMerge(query), (error: unknown) => error instanceof AtlasSourceServiceError && error.code === "http-error");
});
