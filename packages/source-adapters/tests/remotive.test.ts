import assert from 'node:assert/strict';
import test from 'node:test';
import { SourceDefinitionSchema } from '@better-me/opportunities';
import type { SourceAdapterContext } from '../src/contracts.js';
import { remotiveAdapter } from '../src/adapters/remotive.js';

const observedAt = '2026-10-24T12:00:00.000Z';
const context: SourceAdapterContext = { observedAt, requestId: 'remotive-synthetic', actorScope: 'synthetic-user', signal: new AbortController().signal,
  budget: { requests: 2, bytes: 100_000, timeoutMs: 5000 }, consumeRequests: () => undefined, consumeBytes: () => undefined, throwIfCancelled: () => undefined };
function source(overrides: Record<string, unknown> = {}) {
  return SourceDefinitionSchema.parse({ sourceId: 'remotive-public-feed', name: 'Remotive public feed', adapterId: 'remotive', adapterVersion: '1',
    capabilities: ['list-jobs'], runtime: ['local-service'], entityType: 'job-posting', enabled: true, status: 'active',
    entryUrl: 'https://remotive.com/api/remote-jobs', options: {}, remoteFilters: ['roles', 'companyNames'],
    endpointPolicy: { allowedHosts: ['remotive.com'], allowedPathPrefixes: ['/api/remote-jobs'], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: 'Remotive · 原始职位回链', homepageUrl: 'https://github.com/remotive-com/remote-jobs-api', usage: 'unknown', requiresAttribution: true },
    refreshPolicy: { mode: 'manual', minIntervalSeconds: 21600, maxRecords: 100, maxPages: 1, requestsPerMinute: 2 }, ...overrides });
}
function input(data: unknown, roles: string[] = [], regions: string[] = [], companyNames: string[] = []) {
  const urls: string[] = [];
  return { urls, source: source(), scope: { roles, regions, companyNames }, context,
    transport: { async request({ url }: { url: string }) { urls.push(url); return { url, status: 200, headers: {}, text: JSON.stringify(data) }; } } };
}
const listing = { id: 123, title: 'Senior Software Engineer', company_name: 'Synthetic Co',
  url: 'https://remotive.com/remote-jobs/software-dev/senior-engineer-123',
  description: '<p>Build <strong>TypeScript</strong> systems.</p><script>drop()</script>',
  publication_date: '2026/10/22 18:40:19', candidate_required_location: 'Worldwide', salary: '$1000 per task',
  job_type: 'contract', tags: ['TypeScript', 'systems'] };

test('Remotive reads one finite API page, filters with documented parameters and preserves remote eligibility evidence', async () => {
  const request = input({ jobs: [listing] }, ['TypeScript'], ['Europe'], ['Synthetic Co']);
  const result = await remotiveAdapter.list(request);
  const job = result.records[0]!;
  const query = new URL(request.urls[0]!);
  assert.equal(query.origin + query.pathname, 'https://remotive.com/api/remote-jobs');
  assert.equal(query.searchParams.get('search'), 'TypeScript'); assert.equal(query.searchParams.get('company_name'), 'Synthetic Co');
  assert.equal(query.searchParams.get('limit'), '100');
  assert.equal(job.sourceRecordId, '123'); assert.equal(job.companyName, 'Synthetic Co');
  assert.equal(job.description, 'Build TypeScript systems.'); assert.equal(job.completeness, 'detail');
  assert.equal(job.workMode, 'remote'); assert.deepEqual(job.locations, []);
  assert.deepEqual(job.remoteEligibleRegions, ['Worldwide']);
  assert.equal(job.compensations[0]?.raw, '$1000 per task'); assert.equal(job.compensations[0]?.currency, undefined);
  assert.equal(job.compensations[0]?.period, 'unknown'); assert.equal(job.employmentType, 'unknown');
  assert.equal(job.sourcePublishedRaw, '2026/10/22 18:40:19'); assert.equal(job.sourcePublishedAt, undefined);
  assert.equal(result.coverage.partial, true); assert.equal(result.coverage.complete, false);
  assert.deepEqual(result.coverage.appliedFilters, ['roles', 'companyNames']);
  assert.deepEqual(result.coverage.ignoredFilters, ['regions']);
  assert.ok(result.warnings.some(value => value.includes('four reads per day')));
});

test('multiple interests remain local and are not silently joined into one upstream search phrase', async () => {
  const request = input({ jobs: [listing] }, ['TypeScript', 'C#'], [], ['Synthetic Co', 'Other Co']);
  const result = await remotiveAdapter.list(request);
  const query = new URL(request.urls[0]!);
  assert.equal(query.searchParams.has('search'), false); assert.equal(query.searchParams.has('company_name'), false);
  assert.deepEqual(result.coverage.appliedFilters, []);
  assert.deepEqual(result.coverage.ignoredFilters, ['roles', 'companyNames']);
});

test('Remotive adapter rejects alternate hosts, endpoint query injection and continuation cursors', async () => {
  const wrongHost = input({ jobs: [listing] }); wrongHost.source = source({ entryUrl: 'https://attacker.example/api/remote-jobs' });
  await assert.rejects(remotiveAdapter.list(wrongHost), error => (error as { code?: string }).code === 'invalid-input');
  const injected = input({ jobs: [listing] }); injected.source = source({ entryUrl: 'https://remotive.com/api/remote-jobs?search=unreviewed' });
  await assert.rejects(remotiveAdapter.list(injected), error => (error as { code?: string }).code === 'invalid-input');
  const cursor = { ...input({ jobs: [listing] }), cursor: 'untrusted-page' };
  await assert.rejects(remotiveAdapter.list(cursor), error => (error as { code?: string }).code === 'invalid-input');
});
