import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCompensation, type Compensation, type SourceDefinition } from '@better-me/opportunities';
import type { SourceAdapterContext, SourceAdapterRequest, SourceJobRecord } from '../src/contracts.js';
import { ashbyAdapter } from '../src/adapters/ashby.js';

// Synthetic data with field shapes and component distinctions observed in the
// official public Posting API; no network, source service or private index.
const NOW = '2026-10-19T00:00:00.000Z';
const SOURCE = 'https://api.ashbyhq.com/posting-api/job-board/synthetic-board?includeCompensation=true';
function request(jobs: Record<string, unknown>[]) {
  const urls: string[] = [];
  const source: SourceDefinition = {
    sourceId: 'synthetic-ashby', name: 'Synthetic Ashby board', adapterId: 'ashby', adapterVersion: '1',
    capabilities: ['list-jobs'], runtime: ['local-service'], entityType: 'job-posting', enabled: true, status: 'active', remoteFilters: [],
    options: { boardToken: 'synthetic-board', companyName: 'Synthetic employer' },
    endpointPolicy: { allowedHosts: ['api.ashbyhq.com'], allowedPathPrefixes: ['/posting-api/job-board/synthetic-board'], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: 'Synthetic official board', usage: 'metadata', requiresAttribution: true },
    refreshPolicy: { mode: 'manual', minIntervalSeconds: 60, maxRecords: 100, maxPages: 1, requestsPerMinute: 10 },
  };
  const context: SourceAdapterContext = {
    observedAt: NOW, requestId: 'synthetic-ashby-fields', actorScope: 'synthetic-owner', signal: new AbortController().signal,
    budget: { requests: 1, bytes: 100_000, timeoutMs: 5000 }, consumeRequests() {}, consumeBytes() {}, throwIfCancelled() {},
  };
  const input: SourceAdapterRequest = {
    source, context, scope: { roles: [], regions: [], companyNames: [] },
    transport: { async request({ url }) { urls.push(url); return { url, status: 200, headers: {}, text: JSON.stringify({ apiVersion: '1', jobs }) }; } },
  };
  return { input, urls };
}
const job = (fields: Record<string, unknown> = {}) => ({
  id: 'synthetic-job', title: 'Synthetic engineer', jobUrl: 'https://jobs.ashbyhq.com/synthetic-board/synthetic-job',
  applyUrl: 'https://jobs.ashbyhq.com/synthetic-board/synthetic-job/application', ...fields,
});
const postal = (country?: string, city?: string, region?: string) => ({ postalAddress: {
  ...(country ? { addressCountry: country } : {}), ...(city ? { addressLocality: city } : {}), ...(region ? { addressRegion: region } : {}),
} });
const component = (fields: Record<string, unknown> = {}) => ({
  id: 'synthetic-component', summary: 'Salary $168K – $220.5K', compensationType: 'Salary', interval: '1 YEAR',
  currencyCode: 'USD', minValue: 168000, maxValue: 220500, ...fields,
});
function normalize(value: SourceJobRecord['compensations'][number], index = 0) {
  const compensation: Compensation = {
    ...value, id: `synthetic-compensation-${index}`, verification: 'unverified',
    evidence: [{ observationId: 'synthetic-observation', sourceUrl: SOURCE, observedAt: NOW, selector: `jobs[0].compensation.compensationTiers[0].components[${index}]` }],
  };
  return normalizeCompensation(compensation, { now: NOW });
}

test('Ashby reads explicit nested and documented flat addresses independently and retains source paths without coordinates', async () => {
  const { input, urls } = request([job({
    location: 'Dallas, Texas', workplaceType: 'OnSite', address: postal('United States', 'Dallas', 'Texas'),
    secondaryLocations: [
      { location: 'Chicago, Illinois', address: postal('USA', 'Chicago', 'Illinois') },
      { location: 'Toronto, Ontario', address: { addressCountry: 'Canada', addressLocality: 'Toronto', addressRegion: 'Ontario' } },
    ],
  })]);
  const result = await ashbyAdapter.list(input), value = result.records[0]!;
  assert.deepEqual(urls, [SOURCE]); assert.equal(result.records.length, 1); assert.equal(result.coverage.complete, true);
  assert.deepEqual(value.locations, [
    { raw: 'Dallas, Texas', countryCode: 'US', city: 'Dallas', region: 'Texas' },
    { raw: 'Chicago, Illinois', countryCode: 'US', city: 'Chicago', region: 'Illinois' },
    { raw: 'Toronto, Ontario', countryCode: 'CA', city: 'Toronto', region: 'Ontario' },
  ]);
  assert.equal(value.workMode, 'on-site'); assert.deepEqual(value.remoteEligibleRegions, []);
  assert.deepEqual(value.evidence.filter(item => item.field === 'locations').map(item => item.selector), [
    'jobs[0].address', 'jobs[0].secondaryLocations[0].address', 'jobs[0].secondaryLocations[1].address',
  ]);
  assert.ok(value.evidence.every(item => item.sourceUrl === SOURCE));
  assert.doesNotMatch(JSON.stringify(value.locations), /coordinates|latitude|longitude/);
});

test('same raw labels do not merge offices with different disclosed countries or cities', async () => {
  const { input } = request([job({ location: 'Cambridge', address: postal('United States', 'Cambridge', 'Massachusetts'), secondaryLocations: [
    { location: 'Cambridge', address: postal('United Kingdom', 'Cambridge', 'England') },
    { location: 'Cambridge', address: postal('Canada', 'Cambridge', 'Ontario') },
    { location: 'Cambridge', address: postal('United States', 'Cambridge', 'Massachusetts') },
  ] })]);
  const result = await ashbyAdapter.list(input), value = result.records[0]!;
  assert.equal(value.locations.length, 3);
  assert.deepEqual(value.locations.map(place => [place.raw, place.countryCode, place.region]), [
    ['Cambridge', 'US', 'Massachusetts'], ['Cambridge', 'GB', 'England'], ['Cambridge', 'CA', 'Ontario'],
  ]);
  assert.equal(value.evidence.filter(item => item.field === 'locations').length, 3);
});

test('missing labels retain disclosed address text while unsupported country names and market labels never establish a country', async () => {
  const { input } = request([job({
    title: 'Synthetic US and Singapore engineer', address: postal('de', 'Berlin', 'Berlin'), secondaryLocations: [
      { address: { addressLocality: 'Paris', addressRegion: 'Ile-de-France', addressCountry: 'France' } },
      { location: 'Europe' },
      { address: postal('Unrecognized Country', 'Synthetic City', 'Synthetic Region') },
    ],
  })]);
  const result = await ashbyAdapter.list(input), value = result.records[0]!;
  assert.deepEqual(value.locations, [
    { raw: 'Berlin, Berlin, de', countryCode: 'DE', city: 'Berlin', region: 'Berlin' },
    { raw: 'Paris, Ile-de-France, France', countryCode: 'FR', city: 'Paris', region: 'Ile-de-France' },
    { raw: 'Europe' },
    { raw: 'Synthetic City, Synthetic Region, Unrecognized Country', city: 'Synthetic City', region: 'Synthetic Region' },
  ]);
  assert.equal(value.locations[2]!.countryCode, undefined); assert.equal(value.locations[3]!.countryCode, undefined);
  assert.equal(value.availability, 'unknown');
});

test('remote labels stay eligibility text, structured remote areas stay disclosed regions, and Hybrid takes precedence over isRemote', async () => {
  const { input } = request([
    job({ id: 'labels', workplaceType: 'Remote', isRemote: true, location: 'Europe', secondaryLocations: [{ location: 'European Union' }] }),
    job({ id: 'remote-structured', workplaceType: 'Remote', isRemote: true, location: 'Dallas, Texas', address: postal('United States', 'Dallas', 'Texas') }),
    job({ id: 'hybrid', workplaceType: 'Hybrid', isRemote: true, location: 'San Francisco, California', address: postal('United States'), secondaryLocations: [{ location: 'Seattle, Washington', address: postal('United States', 'Seattle', 'Washington') }] }),
    job({ id: 'fallback', isRemote: true, location: 'Europe' }),
  ]);
  const result = await ashbyAdapter.list(input);
  const [labels, remote, hybrid, fallback] = result.records;
  assert.equal(labels!.workMode, 'remote'); assert.deepEqual(labels!.locations, []); assert.deepEqual(labels!.remoteEligibleRegions, ['Europe', 'European Union']);
  assert.equal(remote!.workMode, 'remote'); assert.deepEqual(remote!.locations, [{ raw: 'Dallas, Texas', countryCode: 'US', city: 'Dallas', region: 'Texas' }]);
  assert.deepEqual(remote!.remoteEligibleRegions, ['Dallas, Texas']);
  assert.equal(hybrid!.workMode, 'hybrid'); assert.equal(hybrid!.locations.length, 2); assert.deepEqual(hybrid!.remoteEligibleRegions, []);
  assert.equal(fallback!.workMode, 'remote'); assert.deepEqual(fallback!.locations, []); assert.deepEqual(fallback!.remoteEligibleRegions, ['Europe']);
  assert.doesNotMatch(JSON.stringify(result.records), /"(?:coordinates|latitude|longitude|kind)":"office"/);
});

test('salary, commission, equity cash, bonus and percentage components preserve distinct disclosed semantics and unknown tax', async () => {
  const { input } = request([job({ compensation: {
    compensationTierSummary: 'Summary envelope is not an additional payment',
    compensationTiers: [{ title: 'United States', additionalInformation: null, components: [
      component(),
      component({ id: 'synthetic-commission', summary: '$72K – $94.5K Commission', compensationType: 'Commission', minValue: 72000, maxValue: 94500 }),
      component({ id: 'synthetic-equity', summary: 'Offers Equity', compensationType: 'EquityCashValue', minValue: null, maxValue: null }),
      component({ id: 'synthetic-bonus', summary: 'Offers Bonus', compensationType: 'Bonus', minValue: null, maxValue: null }),
      component({ id: 'synthetic-percentage', summary: '0.5% – 1.75%', compensationType: 'EquityPercentage', currencyCode: null, interval: 'NONE', minValue: 0.5, maxValue: 1.75 }),
    ] }],
    summaryComponents: [component()],
  } })]);
  const result = await ashbyAdapter.list(input), value = result.records[0]!;
  assert.equal(value.compensations.length, 5);
  const [salary, commission, equity, bonus, percentage] = value.compensations;
  assert.deepEqual([salary!.kind, salary!.currency, salary!.period, salary!.min, salary!.max, salary!.tax], ['base', 'USD', 'year', 168000, 220500, 'unknown']);
  assert.deepEqual([commission!.kind, commission!.currency, commission!.period, commission!.min, commission!.max], ['unknown', 'USD', 'year', 72000, 94500]);
  assert.deepEqual([equity!.kind, equity!.currency, equity!.period, equity!.min, equity!.max], ['equity', 'USD', 'year', undefined, undefined]);
  assert.deepEqual([bonus!.kind, bonus!.min, bonus!.max], ['bonus', undefined, undefined]);
  assert.deepEqual([percentage!.kind, percentage!.currency, percentage!.period, percentage!.min, percentage!.max], ['unknown', undefined, 'unknown', undefined, undefined]);
  assert.ok(value.compensations.every(entry => entry.tax === 'unknown'));
  assert.match(salary!.raw, /United States.*Salary.*168K.*220.5K/); assert.match(percentage!.raw, /0.5%.*1.75%/);
  assert.ok(value.compensations.every(entry => !Object.hasOwn(entry, 'locationIds')));
  const evidence = value.evidence.filter(entry => entry.field === 'compensations');
  assert.deepEqual(evidence.map(entry => entry.selector), Array.from({ length: 5 }, (_, i) => `jobs[0].compensation.compensationTiers[0].components[${i}]`));
  assert.equal(JSON.parse(evidence[1]!.quote!).compensationType, 'Commission');
  assert.equal(JSON.parse(evidence[4]!.quote!).minValue, 0.5);
  value.compensations.forEach((entry, index) => { const normalized = normalize(entry, index); assert.equal(normalized.cnyAnnual, undefined); assert.equal(normalized.originalAnnual, undefined); });
  assert.equal(normalize(salary!).reason, 'unknown-tax-basis'); assert.equal(normalize(commission!).reason, 'not-base-salary');
});

test('multiple tiers preserve their labels and source indices without duplicating summary envelopes or inferring location bindings', async () => {
  const { input } = request([job({ location: 'San Francisco, California', address: postal('United States'), compensation: {
    compensationTierSummary: '$172.8K – $283.5K • Multiple Ranges', scrapeableCompensationSalarySummary: '$172,800 - $283,500',
    summaryComponents: [component({ minValue: 172800, maxValue: 283500 })],
    compensationTiers: [
      { title: 'US - Tier 1', components: [component({ summary: 'Salary $216,000 – $283,500', minValue: 216000, maxValue: 283500 })] },
      { title: 'US - Tier 2', components: [component({ summary: 'Salary $194,400 – $255,150', minValue: 194400, maxValue: 255150 })] },
      { title: 'US - Tier 3', components: [component({ summary: 'Salary $172,800 – $226,800', minValue: 172800, maxValue: 226800 })] },
    ],
  } })]);
  const result = await ashbyAdapter.list(input), value = result.records[0]!;
  assert.deepEqual(value.compensations.map(entry => [entry.min, entry.max]), [[216000, 283500], [194400, 255150], [172800, 226800]]);
  assert.deepEqual(value.evidence.filter(entry => entry.field === 'compensations').map(entry => entry.selector), [
    'jobs[0].compensation.compensationTiers[0].components[0]', 'jobs[0].compensation.compensationTiers[1].components[0]', 'jobs[0].compensation.compensationTiers[2].components[0]',
  ]);
  for (let i = 0; i < 3; i++) assert.match(value.compensations[i]!.raw, new RegExp(`US - Tier ${i + 1}`));
  assert.ok(value.compensations.every(entry => !Object.hasOwn(entry, 'locationIds')));
  assert.ok(value.warnings.some(warning => /tiers.*separately.*location bindings/.test(warning)));
});

test('unknown intervals, reversed ranges and unknown component types retain original evidence without comparable salary', async () => {
  const { input } = request([job({ compensation: { compensationTiers: [{ title: 'Synthetic tier', components: [
    component({ id: 'synthetic-unknown-interval', summary: 'USD 100 – 200 per fortnight', interval: '2 WEEKS', minValue: 100, maxValue: 200 }),
    component({ id: 'synthetic-reversed', summary: 'USD 300 – 100 per year', minValue: 300, maxValue: 100 }),
    component({ id: 'synthetic-unknown-type', summary: 'Original future type 17 – 29', compensationType: 'FutureComponent', minValue: 17, maxValue: 29 }),
  ] }] } })]);
  const result = await ashbyAdapter.list(input), value = result.records[0]!;
  const [interval, reversed, unknown] = value.compensations;
  assert.equal(interval!.period, 'unknown'); assert.match(interval!.raw, /2 WEEKS/);
  assert.equal(reversed!.min, undefined); assert.equal(reversed!.max, undefined); assert.match(reversed!.raw, /300.*100/);
  assert.equal(unknown!.kind, 'unknown'); assert.equal(unknown!.min, undefined); assert.equal(unknown!.max, undefined); assert.equal(unknown!.currency, undefined);
  assert.match(unknown!.raw, /Original future type 17.*29/);
  assert.ok(value.warnings.some(warning => /reversed bounds/.test(warning)));
  const evidence = value.evidence.filter(entry => entry.field === 'compensations');
  assert.equal(JSON.parse(evidence[0]!.quote!).interval, '2 WEEKS');
  assert.deepEqual([JSON.parse(evidence[1]!.quote!).minValue, JSON.parse(evidence[1]!.quote!).maxValue], [300, 100]);
  assert.equal(JSON.parse(evidence[2]!.quote!).compensationType, 'FutureComponent');
  value.compensations.forEach((entry, index) => { assert.equal(normalize(entry, index).cnyAnnual, undefined); });
});

test('tier-only summaries, top-level fallback and OTE prose remain separate raw disclosures without inferred arithmetic', async () => {
  const { input } = request([
    job({ id: 'tier-only', compensation: { compensationTiers: [{ title: 'Zone A', tierSummary: 'Original salary range unavailable', components: [] }] } }),
    job({ id: 'fallback', compensation: { compensationTierSummary: 'Original fallback compensation text' } }),
    job({ id: 'ote', compensation: { compensationTiers: [{ title: 'United States', additionalInformation: 'OTE (70/30 base/commission split) $248,000 - $325,500', components: [component({ summary: 'Salary $173,600 – $227,850', minValue: 173600, maxValue: 227850 })] }] } }),
  ]);
  const result = await ashbyAdapter.list(input), [tier, fallback, ote] = result.records;
  assert.equal(tier!.compensations.length, 1); assert.match(tier!.compensations[0]!.raw, /Zone A.*Original salary range unavailable/);
  assert.deepEqual(fallback!.compensations, [{ raw: 'Original fallback compensation text', period: 'unknown', tax: 'unknown', kind: 'unknown' }]);
  assert.equal(ote!.compensations.length, 2); assert.match(ote!.compensations[1]!.raw, /United States.*OTE \(70\/30.*248,000.*325,500/);
  assert.equal(ote!.compensations[1]!.kind, 'unknown'); assert.equal(ote!.compensations[1]!.min, undefined); assert.equal(ote!.compensations[1]!.currency, undefined);
  assert.ok(ote!.evidence.some(entry => entry.selector === 'jobs[2].compensation.compensationTiers[0].additionalInformation'));
});
