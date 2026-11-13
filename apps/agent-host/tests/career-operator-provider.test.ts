import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { createConfiguredPrivacyProviderFromEnvironment } from "../src/career-studio/operator-provider.js";
import type { CloudDisclosureEnvelope } from "../src/privacy/index.js";

const secret = "SYNTHETIC_EXISTING_SCOPED_CREDENTIAL_784913";
const reference = { providerId: "existing-synthetic-provider", configRevision: "v1", configHash: "f".repeat(64) };
const approved: CloudDisclosureEnvelope = { protocol: "betterme.disclosure.v1", taskId: "LOCAL_TASK_ID_NOT_DISCLOSED", operationId: "LOCAL_OPERATION_ID_NOT_DISCLOSED", model: "synthetic-model", summary: { evidence: "Implemented CAS guarded state restoration." }, sources: [{ id: "fact-1", revision: "v1", hash: "e".repeat(64) }] };
const environment = (baseURL = "https://synthetic-existing-cloud.invalid/v1") => ({ BETTERME_CAREER_PRIVACY_PROVIDER_ID: reference.providerId, BETTERME_CAREER_PRIVACY_PROVIDER: "openai-compatible", BETTERME_CAREER_PRIVACY_BASE_URL: baseURL, BETTERME_CAREER_PRIVACY_MODEL: "synthetic-model", BETTERME_CAREER_PRIVACY_RUNTIME_VERSION: "existing-provider-revision-1", BETTERME_CAREER_PRIVACY_API_KEY_ENV: "SYNTHETIC_EXISTING_PROVIDER_KEY", BETTERME_CAREER_PRIVACY_MAX_OUTPUT_TOKENS: "1024", SYNTHETIC_EXISTING_PROVIDER_KEY: secret });
const success = { choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ text: "Only approved synthetic CAS evidence.", sourceIds: ["fact-1"], unknowns: ["No performance measure was supplied."] }) } }] };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; };
async function listen(server: Server) { server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address === "object"); return `http://127.0.0.1:${address.port}`; }
async function fixture(t: { after(fn: () => Promise<void> | void): void }, input: { wait?: Promise<void>; response?: unknown; status?: number; redirect?: boolean } = {}) {
  const captures: { url: string; authorization?: string; body: Record<string, any> }[] = [], started = deferred<void>();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); captures.push({ url: request.url!, authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); started.resolve(); await input.wait;
    if (response.destroyed) return;
    if (input.redirect) { response.writeHead(307, { location: "/unexpected-second-recipient" }); response.end(); return; }
    response.writeHead(input.status ?? 200, { "content-type": "application/json" }); response.end(JSON.stringify(input.response ?? success));
  });
  const base = await listen(server), env = environment(`${base}/v1`), resolver = createConfiguredPrivacyProviderFromEnvironment({ environment: env, allowLoopbackHttpFixture: true })!, adapter = (await resolver(reference))!;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { env, adapter, captures, started };
}

test("operator environment factory has no default provider/key/URL and only explicit existing provider id resolves", async () => {
  assert.equal(createConfiguredPrivacyProviderFromEnvironment({ environment: {} }), undefined);
  assert.throws(() => createConfiguredPrivacyProviderFromEnvironment({ environment: { BETTERME_CAREER_PRIVACY_MODEL: "synthetic" } }), /operator_provider_environment_incomplete_or_invalid/);
  for (const baseURL of ["http://synthetic-cloud.invalid/v1", "https://user:pass@synthetic-cloud.invalid/v1", "https://synthetic-cloud.invalid/v1?token=CANARY", "https://localhost/v1"]) assert.throws(() => createConfiguredPrivacyProviderFromEnvironment({ environment: environment(baseURL) }), /operator_provider_endpoint_invalid/);
  const resolver = createConfiguredPrivacyProviderFromEnvironment({ environment: environment() })!; assert.equal(await resolver({ ...reference, providerId: "different-provider" }), undefined);
  const missing = environment(); missing.SYNTHETIC_EXISTING_PROVIDER_KEY = ""; const unavailable = (await createConfiguredPrivacyProviderFromEnvironment({ environment: missing })!(reference))!; await assert.rejects(unavailable.binding(), /operator_provider_credential_unavailable/);
});

test("operator configured provider actual loopback HTTP sends only approved summary with exact existing credential header and no tools/retry", async t => {
  const f = await fixture(t), binding = await f.adapter.binding(); assert.equal(binding.model, approved.model); assert.equal(binding.location, "cloud"); assert.equal(JSON.stringify(binding).includes(secret), false);
  const output = await f.adapter.dispatch(approved, new AbortController().signal); assert.equal(f.captures.length, 1); const captured = f.captures[0]!;
  assert.equal(captured.url, "/v1/chat/completions"); assert.equal(captured.authorization, `Bearer ${secret}`); assert.equal(captured.body.stream, false); assert.deepEqual(captured.body.response_format, { type: "json_object" }); assert.equal(captured.body.max_tokens, 1024);
  assert.equal(captured.body.tools, undefined); assert.equal(captured.body.tool_choice, undefined); assert.equal(captured.body.model, "synthetic-model");
  assert.deepEqual(JSON.parse(captured.body.messages[1].content), { summary: approved.summary, sources: approved.sources });
  assert.equal(JSON.stringify(captured.body).includes(approved.taskId), false); assert.equal(JSON.stringify(captured.body).includes(approved.operationId), false); assert.equal(JSON.stringify(captured.body).includes(secret), false); assert.ok(output);
});

test("operator configured provider raw code/secrets/private paths and unexpected fields fail before any external request", async t => {
  const f = await fixture(t);
  for (const text of ['api_key="SYNTHETIC_PRIVATE_CANARY_91827"', "diff --git a/private.ts b/private.ts\n+const secret = 1", "/Users/synthetic/private/source.ts"]) await assert.rejects(f.adapter.dispatch({ ...approved, summary: { evidence: text } }, new AbortController().signal), /operator_provider_unsafe_summary/);
  await assert.rejects(f.adapter.dispatch({ ...approved, rawSource: "PRIVATE_LOCAL_ONLY_CANARY" } as unknown as CloudDisclosureEnvelope, new AbortController().signal), /operator_provider_approved_summary_required/);
  await assert.rejects(f.adapter.dispatch({ ...approved, model: "different-model" }, new AbortController().signal), /operator_provider_model_mismatch/); assert.equal(f.captures.length, 0);
});

test("operator configured provider redirect and provider failure never retry, switch endpoint, retain error content or repair JSON", async t => {
  const redirected = await fixture(t, { redirect: true }); await assert.rejects(redirected.adapter.dispatch(approved, new AbortController().signal), /operator_provider_delivery_unknown/); assert.equal(redirected.captures.length, 1);
  const failed = await fixture(t, { status: 402, response: { api_key: secret, message: "PRIVATE_PROVIDER_ERROR_CANARY" } });
  await assert.rejects(failed.adapter.dispatch(approved, new AbortController().signal), error => { assert.equal(String(error).includes(secret), false); assert.equal(String(error).includes("CANARY"), false); return String(error).includes("privacy_http_failed"); }); assert.equal(failed.captures.length, 1);
  const malformed = await fixture(t, { response: { choices: [{ message: { content: "```json\n{\"text\":\"must not repair\",\n```" } }] } }); await assert.rejects(malformed.adapter.dispatch(approved, new AbortController().signal), /operator_provider_delivery_unknown/); assert.equal(malformed.captures.length, 1);
});

test("operator configured provider endpoint/model/credential/version drift rejects before transport and never selects replacement", async t => {
  const changes = [{ key: "BETTERME_CAREER_PRIVACY_BASE_URL", value: "https://changed-synthetic.invalid/v1" }, { key: "BETTERME_CAREER_PRIVACY_MODEL", value: "other-model" }, { key: "BETTERME_CAREER_PRIVACY_RUNTIME_VERSION", value: "changed-revision" }, { key: "SYNTHETIC_EXISTING_PROVIDER_KEY", value: "SYNTHETIC_ROTATED_EXISTING_KEY_86213" }] as const;
  for (const change of changes) { const f = await fixture(t); await f.adapter.binding(); f.env[change.key] = change.value; await assert.rejects(f.adapter.dispatch(approved, new AbortController().signal), /operator_provider_binding_changed/); assert.equal(f.captures.length, 0); }
});

test("operator configured provider real in-flight credential rotation and caller cancellation reject late results", async t => {
  const wait = deferred<void>(), f = await fixture(t, { wait: wait.promise }); await f.adapter.binding(); const pending = f.adapter.dispatch(approved, new AbortController().signal); await f.started.promise; f.env.SYNTHETIC_EXISTING_PROVIDER_KEY = "SYNTHETIC_ROTATED_KEY_692315"; wait.resolve(); await assert.rejects(pending, /operator_provider_binding_changed/); assert.equal(f.captures.length, 1);
  const hold = deferred<void>(), g = await fixture(t, { wait: hold.promise }), controller = new AbortController(), cancelled = g.adapter.dispatch(approved, controller.signal); await g.started.promise; controller.abort(); hold.resolve(); await assert.rejects(cancelled, /privacy_cancelled/); assert.equal(g.captures.length, 1);
});

test("operator configured provider output bounds, cited source ids, generated secrets and tool calls fail closed", async t => {
  const responses = [{ choices: [{ message: { content: JSON.stringify({ text: "Unsupported source.", sourceIds: ["invented-fact"], unknowns: [] }) } }] }, { choices: [{ message: { content: JSON.stringify({ text: 'api_key="SYNTHETIC_REINTRODUCED_SECRET_95123"', sourceIds: ["fact-1"], unknowns: [] }) } }] }, { choices: [{ finish_reason: "tool_calls", message: { content: "{}", tool_calls: [{ function: { name: "read_private_file" } }] } }] }, { choices: [{ finish_reason: "length", message: { content: "{}" } }] }];
  for (const response of responses) { const f = await fixture(t, { response }); await assert.rejects(f.adapter.dispatch(approved, new AbortController().signal)); assert.equal(f.captures.length, 1); }
  let requests = 0; const resolver = createConfiguredPrivacyProviderFromEnvironment({ environment: environment(), maxInputBytes: 10, fetch: async () => { requests++; return new Response("{}"); } })!; const tiny = (await resolver(reference))!; await assert.rejects(tiny.dispatch(approved, new AbortController().signal), /operator_provider_input_limit/); assert.equal(requests, 0);
});
