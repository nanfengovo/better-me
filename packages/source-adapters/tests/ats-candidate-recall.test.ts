import assert from 'node:assert/strict';
import test from 'node:test';
import type { SourceDefinition } from '@better-me/opportunities';
import type { SourceAdapter, SourceAdapterContext, SourceAdapterRequest } from '../src/contracts.js';
import { assessSourceScopeMatch } from '../src/local-match.js';
import { greenhouseAdapter } from '../src/adapters/greenhouse.js';
import { leverAdapter } from '../src/adapters/lever.js';
import { ashbyAdapter } from '../src/adapters/ashby.js';

type Row = { id: string; title: string; body?: string; place?: string };
function fixture(adapter: SourceAdapter, rows: Row[], maxRecords = 2) {
  const urls: string[] = [];
  const source: SourceDefinition = {
    sourceId: 'synthetic-source', name: 'Synthetic ATS board', adapterId: adapter.adapterId, adapterVersion: '1',
    capabilities: ['list-jobs'], runtime: ['local-service'], entityType: 'job-posting', enabled: true, status: 'active', remoteFilters: [],
    options: { boardToken: 'synthetic-board', companyName: 'Synthetic employer' },
    endpointPolicy: { allowedHosts: ['careers.example.com'], allowedPathPrefixes: ['/'], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: 'Synthetic board', usage: 'metadata', requiresAttribution: true },
    refreshPolicy: { mode: 'manual', minIntervalSeconds: 60, maxRecords, maxPages: 2, requestsPerMinute: 10 },
  };
  const context: SourceAdapterContext = {
    requestId: 'synthetic-recall', actorScope: 'synthetic-owner', observedAt: '2026-10-19T00:00:00Z', signal: new AbortController().signal,
    budget: { requests: 1, bytes: 100_000, timeoutMs: 5000 }, consumeRequests() {}, consumeBytes() {}, throwIfCancelled() {},
  };
  const jobs = rows.map((row) => adapter.adapterId === 'greenhouse' ? {
    id: row.id, title: row.title, absolute_url: `https://careers.example.com/${row.id}`, content: row.body, location: { name: row.place ?? 'Shanghai' },
  } : adapter.adapterId === 'ashby' ? {
    id: row.id, title: row.title, jobUrl: `https://careers.example.com/${row.id}`, descriptionPlain: row.body, location: row.place ?? 'Shanghai',
  } : {
    id: row.id, text: row.title, hostedUrl: `https://careers.example.com/${row.id}`,
    lists: row.body ? [{ text: 'Requirements', content: row.body }] : [], categories: { location: row.place ?? 'Shanghai' },
  });
  const input: SourceAdapterRequest = {
    source, scope: { roles: ['C# 后端'], regions: ['Shanghai'], companyNames: [] }, context,
    transport: { async request({ url }) {
      urls.push(url);
      return { url, status: 200, headers: {}, text: JSON.stringify(adapter.adapterId === 'lever' ? jobs : { jobs }) };
    } },
  };
  return { input, urls };
}

for (const adapter of [greenhouseAdapter, leverAdapter, ashbyAdapter]) {
  test(`${adapter.adapterId} allocates its existing quota to matching downloaded tail records while keeping source order and evidence`, async () => {
    const { input, urls } = fixture(adapter, [
      { id: 'early', title: '后端 engineer', body: 'C++ systems' },
      { id: 'unknown', title: '后端 engineer' },
      { id: 'tail-a', title: '后端 engineer', body: 'Requirements include C#' },
      { id: 'other-city', title: '后端 engineer', body: 'C#', place: 'Beijing' },
      { id: 'tail-b', title: '后端 engineer', body: 'Use C# services' },
    ]);
    const result = await adapter.list(input);
    assert.equal(urls.length, 1, 'ranking downloaded records must not fetch more pages or details');
    assert.deepEqual(result.records.map((record) => record.sourceRecordId), ['tail-a', 'tail-b']);
    assert.equal(result.records.every((record) => record.completeness === 'detail'), true);
    assert.equal(result.records.every((record) => assessSourceScopeMatch(record, input.scope).status === 'matched'), true);
    assert.ok(result.records[0]!.evidence.some((entry) => entry.selector?.includes('[2]')));
    assert.ok(result.records[1]!.evidence.some((entry) => entry.selector?.includes('[4]')));
    assert.equal(result.coverage.fetchedRecords, 5);
    assert.equal(result.coverage.partial, true); assert.equal(result.coverage.complete, false); assert.equal(result.stopReason, 'record-limit');
    assert.deepEqual(result.coverage.appliedFilters, []); assert.deepEqual(result.coverage.ignoredFilters, ['roles', 'regions']);
    if (adapter.adapterId === 'lever') {
      assert.equal(new URL(urls[0]!).searchParams.get('limit'), '2');
      assert.equal(result.nextCursor, '5', 'the cursor advances across the actual upstream page, not selected results');
    } else assert.equal(result.nextCursor, undefined);
  });

  test(`${adapter.adapterId} retains unread candidates ahead of complete nonmatches without promoting unknown text`, async () => {
    const { input } = fixture(adapter, [
      { id: 'excluded', title: '后端 engineer', body: 'C++ only' },
      { id: 'unknown', title: '后端 engineer' },
      { id: 'matched', title: '后端 engineer', body: 'C# services' },
    ]);
    const result = await adapter.list(input);
    assert.deepEqual(result.records.map((record) => record.sourceRecordId), ['unknown', 'matched']);
    assert.equal(result.records[0]!.completeness, 'excerpt'); assert.equal(result.records[0]!.description, undefined);
    assert.equal(assessSourceScopeMatch(result.records[0]!, input.scope).status, 'unknown');
    assert.equal(result.records[0]!.availability, 'unknown');
  });

  test(`${adapter.adapterId} invalid downloaded rows do not occupy a matching candidate slot and remain visible in coverage warnings`, async () => {
    const { input } = fixture(adapter, [
      { id: 'invalid', title: '', body: 'C# 后端' },
      { id: 'excluded', title: '后端 engineer', body: 'C++' },
      { id: 'matched', title: '后端 engineer', body: 'C#' },
    ], 1);
    const result = await adapter.list(input);
    assert.deepEqual(result.records.map((record) => record.sourceRecordId), ['matched']);
    assert.ok(result.warnings.some((warning) => warning.includes('1 downloaded source records failed validation')));
    assert.equal(result.coverage.fetchedRecords, 3); assert.equal(result.coverage.partial, true);
  });

  test(`${adapter.adapterId} preserves all original rows and their order when the downloaded page fits the quota`, async () => {
    const { input } = fixture(adapter, [
      { id: 'excluded', title: 'Unrelated job', body: 'Marketing only' },
      { id: 'matched', title: '后端 engineer', body: 'C#' },
      { id: 'unknown', title: '后端 engineer' },
    ], 10);
    const result = await adapter.list(input);
    assert.deepEqual(result.records.map((record) => record.sourceRecordId), ['excluded', 'matched', 'unknown']);
    assert.equal(result.coverage.partial, false); assert.equal(result.coverage.complete, true);
    assert.equal(result.nextCursor, undefined);
  });
}

test('Lever local prioritization retains the existing requested page size and offset for a normal paginated response', async () => {
  const { input, urls } = fixture(leverAdapter, [
    { id: 'excluded', title: 'Unrelated role', body: 'Marketing' },
    { id: 'matched', title: '后端 engineer', body: 'C#' },
  ]);
  input.cursor = '10';
  const result = await leverAdapter.list(input);
  assert.equal(urls.length, 1); assert.equal(new URL(urls[0]!).searchParams.get('skip'), '10');
  assert.equal(new URL(urls[0]!).searchParams.get('limit'), '2');
  assert.deepEqual(result.records.map((record) => record.sourceRecordId), ['excluded', 'matched']);
  assert.equal(result.nextCursor, '12'); assert.equal(result.coverage.partial, false); assert.equal(result.coverage.complete, false);
});
