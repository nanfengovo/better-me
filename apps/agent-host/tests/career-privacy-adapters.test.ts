import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { createLocalOllamaClient, createOllamaPrivacyAdapter, disclosureViolations, parseLocalJson, privacyRuntimeFingerprint, redactDisclosureText } from "../src/privacy/index.js";

const digest = "a".repeat(64), embeddingDigest = "b".repeat(64);
const budget = { maxInputBytes: 100_000, maxOutputBytes: 16_000, maxActiveMs: 3000 };
const code = (expected: string) => (error: unknown) => error instanceof Error && error.message === expected;
async function fakeOllama(t: { after(fn: () => Promise<void> | void): void }) {
  let remote: Record<string, unknown> = {}, installedDigest = digest, reply = '{"fields":[{"name":"evidence","text":"Implemented an idempotent state machine.","sourceIds":["fact-1"]}]}';
  let changeAfterGenerate = false;
  const requests: { path: string; body: unknown }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString("utf8"), body: unknown = text ? JSON.parse(text) : undefined;
    requests.push({ path: request.url!, body });
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/version") response.end(JSON.stringify({ version: "0.40.15" }));
    else if (request.url === "/api/tags") response.end(JSON.stringify({ models: [{ name: "synthetic-local:latest", digest: installedDigest, ...remote }, { name: "synthetic-embed:latest", digest: embeddingDigest }] }));
    else if (request.url === "/api/generate") {
      if (changeAfterGenerate) installedDigest = "f".repeat(64);
      response.end(JSON.stringify({ model: "synthetic-local:latest", response: reply, done: true, done_reason: "stop" }));
    } else if (request.url === "/api/embed") response.end(JSON.stringify({ model: "synthetic-embed:latest", embeddings: [[1, 0], [0, 1]] }));
    else { response.statusCode = 404; response.end('{"error":"unsupported"}'); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address === "object");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const client = createLocalOllamaClient({ endpoint: `http://127.0.0.1:${address.port}`, model: "synthetic-local:latest", expectedDigest: digest });
  return { client, requests, endpoint: `http://127.0.0.1:${address.port}`, setRemote: (value: Record<string, unknown>) => { remote = value; }, setDigest: (value: string) => { installedDigest = value; }, setReply: (value: string) => { reply = value; }, driftAfterGenerate: () => { changeAfterGenerate = true; } };
}

test("privacy local Ollama actual loopback completion pins endpoint+digest, bounds input and sends explicit JSON schema", async t => {
  const f = await fakeOllama(t), binding = await f.client.binding();
  assert.equal(binding.location, "local"); assert.equal(binding.modelDigest, digest); assert.match(binding.endpointFingerprint, /^[a-f0-9]{64}$/);
  const text = await f.client.complete({ prompt: "Summarize only synthetic public facts.", jsonSchema: { type: "object" }, signal: new AbortController().signal, budget });
  assert.match(text, /idempotent/);
  const generate = f.requests.find(request => request.path === "/api/generate")!.body as { model: string; prompt: string; stream: boolean; think: boolean; format: unknown };
  assert.equal(generate.model, "synthetic-local:latest"); assert.equal(generate.stream, false); assert.equal(generate.think, false); assert.deepEqual(generate.format, { type: "object" });
  assert.equal(f.requests.filter(request => request.path === "/api/tags").length, 3);
  assert.equal(f.requests.filter(request => request.path === "/api/version").length, 3);
  assert.deepEqual([...new Set(f.requests.map(request => request.path))].sort(), ["/api/generate", "/api/tags", "/api/version"]);
  const secondEndpoint = createLocalOllamaClient({ endpoint: "http://127.0.0.1:11434", model: "synthetic-local:latest", expectedDigest: digest });
  assert.notEqual(privacyRuntimeFingerprint(binding), privacyRuntimeFingerprint({ ...binding, endpointFingerprint: "e".repeat(64) }));
  assert.ok(secondEndpoint); // Construction makes no connection or configuration mutation.
});

test("privacy loopback daemon remote flags and changed installed digest reject before generation without fallback", async t => {
  for (const remote of [{ remote_host: "https://synthetic-cloud.invalid" }, { remote_model: "remote-model" }, { remote_host: "" }]) {
    const f = await fakeOllama(t); f.setRemote(remote);
    await assert.rejects(f.client.complete({ prompt: "synthetic", signal: new AbortController().signal, budget }), code("local_model_missing_remote_or_changed"));
    assert.equal(f.requests.some(request => request.path === "/api/generate"), false);
  }
  const f = await fakeOllama(t); f.setDigest("c".repeat(64));
  await assert.rejects(f.client.complete({ prompt: "synthetic", signal: new AbortController().signal, budget }), code("local_model_missing_remote_or_changed"));
  assert.equal(f.requests.some(request => request.path === "/api/generate"), false);
});

test("privacy local completion rejects late output after installed model digest drift", async t => {
  const f = await fakeOllama(t); f.driftAfterGenerate();
  await assert.rejects(f.client.complete({ prompt: "synthetic", signal: new AbortController().signal, budget }), code("local_model_missing_remote_or_changed"));
  assert.equal(f.requests.filter(request => request.path === "/api/generate").length, 1);
});

test("privacy local client blocks cloud model tags, non-loopback endpoints and unpinned digests at construction", () => {
  for (const model of ["gemma4:31b-cloud", "synthetic:cloud", "synthetic-cloud:latest"]) assert.throws(() => createLocalOllamaClient({ model, expectedDigest: digest }), code("local_model_requires_pinned_local_digest"));
  for (const endpoint of ["https://cloud.invalid", "http://192.0.2.1:11434", "http://127.0.0.1:11434/private", "http://user:pass@127.0.0.1:11434", "http://127.0.0.1:11434?key=synthetic"]) assert.throws(() => createLocalOllamaClient({ endpoint, model: "synthetic-local", expectedDigest: digest }), code("invalid_local_endpoint"));
  assert.throws(() => createLocalOllamaClient({ model: "synthetic-local", expectedDigest: "unknown" }), code("local_model_requires_pinned_local_digest"));
});

test("privacy local client cancellation, byte limits and malformed local response never choose another model", async t => {
  const f = await fakeOllama(t), controller = new AbortController(); controller.abort();
  await assert.rejects(f.client.complete({ prompt: "synthetic", signal: controller.signal, budget }), code("privacy_cancelled"));
  assert.equal(f.requests.length, 0);
  await assert.rejects(f.client.complete({ prompt: "synthetic".repeat(100), signal: new AbortController().signal, budget: { ...budget, maxInputBytes: 20 } }), code("local_input_limit"));
  assert.equal(f.requests.some(request => request.path === "/api/generate"), false);
  f.setReply("x".repeat(20_000));
  await assert.rejects(f.client.complete({ prompt: "synthetic", signal: new AbortController().signal, budget }), code("privacy_http_output_limit"));
  assert.equal(f.requests.filter(request => request.path === "/api/generate").length, 1);
});

test("privacy optional local embedding is explicitly pinned and remains on /api/embed", async t => {
  const f = await fakeOllama(t);
  assert.equal(f.client.embed, undefined);
  const client = createLocalOllamaClient({ endpoint: f.endpoint, model: "synthetic-local:latest", expectedDigest: digest, embeddingModel: "synthetic-embed:latest", expectedEmbeddingDigest: embeddingDigest });
  assert.deepEqual(await client.embed!({ texts: ["synthetic local query", "synthetic local fact"], signal: new AbortController().signal, budget }), [[1, 0], [0, 1]]);
  assert.equal((await client.binding()).embeddingDigest, embeddingDigest);
  assert.equal(f.requests.some(request => request.path === "/api/generate"), false);
  assert.equal(f.requests.filter(request => request.path === "/api/embed").length, 1);
});

test("privacy adapter never includes local-only sources in actual model prompt", async t => {
  const f = await fakeOllama(t), adapter = createOllamaPrivacyAdapter(f.client, { budget });
  const source = { id: "fact-1", revision: "r1", classification: "summary_allowed" as const, kind: "fact" as const, text: "Synthetic verified idempotency fact." };
  await adapter.summarize({ sources: [source], requestedFields: ["evidence"] }, new AbortController().signal);
  const prompt = (f.requests.find(request => request.path === "/api/generate")!.body as { prompt: string }).prompt;
  assert.match(prompt, /Synthetic verified idempotency fact/); assert.match(prompt, /untrusted data/);
  await assert.rejects(adapter.summarize({ sources: [{ ...source, classification: "local_only", text: "SYNTHETIC_LOCAL_ONLY_CANARY_17439" }], requestedFields: ["evidence"] }, new AbortController().signal), code("local_only_summary_input"));
  assert.equal(f.requests.filter(request => request.path === "/api/generate").length, 1);
});

test("privacy JSON repair is bounded syntax-only, tracks BOM, never changes strings or fabricates missing tokens", () => {
  const fixed = parseLocalJson('\uFEFF{"value":"literal ,} stays intact",}');
  assert.deepEqual(fixed.value, { value: "literal ,} stays intact" }); assert.deepEqual(fixed.repairs.map(repair => repair.kind), ["bom", "trailing_comma"]);
  assert.throws(() => parseLocalJson('{"value":'), code("invalid_local_json"));
  assert.throws(() => parseLocalJson("{'value':1}"), code("invalid_local_json"));
  assert.throws(() => parseLocalJson('```json\n{"value":1,}\n```', { maxRepairs: 1 }), code("json_repair_budget_exhausted"));
  assert.throws(() => parseLocalJson('{"value":1,}', { maxRepairs: 0 }), code("json_repair_budget_exhausted"));
  assert.throws(() => parseLocalJson("x".repeat(21), { maxBytes: 20 }), code("local_output_limit"));
  assert.throws(() => parseLocalJson("{}", { maxRepairs: 99 }), code("invalid_json_repair_budget"));
  assert.deepEqual(parseLocalJson('{"value":1}').repairs, []);
});

test("privacy content guard blocks source/diff/keys/absolute files and redacts declared names/PII", () => {
  for (const path of ["/Users/synthetic/private.ts", "/opt/synthetic/private.ts", "C:\\private\\synthetic.ts", "\\\\synthetic\\private\\file.ts"]) assert.ok(disclosureViolations(`See ${path}`).includes("private_path"));
  assert.ok(disclosureViolations('api_key="SYNTHETIC_SECRET_TOKEN"').includes("credential"));
  assert.ok(disclosureViolations("diff --git a/a.ts b/a.ts\n@@ -1 +1 @@").includes("raw_diff"));
  assert.ok(disclosureViolations("const state = 1;").includes("raw_code"));
  assert.deepEqual(disclosureViolations("Implemented SQLite transaction leasing with CAS checks."), []);
  const redacted = redactDisclosureText("Synthetic(Name) person@example.test 13800138000", ["Synthetic(Name)"]);
  assert.equal(redacted.text.includes("Synthetic(Name)"), false); assert.equal(redacted.text.includes("person@example.test"), false); assert.equal(redacted.redactions.length, 3);
});
