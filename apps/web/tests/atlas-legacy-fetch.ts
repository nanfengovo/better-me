import { mock } from "node:test";

/** Existing receipt/CAS fixtures model pre-browse services. An unsupported new
 * display endpoint must explicitly answer 404, never a malformed success body.
 * New browse and real-service integration tests use the new protocol directly. */
export function mockLegacyAtlasFetch(implementation: typeof fetch) {
  return mock.method(globalThis, "fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : String(input), "http://synthetic-legacy.invalid").pathname;
    return path === "/api/v1/atlas/browse"
      ? Promise.resolve(new Response(null, { status: 404 }))
      : implementation(input, init);
  });
}
