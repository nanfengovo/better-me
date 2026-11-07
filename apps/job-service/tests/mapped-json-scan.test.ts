import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SourceDefinition, type TrustedToolContext, type ToolResult } from '@better-me/opportunities';
import { mappedJsonAdapter, type SourceSyncResult } from '@better-me/source-adapters';
import { createJobApplication } from '../src/application.js';
import { openJobRepository } from '../src/repository.js';

const AT = '2026-10-22T00:00:00.000Z', ENTRY = 'https://feed.synthetic.example/api/jobs';
const scope = { roles: ['C#'], regions: [], companyNames: [] };
const config: SourceDefinition = { sourceId: 'synthetic-paged-json', name: 'Synthetic paged JSON', adapterId: 'mapped-json', adapterVersion: '1',
  capabilities: ['list-jobs'], runtime: ['local-service'], entityType: 'job-posting', enabled: true, status: 'active', entryUrl: ENTRY, remoteFilters: [],
  options: { recordsPath: 'data', idPath: 'id', titlePath: 'title', urlPath: 'url', descriptionPath: 'description', companyPath: 'company', discoveryOnly: false,
    nextPageUrlPath: 'links.next', pageParameter: 'page' },
  endpointPolicy: { allowedHosts: ['feed.synthetic.example'], allowedPathPrefixes: ['/api/jobs'], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
  attribution: { label: 'Synthetic feed', usage: 'unknown', requiresAttribution: true },
  refreshPolicy: { mode: 'manual', minIntervalSeconds: 0, maxRecords: 2, maxPages: 1, requestsPerMinute: 100 } };
function context(key = randomUUID()): TrustedToolContext { return { requestId: randomUUID(), actorScope: 'synthetic-owner', idempotencyKey: key,
  allowedEffects: ['read-index', 'external-read', 'local-write'], signal: new AbortController().signal, budget: { requests: 10, bytes: 1_000_000, timeoutMs: 5000 } }; }
function value<T>(result: ToolResult<T>): T { assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) throw new Error(result.error.code); return result.value; }
const nextInput = (result: SourceSyncResult) => ({ sourceId: config.sourceId, fromRunId: result.run.runId, expectedProgressVersion: result.scanProgress!.version });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'betterme-paged-json-')), path = join(directory, 'jobs.sqlite');
  const calls: string[] = []; let changed = false, invalidNext = false;
  let repository = openJobRepository(path, { now: () => AT });
  await repository.registerSource(config, { actorScope: 'synthetic-owner', idempotencyKey: 'register' });
  const transport = { async request({ url, context: execution }: any) {
    execution.throwIfCancelled(); execution.consumeRequests(); calls.push(url);
    const page = Number(new URL(url).searchParams.get('page') ?? '1');
    const ids = page === 1 ? changed ? [3, 2, 1] : [1, 2, 3] : [4];
    const text = JSON.stringify({ data: ids.map(id => ({ id, title: `Synthetic developer ${id}`, url: `https://feed.synthetic.example/jobs/${id}`,
      description: 'Build C# backend services', company: 'Synthetic employer' })), links: { next: invalidNext ? 'https://other.example/api/jobs?page=2' : page === 1 ? `${ENTRY}?page=2` : null } });
    execution.consumeBytes(new TextEncoder().encode(text).length); return { url, status: 200, headers: {}, text };
  } };
  let application = createJobApplication({ repository, adapters: [mappedJsonAdapter], transport, now: () => AT });
  return { calls, get repository() { return repository; }, get application() { return application; },
    change() { changed = true; }, invalidNext() { invalidNext = true; },
    async reopen() { await application.shutdown(); repository.close(); repository = openJobRepository(path, { now: () => AT }); await repository.recoverInterruptedRuns();
      application = createJobApplication({ repository, adapters: [mappedJsonAdapter], transport, now: () => AT }); },
    async close() { await application.shutdown(); repository.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('real JSON adapter and durable tools preserve a partial downloaded page across reopening then reach the next remote page', async () => {
  const f = await fixture();
  try {
    const first = value<SourceSyncResult>(await f.application.registry.execute('sources.sync', { sourceId: config.sourceId, scope }, context()));
    assert.equal(first.scanProgress!.state, 'ready'); assert.equal((await f.repository.readSnapshot()).jobs.length, 2);
    await f.reopen();
    const input = nextInput(first), secondContext = context();
    const second = value<SourceSyncResult>(await f.application.registry.execute('sources.continue-sync', input, secondContext));
    assert.equal(second.scanProgress!.state, 'ready'); assert.equal((await f.repository.readSnapshot()).jobs.length, 3);
    assert.equal(second.scanProgress!.attemptedRecords, 6, 'each full downloaded page is counted, including explicit within-page rereads');
    const before = f.calls.length;
    const replay = value<SourceSyncResult>(await f.application.registry.execute('sources.continue-sync', input, secondContext));
    assert.equal(replay.run.runId, second.run.runId); assert.equal(f.calls.length, before);
    const third = value<SourceSyncResult>(await f.application.registry.execute('sources.continue-sync', nextInput(second), context()));
    assert.equal(third.scanProgress!.state, 'exhausted'); assert.equal(third.scanProgress!.canContinue, false);
    assert.equal((await f.repository.readSnapshot()).jobs.length, 4); assert.deepEqual(f.calls, [ENTRY, ENTRY, `${ENTRY}?page=2`]);
    assert.equal(JSON.stringify(third).includes('cursor'), false);
    const backup = await f.repository.backup(); assert.equal(backup.schemaVersion, 8); assert.ok(backup.sourceScans.length > 0);
  } finally { await f.close(); }
});

test('a changed downloaded JSON page permanently invalidates its saved offset without losing earlier jobs', async () => {
  const f = await fixture();
  try {
    const first = value<SourceSyncResult>(await f.application.registry.execute('sources.sync', { sourceId: config.sourceId, scope }, context()));
    f.change();
    const result = value<SourceSyncResult>(await f.application.registry.execute('sources.continue-sync', nextInput(first), context()));
    assert.equal(result.sourceError?.code, 'source-changed'); assert.equal(result.scanProgress!.state, 'invalidated');
    assert.equal(result.scanProgress!.canContinue, false); assert.equal((await f.repository.readSnapshot()).jobs.length, 2);
  } finally { await f.close(); }
});

test('an unsafe next-page URL retains valid jobs but finishes truncated rather than claiming no more jobs', async () => {
  const f = await fixture();
  try {
    f.invalidNext();
    const first = value<SourceSyncResult>(await f.application.registry.execute('sources.sync', { sourceId: config.sourceId, scope }, context()));
    const second = value<SourceSyncResult>(await f.application.registry.execute('sources.continue-sync', nextInput(first), context()));
    assert.equal((await f.repository.readSnapshot()).jobs.length, 3); assert.equal(second.scanProgress!.state, 'truncated');
    assert.equal(second.scanProgress!.canContinue, false); assert.deepEqual(f.calls, [ENTRY, ENTRY]);
  } finally { await f.close(); }
});
