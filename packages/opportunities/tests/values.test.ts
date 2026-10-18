import assert from 'node:assert/strict';
import test from 'node:test';
import type { Company, Compensation, JobLocation } from '../src/schema.js';
import {
  CompensationNormalizationOptionsSchema,
  FxSnapshotSchema,
  NormalizedCompensationSchema,
  normalizeCompensation,
  salaryMetric,
  type FxSnapshot,
} from '../src/compensation.js';
import { distanceToLocations, evaluateLocationDistance, haversineKm, LocationDistanceSchema, type Wgs84Coordinate } from '../src/geo.js';
import {
  CompanyColorConfigSchema,
  CompanyColorMatchSchema,
  classifyCompany,
  effectiveCompanyControllers,
  exportCompanyColorConfig,
  getDefaultCompanyColorConfig,
  importCompanyColorConfig,
  resolveCompanyColor,
} from '../src/colors.js';

const evidence = [{
  observationId: 'synthetic-observation', sourceUrl: 'https://careers.example.test/job/1',
  quote: 'Annual gross base salary CNY 120000–240000.', observedAt: '2026-10-18T00:00:00.000Z',
}];
const now = '2026-10-18T12:00:00.000Z';
function compensation(overrides: Partial<Compensation> = {}): Compensation {
  return {
    id: 'synthetic-salary', raw: evidence[0]!.quote, currency: 'CNY', period: 'year', min: 120000, max: 240000,
    tax: 'gross', kind: 'base', verification: 'verified', evidence: structuredClone(evidence), ...overrides,
  };
}
function point(latitude: number, longitude: number): Wgs84Coordinate {
  return { latitude, longitude, coordinateSystem: 'WGS84' };
}
function location(overrides: Partial<JobLocation> = {}): JobLocation {
  return {
    id: 'synthetic-office', raw: 'Synthetic office', kind: 'office', coordinates: point(0, 1), precision: 'address',
    verification: 'verified', evidence: structuredClone(evidence), ...overrides,
  };
}
function company(code?: string, kind: 'state' | 'private' | 'dispersed' | 'joint' | 'unknown' = 'private'): Company {
  return {
    id: 'synthetic-company', names: ['Synthetic company'], domains: [], parentCompanyIds: [], manualOverrides: [],
    ultimateControllers: {
      value: [{ name: 'Synthetic controller', jurisdictionCode: code, kind }], evidence: structuredClone(evidence),
      verification: 'verified', method: 'manual', revision: 0,
    },
  };
}

test('annual gross fixed cash preserves disclosure, evidence and both bounds', () => {
  const input = compensation();
  const normalized = normalizeCompensation(input, { now });
  assert.equal(normalized.reason, 'comparable');
  assert.deepEqual(normalized.cnyAnnual, { currency: 'CNY', min: 120000, max: 240000 });
  assert.equal(salaryMetric(normalized, 'mid'), 180000);
  assert.equal(normalized.estimated, false);
  assert.equal(normalized.raw, input.raw);
  normalized.evidence[0]!.quote = 'Changed copy';
  assert.equal(input.evidence[0]!.quote, evidence[0]!.quote);
});

test('monthly payroll count is explicit; twelve-month estimate needs an opt-in and an assumption', () => {
  const input = compensation({ period: 'month', min: 10000, max: 20000 });
  assert.equal(normalizeCompensation(input, { now }).reason, 'missing-months-per-year');
  const estimate = normalizeCompensation(input, { now, allowMonthlyEstimate: true });
  assert.deepEqual(estimate.cnyAnnual, { currency: 'CNY', min: 120000, max: 240000 });
  assert.equal(estimate.estimated, true);
  assert.deepEqual(estimate.assumptions, ['monthly-base-times-12']);
  const disclosed = normalizeCompensation({ ...input, monthsPerYear: 13 }, { now, allowMonthlyEstimate: true });
  assert.equal(disclosed.cnyAnnual?.min, 130000);
  assert.equal(disclosed.estimated, false);
});

test('hour/day/week wages never acquire guessed working time', () => {
  for (const [period, field, units] of [
    ['hour', 'hoursPerYear', 1800], ['day', 'daysPerYear', 200], ['week', 'weeksPerYear', 48],
  ] as const) {
    const input = compensation({ period, min: 100, max: undefined });
    assert.equal(normalizeCompensation(input, { now }).reason, `missing-${period}s-per-year`);
    const normalized = normalizeCompensation({ ...input, [field]: units }, { now });
    assert.equal(normalized.cnyAnnual?.min, 100 * units);
    assert.equal(normalized.cnyAnnual?.max, undefined);
  }
});

test('tax assumptions, bonus, equity and total compensation cannot inflate the base comparison', () => {
  for (const tax of ['net', 'unknown'] as const) {
    const normalized = normalizeCompensation(compensation({ tax }), { now });
    assert.equal(normalized.cnyAnnual, undefined);
    assert.equal(normalized.reason, tax === 'net' ? 'net-salary' : 'unknown-tax-basis');
  }
  for (const kind of ['bonus', 'equity', 'total', 'unknown'] as const) {
    assert.equal(normalizeCompensation(compensation({ kind }), { now }).reason, 'not-base-salary');
  }
});

test('unknown/conflicting or unbound amounts stay unknown; disclosed unverified figures retain that status', () => {
  for (const verification of ['unknown', 'conflicting'] as const) {
    assert.equal(normalizeCompensation(compensation({ verification }), { now }).cnyAnnual, undefined);
  }
  const missing = compensation({ verification: 'unverified', evidence: [] });
  assert.equal(normalizeCompensation(missing, { now }).reason, 'missing-evidence');
  const urlOnly = compensation({ evidence: [{ ...evidence[0]!, quote: undefined }] });
  assert.equal(normalizeCompensation(urlOnly, { now }).reason, 'missing-evidence');
  const disclosed = normalizeCompensation(compensation({ verification: 'unverified' }), { now });
  assert.equal(disclosed.cnyAnnual?.min, 120000);
  assert.equal(disclosed.verification, 'unverified');
});

test('only an actual disclosed side supports min/max; midpoint never invents a missing side', () => {
  const upperOnly = normalizeCompensation(compensation({ min: undefined, max: 240000 }), { now });
  assert.equal(salaryMetric(upperOnly, 'min'), undefined);
  assert.equal(salaryMetric(upperOnly, 'mid'), undefined);
  assert.equal(salaryMetric(upperOnly, 'max'), 240000);
  const lowerOnly = normalizeCompensation(compensation({ max: undefined }), { now });
  assert.equal(salaryMetric(lowerOnly, 'min'), 120000);
  assert.equal(salaryMetric(lowerOnly, 'mid'), undefined);
  assert.equal(salaryMetric(lowerOnly, 'max'), undefined);
  assert.equal(normalizeCompensation(compensation({ min: undefined, max: undefined }), { now }).reason, 'missing-amount');
  assert.equal(normalizeCompensation(compensation({ min: 300000, max: 200000 }), { now }).reason, 'invalid-compensation');
});

const fx: FxSnapshot = { id: 'synthetic-fx', provider: 'Synthetic test provider', date: '2026-10-17', ratesToCny: { USD: 7, EUR: 8 } };
test('FX records source/date/rate and original annual values, never mixes display currencies', () => {
  const normalized = normalizeCompensation(compensation({ currency: 'USD', min: 100000, max: 150000 }), { fx, now });
  assert.equal(normalized.cnyAnnual?.min, 700000);
  assert.deepEqual(normalized.originalAnnual, { currency: 'USD', min: 100000, max: 150000 });
  assert.deepEqual(normalized.fx, { id: fx.id, provider: fx.provider, date: fx.date, rateToCny: 7, ageDays: 1 });
  assert.equal(salaryMetric(normalized, 'min', 'USD'), 100000);
  assert.equal(salaryMetric(normalized, 'min', 'EUR'), undefined);
  assert.equal(salaryMetric(normalized, 'min'), 700000);
});

test('missing, stale and future FX retain original currency but do not create a CNY amount', () => {
  const input = compensation({ currency: 'USD' });
  const cases = [
    [{}, 'fx-missing'],
    [{ fx: { ...fx, ratesToCny: { EUR: 8 } } }, 'fx-rate-missing'],
    [{ fx: { ...fx, date: '2026-10-19' } }, 'fx-future'],
    [{ fx: { ...fx, date: '2026-09-01' }, maxFxAgeDays: 30 }, 'fx-stale'],
  ] as const;
  for (const [options, reason] of cases) {
    const normalized = normalizeCompensation(input, { ...options, now });
    assert.equal(normalized.reason, reason);
    assert.equal(normalized.status, 'original-only');
    assert.equal(normalized.cnyAnnual, undefined);
    assert.equal(normalized.originalAnnual?.currency, 'USD');
  }
  assert.equal(normalizeCompensation(input, { fx: { ...fx, date: '2026-10-17' }, now: '2026-10-18T23:59:59.000Z', maxFxAgeDays: 1 }).status, 'comparable');
});

test('FX snapshot and options reject impossible dates, negative rates and executable/unknown fields', () => {
  for (const value of [
    { ...fx, date: '2026-02-30' }, { ...fx, ratesToCny: { USD: -1 } },
    { ...fx, ratesToCny: { CNY: 7 } }, { ...fx, expression: 'arbitrary-code' },
  ]) assert.equal(FxSnapshotSchema.safeParse(value).success, false);
  assert.equal(CompensationNormalizationOptionsSchema.safeParse({ maxFxAgeDays: -1 }).success, false);
  assert.equal(normalizeCompensation(compensation({ currency: 'USD' }), { fx: { ...fx, date: '2026-02-30' }, now }).reason, 'invalid-options');
});

test('Haversine handles zero, antipodes, poles and crossing the date line', () => {
  assert.equal(haversineKm(point(0, 0), point(0, 0)), 0);
  assert.ok(Math.abs(haversineKm(point(0, 0), point(0, 180))! - 20015.114442) < 0.001);
  assert.ok(haversineKm(point(90, 0), point(90, 120))! < 0.000001);
  assert.ok(Math.abs(haversineKm(point(0, 179.9), point(0, -179.9))! - 22.239016) < 0.001);
  assert.ok(Math.abs(haversineKm(point(51.5074, -0.1278), point(40.7128, -74.006))! - 5570.23) < 1);
});

test('invalid ranges and foreign coordinate systems are not silently converted or used', () => {
  for (const invalid of [point(91, 0), point(0, 181), point(Number.NaN, 0), { ...point(0, 0), coordinateSystem: 'GCJ02' }]) {
    assert.equal(haversineKm(invalid as Wgs84Coordinate, point(0, 0)), undefined);
  }
  const invalid = location({ coordinates: { ...point(0, 1), coordinateSystem: 'BD09' } as Wgs84Coordinate });
  assert.equal(evaluateLocationDistance(point(0, 0), invalid).reason, 'invalid-coordinates');
});

test('city estimates require opt-in; remote areas and coarse regions never become offices', () => {
  const city = location({ precision: 'city' });
  assert.equal(evaluateLocationDistance(point(0, 0), city).reason, 'city-estimate-disabled');
  assert.equal(evaluateLocationDistance(point(0, 0), city, { allowCityEstimate: true }).distance?.estimated, true);
  for (const precision of ['country', 'region', 'unknown'] as const) {
    assert.equal(evaluateLocationDistance(point(0, 0), location({ precision }), { allowCityEstimate: true }).reason, 'insufficient-precision');
  }
  assert.equal(evaluateLocationDistance(point(0, 0), location({ kind: 'remote-region' })).reason, 'not-office-location');
  assert.equal(distanceToLocations(point(0, 0), [location({ coordinates: undefined })]), undefined);
});

test('multiple optional offices choose nearest once, with a stable location-ID tie break', () => {
  const result = distanceToLocations(point(0, 0), [
    location({ id: 'far-office', coordinates: point(0, 10) }),
    location({ id: 'z-office', coordinates: point(0, 1) }),
    location({ id: 'a-office', coordinates: point(0, 1) }),
  ]);
  assert.equal(result?.locationId, 'a-office');
  assert.ok(Math.abs(result!.km - 111.19508) < 0.001);
  assert.equal(result?.estimated, false);
});

test('default semantic colors express origin priority independently of state/private ownership', () => {
  for (const [code, kind, expected] of [
    ['SE', 'private', 'nordic'], ['DE', 'private', 'de-fr'], ['FR', 'private', 'de-fr'],
    ['NL', 'private', 'europe'], ['US', 'state', 'us'], ['SG', 'private', 'sg-hk'],
    ['HK', 'state', 'sg-hk'], ['CN', 'state', 'domestic-state'], ['CN', 'private', 'domestic-private'],
    ['JP', 'private', 'other-known'],
  ] as const) {
    const resolved = resolveCompanyColor(company(code, kind));
    assert.equal(resolved.ruleId, expected);
    assert.equal(resolved.classification.jurisdictions[0], code);
  }
  assert.equal(resolveCompanyColor(company('US', 'state')).ownershipLabel, '国有控制');
});

test('unverified, conflicting, empty and incomplete control facts never turn into private/foreign guesses', () => {
  const unverified = company('US');
  unverified.ultimateControllers.verification = 'unverified';
  assert.equal(resolveCompanyColor(unverified).ruleId, 'unverified');
  const conflicting = company('DE');
  conflicting.ultimateControllers.verification = 'conflicting';
  assert.equal(resolveCompanyColor(conflicting).ruleId, 'conflicting');
  const unknown = company();
  assert.equal(resolveCompanyColor(unknown).reason, 'no-rule');
  const noEvidence = company('US');
  noEvidence.ultimateControllers.evidence = [];
  assert.equal(resolveCompanyColor(noEvidence).reason, 'controllers-evidence-missing');
  const empty = company('US');
  empty.ultimateControllers.value = [];
  assert.equal(resolveCompanyColor(empty).ruleId, 'unknown');
});

test('multiple controllers preserve joint control instead of selecting the first jurisdiction', () => {
  const joint = company('DE');
  joint.ultimateControllers.value.push({ name: 'Second synthetic controller', jurisdictionCode: 'CN', kind: 'state' });
  const resolved = resolveCompanyColor(joint);
  assert.equal(resolved.ruleId, 'joint');
  assert.deepEqual(resolved.classification.jurisdictions, ['CN', 'DE']);
  assert.equal(resolved.classification.jointControl, true);
  assert.equal(classifyCompany(joint).ownership, 'joint');
  joint.ultimateControllers.value[1]!.jurisdictionCode = undefined;
  const noJointRule = getDefaultCompanyColorConfig();
  noJointRule.rules = noJointRule.rules.filter((rule) => rule.id !== 'joint');
  assert.equal(resolveCompanyColor(joint, noJointRule).reason, 'no-rule');
});

test('rules/group membership and origin-versus-state priority can be edited and round-tripped as JSON', () => {
  const config = getDefaultCompanyColorConfig();
  config.rules.push({ id: 'all-state', ownership: 'state', priority: 200, color: '#F0C123', label: '所有国有控制' });
  assert.equal(resolveCompanyColor(company('US', 'state'), config).ruleId, 'all-state');
  assert.deepEqual(importCompanyColorConfig(exportCompanyColorConfig(config)), config);
  assert.equal(resolveCompanyColor(company('US', 'state')).ruleId, 'us');
  const another = getDefaultCompanyColorConfig();
  another.groups.find((group) => group.id === 'nordic')!.jurisdictions.push('DE');
  assert.equal(resolveCompanyColor(company('DE'), another).ruleId, 'nordic');
});

test('color imports reject executable expressions, arbitrary CSS, unknown groups and duplicate IDs', () => {
  const config = getDefaultCompanyColorConfig();
  assert.equal(CompanyColorConfigSchema.safeParse({ ...config, css: 'body{}' }).success, false);
  assert.equal(CompanyColorConfigSchema.safeParse({ ...config, defaultColor: 'url(https://example.test)' }).success, false);
  const badGroup = structuredClone(config);
  badGroup.rules[0]!.group = 'missing-group';
  assert.equal(CompanyColorConfigSchema.safeParse(badGroup).success, false);
  const duplicate = structuredClone(config);
  duplicate.rules.push(duplicate.rules[0]!);
  assert.equal(CompanyColorConfigSchema.safeParse(duplicate).success, false);
  assert.throws(() => importCompanyColorConfig('{not valid json}'));
});

test('evidenced manual control corrections survive source refresh without mutating original evidence', () => {
  const source = company('US');
  source.manualOverrides.push({
    id: 'manual-correction', field: 'ultimateControllers', reason: 'Synthetic verified correction',
    at: now, basedOnRevision: 0,
    value: { ...structuredClone(source.ultimateControllers), value: [{ name: 'Corrected controller', jurisdictionCode: 'DE', kind: 'private' }], revision: 1 },
  });
  source.ultimateControllers.revision = 2;
  assert.equal(resolveCompanyColor(source).ruleId, 'de-fr');
  assert.equal(effectiveCompanyControllers(source).value[0]!.jurisdictionCode, 'DE');
  assert.equal(source.ultimateControllers.value[0]!.jurisdictionCode, 'US');
  source.manualOverrides.push({
    id: 'future-correction', field: 'ultimateControllers', reason: 'Invalid future base', at: '2026-10-18T13:00:00.000Z', basedOnRevision: 99,
    value: { ...structuredClone(source.ultimateControllers), value: [{ name: 'Future controller', jurisdictionCode: 'CN', kind: 'state' }], revision: 100 },
  });
  assert.equal(resolveCompanyColor(source).ruleId, 'de-fr');
});

test('manual correction chains can explicitly return a formerly verified control origin to unverified', () => {
  const source = company('US');
  source.manualOverrides.push({
    id: 'first-correction', field: 'ultimateControllers', reason: 'First correction', at: now, basedOnRevision: 0,
    value: { ...structuredClone(source.ultimateControllers), revision: 1 },
  }, {
    id: 'second-correction', field: 'ultimateControllers', reason: 'Evidence is inconclusive', at: '2026-10-18T13:00:00.000Z', basedOnRevision: 1,
    value: { ...structuredClone(source.ultimateControllers), verification: 'unverified', revision: 2 },
  });
  assert.equal(resolveCompanyColor(source).ruleId, 'unverified');
  assert.equal(effectiveCompanyControllers(source).revision, 2);
  assert.equal(source.ultimateControllers.verification, 'verified');
});

test('salary tool output schemas round-trip all statuses and reject fabricated comparison metadata', () => {
  const outputs = [
    normalizeCompensation(compensation({ locationIds: ['synthetic-office'] }), { now }),
    normalizeCompensation(compensation({ currency: 'USD' }), { now, fx }),
    normalizeCompensation(compensation({ currency: 'USD' }), { now }),
    normalizeCompensation(compensation({ period: 'month' }), { now, allowMonthlyEstimate: true }),
    normalizeCompensation(compensation({ tax: 'unknown' }), { now }),
  ];
  for (const output of outputs) {
    assert.deepEqual(NormalizedCompensationSchema.parse(JSON.parse(JSON.stringify(output))), output);
  }
  const comparable = outputs[0]!;
  assert.deepEqual(comparable.locationIds, ['synthetic-office']);
  assert.equal(NormalizedCompensationSchema.safeParse({ ...comparable, locationIds: ['synthetic-office', 'synthetic-office'] }).success, false);
  assert.equal(NormalizedCompensationSchema.safeParse({ ...comparable, cnyAnnual: { currency: 'CNY', min: -1 } }).success, false);
  assert.equal(NormalizedCompensationSchema.safeParse({ ...comparable, reason: 'unknown-tax-basis' }).success, false);
  assert.equal(NormalizedCompensationSchema.safeParse({ ...comparable, verification: 'conflicting' }).success, false);
  assert.equal(NormalizedCompensationSchema.safeParse({ ...outputs[1]!, fx: undefined }).success, false);
  assert.equal(NormalizedCompensationSchema.safeParse({ ...outputs[3]!, estimated: false }).success, false);
  assert.equal(NormalizedCompensationSchema.safeParse({ ...comparable, executable: 'unexpected' }).success, false);
});

test('distance and color tool outputs reject impossible distances and promotion of unverified classifications', () => {
  const cityDistance = distanceToLocations(point(0, 0), [location({ precision: 'city' })], { allowCityEstimate: true })!;
  assert.deepEqual(LocationDistanceSchema.parse(JSON.parse(JSON.stringify(cityDistance))), cityDistance);
  assert.equal(LocationDistanceSchema.safeParse({ ...cityDistance, estimated: false }).success, false);
  assert.equal(LocationDistanceSchema.safeParse({ ...cityDistance, km: 40000 }).success, false);
  assert.equal(LocationDistanceSchema.safeParse({ ...cityDistance, precision: 'country' }).success, false);
  const verified = resolveCompanyColor(company('DE'));
  assert.deepEqual(CompanyColorMatchSchema.parse(JSON.parse(JSON.stringify(verified))), verified);
  const unverifiedCompany = company('US');
  unverifiedCompany.ultimateControllers.verification = 'unverified';
  const unverified = resolveCompanyColor(unverifiedCompany);
  assert.deepEqual(CompanyColorMatchSchema.parse(unverified), unverified);
  assert.equal(CompanyColorMatchSchema.safeParse({ ...unverified, reason: 'matched-rule' }).success, false);
  assert.equal(CompanyColorMatchSchema.safeParse({ ...unverified, classification: { ...unverified.classification, jurisdictions: ['US'] } }).success, false);
  assert.equal(CompanyColorMatchSchema.safeParse({ ...verified, color: 'var(--accent)' }).success, false);
});
