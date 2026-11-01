import { generateKeyPair, exportJWK, SignJWT } from "jose";
import type { ChatGptPlanService } from "../../src/chatgpt/service.js";

/** Cryptographically valid fictional OpenID provider. It never contacts OpenAI. */
export async function chatGptProviderFixture() {
  const key = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(key.publicKey), kid: "fixture-key", alg: "RS256", use: "sig" };
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const settings = { nonce: "", clientId: "oaiapp_fixture", subject: "fictional-user", audience: "", scopes: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    expiresIn: 3600, badSignature: false, tokenError: "", responseStatus: 200, errorCode: "", noTerminal: false, incomplete: false, modelRemoved: false, responseText: "Synthetic answer only", revokeFails: false, responseDelayMs: 0 };
  let refreshCount = 0, authCount = 0;
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input); calls.push({ url, init });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "x-request-id": "req_fixture" } });
    if (url === "https://auth.openai.com/.well-known/openid-configuration") return json({ issuer: "https://auth.openai.com", authorization_endpoint: "https://auth.openai.com/api/accounts/authorize", token_endpoint: "https://auth.openai.com/api/accounts/oauth/token", jwks_uri: "https://auth.openai.com/.well-known/jwks.json", revocation_endpoint: "https://auth.openai.com/api/accounts/oauth/revoke" });
    if (url === "https://auth.openai.com/.well-known/jwks.json") return json({ keys: [jwk] });
    if (url === "https://auth.openai.com/api/accounts/oauth/token") {
      const body = new URLSearchParams(String(init?.body));
      if (settings.tokenError) return json({ error: settings.tokenError }, 400);
      if (body.get("grant_type") === "refresh_token") refreshCount++; else authCount++;
      const privateKey = settings.badSignature ? (await generateKeyPair("RS256")).privateKey : key.privateKey;
      const identity = await new SignJWT({ nonce: settings.nonce, email: "person@example.invalid" }).setProtectedHeader({ alg: "RS256", kid: jwk.kid })
        .setIssuer("https://auth.openai.com").setAudience(settings.audience || settings.clientId).setSubject(settings.subject).setIssuedAt().setExpirationTime("1h").sign(privateKey);
      return json({ token_type: "Bearer", access_token: `FICTIONAL_ACCESS_${refreshCount}`, refresh_token: `FICTIONAL_REFRESH_${refreshCount}`, id_token: identity, expires_in: settings.expiresIn, scope: settings.scopes });
    }
    if (url === "https://auth.openai.com/api/accounts/oauth/revoke") return settings.revokeFails ? json({ detail: "Synthetic failure" }, 503) : new Response(null, { status: 200 });
    if (url === "https://api.openai.com/v1/models") return json({ models: settings.modelRemoved ? [] : [{ slug: "fixture-gpt", display_name: "Fictional GPT", visibility: "list" }, { slug: "hidden-fixture", display_name: "Hidden", visibility: "hidden" }] });
    if (url === "https://api.openai.com/v1/responses") {
      if (settings.responseStatus !== 200) return json({ error: { code: settings.errorCode, message: "NEVER_EXPOSE_PROVIDER_BODY_OR_TOKEN" } }, settings.responseStatus);
      if (settings.responseDelayMs) await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, settings.responseDelayMs); init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal?.reason); }, { once: true }); });
      const event = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
      const events = event({ type: "response.output_text.delta", delta: settings.responseText }) + (settings.noTerminal ? "" : settings.incomplete ? event({ type: "response.incomplete", response: { status: "incomplete" } })
        : settings.errorCode ? event({ type: "response.failed", response: { error: { code: settings.errorCode } } }) : event({ type: "response.completed", response: { status: "completed" } }));
      return new Response(events, { headers: { "Content-Type": "text/event-stream", "x-request-id": "req_fixture" } });
    }
    throw new Error(`Unexpected fictional transport route: ${url}`);
  };
  const prepare = (authorizationUrl: string) => {
    const url = new URL(authorizationUrl); settings.nonce = url.searchParams.get("nonce")!;
    if (url.searchParams.get("client_id") !== "dynamic_agent_client") settings.clientId = url.searchParams.get("client_id")!;
    const callback = new URL(url.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", url.searchParams.get("state")!); callback.searchParams.set("code", "FICTIONAL_ONE_TIME_CODE"); callback.searchParams.set("client_id", settings.clientId);
    return { url, callback };
  };
  const login = async (service: ChatGptPlanService, profileId?: string) => {
    const launch = await service.startSignIn(profileId); const { url, callback } = prepare(launch.authorizationUrl);
    const response = await fetch(callback); await response.text();
    return { response, url, callback, state: await service.state(), launch };
  };
  return { fetch: fetchMock, calls, settings, prepare, login, get refreshCount() { return refreshCount; }, get authCount() { return authCount; } };
}
