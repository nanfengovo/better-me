import { HttpUrlSchema } from "./schema.js";

const trackingKeys = new Set(["fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid", "_ga", "_gl", "igshid"]);

/** Preserve job IDs, duplicate parameters, source/ref parameters, and SPA route fragments. */
export function normalizeSourceUrl(value: string): string {
  const parsed = HttpUrlSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Expected an HTTP(S) source URL without credentials.");
  const url = new URL(parsed.data);
  for (const key of Array.from(url.searchParams.keys())) {
    const normalized = key.toLowerCase();
    if (normalized.startsWith("utm_") || trackingKeys.has(normalized)) url.searchParams.delete(key);
  }
  return url.toString();
}

/** Structured JSON identity avoids delimiter collisions and needs no Node runtime. */
export async function deriveEntityId(kind: string, parts: readonly string[]): Promise<string> {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(kind)) throw new TypeError("Invalid entity kind.");
  if (parts.length < 1 || parts.length > 128 || parts.some((part) => typeof part !== "string" || part.length > 16_384)) {
    throw new TypeError("Entity identity requires 1–128 bounded string parts.");
  }
  const bytes = new TextEncoder().encode(JSON.stringify(["better-me/opportunities", 1, kind, parts]));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${kind}_${hex}`;
}
