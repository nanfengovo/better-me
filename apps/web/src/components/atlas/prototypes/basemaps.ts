import catalog from "./basemaps.json";

export type AtlasAttribution = { label: string; url: string };
type CommonBasemap = { id: string; name: string; maxZoom: number; attributions: AtlasAttribution[]; policyUrl?: string };
export type AtlasBasemapConfig = CommonBasemap & (
  { type: "vector-style"; styleUrl: string } |
  { type: "raster"; tiles: string[]; tileSize: 256 | 512; maxNativeZoom: number }
);
const validUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try { const url = new URL(value); return !url.username && !url.password && (url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))); } catch { return false; }
};
/** Public map endpoints only. Credentials belong to the provider's official integration. */
export function parseAtlasBasemap(value: unknown): AtlasBasemapConfig {
  if (!value || typeof value !== "object") throw new Error("Invalid basemap configuration.");
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !/^[\w-]{1,80}$/.test(raw.id) || typeof raw.name !== "string" || !raw.name.trim()
    || !Number.isFinite(raw.maxZoom) || Number(raw.maxZoom) < 1 || Number(raw.maxZoom) > 24
    || !Array.isArray(raw.attributions) || !raw.attributions.length
    || raw.attributions.some((item) => !item || typeof item !== "object" || typeof item.label !== "string" || !validUrl(item.url))
    || (raw.policyUrl !== undefined && !validUrl(raw.policyUrl))) throw new Error("Invalid basemap identity, zoom or attribution.");
  if (raw.type === "vector-style" && validUrl(raw.styleUrl)) return raw as AtlasBasemapConfig;
  if (raw.type === "raster" && Array.isArray(raw.tiles) && raw.tiles.length > 0 && raw.tiles.length <= 8
    && raw.tiles.every((tile) => validUrl(tile) && ["{x}", "{y}", "{z}"].every((token) => tile.includes(token)))
    && [256, 512].includes(Number(raw.tileSize)) && Number.isInteger(raw.maxNativeZoom) && Number(raw.maxNativeZoom) >= 0 && Number(raw.maxNativeZoom) <= Number(raw.maxZoom)) return raw as AtlasBasemapConfig;
  throw new Error("Invalid basemap endpoint or tile configuration.");
}
export const ATLAS_BASEMAPS: readonly AtlasBasemapConfig[] = catalog.providers.map(parseAtlasBasemap);
export const DEFAULT_ATLAS_BASEMAP = ATLAS_BASEMAPS.find((provider) => provider.id === catalog.defaultProviderId)!;
if (!DEFAULT_ATLAS_BASEMAP) throw new Error("The default atlas basemap is not registered.");
export function attributionHtml(provider: AtlasBasemapConfig): string {
  const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
  return provider.attributions.map((item) => `<a href="${escape(item.url)}" target="_blank" rel="noopener noreferrer">${escape(item.label)}</a>`).join(" · ");
}
