/** Supplied only by the local Docker gateway, before the application module loads. */
export type RuntimeConnection = { mode: "docker"; origin: string; agentToken: string; jobToken: string };

export function readRuntimeConnection(): RuntimeConnection | undefined {
  if (typeof window === "undefined") return undefined;
  const value: unknown = (window as Window & { __BETTER_ME_RUNTIME__?: unknown }).__BETTER_ME_RUNTIME__;
  if (!value || typeof value !== "object") return undefined;
  const config = value as Record<string, unknown>;
  try {
    const origin = new URL(String(config.origin));
    if (config.mode !== "docker" || origin.origin !== window.location.origin || origin.href !== origin.origin + "/"
      || !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
      || !["agentToken", "jobToken"].every(key => typeof config[key] === "string" && /^[A-Za-z0-9_-]{43,128}$/.test(config[key] as string))) return undefined;
    return config as RuntimeConnection;
  } catch { return undefined; }
}
