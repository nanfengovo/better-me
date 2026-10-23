import assert from 'node:assert/strict';
import test from 'node:test';
import { SourceDefinitionSchema, type ToolResult, type TrustedToolContext } from '@better-me/opportunities';
import { createJobApplication } from '../src/application.js';
import { createJobHttpServer } from '../src/http.js';
import { openJobRepository } from '../src/repository.js';

const AT = '2026-10-22T00:00:00.000Z', ENTRY = 'https://feed.synthetic.example/api/jobs';
const source = SourceDefinitionSchema.parse({ sourceId: 'synthetic-location-json', name: 'Synthetic location feed', adapterId: 'mapped-json', adapterVersion: '1',
  capabilities: ['list-jobs'], runtime: ['local-service'], entityType: 'job-posting', enabled: true, status: 'active', entryUrl: ENTRY, remoteFilters: [],
  options: { recordsPath: 'data', idPath: 'id', titlePath: 'title', urlPath: 'url', companyPath: 'company', descriptionPath: 'description', discoveryOnly: false,
    locationsPath: 'offices', locationCountryPath: 'country', locationCityPath: 'city', locationRegionPath: 'region',
    locationStreetAddressPath: 'street', locationPostalCodePath: 'postal' },
  endpointPolicy: { allowedHosts: ['feed.synthetic.example'], allowedPathPrefixes: ['/api/jobs'], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
  attribution: { label: 'Synthetic original feed', usage: 'unknown', requiresAttribution: true },
  refreshPolicy: { mode: 'manual', minIntervalSeconds: 0, maxRecords: 20, maxPages: 1, requestsPerMinute: 100 } });
const context = (key?: string): TrustedToolContext => ({ requestId: `synthetic-locations-${key ?? 'read'}`, actorScope: 'synthetic-owner',
  allowedEffects: ['read-index', 'local-write', 'external-read'], signal: new AbortController().signal,
  budget: { requests: 10, bytes: 1_000_000, timeoutMs: 5000 }, ...(key ? { idempotencyKey: key } : {}) });
function value(result: ToolResult): any { assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) throw new Error(result.error.code); return result.value; }
const row = (id: string, offices: unknown[]) => ({ id, title: 'C# engineer', description: 'Build C# services with original source evidence', company: 'Synthetic employer',
  url: `https://feed.synthetic.example/jobs/${id}`, offices });
const rows = [
  row('domestic', [{ country: 'CN', city: 'Shanghai', region: 'Shanghai', street: '88 Synthetic Road', postal: '00123' }]),
  row('foreign', [{ country: 'US', city: 'Boston', street: '99 Synthetic Street', postal: '00234' }]),
  row('split', [{ country: 'US', city: 'Austin', street: '11 Austin Road' }, { country: 'CN', city: 'Boston', street: '22 Boston Road' }]),
  row('unknown', [{ city: 'Shanghai', street: '77 Unverified Road' }]),
];
async function fixture() {
  const repository = openJobRepository(':memory:', { now: () => AT }); let calls = 0;
  const application = createJobApplication({ repository, now: () => AT, transport: { async request({ url }) {
    calls++; return { url, status: 200, headers: {}, text: JSON.stringify({ data: rows }) };
  } } });
  value(await application.registry.execute('sources.register', { source, expectedRevision: 0 }, context('register')));
  return { repository, application, get calls() { return calls; }, async close() { await application.shutdown(); repository.close(); } };
}

test('configured JSON locations survive sync, SQLite, HTTP query and source-street planning without becoming confirmed office points', async () => {
  const f = await fixture();
  const http = createJobHttpServer({ registry: f.application.registry, token: 'synthetic-locations-http-token-123456789', allowedOrigins: ['http://localhost:5173'], port: 0 });
  try {
    const { url } = await http.listen();
    const synced = value(await f.application.registry.execute('sources.sync', { sourceId: source.sourceId }, context('sync')));
    assert.equal(synced.run.status, 'completed');
    const snapshot = await f.repository.readSnapshot(); assert.equal(snapshot.jobs.length, 4);
    const listing = snapshot.listings.find(item => item.sourceRecordId === 'domestic')!;
    const job = snapshot.jobs.find(item => item.id === listing.canonicalJobId)!;
    const location = snapshot.locations.find(item => listing.locationIds!.includes(item.id))!;
    assert.deepEqual(job.locationIds, listing.locationIds);
    assert.equal(location.countryCode, 'CN'); assert.equal(location.city, 'Shanghai'); assert.equal(location.region, 'Shanghai');
    assert.equal(location.streetAddress, '88 Synthetic Road'); assert.equal(location.postalCode, '00123');
    assert.equal(location.coordinates, undefined); assert.equal(location.officeResolution, undefined);
    const observation = snapshot.observations.find(item => item.listingId === listing.id)!;
    assert.ok(location.evidence.some(ref => ref.observationId === observation.id && ref.selector === 'data[0].offices[0].street' && ref.quote === '88 Synthetic Road' && ref.sourceUrl === ENTRY));
    const split = snapshot.listings.find(item => item.sourceRecordId === 'split')!;
    for (const [index, street] of ['11 Austin Road', '22 Boston Road'].entries()) {
      const place = snapshot.locations.find(item => split.locationIds!.includes(item.id) && item.streetAddress === street)!;
      assert.ok(place.evidence.some(ref => ref.selector === `data[2].offices[${index}].street` && ref.quote === street));
      assert.equal(place.evidence.some(ref => ref.selector?.startsWith(`data[2].offices[${1 - index}]`)), false, 'another office cannot supply this location evidence');
    }
    const detail = value(await f.application.registry.execute('jobs.read-detail', { jobId: job.id }, context()));
    assert.equal(detail.listings[0].canonicalUrl, rows[0]!.url); assert.equal(detail.sources[0].attribution.label, source.attribution.label);
    const query = { market: 'domestic', includeUnknownLocations: false, workCountryCodes: ['CN'], workRegionGroups: [['Shanghai']], mapCityReferences: true };
    const expected = value(await f.application.registry.execute('jobs.search', query, context()));
    const response = await fetch(`${url}/api/v1/jobs/search`, { method: 'POST', headers: { Authorization: 'Bearer synthetic-locations-http-token-123456789', 'Content-Type': 'application/json' }, body: JSON.stringify(query) });
    assert.equal(response.status, 200); assert.deepEqual(value(await response.json() as ToolResult), expected);
    assert.equal(expected.totalJobs, 1); assert.equal(expected.items[0].job.id, job.id); assert.equal(expected.mappedJobs, 0);
    assert.equal(expected.mapReferenceCoverage.cityReferenceJobs, 1); assert.equal(expected.items[0].distance, undefined);
    const before = await f.repository.backup(), calls = f.calls;
    const plan = value(await f.application.registry.execute('jobs.plan-address-enrichment', { jobIds: [job.id], expectedRevision: snapshot.revision }, context()));
    assert.equal(plan.items[0].status, 'source-street'); assert.equal(plan.items[0].currentOffice.length, 0);
    assert.equal(plan.items[0].sourceStreetTargets[0].sourceLocation.streetAddress, '88 Synthetic Road');
    assert.equal(plan.items[0].sourceStreetTargets[0].sourceLocation.postalCode, '00123');
    assert.deepEqual(plan.items[0].ownedOfficialTargets, [], 'generic mapping does not assert official affiliation or detail-reader capability');
    assert.equal(f.calls, calls); assert.deepEqual(await f.repository.backup(), before);
  } finally { await http.close(); await f.close(); }
});

test('source preview and sync require country and city on one disclosed location, and do not guess country from city', async () => {
  const f = await fixture();
  try {
    const input = { sourceId: source.sourceId, scope: { roles: ['C#'], regions: ['Boston'], countryCodes: ['US'], companyNames: [] } };
    const before = await f.repository.backup();
    const preview = value(await f.application.registry.execute('sources.preview', input, context()));
    assert.equal(preview.localMatchedRecords, 1); assert.deepEqual(await f.repository.backup(), before);
    value(await f.application.registry.execute('sources.sync', input, context('sync-boston')));
    const snapshot = await f.repository.readSnapshot(); assert.equal(snapshot.jobs.length, 1);
    assert.equal(snapshot.listings[0]!.sourceRecordId, 'foreign');
    const result = value(await f.application.registry.execute('jobs.search', { market: 'global', workCountryCodes: ['US'], workRegionGroups: [['Boston']], includeUnknownLocations: false }, context()));
    assert.equal(result.totalJobs, 1); assert.equal(result.items[0].job.id, snapshot.jobs[0]!.id);
    assert.equal(result.mappedJobs, 0); assert.equal(result.items[0].distance, undefined);
  } finally { await f.close(); }
});
