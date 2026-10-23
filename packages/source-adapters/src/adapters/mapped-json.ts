import { JsonMappingPathSchema, JsonFieldMappingSchema, type JsonFieldMapping } from "../mapping-contracts.js";
export { JsonFieldMappingSchema, type JsonFieldMapping } from "../mapping-contracts.js";
import { ToolError } from '@better-me/opportunities';
import type { SourceAdapter } from '../contracts.js';
import { baseRecord, idValue, jsonResponse, page, plainText, publicUrl, timeValue } from './common.js';
import { allocateDownloadedRecordQuota, allocateDownloadedRecordWindow } from './bounded-records.js';
import { resolveJsonPage, readJsonNextPage, jsonContinuation, jsonPageFingerprint } from './mapped-json-pagination.js';
import { applyMappedJsonLocations } from './mapped-json-locations.js';

/** No eval, bracket expressions, wildcards, getters, prototype traversal or JavaScript mapping code. */
export function readJsonField(value: unknown, path: string): unknown {
  if (!JsonMappingPathSchema.safeParse(path).success) throw new ToolError('invalid-input');
  if (path === '') return value;
  let cursor: unknown = value;
  for (const part of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(cursor, part);
    if (!descriptor || !('value' in descriptor)) return undefined;
    cursor = descriptor.value;
  }
  return cursor;
}

/** Explicit units only: retain the source value if its epoch cannot safely become a four-digit UTC year. */
function publicationTime(value: unknown, format: JsonFieldMapping['publishedFormat']): { raw?: string; at?: string } {
  if (format === 'iso') return timeValue(value);
  const raw = typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' && value.trim() ? value.trim() : undefined;
  if (raw === undefined) return {};
  const amount = typeof value === 'number' ? value : /^(?:0|[1-9]\d*)$/.test(raw) ? Number(raw) : Number.NaN;
  const maximum = format === 'unix-seconds' ? 253_402_300_799 : 253_402_300_799_999;
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > maximum) return { raw };
  const milliseconds = format === 'unix-seconds' ? amount * 1000 : amount;
  return { raw, at: new Date(milliseconds).toISOString() };
}

/** One mapping is supplied through the source registry; feeds remain discovery leads by default. */
export const mappedJsonAdapter: SourceAdapter = {
  adapterId: 'mapped-json', version: '1', capabilities: ['list-jobs'], remoteFilters: [], entityTypes: ['job-posting', 'recruitment-campaign', 'discovery-lead'],
  async list(request) {
    if (!request.source.entryUrl) throw new ToolError('invalid-input');
    const options = request.source.options ?? {};
    const mappingKeys = ['recordsPath', 'idPath', 'titlePath', 'urlPath', 'applicationUrlPath', 'companyPath', 'descriptionPath', 'locationsPath',
      'locationTextPath', 'locationCountryPath', 'locationCountryFormat', 'locationRegionPath', 'locationCityPath', 'locationStreetAddressPath', 'locationPostalCodePath',
      'salaryTextPath', 'publishedPath', 'updatedPath', 'descriptionCompleteness', 'enumerationComplete', 'publishedFormat', 'nextPageUrlPath', 'pageParameter', 'discoveryOnly'];
    const input = Object.fromEntries(mappingKeys.filter((key) => Object.hasOwn(options, key)).map((key) => [key, options[key]]));
    const parsed = JsonFieldMappingSchema.safeParse(input);
    if (!parsed.success) throw new ToolError('invalid-input');
    const mapping = parsed.data;
    if (request.cursor && !mapping.nextPageUrlPath) throw new ToolError('invalid-input');
    const state = mapping.nextPageUrlPath ? resolveJsonPage(request, mapping) : undefined;
    const response = await jsonResponse(request, state?.url ?? request.source.entryUrl);
    if (state && response.url !== state.url) throw new ToolError('source-changed');
    const rows = readJsonField(response.data, mapping.recordsPath);
    if (!Array.isArray(rows)) throw new ToolError('source-changed');
    const snapshot = state ? jsonPageFingerprint(response.data) : undefined;
    if (state?.offset && state.snapshot !== snapshot) throw new ToolError('source-changed');
    const limit = request.source.refreshPolicy.maxRecords;
    const downloaded = rows.map((row, index) => {
      if (index % 64 === 0) request.context.throwIfCancelled();
      const get = (path?: string) => path === undefined ? undefined : readJsonField(row, path);
      const rawTitle = get(mapping.titlePath);
      const title = Array.isArray(rawTitle) ? rawTitle.map(plainText).filter(Boolean).join(' / ') : plainText(rawTitle);
      const result = baseRecord(title, response.url, `${mapping.recordsPath}[${index}].${mapping.titlePath}`);
      result.entityType = mapping.discoveryOnly ? 'discovery-lead' : request.source.entityType === 'recruitment-campaign' ? 'recruitment-campaign' : 'job-posting';
      result.completeness = result.entityType === 'job-posting' ? 'excerpt' : 'lead';
      result.sourceRecordId = idValue(get(mapping.idPath));
      result.url = publicUrl(get(mapping.urlPath));
      result.applicationUrl = publicUrl(get(mapping.applicationUrlPath));
      const company = plainText(get(mapping.companyPath));
      if (company) result.companyName = company;
      const rawDescription = get(mapping.descriptionPath);
      const description = Array.isArray(rawDescription) ? rawDescription.map(plainText).filter(Boolean).join('\n') : plainText(rawDescription);
      if (description) {
        result.description = description;
        if (result.entityType === 'job-posting') result.completeness = mapping.descriptionCompleteness;
        result.evidence.push({ field: 'description', selector: `${mapping.recordsPath}[${index}].${mapping.descriptionPath}`, sourceUrl: response.url });
      }
      const places = get(mapping.locationsPath);
      const rowSelector = `${mapping.recordsPath}[${index}]`;
      applyMappedJsonLocations(result, places, mapping,
        mapping.locationsPath === '' ? rowSelector : `${rowSelector}.${mapping.locationsPath}`, response.url, readJsonField);
      const salary = plainText(get(mapping.salaryTextPath));
      if (salary) {
        result.compensations = [{ raw: salary, period: 'unknown', tax: 'unknown', kind: 'unknown' }];
        result.evidence.push({ field: 'compensations', selector: `${mapping.recordsPath}[${index}].${mapping.salaryTextPath}`, quote: salary, sourceUrl: response.url });
      }
      const published = publicationTime(get(mapping.publishedPath), mapping.publishedFormat);
      const updated = timeValue(get(mapping.updatedPath));
      if (published.raw) result.sourcePublishedRaw = published.raw;
      if (published.at) result.sourcePublishedAt = published.at;
      if (published.raw) result.evidence.push({ field: 'sourcePublishedRaw', selector: `${mapping.recordsPath}[${index}].${mapping.publishedPath}`, quote: published.raw, sourceUrl: response.url });
      if (published.raw && !published.at && mapping.publishedFormat !== 'iso') result.warnings.push('The explicitly configured publication epoch is invalid or outside the supported range; its original value was retained without a parsed timestamp.');
      if (updated.raw) result.sourceUpdatedRaw = updated.raw;
      if (updated.at) result.sourceUpdatedAt = updated.at;
      if (mapping.discoveryOnly) result.warnings.push('Discovery lead from a configured feed, not a verified live job. Follow the original posting before using it as job evidence.');
      return result;
    });
    if (state) {
      const selected = allocateDownloadedRecordWindow(downloaded, request, limit, state.offset);
      if (state.offset && state.offset >= selected.totalRecords) throw new ToolError('source-changed');
      const next = readJsonNextPage(readJsonField(response.data, mapping.nextPageUrlPath!), state);
      const moreInPage = selected.nextOffset < selected.totalRecords;
      const nextCursor = moreInPage ? jsonContinuation(state, state.page, selected.nextOffset, snapshot)
        : next.page !== undefined ? jsonContinuation(state, next.page) : undefined;
      return page(request, selected.records, { fetchedRecords: rows.length, ...(nextCursor ? { nextCursor } : {}),
        partial: selected.invalidRecords > 0 || next.invalid || !mapping.enumerationComplete,
        stopReason: selected.invalidRecords > 0 || next.invalid ? 'source-error' : 'page-limit',
        warning: [
          'Configured JSON pagination follows only source-returned numeric pages of the same reviewed endpoint; each call still downloads its full page before applying the output limit.',
          ...(selected.invalidRecords ? [`${selected.invalidRecords} downloaded source records failed validation and were omitted; enumeration is partial.`] : []),
          ...(next.invalid ? ['The source next-page field was missing or unsafe; records were retained, but complete upstream enumeration is not claimed.'] : []),
          ...(!mapping.enumerationComplete ? ['This feed does not claim complete upstream enumeration even at its last returned page.'] : []),
        ].join(' '),
      });
    }
    const selected = allocateDownloadedRecordQuota(downloaded, request, limit);
    return page(request, selected.records, { ...(mapping.enumerationComplete ? { totalAvailable: rows.length } : {}), fetchedRecords: rows.length,
      partial: rows.length > limit || selected.invalidRecords > 0 || !mapping.enumerationComplete,
      stopReason: rows.length > limit ? 'record-limit' : selected.invalidRecords ? 'source-error' : 'page-limit',
      warning: [
        'Configured JSON mapping does not execute upstream code, infer ownership, geocode locations or independently verify availability.',
        ...(!mapping.enumerationComplete ? ['This configured feed is a finite page or latest-jobs window; complete upstream enumeration is not claimed.'] : []),
        ...(selected.invalidRecords ? [`${selected.invalidRecords} downloaded source records failed validation and were omitted; enumeration is partial.`] : []),
      ].join(' '),
    });
  },
};

/** Same finite JSON mapping, with source links retained and discovery-only semantics enforced. */
export const githubJsonAdapter: SourceAdapter = {
  ...mappedJsonAdapter,
  adapterId: 'github-json',
  entityTypes: ['discovery-lead'],
  async list(request) {
    if (!request.source.entryUrl) throw new ToolError('invalid-input');
    const url = new URL(request.source.entryUrl);
    if (url.hostname !== 'raw.githubusercontent.com' || url.pathname.split('/').filter(Boolean).length < 4) throw new ToolError('invalid-input');
    return mappedJsonAdapter.list({ ...request, source: { ...request.source, options: { ...request.source.options, discoveryOnly: true } } });
  },
};
