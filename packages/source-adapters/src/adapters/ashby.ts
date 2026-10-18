import { ToolError } from '@better-me/opportunities';
import type { SourceAdapter } from '../contracts.js';
import { baseRecord, companyName, idValue, jsonResponse, own, page, plainText, publicUrl, record, slug, timeValue, workMode } from './common.js';
import { allocateDownloadedRecordQuota } from './bounded-records.js';
import { applyAshbyCompensation, applyAshbyLocations } from './ashby-fields.js';

export const ashbyAdapter: SourceAdapter = {
  adapterId: 'ashby', version: '1', capabilities: ['list-jobs'], remoteFilters: [], entityTypes: ['job-posting'],
  async list(request) {
    if (request.cursor) throw new ToolError('invalid-input');
    const endpoint = `https://api.ashbyhq.com/posting-api/job-board/${slug(request.source)}?includeCompensation=true`;
    const response = await jsonResponse(request, endpoint);
    const jobs = own(response.data, 'jobs');
    if (!Array.isArray(jobs)) throw new ToolError('source-changed');
    const limit = request.source.refreshPolicy.maxRecords;
    const downloaded = jobs.map((value, index) => {
      const job = record(value);
      const result = baseRecord(plainText(job.title), response.url, `jobs[${index}].title`);
      result.sourceRecordId = idValue(job.id);
      result.url = publicUrl(job.jobUrl);
      result.applicationUrl = publicUrl(job.applyUrl) ?? result.url;
      result.companyName = companyName(request.source);
      result.workMode = workMode(job.workplaceType);
      if (result.workMode === 'unknown' && job.isRemote === true) result.workMode = 'remote';
      const descriptions = plainText(job.descriptionPlain ?? job.descriptionHtml);
      if (descriptions) { result.description = descriptions; result.completeness = 'detail'; result.evidence.push({ field: 'description', selector: `jobs[${index}].descriptionPlain`, sourceUrl: response.url }); }
      applyAshbyLocations(result, job, `jobs[${index}]`, response.url);
      const published = timeValue(job.publishedAt);
      if (published.raw) result.sourcePublishedRaw = published.raw;
      if (published.at) result.sourcePublishedAt = published.at;
      applyAshbyCompensation(result, job, `jobs[${index}]`, response.url);
      if (job.isListed === false) result.warnings.push('Source marks this posting as unlisted; this is not an independent availability verification.');
      return result;
    });
    const selected = allocateDownloadedRecordQuota(downloaded, request, limit);
    return page(request, selected.records, { totalAvailable: jobs.length, fetchedRecords: jobs.length,
      partial: jobs.length > limit || selected.invalidRecords > 0,
      stopReason: jobs.length > limit ? 'record-limit' : 'source-error',
      ...(selected.invalidRecords ? { warning: `${selected.invalidRecords} downloaded source records failed validation and were omitted; enumeration is partial.` } : {}),
    });
  },
};
