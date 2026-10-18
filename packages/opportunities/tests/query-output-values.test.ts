import assert from 'node:assert/strict';
import test from 'node:test';
import { AtlasDatasetSchema, type AtlasDataset } from '../src/schema.js';
import { queryJobs, createJobQueryService, type JobQueryInput } from '../src/query.js';
import { JobQueryResultSchema } from '../src/query-output.js';
import { createJobsSearchTool } from '../src/services.js';
import { createToolRegistry } from '../src/tools.js';

const NOW = '2026-10-18T12:00:00.000Z';
const sourceUrl = 'https://careers.example.test/jobs/synthetic-role';
const evidence = [{ observationId: 'synthetic-observation', sourceUrl, observedAt: NOW, quote: 'Synthetic annual gross USD base salary 100000–120000; synthetic verified Swedish controller.' }];
const point = (latitude: number, longitude: number) => ({ latitude, longitude, coordinateSystem: 'WGS84' as const });
const options = {
  now: NOW,
  fx: { id: 'synthetic-fx', provider: 'Synthetic fixture', date: '2026-10-17', ratesToCny: { USD: 7 } },
  anchor: { ref: 'opaque-synthetic-anchor', ...point(0, 0) },
};
const query: JobQueryInput = {
  sourceIds: ['constructor'], controllerJurisdictions: ['SE'], ownershipKinds: ['private'],
  distance: { anchorRef: 'opaque-synthetic-anchor', maxKm: 10, includeUnknown: false },
  salary: { metric: 'min', includeUnknown: false }, sort: { field: 'salary', direction: 'desc' }, mapLevel: 'location',
};

/** End-to-end output fixtures are entirely synthetic, including the deliberately adversarial source ID. */
function richDataset(): AtlasDataset {
  return AtlasDatasetSchema.parse({
    schemaVersion: 1, revision: 1,
    sources: [{
      sourceId: 'constructor', name: 'Synthetic source', adapterId: 'synthetic-adapter', adapterVersion: '1',
      capabilities: ['list-jobs', 'read-detail'], runtime: ['local-service'], entityType: 'job-posting',
      enabled: true, status: 'active', remoteFilters: [],
      endpointPolicy: { allowedHosts: ['careers.example.test'], allowedPathPrefixes: ['/'], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
      attribution: { label: 'Synthetic source attribution', usage: 'metadata', requiresAttribution: true },
      refreshPolicy: { mode: 'manual', minIntervalSeconds: 60, maxRecords: 100, maxPages: 2, requestsPerMinute: 30 },
    }],
    companies: [{
      id: 'synthetic-company', names: ['Synthetic employer'], domains: ['careers.example.test'], parentCompanyIds: [], manualOverrides: [],
      ultimateControllers: { value: [{ name: 'Synthetic controller', jurisdictionCode: 'SE', kind: 'private' }], evidence, verification: 'verified', method: 'manual', revision: 0 },
    }],
    jobs: [{
      id: 'synthetic-job', companyId: 'synthetic-company',
      title: { value: 'Synthetic TypeScript engineer', evidence, verification: 'verified', method: 'source-structured', revision: 0 },
      description: 'Synthetic role description', locationIds: ['near-office', 'far-office'], compensationIds: ['synthetic-base'], listingIds: ['synthetic-listing'],
      workMode: 'on-site', employmentType: 'social', remoteEligibleRegions: [], status: 'open', revision: 0, updatedAt: NOW,
    }],
    locations: [
      { id: 'near-office', raw: 'Synthetic near office', countryCode: 'CN', city: 'Synthetic near city', kind: 'office', precision: 'address', coordinates: point(0.01, 0), verification: 'verified', evidence },
      { id: 'far-office', raw: 'Synthetic distant office', countryCode: 'CN', city: 'Synthetic distant city', kind: 'office', precision: 'address', coordinates: point(10, 0), verification: 'verified', evidence },
    ],
    compensations: [{
      id: 'synthetic-base', raw: 'Synthetic USD 100000–120000 annual gross base', currency: 'USD', period: 'year', min: 100000, max: 120000,
      tax: 'gross', kind: 'base', verification: 'verified', evidence, locationIds: ['near-office'],
    }],
    listings: [{ id: 'synthetic-listing', sourceId: 'constructor', sourceRecordId: 'synthetic-role', canonicalUrl: sourceUrl, canonicalJobId: 'synthetic-job', observationIds: ['synthetic-observation'], firstDiscoveredAt: NOW }],
    observations: [{ id: 'synthetic-observation', listingId: 'synthetic-listing', fetchedAt: NOW, detailFetchedAt: NOW, availabilityVerifiedAt: NOW, availability: 'open', availabilityMethod: 'detail-explicit', result: 'read', completeness: 'detail', warnings: [] }],
    snapshots: [],
  });
}

test('real foreign-salary/verified-control/exact-distance query passes nested output schema and JSON transport', async () => {
  const result = await queryJobs(richDataset(), query, options);
  const parsed = JobQueryResultSchema.safeParse(result);
  assert.equal(parsed.success, true, parsed.success ? undefined : JSON.stringify(parsed.error.issues));
  assert.equal(result.totalJobs, 1);
  assert.equal(result.items[0]!.salaryCny, 700000);
  assert.equal(result.items[0]!.salary?.originalAnnual?.currency, 'USD');
  assert.equal(result.items[0]!.salary?.fx?.rateToCny, 7);
  assert.equal(result.items[0]!.color.ruleId, 'nordic');
  assert.equal(result.items[0]!.color.classification.status, 'verified');
  assert.equal(result.items[0]!.distance?.estimated, false);
  assert.ok(result.items[0]!.distance!.km > 1 && result.items[0]!.distance!.km < 2);
  assert.deepEqual(result.items[0]!.locations.map((location) => location.id), ['near-office']);
  assert.equal(result.locationPinCount, 1);
  assert.deepEqual(result.mapBuckets.flatMap((bucket) => bucket.locationIds), ['near-office']);
  assert.equal(Object.hasOwn(result.facets.sources, 'constructor'), true);
  assert.equal(result.facets.sources.constructor, 1);
  const transported = JobQueryResultSchema.parse(JSON.parse(JSON.stringify(result)));
  assert.equal(transported.facets.sources.constructor, 1);
  assert.equal(JSON.stringify(transported).includes('"latitude":0,"longitude":0'), false);
});

test('conflicting foreign base offers stay ambiguous through strict query response validation', async () => {
  const dataset = richDataset();
  dataset.compensations.push({ ...structuredClone(dataset.compensations[0]!), id: 'alternative-base', min: 200000, max: 240000 });
  dataset.jobs[0]!.compensationIds.push('alternative-base');
  const result = await queryJobs(dataset, { ...query, salary: { includeUnknown: true } }, options);
  assert.equal(result.items[0]!.salarySelection, 'ambiguous');
  assert.equal(result.items[0]!.salary, undefined);
  assert.equal(result.items[0]!.salaryCny, undefined);
  assert.equal(result.items[0]!.salaryCandidates.length, 2);
  assert.equal(result.unknownSalaryCount, 1);
  assert.equal(JobQueryResultSchema.safeParse(result).success, true);
  dataset.jobs[0]!.compensationIds.reverse();
  const reversed = await queryJobs(dataset, { ...query, salary: { includeUnknown: true } }, options);
  assert.equal(reversed.items[0]!.salarySelection, 'ambiguous');
  assert.equal(reversed.items[0]!.salaryCny, undefined);
});

test('jobs.search registry transports real normalized values without returning the private distance anchor', async () => {
  const tool = createJobsSearchTool(createJobQueryService({ readSnapshot: async () => richDataset() }), () => options);
  const registry = createToolRegistry([tool]);
  const result = await registry.execute('jobs.search', query, {
    requestId: 'synthetic-request', actorScope: 'synthetic-user', signal: new AbortController().signal,
    allowedEffects: ['read-index'], budget: { requests: 0, bytes: 1000000, timeoutMs: 5000 },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  const parsed = JobQueryResultSchema.parse(result.value);
  assert.equal(parsed.items[0]!.salary?.fx?.id, 'synthetic-fx');
  assert.equal(parsed.items[0]!.distance?.locationId, 'near-office');
  assert.equal(parsed.items[0]!.color.classification.jurisdictions[0], 'SE');
  assert.equal(Object.hasOwn(parsed, 'anchor'), false);
  assert.equal(Object.hasOwn(parsed.normalizedQuery, 'anchor'), false);
  assert.equal(JSON.stringify(parsed).includes('"latitude":0,"longitude":0'), false);
});

test('valid 201-character entity and region identifiers remain addressable by query filters', async () => {
  const dataset = richDataset();
  const longCompanyId = `c${'x'.repeat(200)}`;
  const longSourceId = `s${'x'.repeat(200)}`;
  const longRegionId = `r${'x'.repeat(200)}`;
  dataset.companies[0]!.id = longCompanyId;
  dataset.jobs[0]!.companyId = longCompanyId;
  dataset.sources[0]!.sourceId = longSourceId;
  dataset.listings[0]!.sourceId = longSourceId;
  dataset.locations[0]!.regionId = longRegionId;
  const result = await queryJobs(dataset, { ...query, sourceIds: [longSourceId], companyIds: [longCompanyId], workRegionIds: [longRegionId] }, options);
  assert.equal(result.totalJobs, 1);
  assert.equal(JobQueryResultSchema.safeParse(result).success, true);
});
