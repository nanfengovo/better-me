import { normalizeSourceUrl, resolveLegacyCountryCode, type AtlasDataset } from "@better-me/opportunities";
import { resolvePlatformSearchRegion } from "@better-me/source-adapters/browser-contracts";
import countryCatalog from "../../../../../config/geography/countries.json";
import { getChinaProvinces, matchDisclosedChinaCities } from "./china-regions";
import type { LiveHarvestCard, LiveHarvestQuery } from "./live-harvest-view";

const normalized = (value: string) => value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
function contains(value: string, term: string): boolean {
  const escaped = normalized(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return /[a-z]/i.test(term) ? new RegExp(`(?<![a-z])${escaped}(?![a-z])`, "iu").test(value) : value.includes(normalized(term));
}
const countryNames = [new Intl.DisplayNames(["zh"], { type: "region" }), new Intl.DisplayNames(["en"], { type: "region" })];
const names = countryCatalog.countries.map(code => ({ code, names: countryNames.map(display => display.of(code) ?? code) }));
const mainlandProvinceNames = getChinaProvinces().filter(province => province.catalogAvailable).map(province => province.name);
const countryMatchers = names.flatMap(entry => entry.names.map(name => {
  const escaped = normalized(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = /[a-z]/iu.test(name) ? new RegExp(`(?<![a-z])${escaped}(?![a-z])`, "iu") : undefined;
  return { code: entry.code, name: normalized(name), matches: (raw: string) => pattern ? pattern.test(raw) : raw.includes(normalized(name)) };
}));

export function harvestMarketScope(mode: "domestic" | "global", country: string): Pick<LiveHarvestQuery, "market" | "countryCodes"> {
  return { market: mode, countryCodes: mode === "domestic" ? [...countryCatalog.domesticCountryCodes] : country ? [country] : [] };
}

/** Only the disclosed location field is evidence. Employer names, search intent and HQ are never inputs. */
export function classifyHarvestLocation(location: string | undefined, query: LiveHarvestQuery): "matching" | "outside" | "unknown" {
  if (!query.countryCodes?.length && !query.region && !query.regionGroups?.length) return "matching";
  const raw = normalized(location ?? "");
  if (!raw) return "unknown";
  // Inner Mongolia and Mongol autonomous administrative names are not Mongolia.
  // Strip only these names from country detection, never from the source evidence.
  const countryText = raw.replace(/内蒙古|inner mongolia|蒙古(?:族)?自治/giu, " ");
  const matched = countryMatchers.filter(entry => entry.matches(countryText));
  const codes = new Set(matched.filter(entry => !matched.some(other => other.code !== entry.code && other.name.length > entry.name.length && other.name.includes(entry.name))).map(entry => entry.code));
  for (const [code, aliases] of [["HK", ["香港", "Hong Kong"]], ["MO", ["澳门", "Macau", "Macao"]], ["TW", ["台湾", "Taiwan"]]] as const) {
    if (aliases.some(alias => contains(raw, alias))) codes.add(code);
  }
  if (codes.has("HK") || codes.has("MO") || codes.has("TW")) codes.delete("CN");
  const parts = raw.split(/[,，/·()（）]+/u);
  for (const [index, part] of parts.entries()) {
    if (/^[a-z]{2}$/iu.test(part.trim()) && index !== parts.length - 1) continue;
    const code = resolveLegacyCountryCode(part);
    if (code) codes.add(code);
  }
  if (/\b(?:usa|united states|u\.s\.)\b/iu.test(raw)) codes.add("US");
  if (/\b(?:uk|united kingdom)\b/iu.test(raw)) codes.add("GB");
  // Do not derive China from a city when an explicit different country is present.
  if (!codes.size && (mainlandProvinceNames.some(name => contains(raw, name)) || /内蒙古|\binner mongolia\b/iu.test(raw)
    || matchDisclosedChinaCities({ countryCode: "CN", raw }).length)) codes.add("CN");
  if (query.countryCodes?.length) {
    if (!codes.size) return "unknown";
    if (!query.countryCodes.some(code => codes.has(code))) return "outside";
    if ([...codes].some(code => !query.countryCodes!.includes(code))) return "unknown";
  }
  const configured = query.region ? resolvePlatformSearchRegion(query.region) : undefined;
  const regionIsCountry = query.region && (resolveLegacyCountryCode(query.region)
    || names.find(entry => entry.names.some(name => normalized(name) === normalized(query.region!)))?.code);
  const groups = query.regionGroups?.length ? query.regionGroups
    : query.region && !regionIsCountry ? [[query.region, ...(configured ? [configured.name, ...configured.aliases] : [])]] : [];
  return groups.every(group => group.some(term => contains(raw, term))) ? "matching" : "outside";
}

export function scopeLiveHarvestCards(cards: readonly LiveHarvestCard[], query: LiveHarvestQuery) {
  const matching: LiveHarvestCard[] = [], outside: LiveHarvestCard[] = [], unknown: LiveHarvestCard[] = [];
  const cache = new Map<string | undefined, ReturnType<typeof classifyHarvestLocation>>();
  for (const entry of cards) {
    const raw = entry.card.locationText;
    const classification = cache.get(raw) ?? classifyHarvestLocation(raw, query);
    cache.set(raw, classification);
    (classification === "matching" ? matching : classification === "outside" ? outside : unknown).push(entry);
  }
  return { matching, outside, unknown };
}

export function harvestCardUrl(value: string): string {
  try {
    const url = new URL(normalizeSourceUrl(value));
    if (!url.hash.startsWith("#/") && !url.hash.startsWith("#!")) url.hash = "";
    return url.toString();
  } catch { return value; }
}

/** Join by captured listing URL, never by company name or job title. No synthetic jobs/coordinates. */
export function selectHarvestIndexJobIds(data: AtlasDataset | null, cards: readonly LiveHarvestCard[]): string[] {
  if (!data) return [];
  const urls = new Set(cards.map(entry => harvestCardUrl(entry.card.url)));
  const listingIds = new Set(data.listings.filter(entry => entry.canonicalUrl && urls.has(harvestCardUrl(entry.canonicalUrl))).map(entry => entry.id));
  return data.jobs.filter(job => job.listingIds.some(id => listingIds.has(id))).map(job => job.id);
}
