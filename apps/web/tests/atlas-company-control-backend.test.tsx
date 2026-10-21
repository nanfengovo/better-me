import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";
import { createAtlasBackendMiddleware } from "../server/atlas-backend.js";

test("company control review forwards only the four fixed tools with server-held credentials and write identity", async () => {
  const token = "c".repeat(64);
  const seen: string[] = [];
  const middleware = createAtlasBackendMiddleware({
    env: { BETTERME_JOB_SERVICE_TOKEN_FILE: path.join(tmpdir(), "synthetic-company-control", "service.token") },
    readTokenFile: async () => token,
    fetcher: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, "http://127.0.0.1:5178");
      assert.match(url.pathname, /^\/api\/v1\/companies\/control-review\/(read|preview|confirm|revoke)$/);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), `Bearer ${token}`);
      assert.equal(headers.get("origin"), "http://localhost:5173");
      assert.equal(init?.method, "POST");
      if (url.pathname.endsWith("confirm") || url.pathname.endsWith("revoke")) assert.equal(headers.get("idempotency-key"), "synthetic-control-write");
      assert.deepEqual(JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)), { companyId: "synthetic.company", expectedRevision: 7 });
      seen.push(url.pathname);
      return Response.json({ ok: true, requestId: "synthetic-control", value: { revision: 7 } });
    },
  });
  const server = createServer((request, response) => { void middleware(request, response, () => { response.writeHead(404); response.end(); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const body = JSON.stringify({ companyId: "synthetic.company", expectedRevision: 7 });
  const headers = { Origin: origin, "Content-Type": "application/json", "Idempotency-Key": "synthetic-control-write" };
  try {
    for (const route of ["read", "preview", "confirm", "revoke"]) {
      const url = `${origin}/api/atlas/api/v1/companies/control-review/${route}`;
      const response = await fetch(url, { method: "POST", headers, body });
      assert.equal(response.status, 200);
      assert.equal((await response.text()).includes(token), false);
      assert.equal((await fetch(url, { headers: { Origin: origin } })).status, 404);
      assert.equal((await fetch(url + "?company=other", { method: "POST", headers, body })).status, 404);
    }
    for (const route of ["import", "fetch", "delete", "../confirm", "confirm/arbitrary"]) {
      assert.equal((await fetch(`${origin}/api/atlas/api/v1/companies/control-review/${route}`, { method: "POST", headers, body })).status, 404);
    }
    assert.equal(seen.length, 4);
    assert.equal((await fetch(`${origin}/api/atlas/api/v1/companies/control-review/read`, { method: "POST", headers: { ...headers, Origin: "https://other.example" }, body })).status, 403);
    assert.equal(seen.length, 4);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
