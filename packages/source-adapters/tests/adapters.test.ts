import assert from 'node:assert/strict';
import test from 'node:test';
import type { SourceDefinition } from '@better-me/opportunities';
import type { SourceAdapter, SourceAdapterRequest, SourceAdapterContext } from '../src/contracts.js';
import { greenhouseAdapter } from '../src/adapters/greenhouse.js';
import { leverAdapter } from '../src/adapters/lever.js';
import { ashbyAdapter } from '../src/adapters/ashby.js';
import { githubJsonAdapter, JsonFieldMappingSchema, mappedJsonAdapter, readJsonField } from '../src/adapters/mapped-json.js';
import { plainText, timeValue } from '../src/adapters/common.js';

const NOW = '2026-10-18T00:00:00.000Z';
const context: SourceAdapterContext = {
  observedAt: NOW, requestId: 'synthetic-request', actorScope: 'synthetic-user', signal: new AbortController().signal,
  budget: { requests: 10, bytes: 100000, timeoutMs: 5000 },
  consumeRequests: () => undefined, consumeBytes: () => undefined, throwIfCancelled: () => undefined,
};
function source(adapter: SourceAdapter, options: SourceDefinition['options'] = {}): SourceDefinition {
  return {
    sourceId: 'synthetic-source', name: 'Synthetic source', adapterId: adapter.adapterId, adapterVersion: '1',
    capabilities: ['list-jobs'], runtime: ['local-service'], entityType: 'job-posting', enabled: true, status: 'active', remoteFilters: [],
    entryUrl: 'https://feeds.example.com/jobs.json', options: { boardToken: 'synthetic-board', companyName: 'Synthetic employer', ...options },
    endpointPolicy: { allowedHosts: ['feeds.example.com'], allowedPathPrefixes: ['/'], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: 'Synthetic source', usage: 'metadata', requiresAttribution: true },
    refreshPolicy: { mode: 'manual', minIntervalSeconds: 60, maxRecords: 100, maxPages: 2, requestsPerMinute: 30 },
  };
}
function request(adapter: SourceAdapter, data: unknown, options: SourceDefinition['options'] = {}): SourceAdapterRequest {
  return {
    source: source(adapter, options), scope: { roles: ['TypeScript'], regions: ['Shanghai'], companyNames: [] }, context,
    transport: { request: async ({ url }) => ({ url, status: 200, headers: {}, text: JSON.stringify(data) }) },
  };
}

test('Greenhouse keeps field provenance and source dates, strips active HTML and never verifies status from HTTP 200', async () => {
  const result = await greenhouseAdapter.list(request(greenhouseAdapter, {
    jobs: [{ id: 123, title: '<b>Synthetic engineer</b>', absolute_url: 'https://careers.example.com/jobs/123', company_name: 'Synthetic employer',
      content: '<p>Build TypeScript.</p><script>sendSecrets()</script>', location: { name: 'Shanghai, China' }, first_published: '2026-10-01', updated_at: '2026-10-17T12:00:00Z' }], meta: { total: 1 },
  }));
  assert.equal(result.records.length, 1);
  const record = result.records[0]!;
  assert.equal(record.title, 'Synthetic engineer'); assert.equal(record.description, 'Build TypeScript.');
  assert.equal(record.availability, 'unknown'); assert.equal(record.availabilityBasis, undefined);
  assert.equal(record.sourcePublishedRaw, '2026-10-01'); assert.equal(record.sourcePublishedAt, undefined);
  assert.equal(record.sourceUpdatedAt, '2026-10-17T12:00:00.000Z');
  assert.equal(record.locations[0]!.countryCode, undefined);
  assert.equal(record.evidence.some((entry) => entry.selector === 'jobs[0].location.name'), true);
  assert.deepEqual(result.coverage.appliedFilters, []); assert.deepEqual(result.coverage.ignoredFilters, ['roles', 'regions']);
  assert.equal(result.coverage.complete, true);
});

test('invalid source rows produce partial coverage and truncation is not complete enumeration', async () => {
  const input = request(greenhouseAdapter, { jobs: [
    { id: 1, title: 'Valid synthetic role' }, { id: 2, title: '' }, { id: 3, title: 'Beyond budget' },
  ] });
  input.source.refreshPolicy.maxRecords = 2;
  const result = await greenhouseAdapter.list(input);
  assert.equal(result.records.length, 2);
  assert.deepEqual(result.records.map((record) => record.sourceRecordId), ['1', '3']);
  assert.ok(result.warnings.some((warning) => warning.includes('1 downloaded source records failed validation')));
  assert.equal(result.coverage.complete, false); assert.equal(result.coverage.partial, true); assert.equal(result.stopReason, 'record-limit');
  assert.equal(result.coverage.totalAvailable, 3); assert.equal(result.coverage.fetchedRecords, 3);
});

test('Lever pagination and salary keep original currency/interval but do not invent tax/base evidence or ownership', async () => {
  const input = request(leverAdapter, [{
    id: 'synthetic-lever-id', text: 'Synthetic developer', hostedUrl: 'https://jobs.lever.co/synthetic/1', applyUrl: 'https://jobs.lever.co/synthetic/1/apply',
    descriptionPlain: 'Synthetic description', categories: { location: 'US / Canada', allLocations: ['US / Canada'] }, workplaceType: 'remote', country: 'US',
    salaryRange: { min: 85000, max: 175000, currency: 'USD', interval: 'per-year-salary' }, createdAt: 1_700_000_000_000,
  }]);
  input.source.refreshPolicy.maxRecords = 1;
  const result = await leverAdapter.list(input);
  assert.equal(result.nextCursor, '1'); assert.equal(result.coverage.complete, false); assert.equal(result.coverage.partial, false);
  const job = result.records[0]!;
  assert.equal(job.compensations[0]!.currency, 'USD'); assert.equal(job.compensations[0]!.period, 'year');
  assert.equal(job.compensations[0]!.tax, 'unknown'); assert.equal(job.compensations[0]!.kind, 'unknown');
  assert.deepEqual(job.locations, []); assert.deepEqual(job.remoteEligibleRegions, ['US / Canada']);
  assert.equal(job.availability, 'unknown'); assert.equal(job.sourcePublishedAt, '2023-11-14T22:13:20.000Z');
});

test('Ashby regional remote labels remain eligibility areas without invented office coordinates', async () => {
  const result = await ashbyAdapter.list(request(ashbyAdapter, { jobs: [{
    id: 'synthetic-ashby-id', title: 'Synthetic remote role', jobUrl: 'https://jobs.ashbyhq.com/synthetic/1', applyUrl: 'https://jobs.ashbyhq.com/synthetic/1/application',
    location: 'Europe', secondaryLocations: [{ location: 'European Union' }], isRemote: true, workplaceType: 'Remote', descriptionPlain: 'Synthetic responsibilities',
    publishedAt: '2026-10-12T09:00:00Z', compensation: { compensationTierSummary: 'USD 100000–150000 + equity' },
  }] }));
  const job = result.records[0]!;
  assert.deepEqual(job.locations, []); assert.deepEqual(job.remoteEligibleRegions, ['Europe', 'European Union']);
  assert.equal(job.compensations[0]!.kind, 'unknown'); assert.equal(job.compensations[0]!.min, undefined);
  assert.equal(job.availability, 'unknown'); assert.equal(job.sourcePublishedAt, '2026-10-12T09:00:00.000Z');
});

test('finite JSON mapping handles unrelated feed shape and does not upgrade campaigns/links to verified jobs', async () => {
  const input = request(mappedJsonAdapter, { payload: { rows: [{
    identity: 'synthetic-json-id', role: { caption: ['Synthetic campaign', 'Second original direction'], link: 'https://careers.example.com/campaign', employer: 'Synthetic company' },
    places: ['Shanghai', 'Beijing'], wage: '面议', updated: '2026-10-17', html: '<p>Source content</p>',
  }] } }, {
    recordsPath: 'payload.rows', idPath: 'identity', titlePath: 'role.caption', urlPath: 'role.link', companyPath: 'role.employer',
    locationsPath: 'places', salaryTextPath: 'wage', updatedPath: 'updated', descriptionPath: 'html',
  });
  const result = await mappedJsonAdapter.list(input);
  const job = result.records[0]!;
  assert.equal(job.entityType, 'discovery-lead'); assert.equal(job.completeness, 'lead');
  assert.equal(job.title, 'Synthetic campaign / Second original direction');
  assert.equal(job.companyName, 'Synthetic company'); assert.equal(job.description, 'Source content');
  assert.deepEqual(job.locations.map((entry) => entry.raw), ['Shanghai', 'Beijing']);
  assert.equal(job.compensations[0]!.raw, '面议'); assert.equal(job.sourceUpdatedAt, undefined);
  assert.equal(job.availability, 'unknown');
});

test('GitHub configured JSON is forcibly discovery-only, even if a config asks to call it verified posting data', async () => {
  const input = request(githubJsonAdapter, [{ id: 'lead-1', title: 'Synthetic listing', url: 'https://careers.example.com/lead' }], { idPath: 'id', titlePath: 'title', urlPath: 'url', discoveryOnly: false });
  input.source.entryUrl = 'https://raw.githubusercontent.com/example/jobs/main/listings.json';
  const result = await githubJsonAdapter.list(input);
  assert.equal(result.records[0]!.entityType, 'discovery-lead'); assert.equal(result.records[0]!.completeness, 'lead');
});

test('JSON mapping never evaluates paths or traverses prototype/accessor properties', () => {
  for (const titlePath of ['__proto__.x', 'constructor.name', 'x[0]', 'x.*', 'x();process.exit()']) {
    assert.equal(JsonFieldMappingSchema.safeParse({ titlePath }).success, false);
  }
  const object = Object.create({ inherited: 'secret' }) as Record<string, unknown>;
  let accessed = false;
  Object.defineProperty(object, 'getter', { get: () => { accessed = true; return 'secret'; } });
  assert.equal(readJsonField(object, 'inherited'), undefined); assert.equal(readJsonField(object, 'getter'), undefined); assert.equal(accessed, false);
  assert.equal(readJsonField({ data: [{ title: 'Synthetic' }] }, 'data.0.title'), 'Synthetic');
  assert.equal(readJsonField({ 岗位: [{ 名称: '合成岗位' }] }, '岗位.0.名称'), '合成岗位');
});

test('schema drift, invalid board slugs and invented cursors fail explicitly instead of claiming empty success', async () => {
  await assert.rejects(greenhouseAdapter.list(request(greenhouseAdapter, { somethingElse: [] })));
  const bad = request(ashbyAdapter, { jobs: [] }, { boardToken: '../other-company' });
  await assert.rejects(ashbyAdapter.list(bad));
  const invalidCursor = request(leverAdapter, []); invalidCursor.cursor = 'javascript:alert(1)';
  await assert.rejects(leverAdapter.list(invalidCursor));
});

test('encoded HTML is decoded before extraction and impossible dates remain raw instead of rolling into a new day', () => {
  assert.equal(plainText('&amp;lt;p&amp;gt;Synthetic text&amp;lt;/p&amp;gt;&lt;script&gt;sendSecret()&lt;/script&gt;'), 'Synthetic text');
  assert.deepEqual(timeValue('2026-02-30T12:00:00Z'), { raw: '2026-02-30T12:00:00Z' });
  assert.deepEqual(timeValue('2026-10-17'), { raw: '2026-10-17' });
});
