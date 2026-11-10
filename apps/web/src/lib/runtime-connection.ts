/** Supplied by this deployment's same-origin gateway, before the application module loads. */
export type RuntimeConnection = { mode: "docker" | "desktop"; origin: string; agentToken: string; jobToken: string };

export function readRuntimeConnection(): RuntimeConnection | undefined {
  if (typeof window === "undefined") return undefined;
  const value: unknown = (window as Window & { __BETTER_ME_RUNTIME__?: unknown }).__BETTER_ME_RUNTIME__;
  if (!value || typeof value !== "object") return undefined;
  const config = value as Record<string, unknown>;
  try {
    const origin = new URL(String(config.origin));
    if (!["docker", "desktop"].includes(String(config.mode)) || origin.origin !== window.location.origin || origin.href !== origin.origin + "/"
      || origin.protocol !== "https:" && !(origin.protocol === "http:" && (["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) || origin.hostname.endsWith(".localhost")))
      || !["agentToken", "jobToken"].every(key => typeof config[key] === "string" && /^[A-Za-z0-9_-]{43,128}$/.test(config[key] as string))) return undefined;
    return config as RuntimeConnection;
  } catch { return undefined; }
}
