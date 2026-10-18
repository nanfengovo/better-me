import { ToolError } from '@better-me/opportunities';
import type { SourceAdapter } from '../contracts.js';
import { baseRecord, companyName, idValue, jsonResponse, own, page, plainText, publicUrl, record, slug, stringValue, timeValue } from './common.js';

export const greenhouseAdapter: SourceAdapter = {
  adapterId: 'greenhouse', version: '1', capabilities: ['list-jobs'], remoteFilters: [], entityTypes: ['job-posting'],
  async list(request) {
    if (request.cursor) throw new ToolError('invalid-input');
    const endpoint = `https://boards-api.greenhouse.io/v1/boards/${slug(request.source)}/jobs?content=true`;
    const response = await jsonResponse(request, endpoint);
    const jobs = own(response.data, 'jobs');
    if (!Array.isArray(jobs)) throw new ToolError('source-changed');
    const limit = request.source.refreshPolicy.maxRecords;
    const records = jobs.slice(0, limit).map((value, index) => {
      const job = record(value);
      const result = baseRecord(plainText(job.title), response.url, `jobs[${index}].title`);
      result.sourceRecordId = idValue(job.id);
      result.url = publicUrl(job.absolute_url);
      result.applicationUrl = result.url;
      result.companyName = stringValue(job.company_name) ?? companyName(request.source);
      const description = plainText(job.content);
      if (description) { result.description = description; result.completeness = 'detail'; result.evidence.push({ field: 'description', selector: `jobs[${index}].content`, sourceUrl: response.url }); }
      const location = plainText(own(job.location, 'name'));
      if (location) {
        result.locations = [{ raw: location }];
        result.evidence.push({ field: 'locations', selector: `jobs[${index}].location.name`, quote: location, sourceUrl: response.url });
      }
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
    return page(request, records, { totalAvailable: total, fetchedRecords: jobs.length, partial: jobs.length > limit || total > jobs.length, stopReason: jobs.length > limit ? 'record-limit' : 'source-error' });
  },
};
