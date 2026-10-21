import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import { createAtlasSourceClient, AtlasSourceServiceError } from "../src/components/atlas/service-client.ts";
import { fxDraft, fxPreview, fxReceipt, fxState } from "./fixtures/atlas-fx.ts";
const respond = (value: unknown) => new Response(JSON.stringify({ ok: true, requestId: "synthetic-fx-client", value }));
const client = () => createAtlasSourceClient("http://127.0.0.1:5178", "synthetic-fx-client-token");
afterEach(() => mock.restoreAll());

test("FX client uses strict authenticated POST routes and binds state, preview and durable mutation receipts", async () => {
  const calls: { path: string; body: unknown; key: string | null }[] = [];
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init: RequestInit) => {
    const path = new URL(String(url)).pathname; calls.push({ path, body: JSON.parse(String(init.body)), key: new Headers(init.headers).get("Idempotency-Key") });
    assert.equal(init.method, "POST"); assert.equal(init.credentials, "omit"); assert.equal(new Headers(init.headers).get("Authorization"), "Bearer synthetic-fx-client-token");
    return respond(path.endsWith("/state") ? fxState() : path.endsWith("/reference") ? fxDraft : path.endsWith("/preview") ? fxPreview : fxReceipt);
  });
  assert.deepEqual(await client().readFxState({ expectedRevision: 1 }), fxState());
  assert.deepEqual(await client().fetchFxReference(), fxDraft);
  assert.deepEqual(await client().previewFxImport({ draft: fxDraft, expectedRevision: 1 }), fxPreview);
  const input = { draft: fxDraft, expectedRevision: 1, previewFingerprint: fxPreview.previewFingerprint, reviewed: true as const, activate: true };
  await client().importFxSnapshot(input, { idempotencyKey: "fx-import-synthetic" });
  await client().activateFxSnapshot({ snapshotId: fxReceipt.snapshotId, expectedRevision: 1, reviewed: true }, { idempotencyKey: "fx-activate-synthetic" });
  assert.deepEqual(calls.map(value => value.path), ["/api/v1/fx/state", "/api/v1/fx/reference", "/api/v1/fx/preview", "/api/v1/fx/import", "/api/v1/fx/activate"]);
  assert.equal(calls[3]!.key, "fx-import-synthetic"); assert.deepEqual(calls[3]!.body, input);
});

test("FX state rejects an old revision and raw/rate/hash tampering despite a valid envelope", async () => {
  for (const value of [fxState(2), { ...fxState(), snapshots: [{ ...fxPreview.snapshot, fx: { ...fxPreview.snapshot.fx, ratesToCny: { CNY: 1, USD: 99, EUR: 8 } } }] }]) {
    mock.method(globalThis, "fetch", async () => respond(value));
    await assert.rejects(client().readFxState({ expectedRevision: 1 }), error => error instanceof AtlasSourceServiceError && error.code === "invalid-response"); mock.restoreAll();
  }
});

test("a preview for different source text or an unbound mutation receipt remains untrusted", async () => {
  mock.method(globalThis, "fetch", async () => respond({ ...fxPreview, snapshot: { ...fxPreview.snapshot, sourceUrl: "https://other.example.invalid/reference" } }));
  await assert.rejects(client().previewFxImport({ draft: fxDraft, expectedRevision: 1 }), /汇率预览/); mock.restoreAll();
  mock.method(globalThis, "fetch", async () => respond({ ...fxReceipt, activeSnapshotId: null }));
  await assert.rejects(client().importFxSnapshot({ draft: fxDraft, expectedRevision: 1, previewFingerprint: fxPreview.previewFingerprint, reviewed: true, activate: true }, { idempotencyKey: "fx-bad-receipt" }), /沿用原请求/);
});

test("an old backend produces an explicit upgrade error and never a fake successful FX configuration", async () => {
  mock.method(globalThis, "fetch", async () => new Response("<html>old backend</html>", { status: 404 }));
  await assert.rejects(client().readFxState({ expectedRevision: 1 }), error => error instanceof AtlasSourceServiceError && error.status === 404 && /升级|更新/.test(error.message));
});
