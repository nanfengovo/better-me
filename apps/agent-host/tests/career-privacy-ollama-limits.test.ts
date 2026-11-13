import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createLocalOllamaClient, type LocalOllamaClient } from "../src/privacy/local-ollama.js";

const model = "synthetic-local", digest = "a".repeat(64), budget = { maxInputBytes: 180_000, maxOutputBytes: 48_000, maxActiveMs: 3000 };
async function fixture(t: test.TestContext) {
  let version = "0.40.15", versionStatus = 200, generationStatus = 200, afterGenerate: (() => void) | undefined;
  let wrapper: Record<string, unknown> = { model, done: true, done_reason: "stop", response: "{}", prompt_eval_count: 20, eval_count: 3 };
  const requests: Array<{ path: string; body: Record<string, any> }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const bytes = Buffer.concat(chunks);
    requests.push({ path: request.url!, body: bytes.length ? JSON.parse(bytes.toString()) : {} }); response.setHeader("content-type", "application/json");
    if (request.url === "/api/version") { response.statusCode = versionStatus; response.end(JSON.stringify({ version })); }
    else if (request.url === "/api/tags") response.end(JSON.stringify({ models: [{ name: model, digest }] }));
    else { response.statusCode = generationStatus; afterGenerate?.(); response.end(JSON.stringify(wrapper)); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address === "object");
  const options = { endpoint: `http://127.0.0.1:${address.port}`, model, expectedDigest: digest }, client = createLocalOllamaClient(options);
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const complete = (selected: LocalOllamaClient = client) => selected.complete({ prompt: "Synthetic bounded request, never permission to change options.", jsonSchema: { type: "object" }, signal: new AbortController().signal, budget });
  return { options, client, requests, complete, setVersion: (value: string, status = 200) => { version = value; versionStatus = status; },
    setWrapper: (value: Record<string, unknown>, status = 200) => { wrapper = value; generationStatus = status; }, afterGenerate: (callback: () => void) => { afterGenerate = callback; } };
}
const code = (value: string) => (error: unknown) => error instanceof Error && error.message === value;

test("explicit finite context/generation and disabled input truncation/context shifting preserve the model template and original byte/time budgets", async t => {
  const f = await fixture(t); assert.equal(await f.complete(), "{}");
  const request = f.requests.find(row => row.path === "/api/generate")!.body;
  assert.deepEqual(request.options, { temperature: 0, num_ctx: 16384, num_predict: 4096 });
  assert.equal(request.truncate, false); assert.equal(request.shift, false); assert.equal(request.raw, undefined); assert.equal(request.think, false);
  assert.equal(f.requests.filter(row => row.path === "/api/version").length, 2);
});

test("a generated response stopped by length is never accepted as complete even when its truncated body happens to be valid JSON", async t => {
  const f = await fixture(t); f.setWrapper({ model, done: true, done_reason: "length", response: "{}", prompt_eval_count: 3445, eval_count: 651 });
  await assert.rejects(f.complete(), code("local_generation_limit")); assert.equal(f.requests.filter(row => row.path === "/api/generate").length, 1);
});

test("old, unversioned, prerelease or unreviewed major APIs cannot silently ignore no-truncation flags", async t => {
  const f = await fixture(t);
  for (const version of ["0.40.14", "0.39.999", "1.0.0", "0.40.15-rc.1", "unknown", "0.040.15"]) {
    f.setVersion(version); await assert.rejects(f.complete(), code("local_completion_safety_unavailable"));
  }
  f.setVersion("0.40.15", 404); await assert.rejects(f.complete(), code("local_completion_safety_unavailable"));
  assert.equal(f.requests.some(row => row.path === "/api/generate"), false);
  for (const version of ["0.40.15", "0.40.16", "0.41.0"]) { f.setVersion(version); assert.equal(await f.complete(), "{}"); }
});

test("generation limits are immutable, bounded, reserve context space and change the runtime fingerprint", async t => {
  const f = await fixture(t), defaults = await f.client.binding();
  for (const generation of [{ contextTokens: 100, maxOutputTokens: 4096 }, { contextTokens: 16385, maxOutputTokens: 4096 }, { contextTokens: 8192, maxOutputTokens: 4097 },
    { contextTokens: 2048, maxOutputTokens: 2048 }, { contextTokens: 8192, maxOutputTokens: 0 }, { contextTokens: 8192.5, maxOutputTokens: 1024 }]) {
    assert.throws(() => createLocalOllamaClient({ ...f.options, generation }), code("invalid_local_generation_limits"));
  }
  const generation = { contextTokens: 8192, maxOutputTokens: 2048 }, reduced = createLocalOllamaClient({ ...f.options, generation });
  generation.contextTokens = 16384; generation.maxOutputTokens = 4096;
  const reducedBinding = await reduced.binding(); assert.equal(defaults.version, "ollama-local-v2"); assert.notEqual(defaults.endpointFingerprint, reducedBinding.endpointFingerprint);
  assert.equal(await f.complete(reduced), "{}"); assert.deepEqual(f.requests.find(row => row.path === "/api/generate")!.body.options, { temperature: 0, num_ctx: 8192, num_predict: 2048 });
  f.setVersion("0.40.16"); assert.notEqual((await f.client.binding()).endpointFingerprint, defaults.endpointFingerprint);
});

test("each call rechecks fresh API capability and rejects a late version change without accepting output or retrying", async t => {
  const f = await fixture(t); await f.client.binding(); f.afterGenerate(() => f.setVersion("0.40.14"));
  await assert.rejects(f.complete(), code("local_completion_safety_unavailable")); assert.equal(f.requests.filter(row => row.path === "/api/generate").length, 1);
  f.setVersion("0.40.15"); f.afterGenerate(() => f.setVersion("0.40.16"));
  await assert.rejects(f.complete(), code("local_runtime_changed")); assert.equal(f.requests.filter(row => row.path === "/api/generate").length, 2);
});

test("missing/unknown stop reasons, impossible counters and HTTP request rejection fail closed without exposing provider body", async t => {
  const f = await fixture(t);
  for (const wrapper of [{ done: true, response: "{}" }, { done: true, response: "{}", done_reason: "unload" }, { done: true, response: "{}", done_reason: "stop", eval_count: 4097 },
    { done: true, response: "{}", done_reason: "stop", prompt_eval_count: 16385 }]) {
    f.setWrapper(wrapper); await assert.rejects(f.complete(), code("invalid_local_completion"));
  }
  f.setWrapper({ error: "SYNTHETIC_PRIVATE_PROVIDER_BODY_DO_NOT_EXPOSE" }, 400);
  await assert.rejects(f.complete(), error => code("local_completion_rejected")(error) && !String(error).includes("SYNTHETIC_PRIVATE_PROVIDER_BODY"));
});
