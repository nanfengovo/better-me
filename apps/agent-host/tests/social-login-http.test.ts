import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { SocialLoginCatalogSchema, SOCIAL_PROVIDERS } from "@better-me/agent-contracts";
import { createAgentServer } from "../src/server.js";
import { registerTestIdentity } from "./fixtures/identity.js";
import { socialIdp } from "./fixtures/social-idp.js";

async function createHarness(t: TestContext) {
  const frontend = "http://localhost:5383", callback = frontend + "/api/v1/agent/identity/oidc/callback";
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-social-http-"));
  let idp: Awaited<ReturnType<typeof socialIdp>> | undefined, server: ReturnType<typeof createAgentServer> | undefined;
  t.after(async () => {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    await idp?.close(); await rm(directory, { recursive: true, force: true });
  });
  idp = await socialIdp(callback);
  server = createAgentServer({ port: 0, host: "127.0.0.1", allowedOrigins: [frontend], authToken: "fixture", identityDirectory: directory,
    checkpointer: new MemorySaver() as never, runtimeDefinitions: [], oidc: idp.options });
  await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const call = (route: string, body?: unknown, headers: Record<string, string> = {}) => fetch(origin + "/api/v1/agent/identity/" + route, {
    method: body ? "POST" : "GET", headers: { Authorization: "Bearer fixture", Origin: frontend, "Content-Type": "application/json", ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}), redirect: "manual" });
  const begin = async (body: unknown, headers: Record<string, string> = {}) => {
    const response = await call("oidc/start", body, headers); assert.equal(response.status, 200, await response.clone().text());
    return { auth: new URL((await response.json()).url), browser: response.headers.getSetCookie()[0]!.split(";")[0]! };
  };
  const finish = (flow: Awaited<ReturnType<typeof begin>>, person = "synthetic-alice") => fetch(origin + "/api/v1/agent/identity/oidc/callback?" + idp.issue(flow.auth, person), {
    headers: { Cookie: flow.browser }, redirect: "manual" });
  return { origin, frontend, issuer: idp.issuer, call, begin, finish };
}

test("primary social entry points reuse one bound owner; management reauth cannot switch or link another identity", async t => {
    const { origin, frontend, issuer, call, begin, finish } = await createHarness(t);
    const catalog = SocialLoginCatalogSchema.parse(await (await call("providers")).json()); assert.ok(catalog.channels.every(channel => channel.state === "available"));
    const local = await registerTestIdentity(origin, "fixture", "local-alice", frontend);
    assert.deepEqual(await (await call("account", undefined, local.headers)).json(), { localPassword: true, unifiedLinked: false });
    assert.equal((await call("account")).status, 401);
    assert.equal((await call("account", undefined, { ...local.headers, "X-BetterMe-Owner": "wrong-owner" })).status, 409);
    const linked = await begin({ intent: "link", provider: "github", password: "synthetic-only-password-2026" }, local.headers);
    assert.equal((await finish(linked)).status, 303);
    assert.deepEqual(await (await call("account", undefined, local.headers)).json(), { localPassword: true, unifiedLinked: true });
    for (const provider of SOCIAL_PROVIDERS.filter(value => value.primary)) {
      const flow = await begin({ intent: "login", provider: provider.id });
      assert.equal(flow.auth.searchParams.get("provider_hint"), "fixture-" + provider.id);
      assert.equal(flow.auth.searchParams.get("code_challenge_method"), "S256");
      const response = await finish(flow); assert.equal(response.status, 303);
      const cookie = response.headers.getSetCookie().find(value => value.startsWith("betterme_session="))!.split(";")[0]!;
      assert.equal((await (await call("session", undefined, { Cookie: cookie })).json()).principal.id, local.principal.id);
    }
    const wrong = await finish(await begin({ intent: "manage" }, local.headers), "synthetic-bob");
    assert.equal(wrong.status, 400); assert.equal(wrong.headers.getSetCookie().length, 0);
    const managed = await finish(await begin({ intent: "manage" }, local.headers));
    assert.equal(managed.status, 303); assert.equal(managed.headers.get("location"), issuer + "/account");
    assert.equal(managed.headers.getSetCookie().length, 0, "management is not a BetterMe sign-in");
    const bob = await finish(await begin({ intent: "login", provider: "google" }), "synthetic-bob");
    const bobCookie = bob.headers.getSetCookie().find(value => value.startsWith("betterme_session="))!.split(";")[0]!;
    const bobPrincipal = (await (await call("session", undefined, { Cookie: bobCookie })).json()).principal;
    assert.notEqual(bobPrincipal.id, local.principal.id, "a rejected management identity was not silently linked");
    const bobHeaders = { Cookie: bobCookie, "X-BetterMe-Owner": bobPrincipal.id };
    assert.deepEqual(await (await call("account", undefined, bobHeaders)).json(), { localPassword: false, unifiedLinked: true });
    assert.equal((await finish(await begin({ intent: "manage" }, bobHeaders), "synthetic-bob")).status, 303);
    assert.equal((await call("oidc/start", { intent: "login", provider: "https://attacker.invalid" })).status, 400);
});

test("configured international entry points pass the real HTTP schema and preserve one verified owner", async t => {
  const { call, begin, finish } = await createHarness(t);
  let owner: string | undefined;
  const catalog = SocialLoginCatalogSchema.parse(await (await call("providers")).json());
  for (const provider of SOCIAL_PROVIDERS.filter(value => !value.primary)) {
    assert.equal(catalog.channels.find(channel => channel.id === provider.id)?.state, "available");
    const flow = await begin({ intent: "login", provider: provider.id });
    assert.equal(flow.auth.searchParams.get("provider_hint"), "fixture-" + provider.id);
    assert.equal(flow.auth.searchParams.get("code_challenge_method"), "S256");
    const response = await finish(flow); assert.equal(response.status, 303);
    const cookie = response.headers.getSetCookie().find(value => value.startsWith("betterme_session="))!.split(";")[0]!;
    const principal = (await (await call("session", undefined, { Cookie: cookie })).json()).principal;
    owner ??= principal.id;
    assert.equal(principal.id, owner);
  }
  assert.equal((await call("oidc/start", { intent: "login", provider: "azure-client-id" })).status, 400);
});
