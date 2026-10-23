import assert from "node:assert/strict";
import test, { after, afterEach, mock } from "node:test";
import { createAtlasLeadClient } from "../src/components/atlas/lead-client.ts";
import { AtlasSourceServiceError } from "../src/components/atlas/service-client.ts";
import { leadCapture, leadImport, leadItem, leadPreview, leadQuery, leadRead, leadReceipt } from "./fixtures/atlas-leads.ts";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "https://synthetic-workbench.invalid" } } });
const response = (value: unknown, status = 200) => new Response(JSON.stringify({ ok: true, requestId: "synthetic-lead-client", value }), { status });
const fails = (code: string) => (problem: unknown) => problem instanceof AtlasSourceServiceError && problem.code === code;
afterEach(() => mock.restoreAll());
after(() => { if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window"); });

test("lead tools use fixed same-origin POST routes and host authentication stays out of the browser", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init: RequestInit) => { calls.push({ url: String(url), init }); return response(calls.length === 1 ? leadQuery : leadRead); });
  const client = createAtlasLeadClient("/api/atlas", "");
  assert.equal((await client.query({ search: "  Synthetic  ", limit: 50 })).totalLeads, 1);
  await client.read({ leadId: leadItem.lead.id, expectedRevision: 7 });
  assert.deepEqual(calls.map(call => call.url), ["query", "read"].map(route => `https://synthetic-workbench.invalid/api/atlas/api/v1/leads/${route}`));
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { search: "Synthetic", limit: 50 });
  for (const { init } of calls) { assert.equal(init.method, "POST"); assert.equal(init.credentials, "omit"); assert.equal(init.redirect, "error"); assert.equal(new Headers(init.headers).get("Authorization"), null); }
});

test("lead input rejects arbitrary URLs and malformed IDs before dispatch, and local reads bind identity and revision", async () => {
  const fetcher = mock.method(globalThis, "fetch", async () => response({ ...leadRead, snapshotRevision: 8 }));
  const client = createAtlasLeadClient("http://127.0.0.1:5178", "synthetic-token");
  await assert.rejects(client.query({ limit: 50, url: "https://unreviewed.invalid" } as any), fails("invalid-input"));
  await assert.rejects(client.read({ leadId: "../other" }), fails("invalid-input")); assert.equal(fetcher.mock.callCount(), 0);
  await assert.rejects(client.read({ leadId: leadItem.lead.id, expectedRevision: 7 }), fails("invalid-response"));
  assert.equal(new Headers(fetcher.mock.calls[0]!.arguments[1]!.headers).get("Authorization"), "Bearer synthetic-token");
});

test("original reads and previews reject unrelated capture identities or listing ownership", async () => {
  const client = createAtlasLeadClient("/api/atlas", ""); let value: unknown = { ...leadCapture, leadDigest: "9".repeat(64) };
  mock.method(globalThis, "fetch", async () => response(value));
  await assert.rejects(client.readOriginal({ leadId: leadItem.lead.id, leadDigest: leadItem.leadDigest, originalSourceId: leadCapture.originalSourceId, expectedRevision: 7 }), fails("invalid-response"));
  value = { ...leadPreview, listings: [{ ...leadPreview.listings[0], canonicalJobId: "another-job" }] };
  await assert.rejects(client.previewOriginal({ capture: leadCapture, expectedRevision: 7 }), fails("invalid-response"));
  value = leadPreview; assert.equal((await client.previewOriginal({ capture: leadCapture, expectedRevision: 7 })).job.id, leadPreview.job.id);
});

test("import checks the canonical job receipt and preserves the exact body plus idempotency key", async () => {
  const calls: RequestInit[] = []; let value: unknown = leadReceipt;
  mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init: RequestInit) => { calls.push(init); return response(value); });
  const client = createAtlasLeadClient("/api/atlas", "");
  const options = { idempotencyKey: "synthetic-original-key", jobId: leadPreview.job.id };
  assert.equal((await client.importOriginal(leadImport, options)).revision, 8);
  value = { ...leadReceipt, jobIds: ["wrong-canonical-job"] };
  await assert.rejects(client.importOriginal(leadImport, options), fails("invalid-response"));
  assert.equal(calls[1]!.body, calls[0]!.body); assert.deepEqual(JSON.parse(String(calls[0]!.body)), leadImport);
  assert.equal(new Headers(calls[0]!.headers).get("Idempotency-Key"), options.idempotencyKey);
});

test("typed source-changed is retained while a legacy HTML 404 is an upgrade error", async () => {
  let reply = new Response(JSON.stringify({ ok: false, requestId: "synthetic-sourcechange", error: { code: "source-changed", message: "Synthetic changed lead" } }), { status: 404 });
  mock.method(globalThis, "fetch", async () => reply);
  const client = createAtlasLeadClient("/api/atlas", "");
  await assert.rejects(client.read({ leadId: leadItem.lead.id }), fails("source-changed"));
  reply = new Response("<p>Not found</p>", { status: 404 });
  await assert.rejects(client.query({ limit: 50 }), problem => fails("http-error")(problem) && (problem as Error).message.includes("重启"));
});

test("stream budgets, invalid UTF-8 and aborts never become successful lead results", async () => {
  let reply = response(leadQuery); const fetcher = mock.method(globalThis, "fetch", async () => reply);
  const client = createAtlasLeadClient("/api/atlas", "");
  await assert.rejects(client.query({ limit: 50 }, { maxBytes: 16 }), fails("too-large"));
  reply = new Response(new Uint8Array([0xc3, 0x28]));
  await assert.rejects(client.query({ limit: 50 }), fails("invalid-response"));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.query({ limit: 50 }, { signal: controller.signal }), { name: "AbortError" }); assert.equal(fetcher.mock.callCount(), 2);
});
