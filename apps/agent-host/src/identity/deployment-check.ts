import type { IdentityDeployment } from "./deployment.js";
import { SocialLoginCatalogModule } from "./social-login.js";

async function discoveryBody(response: Response): Promise<string> {
  const limit = 128 * 1024;
  if (!response.ok || Number(response.headers.get("content-length")) > limit || !response.body) throw new Error("discovery_unavailable");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error("discovery_too_large"); }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { reader.releaseLock(); }
}

/** Redacted operator diagnostic, separate from application health and ordinary-user UI. */
export async function checkIdentityDeployment(identity: IdentityDeployment, fetcher: typeof fetch = fetch) {
  const base = { mode: identity.mode, source: identity.source, localAccounts: true, existingDataChanged: false };
  if (identity.issue) return { ...base, ready: false, status: identity.issue };
  if (!identity.oidc) return { ...base, ready: true, status: "local_only" };
  const options = identity.oidc;
  try {
    const response = await fetcher(new URL(".well-known/openid-configuration", options.issuer.endsWith("/") ? options.issuer : options.issuer + "/"), {
      redirect: "error", signal: AbortSignal.timeout(4000), credentials: "omit", cache: "no-store",
    });
    const body = await discoveryBody(response);
    const metadata = JSON.parse(body) as Record<string, unknown>;
    if (metadata.issuer !== options.issuer || !["authorization_endpoint", "token_endpoint", "jwks_uri"].every(key => {
      const url = new URL(String(metadata[key]));
      return url.origin === new URL(options.issuer).origin && !url.username && !url.password && !url.hash;
    })) return { ...base, ready: false, status: "oidc_discovery_invalid" };
  } catch { return { ...base, ready: false, status: "oidc_discovery_unavailable" }; }
  const catalog = await new SocialLoginCatalogModule(options, fetcher).list("", true);
  return { ...base, ready: catalog.service === "ready" && catalog.unifiedLoginAvailable,
    status: catalog.service !== "ready" ? "oidc_catalog_unavailable" : !catalog.unifiedLoginAvailable ? "oidc_login_disabled" : "unified_ready",
    // No client IDs, provider names, secrets, profiles or filesystem paths.
    channels: catalog.channels.map(({ id, state }) => ({ id, state })),
  };
}
