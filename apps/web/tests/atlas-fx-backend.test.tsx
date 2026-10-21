import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";
import { createAtlasBackendMiddleware } from "../server/atlas-backend.js";

test("FX gateway exposes only five fixed POST tools and keeps host credentials on the server", async () => {
  const token = "f".repeat(64);
  let calls = 0;
  const middleware = createAtlasBackendMiddleware({
    env: { BETTERME_JOB_SERVICE_TOKEN_FILE: path.join(tmpdir(), "synthetic-fx", "service.token") }, readTokenFile: async () => token,
    fetcher: async (input, init) => {
      calls++; assert.match(String(input), /^http:\/\/127\.0\.0\.1:5178\/api\/v1\/fx\/(state|preview|import|activate|reference)$/);
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`);
      assert.equal(new Headers(init?.headers).get("origin"), "http://localhost:5173");
      assert.equal(init?.method, "POST"); return Response.json({ ok: true, data: {} });
    },
  });
  const server = createServer((request, response) => { void middleware(request, response, () => { response.writeHead(404); response.end(); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const route of ["state", "preview", "import", "activate", "reference"]) {
      const url = `${origin}/api/atlas/api/v1/fx/${route}`;
      assert.equal((await fetch(url, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" })).status, 200);
      assert.equal((await fetch(url, { headers: { Origin: origin } })).status, 404);
      assert.equal((await fetch(url + "?target=https://evil.example", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" })).status, 404);
    }
    assert.equal(calls, 5);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
