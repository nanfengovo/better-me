import assert from "node:assert/strict";
import test from "node:test";
import { ToolError, type SourceDefinition } from "@better-me/opportunities";
import { CompanyCareerDiscoveryResultSchema, DiscoverCompanyCareersInputSchema } from "../src/career-discovery-contracts.js";
import { discoverCompanyCareers, type CompanyCareerDiscoveryExecution } from "../src/career-discovery.js";
import type { SourceAdapterContext, SourceTransportResponse } from "../src/contracts.js";

const observedAt = "2026-10-18T14:00:00.000Z";
function source(): SourceDefinition {
  return {
    sourceId: "synthetic-company-discovery", name: "Synthetic company discovery", adapterId: "source-discovery", adapterVersion: "1",
    capabilities: ["discover-sources"], runtime: ["local-service"], entityType: "company-directory", enabled: true, status: "active", remoteFilters: [],
    endpointPolicy: { allowedHosts: ["company.example.com"], allowedPathPrefixes: ["/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: "Synthetic discovery", usage: "link-only", requiresAttribution: true },
    refreshPolicy: { mode: "manual", minIntervalSeconds: 10, maxRecords: 100, maxPages: 10, requestsPerMinute: 20 },
  };
}
function execution(respond: (url: URL) => string | Partial<SourceTransportResponse> = () => "<html><body>No recruiting links</body></html>"):
  CompanyCareerDiscoveryExecution & { requests: string[]; cancel(): void; charged: { requests: number; bytes: number } } {
  const requests: string[] = [], charged = { requests: 0, bytes: 0 };
  const controller = new AbortController();
  const context: SourceAdapterContext = {
    requestId: "synthetic-career-discovery", observedAt, actorScope: "local", signal: controller.signal,
    budget: { requests: 20, bytes: 8_000_000, timeoutMs: 10_000 },
    consumeRequests(count = 1) { charged.requests += count; if (charged.requests > this.budget.requests) throw new ToolError("budget-exceeded"); },
    consumeBytes(bytes) { charged.bytes += bytes; if (charged.bytes > this.budget.bytes) throw new ToolError("budget-exceeded"); },
    throwIfCancelled() { if (controller.signal.aborted) throw new ToolError("cancelled"); },
  };
  return {
    source: source(), context, requests, charged, cancel() { controller.abort(); },
    transport: { async request(input) {
      assert.equal(input.context, context);
      assert.equal(input.source.sourceId, "synthetic-company-discovery");
      assert.equal(input.source.endpointPolicy.allowedHosts.includes(new URL(input.url).hostname), true, "No discovered URL may widen the installed endpoint policy.");
      input.context.throwIfCancelled(); input.context.consumeRequests(); requests.push(input.url);
      const value = respond(new URL(input.url));
      const response = { status: 200, url: input.url, headers: { "content-type": "text/html; charset=utf-8" }, text: "", ...(typeof value === "string" ? { text: value } : value) };
      input.context.consumeBytes(new TextEncoder().encode(response.text).byteLength);
      return response;
    } },
  };
}
function errorCode(code: string): (error: unknown) => boolean { return (error) => error instanceof ToolError && error.code === code; }
const companyName = "Synthetic Industries";
const companyWebsite = "https://company.example.com/";

test("a company name alone requires an explicit website and never guesses a domain or claims an empty job search", async () => {
  const run = execution();
  const result = await discoverCompanyCareers({ companyName }, run);
  assert.equal(result.status, "requires-company-website");
  assert.equal(result.candidates.length, 0);
  assert.equal(result.proposals.length, 0);
  assert.equal(result.partial, false);
  assert.equal(run.requests.length, 0);
  assert.ok(result.warnings.some((warning) => warning.includes("never guessed")));
  assert.equal(CompanyCareerDiscoveryResultSchema.safeParse(result).success, true);
});

test("inactive installed company names and trusted aliases remain visible without guessing or enabling sources", async () => {
  const run = execution();
  const installed = { ...source(), sourceId: "installed-board", name: "Installed board", adapterId: "lever", enabled: false, status: "needs-review" as const,
    options: { companyName, boardToken: "synthetic" }, entryUrl: "https://api.lever.co/v0/postings/synthetic?mode=json" };
  run.registeredSources = [installed];
  run.companyAliases = { "installed-board": ["合成工业"] };
  const before = JSON.stringify(installed);
  const byName = await discoverCompanyCareers({ companyName: "  SYNTHETIC   Industries " }, run);
  assert.equal(byName.status, "requires-company-website");
  assert.equal(byName.matchedSources[0]!.matchedBy, "company-name");
  assert.equal(byName.matchedSources[0]!.enabled, false);
  const byAlias = await discoverCompanyCareers({ companyName: "合成工业" }, run);
  assert.equal(byAlias.matchedSources[0]!.matchedBy, "company-alias");
  assert.equal(run.requests.length, 0);
  assert.equal(JSON.stringify(installed), before);
  assert.deepEqual(byAlias.candidates, []);
  assert.ok(byAlias.warnings.some((warning) => warning.includes("disabled")));
});

test("inactive installed matches do not authorize their stored URL, but an explicit website can continue bounded discovery", async () => {
  const run = execution(() => '<html><body><a href="/careers">Careers</a></body></html>');
  const installed = { ...source(), sourceId: "inactive-board", name: "Installed board", adapterId: "lever", enabled: false, status: "needs-review" as const,
    options: { companyName }, entryUrl: "https://api.lever.co/v0/postings/synthetic?mode=json" };
  run.registeredSources = [installed];
  const result = await discoverCompanyCareers({ companyName, companyWebsite }, run);
  assert.equal(result.status, "needs-review");
  assert.equal(result.matchedSources[0]!.sourceId, installed.sourceId);
  assert.deepEqual(run.requests, [companyWebsite, `${companyWebsite}careers`]);
  assert.equal(result.candidates[0]!.candidate.homeUrl, companyWebsite + "careers");
  assert.equal(result.proposals[0]!.source.enabled, false);
});

test("only enabled active existing matches retain the no-network priority, including mixed match lists", async () => {
  const active = { ...source(), sourceId: "active-board", name: "Active board", adapterId: "lever", enabled: true, status: "active" as const,
    options: { companyName }, entryUrl: "https://api.lever.co/v0/postings/active?mode=json" };
  const inactive = { ...active, sourceId: "inactive-board", name: "Inactive board", enabled: false, status: "unavailable" as const };
  const run = execution(); run.registeredSources = [inactive, active];
  const result = await discoverCompanyCareers({ companyName }, run);
  assert.equal(result.status, "matched-existing");
  assert.deepEqual(result.matchedSources.map(match => match.sourceId), [inactive.sourceId, active.sourceId]);
  assert.equal(run.requests.length, 0);
  assert.equal(result.proposals.length, 0);
});

test("each disabled or non-active match status continues only the explicit website policy", async () => {
  for (const [enabled, status] of [[false, "active"], [true, "disabled"], [true, "needs-review"], [true, "unavailable"]] as const) {
    const run = execution();
    const installed = { ...source(), sourceId: `inactive-${enabled}-${status}`, name: "Installed board", adapterId: "lever", enabled, status,
      options: { companyName }, entryUrl: "https://api.lever.co/v0/postings/synthetic?mode=json" };
    run.registeredSources = [installed]; const before = structuredClone(installed);
    const result = await discoverCompanyCareers({ companyName, companyWebsite }, run);
    assert.equal(result.matchedSources[0]!.enabled, enabled); assert.equal(result.matchedSources[0]!.status, status);
    assert.equal(result.status, "no-candidates"); assert.deepEqual(run.requests, [companyWebsite]);
    assert.deepEqual(installed, before); assert.equal(result.proposals.length, 0);
  }
});

test("inactive name-only matches continue through the trusted provider without authorizing stored endpoints", async () => {
  const run = execution();
  run.registeredSources = [{ ...source(), sourceId: "inactive-board", name: "Installed board", adapterId: "lever", enabled: false, status: "disabled",
    options: { companyName }, entryUrl: "https://api.lever.co/v0/postings/synthetic?mode=json" }];
  let calls = 0;
  run.searchProvider = { metadata: { providerId: "host-installed", label: "Synthetic search" }, async search(input) {
    calls++; assert.equal(input.companyName, companyName); assert.equal(input.source.sourceId, run.source.sourceId);
    assert.deepEqual(input.source.endpointPolicy.allowedHosts, run.source.endpointPolicy.allowedHosts); assert.equal(input.source.entryUrl, undefined); assert.equal(input.transport, run.transport);
    assert.equal(input.source.endpointPolicy.allowedHosts.includes("api.lever.co"), false);
    return { results: [{ url: "https://jobs.lever.co/synthetic", title: "Careers" }], partial: false };
  } };
  const result = await discoverCompanyCareers({ companyName }, run);
  assert.equal(calls, 1); assert.equal(run.requests.length, 0); assert.equal(result.status, "needs-review");
  assert.equal(result.matchedSources[0]!.sourceId, "inactive-board"); assert.equal(result.candidates[0]!.companyAssociation, "unverified");
  assert.equal(result.proposals[0]!.source.enabled, false); assert.equal(result.proposals[0]!.source.status, "needs-review");
});

test("shared ATS hosts never match a different installed company's board by hostname", async () => {
  const run = execution();
  run.registeredSources = [{ ...source(), sourceId: "different-board", name: "Different company", adapterId: "lever",
    options: { companyName: "Other Company", boardToken: "other" }, attribution: { label: "Other", homepageUrl: "https://jobs.lever.co/other", usage: "link-only", requiresAttribution: true } }];
  const result = await discoverCompanyCareers({ companyName, companyWebsite: "https://jobs.lever.co/synthetic" }, run);
  assert.equal(result.matchedSources.length, 0);
  assert.equal(result.candidates[0]!.entryKind, "lever");
  assert.equal(run.requests.length, 0);
});

test("a discovery-policy with matching company name, alias and website remains an access policy rather than an existing recruiting source", async () => {
  const run = execution(() => '<html><a href="https://jobs.lever.co/synthetic">Careers</a></html>');
  const policy = { ...source(), adapterId: "discovery-policy", name: companyName, entryUrl: companyWebsite,
    options: { companyName }, attribution: { ...source().attribution, homepageUrl: companyWebsite } };
  run.source = policy; run.registeredSources = [policy]; run.companyAliases = { [policy.sourceId]: ["Synthetic alias"] };
  const nameOnly = await discoverCompanyCareers({ companyName }, run);
  const aliasOnly = await discoverCompanyCareers({ companyName: "Synthetic alias" }, run);
  assert.equal(nameOnly.status, "requires-company-website"); assert.equal(aliasOnly.status, "requires-company-website");
  assert.deepEqual(nameOnly.matchedSources, []); assert.deepEqual(aliasOnly.matchedSources, []); assert.deepEqual(run.requests, []);
  const website = await discoverCompanyCareers({ companyName, companyWebsite }, run);
  assert.equal(website.status, "needs-review"); assert.deepEqual(website.matchedSources, []);
  assert.deepEqual(run.requests, [companyWebsite]); assert.equal(website.candidates[0]!.entryKind, "lever");
});

test("a shared repository host cannot match another company's source solely by host", async () => {
  const run = execution();
  run.registeredSources = [{ ...source(), sourceId: "other-github-source", name: "Other project", options: { companyName: "Other Company" },
    attribution: { label: "Other project", homepageUrl: "https://github.com/other/jobs", usage: "link-only", requiresAttribution: true } }];
  const result = await discoverCompanyCareers({ companyName, seedUrls: ["https://jobs.lever.co/synthetic"] }, run);
  assert.equal(result.matchedSources.length, 0);
  run.source.endpointPolicy.allowedHosts = ["github.com"];
  const repository = await discoverCompanyCareers({ companyName, companyWebsite: "https://github.com/synthetic/jobs" }, run);
  assert.equal(repository.matchedSources.length, 0);
  assert.equal(repository.status, "needs-review");
  assert.equal(repository.candidates[0]!.candidate.homeUrl, "https://github.com/synthetic/jobs");
});

test("same-site static HTML discovery is bounded, deduplicates board links and preserves evidence", async () => {
  const run = execution((url) => url.pathname === "/" ? `<html><body>
    <a href="/about">About</a><a href="/careers?lang=en&amp;team=engineering">Careers &amp; jobs</a>
    <a href="https://jobs.lever.co/synthetic/abc123">Open engineering role</a>
    <a href="https://jobs.lever.co/synthetic">Join us</a>
  </body></html>` : `<html><a href="https://jobs.ashbyhq.com/synthetic">招聘</a><a href="/">Home</a></html>`);
  const before = JSON.stringify(run.source);
  const result = await discoverCompanyCareers({ companyName, companyWebsite }, run);
  assert.equal(result.status, "needs-review");
  assert.deepEqual(run.requests, [companyWebsite, "https://company.example.com/careers?lang=en&team=engineering"]);
  assert.equal(run.charged.requests, 2);
  assert.ok(run.charged.bytes > 0);
  assert.equal(result.candidates.length, 3);
  const lever = result.candidates.find((entry) => entry.entryKind === "lever")!;
  assert.equal(lever.candidate.homeUrl, "https://jobs.lever.co/synthetic");
  assert.equal(lever.evidence.length, 2);
  assert.equal(lever.evidence[0]!.sourceUrl, companyWebsite);
  assert.equal(lever.companyAssociation, "unverified");
  assert.equal(result.proposals.every((proposal) => !proposal.source.enabled && proposal.source.status === "needs-review"), true);
  assert.equal(JSON.stringify(run.source), before);
  assert.equal(JSON.stringify(result).includes("availabilityVerifiedAt"), false);
});

test("recognized Greenhouse, Lever, Ashby and Tencent entries generate existing inert registration proposals without requesting ATS endpoints", async () => {
  const run = execution();
  const result = await discoverCompanyCareers({ companyName, seedUrls: [
    "https://job-boards.greenhouse.io/synthetic/jobs/123", "https://boards.greenhouse.io/synthetic-old",
    "https://jobs.lever.co/synthetic", "https://jobs.ashbyhq.com/synthetic", "https://careers.tencent.com/search.html",
  ] }, run);
  assert.equal(run.requests.length, 0);
  assert.deepEqual(result.candidates.map((item) => item.entryKind), ["greenhouse", "greenhouse", "lever", "ashby", "tencent"]);
  for (const proposal of result.proposals) {
    assert.equal(proposal.schemaVersion, 1);
    assert.equal(proposal.source.enabled, false);
    assert.equal(proposal.source.status, "needs-review");
    assert.equal(proposal.source.attribution.usage, "link-only");
    assert.deepEqual(proposal.source.capabilities, ["list-jobs"]);
    assert.equal(proposal.source.endpointPolicy.allowedHosts.length, 1);
    assert.equal(proposal.source.endpointPolicy.allowRedirects, false);
    assert.ok(proposal.reviewRequired.some((warning) => warning.includes("companyName")));
  }
  const tencent = result.proposals.find((proposal) => proposal.source.adapterId === "tencent")!.source;
  assert.equal(tencent.options!.fetchDetails, false);
  assert.deepEqual(tencent.endpointPolicy.allowedPathPrefixes, ["/tencentcareer/api/post/Query"]);
  assert.deepEqual(tencent.remoteFilters, ["roles"]);
});

test("SmartRecruiters career seeds create one disabled company-scoped proposal without requesting the ATS", async () => {
  const run = execution(), before = structuredClone(run.source), tenant = "Synthetic-Industries";
  const result = await discoverCompanyCareers({ companyName, seedUrls: [
    `https://CAREERS.SMARTRECRUITERS.COM/${tenant}/`,
    `https://jobs.smartrecruiters.com/${tenant}/123456-synthetic-role?ref=careers`,
  ] }, run);
  assert.equal(run.requests.length, 0); assert.equal(run.charged.requests, 0); assert.equal(result.status, "needs-review");
  assert.equal(result.candidates.length, 1); assert.equal(result.proposals.length, 1);
  const candidate = result.candidates[0]!;
  assert.equal(candidate.entryKind, "smartrecruiters"); assert.equal(candidate.companyAssociation, "unverified");
  assert.equal(candidate.candidate.homeUrl, `https://careers.smartrecruiters.com/${tenant}`);
  assert.equal(candidate.evidence.length, 2); assert.deepEqual(candidate.candidate.entryHints, [{ url: `https://api.smartrecruiters.com/v1/companies/${tenant}/postings`, format: "json" }]);
  const proposal = result.proposals[0]!, configured = proposal.source;
  assert.equal(configured.adapterId, "smartrecruiters"); assert.equal(configured.adapterVersion, "1");
  assert.equal(configured.enabled, false); assert.equal(configured.status, "needs-review"); assert.equal(configured.entityType, "job-posting");
  assert.equal(configured.entryUrl, `https://api.smartrecruiters.com/v1/companies/${tenant}/postings`);
  assert.deepEqual(configured.options, { companyName, companyIdentifier: tenant, pageSize: 20, fetchDetails: true, maxDetailRequestsPerPage: 2 });
  assert.deepEqual(configured.endpointPolicy, { allowedHosts: ["api.smartrecruiters.com"], allowedPathPrefixes: [`/v1/companies/${tenant}/postings`], requireHttps: true, allowRedirects: false, maxRedirects: 0 });
  assert.deepEqual(configured.capabilities, ["list-jobs"]); assert.deepEqual(configured.remoteFilters, ["roles"]);
  assert.equal(configured.attribution.usage, "link-only"); assert.equal(configured.attribution.homepageUrl, candidate.candidate.homeUrl);
  assert.ok(proposal.reviewRequired.some(warning => warning.includes("companyName")));
  assert.deepEqual(run.source, before); assert.equal(CompanyCareerDiscoveryResultSchema.safeParse(result).success, true);
});

test("a company HTML SmartRecruiters link keeps original anchor evidence and does not expand discovery network scope", async () => {
  const tenant = "SyntheticIndustries", destination = `https://jobs.smartrecruiters.com/${tenant}/123456-example`;
  const run = execution(() => `<html><body><a href="${destination}">查看我们的技术招聘岗位</a></body></html>`), before = structuredClone(run.source);
  const result = await discoverCompanyCareers({ companyName, companyWebsite }, run);
  assert.deepEqual(run.requests, [companyWebsite]); assert.deepEqual(result.visitedUrls, [companyWebsite]);
  assert.equal(result.candidates.length, 1); const candidate = result.candidates[0]!;
  assert.equal(candidate.entryKind, "smartrecruiters"); assert.equal(candidate.matchedBy, "career-link"); assert.equal(candidate.companyAssociation, "unverified");
  assert.deepEqual(candidate.evidence, [{ kind: "html-link", sourceUrl: companyWebsite, targetUrl: destination, quote: "查看我们的技术招聘岗位" }]);
  assert.equal(candidate.candidate.homeUrl, `https://careers.smartrecruiters.com/${tenant}`);
  assert.equal(result.proposals[0]!.source.options!.companyIdentifier, tenant);
  assert.equal(result.proposals[0]!.source.options!.fetchDetails, true);
  assert.equal(result.proposals[0]!.source.options!.maxDetailRequestsPerPage, 2);
  assert.equal(result.proposals[0]!.source.enabled, false); assert.equal(result.proposals[0]!.source.status, "needs-review");
  assert.deepEqual(run.source, before); assert.equal(run.source.endpointPolicy.allowedHosts.includes("api.smartrecruiters.com"), false);
});

test("SmartRecruiters shared hosts cannot identify another company or match an unrelated installed tenant", async () => {
  const installed: SourceDefinition = { ...source(), sourceId: "other-smartrecruiters", name: "Other employer", adapterId: "smartrecruiters",
    options: { companyName: "Other Employer", companyIdentifier: "OtherTenant" }, entryUrl: "https://api.smartrecruiters.com/v1/companies/OtherTenant/postings",
    attribution: { label: "Other employer", homepageUrl: "https://careers.smartrecruiters.com/OtherTenant", usage: "link-only", requiresAttribution: true } };
  const run = execution(); run.registeredSources = [installed];
  const result = await discoverCompanyCareers({ companyName, seedUrls: ["https://careers.smartrecruiters.com/SyntheticTenant"] }, run);
  assert.equal(result.matchedSources.length, 0); assert.equal(result.candidates[0]!.entryKind, "smartrecruiters"); assert.equal(run.requests.length, 0);
  for (const host of ["careers.smartrecruiters.com", "jobs.smartrecruiters.com", "api.smartrecruiters.com"]) {
    const root = execution(); root.source.endpointPolicy.allowedHosts = [host];
    root.registeredSources = [{ ...installed, attribution: { ...installed.attribution, homepageUrl: `https://${host}/` } }];
    const rootResult = await discoverCompanyCareers({ companyName, companyWebsite: `https://${host}/` }, root);
    assert.equal(rootResult.matchedSources.length, 0, `shared root ${host} is not employer ownership evidence`);
    assert.equal(rootResult.status, "no-candidates"); assert.deepEqual(root.requests, [`https://${host}/`]);
  }
});

test("SmartRecruiters existing-source matching uses the exact companyIdentifier and preserves tenant case", async () => {
  const run = execution(), tenant = "SyntheticIndustries";
  const installed: SourceDefinition = { ...source(), sourceId: "installed-smartrecruiters", name: "Custom saved label", adapterId: "smartrecruiters", enabled: false, status: "needs-review",
    options: { companyName: "Saved unrelated label", companyIdentifier: tenant }, entryUrl: `https://api.smartrecruiters.com/v1/companies/${tenant}/postings` };
  run.registeredSources = [installed]; const before = structuredClone(installed);
  for (const seed of [`https://careers.smartrecruiters.com/${tenant}`, `https://JOBS.SMARTRECRUITERS.COM/${tenant}/123456-role`]) {
    const result = await discoverCompanyCareers({ companyName, seedUrls: [seed] }, run);
    assert.equal(result.status, "needs-review"); assert.equal(result.matchedSources[0]!.sourceId, installed.sourceId);
    assert.equal(result.matchedSources[0]!.matchedBy, "entry-url"); assert.equal(result.matchedSources[0]!.enabled, false);
    assert.equal(result.candidates[0]!.entryKind, "smartrecruiters"); assert.equal(result.proposals.length, 1); assert.equal(result.proposals[0]!.source.enabled, false); assert.equal(run.requests.length, 0);
  }
  const differentCase = await discoverCompanyCareers({ companyName, seedUrls: [`https://careers.smartrecruiters.com/${tenant.toLowerCase()}`] }, run);
  assert.equal(differentCase.matchedSources.length, 0); assert.equal(differentCase.proposals[0]!.source.options!.companyIdentifier, tenant.toLowerCase());
  assert.deepEqual(installed, before); assert.equal(run.requests.length, 0);
});

test("SmartRecruiters escaped, dot and lookalike paths never acquire executable company-scoped proposals", async () => {
  const roots = [
    "https://careers.smartrecruiters.com/Synthetic%2fOther", "https://careers.smartrecruiters.com/Synthetic%252fOther",
    "https://careers.smartrecruiters.com/Synthetic/../Other", "https://careers.smartrecruiters.com/Synthetic/%2e%2e/Other",
    "https://jobs.smartrecruiters.com/Synthetic%5cOther/123", "https://careers.smartrecruiters.com.evil.example.com/Other",
    "https://notcareers.smartrecruiters.com/Other",
  ];
  for (const destination of roots) {
    const run = execution(() => `<html><body><a href="${destination}">Careers</a></body></html>`);
    const before = structuredClone(run.source);
    const result = await discoverCompanyCareers({ companyName, companyWebsite }, run);
    assert.ok(result.proposals.every(proposal => proposal.source.adapterId !== "smartrecruiters"), `Unsafe URL obtained an ATS proposal: ${destination}`);
    assert.ok(result.proposals.every(proposal => !proposal.source.enabled)); assert.deepEqual(run.requests, [companyWebsite]);
    assert.deepEqual(run.source, before);
  }
});

test("HTML career entries have no fake runnable generic parser", async () => {
  const run = execution(() => '<html><a href="/careers">Careers</a></html>');
  const result = await discoverCompanyCareers({ companyName, companyWebsite, maxPages: 1 }, run);
  const source = result.proposals[0]!.source;
  assert.equal(source.adapterId, "review-required-html");
  assert.deepEqual(source.capabilities, []);
  assert.equal(source.entityType, "company-directory");
  assert.equal(source.options, undefined);
  assert.ok(result.proposals[0]!.reviewRequired.some((warning) => warning.includes("no installed generic parser")));
  assert.equal(result.partial, true);
  assert.equal(run.requests.length, 1);
});

test("cross-host career and ATS links are evidence only and do not silently widen the endpoint policy", async () => {
  const run = execution(() => `<html>
    <a href="https://careers.external.example.com/">Careers</a>
    <a href="https://jobs.ashbyhq.com/synthetic">View jobs</a>
    <a href="https://company.example.com.evil.example.com/careers">Join us</a>
  </html>`);
  const result = await discoverCompanyCareers({ companyName, companyWebsite }, run);
  assert.deepEqual(run.requests, [companyWebsite]);
  assert.equal(result.candidates.length, 3);
  assert.ok(result.candidates.every((item) => item.companyAssociation === "unverified"));
  assert.ok(result.warnings.some((warning) => warning.includes("External career links")));
  assert.deepEqual(run.source.endpointPolicy.allowedHosts, ["company.example.com"]);
});

test("scripts, inert template links, private hosts, unsafe schemes and credential URLs cannot become candidates", async () => {
  const run = execution(() => `<html>
    <script>const fake='<a href="https://jobs.lever.co/script">Careers</a>';</script>
    <template><a href="https://jobs.lever.co/template">Careers</a></template>
    <template><template>Nested</template><a href="https://jobs.lever.co/nested-template">Jobs</a></template>
    <iframe><a href="https://jobs.lever.co/iframe">Careers</a></iframe>
    <textarea><a href="https://jobs.lever.co/textarea">Careers</a></textarea>
    <div data-copy='<a href="https://jobs.lever.co/attribute">Careers</a>'>Text</div>
    <!-- <a href="https://jobs.lever.co/comment">Careers</a> -->
    <a href="javascript:alert(1)">Careers</a><a href="data:text/html,test">Jobs</a>
    <a href="https://127.0.0.1/careers">Careers</a><a href="https://[::1]/jobs">Jobs</a>
    <a href="https://recruit.internal/careers">Careers</a>
    <a href="https://user:password@jobs.lever.co/credentials">Jobs</a>
    <a href="&#106;avascript:alert(1)">Jobs</a>
    <a data-description='href="https://jobs.lever.co/quoted-attribute"' href="https://jobs.lever.co/safe">Careers</a>
  </html>`);
  const result = await discoverCompanyCareers({ companyName, companyWebsite }, run);
  assert.deepEqual(result.candidates.map((item) => item.candidate.homeUrl), ["https://jobs.lever.co/safe"]);
  assert.equal(run.requests.length, 1);
});

test("large inert metadata before static career navigation is skipped without becoming a source or scope", async () => {
  const metadata = `<MeTa name="synthetic.wizard.configuration" content="${"&quot;configuration&quot;:true,".repeat(600)}"/>`;
  const run = execution(() => `<html><head>${metadata}</head><body><a href="https://jobs.lever.co/visible-navigation">All Jobs</a></body></html>`);
  const result = await discoverCompanyCareers({ companyName, companyWebsite, maxPages: 1 }, run);
  assert.equal(result.status, "needs-review");
  assert.deepEqual(result.candidates.map(item => item.candidate.homeUrl), ["https://jobs.lever.co/visible-navigation"]);
  assert.equal(result.candidates[0]!.evidence[0]!.quote, "All Jobs");
  assert.equal(result.partial, false);
  assert.equal(result.warnings.some(warning => warning.includes("anchor scan limit")), false);
  assert.deepEqual(run.requests, [companyWebsite]);
  assert.ok(result.proposals.every(proposal => !proposal.source.enabled && proposal.source.status === "needs-review"));
});

test("meta skipping honors an exact 64K UTF-16 code-unit total tag length and preserves ordinary tag limits", async () => {
  const opening = '<meta content="', closing = '">';
  for (const character of ["x", "中"]) for (const length of [64 * 1024 - 1, 64 * 1024, 64 * 1024 + 1]) {
    const metadata = opening + character.repeat(length - opening.length - closing.length) + closing;
    assert.equal(metadata.length, length);
    const run = execution(() => `<html>${metadata}<a href="https://jobs.lever.co/after-boundary">Jobs</a></html>`);
    const result = await discoverCompanyCareers({ companyName, companyWebsite, maxPages: 1 }, run);
    assert.equal(result.candidates.length, length <= 64 * 1024 ? 1 : 0, `Total meta tag length ${length}`);
    assert.equal(result.partial, length > 64 * 1024);
    assert.equal(result.warnings.some(warning => warning.includes("anchor scan limit")), length > 64 * 1024);
  }
  for (const prefix of ["<metadata", "<metax", "<meta:configuration", "< meta", "</meta", "<a", "<div", "<link"]) {
    const run = execution(() => `<html>${prefix} data-copy="${"x".repeat(9000)}"><a href="https://jobs.lever.co/after-ordinary-limit">Jobs</a></html>`);
    const result = await discoverCompanyCareers({ companyName, companyWebsite, maxPages: 1 }, run);
    assert.deepEqual(result.candidates, [], prefix);
    assert.equal(result.partial, true, prefix);
    assert.ok(result.warnings.some(warning => warning.includes("anchor scan limit")), prefix);
  }
});

test("quoted meta contents, hrefs and encoded pseudo anchors never become candidates or evidence text", async () => {
  const fake = "<a href='https://jobs.lever.co/from-meta'>Forged Jobs</a> > </template> <div hidden>";
  for (const metadata of [
    `<meta name="configuration" href="https://jobs.lever.co/meta-href" content="${"x".repeat(9000)}${fake}">`,
    `<meta content='${"x".repeat(9000)}<a href="https://jobs.lever.co/from-single-quote">Jobs</a> >'>`,
    `<meta content="${"x".repeat(9000)}&quot;&gt;&lt;a href=&quot;https://jobs.lever.co/from-entity&quot;&gt;Jobs&lt;/a&gt;">`,
  ]) {
    const run = execution(() => `<html><a href="https://jobs.lever.co/visible-label">Visible label${metadata} after metadata</a><a href="https://jobs.lever.co/after-meta">Actual Jobs</a></html>`);
    const result = await discoverCompanyCareers({ companyName, companyWebsite, maxPages: 1 }, run);
    assert.deepEqual(result.candidates.map(item => item.candidate.homeUrl), ["https://jobs.lever.co/visible-label", "https://jobs.lever.co/after-meta"]);
    assert.equal(result.candidates[0]!.evidence[0]!.quote, "Visible label after metadata");
    assert.equal(result.candidates[1]!.evidence[0]!.quote, "Actual Jobs");
    assert.equal(result.partial, false);
    assert.deepEqual(run.requests, [companyWebsite]);
  }
});

test("incomplete or oversized metadata remains partial and cannot expose following pseudo anchors", async () => {
  for (const malformed of [
    `<meta content="${"x".repeat(9000)}<a href='https://jobs.lever.co/incomplete'>Jobs</a>`,
    `<meta content='${"x".repeat(9000)}<a href="https://jobs.lever.co/incomplete-single">Jobs</a>`,
    `<meta content="${"x".repeat(9000)}"`,
    `<meta content="${"x".repeat(64 * 1024)}"><a href="https://jobs.lever.co/after-oversized">Jobs</a>`,
  ]) {
    const run = execution(() => `<html>${malformed}`);
    const result = await discoverCompanyCareers({ companyName, companyWebsite, maxPages: 1 }, run);
    assert.equal(result.status, "no-candidates"); assert.deepEqual(result.candidates, []); assert.equal(result.partial, true);
    assert.ok(result.warnings.some(warning => warning.includes("anchor scan limit")));
  }
});

test("metadata skips cannot escape existing raw or inert subtrees, including self-closing non-void tags", async () => {
  const metadata = `<meta content="${"x".repeat(9000)} > </template> <a href='https://jobs.lever.co/meta-fake'>Jobs</a>">`;
  for (const tag of ["script", "style", "textarea", "title", "xmp", "template", "noscript", "iframe", "object"]) {
    for (const slash of ["", "/"]) {
      const run = execution(() => `<html><${tag}${slash}>${metadata}<a href="https://jobs.lever.co/inert-fake">Jobs</a></${tag}><a href="https://jobs.lever.co/visible-after-block">Jobs</a></html>`);
      const result = await discoverCompanyCareers({ companyName, companyWebsite, maxPages: 1 }, run);
      assert.deepEqual(result.candidates.map(item => item.candidate.homeUrl), ["https://jobs.lever.co/visible-after-block"], `${tag}${slash}`);
      assert.equal(result.partial, false);
    }
  }
  const plaintext = execution(() => `<html><plaintext>${metadata}<a href="https://jobs.lever.co/plaintext-fake">Jobs</a></plaintext>`);
  assert.deepEqual((await discoverCompanyCareers({ companyName, companyWebsite }, plaintext)).candidates, []);
});

test("large metadata does not lift page bytes, tag count, cancellation or per-page endpoint limits", async () => {
  const metadata = `<meta content="${"x".repeat(9000)}">`;
  const tags = execution(() => `<html>${"<meta>".repeat(10_000)}<a href="https://jobs.lever.co/after-many-tags">Jobs</a></html>`);
  const tagResult = await discoverCompanyCareers({ companyName, companyWebsite, maxPages: 1 }, tags);
  assert.deepEqual(tagResult.candidates, []); assert.equal(tagResult.partial, true);
  const bytes = execution(() => `<html><meta content="${"x".repeat(2 * 1024 * 1024)}"></html>`);
  await assert.rejects(discoverCompanyCareers({ companyName, companyWebsite }, bytes), errorCode("budget-exceeded"));
  const cancelled = execution(() => { cancelled.cancel(); return `<html>${metadata}<a href="/careers">Jobs</a></html>`; });
  await assert.rejects(discoverCompanyCareers({ companyName, companyWebsite }, cancelled), errorCode("cancelled"));
  assert.equal(cancelled.requests.length, 1);
  const page = execution(() => `<html>${metadata}<a href="/careers">Jobs</a><a href="https://outside.example.com/careers">Careers</a></html>`);
  const result = await discoverCompanyCareers({ companyName, companyWebsite, maxPages: 1 }, page);
  assert.equal(result.candidates.length, 2); assert.equal(result.partial, true); assert.deepEqual(page.requests, [companyWebsite]);
  assert.deepEqual(page.source.endpointPolicy.allowedHosts, ["company.example.com"]);
});

test("script-only and metadata-only career URLs still return no candidates rather than invented job coverage", async () => {
  const run = execution(() => `<html><head><meta content="${"x".repeat(9000)} https://jobs.lever.co/metadata-only"></head><body><script>const careers = 'https://jobs.lever.co/script-only';</script></body></html>`);
  const result = await discoverCompanyCareers({ companyName, companyWebsite, maxPages: 1 }, run);
  assert.equal(result.status, "no-candidates"); assert.deepEqual(result.candidates, []); assert.deepEqual(result.proposals, []);
  assert.ok(result.warnings.some(warning => warning.includes("JavaScript-rendered")));
  assert.equal("totalJobs" in result, false); assert.deepEqual(run.requests, [companyWebsite]);
});

test("explicit unsafe sites reject before transport and endpoint restrictions remain in force", async () => {
  for (const companyWebsite of ["https://127.0.0.1/careers", "https://user:password@company.example.com/", "http://company.example.com/", "https://company.example.com:8080/"]) {
    const run = execution();
    await assert.rejects(discoverCompanyCareers({ companyName, companyWebsite }, run), errorCode("invalid-input"));
    assert.equal(run.requests.length, 0);
  }
  const disallowed = execution();
  await assert.rejects(discoverCompanyCareers({ companyName, companyWebsite: "https://unconfigured.example.com/" }, disallowed), errorCode("not-authorized"));
  assert.equal(disallowed.requests.length, 0);
  const limited = execution(() => '<html><a href="/outside/careers">Careers</a></html>');
  limited.source.endpointPolicy.allowedPathPrefixes = ["/allowed"];
  const result = await discoverCompanyCareers({ companyName, companyWebsite: "https://company.example.com/allowed" }, limited);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.partial, true);
  assert.equal(limited.requests.length, 1);
});

test("bounded pages and candidates report partial coverage without inventing pagination or job counts", async () => {
  const run = execution(() => '<html><a href="/careers">Careers</a><a href="https://jobs.lever.co/one">Jobs</a><a href="https://jobs.lever.co/two">Jobs</a></html>');
  const result = await discoverCompanyCareers({ companyName, companyWebsite, maxPages: 1, limit: 1 }, run);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.partial, true);
  assert.equal(result.visitedUrls.length, 1);
  assert.ok(result.warnings.some((warning) => warning.includes("Candidate limit")));
  assert.ok(result.warnings.some((warning) => warning.includes("Page limit")));
  assert.equal("totalJobs" in result, false);
  assert.equal(DiscoverCompanyCareersInputSchema.safeParse({ companyName, maxPages: 11 }).success, false);
});

test("a host-injected search provider returns unverified candidates and receives the same controlled transport/context", async () => {
  const run = execution();
  let called = 0;
  run.searchProvider = { async search(input) {
    called++;
    assert.equal(input.companyName, companyName);
    assert.equal(input.query, `${companyName} official careers 招聘`);
    assert.equal(input.context, run.context);
    assert.equal(input.transport, run.transport);
    assert.deepEqual(input.source.endpointPolicy.allowedHosts, ["company.example.com"]);
    return { results: [{ url: "https://jobs.lever.co/synthetic", title: "Careers", evidenceUrl: "https://search.example.com/results?q=synthetic" },
      { url: "https://127.0.0.1/jobs", title: "Unsafe" }], partial: false };
  } };
  const result = await discoverCompanyCareers({ companyName }, run);
  assert.equal(called, 1);
  assert.equal(run.requests.length, 0);
  assert.equal(result.status, "needs-review");
  assert.equal(result.partial, true);
  assert.equal(result.candidates[0]!.matchedBy, "search-result");
  assert.equal(result.candidates[0]!.evidence[0]!.sourceUrl, "https://search.example.com/results?q=synthetic");
  assert.equal(result.candidates[0]!.companyAssociation, "unverified");
  run.searchProvider = { async search() { return { results: [{ url: "javascript:evil" }], partial: false }; } };
  await assert.rejects(discoverCompanyCareers({ companyName }, run), errorCode("source-changed"));
});

test("cancellation, source capability, auth, rate and byte budgets remain explicit failures", async () => {
  const cancelled = execution(); cancelled.cancel();
  await assert.rejects(discoverCompanyCareers({ companyName, companyWebsite }, cancelled), errorCode("cancelled"));
  assert.equal(cancelled.requests.length, 0);
  const disabled = execution(); disabled.source.enabled = false;
  await assert.rejects(discoverCompanyCareers({ companyName }, disabled), errorCode("not-authorized"));
  const incapable = execution(); incapable.source.capabilities = ["list-jobs"];
  await assert.rejects(discoverCompanyCareers({ companyName }, incapable), errorCode("unsupported-capability"));
  for (const [status, code] of [[429, "rate-limited"], [403, "needs-auth"], [500, "source-changed"]] as const) {
    await assert.rejects(discoverCompanyCareers({ companyName, companyWebsite }, execution(() => ({ status }))), errorCode(code));
  }
  const bytes = execution(() => "<html>" + "x".repeat(2 * 1024 * 1024) + "</html>");
  await assert.rejects(discoverCompanyCareers({ companyName, companyWebsite }, bytes), errorCode("budget-exceeded"));
  const redirect = execution(() => ({ url: "https://different.example.com/careers", text: "<html></html>" }));
  await assert.rejects(discoverCompanyCareers({ companyName, companyWebsite }, redirect), errorCode("not-authorized"));
});

test("transport request budgets and cancellation after a response stop bounded follow-up reads", async () => {
  const limited = execution(() => '<html><a href="/careers">Careers</a></html>');
  limited.context = { ...limited.context, consumeRequests() { throw new ToolError("budget-exceeded"); } };
  limited.transport = { async request(input) { input.context.consumeRequests(); throw new Error("unreachable"); } };
  await assert.rejects(discoverCompanyCareers({ companyName, companyWebsite }, limited), errorCode("budget-exceeded"));
  const cancelled = execution(() => { cancelled.cancel(); return '<html><a href="/careers">Careers</a></html>'; });
  await assert.rejects(discoverCompanyCareers({ companyName, companyWebsite }, cancelled), errorCode("cancelled"));
  assert.equal(cancelled.requests.length, 1);
});
