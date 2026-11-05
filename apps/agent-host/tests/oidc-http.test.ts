import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { MemorySaver } from "@langchain/langgraph";
import { createAgentServer } from "../src/server.js";
import { registerTestIdentity } from "./fixtures/identity.js";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
test("OIDC verifies real signed tokens, PKCE and browser state; linking preserves owner and late callbacks cannot switch accounts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-oidc-http-"));
  const keys = await generateKeyPair("RS256"), publicKey = { ...await exportJWK(keys.publicKey), kid: "fixture", alg: "RS256", use: "sig" };
  let issuer = "", subject = "fixture-alice", wrongNonce = false, wrongAudience = false, wrongSignature = false, wrongIssuer = false, tokenCalls = 0;
  let delayed: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
  const codes = new Map<string, URL>();
  const idp = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url?.startsWith("/api/get-app-login?")) return res.end(JSON.stringify({ status: "ok", data: {
      clientId: "fixture-client", signinMethods: [{ name: "Password" }], providers: ["WeChat", "QQ", "GitHub", "Google"].map(type => ({ name: "fixture-" + type,
        canSignIn: true, canSignUp: true, bindingRule: [], provider: { name: "fixture-" + type, category: "OAuth", type, clientId: "fixture", clientSecret: "***" } })) } }));
    if (req.url === "/.well-known/openid-configuration") return res.end(JSON.stringify({ issuer, authorization_endpoint: issuer + "/authorize", token_endpoint: issuer + "/token", jwks_uri: issuer + "/jwks",
      response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"], token_endpoint_auth_methods_supported: ["client_secret_post"], code_challenge_methods_supported: ["S256"] }));
    if (req.url === "/jwks") return res.end(JSON.stringify({ keys: [publicKey] }));
    if (req.url !== "/token") { res.statusCode = 404; return res.end("{}"); }
    tokenCalls++;
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = new URLSearchParams(Buffer.concat(chunks).toString()), auth = codes.get(body.get("code") ?? "");
    if (!auth || createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url") !== auth.searchParams.get("code_challenge") || body.get("client_secret") !== "fixture-secret") {
      res.statusCode = 400; return res.end(JSON.stringify({ error: "invalid_grant" }));
    }
    if (delayed) { delayed.entered.resolve(); await delayed.release.promise; }
    const signer = wrongSignature ? (await generateKeyPair("RS256")).privateKey : keys.privateKey;
    const token = await new SignJWT({ nonce: wrongNonce ? "wrong" : auth.searchParams.get("nonce"), name: "fixture" })
      .setProtectedHeader({ alg: "RS256", kid: "fixture" }).setIssuer(wrongIssuer ? "https://attacker.invalid" : issuer).setSubject(subject).setAudience(wrongAudience ? "attacker" : "fixture-client").setIssuedAt().setExpirationTime("5m").sign(signer);
    res.end(JSON.stringify({ token_type: "Bearer", access_token: "synthetic-only", id_token: token }));
  }).listen(0, "127.0.0.1");
  await once(idp, "listening"); const ia = idp.address(); assert.ok(ia && typeof ia !== "string"); issuer = `http://127.0.0.1:${ia.port}`;
  const frontend = "http://localhost:5173", callback = frontend + "/api/v1/agent/identity/oidc/callback";
  const server = createAgentServer({ port: 0, host: "127.0.0.1", allowedOrigins: [frontend], authToken: "fixture", identityDirectory: directory,
    checkpointer: new MemorySaver() as never, runtimeDefinitions: [], oidc: { issuer, clientId: "fixture-client", clientSecret: "fixture-secret", callbackUrl: callback, allowLoopbackHttp: true } });
  await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string"); const origin = `http://127.0.0.1:${address.port}`;
  const call = (route: string, body?: unknown, headers: Record<string, string> = {}) => fetch(origin + "/api/v1/agent/identity/" + route, {
    method: body ? "POST" : "GET", headers: { Authorization: "Bearer fixture", Origin: frontend, "Content-Type": "application/json", ...headers }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: "manual" });
  let channelIndex = 0;
  const begin = async (headers: Record<string, string> = {}, link = false) => {
    const provider = ["wechat", "qq", "github", "google"][channelIndex++ % 4];
    const response = await call("oidc/start", { intent: link ? "link" : "login", provider, ...(link ? { password: "synthetic-only-password-2026" } : {}) }, headers);
    assert.equal(response.status, 200, await response.clone().text());
    const url = new URL((await response.json()).url), cookie = response.headers.getSetCookie()[0]!.split(";")[0]!;
    assert.equal(url.searchParams.get("code_challenge_method"), "S256"); assert.ok(url.searchParams.get("nonce"));
    assert.equal(url.searchParams.get("provider_hint"), "fixture-" + ({ wechat: "WeChat", qq: "QQ", github: "GitHub", google: "Google" }[provider!]));
    const code = String(codes.size); codes.set(code, url);
    return { cookie, query: `?code=${code}&state=${url.searchParams.get("state")}`, code };
  };
  const finish = (flow: Awaited<ReturnType<typeof begin>>, cookie = flow.cookie) => fetch(origin + "/api/v1/agent/identity/oidc/callback" + flow.query, { headers: { Cookie: cookie }, redirect: "manual" });
  try {
    const alice = await registerTestIdentity(origin, "fixture", "alice", frontend), bob = await registerTestIdentity(origin, "fixture", "bob", frontend);
    const link = await begin(alice.headers, true); assert.equal((await finish(link)).status, 303);
    assert.equal((await finish(link)).status, 400, "authorization callback is single-use");
    const flow = await begin(); const done = await finish(flow); assert.equal(done.status, 303);
    const cookie = done.headers.getSetCookie().find(value => value.startsWith("betterme_session="))!.split(";")[0]!;
    assert.equal((await (await call("session", undefined, { Cookie: cookie })).json()).principal.id, alice.principal.id);
    const forged = await begin(); const count = tokenCalls;
    assert.equal((await finish({ ...forged, query: forged.query.replace(/state=.*/, "state=forged") })).status, 400); assert.equal(tokenCalls, count);
    assert.equal((await finish(forged, "")).status, 400);
    for (const failure of ["nonce", "audience", "signature", "issuer"]) {
      wrongNonce = failure === "nonce"; wrongAudience = failure === "audience"; wrongSignature = failure === "signature"; wrongIssuer = failure === "issuer";
      const next = await begin(failure === "nonce" ? { Cookie: forged.cookie } : {});
      if (failure === "nonce") assert.equal((await finish(forged)).status, 400, "a newer attempt invalidates the previous attempt for this browser");
      const rejected = await finish(next); assert.equal(rejected.status, 400, failure); assert.equal(rejected.headers.getSetCookie().some(value => value.startsWith("betterme_session=")), false);
    }
    wrongNonce = wrongAudience = wrongSignature = wrongIssuer = false;
    delayed = { entered: deferred(), release: deferred() }; const late = await begin(); const pending = finish(late); await delayed.entered.promise;
    const switchAccount = await call("sign-in", { username: "bob", password: "synthetic-only-password-2026" }, { Cookie: late.cookie }); assert.equal(switchAccount.status, 200);
    delayed.release.resolve(); const rejected = await pending;
    assert.equal(rejected.status, 400); assert.equal(rejected.headers.getSetCookie().some(value => value.startsWith("betterme_session=")), false);
    assert.equal((await (await call("session", undefined, bob.headers)).json()).principal.id, bob.principal.id);
    subject = "different-person"; const other = await finish(await begin()); const otherCookie = other.headers.getSetCookie().find(value => value.startsWith("betterme_session="))!.split(";")[0]!;
    assert.notEqual((await (await call("session", undefined, { Cookie: otherCookie })).json()).principal.id, alice.principal.id);
    delayed = { entered: deferred(), release: deferred() };
    const logoutFlow = await begin(alice.headers, true), pendingLink = finish(logoutFlow); await delayed.entered.promise;
    const logout = await call("sign-out", {}, { ...alice.headers, Cookie: alice.headers.Cookie + "; " + logoutFlow.cookie }); assert.equal(logout.status, 200);
    delayed.release.resolve(); const abandoned = await pendingLink;
    assert.equal(abandoned.status, 400); assert.equal(abandoned.headers.getSetCookie().some(value => value.startsWith("betterme_session=")), false);
  } finally {
    delayed?.release.resolve(); server.closeAllConnections(); idp.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => idp.close(() => resolve()))]);
    await rm(directory, { recursive: true, force: true });
  }
});
