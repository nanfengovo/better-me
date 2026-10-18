import { ToolError } from '@better-me/opportunities';
import type { SourceAdapter } from '../contracts.js';
import { baseRecord, companyName, idValue, jsonResponse, own, page, plainText, publicUrl, record, slug, stringValue, timeValue, workMode } from './common.js';

export const ashbyAdapter: SourceAdapter = {
  adapterId: 'ashby', version: '1', capabilities: ['list-jobs'], remoteFilters: [], entityTypes: ['job-posting'],
  async list(request) {
    if (request.cursor) throw new ToolError('invalid-input');
    const endpoint = `https://api.ashbyhq.com/posting-api/job-board/${slug(request.source)}?includeCompensation=true`;
    const response = await jsonResponse(request, endpoint);
    const jobs = own(response.data, 'jobs');
    if (!Array.isArray(jobs)) throw new ToolError('source-changed');
    const limit = request.source.refreshPolicy.maxRecords;
    const records = jobs.slice(0, limit).map((value, index) => {
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
      const rawPlaces: Array<{ raw: string; countryCode?: string; region?: string; city?: string }> = [];
      const primary = stringValue(job.location);
      const address = record(own(job.address, 'postalAddress'));
      const countryValue = stringValue(address.addressCountry);
      const country = countryValue && /^[A-Za-z]{2}$/.test(countryValue) ? countryValue.toUpperCase() : undefined;
      if (primary) rawPlaces.push({ raw: primary, ...(country ? { countryCode: country } : {}), ...(stringValue(address.addressRegion) ? { region: stringValue(address.addressRegion) } : {}), ...(stringValue(address.addressLocality) ? { city: stringValue(address.addressLocality) } : {}) });
      if (Array.isArray(job.secondaryLocations)) for (const secondary of job.secondaryLocations) {
        const raw = stringValue(own(secondary, 'location'));
        if (raw && !rawPlaces.some((entry) => entry.raw === raw)) rawPlaces.push({ raw });
      }
      if (result.workMode === 'remote') result.remoteEligibleRegions = rawPlaces.map((entry) => entry.raw);
      else result.locations = rawPlaces;
      if (rawPlaces.length) result.evidence.push({ field: result.workMode === 'remote' ? 'remoteEligibleRegions' : 'locations', selector: `jobs[${index}].location`, sourceUrl: response.url });
      const published = timeValue(job.publishedAt);
      if (published.raw) result.sourcePublishedRaw = published.raw;
      if (published.at) result.sourcePublishedAt = published.at;
      const compensation = record(job.compensation);
      const compensationText = stringValue(compensation.compensationTierSummary) ?? stringValue(compensation.summary) ?? stringValue(compensation.scrapeableCompensationSalarySummary);
      if (compensationText) {
        result.compensations = [{ raw: compensationText, period: 'unknown', tax: 'unknown', kind: 'unknown' }];
        result.evidence.push({ field: 'compensations', selector: `jobs[${index}].compensation`, quote: compensationText, sourceUrl: response.url });
      }
      if (job.isListed === false) result.warnings.push('Source marks this posting as unlisted; this is not an independent availability verification.');
      return result;
    });
    return page(request, records, { totalAvailable: jobs.length, fetchedRecords: jobs.length, partial: jobs.length > limit, stopReason: 'record-limit' });
  },
};
