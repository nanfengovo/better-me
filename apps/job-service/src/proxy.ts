import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SourceProxyConfig, SourceProxyResolver } from "@better-me/source-adapters";

const execFileAsync = promisify(execFile);
const CACHE_TTL_MS = 1_500;

export function normalizeHttpProxyUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const candidate = trimmed.includes("://") ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.hash || parsed.search || (parsed.pathname && parsed.pathname !== "/")) {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function isValidProxySetting(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) return false;
  if (value === "auto" || value === "direct") return true;
  if (!value.includes("://")) return false;
  return normalizeHttpProxyUrl(value) !== undefined;
}

export function formatProxyLogLabel(value: string | undefined): string {
  if (!value || value === "direct" || value === "auto") return value ?? "direct";
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "custom";
  }
}

function selectKeyedServer(server: string): string | undefined {
  const parts = server.split(";");
  const keyed = parts.some((part) => part.includes("="));
  if (!keyed) return normalizeHttpProxyUrl(server);
  for (const prefix of ["https=", "http="]) {
    const match = parts.find((part) => part.trim().toLowerCase().startsWith(prefix));
    if (match) {
      const url = normalizeHttpProxyUrl(match.split("=").slice(1).join("="));
      if (url) return url;
    }
  }
  return undefined;
}

/** Parses macOS `scutil --proxy` output into an HTTP(S) proxy URL and bypass list without a shell. */
export function parseMacHttpProxyOutput(stdout: string): SourceProxyConfig | undefined {
  const values: Record<string, string> = {};
  const exceptions: string[] = [];
  let inExceptions = false;
  for (const line of stdout.split(/\r?\n/)) {
    if (inExceptions) {
      if (/^\s*\}/.test(line)) { inExceptions = false; continue; }
      const item = line.match(/^\s*\d+\s*:\s*(.+)$/);
      if (item?.[1]?.trim()) exceptions.push(item[1].trim());
      continue;
    }
    if (/^\s*ExceptionsList\s*:\s*<array>\s*\{/.test(line)) { inExceptions = true; continue; }
    const entry = line.match(/^\s*([A-Za-z0-9_]+)\s*:\s*(.+)$/);
    if (!entry) continue;
    const raw = entry[2]!.trim();
    if (!raw.startsWith("<")) values[entry[1]!] = raw;
  }
  const server = values.HTTPSEnable === "1" && values.HTTPSProxy && values.HTTPSPort
    ? `${values.HTTPSProxy}:${values.HTTPSPort}`
    : values.HTTPEnable === "1" && values.HTTPProxy && values.HTTPPort
      ? `${values.HTTPProxy}:${values.HTTPPort}`
      : undefined;
  const url = normalizeHttpProxyUrl(server);
  if (!url) return undefined;
  const bypass = exceptions.length ? exceptions.join(",") : undefined;
  return { url, ...(bypass ? { bypass } : {}) };
}

async function detectOsHttpProxy(): Promise<SourceProxyConfig | undefined> {
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("/usr/sbin/scutil", ["--proxy"], { timeout: 2_000, windowsHide: true });
      return parseMacHttpProxyOutput(stdout);
    } catch {
      return undefined;
    }
  }
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync("reg.exe", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"], {
        timeout: 2_000, maxBuffer: 128 * 1024, windowsHide: true,
      });
      const read = (name: string) => stdout.match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*)$`, "mi"))?.[1]?.trim();
      if (read("ProxyEnable") !== "0x1") return undefined;
      const url = read("ProxyServer") ? selectKeyedServer(read("ProxyServer")!) : undefined;
      if (!url) return undefined;
      const override = read("ProxyOverride");
      return { url, ...(override ? { bypass: override } : {}) };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function detectAutoHttpProxy(env: NodeJS.ProcessEnv = process.env): Promise<SourceProxyConfig | undefined> {
  const envBypass = env.NO_PROXY ?? env.no_proxy;
  for (const candidate of [env.HTTPS_PROXY, env.https_proxy, env.HTTP_PROXY, env.http_proxy, env.ALL_PROXY, env.all_proxy]) {
    const url = normalizeHttpProxyUrl(candidate);
    if (url) return { url, ...(envBypass?.trim() ? { bypass: envBypass.trim() } : {}) };
  }
  const osProxy = await detectOsHttpProxy();
  if (!osProxy) return undefined;
  const bypass = [osProxy.bypass, envBypass].filter((part): part is string => Boolean(part?.trim())).join(",");
  return { url: osProxy.url, ...(bypass ? { bypass } : {}) };
}

export function createJobServiceProxyResolver(proxySetting: string | undefined): SourceProxyResolver | undefined {
  if (!proxySetting || proxySetting === "direct") return undefined;
  if (proxySetting !== "auto") {
    const url = normalizeHttpProxyUrl(proxySetting);
    if (!url) return undefined;
    return () => {
      const bypass = (process.env.NO_PROXY ?? process.env.no_proxy)?.trim();
      return { url, ...(bypass ? { bypass } : {}) };
    };
  }
  let cached: { value: SourceProxyConfig | undefined; expiresAt: number } | undefined;
  let inFlight: Promise<SourceProxyConfig | undefined> | undefined;
  return async () => {
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.value;
    if (inFlight) return await inFlight;
    const pending = detectAutoHttpProxy()
      .then((value) => {
        cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
        return value;
      })
      .finally(() => {
        if (inFlight === pending) inFlight = undefined;
      });
    inFlight = pending;
    return await pending;
  };
}
