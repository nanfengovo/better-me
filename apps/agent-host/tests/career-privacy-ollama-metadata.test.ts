import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createLocalOllamaClient, localOllamaCompletionWireBudget, LocalOllamaCompletionError } from "../src/privacy/local-ollama.js";

const runtime = { model: "synthetic-local", modelDigest: "a".repeat(64) }, budget = { maxInputBytes: 180_000, maxOutputBytes: 48_000, maxActiveMs: 3000 };
async function fixture(t: test.TestContext) {
  let wrapper: Record<string, unknown> = { model: runtime.model, done: true, done_reason: "stop", response: '{"ok":true}', context: Array(12_000).fill(12345) }, declaredLength: number | undefined;
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    const parts: Buffer[] = []; for await (const part of request) parts.push(Buffer.from(part)); const bytes = Buffer.concat(parts);
    requests.push({ path: request.url!, body: bytes.length ? JSON.parse(bytes.toString()) : {} }); response.setHeader("content-type", "application/json");
    if (request.url === "/api/version") response.end(JSON.stringify({ version: "0.40.15" }));
    else if (request.url === "/api/tags") response.end(JSON.stringify({ models: [{ name: runtime.model, digest: runtime.modelDigest }] }));
    else { if (declaredLength) response.setHeader("content-length", declaredLength); response.end(JSON.stringify(wrapper)); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address === "object");
  const client = createLocalOllamaClient({ endpoint: `http://127.0.0.1:${address.port}`, model: runtime.model, expectedDigest: runtime.modelDigest });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const complete = (selectedBudget = budget) => client.complete({ prompt: "Synthetic bounded local prompt.", jsonSchema: { type: "object" }, signal: new AbortController().signal, budget: selectedBudget });
  return { client, requests, complete, set: (value: Record<string, unknown>, length?: number) => { wrapper = { done_reason: "stop", ...value }; declaredLength = length; } };
}
const errorBoundary = (boundary: "wire" | "generated" | "context") => (error: unknown) => error instanceof LocalOllamaCompletionError && error.boundary === boundary;

test("small generated response plus legitimate >48KB token-ID metadata succeeds without returning metadata or disabling the model template", async t => {
  const f = await fixture(t), reply = await f.complete(); assert.equal(reply, '{"ok":true}'); assert.equal(reply.includes("context"), false);
  const request = f.requests.find(item => item.path === "/api/generate")!.body; assert.equal(request["raw"], undefined); assert.equal(request["stream"], false); assert.equal(request["think"], false);
  assert.equal(f.requests.filter(item => item.path === "/api/generate").length, 1); assert.equal(f.requests.filter(item => item.path === "/api/tags").length, 2);
  const limits = localOllamaCompletionWireBudget(budget); assert.ok(limits.maxWireBytes > 48000 && limits.maxWireBytes <= 2000000); assert.ok(limits.maxContextTokens <= 262144);
});

test("generated UTF-8 response and unsolicited thinking remain under the unchanged 48KB model-output cap", async t => {
  const f = await fixture(t);
  for (const response of ["x".repeat(48001), "测".repeat(16001)]) { f.set({ done: true, response, context: [1] }); await assert.rejects(f.complete(), errorBoundary("generated")); }
  f.set({ done: true, response: "x".repeat(24000), thinking: "y".repeat(24001), context: [1] }); await assert.rejects(f.complete(), errorBoundary("generated"));
  assert.equal(f.requests.filter(item => item.path === "/api/generate").length, 3); assert.equal(f.requests.some(item => item.path === "/api/chat"), false);
});

test("wire metadata has an independent derived hard cap and rejects oversized declared or chunked bodies before parsing", async t => {
  const f = await fixture(t), limits = localOllamaCompletionWireBudget(budget);
  f.set({ done: true, response: "{}", context: [1] }, limits.maxWireBytes + 1); await assert.rejects(f.complete(), errorBoundary("wire"));
  f.set({ done: true, response: "{}", context: Array(150000).fill(123456789) }); await assert.rejects(f.complete(), errorBoundary("wire"));
  assert.equal(localOllamaCompletionWireBudget({ ...budget, maxInputBytes: 2000000, maxOutputBytes: 256000 }).maxWireBytes, 2000000);
});

test("context must be a finite bounded integer token-ID array, never strings, nested objects, negatives or unlimited metadata", async t => {
  const f = await fixture(t), limit = localOllamaCompletionWireBudget(budget).maxContextTokens;
  for (const context of [[1, -1], [1, 1.5], ["1"], [[1]], [2147483648], null, Array(limit + 1).fill(1)]) {
    f.set({ done: true, response: "{}", context }); await assert.rejects(f.complete(), errorBoundary("context"));
  }
  f.set({ done: true, response: "{}", context: [0, 2147483647] }); assert.equal(await f.complete(), "{}");
});

test("unknown/invalid wrapper fields fail closed and missing optional context remains compatible", async t => {
  const f = await fixture(t);
  for (const extra of [{ system_prompt: "DO_NOT_EXPOSE_SOURCE" }, { eval_count: -1 }, { prompt_eval_duration: 1.1 }, { prompt_eval_cached_count: -1 }, { prompt_eval_cached_count: "1" }, { model: "changed-model" }, { context: { tokens: [1] } }]) {
    f.set({ model: runtime.model, done: true, response: "{}", ...extra }); await assert.rejects(f.complete(), error => error instanceof Error && error.message === "invalid_local_completion" && !error.message.includes("DO_NOT_EXPOSE_SOURCE"));
  }
  f.set({ model: runtime.model, done: true, response: "{}", created_at: "2026-11-09T00:00:00.000Z", total_duration: 1000, load_duration: 10, prompt_eval_count: 2, prompt_eval_cached_count: 1, prompt_eval_duration: 10, eval_count: 2, eval_duration: 50, done_reason: "stop" });
  assert.equal(await f.complete(), "{}");
});
