import { ToolError } from '@better-me/opportunities';
import { SourcePageSchema, type SourceAdapter, type SourceJobRecord } from '../contracts.js';
import { allocateDownloadedRecordQuota } from './bounded-records.js';
import { baseRecord, idValue, jsonResponse, own, plainText, publicUrl, record, timeValue } from './common.js';

const API_ORIGIN = 'https://remotive.com';
const API_PATH = '/api/remote-jobs';
const MAX_TERMS = 12;
const MAX_TERM_LENGTH = 80;

/** Remotive requires its original listing URL to be retained for attribution. */
function originalPostingUrl(value: unknown): string | undefined {
  const candidate = publicUrl(value);
  if (!candidate) return undefined;
  const url = new URL(candidate);
  return url.origin === API_ORIGIN && url.pathname.startsWith("/remote-jobs/") && !url.search && !url.hash ? candidate : undefined;
}

/** Finite public feed. Each refresh reads only the first active feed window and remains partial. */
export const remotiveAdapter: SourceAdapter = {
  adapterId: 'remotive', version: '1', capabilities: ['list-jobs'],
  remoteFilters: ['roles', 'companyNames'], entityTypes: ['job-posting'],
  async list(request) {
    if (request.cursor) throw new ToolError('invalid-input');
    const entry = new URL(request.source.entryUrl ?? `${API_ORIGIN}${API_PATH}`);
    if (entry.origin !== API_ORIGIN || entry.pathname !== API_PATH || entry.username || entry.password || entry.hash || entry.search) {
      throw new ToolError('invalid-input');
    }
    const terms = [...new Set(request.scope.roles.map(value => value.trim()).filter(Boolean))];
    const companies = [...new Set(request.scope.companyNames.map(value => value.trim()).filter(Boolean))];
    const categoryValue = request.source.options?.category;
    const category = typeof categoryValue === 'string' ? categoryValue : undefined;
    if (categoryValue !== undefined && category === undefined) throw new ToolError('invalid-input');
    if (typeof category === 'string' && (!category.trim() || category.length > MAX_TERM_LENGTH || /[\p{Cc}\p{Cs}]/u.test(category))) throw new ToolError('invalid-input');
    if (terms.length > MAX_TERMS || companies.length > MAX_TERMS
      || [...terms, ...companies].some(value => value.length > MAX_TERM_LENGTH || /[\p{Cc}\p{Cs}]/u.test(value))) throw new ToolError('invalid-input');

    const url = new URL(`${API_ORIGIN}${API_PATH}`);
    if (category) url.searchParams.set('category', category);
    if (companies.length === 1) url.searchParams.set('company_name', companies[0]!);
    // The endpoint accepts one text query per request. Never join multiple interests
    // into a phrase that would silently change OR intent; leave them to local matching.
    if (terms.length === 1) url.searchParams.set('search', terms[0]!);
    url.searchParams.set('limit', String(Math.min(100, request.source.refreshPolicy.maxRecords)));
    const response = await jsonResponse(request, url.toString());
    const payload = record(response.data);
    const rows = own(payload, 'jobs');
    if (!Array.isArray(rows) || !rows.every(row => row !== null && typeof row === 'object' && !Array.isArray(row))) throw new ToolError('source-changed');
    const downloaded: SourceJobRecord[] = rows.map((value, index) => {
      const row = record(value), title = plainText(own(row, 'title'));
      const selector = `jobs[${index}]`;
      const job = baseRecord(title, response.url, `${selector}.title`);
      job.sourceRecordId = idValue(own(row, 'id'));
      job.url = originalPostingUrl(own(row, 'url'));
      job.companyName = plainText(own(row, 'company_name')) || undefined;
      const description = plainText(own(row, 'description'));
      if (description) {
        job.description = description;
        job.completeness = 'detail';
        job.evidence.push({ field: 'description', selector: `${selector}.description`, sourceUrl: response.url });
      }
      const candidateLocation = plainText(own(row, 'candidate_required_location'));
      if (candidateLocation) {
        job.remoteEligibleRegions = [candidateLocation];
        job.evidence.push({ field: 'remoteEligibleRegions', selector: `${selector}.candidate_required_location`, quote: candidateLocation, sourceUrl: response.url });
      }
      const salary = plainText(own(row, 'salary'));
      if (salary) {
        // Remotive describes this field as usually USD/year, but it is optional and can
        // contain task, hourly or non-numeric text. Preserve the exact text only.
        job.compensations = [{ raw: salary, period: 'unknown', tax: 'unknown', kind: 'unknown' }];
        job.evidence.push({ field: 'compensations', selector: `${selector}.salary`, quote: salary, sourceUrl: response.url });
      }
      // Remotive examples use both timezone-free ISO-like text and slash-separated
      // local timestamps; retain these raw because no timezone is disclosed.
      const publishedRaw = plainText(own(row, 'publication_date'));
      const published = timeValue(publishedRaw);
      if (published.raw) job.sourcePublishedRaw = published.raw;
      if (published.at) job.sourcePublishedAt = published.at;
      if (published.raw) job.evidence.push({ field: 'sourcePublishedRaw', selector: `${selector}.publication_date`, quote: published.raw, sourceUrl: response.url });
      const type = plainText(own(row, 'job_type')).toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');
      if (type === 'internship') job.employmentType = 'internship';
      else if (type === 'full_time' || type === 'part_time') job.employmentType = 'social';
      const tags = own(row, 'tags');
      if (Array.isArray(tags)) {
        const quote = tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0).slice(0, 30).join(', ');
        if (quote) job.evidence.push({ field: 'sourceTags', selector: `${selector}.tags`, quote, sourceUrl: response.url });
      }
      job.workMode = 'remote';
      job.warnings.push('Remotive lists remote work; candidate eligibility regions are retained separately and do not represent an office address. The feed is a delayed finite active-jobs window, not a complete remote-market search. Salary is preserved as source text without inferring currency, period, gross/net or base pay.');
      return job;
    });
    const linked = downloaded.filter(job => Boolean(job.url));
    const invalidLinks = downloaded.length - linked.length;
    const selected = allocateDownloadedRecordQuota(linked, request, request.source.refreshPolicy.maxRecords);
    const localIgnored = (['roles', 'regions', 'companyNames'] as const).filter((key) => {
      if (key === 'roles') return terms.length > 1;
      if (key === 'companyNames') return companies.length > 1;
      return request.scope[key].length > 0;
    });
    const appliedFilters = [
      ...(terms.length === 1 ? ['roles' as const] : []),
      ...(companies.length === 1 ? ['companyNames' as const] : []),
    ];
    const warning = `Remotive API returns a finite delayed jobs window; complete market enumeration is not available. The API advises at most four reads per day, blocks over two per minute, requires Remotive attribution and original-posting links, prohibits forwarding listings to third-party job sites, and prohibits collecting signup/email leads on a listing site. ${invalidLinks ? `${invalidLinks} records without a validated Remotive original listing URL were omitted. ` : ''}${selected.invalidRecords ? `${selected.invalidRecords} other invalid records were omitted. ` : ''}Candidate eligibility regions are not office locations.`;
    return SourcePageSchema.parse({
      records: selected.records, observedAt: request.context.observedAt,
      coverage: { complete: false, partial: true, fetchedRecords: rows.length, appliedFilters, ignoredFilters: localIgnored },
      stopReason: 'page-limit', warnings: [warning],
    });
  },
};
