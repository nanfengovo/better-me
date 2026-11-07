import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolError, type SourceDefinition } from '@better-me/opportunities';
import type { SourceAdapterRequest } from '../src/contracts.js';
import { mappedJsonAdapter, githubJsonAdapter } from '../src/adapters/mapped-json.js';
import { JsonFieldMappingSchema } from '../src/mapping-contracts.js';

const ENTRY = 'https://feed.example.com/api/jobs?language=en';
const row = (id: number, description = 'Build C# services') => ({ id, title: `Synthetic role ${id}`, description,
  company: `Synthetic employer ${id}`, url: `https://feed.example.com/jobs/${id}` });
function fixture(limit = 2) {
  const pages = new Map<number, unknown>([
    [1, { data: [row(1), row(2), row(3)], links: { next: `${ENTRY}&page=2` } }],
    [2, { data: [row(4)], links: { next: null } }],
  ]);
  const calls: string[] = [];
  const source: SourceDefinition = { sourceId: 'synthetic-paged-feed', name: 'Synthetic paged feed', adapterId: 'mapped-json', adapterVersion: '1',
    capabilities: ['list-jobs'], runtime: ['local-service'], entityType: 'job-posting', enabled: true, status: 'active', remoteFilters: [], entryUrl: ENTRY,
    options: { recordsPath: 'data', idPath: 'id', titlePath: 'title', descriptionPath: 'description', companyPath: 'company', urlPath: 'url', discoveryOnly: false,
      nextPageUrlPath: 'links.next', pageParameter: 'page' },
    endpointPolicy: { allowedHosts: ['feed.example.com'], allowedPathPrefixes: ['/api/jobs'], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: 'Synthetic feed', usage: 'unknown', requiresAttribution: true },
    refreshPolicy: { mode: 'manual', minIntervalSeconds: 0, maxRecords: limit, maxPages: 3, requestsPerMinute: 30 } };
  const controller = new AbortController();
  const request: SourceAdapterRequest = { source, scope: { roles: ['C#'], regions: [], companyNames: [] },
    context: { requestId: 'synthetic-json-page', actorScope: 'synthetic-test', observedAt: '2026-10-22T00:00:00Z', signal: controller.signal,
      budget: { requests: 10, bytes: 1_000_000, timeoutMs: 5000 }, consumeRequests() {}, consumeBytes() {}, throwIfCancelled() { controller.signal.throwIfAborted(); } },
    transport: { async request({ url }) { calls.push(url); const page = Number(new URL(url).searchParams.get('page') ?? '1');
      return { url, status: 200, headers: {}, text: JSON.stringify(pages.get(page)) }; } } };
  return { request, pages, calls, controller };
}
const code = (expected: string) => (error: unknown) => error instanceof ToolError && error.code === expected;

test('configured pagination drains the ranked current page before following the source-returned next page', async () => {
  const f = fixture();
  const first = await mappedJsonAdapter.list(f.request);
  assert.deepEqual(first.records.map(record => record.sourceRecordId), ['1', '2']);
  assert.equal(first.coverage.partial, false); assert.equal(first.coverage.complete, false); assert.ok(first.nextCursor);
  assert.equal(first.coverage.fetchedRecords, 3); assert.equal(first.coverage.totalAvailable, undefined);
  const second = await mappedJsonAdapter.list({ ...f.request, cursor: first.nextCursor });
  assert.deepEqual(second.records.map(record => record.sourceRecordId), ['3']);
  assert.ok(second.records[0]!.evidence.some(evidence => evidence.selector === 'data[2].description'));
  const third = await mappedJsonAdapter.list({ ...f.request, cursor: second.nextCursor });
  assert.deepEqual(third.records.map(record => record.sourceRecordId), ['4']);
  assert.equal(third.nextCursor, undefined); assert.equal(third.coverage.complete, true);
  assert.deepEqual(f.calls, [ENTRY, ENTRY, `${ENTRY}&page=2`]);
});

test('small output limits preserve matching tail jobs and continue every remaining candidate without duplication', async () => {
  const f = fixture(1);
  f.pages.set(1, { data: [row(1, 'Marketing only'), row(2), row(3)], links: { next: null } });
  const ids: string[] = []; let cursor: string | undefined;
  for (let index = 0; index < 3; index++) {
    const result = await mappedJsonAdapter.list({ ...f.request, cursor });
    ids.push(...result.records.map(record => record.sourceRecordId!)); cursor = result.nextCursor;
  }
  assert.deepEqual(ids, ['2', '3', '1']); assert.equal(cursor, undefined);
});

test('a within-page cursor rejects changed records rather than applying an old ranked offset', async () => {
  const f = fixture(); const first = await mappedJsonAdapter.list(f.request);
  f.pages.set(1, { data: [row(3), row(2), row(1)], links: { next: `${ENTRY}&page=2` } });
  await assert.rejects(mappedJsonAdapter.list({ ...f.request, cursor: first.nextCursor }), code('source-changed'));
});

test('scope and source changes reject cursor reuse before any external request; a smaller batch remains valid', async () => {
  const f = fixture(); const first = await mappedJsonAdapter.list(f.request); f.calls.length = 0;
  for (const request of [
    { ...f.request, scope: { roles: ['Java'], regions: [], companyNames: [] } },
    { ...f.request, source: { ...f.request.source, sourceId: 'different-source' } },
    { ...f.request, source: { ...f.request.source, entryUrl: ENTRY.replace('en', 'de') } },
  ]) await assert.rejects(mappedJsonAdapter.list({ ...request, cursor: first.nextCursor }), code('invalid-input'));
  assert.equal(f.calls.length, 0);
  const smaller = await mappedJsonAdapter.list({ ...f.request, source: { ...f.request.source, refreshPolicy: { ...f.request.source.refreshPolicy, maxRecords: 1 } }, cursor: first.nextCursor });
  assert.deepEqual(smaller.records.map(record => record.sourceRecordId), ['3']);
});

test('unsafe, ambiguous, missing and looping next fields retain current records and report partial coverage without following them', async () => {
  for (const next of [undefined, '', 2, `${ENTRY}&page=1`, `${ENTRY}&page=0`, `${ENTRY}&page=2&page=3`,
    'https://other.example.com/api/jobs?language=en&page=2', '/api/other?language=en&page=2', '?language=de&page=2',
    '?language=en&page=2&extra=1', '?language=en&page=2#fragment', '?language=en&page=02', '?language=en&page=1000000001',
    'https://user:pass@feed.example.com/api/jobs?language=en&page=2']) {
    const f = fixture(10); f.pages.set(1, { data: [row(1)], links: { next } });
    const result = await mappedJsonAdapter.list(f.request);
    assert.equal(result.records.length, 1); assert.equal(result.coverage.partial, true); assert.equal(result.coverage.complete, false);
    assert.equal(result.nextCursor, undefined); assert.equal(result.stopReason, 'source-error'); assert.equal(f.calls.length, 1);
  }
});

test('relative next links and explicitly numbered entry pages preserve static query terms', async () => {
  const f = fixture(10); f.request.source.entryUrl = `${ENTRY}&page=1`;
  f.pages.set(1, { data: [row(1)], links: { next: '?page=2&language=en' } });
  const first = await mappedJsonAdapter.list(f.request);
  await mappedJsonAdapter.list({ ...f.request, cursor: first.nextCursor });
  assert.deepEqual(f.calls, [`${ENTRY}&page=1`, `${ENTRY}&page=2`]);
});

test('a finite latest-jobs window, invalid rows and a final page never become claimed complete coverage', async () => {
  const f = fixture(10); f.request.source.options = { ...f.request.source.options, enumerationComplete: false };
  f.pages.set(1, { data: [row(1), { legal: 'Not a job' }], links: { next: null } });
  const result = await mappedJsonAdapter.list(f.request);
  assert.equal(result.records.length, 1); assert.equal(result.coverage.partial, true); assert.equal(result.coverage.complete, false);
  assert.ok(result.warnings.some(warning => warning.includes('1 downloaded source records')));
});

test('invalid cursor, redirected response, cancellation and legacy mappings keep their prior boundaries', async () => {
  const f = fixture();
  await assert.rejects(mappedJsonAdapter.list({ ...f.request, cursor: 'forged' }), code('invalid-input')); assert.equal(f.calls.length, 0);
  const { nextPageUrlPath: _next, ...legacyOptions } = f.request.source.options!;
  const legacy = { ...f.request, source: { ...f.request.source, options: legacyOptions } };
  const finite = await mappedJsonAdapter.list(legacy); assert.equal(finite.nextCursor, undefined); assert.equal(finite.coverage.partial, true);
  await assert.rejects(mappedJsonAdapter.list({ ...legacy, cursor: 'old' }), code('invalid-input'));
  await assert.rejects(mappedJsonAdapter.list({ ...f.request, transport: { request: async () => ({ url: `${ENTRY}&page=2`, status: 200, headers: {}, text: '{}' }) } }), code('source-changed'));
  f.controller.abort(); await assert.rejects(mappedJsonAdapter.list(f.request), { name: 'AbortError' });
});

test('pagination configuration is browser-safe strict data and cannot run code or use prototype paths', () => {
  const valid = { titlePath: 'title', nextPageUrlPath: 'links.next', pageParameter: 'page' };
  assert.equal(JsonFieldMappingSchema.safeParse(valid).success, true);
  for (const pagination of [{ nextPageUrlPath: '', pageParameter: 'page' }, { nextPageUrlPath: 'links.__proto__', pageParameter: 'page' },
    { nextPageUrlPath: 'links.next', pageParameter: '__proto__' }, { nextPageUrlPath: 'links.next', pageParameter: 'page', endpoint: 'https://other.example.com' }])
    assert.equal(JsonFieldMappingSchema.safeParse({ titlePath: 'title', ...pagination }).success, false);
});

test('GitHub JSON pagination continues to return discovery leads, never verified jobs', async () => {
  const f = fixture(10); f.request.source = { ...f.request.source, adapterId: 'github-json', entityType: 'company-directory', entryUrl: 'https://raw.githubusercontent.com/synthetic/repo/main/jobs.json' };
  f.request.transport = { request: async ({ url }) => ({ url, status: 200, headers: {}, text: JSON.stringify({ data: [row(1)], links: { next: null } }) }) };
  const result = await githubJsonAdapter.list(f.request);
  assert.equal(result.records[0]!.entityType, 'discovery-lead'); assert.equal(result.records[0]!.completeness, 'lead');
});
