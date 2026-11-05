import http from "node:http";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { SOCIAL_PROVIDERS } from "@better-me/agent-contracts";

/** Signed loopback-only fictional IdP. No real OAuth supplier, identity, key or inference request. */
export async function socialIdp(callbackUrl: string) {
  const keys = await generateKeyPair("RS256"), publicKey = { ...await exportJWK(keys.publicKey), kid: "social-fixture", alg: "RS256", use: "sig" };
  const flows = new Map<string, URL>(), codes = new Map<string, { auth: URL; subject: string }>();
  const controls = { offline: false, disabled: new Set<string>() };
  let issuer = "";
  function issue(auth: URL, subject = "synthetic-alice") {
    const code = randomUUID(); codes.set(code, { auth, subject });
    return new URLSearchParams({ code, state: auth.searchParams.get("state")! }).toString();
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store");
    if (url.pathname === "/api/get-app-login") {
      if (controls.offline) { res.statusCode = 503; return res.end("{}"); }
      if (url.searchParams.get("clientId") !== "social-fixture" || url.searchParams.get("redirectUri") !== callbackUrl) { res.statusCode = 400; return res.end("{}"); }
      return res.end(JSON.stringify({ status: "ok", data: { clientId: "social-fixture", signinMethods: [{ name: "Password" }],
        providers: SOCIAL_PROVIDERS.map(provider => ({ name: "fixture-" + provider.id, canSignIn: !controls.disabled.has(provider.id), canSignUp: true, bindingRule: [],
          provider: { name: "fixture-" + provider.id, category: "OAuth", type: provider.type, clientId: "synthetic-client", clientSecret: "***" } })) } }));
    }
    if (url.pathname === "/.well-known/openid-configuration") return res.end(JSON.stringify({ issuer, authorization_endpoint: issuer + "/authorize",
      token_endpoint: issuer + "/token", jwks_uri: issuer + "/jwks", response_types_supported: ["code"], subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"], token_endpoint_auth_methods_supported: ["client_secret_post"], code_challenge_methods_supported: ["S256"] }));
    if (url.pathname === "/jwks") return res.end(JSON.stringify({ keys: [publicKey] }));
    if (url.pathname === "/authorize") {
      if (url.searchParams.get("redirect_uri") !== callbackUrl) { res.statusCode = 400; return res.end("{}"); }
      const flow = randomUUID(); flows.set(flow, url);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end(`<meta name="viewport" content="width=device-width,initial-scale=1"><h1>合成身份授权页</h1><p>仅验收协议，不调用真实社交平台。</p><p>渠道：${SOCIAL_PROVIDERS.find(provider => "fixture-" + provider.id === url.searchParams.get("provider_hint"))?.label ?? "统一账号"}</p><p><a href="/choose?flow=${flow}&person=alice">授权 Synthetic Alice</a></p><p><a href="/choose?flow=${flow}&person=bob">授权 Synthetic Bob</a></p><p><a href="/choose?flow=${flow}&person=cancel">取消授权</a></p>`);
    }
    if (url.pathname === "/choose") {
      const flow = url.searchParams.get("flow") ?? "", auth = flows.get(flow); flows.delete(flow);
      if (!auth) { res.statusCode = 400; return res.end("{}"); }
      const query = url.searchParams.get("person") === "cancel" ? new URLSearchParams({ error: "access_denied", state: auth.searchParams.get("state")! }).toString()
        : issue(auth, url.searchParams.get("person") === "bob" ? "synthetic-bob" : "synthetic-alice");
      res.writeHead(303, { Location: callbackUrl + "?" + query }); return res.end();
    }
    if (url.pathname === "/account") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end(`<h1>合成统一账号中心</h1><p>已验证身份，仅测试管理跳转；此页不提供真实绑定。</p><a href="${new URL(callbackUrl).origin}">返回合成 BetterMe</a>`);
    }
    if (url.pathname !== "/token" || req.method !== "POST") { res.statusCode = 404; return res.end("{}"); }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = new URLSearchParams(Buffer.concat(chunks).toString()), code = body.get("code") ?? "", entry = codes.get(code); codes.delete(code);
    if (!entry || body.get("client_secret") !== "social-fixture-secret" || body.get("redirect_uri") !== callbackUrl
      || createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url") !== entry.auth.searchParams.get("code_challenge")) {
      res.statusCode = 400; return res.end(JSON.stringify({ error: "invalid_grant" }));
    }
    const token = await new SignJWT({ name: entry.subject === "synthetic-alice" ? "Synthetic Alice" : "Synthetic Bob", nonce: entry.auth.searchParams.get("nonce") })
      .setProtectedHeader({ alg: "RS256", kid: "social-fixture" }).setIssuer(issuer).setSubject(entry.subject).setAudience("social-fixture").setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
    res.end(JSON.stringify({ token_type: "Bearer", access_token: "synthetic-only", id_token: token }));
  }).listen(0, "127.0.0.1");
  await once(server, "listening"); const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_not_listening"); issuer = `http://127.0.0.1:${address.port}`;
  return { issuer, controls, issue, options: { issuer, clientId: "social-fixture", clientSecret: "social-fixture-secret", callbackUrl, allowLoopbackHttp: true },
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
