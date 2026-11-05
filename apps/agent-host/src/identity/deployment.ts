import { lstat, readFile } from "node:fs/promises";
import { OIDC_CALLBACK_PATH, loadOidcOptions, validateOidcOptions, type OidcOptions } from "./oidc.js";

type Environment = Readonly<Record<string, string | undefined>>;
export type IdentityDeployment = {
  mode: "local" | "unified";
  source: "none" | "file" | "legacy_file" | "environment";
  oidc?: OidcOptions;
  issue?: "invalid_auth_mode" | "oidc_configuration_missing" | "oidc_configuration_conflict" | "oidc_configuration_invalid";
};
const isLoopback = (url: URL) => ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.hostname.endsWith(".localhost");

/** A configured origin, not X-Forwarded-* or a user-controlled callback/Host. */
export function publicOrigins(env: Environment, fallback: readonly string[]): string[] {
  const value = env.BETTER_ME_PUBLIC_ORIGIN;
  if (!value) return [...fallback];
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url))) throw new Error();
    return [...new Set([url.origin, ...fallback])];
  } catch { throw new Error("invalid_public_origin"); }
}

/** Secret mounts can be read-only 0444 inside an isolated container; no names/values are logged. */
async function readSecretMount(filename: string): Promise<string> {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) throw new Error("invalid_secret_mount");
  return (await readFile(filename, "utf8")).replace(/\r?\n$/, "");
}

/** Read-only configuration. Invalid online config disables online login, not local accounts. */
export async function loadIdentityDeployment({ env = process.env, defaultConfigPath }: { env?: Environment; defaultConfigPath?: string } = {}): Promise<IdentityDeployment> {
  const requested = env.BETTERME_AUTH_MODE ?? "auto";
  if (!["auto", "local", "unified"].includes(requested)) return { mode: "local", source: "none", issue: "invalid_auth_mode" };
  if (requested === "local") return { mode: "local", source: "none" };
  const file = env.BETTERME_OIDC_CONFIG;
  const configuredEnvironment = [env.BETTERME_OIDC_ISSUER, env.BETTERME_OIDC_CLIENT_ID, env.BETTERME_OIDC_CLIENT_SECRET_FILE, env.BETTERME_OIDC_CLIENT_SECRET].some(value => value !== undefined);
  if (file && configuredEnvironment || env.BETTERME_OIDC_CLIENT_SECRET_FILE && env.BETTERME_OIDC_CLIENT_SECRET) {
    return { mode: "unified", source: "none", issue: "oidc_configuration_conflict" };
  }
  const source = configuredEnvironment ? "environment" : file ? "file" : defaultConfigPath ? "legacy_file" : "none";
  try {
    let oidc: OidcOptions | undefined;
    if (configuredEnvironment) {
      if (!env.BETTER_ME_PUBLIC_ORIGIN || !env.BETTERME_OIDC_ISSUER || !env.BETTERME_OIDC_CLIENT_ID || !(env.BETTERME_OIDC_CLIENT_SECRET_FILE || env.BETTERME_OIDC_CLIENT_SECRET)) {
        return { mode: "unified", source, issue: "oidc_configuration_missing" };
      }
      oidc = validateOidcOptions({
        issuer: env.BETTERME_OIDC_ISSUER, clientId: env.BETTERME_OIDC_CLIENT_ID,
        clientSecret: env.BETTERME_OIDC_CLIENT_SECRET_FILE ? await readSecretMount(env.BETTERME_OIDC_CLIENT_SECRET_FILE) : env.BETTERME_OIDC_CLIENT_SECRET,
        callbackUrl: publicOrigins(env, [])[0]! + OIDC_CALLBACK_PATH,
        allowLoopbackHttp: env.BETTERME_OIDC_ALLOW_LOOPBACK_HTTP === "true",
      });
    } else if (file || defaultConfigPath) oidc = await loadOidcOptions((file ?? defaultConfigPath)!);
    if (!oidc) return requested === "unified" || file
      ? { mode: "unified", source, issue: "oidc_configuration_missing" } : { mode: "local", source: "none" };
    if (env.BETTER_ME_PUBLIC_ORIGIN && new URL(oidc.callbackUrl).origin !== publicOrigins(env, [])[0]) throw new Error("callback_origin_mismatch");
    return { mode: "unified", source, oidc };
  } catch {
    // Parser/fs errors may contain inputs or paths. Expose only this fixed code.
    return { mode: "unified", source, issue: "oidc_configuration_invalid" };
  }
}
