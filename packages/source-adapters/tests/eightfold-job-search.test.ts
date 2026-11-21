import assert from "node:assert/strict";
import test from "node:test";
import type { SourceTransport } from "../src/contracts.js";
import { discoverEightfoldJobs } from "../src/eightfold-job-search.js";
import { eightfoldPcsAdapter, microsoftPcsBoard } from "../src/adapters/eightfold-pcs.js";
import { OfficialJobDiscoveryResultSchema } from "../src/official-job-discovery-contracts.js";

const input = { role: "软件工程师", region: "上海市", skills: ["C#"], secondarySkills: ["React"] };
const now = "2026-11-21T03:00:00Z";
const context = { requestId: "ms-test", actorScope: "test", observedAt: now, signal: new AbortController().signal,
  budget: { requests: 8, bytes: 4_000_000, timeoutMs: 10_000 }, consumeRequests() {}, consumeBytes() {}, throwIfCancelled() { this.signal.throwIfAborted(); } };
const detail = (id: number) => "https://apply.careers.microsoft.com/careers/job/" + id + "?hl=en";
const officeUrl = "https://careers.microsoft.com/v2/global/en/locations/shanghai.html";

function fixture(options: { unavailable?: boolean; company?: string; expired?: boolean; detailCity?: string } = {}) {
  const urls: string[] = [];
  const fetch: SourceTransport = { async request({ url, source }) {
    assert.ok(source.endpointPolicy.allowedHosts.includes(new URL(url).hostname));
    urls.push(url);
    let text: string, type = "text/html";
    if (url.startsWith(microsoftPcsBoard.entryUrl!)) {
      if (options.unavailable) throw new Error("unavailable");
      const item = (id: number, location: string, positionUrl = "/careers/job/" + id) => ({ id, name: "Software Engineer", standardizedLocations: [location], positionUrl });
      text = JSON.stringify({ status: 200, data: { count: 7, positions: [item(421, "Shanghai, Shanghai, CN"),
        item(422, "Paris, France, FR"), item(423, "Shanghai, Shanghai, CN", "https://outside.invalid/jobs/423")] } });
      type = "application/json";
    } else if (url === officeUrl) {
      text = '<a href="' + detail(421) + '">See details</a><a href="https://example.org/careers/job/59">unrelated</a>';
    } else if (url === detail(421)) {
      text = '<script type="application/ld+json">' + JSON.stringify({ "@context": "https://schema.org", "@type": "JobPosting",
        url, title: "Software Engineer", hiringOrganization: { name: options.company ?? "Microsoft" }, description: "Develop C# and React tooling. Occasional travel required.",
        validThrough: options.expired ? "2025-10-18" : "2027-04-12",
        jobLocation: { "@type": "Place", address: { addressLocality: options.detailCity ?? "Shanghai", addressCountry: "CN" } } }) + "</script>";
    } else throw new Error("unknown URL");
    return { url, status: 200, text, headers: { "content-type": type } };
  } };
  return { urls, transport: fetch, context };
}
test("Eightfold matches official detail and exact office, then proposes the employer without enabling it", async () => {
  const run = fixture();
  const result = OfficialJobDiscoveryResultSchema.parse(await discoverEightfoldJobs(input, run));
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(run.urls.slice(1), [detail(421)]);
  const match = result.candidates[0]!;
  assert.ok(run.urls[0]!.includes("query=C%23"));
  assert.deepEqual(match.matchedSkills, ["C#", "React"]);
  assert.equal(match.url, detail(421));
  assert.equal(match.sourceProposal?.enabled, false);
  const existing = { ...match.sourceProposal!, enabled: true, status: "active" as const };
  const again = await discoverEightfoldJobs(input, { ...fixture(), registeredSources: [existing] });
  assert.equal(again.candidates[0]?.sourceId, existing.sourceId);
  assert.equal(again.candidates[0]?.sourceProposal, undefined);
});
test("Eightfold falls back to the regional employer page and provides the same URLs during company collection", async () => {
  const run = fixture({ unavailable: true });
  const searched = await discoverEightfoldJobs(input, run);
  assert.equal(searched.candidates.length, 1);
  assert.deepEqual(run.urls.slice(1), [officeUrl, detail(421)]);
  const read = fixture({ unavailable: true });
  const collected = await eightfoldPcsAdapter.list({ ...read, source: searched.candidates[0]!.sourceProposal!, scope: { roles: [], regions: [], companyNames: [] } });
  assert.equal(collected.coverage.partial, true);
  assert.equal(collected.records[0]?.url, searched.candidates[0]?.url);
  assert.equal(collected.records[0]?.sourceRecordId, searched.candidates[0]?.jobId);
  assert.equal(collected.records[0]?.companyName, "Microsoft");
});
test("Eightfold skips expired jobs, employer mismatches, conflicting cities and irrelevant primary skills", async () => {
  for (const option of [{ expired: true }, { company: "Another" }, { detailCity: "Suzhou" }]) {
    assert.equal((await discoverEightfoldJobs(input, fixture(option))).candidates.length, 0);
  }
  assert.equal((await discoverEightfoldJobs({ ...input, skills: ["Cobol"] }, fixture())).candidates.length, 0);
});
test("Eightfold refresh keeps native pagination and guards the configured employer endpoint", async () => {
  const run = fixture(), request = { ...run, source: microsoftPcsBoard, scope: { roles: [], regions: [], companyNames: [] } };
  const page = await eightfoldPcsAdapter.list(request);
  assert.equal(page.coverage.fetchedRecords, 3);
  assert.equal(page.records.length, 2);
  assert.equal(page.nextCursor, "3");
  assert.equal(page.records[0]?.url, detail(421));
  await assert.rejects(eightfoldPcsAdapter.list({ ...request, source: { ...microsoftPcsBoard, entryUrl: "https://outside.invalid/" } }));
});
