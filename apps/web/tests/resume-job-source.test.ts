import assert from "node:assert/strict";
import test from "node:test";
import { queryJobs, type JobQueryInput } from "@better-me/opportunities";
import { extractRecommendationProfile } from "../src/lib/resume-job-recommendations";
import { readIndexRecommendationCandidates } from "../src/lib/resume-job-source";
import { fixtureResume, recommendationDataset } from "./fixtures/resume-recommendations";

const endpoint = "http://127.0.0.1:5178";
const at = "2026-10-31T00:00:00Z";
async function reply(query: JobQueryInput, empty = false) {
  const value = await queryJobs(recommendationDataset(empty ? [] : undefined), query, { now: at });
  return Response.json({ ok: true, requestId: "synthetic-read-only-query", value });
}

test("uses bounded authenticated public queries, not full snapshots or resume documents", async context => {
  const requests: Array<{ url: string; init: RequestInit; body: JobQueryInput }> = [];
  context.mock.method(globalThis, "fetch", async (input: URL | string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as JobQueryInput;
    requests.push({ url: String(input), init, body });
    return reply(body);
  });
  const before = JSON.stringify(fixtureResume);
  const source = await readIndexRecommendationCandidates(endpoint, "synthetic-test-token", extractRecommendationProfile(fixtureResume), new AbortController().signal);
  assert.equal(source.kind, "index");
  assert.equal(source.bounded, true);
  assert.equal(source.partial, false);
  assert.equal(requests.length, 3);
  assert.equal(new Set(source.dataset.jobs.map(job => job.id)).size, source.dataset.jobs.length);
  for (const { url, init, body } of requests) {
    assert.equal(url, `${endpoint}/api/v1/jobs/search`);
    assert.equal(init.method, "POST");
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer synthetic-test-token");
    assert.equal(body.page?.limit, 60);
    assert.equal(body.search?.mode, "exact");
    assert.deepEqual(body.statuses, ["open", "unknown"]);
    assert.ok(body.workRegionGroups?.[0]?.includes("上海市"));
    assert.deepEqual(Object.keys(body).sort(), ["search", "workRegionGroups", "workCountryCodes", "statuses", "page"].sort());
    assert.ok(!String(init.body).includes("合成测试候选人"));
    assert.ok(!String(init.body).includes("合成测试企业"));
  }
  assert.equal(JSON.stringify(fixtureResume), before);
});

test("keeps successful query evidence when another term fails; all failures are not reported as zero", async context => {
  context.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as JobQueryInput;
    return body.search?.text === ".NET" ? new Response(null, { status: 503 }) : reply(body);
  });
  const source = await readIndexRecommendationCandidates(endpoint, "synthetic-test-token", extractRecommendationProfile(fixtureResume), new AbortController().signal);
  assert.equal(source.partial, true);
  assert.ok(source.dataset.jobs.length > 0);
  context.mock.restoreAll();
  context.mock.method(globalThis, "fetch", async () => new Response(null, { status: 401 }));
  await assert.rejects(readIndexRecommendationCandidates(endpoint, "synthetic-test-token", extractRecommendationProfile(fixtureResume), new AbortController().signal), /index unavailable/i);
});

test("falls back once to other areas only when the disclosed-area candidates are insufficient", async context => {
  const requests: JobQueryInput[] = [];
  context.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    const query = JSON.parse(String(init.body)) as JobQueryInput; requests.push(query);
    return reply(query, !!query.workRegionGroups);
  });
  const result = await readIndexRecommendationCandidates(endpoint, "synthetic-test-token", extractRecommendationProfile(fixtureResume), new AbortController().signal);
  assert.equal(requests.length, 4);
  assert.ok(requests.slice(0, 3).every(query => !!query.workRegionGroups));
  assert.equal(requests[3]!.workRegionGroups, undefined);
  assert.equal(result.partial, false);
  assert.ok(result.dataset.jobs.length > 0);
});

test("abort cancels requests and no-profile requests never read the index", async context => {
  let calls = 0;
  context.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
  });
  const profile = extractRecommendationProfile(fixtureResume), abort = new AbortController();
  const pending = readIndexRecommendationCandidates(endpoint, "synthetic-test-token", profile, abort.signal);
  abort.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(calls, 3);
  profile.roles = []; profile.skills = []; profile.tags = [];
  const empty = await readIndexRecommendationCandidates(endpoint, "synthetic-test-token", profile, new AbortController().signal);
  assert.equal(calls, 3);
  assert.equal(empty.dataset.jobs.length, 0);
});
