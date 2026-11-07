import { normalizeGeographicName, ToolError } from '@better-me/opportunities';
import type { SourceAdapter } from '../contracts.js';
import { baseRecord, companyName, idValue, jsonResponse, own, page, plainText, publicUrl, record, slug, stringValue, timeValue } from './common.js';
import { allocateDownloadedRecordQuota } from './bounded-records.js';
import { resolveSourceCountryCode } from '../source-country.js';

type GreenhouseOffice = { streetAddress: string; raw: string; city: string; region: string; postalCode?: string; countryCode: 'US' };

const US_STATES = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'], ['CO', 'Colorado'],
  ['CT', 'Connecticut'], ['DE', 'Delaware'], ['DC', 'District of Columbia'], ['FL', 'Florida'], ['GA', 'Georgia'],
  ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'],
  ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'], ['MA', 'Massachusetts'],
  ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'],
  ['NE', 'Nebraska'], ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'],
  ['NY', 'New York'], ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'],
  ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'], ['SD', 'South Dakota'],
  ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'],
  ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
] as const;
function usRegion(value: string): string | undefined {
  const normalized = normalizeGeographicName(value).replace(/\./g, '');
  const match = US_STATES.find(([code, name]) => normalized === normalizeGeographicName(code) || normalized === normalizeGeographicName(name));
  return match?.[0];
}

function usComponents(value: string): { city: string; region: string; countryCode: 'US'; postalCode?: string; cityIndex: number } | undefined {
  const parts = value.split(',').map(part => part.trim()).filter(Boolean);
  const countryText = parts.at(-1);
  if (!countryText || resolveSourceCountryCode(countryText) !== 'US') return undefined;
  const countryIndex = parts.length - 1;
  for (let index = countryIndex - 1; index > 0; index--) {
    const stateToken = parts[index]!;
    const inline = stateToken.match(/^(.+?)\s+(\d{5}(?:-\d{4})?)$/);
    const region = usRegion(inline?.[1] ?? stateToken);
    if (!region) continue;
    const cityIndex = index - 1;
    const city = parts[cityIndex];
    if (!city) return undefined;
    const separatePostal = parts[index + 1] && index + 1 < countryIndex && /^\d{5}(?:-\d{4})?$/.test(parts[index + 1]!) ? parts[index + 1] : undefined;
    return { city, region, countryCode: 'US', ...(inline?.[2] || separatePostal ? { postalCode: inline?.[2] ?? separatePostal } : {}), cityIndex };
  }
  return undefined;
}

function greenhouseOfficeRaw(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length !== 1) return undefined;
  const office = record(value[0]), full = plainText(office.location);
  if (!full || full.length > 5000 || /[\p{Cc}\p{Cs}]/u.test(full)) return undefined;
  return full;
}

/** Parse only the reviewed US comma grammar. Other address grammars remain raw evidence. */
function greenhouseOffice(value: unknown): GreenhouseOffice | undefined {
  const full = greenhouseOfficeRaw(value);
  if (!full) return undefined;
  const parts = full.split(',').map((part) => part.trim()).filter(Boolean);
  const components = usComponents(full);
  if (!components) return undefined;
  const street = parts.slice(0, components.cityIndex).join(', ');
  if (!street || !/(?:^|\s)\d+[A-Za-z]?(?:[-/]\d+)?\s+\S+|\b(?:street|st\.?|road|rd\.?|avenue|ave\.?|drive|dr\.?|lane|ln\.?|boulevard|blvd\.?|parkway|pkwy\.?|way)\b/i.test(street)) return undefined;
  return { streetAddress: street, raw: full, city: components.city, region: components.region, ...(components.postalCode ? { postalCode: components.postalCode } : {}), countryCode: 'US' };
}

/** A Greenhouse office belongs to this listing only when US city/state/country all match exactly. */
function officeMatchesListing(office: GreenhouseOffice, listingLocation: string | undefined): boolean {
  if (!listingLocation) return false;
  const listing = usComponents(listingLocation);
  return !!listing && listing.countryCode === office.countryCode && listing.region === office.region
    && normalizeGeographicName(listing.city) === normalizeGeographicName(office.city);
}

export const greenhouseAdapter: SourceAdapter = {
  adapterId: 'greenhouse', version: '1', capabilities: ['list-jobs'], remoteFilters: [], entityTypes: ['job-posting'],
  async list(request) {
    if (request.cursor) throw new ToolError('invalid-input');
    const endpoint = `https://boards-api.greenhouse.io/v1/boards/${slug(request.source)}/jobs?content=true`;
    const response = await jsonResponse(request, endpoint);
    const jobs = own(response.data, 'jobs');
    if (!Array.isArray(jobs)) throw new ToolError('source-changed');
    const limit = request.source.refreshPolicy.maxRecords;
    const downloaded = jobs.map((value, index) => {
      const job = record(value);
      const result = baseRecord(plainText(job.title), response.url, `jobs[${index}].title`);
      result.sourceRecordId = idValue(job.id);
      result.url = publicUrl(job.absolute_url);
      result.applicationUrl = result.url;
      result.companyName = stringValue(job.company_name) ?? companyName(request.source);
      const description = plainText(job.content);
      if (description) { result.description = description; result.completeness = 'detail'; result.evidence.push({ field: 'description', selector: `jobs[${index}].content`, sourceUrl: response.url }); }
      const location = plainText(own(job.location, 'name'));
      const offices = own(job, 'offices');
      const office = greenhouseOffice(offices);
      const officeRaw = greenhouseOfficeRaw(offices);
      if (office && officeMatchesListing(office, location)) {
        result.locations = [{ raw: [location, office.raw].filter(Boolean).join(' · '), streetAddress: office.streetAddress, city: office.city, region: office.region, ...(office.postalCode ? { postalCode: office.postalCode } : {}), countryCode: office.countryCode }];
        if (location) result.evidence.push({ field: 'locations', selector: `jobs[${index}].location.name`, quote: location, sourceUrl: response.url });
        result.evidence.push({ field: 'locations.streetAddress', selector: `jobs[${index}].offices[0].location`, quote: office.raw, sourceUrl: response.url });
        if (office.postalCode) result.evidence.push({ field: 'locations.postalCode', selector: `jobs[${index}].offices[0].location`, quote: office.postalCode, sourceUrl: response.url });
      } else if (location) {
        result.locations = [{ raw: location }];
        result.evidence.push({ field: 'locations', selector: `jobs[${index}].location.name`, quote: location, sourceUrl: response.url });
      }
      if (officeRaw && (!office || !officeMatchesListing(office, location))) result.evidence.push({ field: 'unassociatedOfficeEvidence', selector: `jobs[${index}].offices[0].location`, quote: officeRaw, sourceUrl: response.url });
      const published = timeValue(job.first_published);
      const updated = timeValue(job.updated_at);
      if (published.raw) result.sourcePublishedRaw = published.raw;
      if (published.at) result.sourcePublishedAt = published.at;
      if (updated.raw) result.sourceUpdatedRaw = updated.raw;
      if (updated.at) result.sourceUpdatedAt = updated.at;
      return result;
    });
    const declaredTotal = own(own(response.data, 'meta'), 'total');
    const total = typeof declaredTotal === 'number' && Number.isSafeInteger(declaredTotal) && declaredTotal >= jobs.length ? declaredTotal : jobs.length;
    const selected = allocateDownloadedRecordQuota(downloaded, request, limit);
    return page(request, selected.records, { totalAvailable: total, fetchedRecords: jobs.length,
      partial: jobs.length > limit || total > jobs.length || selected.invalidRecords > 0,
      stopReason: jobs.length > limit ? 'record-limit' : 'source-error',
      ...(selected.invalidRecords ? { warning: `${selected.invalidRecords} downloaded source records failed validation and were omitted; enumeration is partial.` } : {}),
    });
  },
};
