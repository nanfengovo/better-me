import { DEFAULT_ATLAS_ENDPOINT, parseAtlasConnectionSession } from "./connection-session";
import { readRuntimeConnection } from "../../lib/runtime-connection";

/** Same path as the Vite development middleware. Public builds never call it. */
export const ATLAS_DEV_JOB_INDEX_PATH = "/__better-me/dev/local-job-index";
export const ATLAS_DEV_AUTOCONNECT_SUPPRESSED_KEY = "better-me:atlas-dev-autoconnect-suppressed:v1";

export type DevJobIndexBootstrap = { ok: true; endpoint: string; token: string } | { ok: false; error: string };
type SessionStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function sessionStore(): SessionStore | undefined {
  try { return window.sessionStorage; } catch { return undefined; }
}

export function readAtlasDevAutoConnectSuppressed(storage = sessionStore()): boolean {
  try { return storage?.getItem(ATLAS_DEV_AUTOCONNECT_SUPPRESSED_KEY) === "1"; } catch { return false; }
}

export function writeAtlasDevAutoConnectSuppressed(storage = sessionStore()): void {
  try { storage?.setItem(ATLAS_DEV_AUTOCONNECT_SUPPRESSED_KEY, "1"); } catch { /* The in-memory flag still blocks this mounted page. */ }
}

export function clearAtlasDevAutoConnectSuppressed(storage = sessionStore()): void {
  try { storage?.removeItem(ATLAS_DEV_AUTOCONNECT_SUPPRESSED_KEY); } catch { /* An explicit connection can still proceed. */ }
}

/** Accept only the fixed loopback index. Anything else is not a development bootstrap. */
export function parseDevJobIndexBootstrap(value: unknown): DevJobIndexBootstrap | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 1 && keys[0] === "error" && typeof record.error === "string" && record.error.trim() && record.error.length <= 500 && !record.error.includes("\n")) {
    return { ok: false, error: record.error };
  }
  if (keys.length !== 2 || typeof record.endpoint !== "string" || typeof record.token !== "string") return undefined;
  const session = parseAtlasConnectionSession({ schemaVersion: 1, dataMode: "live", endpoint: record.endpoint, token: record.token });
  if (!session || session.dataMode !== "live" || ![DEFAULT_ATLAS_ENDPOINT, readRuntimeConnection()?.origin].includes(new URL(session.endpoint).origin)) return undefined;
  return { ok: true, endpoint: new URL(session.endpoint).origin, token: session.token };
}

export async function requestDevJobIndex(signal: AbortSignal): Promise<DevJobIndexBootstrap | undefined> {
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await fetch(ATLAS_DEV_JOB_INDEX_PATH, {
      signal, credentials: "same-origin", cache: "no-store", redirect: "error", headers: { Accept: "application/json" },
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(error instanceof Error && error.message ? error.message : "无法询问本地开发服务。", { cause: error });
  }
  signal.throwIfAborted();
  if (response.status === 404) return undefined;
  const text = await response.text();
  signal.throwIfAborted();
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { return undefined; }
  const parsed = parseDevJobIndexBootstrap(payload);
  if (!parsed) return undefined;
  if (!response.ok && parsed.ok) return { ok: false, error: `本地开发服务返回 ${response.status}，没有交出可用连接。` };
  return parsed;
}
