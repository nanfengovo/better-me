import { normalizeGeographicName, resolveLegacyCountryCode, type GeocodingInput, type JobLocation } from "@better-me/opportunities";
import countryCatalog from "../../../../../config/geography/countries.json";

type LocationInput = Pick<JobLocation, "raw" | "city" | "countryCode" | "kind">;
const countryCodes = new Set(countryCatalog.countries);
const countriesByName = new Map<string, Set<string>>();
const countryLabels = typeof Intl.DisplayNames === "function" ? ["en", "zh"].map((locale) => new Intl.DisplayNames([locale], { type: "region" })) : [];
for (const code of countryCodes) {
  const names = [code];
  for (const labels of countryLabels) {
    const label = labels.of(code);
    if (label) names.push(label);
  }
  for (const name of names) {
    const key = normalizeGeographicName(name);
    const matches = countriesByName.get(key) ?? new Set<string>();
    matches.add(code); countriesByName.set(key, matches);
  }
}

function exactCountry(value: string): string | undefined {
  const alias = resolveLegacyCountryCode(value);
  if (alias && countryCodes.has(alias)) return alias;
  const matches = countriesByName.get(normalizeGeographicName(value));
  return matches?.size === 1 ? [...matches][0] : undefined;
}

const multiLocation = /[;；\r\n]|\s[|/]\s/u;
const remoteLocation = /\b(?:remote|remotely|anywhere|worldwide|wfh|work[ -]from[ -]home)\b|远程|居家|全球|全境/iu;
const cityName = /^[\p{L}\p{M}][\p{L}\p{M}\p{N}\s.'’-]*$/u;

/** Prepares only a transient, explicitly selected city-reference search; never repairs source facts.
 * A complete last comma field must name a known country exactly. Middle fields remain opaque regions.
 */
export function buildAtlasCityCandidateQuery(location: LocationInput, limit = 8): GeocodingInput {
  const countries = location.countryCode ? [location.countryCode] : [];
  const original = { kind: location.kind ?? "unknown", raw: location.raw, countryCodes: countries, limit };
  if (original.kind !== "office") return original;
  // A composite office/remote label cannot establish which part is an office.
  if (multiLocation.test(location.raw) || remoteLocation.test(location.raw)) return { ...original, kind: "unknown" };
  const city = location.city?.trim();
  const parts = location.raw.split(/[,，]/u).map((part) => part.trim());
  const suffix = parts.length >= 2 && parts.length <= 3 && parts.every(Boolean) ? exactCountry(parts[parts.length - 1]!) : undefined;
  const compatibleCountry = suffix && (!location.countryCode || location.countryCode === suffix) ? suffix : undefined;
  if (city) return { ...original, raw: city, countryCodes: location.countryCode ? countries : compatibleCountry ? [compatibleCountry] : [] };
  if (!compatibleCountry || !cityName.test(parts[0]!)) return original;
  return { ...original, raw: parts[0]!, countryCodes: [compatibleCountry] };
}
