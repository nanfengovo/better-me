import assert from "node:assert/strict";
import test from "node:test";
import { ToolError, buildFxReferenceSnapshot, type ToolHandlerContext } from "@better-me/opportunities";
import { createFxReferenceProvider, FxReferenceProviderConfigSchema } from "../src/fx-reference.js";
import { SourceTransportError } from "../src/transport.js";
import type { SourceTransport, SourceTransportResponse } from "../src/contracts.js";

const now = "2026-10-21T09:00:00.000Z";
const raw = '{"amount":1.0,"base":"EUR","date":"2026-10-20","rates":{"CNY":8,"USD":1.25,"GBP":0.8}}';
const rawV2 = '[{"date":"2026-10-20","base":"EUR","quote":"CNY","rate":8},{"date":"2026-10-20","base":"EUR","quote":"USD","rate":1.25}]';
function fixture(respond: (input: Parameters<SourceTransport["request"]>[0]) => Partial<SourceTransportResponse> | Promise<Partial<SourceTransportResponse>> = () => ({ text: rawV2 })) {
  const requests: Parameters<SourceTransport["request"]>[0][] = [];
  const controller = new AbortController();
  const context: ToolHandlerContext = { requestId: "synthetic-fx", actorScope: "local", signal: controller.signal,
    budget: { requests: 2, bytes: 262144, timeoutMs: 1000 }, consumeRequests() {}, consumeBytes() {},
    throwIfCancelled() { if (controller.signal.aborted) throw new ToolError("cancelled"); } };
  const transport: SourceTransport = { async request(input) { requests.push(input); return {
    status: 200, url: input.url, headers: { "content-type": "application/json" }, text: "", ...await respond(input),
  }; } };
  return { requests, controller, context, transport };
}
const code = (value: string) => (error: unknown) => error instanceof ToolError && error.code === value;

test("reference provider reads only on explicit execution and preserves raw evidence without activating anything", async () => {
  const run = fixture();
  const provider = createFxReferenceProvider(run.transport, undefined, { now: () => now });
  assert.equal(run.requests.length, 0);
  const draft = await provider.read(run.context);
  assert.equal(run.requests.length, 1); assert.equal(draft.raw, rawV2); assert.equal(draft.retrievedAt, now);
  const request = run.requests[0]!;
  assert.equal(request.url, "https://api.frankfurter.dev/v2/rates?providers=ECB");
  assert.deepEqual(request.source.endpointPolicy.allowedHosts, ["api.frankfurter.dev"]);
  assert.deepEqual(request.source.endpointPolicy.allowedPathPrefixes, ["/v2/rates"]);
  assert.equal(request.source.endpointPolicy.allowRedirects, false);
  assert.deepEqual(request.headers, { accept: "application/json" });
  const snapshot = await buildFxReferenceSnapshot(draft, { now });
  assert.equal(snapshot.fx.ratesToCny.USD, 6.4); assert.equal(snapshot.fx.ratesToCny.EUR, 8);
  assert.equal(snapshot.provenance, "manual-import");
});

test("host may install another EUR reference JSON provider but callers cannot select URLs", async () => {
  const run = fixture(() => ({ text: raw }));
  const draft = await createFxReferenceProvider(run.transport, { provider: "Synthetic reference", endpoint: "https://rates.example.com/latest.json", format: "eur-reference-json-v1" }, { now: () => now }).read(run.context);
  assert.equal(draft.sourceUrl, "https://rates.example.com/latest.json");
  assert.deepEqual(run.requests[0]!.source.endpointPolicy.allowedHosts, ["rates.example.com"]);
  for (const endpoint of ["http://rates.example.com/latest", "https://127.0.0.1/latest", "https://user:secret@rates.example.com/latest", "https://rates.example.com/latest?key=secret", "https://rates.example.com/latest#secret", "https://rates.example.com:444/latest", "https://rates.internal/latest"]) {
    assert.equal(FxReferenceProviderConfigSchema.safeParse({ provider: "Synthetic", endpoint, format: "eur-reference-json-v1" }).success, false, endpoint);
  }
});

test("malformed, future and non-EUR responses remain source failures without raw-body errors", async () => {
  for (const response of [{ status: 403 }, { url: "https://other.example.com/latest" }, { text: "private-response-secret" },
    { text: rawV2.replace('"EUR"', '"USD"') }, { text: rawV2.replaceAll("2026-10-20", "2026-10-22") }, { text: rawV2.replace('"CNY"', '"CAD"') }, { text: rawV2.replace('"2026-10-20"', '"2026-10-19"') }]) {
    const run = fixture(() => response);
    await assert.rejects(createFxReferenceProvider(run.transport, undefined, { now: () => now }).read(run.context), code("source-changed"));
  }
});

test("provider preserves transport rate limits and cancellation instead of manufacturing a snapshot", async () => {
  for (const [transportCode, expected] of [["rate-limited", "rate-limited"], ["timeout", "timeout"], ["response-too-large", "budget-exceeded"], ["unsafe-endpoint", "source-changed"]] as const) {
    const run = fixture(() => { throw new SourceTransportError(transportCode); });
    await assert.rejects(createFxReferenceProvider(run.transport).read(run.context), code(expected));
  }
  const run = fixture(); run.controller.abort();
  await assert.rejects(createFxReferenceProvider(run.transport).read(run.context), code("cancelled"));
  assert.equal(run.requests.length, 0);
  const late = fixture(async () => { late.controller.abort(); return { text: rawV2 }; });
  await assert.rejects(createFxReferenceProvider(late.transport).read(late.context), code("cancelled"));
});
