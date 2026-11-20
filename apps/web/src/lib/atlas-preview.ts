export const PREVIEW_ATLAS_PATH = "/api/v1/agent/preview-jobs";
export const PREVIEW_ATLAS_BOOTSTRAP_PATH = `${PREVIEW_ATLAS_PATH}/connection`;
export const ATLAS_DEV_JOB_INDEX_PATH = "/__better-me/dev/local-job-index";
export const ATLAS_OWNER_HEADER = "x-betterme-owner";
const SESSION_PREFIX = "preview-session:";

export const isAtlasOwnerId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);

export function previewAtlasSession(owner: string) {
  return `${SESSION_PREFIX}${owner}`;
}

export function previewAtlasOwner(endpoint: string, session: string, origin = (globalThis as { location?: { origin: string } }).location?.origin) {
  if (!origin || !session.startsWith(SESSION_PREFIX) || new URL(endpoint).origin !== origin) return undefined;
  const owner = session.slice(SESSION_PREFIX.length);
  return isAtlasOwnerId(owner) ? owner : undefined;
}

export function atlasHttpTarget(base: URL, token: string, path: string) {
  const owner = previewAtlasOwner(base.href, token);
  const headers: Record<string, string> = owner ? { [ATLAS_OWNER_HEADER]: owner } : { Authorization: `Bearer ${token}` };
  return {
    url: new URL(owner ? `${PREVIEW_ATLAS_PATH}${path}` : path, base),
    credentials: owner ? "same-origin" as const : "omit" as const,
    headers,
  };
}
