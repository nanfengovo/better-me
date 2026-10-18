import { resolveLegacyCountryCode } from '@better-me/opportunities';
import type { SourceJobRecord, SourceRecordLocation } from '../contracts.js';
import { own, record, stringValue } from './common.js';

/** Interpret explicit address fields only; a board, currency or region label is not a country. */
function location(value: unknown): SourceRecordLocation | undefined {
  const input = record(value);
  const address = record(input.address);
  const postal = Object.hasOwn(address, 'postalAddress') ? record(address.postalAddress) : address;
  const country = stringValue(postal.addressCountry);
  const countryCode = country && (/^[a-z]{2}$/i.test(country) ? country.toUpperCase() : resolveLegacyCountryCode(country));
  const region = stringValue(postal.addressRegion);
  const city = stringValue(postal.addressLocality);
  // If a label is missing, retain the disclosed address values as readable source text.
  const raw = stringValue(input.location) ?? [city, region, country].filter(Boolean).join(', ');
  return raw ? { raw, ...(countryCode ? { countryCode } : {}), ...(region ? { region } : {}), ...(city ? { city } : {}) } : undefined;
}

export function applyAshbyLocations(result: SourceJobRecord, job: Record<string, unknown>, selector: string, sourceUrl: string): void {
  const entries = [{ value: job, selector }, ...(Array.isArray(job.secondaryLocations)
    ? job.secondaryLocations.map((value, index) => ({ value, selector: `${selector}.secondaryLocations[${index}]` })) : [])];
  const seen = new Set<string>();
  for (const entry of entries) {
    const place = location(entry.value);
    if (!place) continue;
    const key = JSON.stringify(place);
    if (seen.has(key)) continue;
    seen.add(key);
    const remote = result.workMode === 'remote';
    if (remote && place.raw.length <= 240 && !result.remoteEligibleRegions.includes(place.raw)) result.remoteEligibleRegions.push(place.raw);
    // Broad labels such as Europe remain text, never a set of inferred countries or offices.
    if (!remote || place.countryCode || place.region || place.city) result.locations.push(place);
    result.evidence.push({ field: remote && !place.countryCode && !place.region && !place.city ? 'remoteEligibleRegions' : 'locations', selector: `${entry.selector}.${own(entry.value, 'address') ? 'address' : 'location'}`,
      quote: JSON.stringify({ location: own(entry.value, 'location'), address: own(entry.value, 'address') }).slice(0, 20_000), sourceUrl });
  }
}

const monetaryKinds = new Map<string, SourceJobRecord['compensations'][number]['kind']>([
  ['Salary', 'base'], ['Bonus', 'bonus'], ['Commission', 'unknown'], ['EquityCashValue', 'equity'],
]);
const amount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000_000 ? value : undefined;

export function applyAshbyCompensation(result: SourceJobRecord, job: Record<string, unknown>, selector: string, sourceUrl: string): void {
  const compensation = record(job.compensation);
  const tiers = Array.isArray(compensation.compensationTiers) ? compensation.compensationTiers : [];
  const appendRaw = (raw: string, path: string) => {
    result.compensations.push({ raw: raw.slice(0, 5000), period: 'unknown', tax: 'unknown', kind: 'unknown' });
    result.evidence.push({ field: 'compensations', selector: path, quote: raw.slice(0, 20_000), sourceUrl });
  };
  for (const [tierIndex, value] of tiers.entries()) {
    const tier = record(value);
    const title = stringValue(tier.title);
    const tierPath = `${selector}.compensation.compensationTiers[${tierIndex}]`;
    const tierSummary = stringValue(tier.tierSummary);
    if (title || tierSummary) result.evidence.push({ field: 'compensations.tier', selector: tierPath,
      quote: JSON.stringify({ title, tierSummary }).slice(0, 20_000), sourceUrl });
    const components = Array.isArray(tier.components) ? tier.components : [];
    for (const [componentIndex, value] of components.entries()) {
      const component = record(value);
      if (!Object.keys(component).length) continue;
      const original = JSON.stringify(component);
      const type = stringValue(component.compensationType);
      const monetary = type !== undefined && monetaryKinds.has(type);
      const currency = monetary ? stringValue(component.currencyCode) : undefined;
      const interval = stringValue(component.interval);
      const summary = stringValue(component.summary) ?? ([type, stringValue(component.currencyCode),
        typeof component.minValue === 'number' ? String(component.minValue) : undefined,
        typeof component.maxValue === 'number' ? String(component.maxValue) : undefined].filter(Boolean).join(' / ') || 'Unspecified compensation component');
      const raw = [title, type, summary, currency, interval].filter(Boolean).join(' · ').slice(0, 5000);
      const min = monetary ? amount(component.minValue) : undefined;
      const max = monetary ? amount(component.maxValue) : undefined;
      const ordered = min === undefined || max === undefined || min <= max;
      result.compensations.push({ raw, period: monetary && component.interval === '1 YEAR' ? 'year' : 'unknown', tax: 'unknown',
        kind: type ? monetaryKinds.get(type) ?? 'unknown' : 'unknown',
        ...(currency && /^[A-Z]{3}$/.test(currency) ? { currency } : {}),
        ...(ordered && min !== undefined ? { min } : {}), ...(ordered && max !== undefined ? { max } : {}) });
      result.evidence.push({ field: 'compensations', selector: `${tierPath}.components[${componentIndex}]`, quote: original.slice(0, 20_000), sourceUrl });
      if (!ordered) result.warnings.push('An Ashby component has reversed bounds; its original values are retained without a comparable amount.');
    }
    if (!components.length && stringValue(tier.tierSummary)) appendRaw([title, tier.tierSummary].filter(Boolean).join(' · '), `${tierPath}.tierSummary`);
    const additional = stringValue(tier.additionalInformation);
    if (additional) appendRaw([title, additional].filter(Boolean).join(' · '), `${tierPath}.additionalInformation`);
  }
  // summaryComponents can be an envelope across tiers, not another payment or a local rate.
  if (!result.compensations.length) {
    const summary = stringValue(compensation.compensationTierSummary) ?? stringValue(compensation.summary) ?? stringValue(compensation.scrapeableCompensationSalarySummary);
    if (summary) appendRaw(summary, `${selector}.compensation`);
  }
  if (tiers.length > 1) result.warnings.push('Ashby compensation tiers are retained separately; tier labels do not establish location bindings.');
}
