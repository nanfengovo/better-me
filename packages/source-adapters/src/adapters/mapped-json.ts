import { JsonMappingPathSchema, JsonFieldMappingSchema } from "../mapping-contracts.js";
export { JsonFieldMappingSchema, type JsonFieldMapping } from "../mapping-contracts.js";
import { ToolError } from '@better-me/opportunities';
import type { SourceAdapter } from '../contracts.js';
import { baseRecord, idValue, jsonResponse, page, plainText, publicUrl, timeValue } from './common.js';

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

/** One mapping is supplied through the source registry; feeds remain discovery leads by default. */
export const mappedJsonAdapter: SourceAdapter = {
  adapterId: 'mapped-json', version: '1', capabilities: ['list-jobs'], remoteFilters: [], entityTypes: ['job-posting', 'recruitment-campaign', 'discovery-lead'],
  async list(request) {
    if (request.cursor || !request.source.entryUrl) throw new ToolError('invalid-input');
    const options = request.source.options ?? {};
    const mappingKeys = ['recordsPath', 'idPath', 'titlePath', 'urlPath', 'applicationUrlPath', 'companyPath', 'descriptionPath', 'locationsPath', 'salaryTextPath', 'publishedPath', 'updatedPath', 'discoveryOnly'];
    const input = Object.fromEntries(mappingKeys.filter((key) => Object.hasOwn(options, key)).map((key) => [key, options[key]]));
    const parsed = JsonFieldMappingSchema.safeParse(input);
    if (!parsed.success) throw new ToolError('invalid-input');
    const mapping = parsed.data;
    const response = await jsonResponse(request, request.source.entryUrl);
    const rows = readJsonField(response.data, mapping.recordsPath);
    if (!Array.isArray(rows)) throw new ToolError('source-changed');
    const limit = request.source.refreshPolicy.maxRecords;
    const records = rows.slice(0, limit).map((row, index) => {
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
        if (result.entityType === 'job-posting') result.completeness = 'detail';
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
      const published = timeValue(get(mapping.publishedPath));
      const updated = timeValue(get(mapping.updatedPath));
      if (published.raw) result.sourcePublishedRaw = published.raw;
      if (published.at) result.sourcePublishedAt = published.at;
      if (updated.raw) result.sourceUpdatedRaw = updated.raw;
      if (updated.at) result.sourceUpdatedAt = updated.at;
      if (mapping.discoveryOnly) result.warnings.push('Discovery lead from a configured feed, not a verified live job. Follow the original posting before using it as job evidence.');
      return result;
    });
    return page(request, records, { totalAvailable: rows.length, fetchedRecords: rows.length, partial: rows.length > limit, stopReason: 'record-limit', warning: 'Configured JSON mapping does not execute upstream code, infer ownership, geocode locations or independently verify availability.' });
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
