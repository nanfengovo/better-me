/** Explicit manual, low-request probe. Not part of the automatic test glob. No user data is read. */
import { readFile } from 'node:fs/promises';
import { SourceDefinitionSchema } from '@better-me/opportunities';
import { createControlledSourceTransport, createGoogleDohResolver } from '../src/transport.js';
import { greenhouseAdapter } from '../src/adapters/greenhouse.js';
import { leverAdapter } from '../src/adapters/lever.js';
import { ashbyAdapter } from '../src/adapters/ashby.js';
import { githubJsonAdapter } from '../src/adapters/mapped-json.js';
import type { SourceAdapter, SourceAdapterContext } from '../src/contracts.js';

const sources = JSON.parse(await readFile(new URL('../../../config/sources/examples.json', import.meta.url), 'utf8')) as unknown[];
const adapters: SourceAdapter[] = [greenhouseAdapter, leverAdapter, ashbyAdapter, githubJsonAdapter];
const onlyAdapter = process.argv.find((value) => value.startsWith('--only='))?.slice('--only='.length);
const useDoh = process.argv.includes('--doh');
const transport = createControlledSourceTransport({ timeoutMs: 20_000, ...(useDoh ? { resolve: createGoogleDohResolver() } : {}) });
for (const adapter of adapters) {
  if (onlyAdapter && adapter.adapterId !== onlyAdapter) continue;
  const source = SourceDefinitionSchema.parse(sources.find((item) => (item as { adapterId?: string }).adapterId === adapter.adapterId));
  // This explicit probe bypasses registry enablement only for the named public example; no config is persisted.
  source.refreshPolicy.maxRecords = adapter.adapterId === 'lever' ? 1 : 100;
  let requests = 0, bytes = 0;
  const observedAt = new Date().toISOString();
  const context: SourceAdapterContext = {
    observedAt, requestId: `public-probe-${adapter.adapterId}`, actorScope: 'public-probe', signal: new AbortController().signal,
    budget: { requests: useDoh ? 2 : 1, bytes: 8 * 1024 * 1024, timeoutMs: 20_000 },
    consumeRequests: (count = 1) => { requests += count; if (requests > (useDoh ? 2 : 1)) throw new Error('Probe request budget reached.'); },
    consumeBytes: (count) => { bytes += count; if (bytes > 8 * 1024 * 1024) throw new Error('Probe byte budget reached.'); },
    throwIfCancelled: () => undefined,
  };
  try {
    const result = await adapter.list({ source, scope: { roles: [], regions: [], companyNames: [] }, context, transport });
    console.log(JSON.stringify({ adapter: adapter.adapterId, observedAt, requests, bytes, dnsMode: useDoh ? 'explicit-google-doh' : 'system', returnedRecords: result.records.length, coverage: result.coverage,
      sample: result.records[0] ? { entityType: result.records[0].entityType, title: result.records[0].title, url: result.records[0].url,
        availability: result.records[0].availability, descriptionLength: result.records[0].description?.length, evidenceCount: result.records[0].evidence.length } : null,
      warnings: result.warnings }));
  } catch (error) {
    const typed = error as { code?: string; name?: string; message?: string };
    console.log(JSON.stringify({ adapter: adapter.adapterId, observedAt, requests, bytes, dnsMode: useDoh ? 'explicit-google-doh' : 'system', errorCode: typed.code ?? typed.name, message: typed.message }));
    process.exitCode = 1;
  }
}
