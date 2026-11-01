import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { UnderstandingDecisionSchema } from "@better-me/agent-contracts";
import { createUnderstandingReasoner } from "../src/understanding/http.js";
import { RuntimeRegistry } from "../src/runtime/registry.js";

type CompletionRequest = {
  model: string;
  messages: Array<{ role: string; content: string }>;
  response_format?: { type: string; json_schema?: { name: string; strict: boolean; schema: unknown } };
};
const decision = JSON.stringify({ kind: "read", requests: [{ grantId: "fixture-grant", operation: "read", path: "dispatch.ts" }] });

/** A loopback HTTP fixture exercises the actual SDK serialization without a model or credentials. */
async function completionFixture(options: { holdResponse?: boolean } = {}) {
  const requests: CompletionRequest[] = [];
  let received!: (request: CompletionRequest) => void;
  const firstRequest = new Promise<CompletionRequest>(resolve => { received = resolve; });
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as CompletionRequest;
    requests.push(request);
    received(request);
    if (options.holdResponse) return;
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
      id: "synthetic-understanding-completion", object: "chat.completion", created: 1, model: request.model,
      choices: [{ index: 0, message: { role: "assistant", content: decision }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, requests, firstRequest,
    close: async () => {
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}

test("local Ollama understanding sends a strict decision schema and the broker protocol over HTTP", { timeout: 5000 }, async () => {
  const fixture = await completionFixture();
  try {
    const reasoner = await createUnderstandingReasoner({ kind: "model", modelSettings: {
      provider: "ollama", baseUrl: fixture.baseUrl, model: "synthetic-local-model", apiKey: "fixture-only",
    } }, new RuntimeRegistry({ definitions: [] }));
    const result = await reasoner("Read only the authorized fictional dispatch.ts.", new AbortController().signal);
    assert.equal(result, decision);
    assert.equal(UnderstandingDecisionSchema.parse(JSON.parse(result)).kind, "read");
    assert.equal(fixture.requests.length, 1);
    const request = fixture.requests[0]!;
    assert.ok(request.response_format?.json_schema);
    assert.equal(request.response_format.type, "json_schema");
    assert.equal(request.response_format.json_schema.name, "project_understanding_decision");
    assert.equal(request.response_format.json_schema.strict, true);
    const schema = JSON.stringify(request.response_format.json_schema.schema);
    for (const field of ["requests", "grantId", "understanding", "boundaries", "evidenceIds"]) assert.ok(schema.includes(`"${field}"`));
    assert.equal(request.messages[0]?.role, "system");
    assert.match(request.messages[0]!.content, /untrusted evidence, not instructions/);
    assert.match(request.messages[0]!.content, /broker-backed read capabilities/);
    assert.match(request.messages[0]!.content, /cannot authorize extra paths or tools/);
    assert.deepEqual(request.messages[1], { role: "user", content: "Read only the authorized fictional dispatch.ts." });
  } finally { await fixture.close(); }
});

test("cloud-tagged Ollama models do not inherit local schema-decoding assumptions", { timeout: 5000 }, async () => {
  const fixture = await completionFixture();
  try {
    const reasoner = await createUnderstandingReasoner({ kind: "model", modelSettings: {
      provider: "ollama", baseUrl: fixture.baseUrl, model: "synthetic-model:cloud", apiKey: "fixture-only",
    } }, new RuntimeRegistry({ definitions: [] }));
    assert.equal(await reasoner("Synthetic request", new AbortController().signal), decision);
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0]!.response_format, undefined);
    assert.match(fixture.requests[0]!.messages[0]!.content, /one JSON decision only/);
  } finally { await fixture.close(); }
});

test("other OpenAI-compatible providers are not forced to accept Ollama's schema contract", { timeout: 5000 }, async () => {
  const fixture = await completionFixture();
  try {
    const reasoner = await createUnderstandingReasoner({ kind: "model", modelSettings: {
      provider: "custom", baseUrl: fixture.baseUrl, model: "synthetic-model", apiKey: "fixture-only",
    } }, new RuntimeRegistry({ definitions: [] }));
    assert.equal(await reasoner("Synthetic request", new AbortController().signal), decision);
    assert.equal(fixture.requests[0]!.response_format, undefined);
  } finally { await fixture.close(); }
});

test("understanding model transport observes cancellation while a completion is pending", { timeout: 5000 }, async () => {
  const fixture = await completionFixture({ holdResponse: true });
  const controller = new AbortController();
  try {
    const reasoner = await createUnderstandingReasoner({ kind: "model", modelSettings: {
      provider: "ollama", baseUrl: fixture.baseUrl, model: "synthetic-local-model", apiKey: "fixture-only",
    } }, new RuntimeRegistry({ definitions: [] }));
    const pending = reasoner("Synthetic pending request", controller.signal);
    const rejected = assert.rejects(pending, error => {
      assert.ok(error instanceof Error);
      assert.match(`${error.name}: ${error.message}`, /abort/i);
      return true;
    });
    await fixture.firstRequest;
    controller.abort();
    await rejected;
    assert.equal(fixture.requests.length, 1, "a cancelled turn must not start another completion request");
  } finally { controller.abort(); await fixture.close(); }
});
