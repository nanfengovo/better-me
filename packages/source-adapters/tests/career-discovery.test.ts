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

test("installed company names and trusted aliases match first without network or enabling sources", async () => {
  const run = execution();
  const installed = { ...source(), sourceId: "installed-board", name: "Installed board", adapterId: "lever", enabled: false, status: "needs-review" as const,
    options: { companyName, boardToken: "synthetic" }, entryUrl: "https://api.lever.co/v0/postings/synthetic?mode=json" };
  run.registeredSources = [installed];
  run.companyAliases = { "installed-board": ["合成工业"] };
  const before = JSON.stringify(installed);
  const byName = await discoverCompanyCareers({ companyName: "  SYNTHETIC   Industries " }, run);
  assert.equal(byName.status, "matched-existing");
  assert.equal(byName.matchedSources[0]!.matchedBy, "company-name");
  assert.equal(byName.matchedSources[0]!.enabled, false);
  const byAlias = await discoverCompanyCareers({ companyName: "合成工业" }, run);
  assert.equal(byAlias.matchedSources[0]!.matchedBy, "company-alias");
  assert.equal(run.requests.length, 0);
  assert.equal(JSON.stringify(installed), before);
  assert.deepEqual(byAlias.candidates, []);
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
