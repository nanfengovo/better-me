import assert from "node:assert/strict";
import test from "node:test";
import { queryJobs, type FxSnapshot } from "@better-me/opportunities";
import { createAtlasDemo } from "../src/components/atlas/demo.ts";
import { getAtlasDataCoverage } from "../src/components/atlas/coverage.ts";

const NOW = "2026-10-18T12:00:00.000Z";
const fx: FxSnapshot = { id: "fixture-fx", provider: "synthetic fixture", date: "2026-10-18", ratesToCny: { USD: 7, CNY: 1 } };

test("empty and absent snapshots disable every data-dependent capability without substituting demo jobs", () => {
  for (const data of [null, undefined, { ...createAtlasDemo(), jobs: [] }]) {
    const coverage = getAtlasDataCoverage(data, { now: NOW });
    assert.equal(coverage.totalJobs, 0);
    for (const name of ["salary", "map", "distance", "country", "region", "ownership", "controller", "source"] as const) {
      assert.equal(coverage[name].supported, false, name); assert.equal(coverage[name].jobs, 0); assert.equal(coverage[name].missingJobs, 0);
    }
    assert.equal(coverage.distance.ready, false); assert.deepEqual(coverage.source.options, []);
  }
});

test("coverage is snapshot-wide, counts jobs once, respects actual classification and does not mutate data", () => {
  const data = createAtlasDemo(), before = JSON.stringify(data);
  // An unused source definition is not evidence of an indexed job from that source.
  data.sources.push({ ...data.sources[0]!, sourceId: "unused-source" });
  const coverage = getAtlasDataCoverage(data, { now: NOW });
  assert.equal(coverage.totalJobs, 22); assert.equal(coverage.salary.jobs, 22); assert.equal(coverage.salary.sortJobs, 22);
  assert.equal(coverage.map.jobs, 22); assert.equal(coverage.distance.jobs, 0, "city estimates require opt-in");
  assert.equal(coverage.country.jobs, 22); assert.equal(coverage.region.jobs, 22);
  assert.equal(coverage.ownership.jobs, 20); assert.equal(coverage.controller.jobs, 20);
  assert.equal(coverage.source.options.length, 1); assert.equal(coverage.source.options[0]!.jobs, 22);
  const enabledDistance = getAtlasDataCoverage(data, { now: NOW, allowCityEstimate: true });
  assert.equal(enabledDistance.distance.jobs, 22); assert.equal(enabledDistance.distance.anchorRequired, true); assert.equal(enabledDistance.distance.ready, false);
  const withAnchor = getAtlasDataCoverage(data, { now: NOW, allowCityEstimate: true, anchor: { latitude: 0, longitude: 0, coordinateSystem: "WGS84" } });
  assert.equal(withAnchor.distance.ready, true); assert.equal(withAnchor.distance.estimatedJobs, 22);
  data.sources.pop(); assert.equal(JSON.stringify(data), before);
});

test("salary support requires actual gross annual evidence and valid FX; raw strings never enable sorting", async () => {
  const data = createAtlasDemo();
  const [raw, foreign, ambiguous, ceilingOnly] = data.jobs.slice(0, 4).map((job) => data.compensations.find((compensation) => job.compensationIds.includes(compensation.id))!);
  Object.assign(raw!, { currency: undefined, min: undefined, max: undefined, tax: "unknown", period: "unknown", kind: "unknown", raw: "15-25K, months and tax unknown" });
  Object.assign(foreign!, { currency: "USD" });
  const second = { ...ambiguous!, id: "different-salary", min: ambiguous!.min! + 1 };
  data.compensations.push(second); data.jobs[2]!.compensationIds.push(second.id);
  ceilingOnly!.min = undefined;
  const unavailable = getAtlasDataCoverage(data, { now: NOW });
  assert.equal(unavailable.salary.rawJobs, 22); assert.equal(unavailable.salary.jobs, 19, "the ceiling and 18 unchanged jobs are comparable without FX");
  assert.equal(unavailable.salary.sortJobs, 18);
  assert.equal(unavailable.salary.ambiguousJobs, 1); assert.equal(unavailable.salary.fxBlockedJobs, 1);
  assert.equal(unavailable.salary.reasons["fx-missing"], 1);
  const current = getAtlasDataCoverage(data, { now: NOW, fx });
  assert.equal(current.salary.jobs, 20); assert.equal(current.salary.sortJobs, 19); assert.equal(current.salary.fxBlockedJobs, 0);
  const stale = getAtlasDataCoverage(data, { now: NOW, fx: { ...fx, date: "2026-08-01" } });
  assert.equal(stale.salary.reasons["fx-stale"], 1); assert.equal(stale.salary.sortJobs, 18);
  const future = getAtlasDataCoverage(data, { now: NOW, fx: { ...fx, date: "2026-10-19" } });
  assert.equal(future.salary.reasons["fx-future"], 1);
  const maxMetric = getAtlasDataCoverage(data, { now: NOW, salaryMetric: "max" });
  assert.equal(maxMetric.salary.sortJobs, 19);
  const actual = await queryJobs(data, { statuses: ["open", "closed", "unknown"], salary: { metric: "min", includeEstimates: true }, page: { limit: 200 } }, { now: NOW, fx });
  assert.equal(current.salary.sortJobs, actual.items.filter((item) => item.salaryCny !== undefined).length);
});

test("monthly estimates, coordinate precision and unverified controllers stay explicit", () => {
  const data = createAtlasDemo();
  const salary = data.compensations.find((value) => data.jobs[0]!.compensationIds.includes(value.id))!;
  salary.period = "month";
  const strict = getAtlasDataCoverage(data, { now: NOW, includeEstimates: false });
  assert.equal(strict.salary.jobs, 21); assert.equal(strict.salary.reasons["missing-months-per-year"], 1);
  const estimated = getAtlasDataCoverage(data, { now: NOW, includeEstimates: true });
  assert.equal(estimated.salary.estimatedJobs, 1);
  const firstLocation = data.locations.find((value) => data.jobs[0]!.locationIds.includes(value.id))!;
  firstLocation.precision = "address";
  const secondLocation = data.locations.find((value) => data.jobs[1]!.locationIds.includes(value.id))!;
  secondLocation.kind = "unknown";
  const company = data.companies.find((value) => value.id === data.jobs[0]!.companyId)!;
  company.ultimateControllers.verification = "unverified";
  const coverage = getAtlasDataCoverage(data, { now: NOW });
  assert.equal(coverage.distance.jobs, 1); assert.equal(coverage.distance.preciseJobs, 1);
  assert.equal(coverage.ownership.jobs, 18); assert.ok(!coverage.controller.values.includes("SE"));
});

test("region suggestions honor the selected country without dropping the snapshot's country choices", async () => {
  const data = createAtlasDemo();
  const [us, au] = data.locations;
  Object.assign(us!, { countryCode: "US", city: "Springfield", regionId: undefined });
  Object.assign(au!, { countryCode: "AU", city: "Springfield", regionId: undefined });
  const all = getAtlasDataCoverage(data, { now: NOW });
  assert.equal(all.region.options.find((option) => option.id === "Springfield")!.jobs, 2);
  const selected = getAtlasDataCoverage(data, { now: NOW, workCountryCodes: ["US"] });
  assert.deepEqual(selected.country.values, all.country.values);
  assert.ok(selected.country.values.includes("AU"));
  const springfield = selected.region.options.find((option) => option.id === "Springfield")!;
  assert.equal(springfield.jobs, 1); assert.deepEqual(springfield.countryCodes, ["US"]);
  const queried = await queryJobs(data, { workCountryCodes: ["US"], workRegionIds: [springfield.id] }, { now: NOW });
  assert.equal(queried.totalJobs, springfield.jobs);
  const nonexistent = getAtlasDataCoverage(data, { now: NOW, workCountryCodes: ["ZZ"] });
  assert.deepEqual(nonexistent.region.options, []);
  assert.equal(nonexistent.region.supported, false);
  assert.deepEqual(nonexistent.country.values, all.country.values);
});

test("a province identifier never borrows its first city's label and evidenced cities remain separately selectable", async () => {
  const data = createAtlasDemo();
  const before = JSON.stringify(data);
  const coverage = getAtlasDataCoverage(data, { now: NOW, workCountryCodes: ["CN"] });
  const province = coverage.region.options.find((option) => option.id === "CN-GD")!;
  assert.equal(province.label, "CN-GD"); assert.equal(province.jobs, 2);
  const shenzhen = coverage.region.options.find((option) => option.id === "深圳")!;
  const guangzhou = coverage.region.options.find((option) => option.id === "广州")!;
  assert.equal(shenzhen.label, "深圳"); assert.equal(shenzhen.jobs, 1);
  assert.equal(guangzhou.label, "广州"); assert.equal(guangzhou.jobs, 1);
  assert.equal((await queryJobs(data, { workCountryCodes: ["CN"], workRegionIds: [shenzhen.id] }, { now: NOW })).totalJobs, 1);
  assert.equal((await queryJobs(data, { workCountryCodes: ["CN"], workRegionIds: [province.id] }, { now: NOW })).totalJobs, 2);
  assert.equal(JSON.stringify(data), before);
});

test("manual controller corrections and partially evidenced jurisdictions match query filtering", async () => {
  const data = createAtlasDemo();
  const company = data.companies.find((value) => value.id === data.jobs[0]!.companyId)!;
  company.manualOverrides.push({ id: "manual-controller-correction", field: "ultimateControllers", basedOnRevision: 0, at: NOW, reason: "Synthetic correction",
    value: { ...company.ultimateControllers, value: [{ name: "Synthetic UK controller", jurisdictionCode: "GB", kind: "private" }], method: "manual", verification: "verified", revision: 1 } });
  const domestic = data.companies.find((value) => value.id === data.jobs[1]!.companyId)!;
  domestic.ultimateControllers.value.push({ name: "Synthetic joint controller without a country", kind: "joint" });
  const coverage = getAtlasDataCoverage(data, { now: NOW });
  assert.equal(coverage.controller.jobs, 20); assert.equal(coverage.controller.completeJobs, 18);
  assert.ok(coverage.controller.values.includes("GB")); assert.ok(!coverage.controller.values.includes("SE"));
  assert.ok(coverage.ownership.values.includes("joint"));
  const corrected = await queryJobs(data, { controllerJurisdictions: ["GB"], page: { limit: 200 } }, { now: NOW });
  assert.equal(corrected.totalJobs, 3, "two corrected jobs plus the existing UK company");
});
