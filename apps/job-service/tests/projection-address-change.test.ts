import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CanonicalJob, SourceDefinition } from "@better-me/opportunities";
import type { SourceAdapterContext } from "@better-me/source-adapters";
import { ashbyAdapter } from "../../../packages/source-adapters/src/adapters/ashby.js";
import { emptyDelta, projectSourcePage } from "../src/projection.js";
import { openJobRepository, RepositoryError, type JobRepository } from "../src/repository.js";

const AT = "2026-10-19T00:00:00.000Z", actorScope = "synthetic-address-owner";
const options = (idempotencyKey: string, expectedRevision: number) => ({ actorScope, idempotencyKey, expectedRevision });
function source(id: string): SourceDefinition {
  return { sourceId: id, name: `Synthetic Ashby source ${id}`, adapterId: "ashby", adapterVersion: "1", capabilities: ["list-jobs"],
    runtime: ["local-service"], entityType: "job-posting", enabled: true, status: "active", remoteFilters: [],
    options: { boardToken: id, companyName: "Synthetic employer" },
    entryUrl: `https://api.ashbyhq.com/posting-api/job-board/${id}?includeCompensation=true`,
    endpointPolicy: { allowedHosts: ["api.ashbyhq.com"], allowedPathPrefixes: [`/posting-api/job-board/${id}`], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: "Synthetic official source", usage: "metadata", requiresAttribution: true },
    refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 10, maxPages: 1, requestsPerMinute: 30 } };
}
const primary = source("synthetic-address-primary"), secondary = source("synthetic-address-secondary");
function posting(streetAddress?: string, postalCode?: string) {
  return { id: "synthetic-engineer", title: "Synthetic C# engineer", jobUrl: `https://jobs.ashbyhq.com/${primary.sourceId}/synthetic-engineer`,
    descriptionPlain: "Synthetic duties: develop C# services. This JD must stay unchanged.", workplaceType: "OnSite", isRemote: false,
    publishedAt: "2026-10-17T00:00:00Z", location: "Unchanged source office label",
    address: { postalAddress: { addressCountry: "US", addressRegion: "Massachusetts", addressLocality: "Boston",
      ...(streetAddress ? { streetAddress } : {}), ...(postalCode ? { postalCode } : {}) } },
    compensation: { compensationTierSummary: "Synthetic USD 100000 base; tax basis undisclosed" } };
}
function facts(job: CanonicalJob) {
  const { locationIds: _locations, revision: _revision, updatedAt: _updated, ...retained } = job;
  return retained;
}
async function fixture(work: (repo: JobRepository, databasePath: string, now: () => string, advance: () => void) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "better-me-address-change-")), path = join(dir, "jobs.sqlite");
  let time = Date.parse(AT); const now = () => new Date(time).toISOString();
  const repo = openJobRepository(path, { now });
  try {
    const seed = emptyDelta(); seed.sources = [primary, secondary];
    await repo.importSnapshot(seed, options("seed-sources", 0));
    await work(repo, path, now, () => { time += 1000; });
  } finally { repo.close(); await rm(dir, { recursive: true, force: true }); }
}
async function ingest(repo: JobRepository, configured: SourceDefinition, value: ReturnType<typeof posting>, key: string, at: string) {
  const context: SourceAdapterContext = { requestId: key, actorScope, observedAt: at,
    signal: new AbortController().signal, budget: { requests: 1, bytes: 100_000, timeoutMs: 5000 },
    consumeRequests() {}, consumeBytes() {}, throwIfCancelled() {} };
  const page = await ashbyAdapter.list({ source: configured, scope: { roles: ["C#"], regions: [], companyNames: [] }, context,
    transport: { async request({ url }) {
      assert.equal(url, configured.entryUrl, "the test has no network and reads exactly its synthetic board response");
      return { url, status: 200, headers: {}, text: JSON.stringify({ jobs: [value] }) };
    } } });
  const before = await repo.readProjectionSnapshot();
  const projection = await projectSourcePage(before, configured, page, key);
  const writeOptions = options(key, before.revision), receipt = await repo.importSnapshot(projection.delta, writeOptions);
  return { projection, receipt, writeOptions, page };
}
async function confirm(repo: JobRepository, jobId: string, locationId: string, key: string) {
  const data = await repo.readSnapshot(), location = data.locations.find(value => value.id === locationId)!;
  const input = { jobId, locationId, expectedRevision: data.revision, reason: "Synthetic explicit address and WGS84 office review",
    proposal: { basis: "manual-user-confirmation" as const, countryCode: "US", formattedAddress: `Boston ${location.streetAddress}`,
      streetAddress: location.streetAddress!, ...(location.postalCode ? { postalCode: location.postalCode } : {}),
      coordinates: { latitude: 42.3, longitude: -71.1, coordinateSystem: "WGS84" as const },
      evidenceUrl: `https://jobs.ashbyhq.com/${primary.sourceId}/synthetic-engineer`, coordinateMeaning: "building" as const } };
  const preview = await repo.previewOfficeConfirmation(input);
  return repo.confirmOfficeAddress({ ...input, previewFingerprint: preview.previewFingerprint, reviewed: true }, options(key, data.revision));
}

test("same-label Ashby moves preserve other source contributions and permanently invalidate old office decisions through A to B to A", async () => fixture(async (repo, path, now, advance) => {
  advance(); const initialImport = await ingest(repo, primary, posting("Synthetic Road A 10", "00123"), "source-a-first", now());
  const first = await repo.readSnapshot(), firstJob = first.jobs[0]!, locationA = first.locations[0]!;
  assert.equal(initialImport.page.records[0]!.locations[0]!.raw, "Unchanged source office label");
  assert.equal(locationA.postalCode, "00123");
  const otherPosting = posting("Synthetic Other Office 30", "00789");
  otherPosting.id = "synthetic-other-engineer"; otherPosting.jobUrl = `https://jobs.ashbyhq.com/${secondary.sourceId}/${otherPosting.id}`;
  advance(); await ingest(repo, secondary, otherPosting, "source-other", now());
  let data = await repo.readSnapshot(); const otherJob = data.jobs.find(value => value.id !== firstJob.id)!;
  const otherLocationId = otherJob.locationIds[0]!;
  const merged = await repo.mergeJobs({ targetJobId: firstJob.id, sourceJobId: otherJob.id, reason: "Synthetic reviewed same requisition", companyIdentityConfirmed: true }, options("merge-sources", data.revision));
  advance(); const officeA = await confirm(repo, firstJob.id, locationA.id, "confirm-a");
  advance(); const otherOffice = await confirm(repo, firstJob.id, otherLocationId, "confirm-other");
  data = await repo.readSnapshot(); const beforeMove = data, beforeJob = data.jobs[0]!;
  const otherLocation = data.locations.find(value => value.id === otherLocationId)!;
  assert.equal(data.jobs.length, 1); assert.equal(beforeJob.listingIds.length, 2);
  assert.equal(otherLocation.officeResolution?.decisionId, otherOffice.decisionId);

  advance(); const moved = await ingest(repo, primary, posting("Synthetic Road B 20"), "source-b", now());
  data = await repo.readSnapshot(); const movedJob = data.jobs[0]!;
  const primaryListing = data.listings.find(value => value.sourceId === primary.sourceId)!;
  const locationB = data.locations.find(value => value.id === primaryListing.locationIds![0])!;
  assert.notEqual(locationB.id, locationA.id); assert.equal(locationB.raw, locationA.raw); assert.equal(locationB.city, locationA.city);
  assert.equal(locationB.streetAddress, "Synthetic Road B 20"); assert.equal(locationB.postalCode, undefined, "moving streets cannot borrow the previous office postcode");
  assert.equal(locationB.coordinates, undefined); assert.equal(locationB.officeResolution, undefined);
  assert.deepEqual(data.locations.find(value => value.id === otherLocationId), otherLocation);
  assert.deepEqual(new Set(movedJob.locationIds), new Set([locationB.id, otherLocationId]));
  assert.deepEqual(facts(movedJob), facts(beforeJob));
  assert.equal(data.revision, beforeMove.revision + 1); assert.equal(movedJob.revision, beforeJob.revision + 1);
  assert.equal(moved.receipt.counts.newJobs, 0); assert.equal(moved.receipt.counts.updatedJobs, 1);
  assert.equal(moved.receipt.counts.newListings, 0); assert.equal(moved.receipt.counts.newSnapshots, 0);
  assert.deepEqual(data.snapshots, beforeMove.snapshots); assert.deepEqual(data.compensations, beforeMove.compensations);
  const invalidations = (await repo.backup()).officeDecisions.filter(value => value.kind === "invalidate");
  assert.equal(invalidations.length, 1); assert.equal(invalidations[0]!.revision, moved.receipt.revision);
  if (invalidations[0]!.kind === "invalidate") assert.deepEqual(invalidations[0]!.targetDecisionIds, [officeA.decisionId]);
  assert.deepEqual(await repo.importSnapshot(moved.projection.delta, moved.writeOptions), moved.receipt);
  assert.equal((await repo.readSnapshot()).revision, moved.receipt.revision, "retry returns the durable receipt without repeating source invalidation");
  await assert.rejects(repo.importSnapshot(moved.projection.delta, options("stale-move", beforeMove.revision)), error => error instanceof RepositoryError && error.code === "stale-version");

  advance(); const returned = await ingest(repo, primary, posting("Synthetic Road A 10", "00123"), "source-a-return", now());
  data = await repo.readSnapshot(); const returnedListing = data.listings.find(value => value.sourceId === primary.sourceId)!;
  const returnedLocation = data.locations.find(value => value.id === returnedListing.locationIds![0])!;
  assert.equal(returnedLocation.streetAddress, "Synthetic Road A 10"); assert.equal(returnedLocation.postalCode, "00123");
  assert.equal(returnedLocation.coordinates, undefined); assert.equal(returnedLocation.officeResolution, undefined);
  assert.deepEqual(data.locations.find(value => value.id === otherLocationId), otherLocation);
  assert.deepEqual(facts(data.jobs[0]!), facts(beforeJob));
  assert.equal((await repo.backup()).officeDecisions.filter(value => value.kind === "invalidate").length, 1);
  assert.equal(returned.receipt.counts.updatedJobs, 1); assert.equal(merged.decision.kind, "merge");
  const reopened = openJobRepository(path, { now });
  try { assert.deepEqual(await reopened.readSnapshot(), data); } finally { reopened.close(); }
  const backup = await repo.backup(), restored = openJobRepository(":memory:", { now });
  try {
    await restored.restore(backup, options("restore-moved-history", 0));
    const after = await restored.readSnapshot(); assert.deepEqual(after.jobs, data.jobs);
    assert.equal(after.locations.find(value => value.id === returnedLocation.id)!.officeResolution, undefined);
    assert.equal(after.locations.find(value => value.id === otherLocationId)!.officeResolution?.decisionId, otherOffice.decisionId);
  } finally { restored.close(); }
}));

test("postal-only Ashby changes keep leading zeros and do not borrow the old street, while sparse refresh retains the new contribution", async () => fixture(async (repo, _path, now, advance) => {
  advance(); await ingest(repo, primary, posting("Synthetic Road A 10", "00123"), "postal-initial", now());
  const initial = await repo.readSnapshot(), old = initial.locations[0]!;
  advance(); await ingest(repo, primary, posting(undefined, "00456"), "postal-changed", now());
  let data = await repo.readSnapshot(); const currentId = data.jobs[0]!.locationIds[0]!, current = data.locations.find(value => value.id === currentId)!;
  assert.notEqual(currentId, old.id); assert.equal(current.postalCode, "00456"); assert.equal(current.streetAddress, undefined);
  assert.equal(current.coordinates, undefined); assert.equal(current.officeResolution, undefined);
  advance(); await ingest(repo, primary, posting(), "postal-sparse", now());
  data = await repo.readSnapshot(); assert.deepEqual(data.jobs[0]!.locationIds, [currentId]);
  assert.equal(data.locations.find(value => value.id === currentId)!.postalCode, "00456");
  assert.equal(data.locations.find(value => value.id === currentId)!.streetAddress, undefined);
}));

test("returning an identical address-specific identity cannot revive its superseded office confirmation", async () => fixture(async (repo, _path, now, advance) => {
  advance(); await ingest(repo, primary, posting("Synthetic Road A 10", "00123"), "versioned-a", now());
  advance(); await ingest(repo, primary, posting("Synthetic Road B 20", "00456"), "versioned-b", now());
  let data = await repo.readSnapshot(); const jobId = data.jobs[0]!.id, locationId = data.jobs[0]!.locationIds[0]!;
  const saved = await confirm(repo, jobId, locationId, "versioned-b-office");
  advance(); const changed = await ingest(repo, primary, posting("Synthetic Road C 30", "00789"), "versioned-c", now());
  const invalidation = (await repo.backup()).officeDecisions.find(value => value.kind === "invalidate")!;
  assert.equal(invalidation.revision, changed.receipt.revision);
  if (invalidation.kind === "invalidate") assert.deepEqual(invalidation.targetDecisionIds, [saved.decisionId]);
  advance(); await ingest(repo, primary, posting("Synthetic Road B 20", "00456"), "versioned-b-return", now());
  data = await repo.readSnapshot(); assert.deepEqual(data.jobs[0]!.locationIds, [locationId], "the same disclosed address reuses its content identity");
  const returned = data.locations.find(value => value.id === locationId)!;
  assert.equal(returned.postalCode, "00456"); assert.equal(returned.coordinates, undefined); assert.equal(returned.officeResolution, undefined);
  const restored = openJobRepository(":memory:", { now });
  try {
    await restored.restore(await repo.backup(), options("restore-versioned-return", 0));
    assert.equal((await restored.readSnapshot()).locations.find(value => value.id === locationId)!.officeResolution, undefined);
  } finally { restored.close(); }
}));
