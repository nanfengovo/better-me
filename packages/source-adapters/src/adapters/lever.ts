import { ToolError } from '@better-me/opportunities';
import type { SourceAdapter, SourceRecordCompensation } from '../contracts.js';
import { baseRecord, companyName, idValue, jsonResponse, own, page, plainText, publicUrl, record, slug, stringValue, workMode } from './common.js';
import { allocateDownloadedRecordQuota } from './bounded-records.js';

export const leverAdapter: SourceAdapter = {
  adapterId: 'lever', version: '1', capabilities: ['list-jobs'], remoteFilters: [], entityTypes: ['job-posting'],
  async list(request) {
    const skip = request.cursor === undefined ? 0 : Number(request.cursor);
    if (!Number.isSafeInteger(skip) || skip < 0 || (request.cursor !== undefined && !/^\d{1,9}$/.test(request.cursor))) throw new ToolError('invalid-input');
    const limit = Math.min(100, request.source.refreshPolicy.maxRecords);
    const endpoint = `https://api.lever.co/v0/postings/${slug(request.source)}?mode=json&skip=${skip}&limit=${limit}`;
    const response = await jsonResponse(request, endpoint);
    if (!Array.isArray(response.data)) throw new ToolError('source-changed');
    const downloaded = response.data.map((value, index) => {
      const job = record(value);
      const result = baseRecord(plainText(job.text), response.url, `[${index}].text`);
      result.sourceRecordId = idValue(job.id);
      result.url = publicUrl(job.hostedUrl);
      result.applicationUrl = publicUrl(job.applyUrl) ?? result.url;
      result.companyName = companyName(request.source);
      const lists = Array.isArray(job.lists) ? job.lists.map((entry) => `${plainText(own(entry, 'text'))}\n${plainText(own(entry, 'content'))}`) : [];
      const description = [plainText(job.descriptionPlain ?? job.description ?? job.openingPlain ?? job.opening), ...lists, plainText(job.additionalPlain ?? job.additional)].filter(Boolean).join('\n\n');
      if (description) { result.description = description; result.completeness = 'detail'; result.evidence.push({ field: 'description', selector: `[${index}].descriptionPlain`, sourceUrl: response.url }); }
      const categories = record(job.categories);
      const locations = Array.isArray(categories.allLocations) ? categories.allLocations.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim())) : [];
      const primary = stringValue(categories.location);
      if (primary && !locations.includes(primary)) locations.unshift(primary);
      const country = typeof job.country === 'string' && /^[A-Za-z]{2}$/.test(job.country) ? job.country.toUpperCase() : undefined;
      result.workMode = workMode(job.workplaceType);
      if (result.workMode === 'remote') result.remoteEligibleRegions = [...new Set(locations)];
      else result.locations = [...new Set(locations)].map((raw) => ({ raw, ...(country ? { countryCode: country } : {}) }));
      if (locations.length) result.evidence.push({ field: result.workMode === 'remote' ? 'remoteEligibleRegions' : 'locations', selector: `[${index}].categories`, sourceUrl: response.url });
      const salary = record(job.salaryRange);
      const min = typeof salary.min === 'number' && Number.isFinite(salary.min) && salary.min >= 0 ? salary.min : undefined;
      const max = typeof salary.max === 'number' && Number.isFinite(salary.max) && salary.max >= 0 ? salary.max : undefined;
      if (min !== undefined || max !== undefined) {
        const periods: Record<string, SourceRecordCompensation['period']> = { 'per-year-salary': 'year', 'per-month-salary': 'month', 'per-hour-wage': 'hour', 'per-week-wage': 'week', 'per-day-wage': 'day' };
        const period = typeof salary.interval === 'string' && Object.hasOwn(periods, salary.interval) ? periods[salary.interval]! : 'unknown';
        const currency = typeof salary.currency === 'string' && /^[A-Z]{3}$/.test(salary.currency) ? salary.currency : undefined;
        result.compensations = [{ raw: JSON.stringify(salary), ...(currency ? { currency } : {}), ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), period, tax: 'unknown', kind: 'unknown' }];
        result.evidence.push({ field: 'compensations', selector: `[${index}].salaryRange`, quote: JSON.stringify(salary), sourceUrl: response.url });
        result.warnings.push('Structured salary range does not disclose tax basis or guaranteed fixed/variable composition.');
      }
      if (typeof job.createdAt === 'number' && Number.isSafeInteger(job.createdAt) && job.createdAt >= 0 && job.createdAt <= 8.64e15) {
        result.sourcePublishedRaw = String(job.createdAt);
        result.sourcePublishedAt = new Date(job.createdAt).toISOString();
      }
      return result;
    });
    const selected = allocateDownloadedRecordQuota(downloaded, request, limit);
    return page(request, selected.records, { fetchedRecords: response.data.length,
      ...(response.data.length >= limit ? { nextCursor: String(skip + response.data.length) } : {}),
      partial: response.data.length > limit || selected.invalidRecords > 0,
      stopReason: response.data.length > limit ? 'record-limit' : 'source-error',
      ...(selected.invalidRecords ? { warning: `${selected.invalidRecords} downloaded source records failed validation and were omitted; enumeration is partial.` } : {}),
    });
  },
};
