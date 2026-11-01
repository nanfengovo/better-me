import { normalizeSourceUrl } from "@better-me/opportunities";
import { PlatformSearchProviderSchema, reviewedCardIdentity, type PlatformSearchProvider } from "@better-me/source-adapters/browser-contracts";

/** Unknown sources keep semantic query parameters and SPA routes; never guess an ID. */
export function harvestCardUrl(value: string): string {
  try {
    const url = new URL(normalizeSourceUrl(value));
    if (!url.hash.startsWith("#/") && !url.hash.startsWith("#!")) url.hash = "";
    return url.toString();
  } catch { return value; }
}

/** Exact official host + provider job ID, shared by display, commit and index joins. */
export function liveCardIdentity(url: string, provider?: PlatformSearchProvider): string {
  for (const candidate of provider ? [provider] : PlatformSearchProviderSchema.options) {
    const identity = reviewedCardIdentity(url, candidate);
    if (identity) return `${candidate}\0${identity.id}`;
  }
  return `url\0${harvestCardUrl(url)}`;
}
