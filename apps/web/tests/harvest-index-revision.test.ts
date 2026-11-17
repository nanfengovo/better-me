import assert from "node:assert/strict";
import test from "node:test";
import { createAtlasSourceClient } from "../src/components/atlas/service-client";

test("CAS revision reuses the authenticated metadata GET without exporting jobs or starting enrichment", async () => {
  const previous = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    assert.equal(new URL(String(url)).pathname, "/api/v1/enrichment/status");
    assert.equal(init?.method, "GET");
    assert.equal(init?.body, undefined);
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer synthetic-token");
    return Response.json({ ok: true, requestId: "metadata-test", value: { revision: 7, pending: 2, workerState: "idle" } });
  };
  try {
    assert.deepEqual(await createAtlasSourceClient("http://127.0.0.1:5178", "synthetic-token").indexRevision(), { revision: 7 });
    assert.equal(calls.length, 1);
  } finally { globalThis.fetch = previous; }
});

for (const value of [-1, "7", Number.MAX_SAFE_INTEGER + 1]) test(`invalid metadata revision ${value} fails closed`, async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ ok: true, requestId: "bad-metadata", value: { revision: value } });
  try { await assert.rejects(createAtlasSourceClient("http://127.0.0.1:5178", "synthetic-token").indexRevision(), /契约/); }
  finally { globalThis.fetch = previous; }
});
