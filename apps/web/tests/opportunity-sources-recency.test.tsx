import assert from "node:assert/strict";
import test from "node:test";
import { fetchOpportunitySource } from "../server/opportunity-sources";

test("fetchOpportunitySource keeps newest 300 jobs when Greenhouse or Lever returns more than 300 rows", async () => {
  const ghJobs = Array.from({ length: 305 }, (_, i) => ({
    id: `gh-${i}`,
    title: `Role ${i}`,
    absolute_url: `https://boards.greenhouse.io/acme/jobs/${i}`,
    location: { name: "Shanghai" },
    first_published: i < 5 ? `2026-11-15T10:0${i}:00Z` : `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`,
    updated_at: i === 304 ? "2026-11-15T20:00:00Z" : undefined,
  }));
  const gh = await fetchOpportunitySource({ provider: "greenhouse", company: "acme" }, async () =>
    new Response(JSON.stringify({ jobs: ghJobs }), { status: 200, headers: { "content-type": "application/json" } }));
  assert.equal(gh.truncated, true);
  assert.equal(gh.jobs.length, 300);
  assert.equal(gh.jobs[0]!.sourceJobId, "gh-304");
  assert.equal(gh.jobs[1]!.sourceJobId, "gh-4");

  const leverRows = Array.from({ length: 305 }, (_, i) => ({
    id: `lv-${i}`,
    text: `Role ${i}`,
    hostedUrl: `https://jobs.lever.co/acme/lv-${i}`,
    createdAt: i === 303 ? Date.parse("2026-11-15T18:00:00Z") : Date.parse("2026-01-01T00:00:00Z") + i,
    categories: { location: "Shanghai" },
  }));
  const lv = await fetchOpportunitySource({ provider: "lever", company: "acme" }, async () =>
    new Response(JSON.stringify(leverRows), { status: 200, headers: { "content-type": "application/json" } }));
  assert.equal(lv.truncated, true);
  assert.equal(lv.jobs.length, 300);
  assert.equal(lv.jobs[0]!.sourceJobId, "lv-303");
});
