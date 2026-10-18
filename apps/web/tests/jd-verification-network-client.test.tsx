import assert from "node:assert/strict";
import test from "node:test";
import { inspectJdBrowserSession, type JdBrowserSession } from "../src/lib/jd-import.ts";
import { JdExtractionError } from "../src/lib/jd-errors.ts";
import { readVerificationNetworkSnapshot } from "../src/lib/jd-verification-network.ts";

const host = "device.captcha-open.aliyuncs.com";
const trace = () => ({ requests: [{ id: 1, host, type: "xhr" }], events: [{ requestId: 1, phase: "request", atMs: 0 }, { requestId: 1, phase: "response", atMs: 31, status: 200 }, { requestId: 1, phase: "finished", atMs: 32 }], truncated: false });
const session: JdBrowserSession = { sessionId: "verification-client-fixture-session", platform: "51JOB", url: "https://jobs.51job.com/shanghai/166509900.html", expiresAt: new Date(Date.now() + 600_000).toISOString() };
const inspection = () => ({ snapshotState: "ready", pageState: "unknown", pageLoad: { readyState: "complete", content: "visible_text", visibleFrames: 0 }, scriptErrors: 0, mainDocument: { state: "response", status: 200 }, mainDocumentRequests: 1, gate: "verification_required", resources: [], truncated: false, blockedPopups: 0, blockedSockets: 0 });

test("51job verification network client preserves fixed transport events and discards nested secrets", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const network = trace();
    globalThis.fetch = async () => new Response(JSON.stringify({ ...inspection(), verificationNetwork: { ...network, body: "private", requests: network.requests.map(item => ({ ...item, url: "https://private.test/?token=secret", headers: { Cookie: "secret" } })), events: network.events.map(item => ({ ...item, responseBody: "private" })) } }));
    const observed = await inspectJdBrowserSession(session, new AbortController().signal);
    assert.deepEqual(observed.verificationNetwork, network);
    assert.equal(observed.gate, "verification_required");
    assert.equal(JSON.stringify(observed).includes("secret"), false);
    globalThis.fetch = async () => new Response(JSON.stringify(inspection()));
    assert.equal(Object.hasOwn(await inspectJdBrowserSession(session, new AbortController().signal), "verificationNetwork"), false);
    for (const verificationNetwork of [null, {}, { ...network, truncated: "false" }, { ...network, requests: [{ id: 1, host: "other.aliyuncs.com", type: "xhr" }] }, { ...network, events: [{ requestId: 1, phase: "passed", atMs: 1 }] }]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ ...inspection(), verificationNetwork }));
      await assert.rejects(inspectJdBrowserSession(session, new AbortController().signal), (error: unknown) => error instanceof JdExtractionError && error.failure.code === "service_unavailable");
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("verification transport schema rejects impossible event chains and makes an independent safe copy", () => {
  const valid = trace();
  assert.deepEqual(readVerificationNetworkSnapshot(valid), valid);
  const invalid = [
    { ...valid, requests: [{ id: 2, host, type: "xhr" }] },
    { ...valid, requests: [{ id: 1, host: `${host}.evil.test`, type: "xhr" }] },
    { ...valid, requests: [{ id: 1, host, type: "websocket" }] },
    { ...valid, events: [valid.events[1]] },
    { ...valid, events: [...valid.events, valid.events[1]] },
    { ...valid, events: [...valid.events.slice(0, 2), { requestId: 1, phase: "response", atMs: 32, status: 200 }] },
    { ...valid, events: [{ requestId: 1, phase: "request", atMs: -1 }] },
    { ...valid, events: [{ requestId: 1, phase: "request", atMs: 86_400_001 }] },
    { ...valid, events: [valid.events[0], { requestId: 1, phase: "failed", atMs: 1, status: 403 }] },
    { ...valid, events: [valid.events[0], { requestId: 1, phase: "response", atMs: 1, status: 600 }] },
    { ...valid, events: [valid.events[0], valid.events[1], { requestId: 1, phase: "finished", atMs: 1 }] },
  ];
  for (const value of invalid) assert.equal(readVerificationNetworkSnapshot(value), undefined);
  const safe = readVerificationNetworkSnapshot(valid)!;
  safe.events[1].status = 403;
  safe.requests[0].host = "changed.invalid";
  assert.deepEqual(readVerificationNetworkSnapshot(valid), valid);
  assert.ok(readVerificationNetworkSnapshot({ requests: [], events: [], truncated: false }));
  assert.ok(readVerificationNetworkSnapshot({ ...valid, events: [valid.events[0], { requestId: 1, phase: "failed", atMs: 12 }] }));
});
