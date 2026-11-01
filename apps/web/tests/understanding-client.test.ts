import assert from "node:assert/strict";
import test from "node:test";
import { createUnderstandingClient, understandingModelRuntime, UnderstandingClientError } from "../src/services/understanding-client";
import { fixtureSession } from "./fixtures/project-understanding";

test("understanding client sends exact scoped source and revision-bound mutations", async () => {
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  const client = createUnderstandingClient({ baseUrl: "https://fixture.invalid", fetch: async (url, options) => {
    calls.push({ url: String(url), options }); return Response.json(fixtureSession());
  } });
  const source = { workspaceKey: "synthetic-workspace", projectKey: "synthetic-project", label: "合成项目", sourceText: "只发送这一字段" };
  await client.createSession(source);
  assert.deepEqual(JSON.parse(String(calls[0]?.options?.body)), source);
  assert.equal(calls[0]?.url, "https://fixture.invalid/api/v1/agent/understanding/sessions");
  await client.updateSource("session / one", { expectedRevision: 3, sourceText: "明确更新后的材料" });
  assert.match(calls[1]!.url, /session%20%2F%20one\/source$/);
  assert.deepEqual(JSON.parse(String(calls[1]?.options?.body)), { expectedRevision: 3, sourceText: "明确更新后的材料" });
  await client.confirm("session", { expectedRevision: 8, summaryHash: "exact-summary-hash" });
  assert.deepEqual(JSON.parse(String(calls[2]?.options?.body)), { expectedRevision: 8, summaryHash: "exact-summary-hash" });
  await client.revokeGrant("session", "grant / one");
  assert.equal(calls[3]?.options?.method, "DELETE"); assert.match(calls[3]!.url, /grants\/grant%20%2F%20one$/);
  await client.cancel("session", 5);
  assert.deepEqual(JSON.parse(String(calls[4]?.options?.body)), { expectedTurnCount: 5 });
});
test("understanding turns carry only explicit runtime consent and caller idempotency identity", async () => {
  let body: unknown;
  const client = createUnderstandingClient({ fetch: async (_url, options) => { body = JSON.parse(String(options?.body)); return Response.json(fixtureSession({ phase: "running" })); } });
  const runtime = understandingModelRuntime({ provider: "ollama", baseUrl: "http://fixture.invalid/v1", model: "synthetic", temperature: 0, apiKey: "synthetic-only" });
  await client.startTurn("synthetic", { expectedRevision: 7, idempotencyKey: "same-request-key", answer: "我想纠正一个术语", selectedOptionIds: ["choice-b"], runtime, consentToSend: true });
  assert.deepEqual(body, JSON.parse(JSON.stringify({ expectedRevision: 7, idempotencyKey: "same-request-key", answer: "我想纠正一个术语", selectedOptionIds: ["choice-b"], runtime, consentToSend: true })));
});
test("invalid responses fail closed and provider error content is not surfaced", async () => {
  const malformed = createUnderstandingClient({ fetch: async () => Response.json({ id: "incomplete", phase: "confirmed" }) });
  await assert.rejects(malformed.getSession("one"), (error: unknown) => error instanceof UnderstandingClientError && error.code === "invalid_response");
  const conflict = createUnderstandingClient({ fetch: async () => Response.json({ error: "revision_conflict", message: "SYNTHETIC_SECRET_PROVIDER_DETAIL" }, { status: 409 }) });
  await assert.rejects(conflict.confirm("one", { expectedRevision: 2, summaryHash: "hash" }), (error: unknown) => {
    assert.ok(error instanceof UnderstandingClientError); assert.equal(error.status, 409); assert.equal(error.code, "revision_conflict");
    assert.doesNotMatch(error.message, /SYNTHETIC_SECRET/); return true;
  });
});
test("capabilities preserve unsupported reasons and transport does not silently fall back", async () => {
  let calls = 0;
  const capability = { id: "fixture-native", name: "合成 Agent", supported: false, available: true, reason: "未验证只读能力" };
  const client = createUnderstandingClient({ fetch: async () => { calls++; return Response.json({ runtimes: [capability] }); } });
  assert.deepEqual(await client.getCapabilities(), [capability]); assert.equal(calls, 1);
  const unavailable = createUnderstandingClient({ fetch: async () => { calls++; throw new TypeError("fetch failed"); } });
  await assert.rejects(unavailable.getSession("one"), (error: unknown) => error instanceof UnderstandingClientError && error.code === "unavailable");
  assert.equal(calls, 2);
});
