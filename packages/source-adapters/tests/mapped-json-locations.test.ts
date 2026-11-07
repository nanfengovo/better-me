import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolError, type SourceDefinition } from '@better-me/opportunities';
import type { SourceAdapterRequest } from '../src/contracts.js';
import { JsonFieldMappingSchema, JsonFieldMappingOptionsSchema } from '../src/mapping-contracts.js';
import { mappedJsonAdapter, readJsonField } from '../src/adapters/mapped-json.js';
import { applyMappedJsonLocations } from '../src/adapters/mapped-json-locations.js';
import { baseRecord } from '../src/adapters/common.js';
import { assessSourceScopeMatch } from '../src/local-match.js';

const ENTRY = 'https://feed.example.com/api/jobs';
const structured = { locationsPath: 'places', locationTextPath: 'label', locationCountryPath: 'country',
  locationRegionPath: 'region', locationCityPath: 'city', locationStreetAddressPath: 'street', locationPostalCodePath: 'postal' };
function fixture(rows: unknown[], extra: SourceDefinition['options'] = {}) {
  const calls: string[] = [];
  const source: SourceDefinition = { sourceId: 'synthetic-place-feed', name: 'Synthetic place feed', adapterId: 'mapped-json', adapterVersion: '1',
    capabilities: ['list-jobs'], runtime: ['local-service'], entityType: 'job-posting', enabled: true, status: 'active', remoteFilters: [], entryUrl: ENTRY,
    options: { recordsPath: 'data', idPath: 'id', titlePath: 'title', companyPath: 'company', descriptionPath: 'description',
      urlPath: 'url', discoveryOnly: false, ...extra },
    endpointPolicy: { allowedHosts: ['feed.example.com'], allowedPathPrefixes: ['/api/jobs'], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: 'Synthetic place feed', usage: 'unknown', requiresAttribution: true },
    refreshPolicy: { mode: 'manual', minIntervalSeconds: 0, maxRecords: 100, maxPages: 2, requestsPerMinute: 30 } };
  const request: SourceAdapterRequest = { source, scope: { roles: [], regions: [], companyNames: [] },
    context: { requestId: 'synthetic-place-request', actorScope: 'synthetic-test', observedAt: '2026-10-22T00:00:00Z', signal: new AbortController().signal,
      budget: { requests: 2, bytes: 1_000_000, timeoutMs: 5000 }, consumeRequests() {}, consumeBytes() {}, throwIfCancelled() {} },
    transport: { async request({ url }) { calls.push(url); return { url, status: 200, headers: {}, text: JSON.stringify({ data: rows }) }; } } };
  return { request, calls };
}
const row = (changes: Record<string, unknown> = {}) => ({ id: 'one', title: 'Synthetic engineer', company: 'Synthetic employer',
  description: 'Build TypeScript services.', url: 'https://feed.example.com/jobs/one', ...changes });

test('legacy string and string-array locations preserve raw values, deduplication and their original evidence', async () => {
  const { request } = fixture([row({ places: [' <b>Shanghai</b> ', 'Shanghai', 'Beijing', 123, null, { label: 'Ignored object' }] }),
    row({ id: 'two', places: '<p>London</p>' }), row({ id: 'three', places: { city: 'Ignored object' } })], { locationsPath: 'places' });
  const result = await mappedJsonAdapter.list(request);
  assert.deepEqual(result.records.map(record => record.locations), [[{ raw: 'Shanghai' }, { raw: 'Beijing' }], [{ raw: 'London' }], []]);
  assert.deepEqual(result.records[0]!.evidence.filter(item => item.field === 'locations'), [{ field: 'locations', selector: 'data[0].places', sourceUrl: ENTRY }]);
  assert.equal(result.records[2]!.evidence.some(item => item.field.startsWith('locations')), false);
});

test('structured entries preserve each country, city, street and postcode without joining different places', async () => {
  const { request } = fixture([row({ places: [
    { label: 'Original Cambridge', country: 'US', region: 'Massachusetts', city: 'Cambridge', street: 'Source street 10', postal: '00123' },
    { label: 'Original Cambridge', country: 'GB', region: 'England', city: 'Cambridge', street: 'Source street 20', postal: 'CB1 2AB' },
  ] })], structured);
  const result = await mappedJsonAdapter.list(request), record = result.records[0]!;
  assert.deepEqual(record.locations, [
    { raw: 'Original Cambridge', countryCode: 'US', region: 'Massachusetts', city: 'Cambridge', streetAddress: 'Source street 10', postalCode: '00123' },
    { raw: 'Original Cambridge', countryCode: 'GB', region: 'England', city: 'Cambridge', streetAddress: 'Source street 20', postalCode: 'CB1 2AB' },
  ]);
  assert.equal(assessSourceScopeMatch(record, { roles: [], companyNames: [], regions: ['England'], countryCodes: ['US'] }).status, 'excluded');
  assert.equal(assessSourceScopeMatch(record, { roles: [], companyNames: [], regions: ['England'], countryCodes: ['GB'] }).status, 'matched');
  assert.doesNotMatch(JSON.stringify(record.locations), /coordinates|latitude|longitude|officeResolution|precision/);
});

test('the raw label takes priority while each structured field retains its own exact selector and source quote', async () => {
  const original = ' <b>Source office label</b> ';
  const { request } = fixture([row({ places: { label: original, country: 'cn', region: 'Shanghai', city: 'Shanghai', street: 'Source road 10', postal: '020000' } })], structured);
  const record = (await mappedJsonAdapter.list(request)).records[0]!;
  assert.equal(record.locations[0]!.raw, 'Source office label'); assert.equal(record.locations[0]!.countryCode, 'CN');
  for (const [field, path, quote] of [
    ['raw', 'label', original], ['countryCode', 'country', 'cn'], ['region', 'region', 'Shanghai'], ['city', 'city', 'Shanghai'],
    ['streetAddress', 'street', 'Source road 10'], ['postalCode', 'postal', '020000'],
  ]) assert.ok(record.evidence.some(item => item.field === `locations.0.${field}` && item.selector === `data[0].places.${path}` && item.quote === quote && item.sourceUrl === ENTRY));
});

test('missing labels use only the address fields disclosed by that entry, including nested fields', async () => {
  const { request } = fixture([row({ places: [
    { address: { nation: 'US', city: 'Boston', street: 'Source street 10', postal: '00123' } },
    { address: { city: 'Paris' } }, { label: 'Wrong field, not configured' },
  ] })], { locationsPath: 'places', locationCountryPath: 'address.nation', locationCityPath: 'address.city',
    locationStreetAddressPath: 'address.street', locationPostalCodePath: 'address.postal' });
  const record = (await mappedJsonAdapter.list(request)).records[0]!;
  assert.deepEqual(record.locations, [{ raw: 'Source street 10, Boston, 00123, US', countryCode: 'US', city: 'Boston', streetAddress: 'Source street 10', postalCode: '00123' }, { raw: 'Paris', city: 'Paris' }]);
  assert.ok(record.evidence.some(item => item.selector === 'data[0].places[0].address.postal' && item.quote === '00123'));
});

test('ISO2 mode accepts only actual catalog members and never aliases UK or guesses names, regions or cities', async () => {
  const countries = ['cn', 'US', 'UK', 'ZZ', 'EU', 'Europe', 'United States', 'Shanghai', 'US / Canada'];
  for (const mode of [undefined, 'iso2']) {
    const { request } = fixture([row({ places: countries.map(country => ({ country })) })], { locationsPath: 'places', locationCountryPath: 'country',
      ...(mode ? { locationCountryFormat: mode } : {}) });
    const record = (await mappedJsonAdapter.list(request)).records[0]!;
    assert.deepEqual(record.locations.map(location => location.countryCode), ['CN', 'US', undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
    assert.deepEqual(record.locations.map(location => location.raw), countries);
    assert.ok(record.evidence.some(item => item.field === 'locations.2.country' && item.quote === 'UK'));
  }
});

test('explicit name mode resolves finite exact aliases and country names while composite and unknown names stay raw', async () => {
  const countries = ['United States', 'UK', '中国', 'Germany', 'Europe', 'US / Canada', 'Shanghai', 'Unknown country'];
  const { request } = fixture([row({ places: countries.map(country => ({ country })) })], { locationsPath: 'places', locationCountryPath: 'country', locationCountryFormat: 'name' });
  const record = (await mappedJsonAdapter.list(request)).records[0]!;
  assert.deepEqual(record.locations.map(location => location.countryCode), ['US', 'GB', 'CN', 'DE', undefined, undefined, undefined, undefined]);
  assert.deepEqual(record.locations.map(location => location.raw), countries);
});

test('empty locationsPath selects this row and empty subpaths select each primitive country value', async () => {
  const sameRow = fixture([row({ country: 'CN', city: 'Shanghai', street: 'Source road 10' })], {
    locationsPath: '', locationCountryPath: 'country', locationCityPath: 'city', locationStreetAddressPath: 'street',
  });
  const record = (await mappedJsonAdapter.list(sameRow.request)).records[0]!;
  assert.deepEqual(record.locations, [{ raw: 'Source road 10, Shanghai, CN', countryCode: 'CN', city: 'Shanghai', streetAddress: 'Source road 10' }]);
  assert.ok(record.evidence.some(item => item.selector === 'data[0].street'));
  const primitive = fixture([row({ places: ['US', 'GB', 'Europe'] })], { locationsPath: 'places', locationCountryPath: '' });
  const primitiveRecord = (await mappedJsonAdapter.list(primitive.request)).records[0]!;
  assert.deepEqual(primitiveRecord.locations, [{ raw: 'US', countryCode: 'US' }, { raw: 'GB', countryCode: 'GB' }, { raw: 'Europe' }]);
  assert.ok(primitiveRecord.evidence.some(item => item.selector === 'data[0].places[0]' && item.quote === 'US'));
});

test('numeric, array and object postal fields are not converted and no country or city comes from another entry', async () => {
  const { request } = fixture([row({ places: [
    { label: 'Numeric postal', country: 86, region: {}, city: ['Shanghai'], street: 123, postal: 123 },
    { label: 'Array postal', postal: ['00123'] }, { label: 'Object postal', postal: { value: '00123' } },
    { label: 'Leading zero', postal: '00123' },
  ] })], structured);
  const record = (await mappedJsonAdapter.list(request)).records[0]!;
  assert.deepEqual(record.locations, [{ raw: 'Numeric postal' }, { raw: 'Array postal' }, { raw: 'Object postal' }, { raw: 'Leading zero', postalCode: '00123' }]);
});

test('deduplication compares all location fields rather than merging identical labels across countries or streets', async () => {
  const { request } = fixture([row({ places: [
    { label: 'Original office', country: 'US', street: 'Source street 10' },
    { label: 'Original office', country: 'US', street: 'Source street 10' },
    { label: 'Original office', country: 'US', street: 'Source street 20' },
    { label: 'Original office', country: 'GB', street: 'Source street 10' },
  ] })], structured);
  const record = (await mappedJsonAdapter.list(request)).records[0]!;
  assert.equal(record.locations.length, 3);
  assert.deepEqual(record.locations.map(location => [location.countryCode, location.streetAddress]), [['US', 'Source street 10'], ['US', 'Source street 20'], ['GB', 'Source street 10']]);
});

test('location evidence binds output indexes after skipped entries and deduplication while retaining every source selector', async () => {
  const { request } = fixture([row({ places: [
    {}, { label: 'First office', country: 'US', street: 'Source street 10' }, null,
    { label: 'First office', country: 'US', street: 'Source street 10' },
    { label: 'Second office', country: 'GB', street: 'Source street 20' },
  ] })], structured);
  const record = (await mappedJsonAdapter.list(request)).records[0]!;
  assert.equal(record.locations.length, 2);
  const first = record.evidence.filter(item => item.field.startsWith('locations.0.'));
  const second = record.evidence.filter(item => item.field.startsWith('locations.1.'));
  assert.equal(first.length, 6); assert.equal(second.length, 3);
  assert.ok(first.every(item => item.selector?.startsWith('data[0].places[1].') || item.selector?.startsWith('data[0].places[3].')));
  assert.ok(second.every(item => item.selector?.startsWith('data[0].places[4].')));
  assert.deepEqual(first.filter(item => item.field.endsWith('.streetAddress')).map(item => item.quote), ['Source street 10', 'Source street 10']);
  assert.deepEqual(second.filter(item => item.field.endsWith('.countryCode')).map(item => item.quote), ['GB']);
  assert.equal(record.evidence.some(item => /^locations\.[2-9]\./.test(item.field)), false);
});

test('the string zero remains disclosed text while numeric zero is never converted into a source address', async () => {
  const { request } = fixture([row({ places: [
    { label: 'String zero fields', region: '0', city: '0', street: '0', postal: '0' },
    { label: 'Number zero fields', country: 0, region: 0, city: 0, street: 0, postal: 0 },
  ] })], structured);
  const record = (await mappedJsonAdapter.list(request)).records[0]!;
  assert.deepEqual(record.locations, [{ raw: 'String zero fields', region: '0', city: '0', streetAddress: '0', postalCode: '0' }, { raw: 'Number zero fields' }]);
  assert.equal(record.evidence.filter(item => item.field.startsWith('locations.0.') && item.quote === '0').length, 4);
  assert.equal(record.evidence.filter(item => item.field.startsWith('locations.1.')).length, 1);
});

test('geo, headquarters, search settings and unconfigured sibling fields cannot become office coordinates or address fields', async () => {
  const { request } = fixture([row({ places: { label: 'Original city label', country: 'CN', city: 'Shanghai', geo: { latitude: 31, longitude: 121 },
    latitude: 31, longitude: 121, address: { street: 'Unconfigured street' } }, headquarters: { street: 'HQ only 99' } })], structured);
  request.scope = { roles: [], regions: ['Shanghai'], countryCodes: ['CN'], companyNames: [] };
  const record = (await mappedJsonAdapter.list(request)).records[0]!;
  assert.deepEqual(record.locations, [{ raw: 'Original city label', countryCode: 'CN', city: 'Shanghai' }]);
  assert.doesNotMatch(JSON.stringify(record.locations), /coordinates|latitude|longitude|streetAddress|officeResolution|precision/);
  assert.equal(record.availability, 'unknown');
});

test('structured path reads cannot execute getters or traverse inherited properties', () => {
  let accesses = 0;
  const entry = Object.create({ country: 'US', city: 'Inherited city' }) as Record<string, unknown>;
  Object.defineProperty(entry, 'street', { get() { accesses++; return 'Getter street 10'; } });
  Object.defineProperty(entry, 'label', { value: 'Own original label' });
  const mapping = JsonFieldMappingSchema.parse({ titlePath: 'title', ...structured });
  const result = baseRecord('Synthetic role', ENTRY, 'title');
  applyMappedJsonLocations(result, [entry], mapping, 'data[0].places', ENTRY, readJsonField);
  assert.equal(accesses, 0); assert.deepEqual(result.locations, [{ raw: 'Own original label' }]);
  assert.deepEqual(result.evidence.filter(item => item.field.startsWith('locations')), [{ field: 'locations.0.raw', selector: 'data[0].places[0].label', quote: 'Own original label', sourceUrl: ENTRY }]);
});

test('new path configuration is strict and requires an explicit location root and country format basis', async () => {
  const paths = ['locationTextPath', 'locationCountryPath', 'locationRegionPath', 'locationCityPath', 'locationStreetAddressPath', 'locationPostalCodePath'];
  for (const key of paths) for (const path of ['__proto__.x', 'constructor.name', 'x.prototype', 'x[0]', 'x.*', 'x();process.exit()']) {
    assert.equal(JsonFieldMappingSchema.safeParse({ titlePath: 'title', locationsPath: 'places', [key]: path }).success, false);
  }
  for (const key of paths.filter(key => key.startsWith('location'))) assert.equal(JsonFieldMappingSchema.safeParse({ titlePath: 'title', [key]: 'value' }).success, false);
  for (const invalid of [{ locationCountryFormat: 'name' }, { locationsPath: 'places', locationCountryFormat: 'name' },
    { locationsPath: 'places', locationCountryPath: 'country', locationCountryFormat: 'guess' }]) {
    assert.equal(JsonFieldMappingSchema.safeParse({ titlePath: 'title', ...invalid }).success, false);
    const { request, calls } = fixture([row()], invalid);
    await assert.rejects(mappedJsonAdapter.list(request), (error: unknown) => error instanceof ToolError && error.code === 'invalid-input');
    assert.equal(calls.length, 0);
  }
  assert.equal(JsonFieldMappingSchema.safeParse({ titlePath: 'title', locationsPath: '', locationCountryPath: '' }).success, true);
});

test('omitted new options add no defaults to legacy parsed mappings and preserve cursor configuration shape', () => {
  const legacy = JsonFieldMappingSchema.parse({ titlePath: 'title', locationsPath: 'location' });
  assert.deepEqual(legacy, { recordsPath: '', titlePath: 'title', locationsPath: 'location', descriptionCompleteness: 'detail', enumerationComplete: true,
    publishedFormat: 'iso', pageParameter: 'page', discoveryOnly: true });
});

test('source options can strip unrelated host fields without bypassing the same location mapping refinements', () => {
  const valid = { titlePath: 'title', locationsPath: '', locationCountryPath: 'country', locationCountryFormat: 'iso2', hostOwnedOption: 'preserved elsewhere' };
  assert.equal(JsonFieldMappingSchema.safeParse(valid).success, false);
  const parsed = JsonFieldMappingOptionsSchema.parse(valid);
  assert.equal(Object.hasOwn(parsed, 'hostOwnedOption'), false);
  assert.equal(parsed.locationCountryPath, 'country');
  assert.equal(parsed.locationCountryFormat, 'iso2');
  for (const invalid of [{ titlePath: 'title', locationCityPath: 'city', hostOwnedOption: true },
    { titlePath: 'title', locationsPath: 'places', locationCountryFormat: 'name', hostOwnedOption: true },
    { titlePath: 'title', locationsPath: 'places', locationCountryPath: '__proto__.country', hostOwnedOption: true }]) {
    assert.equal(JsonFieldMappingSchema.safeParse(invalid).success, false);
    assert.equal(JsonFieldMappingOptionsSchema.safeParse(invalid).success, false);
  }
});

test('a pagination cursor rejects any changed location mapping before a subsequent external request', async () => {
  const f = fixture([row({ id: 'one', places: { label: 'Source office', country: 'US', city: 'Boston', street: 'Source street 10', postal: '00123' } }),
    row({ id: 'two', places: { label: 'Second office', country: 'GB', city: 'London' } })], { ...structured, nextPageUrlPath: 'links.next' });
  f.request.source.refreshPolicy.maxRecords = 1;
  f.request.transport = { async request({ url }) { f.calls.push(url); return { url, status: 200, headers: {}, text: JSON.stringify({
    data: [row({ id: 'one', places: { label: 'Source office', country: 'US', city: 'Boston', street: 'Source street 10', postal: '00123' } }),
      row({ id: 'two', places: { label: 'Second office', country: 'GB', city: 'London' } })], links: { next: null },
  }) }; } };
  const first = await mappedJsonAdapter.list(f.request); assert.ok(first.nextCursor); assert.equal(f.calls.length, 1);
  const changes = { locationsPath: 'otherPlaces', locationTextPath: 'otherLabel', locationCountryPath: 'otherCountry', locationCountryFormat: 'name',
    locationRegionPath: 'otherRegion', locationCityPath: 'otherCity', locationStreetAddressPath: 'otherStreet', locationPostalCodePath: 'otherPostal' };
  for (const [key, value] of Object.entries(changes)) await assert.rejects(mappedJsonAdapter.list({ ...f.request, cursor: first.nextCursor,
    source: { ...f.request.source, options: { ...f.request.source.options, [key]: value } } }),
  (error: unknown) => error instanceof ToolError && error.code === 'invalid-input');
  assert.equal(f.calls.length, 1);
  const second = await mappedJsonAdapter.list({ ...f.request, cursor: first.nextCursor });
  assert.deepEqual(second.records.map(record => record.sourceRecordId), ['two']); assert.equal(second.nextCursor, undefined);
});
