import * as client from "openid-client";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { IdentityError, IdentityService } from "./service.js";
import { readPrivateJson } from "./private-json.js";
import { SocialProviderIdSchema } from "@better-me/agent-contracts";
import { SocialLoginCatalogModule } from "./social-login.js";

export const OIDC_CALLBACK_PATH = "/api/v1/agent/identity/oidc/callback";
const Options = z.object({ issuer: z.string().url(), clientId: z.string().min(1).max(200), clientSecret: z.string().min(1).max(1000),
  callbackUrl: z.string().url(), allowLoopbackHttp: z.boolean().default(false) }).strict();
export type OidcOptions = z.input<typeof Options>;
const COOKIE = "betterme_oidc_browser", TTL = 5 * 60_000;
const loopback = (url: URL) => ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
const browserId = (cookie?: string) => {
  const values = cookie?.split(";").map(value => value.trim()).filter(value => value.startsWith(COOKIE + "=")) ?? [];
  const id = values.length === 1 ? values[0]!.slice(COOKIE.length + 1) : "";
  return /^[A-Za-z0-9_-]{43}$/.test(id) ? id : undefined;
};
type Flow = { state: string; nonce: string; verifier: string; until: number; claimed: boolean; intent: "login" | "link" | "manage"; cookie?: string; ownerId?: string };

/** Server-only OIDC boundary. Neither provider credentials nor tokens enter the browser/Agent memory. */
export class OidcService {
  readonly options: z.infer<typeof Options>;
  readonly social: SocialLoginCatalogModule;
  private flows = new Map<string, Flow>();
  private attempts = new Map<string, { count: number; until: number }>();
  private configuration?: Promise<client.Configuration>;
  constructor(options: OidcOptions, private identities: IdentityService, private clock: () => number = Date.now) {
    this.options = Options.parse(options);
    const issuer = new URL(this.options.issuer), callback = new URL(this.options.callbackUrl);
    for (const url of [issuer, callback]) {
      if (url.username || url.password || url.hash || url.search || (url.protocol !== "https:" && !(this.options.allowLoopbackHttp && url.protocol === "http:" && loopback(url)))) throw new Error("unsafe_oidc_url");
    }
    if (callback.pathname !== OIDC_CALLBACK_PATH) throw new Error("invalid_oidc_callback");
    this.social = new SocialLoginCatalogModule(this.options);
  }
  private config() {
    this.configuration ??= client.discovery(new URL(this.options.issuer), this.options.clientId,
      { token_endpoint_auth_method: "client_secret_post", id_token_signed_response_alg: "RS256" }, client.ClientSecretPost(this.options.clientSecret), {
        timeout: 10, execute: [client.enableNonRepudiationChecks, ...(this.options.allowLoopbackHttp ? [client.allowInsecureRequests] : [])],
      }).then(config => {
        // Self-hosted Casdoor endpoints must belong to the explicitly configured issuer, never to a request URL.
        const metadata = config.serverMetadata(), issuer = new URL(this.options.issuer);
        if (metadata.issuer !== this.options.issuer) throw new Error("oidc_issuer_mismatch");
        for (const value of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.jwks_uri]) {
          if (!value || new URL(value).origin !== issuer.origin) throw new Error("unsafe_oidc_endpoint");
        }
        return config;
      }).catch(error => { this.configuration = undefined; throw error; });
    return this.configuration;
  }
  cancel(cookie?: string) { const id = browserId(cookie); if (id) this.flows.delete(id); }
  async start(input: unknown, cookie: string | undefined, expectedOwner: string | undefined, clientAddress: string, userAgent = "") {
    const body = z.object({ intent: z.enum(["login", "link", "manage"]), password: z.string().max(128).optional(), provider: SocialProviderIdSchema.optional() }).strict().parse(input);
    const now = this.clock();
    for (const [key, item] of this.flows) if (item.until <= now) this.flows.delete(key);
    for (const [key, item] of this.attempts) if (item.until <= now) this.attempts.delete(key);
    const attempts = this.attempts.get(clientAddress) ?? { count: 0, until: now + 60_000 };
    if (++attempts.count > 10 || this.attempts.size >= 1000 && !this.attempts.has(clientAddress) || this.flows.size >= 200) throw new IdentityError(429, "oidc_rate_limited");
    this.attempts.set(clientAddress, attempts);
    const id = browserId(cookie) ?? randomBytes(32).toString("base64url");
    const flow: Flow = { state: client.randomState(), nonce: client.randomNonce(), verifier: client.randomPKCECodeVerifier(), until: now + TTL, claimed: false, intent: body.intent };
    this.flows.set(id, flow); // Set before any await: a newer attempt can cancel even an in-flight start.
    const active = () => this.flows.get(id) === flow && flow.until > this.clock();
    try {
      if (body.intent === "link") {
        const principal = await this.identities.verifyLocal(cookie, body.password ?? "");
        if (principal.id !== expectedOwner) throw new IdentityError(409, "identity_changed");
        flow.ownerId = principal.id; flow.cookie = cookie;
      } else if (body.intent === "manage") {
        const principal = await this.identities.authenticate(cookie);
        if (!principal || principal.id !== expectedOwner) throw new IdentityError(401, "identity_required");
        const methods = await this.identities.loginMethods(cookie, principal.id, this.options.issuer);
        if (!methods.unifiedLinked) throw new IdentityError(409, "external_identity_not_linked");
        flow.ownerId = principal.id; flow.cookie = cookie;
      } else if (await this.identities.authenticate(cookie)) throw new IdentityError(409, "sign_out_before_oidc_login");
      const providerName = await this.social.resolve(body.provider, userAgent);
      const config = await this.config(), challenge = await client.calculatePKCECodeChallenge(flow.verifier);
      if (!active()) throw new IdentityError(409, "oidc_flow_cancelled");
      const url = client.buildAuthorizationUrl(config, { redirect_uri: this.options.callbackUrl, response_type: "code", scope: "openid profile",
        state: flow.state, nonce: flow.nonce, code_challenge: challenge, code_challenge_method: "S256", prompt: "login",
        ...(providerName ? { provider_hint: providerName } : {}) });
      return { url: url.href, cookie: `${COOKIE}=${id}; Path=/api/v1/agent/identity; HttpOnly; SameSite=Lax; Max-Age=86400${new URL(this.options.callbackUrl).protocol === "https:" ? "; Secure" : ""}` };
    } catch (error) {
      if (this.flows.get(id) === flow) this.flows.delete(id);
      if (error instanceof IdentityError) throw error;
      throw new IdentityError(503, "oidc_service_unavailable");
    }
  }
  async complete(search: string, cookie?: string) {
    const id = browserId(cookie), flow = id && this.flows.get(id), url = new URL(this.options.callbackUrl); url.search = search;
    if (!id || !flow || flow.claimed || flow.until <= this.clock() || url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== flow.state) throw new IdentityError(400, "oidc_callback_rejected");
    flow.claimed = true;
    const active = () => this.flows.get(id) === flow && flow.until > this.clock();
    try {
      const config = await this.config();
      const tokens = await client.authorizationCodeGrant(config, url, { pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce, idTokenExpected: true });
      if (!active()) throw new IdentityError(409, "oidc_flow_cancelled");
      const claims = tokens.claims();
      if (!claims || claims.iss !== this.options.issuer || typeof claims.sub !== "string" || !claims.sub) throw new IdentityError(400, "oidc_callback_rejected");
      const proof = { issuer: claims.iss, subject: claims.sub, displayName: String(claims.name ?? claims.displayName ?? claims.preferred_username ?? "Casdoor 用户").slice(0, 60).trim() || "Casdoor 用户" };
      const result = flow.intent === "link" ? { principal: await this.identities.linkExternal(flow.cookie, flow.ownerId!, proof, active) }
        : flow.intent === "manage" ? { principal: await this.identities.verifyExternalOwner(flow.cookie, flow.ownerId!, proof, active) }
          : await this.identities.signInExternal(proof, active);
      if (!active()) throw new IdentityError(409, "oidc_flow_cancelled");
      return { ...result, redirect: flow.intent === "manage" ? new URL("/account", this.options.issuer).href
        : new URL(flow.intent === "link" ? "/?identity=linked" : "/", this.options.callbackUrl).href };
    } finally { if (this.flows.get(id) === flow) this.flows.delete(id); }
  }
}

export async function loadOidcOptions(filename: string): Promise<OidcOptions | undefined> {
  const raw = await readPrivateJson(filename);
  return raw === undefined ? undefined : Options.parse(raw);
}
