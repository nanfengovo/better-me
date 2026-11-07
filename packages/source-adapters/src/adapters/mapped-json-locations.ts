import countryCatalog from '../../../../config/geography/countries.json' with { type: 'json' };
import type { SourceJobRecord, SourceRecordLocation } from '../contracts.js';
import type { JsonFieldMapping } from '../mapping-contracts.js';
import { resolveSourceCountryCode } from '../source-country.js';
import { plainText } from './common.js';

const countryCodes = new Set(countryCatalog.countries);
const fieldMappings = [
  ['raw', 'locationTextPath'], ['countryCode', 'locationCountryPath'], ['region', 'locationRegionPath'],
  ['city', 'locationCityPath'], ['streetAddress', 'locationStreetAddressPath'], ['postalCode', 'locationPostalCodePath'],
] as const;

/** Map only explicitly configured fields of this entry. Coordinates and office precision are separate evidence. */
export function applyMappedJsonLocations(result: SourceJobRecord, value: unknown, mapping: JsonFieldMapping,
  selector: string, sourceUrl: string, readField: (value: unknown, path: string) => unknown): void {
  const structured = fieldMappings.some(([, path]) => mapping[path] !== undefined);
  if (!structured) {
    // Preserve the previous string/string[] mapping, including its evidence and sanitization.
    const locations = Array.isArray(value) ? value.map(plainText).filter(Boolean) : plainText(value) ? [plainText(value)] : [];
    result.locations = [...new Set(locations)].map(raw => ({ raw }));
    if (locations.length) result.evidence.push({ field: 'locations', selector, sourceUrl });
    return;
  }

  const entries = Array.isArray(value) ? value : [value];
  const seen = new Map<string, number>();
  result.locations = [];
  for (const [index, entry] of entries.entries()) {
    const entrySelector = Array.isArray(value) ? `${selector}[${index}]` : selector;
    const disclosed: Partial<Record<typeof fieldMappings[number][0], string>> = {};
    const evidence: SourceJobRecord['evidence'] = [];
    for (const [field, pathKey] of fieldMappings) {
      const path = mapping[pathKey];
      if (path === undefined) continue;
      const original = readField(entry, path);
      if (typeof original !== 'string') continue;
      const text = plainText(original);
      if (!text) continue;
      disclosed[field] = text;
      evidence.push({ field: `locations.${field}`, selector: path ? `${entrySelector}.${path}` : entrySelector,
        quote: original.slice(0, 20_000), sourceUrl });
    }
    const country = disclosed.countryCode;
    const candidateCode = country?.toUpperCase();
    const countryCode = country === undefined ? undefined : mapping.locationCountryFormat === 'name'
      ? resolveSourceCountryCode(country) : candidateCode && /^[A-Z]{2}$/.test(candidateCode) && countryCodes.has(candidateCode) ? candidateCode : undefined;
    const raw = disclosed.raw ?? [disclosed.streetAddress, disclosed.city, disclosed.region, disclosed.postalCode, country].filter(Boolean).join(', ');
    if (!raw) continue;
    const location: SourceRecordLocation = { raw, ...(countryCode ? { countryCode } : {}),
      ...(disclosed.region ? { region: disclosed.region } : {}), ...(disclosed.city ? { city: disclosed.city } : {}),
      ...(disclosed.streetAddress ? { streetAddress: disclosed.streetAddress } : {}), ...(disclosed.postalCode ? { postalCode: disclosed.postalCode } : {}) };
    const key = JSON.stringify(location);
    let outputIndex = seen.get(key);
    if (outputIndex === undefined) { outputIndex = result.locations.length; seen.set(key, outputIndex); result.locations.push(location); }
    result.evidence.push(...evidence.map(item => {
      const field = item.field === 'locations.countryCode' && !countryCode ? 'country' : item.field.slice('locations.'.length);
      return { ...item, field: `locations.${outputIndex}.${field}` };
    }));
  }
}
