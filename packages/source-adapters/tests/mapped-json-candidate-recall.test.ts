import assert from 'node:assert/strict';
import test from 'node:test';
import type { SourceDefinition } from '@better-me/opportunities';
import type { SourceAdapterRequest } from '../src/contracts.js';
import { mappedJsonAdapter } from '../src/adapters/mapped-json.js';
import { assessSourceScopeMatch } from '../src/local-match.js';
import { JsonFieldMappingSchema } from '../src/mapping-contracts.js';

function fixture(rows: unknown[], limit = 2) {
  const urls: string[] = [];
  const source: SourceDefinition = {
    sourceId: 'synthetic-multicompany-feed', name: 'Synthetic multi-company feed', adapterId: 'mapped-json', adapterVersion: '1',
    capabilities: ['list-jobs'], runtime: ['local-service'], entityType: 'job-posting', enabled: true, status: 'active', remoteFilters: [],
    entryUrl: 'https://feed.example.com/api', options: { recordsPath: 'data', idPath: 'id', titlePath: 'title', descriptionPath: 'body',
      companyPath: 'company', locationsPath: 'location', urlPath: 'url', discoveryOnly: false },
    endpointPolicy: { allowedHosts: ['feed.example.com'], allowedPathPrefixes: ['/api'], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: 'Synthetic feed', usage: 'unknown', requiresAttribution: true },
    refreshPolicy: { mode: 'manual', minIntervalSeconds: 3600, maxRecords: limit, maxPages: 1, requestsPerMinute: 5 },
  };
  const request: SourceAdapterRequest = { source, scope: { roles: ['C#'], regions: ['Shanghai'], companyNames: [] },
    context: { requestId: 'synthetic-mapped-recall', actorScope: 'synthetic-test', observedAt: '2026-10-19T00:00:00Z', signal: new AbortController().signal,
      budget: { requests: 1, bytes: 100_000, timeoutMs: 5000 }, consumeRequests() {}, consumeBytes() {}, throwIfCancelled() {} },
    transport: { async request({ url }) { urls.push(url); return { url, status: 200, headers: {}, text: JSON.stringify({ data: rows }) }; } },
  };
  return { request, urls };
}
const row = (id: string, body?: string, location = 'Shanghai') => ({ id, title: `Synthetic ${id}`, company: `Employer ${id}`,
  ...(body ? { body } : {}), location, url: `https://feed.example.com/jobs/${id}` });

test('a multi-company feed allocates its existing output allowance across all downloaded records instead of losing matching tail jobs', async () => {
  const { request, urls } = fixture([row('early', 'C++ only'), row('unknown'), row('tail-a', 'C# services'), row('other-city', 'C#', 'Beijing'), row('tail-b', 'C# backend')]);
  const result = await mappedJsonAdapter.list(request);
  assert.equal(urls.length, 1); assert.deepEqual(result.records.map((record) => record.sourceRecordId), ['tail-a', 'tail-b']);
  assert.deepEqual(result.records.map((record) => record.companyName), ['Employer tail-a', 'Employer tail-b']);
  assert.equal(result.records.every((record) => assessSourceScopeMatch(record, request.scope).status === 'matched'), true);
  assert.ok(result.records[0]!.evidence.some((entry) => entry.selector === 'data[2].body'));
  assert.ok(result.records[1]!.evidence.some((entry) => entry.selector === 'data[4].body'));
  assert.equal(result.coverage.fetchedRecords, 5); assert.equal(result.coverage.totalAvailable, 5);
  assert.equal(result.coverage.partial, true); assert.equal(result.stopReason, 'record-limit');
  assert.equal(result.nextCursor, undefined); assert.deepEqual(result.coverage.appliedFilters, []);
});

test('an unread feed candidate retains its uncertainty and is selected before an unrelated complete description', async () => {
  const { request } = fixture([row('excluded', 'C++ only'), row('unknown'), row('matched', 'C#')]);
  const result = await mappedJsonAdapter.list(request);
  assert.deepEqual(result.records.map((record) => record.sourceRecordId), ['unknown', 'matched']);
  assert.equal(result.records[0]!.description, undefined); assert.equal(result.records[0]!.completeness, 'excerpt');
  assert.equal(assessSourceScopeMatch(result.records[0]!, request.scope).status, 'unknown');
  assert.equal(result.records[0]!.availability, 'unknown');
});

test('a feed disclaimer or malformed row does not consume a matching slot and remains visible as partial coverage', async () => {
  const { request } = fixture([{ legal: 'Synthetic disclaimer, not a job' }, row('excluded', 'C++ only'), row('matched', 'C#')], 1);
  const result = await mappedJsonAdapter.list(request);
  assert.deepEqual(result.records.map((record) => record.sourceRecordId), ['matched']);
  assert.equal(result.coverage.fetchedRecords, 3); assert.equal(result.coverage.partial, true);
  assert.ok(result.warnings.some((warning) => warning.includes('1 downloaded source records failed validation and were omitted')));
});

test('a full downloaded page that fits the limit preserves source order and does not invent further pagination or country evidence', async () => {
  const { request } = fixture([row('excluded', 'C++ only'), row('matched', 'C#'), row('unknown')], 10);
  const result = await mappedJsonAdapter.list(request);
  assert.deepEqual(result.records.map((record) => record.sourceRecordId), ['excluded', 'matched', 'unknown']);
  assert.equal(result.coverage.complete, true); assert.equal(result.coverage.partial, false); assert.equal(result.nextCursor, undefined);
  assert.ok(result.records.every((record) => record.locations.every((location) => location.countryCode === undefined)));
});

test('feed-specific completeness and finite enumeration are explicit while legacy mapping defaults stay compatible', async () => {
  const defaults = JsonFieldMappingSchema.parse({ titlePath: 'title' });
  assert.equal(defaults.descriptionCompleteness, 'detail'); assert.equal(defaults.enumerationComplete, true); assert.equal(defaults.publishedFormat, 'iso');
  assert.equal(JsonFieldMappingSchema.safeParse({ titlePath: 'title', descriptionCompleteness: 'verified' }).success, false);
  assert.equal(JsonFieldMappingSchema.safeParse({ titlePath: 'title', publishedFormat: 'guess' }).success, false);
  const { request } = fixture([row('excerpt', 'Only an introductory summary')], 10);
  request.source.options = { ...request.source.options, descriptionCompleteness: 'excerpt', enumerationComplete: false };
  const result = await mappedJsonAdapter.list(request);
  assert.equal(result.records[0]!.description, 'Only an introductory summary'); assert.equal(result.records[0]!.completeness, 'excerpt');
  assert.equal(assessSourceScopeMatch(result.records[0]!, request.scope).status, 'unknown');
  assert.equal(result.coverage.complete, false); assert.equal(result.coverage.partial, true); assert.equal(result.stopReason, 'page-limit');
  assert.equal(result.coverage.totalAvailable, undefined); assert.equal(result.coverage.fetchedRecords, 1);
  assert.ok(result.warnings.some((warning) => warning.includes('finite page or latest-jobs window')));
});

test('an explicitly declared Unix publication format preserves raw units and exact timestamp evidence', async () => {
  for (const [format, epoch, expected] of [
    ['unix-seconds', 1_704_067_200, '2024-01-01T00:00:00.000Z'],
    ['unix-milliseconds', 1_704_067_200_123, '2024-01-01T00:00:00.123Z'],
    ['unix-seconds', '1704067200', '2024-01-01T00:00:00.000Z'],
    ['unix-milliseconds', 0, '1970-01-01T00:00:00.000Z'],
  ] as const) {
    const { request } = fixture([{ ...row('epoch'), published: epoch }]);
    request.source.options = { ...request.source.options, publishedPath: 'published', publishedFormat: format };
    const result = await mappedJsonAdapter.list(request); const record = result.records[0]!;
    assert.equal(record.sourcePublishedRaw, String(epoch)); assert.equal(record.sourcePublishedAt, expected);
    assert.ok(record.evidence.some((entry) => entry.field === 'sourcePublishedRaw' && entry.quote === String(epoch) && entry.selector === 'data[0].published'));
  }
});

test('fractional, negative, unsafe or oversized epochs remain raw without rolling to invented publication dates', async () => {
  for (const [format, epoch] of [
    ['unix-seconds', 1.5], ['unix-seconds', -1], ['unix-seconds', 253_402_300_800],
    ['unix-milliseconds', 253_402_300_800_000], ['unix-milliseconds', Number.MAX_SAFE_INTEGER + 1],
    ['unix-seconds', '1792342847e0'], ['unix-seconds', '2026-10-18'],
  ] as const) {
    const { request } = fixture([{ ...row('invalid-epoch'), published: epoch }]);
    request.source.options = { ...request.source.options, publishedPath: 'published', publishedFormat: format };
    const record = (await mappedJsonAdapter.list(request)).records[0]!;
    assert.equal(record.sourcePublishedRaw, String(epoch)); assert.equal(record.sourcePublishedAt, undefined);
    assert.ok(record.warnings.some((warning) => warning.includes('epoch is invalid')));
  }
});

test('default ISO mapping does not guess numeric epoch units and retains timezone-free dates as original text', async () => {
  const { request } = fixture([
    { ...row('number'), published: 1_792_342_847 },
    { ...row('iso'), published: '2026-10-18T16:33:07+00:00' },
    { ...row('date-only'), published: '2026-10-18' },
  ], 10);
  request.source.options = { ...request.source.options, publishedPath: 'published' };
  const result = await mappedJsonAdapter.list(request);
  assert.equal(result.records[0]!.sourcePublishedRaw, undefined); assert.equal(result.records[0]!.sourcePublishedAt, undefined);
  assert.equal(result.records[1]!.sourcePublishedRaw, '2026-10-18T16:33:07+00:00'); assert.equal(result.records[1]!.sourcePublishedAt, '2026-10-18T16:33:07.000Z');
  assert.equal(result.records[2]!.sourcePublishedRaw, '2026-10-18'); assert.equal(result.records[2]!.sourcePublishedAt, undefined);
});
