import { normalizeGeographicName, resolveLegacyCountryCode } from "@better-me/opportunities";
import countryCatalog from "../../../config/geography/countries.json" with { type: "json" };

const countryCodes = new Set(countryCatalog.countries);
const names = new Map<string, Set<string>>();
const labels = typeof Intl.DisplayNames === "function"
  ? ["en", "zh"].map(locale => new Intl.DisplayNames([locale], { type: "region" })) : [];
for (const code of countryCodes) {
  for (const name of [code, ...labels.map(label => label.of(code)).filter((value): value is string => !!value)]) {
    const key = normalizeGeographicName(name), matches = names.get(key) ?? new Set<string>();
    matches.add(code); names.set(key, matches);
  }
}

/** Exact explicit country fields only. The versioned ISO catalog excludes unknown and regional codes. */
export function resolveSourceCountryCode(value: string): string | undefined {
  const alias = resolveLegacyCountryCode(value);
  if (alias && countryCodes.has(alias)) return alias;
  const matches = names.get(normalizeGeographicName(value));
  return matches?.size === 1 ? [...matches][0] : undefined;
}
