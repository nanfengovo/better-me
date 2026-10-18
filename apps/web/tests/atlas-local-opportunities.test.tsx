import assert from "node:assert/strict";
import test from "node:test";
import { AtlasDatasetSchema, queryJobs } from "@better-me/opportunities";
import { createOpportunity, type Opportunity, type OpportunityLibrary } from "../src/lib/opportunities.ts";
import { LocalOpportunityProjectionError, projectLocalOpportunities } from "../src/components/atlas/local-opportunities.ts";
import { getAtlasDataCoverage } from "../src/components/atlas/coverage.ts";

const CAPTURED = "2026-10-17T10:11:12.000Z";
const UPDATED = "2026-10-18T12:00:00.000Z";
const PRIVATE = "synthetic-private-contact-material-key-must-stay-in-library";
function fixture(): OpportunityLibrary & { privateData: string } {
  const platforms = [
    ["51JOB", "https://jobs.51job.com/shanghai/123456789.html"],
    ["BOSS直聘", "https://www.zhipin.com/job_detail/synthetic42.html"],
    ["猎聘", "https://www.liepin.com/job/196543210.shtml"],
    ["LinkedIn", "https://www.linkedin.com/jobs/view/1234567890"],
    ["GitHub 招聘清单", "https://github.com/synthetic/jobs/issues/42"],
    ["任意已核对官网来源", "https://careers.example.test/jobs/42"],
  ];
  const jobs = platforms.map(([platform, url], index): Opportunity => {
    const job = createOpportunity({ company: `合成公开雇主 ${index}`, title: `合成工程师 ${index}`, description: `合成已收藏岗位正文 ${index}`,
      sourcePlatform: platform!, sourceUrl: url!, discoveryUrl: index === 3 ? "https://github.com/synthetic/jobs" : "", collectedAt: CAPTURED,
      location: { country: "中国", region: "上海", city: "上海" }, salaryText: "15-25K，薪数未提供",
      ...(index === 0 ? { sourcePublishedText: "2026年10月16日发布", sourcePublishedAt: "2026-10-16T08:00:00+08:00", sourceUpdatedAt: "2026-10-17T09:00:00+08:00" } : {}),
    }, CAPTURED);
    job.id = `synthetic-local-opportunity-${index}`;
    job.updatedAt = UPDATED;
    job.application.notes = PRIVATE;
    job.application.contactDetails = PRIVATE;
    job.materials = [{ id: `material-${index}`, resumeViewId: "private-resume", resumeName: PRIVATE, resumeUpdatedAt: CAPTURED, locale: "zh", markdown: PRIVATE, createdAt: CAPTURED }];
    return job;
  });
  return { schemaVersion: 1, revision: 17, updatedAt: UPDATED, jobs, privateData: PRIVATE };
}

test("current-library projection includes four platforms and arbitrary reviewed sources without storage, migration or private fields", async () => {
  const library = fixture(); const original = JSON.stringify(library);
  const projected = await projectLocalOpportunities(library);
  assert.deepEqual(Object.keys(projected).sort(), ["dataset", "warnings"]);
  assert.equal(projected.dataset.revision, library.revision);
  assert.equal(projected.dataset.jobs.length, 6);
  assert.deepEqual(projected.dataset.sources.map((source) => source.attribution.label).sort(), library.jobs.map((job) => job.sourcePlatform).sort());
  assert.equal(AtlasDatasetSchema.safeParse(projected.dataset).success, true);
  assert.equal(JSON.stringify(projected).includes(PRIVATE), false);
  assert.equal(JSON.stringify(projected).includes("privateBindings"), false);
  assert.equal(JSON.stringify(projected).includes("sourceFingerprint"), false);
  assert.equal(JSON.stringify(library), original);
  const result = await queryJobs(projected.dataset, {}, { now: UPDATED });
  assert.equal(result.totalJobs, 6); assert.equal(result.mapBuckets.length, 0);
  assert.equal(result.unlocatedJobs, 6);
  for (const location of projected.dataset.locations) { assert.equal(location.coordinates, undefined); assert.equal(location.precision, "unknown"); }
  for (const compensation of projected.dataset.compensations) { assert.equal(compensation.currency, undefined); assert.equal(compensation.period, "unknown"); }
});

test("capture, publication and platform update remain separate and a missing publication is never invented", async () => {
  const library = fixture(); const { dataset } = await projectLocalOpportunities(library);
  const first = dataset.observations[0]!;
  assert.equal(first.fetchedAt, CAPTURED);
  assert.equal(first.sourcePublishedRaw, library.jobs[0]!.sourcePublishedText);
  assert.equal(first.sourcePublishedAt, "2026-10-16T00:00:00.000Z");
  assert.equal(first.sourceUpdatedAt, "2026-10-17T01:00:00.000Z");
  assert.equal(dataset.snapshots[0]!.createdAt, CAPTURED);
  assert.equal(dataset.jobs[0]!.updatedAt, UPDATED);
  for (const observation of dataset.observations.slice(1)) {
    assert.equal(observation.fetchedAt, CAPTURED);
    assert.equal(observation.sourcePublishedAt, undefined);
    assert.equal(observation.sourcePublishedRaw, undefined);
    assert.equal(observation.availability, "unknown");
  }
});

test("explicit saved country names support real country filtering without fabricating salary, control or coordinates", async () => {
  const library = fixture();
  library.jobs[1]!.location.country = "香港";
  library.jobs[2]!.location.country = "";
  library.jobs[3]!.location.country = "USA";
  library.jobs[4]!.location.country = "Taiwan";
  library.jobs[5]!.location.country = "Macao";
  const before = JSON.stringify(library);
  const { dataset } = await projectLocalOpportunities(library);
  assert.deepEqual(dataset.locations.map((location) => location.countryCode), ["CN", "HK", undefined, "US", "TW", "MO"]);
  const coverage = getAtlasDataCoverage(dataset, { now: UPDATED, allowCityEstimate: true });
  assert.equal(coverage.country.jobs, 5); assert.deepEqual(coverage.country.values, ["CN", "HK", "MO", "TW", "US"]);
  assert.equal(coverage.source.jobs, 6); assert.equal(coverage.source.options.length, 6);
  assert.equal(coverage.salary.rawJobs, 6); assert.equal(coverage.salary.supported, false); assert.equal(coverage.salary.sortSupported, false);
  assert.equal(coverage.map.supported, false); assert.equal(coverage.distance.supported, false);
  assert.equal(coverage.ownership.supported, false); assert.equal(coverage.controller.supported, false);
  const china = await queryJobs(dataset, { workRegionIds: ["CN"] }, { now: UPDATED });
  assert.equal(china.totalJobs, 1); assert.equal(china.items[0]!.job.title.value, library.jobs[0]!.title);
  const domestic = await queryJobs(dataset, { market: "domestic", includeUnknownLocations: false }, { now: UPDATED });
  assert.equal(domestic.totalJobs, 4, "CN, HK, MO and TW stay separate while participating in the configured domestic scope");
  const overseas = await queryJobs(dataset, { market: "overseas", includeUnknownLocations: false }, { now: UPDATED });
  assert.equal(overseas.totalJobs, 1); assert.equal(overseas.items[0]!.locations[0]!.countryCode, "US");
  assert.equal(JSON.stringify(library), before);
});

test("explicit selected IDs project only their public reference graph and remap warning indices", async () => {
  const library = fixture(); const selected = [library.jobs[3]!.id];
  const result = await projectLocalOpportunities(library, { selectedOpportunityIds: selected });
  assert.equal(result.dataset.jobs.length, 1); assert.equal(result.dataset.sources.length, 1);
  assert.equal(result.dataset.sources[0]!.attribution.label, "LinkedIn");
  assert.equal(result.dataset.listings[0]!.canonicalUrl, library.jobs[3]!.sourceUrl);
  assert.deepEqual(result.dataset.listings[0]!.discoveredViaUrls, [library.jobs[3]!.discoveryUrl]);
  for (const name of ["companies", "locations", "compensations", "listings", "observations", "snapshots"] as const) assert.equal(result.dataset[name].length, 1);
  assert.ok(result.warnings.every((warning) => warning.jobIndex === undefined || warning.jobIndex === 0));
  const empty = await projectLocalOpportunities(library, { selectedOpportunityIds: [] });
  assert.equal(empty.dataset.jobs.length, 0); assert.equal(empty.dataset.sources.length, 0); assert.equal(empty.dataset.observations.length, 0);
  for (const selection of [["missing-id"], [selected[0]!, selected[0]!], [""], Array(2001).fill(selected[0])]) {
    await assert.rejects(projectLocalOpportunities(library, { selectedOpportunityIds: selection }), LocalOpportunityProjectionError);
  }
});

test("projection captures the supplied snapshot and selection before async hashing while repeat IDs stay stable", async () => {
  const library = fixture(); const selection = [library.jobs[1]!.id];
  const original = structuredClone(library);
  const pending = projectLocalOpportunities(library, { selectedOpportunityIds: selection });
  library.jobs[1]!.description = "changed concurrently"; library.revision++; selection[0] = library.jobs[4]!.id;
  const projected = await pending;
  assert.equal(projected.dataset.revision, original.revision);
  assert.equal(projected.dataset.jobs[0]!.description, original.jobs[1]!.description);
  assert.equal(projected.dataset.sources[0]!.attribution.label, "BOSS直聘");
  const repeat = await projectLocalOpportunities(original, { selectedOpportunityIds: [original.jobs[1]!.id] });
  assert.deepEqual(projected, repeat);
});

test("cancellation and unsafe or invalid input reject without altering the supplied opportunity library", async () => {
  const library = fixture(); const original = JSON.stringify(library);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(projectLocalOpportunities(library, { signal: abort.signal }), { name: "AbortError" });
  const laterAbort = new AbortController(); const pending = projectLocalOpportunities(library, { signal: laterAbort.signal }); laterAbort.abort();
  await assert.rejects(pending, { name: "AbortError" });
  const unsafe = structuredClone(library); unsafe.jobs[0]!.sourceUrl = "http://127.0.0.1/private";
  await assert.rejects(projectLocalOpportunities(unsafe));
  let getterCalls = 0; const imported = { ...library, get unexpectedPrivateData() { getterCalls++; return PRIVATE; } };
  await assert.rejects(projectLocalOpportunities(imported)); assert.equal(getterCalls, 0);
  assert.equal(JSON.stringify(library), original);
});
