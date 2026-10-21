import { DEFAULT_ATLAS_BACKEND_ENDPOINT } from "./backend-connection";
export { DEFAULT_ATLAS_BACKEND_ENDPOINT } from "./backend-connection";

export const ATLAS_CONNECTION_SESSION_KEY = "better-me:atlas-connection-session:v1";
export const DEFAULT_ATLAS_ENDPOINT = "http://127.0.0.1:5178";

export type AtlasDataMode = "local" | "demo" | "live";
export type AtlasConnectionIdentity = { endpoint: string; token: string };
export type AtlasConnectionSession = { schemaVersion: 1 } & (
  | { dataMode: "local" | "demo" }
  | ({ dataMode: "live" } & AtlasConnectionIdentity)
);
type SessionStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function sessionStore(): SessionStore | undefined {
  try { return window.sessionStorage; } catch { return undefined; }
}

/** The gateway stores only a marker; direct loopback credentials require a successful manual connection. */
function validIdentity(value: Record<string, unknown>): value is Record<string, unknown> & AtlasConnectionIdentity {
  if (value.endpoint === DEFAULT_ATLAS_BACKEND_ENDPOINT) return value.token === "";
  if (typeof value.endpoint !== "string" || value.endpoint.length > 200
      || typeof value.token !== "string" || !value.token.trim() || value.token.length > 4096 || /[\r\n\0]/.test(value.token)) return false;
  try {
    const url = new URL(value.endpoint);
    return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      && !url.search && !url.hash && url.pathname === "/";
  } catch { return false; }
}

export function parseAtlasConnectionSession(value: unknown): AtlasConnectionSession | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) return undefined;
  if (record.dataMode === "local" || record.dataMode === "demo") {
    if (Object.keys(record).some((key) => !["schemaVersion", "dataMode"].includes(key))) return undefined;
    return { schemaVersion: 1, dataMode: record.dataMode };
  }
  if (record.dataMode !== "live" || Object.keys(record).some((key) => !["schemaVersion", "dataMode", "endpoint", "token"].includes(key)) || !validIdentity(record)) return undefined;
  return { schemaVersion: 1, dataMode: "live", endpoint: record.endpoint, token: record.token };
}

export function clearAtlasConnectionSession(storage = sessionStore()): void {
  try { storage?.removeItem(ATLAS_CONNECTION_SESSION_KEY); } catch { /* Page memory remains usable if storage is blocked. */ }
}

export function readAtlasConnectionSession(storage = sessionStore()): AtlasConnectionSession | undefined {
  try {
    const raw = storage?.getItem(ATLAS_CONNECTION_SESSION_KEY);
    if (raw === null || raw === undefined) return undefined;
    const session = raw.length <= 5000 ? parseAtlasConnectionSession(JSON.parse(raw)) : undefined;
    if (session) return session;
  } catch { /* Damaged and future-version identities are discarded; the workspace may use its fixed default backend. */ }
  clearAtlasConnectionSession(storage);
  return undefined;
}

/** Credentials are saved only by the workspace after an explicitly requested connection succeeds. */
export function writeAtlasConnectionSession(value: AtlasConnectionSession, storage = sessionStore()): boolean {
  const session = parseAtlasConnectionSession(value);
  if (!session || !storage) { clearAtlasConnectionSession(storage); return false; }
  try { storage.setItem(ATLAS_CONNECTION_SESSION_KEY, JSON.stringify(session)); return true; }
  catch { clearAtlasConnectionSession(storage); return false; }
}
