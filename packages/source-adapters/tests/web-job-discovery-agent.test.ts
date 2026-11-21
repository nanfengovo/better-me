import assert from "node:assert/strict";
import test from "node:test";
import { createWebJobDiscoveryState, expandWebJobDiscovery } from "../src/web-job-discovery-agent.js";
import { jobPostingJsonLdAdapter } from "../src/adapters/jobposting-jsonld.js";
import { discoverEmployerBackground } from "../src/discovered-employer-background.js";
import type { SourceAdapterContext, SourceTransport } from "../src/contracts.js";
import type { OfficialJobDiscoveryCandidate, OfficialJobDiscoveryResult } from "../src/official-job-discovery-contracts.js";

const observedAt = "2026-11-21T00:00:00Z";
function context(): SourceAdapterContext {
  const signal = new AbortController().signal;
  return { requestId: "synthetic-discovery-exploration", actorScope: "synthetic", observedAt, signal,
    budget: { requests: 144, bytes: 64_000_000, timeoutMs: 120_000 }, consumeRequests() {}, consumeBytes() {}, throwIfCancelled() { signal.throwIfAborted(); } };
}
const input = { role: "软件工程师", skills: ["C#", ".NET"], region: "上海" };
const seed: OfficialJobDiscoveryResult = { observedAt, candidates: [], queries: [], warnings: [], status: "partial" };
function fixturePage(url: string, company: string) {
  const origin = new URL(url).origin;
  return '<html><head><script type="application/ld+json">' + JSON.stringify({
    "@context": "https://schema.org", "@type": "JobPosting", identifier: { value: "role-1" }, title: "Software Engineer",
    url, description: "Develop C# and .NET APIs. No travel required.", validThrough: "2026-12-31",
    hiringOrganization: { "@type": "Organization", name: company, sameAs: origin },
    jobLocation: { "@type": "Place", address: { addressLocality: "Shanghai", addressCountry: "CN" } },
  }) + '</script></head><body><main><h1>Software Engineer</h1><p>Currently accepting applications</p><a href="/apply/role-1">Apply now</a></main></body></html>';
}

test("successive searches discover unrelated, previously unseen official websites and generate a reusable collection from a real directory", async () => {
  const urls = ["https://careers.northstar-example.com/jobs", "https://careers.orbit-example.com/jobs"];
  const companies = ["Northstar Example", "Orbit Example"];
  const calls: string[] = [], queries: string[] = [];
  const transport: SourceTransport = { async request({ url }) {
    calls.push(url);
    const source = urls.find(entry => url.startsWith(entry));
    if (!source) throw new Error("not found");
    const text = url === source ? '<html><body><a href="/jobs/role-1">C# Software Engineer</a><a href="https://127.0.0.1/jobs">Jobs</a></body></html>'
      : fixturePage(url, companies[urls.indexOf(source)]!);
    return { url, text, status: 200, headers: { "content-type": "text/html" } };
  } };
  const state = createWebJobDiscoveryState(input, seed);
  const searchProvider = { async search({ query }: { query: string }) {
    const url = urls[Math.min(1, queries.length)]!;
    queries.push(query);
    return { results: [{ url, title: "C# job openings" }], partial: false };
  } };
  const execution = { context: context(), transport, detailTransport: transport, searchProvider };
  const first = await expandWebJobDiscovery(input, state, execution);
  assert.equal(first.candidates[0]?.company, companies[0]);
  assert.equal(first.candidates[0]?.availability, "open");
  assert.ok(first.candidates[0]?.sourceProposal);
  const proposal = first.candidates[0]!.sourceProposal!;
  assert.equal(proposal.entryUrl, urls[0]);
  assert.equal(proposal.enabled, false);
  assert.equal(proposal.adapterId, "jobposting-jsonld");
  const preview = await jobPostingJsonLdAdapter.list({ context: context(), transport, source: { ...proposal, enabled: true, status: "active" },
    scope: { roles: [], regions: [], companyNames: [] } });
  assert.equal(preview.records[0]?.url, first.candidates[0]?.url);
  const second = await expandWebJobDiscovery(input, state, execution);
  assert.equal(second.candidates[0]?.company, companies[1]);
  assert.notEqual(queries[0], queries[1]);
  assert.equal(state.knownCompanies.size, 2);
  assert.equal(calls.filter(url => url === urls[0] + "/role-1").length, 2, "only the explicit collection preview re-read the first posting");
  assert.ok(!calls.some(url => url.includes("127.0.0.1") || url.includes("/apply/")));
});

test("public role index leads reach an unknown Workday tenant and only open official postings gain a source proposal", async () => {
  const directory = "https://jobseveryhour.com";
  const home = "https://futurelabs.wd4.myworkdayjobs.com/External";
  const job = home + "/job/Shanghai/Software-Engineer_1";
  const api = "https://futurelabs.wd4.myworkdayjobs.com/wday/cxs/futurelabs/External/job/Shanghai/Software-Engineer_1";
  const manifest = home + "/siteMap.xml";
  const pages = new Map([
    [directory + "/locations/china/", '<a href="/roles/software-engineer/china/">Software Engineer</a>'],
    [directory + "/roles/software-engineer/china/", '<a href="/job/new-company-role/"><span><span class="jt">Software Engineer</span><span class="js">Future Labs · Shanghai China</span></span>C# .NET</a>'],
    [directory + "/job/new-company-role/", '<a id="apply" href="' + job + '">Apply on company site</a>'],
    [api, JSON.stringify({ jobPostingInfo: { title: "Software Engineer", jobDescription: "C# developer. No travel required.", jobReqId: "1",
      jobPostingSiteId: "External", externalUrl: job, location: "Shanghai", country: { descriptor: "China" }, canApply: true, posted: true },
      hiringOrganization: { name: "Future Labs" }, similarJobs: [] })],
    [manifest, '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>' + job + '</loc></url></urlset>'],
  ]);
  const transport: SourceTransport = { async request({ url }) {
    const text = pages.get(url);
    if (!text) throw new Error("unexpected URL");
    return { url, text, status: 200, headers: { "content-type": url === api ? "application/json" : url === manifest ? "application/xml" : "text/html" } };
  } };
  const result = await expandWebJobDiscovery(input, createWebJobDiscoveryState(input, seed), { context: context(), transport, detailTransport: transport });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.url, job);
  assert.equal(result.candidates[0]?.sourceProposal?.entryUrl, manifest);
  assert.equal(result.candidates[0]?.discoveryEvidenceUrl, directory + "/job/new-company-role/");
  const closed = JSON.parse(pages.get(api)!);
  closed.jobPostingInfo.canApply = false;
  pages.set(api, JSON.stringify(closed));
  const again = await expandWebJobDiscovery(input, createWebJobDiscoveryState(input, seed), { context: context(), transport, detailTransport: transport });
  assert.equal(again.candidates.length, 0);
});

test("public headquarters data requires the new verified ATS tenant and the corporate website to agree", async () => {
  const claim = (value: unknown) => ({ mainsnak: { datavalue: { value } } });
  const label = (en: string) => ({ en: { value: en } });
  const candidate: OfficialJobDiscoveryCandidate = { company: "Nimbus Corporation China", url: "https://nimbus.wd1.myworkdayjobs.com/External/job/Shanghai/Developer_1",
    title: "Software Engineer", verification: "official-detail", travel: "unknown", availability: "open", matchedSkills: ["C#"], description: "C# developer" };
  const transport: SourceTransport = { async request({ url }) {
    const query = new URL(url).searchParams;
    let body: unknown;
    if (query.get("action") === "wbsearchentities") body = { search: [{ id: "Q100" }] };
    else if (query.get("action") === "wbgetclaims") body = { claims: { P17: [claim({ id: "Q30" })] } };
    else if (query.get("ids") === "Q100") body = { entities: { Q100: { labels: label("Nimbus Corporation"),
      claims: { P17: [claim({ id: "Q30" })], P159: [claim({ id: "Q200" })], P31: [claim({ id: "Q4830453" })], P856: [claim("https://nimbus.example.org/")] } } } };
    else body = { entities: { Q200: { labels: label("San Francisco") }, Q30: { labels: label("United States") } } };
    return { url, text: JSON.stringify(body), status: 200, headers: {} };
  } };
  const result = await discoverEmployerBackground(candidate, { transport, context: context() });
  // The URL's host must correspond to the actual corporate name, rather than an arbitrary public entity.
  assert.equal(result?.group.name, "Nimbus Corporation");
  assert.equal(result?.group.evidenceKind, "public-entity");
  assert.equal((await discoverEmployerBackground({ ...candidate, company: "Unrelated Employer" }, { transport, context: context() })), undefined);
});
