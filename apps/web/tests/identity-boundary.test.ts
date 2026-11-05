import assert from "node:assert/strict";
import test, { after, afterEach, mock } from "node:test";
import { Window } from "happy-dom";
import { activatePrincipal, invalidateIdentity, captureIdentity, ownedFetch, privateStorage, capturePrivateStorage, ownerDatabase, privateStorageEvent, IdentityBoundaryError } from "../src/lib/identity";
import { createOwnedRecords } from "../src/services/owned-records";
import { emptyAgentState } from "../src/lib/betterme-agent/storage";
import { mergeAgentBackup } from "../src/lib/betterme-agent/backup";
import { sendAgentChat, startJdMatch, resumeJdMatch, streamLocalAgentRun } from "../src/services/agent-client";
import { createUnderstandingClient } from "../src/services/understanding-client";
import { createChatGptClient } from "../src/services/chatgpt-client";

const dom = new Window({ url: "http://identity-fixture.invalid" });
const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.localStorage });
const alice = { id: "11111111-1111-4111-8111-111111111111", username: "alice", displayName: "Alice" };
const bob = { id: "22222222-2222-4222-8222-222222222222", username: "bob", displayName: "Bob" };
const config = { provider: "openai-compatible" as const, model: "fixture", baseUrl: "https://paid-provider.invalid/v1", apiKey: "not-a-real-key", temperature: 0 };
afterEach(() => { mock.restoreAll(); activatePrincipal(undefined); dom.localStorage.clear(); });
after(() => { dom.happyDOM.abort(); if (original) Object.defineProperty(globalThis, "localStorage", original); else Reflect.deleteProperty(globalThis, "localStorage"); });

test("private browser keys and history databases isolate equal names without claiming legacy data or changing autosave", () => {
  dom.localStorage.setItem("same", "legacy must stay"); dom.localStorage.setItem("better-me:auto-save:v1", '{"enabled":false}');
  activatePrincipal(alice); const captured = capturePrivateStorage(), databaseA = ownerDatabase("history");
  assert.equal(privateStorage.getItem("same"), null); privateStorage.setItem("same", "A-secret");
  activatePrincipal(bob); assert.equal(privateStorage.getItem("same"), null); privateStorage.setItem("same", "B-secret");
  captured.setItem("late", "A-late"); assert.equal(privateStorage.getItem("late"), null);
  assert.notEqual(ownerDatabase("history"), databaseA);
  assert.equal(privateStorageEvent({ key: `betterme.owner.v1:${alice.id}:same`, newValue: "A", storageArea: dom.localStorage }), undefined);
  assert.deepEqual(privateStorageEvent({ key: `betterme.owner.v1:${bob.id}:same`, newValue: "B", storageArea: dom.localStorage }), { key: "same", newValue: "B" });
  activatePrincipal(alice); assert.equal(privateStorage.getItem("same"), "A-secret"); assert.equal(privateStorage.getItem("late"), "A-late");
  assert.equal(dom.localStorage.getItem("same"), "legacy must stay"); assert.equal(dom.localStorage.getItem("better-me:auto-save:v1"), '{"enabled":false}');
});

test("private requests use HttpOnly credentials plus expected owner and refuse late headers", async () => {
  activatePrincipal(alice);
  let finish!: (response: Response) => void, options: RequestInit | undefined;
  const pending = ownedFetch("http://fixture.invalid", {}, async (_url, init) => { options = init; return new Promise(resolve => { finish = resolve; }); });
  assert.equal(options?.credentials, "include"); assert.equal(new Headers(options?.headers).get("X-BetterMe-Owner"), alice.id);
  activatePrincipal(bob); assert.equal(options?.signal?.aborted, true);
  finish(Response.json({ secret: "A" })); await assert.rejects(pending, IdentityBoundaryError);
});

test("a locked identity cannot start another private request even when the transport ignores abort", async () => {
  activatePrincipal(alice); invalidateIdentity();
  let requests = 0;
  await assert.rejects(ownedFetch("http://fixture.invalid", {}, async () => {
    requests++; return Response.json({ secret: "A-after-lock" });
  }), IdentityBoundaryError);
  assert.equal(requests, 0, "locked pages must stop before submitting private work");
  assert.throws(captureIdentity(), IdentityBoundaryError);
});

test("a body resolving after account change cannot enter the next user's memory", async () => {
  activatePrincipal(alice); let finish!: (value: Uint8Array) => void;
  const body = new ReadableStream<Uint8Array>({ async pull(controller) { const bytes = await new Promise<Uint8Array>(resolve => { finish = resolve; }); controller.enqueue(bytes); controller.close(); } });
  const response = await ownedFetch("http://fixture.invalid", {}, async () => new Response(body));
  const reading = response.json(); activatePrincipal(bob);
  finish(new TextEncoder().encode('{"secret":"A-late"}')); await assert.rejects(reading, IdentityBoundaryError);
});

test("cloning a private response cannot bypass the late-body identity boundary", async () => {
  activatePrincipal(alice); let finish!: (value: Uint8Array) => void;
  const body = new ReadableStream<Uint8Array>({ async pull(controller) {
    const bytes = await new Promise<Uint8Array>(resolve => { finish = resolve; }); controller.enqueue(bytes); controller.close();
  } });
  const response = await ownedFetch("http://fixture.invalid", {}, async () => new Response(body));
  const reading = response.clone().json();
  activatePrincipal(bob);
  finish(new TextEncoder().encode('{"secret":"A-cloned-late"}'));
  await assert.rejects(reading, IdentityBoundaryError);
  void response.body?.cancel().catch(() => undefined);
});

test("a previous account's late denial cannot invalidate the newly authenticated account", async () => {
  activatePrincipal(alice);
  const reading = Promise.withResolvers<void>();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const denied = new Response(null, { status: 409 });
  mock.method(denied, "clone", () => {
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    reading.resolve(); return new Response(body, { status: 409 });
  });
  const pending = ownedFetch("http://fixture.invalid", {}, async () => denied);
  await reading.promise;
  activatePrincipal(bob); const assertBob = captureIdentity();
  controller.enqueue(new TextEncoder().encode('{"error":"identity_changed"}')); controller.close();
  await assert.rejects(pending, IdentityBoundaryError);
  assert.doesNotThrow(assertBob, "a stale Alice response must not lock Bob's active identity");
  const response = await ownedFetch("http://fixture.invalid", {}, async () => Response.json({ owner: bob.id }));
  assert.deepEqual(await response.json(), { owner: bob.id });
});

test("owner records capture identity, reject a mismatched server envelope and never reuse old data", async () => {
  activatePrincipal(alice); const a = createOwnedRecords("continuity");
  let requests = 0;
  mock.method(globalThis, "fetch", async () => { requests++; return Response.json({ ownerId: bob.id, revision: 1, value: { secret: "B" } }); });
  await assert.rejects(a.load("same")); activatePrincipal(bob);
  await assert.rejects(a.load("same"), IdentityBoundaryError); assert.equal(requests, 1);
});

test("cross-account backup import is rejected; unowned legacy import stays an inactive archive", () => {
  const a = emptyAgentState("same", alice.id), b = emptyAgentState("same", bob.id);
  assert.throws(() => mergeAgentBackup(b, a), /另一个 BetterMe 账号/);
  const legacy = emptyAgentState("same"); legacy.messages.push({ id: "legacy-message", origin: "companion", role: "user", text: "legacy", at: new Date().toISOString(), memoryIds: [], resumeShared: true });
  const restored = mergeAgentBackup(b, legacy).state;
  assert.equal(restored.ownerId, bob.id); assert.equal(restored.messages[0]?.archived, true); assert.equal(restored.messages[0]?.resumeShared, false);
});

test("identity failures stop chat, matching and confirmation without any paid-provider request", async () => {
  activatePrincipal(alice); const urls: string[] = [];
  mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => { urls.push(String(input)); return Response.json({ error: "identity_changed" }, { status: 409 }); });
  await assert.rejects(sendAgentChat({ messages: [], llmConfig: config }), IdentityBoundaryError);
  activatePrincipal(alice); await assert.rejects(startJdMatch({ threadId: "same", rawJd: "synthetic", allowedProfileEntryIds: [], llmConfig: config }), IdentityBoundaryError);
  activatePrincipal(alice); await assert.rejects(resumeJdMatch({ threadId: "same", decisions: {}, currentProposals: [], llmConfig: config }), IdentityBoundaryError);
  assert.equal(urls.length, 3); assert.ok(urls.every(url => url.includes("/api/v1/agent/")));
});

test("malformed authenticated chat does not trigger a second browser/paid generation", async () => {
  activatePrincipal(alice); let calls = 0;
  mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ reply: null }); });
  await assert.rejects(sendAgentChat({ messages: [], llmConfig: config }), /无法核对/); assert.equal(calls, 1);
});

test("understanding and ChatGPT transports propagate identity invalidation instead of masking or retrying it", async () => {
  const transport: typeof fetch = async () => Response.json({ error: "identity_required" }, { status: 401 });
  activatePrincipal(alice); await assert.rejects(createUnderstandingClient({ fetch: transport }).getSession("same"), IdentityBoundaryError);
  activatePrincipal(alice); await assert.rejects(createChatGptClient({ fetch: transport }).state(), IdentityBoundaryError);
});

test("late SSE events from an abort-ignoring transport cannot reach the new user's callback", async () => {
  activatePrincipal(alice); let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(current) { controller = current; } });
  mock.method(globalThis, "fetch", async () => new Response(stream));
  const events: unknown[] = [], pending = streamLocalAgentRun({ runId: "A-only", onEvent: event => events.push(event) });
  await new Promise<void>(resolve => setImmediate(resolve)); activatePrincipal(bob);
  controller.enqueue(new TextEncoder().encode('data: {"sequence":1,"payload":{"secret":"A"}}\n\n')); controller.close();
  await assert.rejects(pending, IdentityBoundaryError); assert.deepEqual(events, []);
});

test("account switching during a batched SSE callback rejects the remaining old-account frames", async () => {
  activatePrincipal(alice);
  const bytes = new TextEncoder().encode('data: {"sequence":1,"payload":{"secret":"A-first"}}\n\ndata: {"sequence":2,"payload":{"secret":"A-second"}}\n\n');
  mock.method(globalThis, "fetch", async () => new Response(bytes));
  const delivered: Array<{ owner: string; sequence: number }> = [];
  let owner = "alice";
  await assert.rejects(streamLocalAgentRun({ runId: "same", onEvent: event => {
    delivered.push({ owner, sequence: event.sequence });
    if (event.sequence === 1) { activatePrincipal(bob); owner = "bob"; }
  } }), IdentityBoundaryError);
  assert.deepEqual(delivered, [{ owner: "alice", sequence: 1 }], "Bob must never receive Alice's second buffered frame");
});
