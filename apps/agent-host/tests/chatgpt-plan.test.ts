import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ChatGptPlanService } from "../src/chatgpt/service.js";
import { chatGptProviderFixture } from "./fixtures/chatgpt-provider.js";

async function fixture(t: { after: (fn: () => Promise<void>) => void }, timeoutMs?: number) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-chatgpt-test-"));
  const provider = await chatGptProviderFixture();
  const service = new ChatGptPlanService({ directory, fetch: provider.fetch, authorizationTimeoutMs: timeoutMs });
  t.after(async () => { service.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { directory, provider, service };
}
const request = (profileId: string) => ({ profileId, model: "fixture-gpt", instructions: "Synthetic instructions", input: [{ role: "user" as const, content: "Synthetic question" }] });

test("OAuth validates PKCE, signed identity, stable host and scoped token storage without exposing credentials", async t => {
  const { directory, provider, service } = await fixture(t);
  assert.deepEqual((await service.state()).profiles, []); assert.equal(provider.calls.length, 0);
  const login = await provider.login(service); assert.equal(login.response.status, 200); assert.equal(login.state.attempt?.phase, "completed");
  const profile = login.state.profiles[0]!; assert.equal(profile.state, "connected");
  assert.equal(login.url.searchParams.get("client_id"), "dynamic_agent_client"); assert.equal(login.url.searchParams.get("agent_name_hint"), "BetterMe");
  assert.equal(login.url.searchParams.get("code_challenge_method"), "S256"); assert.ok(login.url.searchParams.get("code_challenge"));
  assert.ok(login.url.searchParams.get("scope")?.includes("chatgpt.tokens.use.direct"));
  const tokenCall = provider.calls.find(call => call.url.endsWith("/oauth/token"))!;
  const form = new URLSearchParams(String(tokenCall.init?.body)); assert.equal(form.get("client_id"), "oaiapp_fixture"); assert.ok(form.get("code_verifier")); assert.equal(form.get("redirect_uri"), login.url.searchParams.get("redirect_uri"));
  assert.doesNotMatch(JSON.stringify(login.state), /FICTIONAL_ACCESS|FICTIONAL_REFRESH|id_token|access_token|refresh_token/);
  if (process.platform !== "win32") { assert.equal((await stat(path.join(directory, "accounts.json"))).mode & 0o777, 0o600); assert.equal((await stat(directory)).mode & 0o777, 0o700); }
  assert.equal((await service.models(profile.id))[0]?.slug, "fixture-gpt");
  const result = await service.respond(request(profile.id), new AbortController().signal); assert.equal(result.text, "Synthetic answer only");
  const wire = JSON.parse(String(provider.calls.find(call => call.url.endsWith("/responses"))!.init?.body));
  assert.equal(wire.store, false); assert.equal(wire.stream, true); assert.equal(wire.temperature, undefined); assert.equal(wire.max_output_tokens, undefined); assert.ok(Array.isArray(wire.input));
  assert.ok((await service.state()).profiles[0]?.lastCompletedAt);
  const host = login.url.searchParams.get("ext_agent_host_id");
  await service.signOut(profile.id);
  const returning = await provider.login(service, profile.id); assert.equal(returning.url.searchParams.get("ext_agent_host_id"), host); assert.equal(returning.url.searchParams.get("client_id"), "oaiapp_fixture"); assert.equal(returning.url.searchParams.has("agent_name_hint"), false);
  const stored = JSON.parse(await readFile(path.join(directory, "accounts.json"), "utf8")); assert.equal(stored.profiles.length, 1);
});

for (const invalid of ["state", "nonce", "signature", "audience", "subject", "client"] as const) test(`OAuth rejects ${invalid} mismatch without replacing an existing account`, async t => {
  const { provider, service } = await fixture(t); const initial = await provider.login(service); const id = initial.state.profiles[0]!.id;
  const launch = await service.startSignIn(id); const { callback } = provider.prepare(launch.authorizationUrl);
  if (invalid === "state") callback.searchParams.set("state", "different");
  if (invalid === "nonce") provider.settings.nonce = "different";
  if (invalid === "signature") provider.settings.badSignature = true;
  if (invalid === "audience") provider.settings.audience = "oaiapp_wrong";
  if (invalid === "subject") provider.settings.subject = "another-person";
  if (invalid === "client") callback.searchParams.set("client_id", "oaiapp_wrong");
  const response = await fetch(callback); assert.equal(response.status, 400); await response.text();
  const next = await service.state(); assert.equal(next.profiles[0]?.id, id); assert.equal(next.profiles[0]?.state, "connected");
  assert.equal(provider.authCount, invalid === "state" || invalid === "client" ? 1 : 2);
});

test("declined consent and explicit cancellation do not exchange a token or send inference", async t => {
  const { provider, service } = await fixture(t);
  const launch = await service.startSignIn(); const { callback } = provider.prepare(launch.authorizationUrl); callback.searchParams.delete("code"); callback.searchParams.set("error", "access_denied");
  await (await fetch(callback)).text(); assert.equal((await service.state()).attempt?.phase, "cancelled"); assert.equal(provider.authCount, 0);
  const next = await service.startSignIn(); service.cancelSignIn(next.attemptId); assert.equal((await service.state()).attempt?.phase, "cancelled");
  assert.equal(provider.calls.filter(call => call.url.endsWith("/responses")).length, 0);
});

test("authorization wait expires without token exchange and can be explicitly restarted", async t => {
  const { provider, service } = await fixture(t, 25);
  const launch = await service.startSignIn();
  for (let i = 0; i < 100 && (await service.state()).attempt?.phase !== "expired"; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await service.state()).attempt?.phase, "expired"); assert.equal(provider.authCount, 0);
  const restarted = await service.startSignIn(); assert.notEqual(restarted.attemptId, launch.attemptId); service.cancelSignIn(restarted.attemptId);
});

test("stopping an account response rejects late output without trying another model", async t => {
  const { provider, service } = await fixture(t); const login = await provider.login(service);
  provider.settings.responseDelayMs = 200;
  const controller = new AbortController(); const pending = service.respond(request(login.state.profiles[0]!.id), controller.signal);
  for (let i = 0; i < 100 && !provider.calls.some(call => call.url.endsWith("/responses")); i++) await new Promise(resolve => setTimeout(resolve, 2));
  controller.abort(); await assert.rejects(pending, /已停止/);
  assert.equal(provider.calls.filter(call => call.url.endsWith("/responses")).length, 1); assert.equal((await service.state()).profiles[0]?.lastCompletedAt, undefined);
});

test("missing plan scope keeps identity signed in but refuses model requests", async t => {
  const { provider, service } = await fixture(t); provider.settings.scopes = "openid profile email";
  const login = await provider.login(service); const profile = login.state.profiles[0]!; assert.equal(profile.state, "plan-disabled");
  await assert.rejects(service.respond(request(profile.id), new AbortController().signal), /尚未允许/);
  assert.equal(provider.calls.filter(call => call.url.includes("api.openai.com")).length, 0);
});

test("concurrent expiry refresh is serialized and tokens rotate together", async t => {
  const { directory, provider, service } = await fixture(t); provider.settings.expiresIn = 1;
  const login = await provider.login(service); provider.settings.expiresIn = 3600;
  const id = login.state.profiles[0]!.id;
  await Promise.all([service.models(id), service.models(id), service.models(id)]); assert.equal(provider.refreshCount, 1);
  const stored = JSON.parse(await readFile(path.join(directory, "accounts.json"), "utf8"));
  assert.equal(stored.profiles[0].tokens.accessToken, "FICTIONAL_ACCESS_1"); assert.equal(stored.profiles[0].tokens.refreshToken, "FICTIONAL_REFRESH_1");
});

test("terminal refresh revocation requires reauth while transient failures preserve credentials", async t => {
  const { provider, service } = await fixture(t); provider.settings.expiresIn = 1;
  const login = await provider.login(service); const id = login.state.profiles[0]!.id;
  provider.settings.tokenError = "temporarily_unavailable"; await assert.rejects(service.models(id)); assert.equal((await service.state()).profiles[0]?.state, "connected");
  provider.settings.tokenError = "invalid_grant"; await assert.rejects(service.models(id)); assert.equal((await service.state()).profiles[0]?.state, "reauth-required");
});

for (const mode of ["http-limit", "stream-limit", "incomplete", "interrupted", "removed-model", "ineligible"] as const) test(`truthful ${mode} outcome never invokes a fallback`, async t => {
  const { provider, service } = await fixture(t); const login = await provider.login(service); const id = login.state.profiles[0]!.id;
  if (mode === "http-limit") { provider.settings.responseStatus = 429; provider.settings.errorCode = "subscription_sharing_usage_limit_exceeded"; }
  if (mode === "stream-limit") provider.settings.errorCode = "subscription_sharing_usage_limit_exceeded";
  if (mode === "ineligible") { provider.settings.responseStatus = 403; provider.settings.errorCode = "subscription_sharing_user_not_eligible"; }
  if (mode === "incomplete") provider.settings.incomplete = true;
  if (mode === "interrupted") provider.settings.noTerminal = true;
  if (mode === "removed-model") provider.settings.modelRemoved = true;
  await assert.rejects(service.respond(request(id), new AbortController().signal));
  const state = await service.state(); assert.equal(state.profiles[0]?.lastCompletedAt, undefined); assert.equal(state.automaticBillingFallback, false);
  assert.doesNotMatch(JSON.stringify(state), /NEVER_EXPOSE|FICTIONAL_ACCESS|FICTIONAL_REFRESH/);
  const count = provider.calls.filter(call => call.url.endsWith("/responses")).length;
  if (mode.includes("limit") || mode === "ineligible") { await assert.rejects(service.respond(request(id), new AbortController().signal)); assert.equal(provider.calls.filter(call => call.url.endsWith("/responses")).length, count); }
  assert.ok(provider.calls.every(call => !call.url.includes("chat/completions") && !call.url.includes("backend-api")));
});

test("sign out revokes refresh session, preserves registration, and reports remote revocation failure", async t => {
  const { provider, service } = await fixture(t); const login = await provider.login(service); const id = login.state.profiles[0]!.id;
  provider.settings.revokeFails = true; const result = await service.signOut(id); assert.equal(result.remoteRevoked, false);
  assert.equal((await service.state()).profiles[0]?.state, "signed-out");
  await assert.rejects(service.respond(request(id), new AbortController().signal), /登录授权/);
});
