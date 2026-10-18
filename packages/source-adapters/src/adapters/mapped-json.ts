import { JsonMappingPathSchema, JsonFieldMappingSchema, type JsonFieldMapping } from "../mapping-contracts.js";
export { JsonFieldMappingSchema, type JsonFieldMapping } from "../mapping-contracts.js";
import { ToolError } from '@better-me/opportunities';
import type { SourceAdapter } from '../contracts.js';
import { baseRecord, idValue, jsonResponse, page, plainText, publicUrl, timeValue } from './common.js';
import { allocateDownloadedRecordQuota } from './bounded-records.js';

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
    if (request.cursor || !request.source.entryUrl) throw new ToolError('invalid-input');
    const options = request.source.options ?? {};
    const mappingKeys = ['recordsPath', 'idPath', 'titlePath', 'urlPath', 'applicationUrlPath', 'companyPath', 'descriptionPath', 'locationsPath', 'salaryTextPath', 'publishedPath', 'updatedPath', 'descriptionCompleteness', 'enumerationComplete', 'publishedFormat', 'discoveryOnly'];
    const input = Object.fromEntries(mappingKeys.filter((key) => Object.hasOwn(options, key)).map((key) => [key, options[key]]));
    const parsed = JsonFieldMappingSchema.safeParse(input);
    if (!parsed.success) throw new ToolError('invalid-input');
    const mapping = parsed.data;
    const response = await jsonResponse(request, request.source.entryUrl);
    const rows = readJsonField(response.data, mapping.recordsPath);
    if (!Array.isArray(rows)) throw new ToolError('source-changed');
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
      const locations = Array.isArray(places) ? places.map(plainText).filter(Boolean) : plainText(places) ? [plainText(places)] : [];
      result.locations = [...new Set(locations)].map((raw) => ({ raw }));
      if (locations.length) result.evidence.push({ field: 'locations', selector: `${mapping.recordsPath}[${index}].${mapping.locationsPath}`, sourceUrl: response.url });
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
