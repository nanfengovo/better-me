import assert from "node:assert/strict";
import test from "node:test";
import { ToolError, type SourceDefinition } from "@better-me/opportunities";
import { createCareerWebSearchProvider, CareerWebSearchConfigSchema } from "../src/career-web-search.js";
import { discoverCompanyCareers } from "../src/career-discovery.js";
import type { SourceAdapterContext, SourceTransport, SourceTransportResponse } from "../src/contracts.js";

const observedAt = "2026-10-19T00:00:00.000Z";
const callerPolicy: SourceDefinition = {
  sourceId: "synthetic-discovery", name: "Synthetic company discovery", adapterId: "source-discovery", adapterVersion: "1",
  capabilities: ["discover-sources"], runtime: ["local-service"], entityType: "company-directory", enabled: true, status: "active", remoteFilters: [],
  endpointPolicy: { allowedHosts: [], allowedPathPrefixes: [], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
  attribution: { label: "Synthetic", usage: "link-only", requiresAttribution: true },
  refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 20, maxPages: 1, requestsPerMinute: 10 },
};
const html = (contents: string) => `<!doctype html><html><body>${contents}</body></html>`;
function result(url: string, title = "Synthetic engineering careers", snippet = "Original public search excerpt") {
  const link = `//duckduckgo.com/l/?uddg=${encodeURIComponent(url)}&amp;rut=synthetic`;
  return `<h2><a class="result__a" href="${link}">${title}</a></h2><a class="result__url" href="${link}">display URL</a><a class="result__snippet" href="${link}">${snippet}</a>`;
}
function execution(respond: (input: Parameters<SourceTransport["request"]>[0]) => Partial<SourceTransportResponse> | Promise<Partial<SourceTransportResponse>> = () => ({ text: html(result("https://jobs.lever.co/synthetic")) })) {
  const requests: Parameters<SourceTransport["request"]>[0][] = [];
  const controller = new AbortController();
  const context: SourceAdapterContext = {
    requestId: "synthetic-search", actorScope: "local", observedAt, signal: controller.signal,
    budget: { requests: 5, bytes: 4 * 1024 * 1024, timeoutMs: 1000 },
    throwIfCancelled() { if (controller.signal.aborted) throw new ToolError("cancelled"); }, consumeRequests() {}, consumeBytes() {},
  };
  const transport: SourceTransport = { async request(input) {
    requests.push(input);
    return { status: 200, url: input.url, headers: { "content-type": "text/html; charset=utf-8" }, text: "", ...await respond(input) };
  } };
  return { requests, controller, context, transport, source: callerPolicy };
}
const code = (expected: string) => (error: unknown) => error instanceof ToolError && error.code === expected;
const search = (run: ReturnType<typeof execution>, provider = createCareerWebSearchProvider({ provider: "duckduckgo-html" }), limit = 10) => provider.search({ ...run, query: "Synthetic & Co official careers 招聘", companyName: "Synthetic & Co", limit });

test("search configuration is host-owned, strict and never accepts URL credentials or private endpoints", () => {
  assert.equal(CareerWebSearchConfigSchema.safeParse({ provider: "duckduckgo-html" }).success, true);
  assert.equal(CareerWebSearchConfigSchema.safeParse({ provider: "searxng", endpoint: "https://search.example.com/search" }).success, true);
  for (const endpoint of ["http://search.example.com/search", "https://127.0.0.1/search", "https://localhost/search", "https://search.example.com:444/search", "https://user:key@search.example.com/search", "https://search.example.com/search?key=private", "https://search.example.com/search#token", "https://search.example.com./search", "https://search.invalid/search", "https://search.example.com/%255csecret", "https://search.example.com/\nsearch"]) {
    assert.equal(CareerWebSearchConfigSchema.safeParse({ provider: "searxng", endpoint }).success, false, endpoint);
  }
  assert.equal(CareerWebSearchConfigSchema.safeParse({ provider: "duckduckgo-html", endpoint: "https://other.example.com" }).success, false);
  assert.equal(CareerWebSearchConfigSchema.safeParse({ provider: "searxng", endpoint: "https://search.example.com/search", apiKey: "synthetic-secret" }).success, false);
});

test("DDG performs one bounded host-policy request and preserves title, related snippet and query evidence", async () => {
  const run = execution(() => ({ text: html(result("https://jobs.lever.co/synthetic", "Synthetic <b>careers</b>", "Original &amp; <b>public</b> excerpt")) }));
  const value = await search(run) as { results: { url: string; title: string; snippet: string; evidenceUrl: string }[]; partial: boolean };
  assert.equal(run.requests.length, 1);
  const sent = run.requests[0]!;
  assert.equal(new URL(sent.url).searchParams.get("q"), "Synthetic & Co official careers 招聘");
  assert.deepEqual(sent.source.endpointPolicy.allowedHosts, ["html.duckduckgo.com"]);
  assert.deepEqual(sent.source.endpointPolicy.allowedPathPrefixes, ["/html/"]);
  assert.equal(sent.source.endpointPolicy.allowRedirects, false);
  assert.equal(callerPolicy.endpointPolicy.allowedHosts.length, 0);
  assert.deepEqual(value.results, [{ url: "https://jobs.lever.co/synthetic", title: "Synthetic careers", snippet: "Original & public excerpt", evidenceUrl: sent.url }]);
  assert.equal(value.partial, true);
});

test("untrusted search markup cannot manufacture executable, commented, duplicate or unsafe candidates", async () => {
  const fake = result("https://jobs.lever.co/ignored");
  const run = execution(() => ({ text: html(`<!--${fake}--><script>${fake}</script><template>${fake}</template><div title='${fake.replaceAll("'", "&#39;")}'>text</div>${result("http://localhost/private")}${result("https://jobs.lever.co/first")}${result("https://jobs.lever.co/first")}${result("https://jobs.ashbyhq.com/second")}`) }));
  const value = await search(run, undefined, 1) as { results: { url: string }[] };
  assert.deepEqual(value.results.map((r) => r.url), ["https://jobs.lever.co/first"]);
});

test("raw, inert and explicitly hidden subtrees never contribute results or alter a visible anchor title", async () => {
  const fake = result("https://jobs.lever.co/inert-only");
  const visible = result("https://jobs.ashbyhq.com/visible-only");
  for (const tag of ["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "template", "object", "svg", "math", "noscript"]) {
    for (const suffix of ["", "/"]) {
      const value = await search(execution(() => ({ text: html(`<${tag}${suffix}>${fake}</${tag}>${visible}`) }))) as { results: { url: string }[] };
      assert.deepEqual(value.results.map(item => item.url), ["https://jobs.ashbyhq.com/visible-only"], `${tag}${suffix}`);
    }
  }
  for (const attribute of ["hidden", 'aria-hidden="true"', 'style="display: none !important"', 'style="visibility: hidden"']) {
    const value = await search(execution(() => ({ text: html(`<div ${attribute}/>${fake}</div>${visible}`) }))) as { results: { url: string }[] };
    assert.deepEqual(value.results.map(item => item.url), ["https://jobs.ashbyhq.com/visible-only"], attribute);
  }
  const value = await search(execution(() => ({ text: html('<a class="result__a" href="https://jobs.lever.co/visible-title">Visible <textarea>inert <b>content</b></textarea><span hidden>hidden title</span> title</a>') }))) as { results: { title: string }[] };
  assert.equal(value.results[0]!.title, "Visible title");
  await assert.rejects(search(execution(() => ({ text: html(`<plaintext>${fake}</plaintext>${visible}`) }))), code("source-changed"));
});

test("malformed raw endings and ancestor closures cannot expose an inert or hidden result", async () => {
  const fake = result("https://jobs.lever.co/malformed-inert-only");
  for (const contents of [
    `<textarea></ textarea>${fake}</textarea>`, `<template></ template>${fake}</template>`,
    `<div><template></div>${fake}</template></div>`, `<section><div hidden></section>${fake}</div></section>`,
    `<a class="result__a" href="https://jobs.lever.co/outer"><span hidden></a>${fake}</span>`,
  ]) await assert.rejects(search(execution(() => ({ text: html(contents) }))), code("source-changed"), contents);
});

test("only non-hidden parsed empty-state content proves an empty search", async () => {
  const empty = '<div class="no-results"><p>No results found for synthetic</p></div>';
  for (const contents of [
    `<!--${empty}-->`, `<script>const fake='${empty}';</script>`, `<textarea>${empty}</textarea>`, `<title>${empty}</title>`,
    `<div hidden>${empty}</div>`, `<div aria-hidden="true">${empty}</div>`, '<div class="no-results"><span hidden>No results</span></div>',
    '<p>No results found for synthetic</p>', '<div class="no-results"></div>',
  ]) await assert.rejects(search(execution(() => ({ text: html(contents) }))), code("source-changed"), contents);
  assert.deepEqual(await search(execution(() => ({ text: html(empty) }))), { results: [], partial: true });
});

test("DDG retains real-page result structure, matching snippet destinations and an explicitly partial page", async () => {
  const first = "https://jobs.lever.co/synthetic-first", second = "https://jobs.ashbyhq.com/synthetic-second";
  const run = execution(() => ({ text: html(`<div class="serp__results"><div id="links" class="results"><div class="result results_links results_links_deep web-result "><div class="links_main links_deep result__body"><h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(first)}&amp;rut=synthetic">Synthetic <b>careers</b></a></h2><a class="result__snippet" href="${second}">Unrelated snippet</a></div></div><div class="result results_links results_links_deep web-result ">${result(second, "Second careers", "Matched original excerpt")}</div></div></div><form action="/html/" method="post"><input type="submit" value="Next" /></form>`) }));
  const value = await search(run) as { results: { url: string; title?: string; snippet?: string; evidenceUrl?: string }[]; partial: boolean };
  assert.deepEqual(value.results, [
    { url: first, title: "Synthetic careers", evidenceUrl: run.requests[0]!.url },
    { url: second, title: "Second careers", snippet: "Matched original excerpt", evidenceUrl: run.requests[0]!.url },
  ]);
  assert.equal(value.partial, true); assert.equal(run.requests.length, 1);
});

test("DDG token, nesting and tag-size limits reject oversized markup before producing candidates", async () => {
  const visible = result("https://jobs.lever.co/within-limit");
  for (const contents of ["<br>".repeat(20_001) + visible, "<div>".repeat(258) + visible + "</div>".repeat(258)]) {
    await assert.rejects(search(execution(() => ({ text: html(contents) }))), code("budget-exceeded"));
  }
  await assert.rejects(search(execution(() => ({ text: html(`<div title="${"x".repeat(8193)}">${visible}</div>`) }))), code("source-changed"));
});

test("DDG empty search is distinguishable from a changed layout and an interactive challenge", async () => {
  const empty = await search(execution(() => ({ text: html('<div class="no-results">No results found for synthetic</div>') }))) as { results: unknown[]; partial: boolean };
  assert.deepEqual(empty, { results: [], partial: true });
  for (const text of [html("new unknown markup"), "not html", html(result("http://127.0.0.1/private")), html('<a class="result__a" href="https://example.com"><a>nested</a></a>')]) {
    await assert.rejects(search(execution(() => ({ text }))), code("source-changed"));
  }
  for (const text of [html('<form id="challenge-form"></form>'), html("Unfortunately, bots use DuckDuckGo too."), html('<script src="anomaly.js"></script>')]) {
    await assert.rejects(search(execution(() => ({ text }))), code("needs-auth"));
  }
});

test("provider errors do not become empty results and response budgets apply before parsing", async () => {
  for (const [status, expected] of [[401, "needs-auth"], [403, "needs-auth"], [429, "rate-limited"], [500, "source-changed"]] as const) {
    await assert.rejects(search(execution(() => ({ status }))), code(expected));
  }
  await assert.rejects(search(execution(() => ({ url: "https://unconfigured.example.com/search" }))), code("source-changed"));
  await assert.rejects(search(execution(() => ({ headers: { "content-type": "application/json" }, text: "{}" }))), code("source-changed"));
  await assert.rejects(search(execution(() => ({ text: "x".repeat(2 * 1024 * 1024 + 1) }))), code("budget-exceeded"));
});

test("cancelled search rejects both before network and after a late transport result", async () => {
  const before = execution(); before.controller.abort();
  await assert.rejects(search(before), code("cancelled")); assert.equal(before.requests.length, 0);
  const late = execution(() => { late.controller.abort(); return { text: html(result("https://jobs.lever.co/late")) }; });
  await assert.rejects(search(late), code("cancelled"));
});

test("SearXNG uses the configured exact HTTPS endpoint and bounded JSON results without automatic page following", async () => {
  const provider = createCareerWebSearchProvider({ provider: "searxng", endpoint: "https://search.example.com/api/search" });
  const run = execution(() => ({ headers: { "content-type": "application/json" }, text: JSON.stringify({ results: [
    { url: "https://jobs.ashbyhq.com/synthetic", title: "Synthetic <b>jobs</b>", content: "Search excerpt", engine: "synthetic" },
    { url: "https://jobs.ashbyhq.com/synthetic", title: "Duplicate" }, { url: "http://127.0.0.1/private" },
  ], unresponsive_engines: [["synthetic-secondary", "timeout"]] }) }));
  const value = await search(run, provider) as { results: { url: string; title: string }[]; partial: boolean };
  assert.equal(run.requests.length, 1);
  const url = new URL(run.requests[0]!.url);
  assert.equal(url.pathname, "/api/search"); assert.equal(url.searchParams.get("format"), "json"); assert.equal(url.searchParams.get("pageno"), "1");
  assert.deepEqual(value.results.map(({ url, title }) => ({ url, title })), [{ url: "https://jobs.ashbyhq.com/synthetic", title: "Synthetic jobs" }]);
  assert.equal(value.partial, true);
});

test("SearXNG invalid JSON, challenge HTML, failed engines and unsafe-only payloads remain failures", async () => {
  const provider = createCareerWebSearchProvider({ provider: "searxng", endpoint: "https://search.example.com/search" });
  for (const body of ["<html>Challenge</html>", "{}", JSON.stringify({ results: [{ url: 1 }] }), JSON.stringify({ results: [], unresponsive_engines: [["synthetic", "error"]] }), JSON.stringify({ results: [{ url: "http://localhost/private" }] })]) {
    await assert.rejects(search(execution(() => ({ headers: { "content-type": "application/json" }, text: body })), provider), code("source-changed"));
  }
  const empty = await search(execution(() => ({ headers: { "content-type": "application/json" }, text: '{"results":[]}' })), provider) as { results: unknown[] };
  assert.deepEqual(empty.results, []);
});

test("discovery records actual provider execution, makes disabled proposals and never follows search candidates", async () => {
  const run = execution();
  const value = await discoverCompanyCareers({ companyName: "Synthetic & Co" }, { ...run, searchProvider: createCareerWebSearchProvider({ provider: "duckduckgo-html" }) });
  assert.equal(value.status, "needs-review"); assert.equal(run.requests.length, 1);
  assert.deepEqual(value.visitedUrls, []);
  assert.deepEqual(value.search, { providerId: "duckduckgo-html", label: "DuckDuckGo HTML", query: "Synthetic & Co official careers 招聘", resultCount: 1 });
  assert.equal(value.candidates[0]!.entryKind, "lever");
  assert.equal(value.candidates[0]!.companyAssociation, "unverified");
  assert.equal(value.proposals[0]!.source.enabled, false); assert.equal(value.proposals[0]!.source.status, "needs-review");
  assert.equal(value.proposals[0]!.source.entryUrl, "https://api.lever.co/v0/postings/synthetic?mode=json");
});
