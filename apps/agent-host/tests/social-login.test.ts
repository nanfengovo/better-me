import assert from "node:assert/strict";
import test from "node:test";
import { SocialLoginCatalogModule, unconfiguredSocialLogin } from "../src/identity/social-login.js";
import { SocialLoginCatalogSchema, SOCIAL_PROVIDERS } from "@better-me/agent-contracts";

const options = { issuer: "https://identity.example", clientId: "fixture-client", callbackUrl: "https://betterme.example/api/v1/agent/identity/oidc/callback" };
const provider = (type: string, extra: Record<string, unknown> = {}, item: Record<string, unknown> = {}) => ({ name: "fixture-" + type,
  canSignIn: true, canSignUp: true, bindingRule: [], ...item,
  provider: { name: "fixture-" + type, category: "OAuth", type, clientId: "private-client-id", clientSecret: "never-export-this-secret", ...extra } });
const application = () => ({ clientId: options.clientId, signinMethods: [{ name: "Password" }], providers: SOCIAL_PROVIDERS.map(value => provider(value.type)) });

test("catalog discovers all allow-listed configured platforms through the fixed public Casdoor endpoint without exposing credentials", async () => {
  let requested: URL | undefined;
  const module = new SocialLoginCatalogModule(options, async (input, init) => {
    requested = new URL(String(input));
    assert.equal(init?.credentials, "omit"); assert.equal(init?.redirect, "error");
    return Response.json({ status: "ok", data: application() });
  });
  const result = SocialLoginCatalogSchema.parse(await module.list());
  assert.deepEqual(result.channels.map(value => value.state), Array(SOCIAL_PROVIDERS.length).fill("available"));
  assert.equal(result.unifiedLoginAvailable, true);
  assert.equal(requested?.origin, options.issuer); assert.equal(requested?.pathname, "/api/get-app-login");
  assert.equal(requested?.searchParams.get("redirectUri"), options.callbackUrl);
  assert.ok(!JSON.stringify(result).includes("never-export")); assert.ok(!JSON.stringify(result).includes("private-client"));
  assert.equal(await module.resolve("github"), "fixture-GitHub");
  assert.equal(await module.resolve("microsoft"), "fixture-AzureAD");
  assert.equal(await module.resolve("gitlab"), "fixture-GitLab");
  assert.equal(await module.resolve("discord"), "fixture-Discord");
});

test("optional international platforms appear only when actually configured, and require exact pinned adapter types", async () => {
  const app = application();
  app.providers = SOCIAL_PROVIDERS.filter(value => value.primary).map(value => provider(value.type));
  const module = new SocialLoginCatalogModule(options, async () => Response.json({ status: "ok", data: app }));
  const primaryIds = SOCIAL_PROVIDERS.filter(value => value.primary).map(value => value.id);
  assert.deepEqual((await module.list()).channels.map(channel => channel.id), primaryIds);
  assert.deepEqual(unconfiguredSocialLogin().channels.map(channel => channel.id), primaryIds);
  await assert.rejects(module.resolve("microsoft"), /social_provider_unavailable/);
  app.providers.push(provider("Microsoft"));
  await assert.rejects(module.resolve("microsoft"), /social_provider_unavailable/, "a display name is not the AzureAD adapter");
  app.providers.push(provider("AzureAD", { clientSecret: "" }));
  await assert.rejects(module.resolve("microsoft"), /social_provider_unavailable/);
  assert.equal((await module.list()).channels.find(channel => channel.id === "microsoft")?.state, "not_configured");
  app.providers[5] = provider("AzureAD");
  assert.equal(await module.resolve("microsoft"), "fixture-AzureAD");
  app.providers[5]!.canSignIn = false;
  await assert.rejects(module.resolve("microsoft"), /social_provider_unavailable/);
});

test("the public catalog accepts legacy primary channels but rejects duplicates, omissions and unknown providers", async () => {
  const legacy = unconfiguredSocialLogin();
  assert.ok(SocialLoginCatalogSchema.safeParse(legacy).success);
  assert.equal(SocialLoginCatalogSchema.safeParse({ ...legacy, channels: [...legacy.channels.slice(0, 3), legacy.channels[0]] }).success, false);
  assert.equal(SocialLoginCatalogSchema.safeParse({ ...legacy, channels: [...legacy.channels, { ...legacy.channels[0], id: "unknown" }] }).success, false);
  assert.equal(SocialLoginCatalogSchema.safeParse({ ...legacy, channels: legacy.channels.slice(1) }).success, false);
});

test("missing credentials, disabled channels, default automatic binding and incompatible WeChat contexts fail closed", async () => {
  const app = application();
  app.providers = [provider("WeChat", { subType: "Mobile", clientId2: "mobile", clientSecret2: "***" }),
    provider("QQ", {}, { canSignIn: false }), provider("GitHub", {}, { bindingRule: ["Email"] }), provider("Google", { clientSecret: "" })];
  const module = new SocialLoginCatalogModule(options, async () => Response.json({ status: "ok", data: app }));
  const browser = await module.list();
  assert.deepEqual(browser.channels.map(value => value.state), ["unsupported_context", "disabled", "unsafe_binding", "not_configured"]);
  assert.equal(browser.unifiedLoginAvailable, false);
  assert.equal((await module.list("MicroMessenger")).channels[0]?.state, "unsafe_binding");
  await assert.rejects(module.resolve("github"), /social_provider_unavailable/);
  await assert.rejects(module.resolve(undefined), /social_provider_unavailable/);
  await assert.rejects(module.resolve("wechat", "MicroMessenger"), /social_provider_unavailable/);
  app.providers[2] = provider("GitHub", {}, { bindingRule: null });
  await assert.rejects(module.resolve("github"), /social_provider_unavailable/, "unspecified upstream auto-binding is not safe by default");
  app.providers[2] = provider("GitHub");
  assert.equal(await module.resolve("wechat", "MicroMessenger"), "fixture-WeChat");
});

test("unsafe providers outside the allow-listed shortcuts also block broker fallback until fixed or disabled", async () => {
  const app = application();
  app.providers.push(provider("Gitee", {}, { bindingRule: ["Phone"] }));
  const module = new SocialLoginCatalogModule(options, async () => Response.json({ status: "ok", data: app }));
  assert.ok((await module.list()).channels.every(channel => channel.state === "unsafe_binding"));
  await assert.rejects(module.resolve("google"), /social_provider_unavailable/);
  app.providers.at(-1)!.canSignIn = false;
  assert.equal(await module.resolve("google"), "fixture-Google");
});

test("catalog is installation-scoped, coalesced and briefly cached; starting a flow rereads disabled channels", async () => {
  let calls = 0, now = 0;
  const app = application();
  const module = new SocialLoginCatalogModule(options, async () => { calls++; return Response.json({ status: "ok", data: app }); }, () => now);
  await Promise.all(Array.from({ length: 8 }, () => module.list())); assert.equal(calls, 1);
  await module.list(); assert.equal(calls, 1);
  now = 10_001; await module.list(); assert.equal(calls, 2);
  app.providers[2]!.canSignIn = false;
  await assert.rejects(module.resolve("github"), /social_provider_unavailable/); assert.equal(calls, 3);
  assert.equal((await module.list()).channels[2]?.state, "disabled");
});

test("unconfigured, offline, malformed, redirected, oversized or wrong-client responses never advertise live channels", async () => {
  assert.equal(SocialLoginCatalogSchema.parse(unconfiguredSocialLogin()).service, "not_configured");
  const fetchers: (typeof fetch)[] = [async () => { throw new Error("private network detail"); },
    async () => new Response("not JSON"), async () => Response.json({ status: "error", msg: "private" }),
    async () => new Response("x".repeat(256 * 1024 + 1)),
    async () => Response.json({ status: "ok", data: { ...application(), clientId: "another-client" } })];
  for (const fetcher of fetchers) {
    const module = new SocialLoginCatalogModule(options, fetcher);
    const result = await module.list();
    assert.equal(result.service, "offline"); assert.ok(result.channels.every(channel => channel.state === "unavailable"));
    assert.ok(!JSON.stringify(result).includes("private"));
    await assert.rejects(module.resolve("google"), /oidc_service_unavailable/);
  }
});

test("organization and application sign-in bans apply to both direct and unified login", async () => {
  for (const ban of [{ disableSignin: true }, { organizationObj: { disableSignin: true } }]) {
    const module = new SocialLoginCatalogModule(options, async () => Response.json({ status: "ok", data: { ...application(), ...ban } }));
    const catalog = await module.list(); assert.equal(catalog.unifiedLoginAvailable, false);
    assert.ok(catalog.channels.every(channel => channel.state === "disabled"));
    await assert.rejects(module.resolve("qq"), /social_provider_unavailable/);
  }
});
