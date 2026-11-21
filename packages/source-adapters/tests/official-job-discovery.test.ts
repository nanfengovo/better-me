import assert from "node:assert/strict";
import test from "node:test";
import { discoverOfficialJobs, type OfficialJobDiscoveryExecution } from "../src/official-job-discovery.js";
import { inspectOfficialJobPage } from "../src/official-job-page.js";
import type { SourceTransport } from "../src/contracts.js";
import { createControlledSourceTransport } from "../src/transport.js";

const now = "2026-11-21T03:30:00.000Z";
const request = { role: "Backend Engineer", skills: ["C#"], secondarySkills: ["Vue"], region: "Shanghai", preferLowTravel: true };
const detailUrl = "https://careers.firgrove.com/jobs/1681";
const atsUrl = "https://jobs.smartrecruiters.com/Firgrove/744000123456789-backend-engineer";
function detail(url: string, fields: Record<string, unknown> = {}, extra = "") {
  const posting = { "@context": "https://schema.org", "@type": "JobPosting", url, title: "Backend Engineer",
    identifier: { value: "1681" }, hiringOrganization: { "@type": "Organization", name: "Firgrove", sameAs: "https://www.firgrove.com" },
    description: "<p>Build C# systems with Vue. No travel required.</p>",
    jobLocation: { "@type": "Place", address: { addressLocality: "Shanghai", addressCountry: "CN" } }, ...fields };
  return '<html><head><script type="application/ld+json">' + JSON.stringify(posting) + "</script></head><body><main>" + extra + "</main></body></html>";
}
function fixture(urls: string[], pages: Record<string, string>): OfficialJobDiscoveryExecution {
  const context = { requestId: "discover", observedAt: now, actorScope: "local",
    budget: { requests: 20, bytes: 2_000_000, timeoutMs: 10_000 }, signal: new AbortController().signal,
    consumeRequests() {}, consumeBytes() {}, throwIfCancelled() { this.signal.throwIfAborted(); } };
  const detailTransport: SourceTransport = { async request({ url, source }) {
    assert.deepEqual(source.endpointPolicy.allowedHosts, [new URL(url).hostname]);
    assert.equal(source.endpointPolicy.allowRedirects, false);
    return { url, status: pages[url] ? 200 : 404, headers: {}, text: pages[url] ?? "" };
  } };
  return { context, transport: { async request() { throw new Error("Unexpected invocation"); } }, detailTransport,
    searchProvider: { async search({ query, companyName }) {
      assert.equal(companyName, ""); assert.ok(query.includes("Shanghai"));
      return { results: urls.map(url => ({ url, title: "Search result", snippet: "No travel! We hire for C#!" })), partial: false };
    } } };
}
test("discovers a new employer without a registered company, deduplicates queries, and grounds skills and travel in its posting", async () => {
  const run = fixture([detailUrl, atsUrl, "https://market.example.com/jobs/1681"], {
    [detailUrl]: detail(detailUrl), [atsUrl]: detail(atsUrl), "https://market.example.com/jobs/1681": "<h1>Results</h1>",
  });
  const results = await discoverOfficialJobs(request, run);
  assert.ok(results.queries.some(query => query.includes("site:jobs.smartrecruiters.com")));
  assert.ok(results.queries.some(query => query.includes("site:myworkdayjobs.com")));
  assert.equal(results.candidates.length, 2);
  const [match, lead] = results.candidates;
  assert.equal(match?.company, "Firgrove"); assert.equal(match?.companyWebsite, "https://www.firgrove.com/"); assert.equal(match?.verification, "official-detail");
  assert.match(match!.location!, /Shanghai/); assert.equal(match!.jobId, "1681");
  assert.deepEqual(match!.matchedSkills, ["C#", "Vue"]); assert.equal(match!.travel, "not-required");
  assert.match(match!.travelEvidence!, /No travel required/); assert.equal(match!.availability, "unknown");
  assert.equal(lead?.verification, "unverified-lead"); assert.equal(lead?.travel, "unknown"); assert.deepEqual(lead?.matchedSkills, []);
});
test("requires employer association even for structured postings; ATS tenant must agree with employer", () => {
  for (const raw of ["https://jobboard.example.org/jobs/1681", "https://jobs.smartrecruiters.com/Different/744000123456789-backend"]) {
    const page = inspectOfficialJobPage(detail(raw), new URL(raw), request, [], now);
    assert.ok(page && typeof page === "object"); assert.equal(page.verification, "unverified-lead");
  }
  const page = inspectOfficialJobPage(detail(atsUrl), new URL(atsUrl), request, [], now);
  assert.ok(page && typeof page === "object"); assert.equal(page.verification, "official-detail");
});
test("explicit expiry, closure and removed pages are excluded; page without JobPosting can still identify an employer JD", async () => {
  const old = detailUrl + "-old", closed = detailUrl + "-closed", missing = detailUrl + "-missing";
  const html = '<html><head><meta property="og:site_name" content="Firgrove"></head><body><main><h1>Backend Engineer</h1><h2>Responsibilities</h2><p>Build services.</p><h2>Qualifications</h2><p>C# required. Travel up to 10%.</p><a href="/apply">Apply now</a></main></body></html>';
  const result = await discoverOfficialJobs(request, fixture([old, closed, missing, detailUrl], {
    [old]: detail(old, { validThrough: "2026-11-01" }),
    [closed]: detail(closed, {}, "<p>This job is no longer available.</p>"), [detailUrl]: html,
  }));
  assert.equal(result.candidates.length, 1); assert.equal(result.candidates[0]?.verification, "official-detail");
  assert.equal(result.candidates[0]?.travel, "low-frequency"); assert.ok(result.warnings.some(warning => warning.includes("3 个结果")));
  assert.equal(inspectOfficialJobPage(detail(detailUrl, {}, "<p>This vacancy has now expired.</p>"), new URL(detailUrl), request, [], now), "closed");
});
test("public destination policy rejects internal DNS results before dispatch and keeps snippets out of evidence", async () => {
  const run = fixture(["https://careers.unit.example/jobs/1681"], {});
  let sent = false;
  run.detailTransport = createControlledSourceTransport({
    allowFakeIp: false, resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    send: async () => { sent = true; throw new Error("unexpected dispatch"); },
  });
  const result = await discoverOfficialJobs(request, run);
  assert.deepEqual(result.candidates, []); assert.equal(sent, false); assert.equal(result.status, "partial");
});
test("missing provider reports unavailable and a cancelled search cannot issue another query", async () => {
  const run = fixture([], {});
  assert.equal((await discoverOfficialJobs(request, { ...run, searchProvider: undefined })).status, "provider-unavailable");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(discoverOfficialJobs(request, { ...run, context: { ...run.context, signal: controller.signal,
    throwIfCancelled() { this.signal.throwIfAborted(); } } }));
});

test("skills alone can discover employers; a result board is reviewable and keeps the verified tenant", async () => {
  const input = { ...request, role: "" };
  const run = fixture([atsUrl], { [atsUrl]: detail(atsUrl) });
  const result = await discoverOfficialJobs(input, run);
  const board = result.candidates[0]!.sourceProposal!;
  assert.equal(board.adapterId, "smartrecruiters"); assert.equal(board.enabled, false); assert.equal(board.status, "needs-review");
  assert.equal(board.options!.companyIdentifier, "Firgrove");
  const repeat = await discoverOfficialJobs(input, { ...run, registeredSources: [{ ...board, sourceId: "installed" }] });
  assert.equal(repeat.candidates[0]?.sourceId, "installed"); assert.equal(repeat.candidates[0]?.sourceProposal, undefined);
  await assert.rejects(discoverOfficialJobs({ ...request, role: "", skills: [] }, run));
});
test("travel and employer ownership labels use the job's own evidence", async () => {
  const { describeJobPreferences } = await import("../src/official-job-preferences.js");
  const fields = describeJobPreferences("Firgrove is a French multinational. Expected travel: 0–10%.", "Firgrove");
  assert.equal(fields.travel, "low-frequency"); assert.equal(fields.employerNature, "foreign-disclosed");
  assert.match(fields.employerNatureEvidence!, /French multinational/);
  assert.equal(describeJobPreferences("Our client is a French multinational. Travel required up to 40%.", "Firgrove").employerNature, "unknown");
  assert.equal(describeJobPreferences("Our client is a French multinational. Travel required up to 40%.", "Firgrove").travel, "required");
  assert.equal(describeJobPreferences("Travel (required estimated % of time)\nWill travel about 15% of time to work together with global R&D center or local partner.", "Firgrove").travel, "required");
  assert.equal(describeJobPreferences("Cut latency by 50%, no travel required.", "Firgrove").travel, "not-required");
  assert.equal(describeJobPreferences("我们是一家致力服务于德国企业客户的软件团队。", "Firgrove").employerNature, "unknown");
  assert.equal(describeJobPreferences("No travel expenses are reimbursed.", "Firgrove").travel, "mentioned");
  assert.equal(describeJobPreferences("We welcome global customers.", "Firgrove").employerNature, "unknown");
});
test("all four supported public ATS boards preserve the employer tenant when proposed", async () => {
  const { companyBoardFromOfficialJob } = await import("../src/career-discovery.js");
  for (const [url, kind] of [
    ["https://job-boards.greenhouse.io/firgrove/jobs/11232", "greenhouse"],
    ["https://jobs.lever.co/firgrove/1abd22ac-ef02-4217-8111-aadcbf68ccef", "lever"],
    ["https://jobs.ashbyhq.com/firgrove/1abd22ac-ef02-4217-8111-aadcbf68ccef", "ashby"],
    [atsUrl, "smartrecruiters"],
  ] as const) {
    const { sourceProposal } = await companyBoardFromOfficialJob({ url, verification: "official-detail", company: "Firgrove" });
    assert.equal(sourceProposal?.adapterId, kind);
    assert.deepEqual(await companyBoardFromOfficialJob({ url, verification: "unverified-lead", company: "Firgrove" }), {});
  }
});
test("Workable refreshes one identified company; keeps pagination and rejects changed employer", async () => {
  const { workableAdapter, workableCompanyBoard } = await import("../src/adapters/workable.js");
  const id = "05dd971a-afcf-4281-bcb1-151ba421f2cd", name = "Firgrove";
  const { sourceProposal: source } = await workableCompanyBoard(id, name, "https://jobs.workable.com/company/a1b2/jobs-at-firgrove");
  assert.ok(source); assert.equal(source.enabled, false);
  assert.equal((await workableCompanyBoard(id, name, source.attribution.homepageUrl!, [{ ...source, sourceId: "existing" }])).sourceId, "existing");
  const run = fixture([], {});
  const job = { id: "post-a", title: "C# Engineer", company: { id }, state: "published", description: "<p>Develop backend services.</p>",
    url: "https://jobs.workable.com/view/abc/engineer", location: { city: "Shanghai", countryName: "China" } };
  const request = { source, context: run.context, scope: { roles: [], regions: [], companyNames: [] }, transport: {
    async request({ url }: {url: string}) {
      assert.ok(url.startsWith(source.entryUrl!));
      return { url, status: 200, headers: {}, text: JSON.stringify({ id, title: name, workableUid: id, jobs: [job, { ...job, company: { id: "another" } }],
        totalSize: 4, ...(url.endsWith("pageToken=cGFnZQ%3D%3D") ? {} : { nextPageToken: "cGFnZQ==" }) }) };
    } } };
  const result = await workableAdapter.list(request);
  assert.equal(result.records.length, 1); assert.equal(result.records[0]?.companyName, name);
  assert.equal(result.records[0]?.locations[0]?.city, "Shanghai"); assert.equal(result.nextCursor, "cGFnZQ==");
  const second = await workableAdapter.list({ ...request, cursor: result.nextCursor }); assert.equal(second.nextCursor, undefined);
  await assert.rejects(workableAdapter.list({ ...request, source: { ...source, options: { companyId: "different" } } }));
});

test("Chinese city aliases match structured office evidence and a known incompatible city is omitted", async () => {
  const other = detailUrl + "-another";
  const result = await discoverOfficialJobs({ ...request, region: "上海" }, { ...fixture([detailUrl, other], {
    [detailUrl]: detail(detailUrl),
    [other]: detail(other, { jobLocation: { address: { addressLocality: "Beijing", addressCountry: "CN" } } }),
  }), searchProvider: { async search() { return { results: [{ url: detailUrl }, { url: other }], partial: false }; } } });
  assert.deepEqual(result.candidates.map(job => job.url), [detailUrl]);
  assert.ok(result.warnings.some(text => text.includes("地点")));
});

test("a nationwide SmartRecruiters search discovers unrelated tenants dynamically and distinguishes a related technology from a resume skill", async () => {
  const { discoverSmartRecruitersJobs } = await import("../src/smartrecruiters-job-search.js");
  const { interleaveEmployers, discoveryRegion } = await import("../src/official-discovery-coverage.js");
  const employers = ["AtlasOne", "Firgrove", "StaffingDesk"];
  const listed = employers.map((tenant, index) => ({
    id: String(744000178000001 + index), company: { identifier: tenant, name: tenant }, name: "Software Developer",
    location: { country: "cn", city: index ? "Suzhou" : "Shanghai", region: "Jiangsu" },
  }));
  const wrongRegion = { ...listed[0]!, id: "744000178000004", location: { country: "us", city: "Shanghai" } };
  const inactive = { ...listed[0]!, id: "744000178000005" };
  const wrongTenant = { ...listed[0]!, id: "744000178000006" };
  const noSkill = { ...listed[0]!, id: "744000178000007" };
  const all = [...listed, wrongRegion, inactive, wrongTenant, noSkill];
  const actualReads = new Set<string>();
  const run = fixture([], {});
  run.transport = { async request({ url }) {
    actualReads.add(url);
    const target = new URL(url);
    let data;
    if (target.pathname === "/sr-jobs/search") {
      assert.ok(target.searchParams.get("keyword"));
      data = { content: all };
    } else if (target.pathname.endsWith("/postings")) {
      assert.equal(target.searchParams.get("country"), "cn");
      data = { content: all.filter(job => job.company.identifier === target.pathname.split("/")[3]) };
    } else {
      const id = target.pathname.split("/").at(-1), job = all.find(item => item.id === id)!;
      data = { ...job, active: id !== inactive.id, visibility: "PUBLIC", company: id === wrongTenant.id ? listed[1]!.company : job.company,
        postingUrl: "https://jobs.smartrecruiters.com/" + job.company.identifier + "/" + id + "-software",
        jobAd: { sections: { jobDescription: { text: job === listed[2] ? "Our client is hiring a C# developer." : "Develop services." },
          qualifications: { text: job === noSkill ? "Python" : job === listed[0] ? "Experience with .NET." : "Experience with C#." } } } };
    }
    return { url, status: 200, headers: { "content-type": "application/json" }, text: JSON.stringify(data) };
  } };
  const input = { ...request, region: "中国", secondarySkills: ["Python"] };
  const result = await discoverSmartRecruitersJobs(input, run);
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.candidates.find(item => item.company === "AtlasOne")!.matchedSkills, []);
  assert.deepEqual(result.candidates.find(item => item.company === "AtlasOne")!.relatedSkills, [".NET"]);
  assert.ok(result.candidates.every(job => job.sourceProposal?.enabled === false && job.sourceProposal.options?.companyIdentifier === job.company));
  assert.ok(![...actualReads].some(url => url.endsWith(wrongRegion.id)));
  const city = await discoverSmartRecruitersJobs({ ...input, region: "上海" }, run);
  assert.deepEqual(city.candidates.map(job => job.company), ["AtlasOne"]);
  assert.equal(discoveryRegion("China").city, undefined);
  assert.deepEqual(interleaveEmployers(["a1","a2","a3","b1","b2","c1"], item => item[0]!), ["a1","b1","c1","a2","b2","a3"]);
});

