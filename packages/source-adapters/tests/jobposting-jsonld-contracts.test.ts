import assert from "node:assert/strict";
import test from "node:test";
import { ToolError, type SourceDefinition } from "@better-me/opportunities";
import { JobPostingJsonLdOptionsSchema, validateJobPostingJsonLdSource } from "../src/jobposting-jsonld-contracts.js";

const entry = "https://careers.example.com/jobs-sitemap.xml";
const options = { enumerationKind: "sitemap-urlset" as const, enumerationUrls: [entry], postingPathPrefixes: ["/jobs/"] };
const source = (changes: Partial<SourceDefinition> = {}): SourceDefinition => ({
  sourceId: "synthetic-jsonld", name: "Synthetic official careers", adapterId: "jobposting-jsonld", adapterVersion: "1",
  capabilities: ["list-jobs"], runtime: ["local-service"], entityType: "job-posting", enabled: true, status: "active", entryUrl: entry, options,
  remoteFilters: [], endpointPolicy: { allowedHosts: ["careers.example.com"], allowedPathPrefixes: ["/jobs-sitemap.xml", "/jobs/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
  attribution: { label: "Synthetic careers", usage: "link-only", requiresAttribution: true },
  refreshPolicy: { mode: "manual", minIntervalSeconds: 3600, maxRecords: 20, maxPages: 4, requestsPerMinute: 10 }, ...changes,
});
const invalidInput = (error: unknown) => error instanceof ToolError && error.code === "invalid-input";

test("flat reviewed JobPosting options default only page size and preserve explicit enumeration", () => {
  const parsed = JobPostingJsonLdOptionsSchema.parse(options);
  assert.deepEqual(parsed, { ...options, pageSize: 5 });
  assert.deepEqual(validateJobPostingJsonLdSource(source()), parsed);
  assert.equal(JobPostingJsonLdOptionsSchema.parse({ ...options, enumerationKind: "html-list", pageSize: 1 }).pageSize, 1);
  assert.equal(JobPostingJsonLdOptionsSchema.parse({ ...options, pageSize: 20 }).pageSize, 20);
});

test("empty, unsupported and unknown configuration is rejected without throwing outside schema validation", () => {
  for (const changes of [{ enumerationKind: "dynamic-list" }, { enumerationUrls: [] }, { enumerationUrls: ["invalid"] },
    { postingPathPrefixes: [] }, { pageSize: 0 }, { pageSize: 21 }, { pageSize: 1.5 }, { selectors: { links: "a" } }, { fetchDetails: true }]) {
    assert.equal(JobPostingJsonLdOptionsSchema.safeParse({ ...options, ...changes }).success, false, JSON.stringify(changes));
  }
  assert.throws(() => validateJobPostingJsonLdSource(source({ options: undefined })), invalidInput);
});

test("sitemap indexes require one reviewed root and bound only child sitemap reads", () => {
  const indexOptions = { ...options, enumerationKind: "sitemap-index" as const, maxChildSitemaps: 3 };
  assert.deepEqual(JobPostingJsonLdOptionsSchema.parse(indexOptions), { ...indexOptions, pageSize: 5 });
  assert.deepEqual(validateJobPostingJsonLdSource(source({ options: indexOptions })), { ...indexOptions, pageSize: 5 });
  for (const maxChildSitemaps of [0, 101, 1.5]) {
    assert.equal(JobPostingJsonLdOptionsSchema.safeParse({ ...indexOptions, maxChildSitemaps }).success, false);
  }
  assert.equal(JobPostingJsonLdOptionsSchema.safeParse({ ...indexOptions, enumerationUrls: [entry, "https://careers.example.com/other-index.xml"] }).success, false);
  assert.equal(JobPostingJsonLdOptionsSchema.safeParse({ ...options, maxChildSitemaps: 3 }).success, false);
  assert.equal(JobPostingJsonLdOptionsSchema.parse({ ...options, enumerationKind: "sitemap-index" }).maxChildSitemaps, undefined);
});

test("enumeration and priority URL lists have finite bounds and normalized unique entries", () => {
  const twenty = Array.from({ length: 20 }, (_, index) => `https://careers.example.com/list/${index}`);
  assert.equal(JobPostingJsonLdOptionsSchema.safeParse({ ...options, enumerationUrls: twenty }).success, true);
  assert.equal(JobPostingJsonLdOptionsSchema.safeParse({ ...options, enumerationUrls: [...twenty, "https://careers.example.com/list/20"] }).success, false);
  for (const enumerationUrls of [[entry, entry], [entry, "https://CAREERS.EXAMPLE.COM/jobs-sitemap.xml"]]) {
    assert.equal(JobPostingJsonLdOptionsSchema.safeParse({ ...options, enumerationUrls }).success, false);
  }
  assert.equal(JobPostingJsonLdOptionsSchema.safeParse({ ...options, priorityPostingUrls: [] }).success, true);
  assert.equal(JobPostingJsonLdOptionsSchema.safeParse({ ...options, priorityPostingUrls: Array.from({ length: 21 }, (_, index) => `https://careers.example.com/jobs/${index}`) }).success, false);
});

test("URL review rejects non-HTTPS, credentials, fragments, ports, IPs, raw/encoded ambiguous paths and whitespace", () => {
  for (const value of ["http://careers.example.com/list", "https://user:pass@careers.example.com/list", "https://@careers.example.com/list", `${entry}#`, `${entry}#section`,
    "https://careers.example.com:443/list", "https://careers.example.com:8443/list", "https://127.0.0.1/list", "https://[::1]/list", "https://localhost/list",
    "https://careers.example.com./list", "https://careers.example.com/a/../list", "https://careers.example.com/a/%2E%2E/list", "https://careers.example.com/a%2flist",
    "https://careers.example.com/a%5clist", "https://careers.example.com/a%252flist", "https://careers.example.com/a%0alist", "https://careers.example.com/a%ZZ",
    "https://careers.example.com\\list", ` ${entry}`, `${entry}\n`]) {
    assert.equal(JobPostingJsonLdOptionsSchema.safeParse({ ...options, enumerationUrls: [value] }).success, false, value);
  }
});

test("all explicit lists and optional priorities share one origin and priorities stay inside reviewed path segments", () => {
  assert.equal(JobPostingJsonLdOptionsSchema.safeParse({ ...options, enumerationUrls: [entry, "https://other.example.com/jobs.xml"] }).success, false);
  for (const priorityPostingUrls of [["https://other.example.com/jobs/1"], ["https://careers.example.com/jobs-else/1"], ["https://careers.example.com/about"],
    ["https://careers.example.com/jobs/1", "https://CAREERS.EXAMPLE.COM/jobs/1"]]) {
    assert.equal(JobPostingJsonLdOptionsSchema.safeParse({ ...options, priorityPostingUrls }).success, false);
  }
  assert.equal(JobPostingJsonLdOptionsSchema.safeParse({ ...options, priorityPostingUrls: ["https://careers.example.com/jobs/1"] }).success, true);
  assert.equal(JobPostingJsonLdOptionsSchema.safeParse({ ...options, enumerationUrls: [entry, "https://careers.example.com/list?page=2&locale=en"] }).success, true);
});

test("path prefixes are finite, unique absolute segment prefixes without encodings, query or dot-segment ambiguity", () => {
  for (const postingPathPrefixes of [["jobs"], ["//jobs/"], ["/jobs//"], ["/jobs/../"], ["/jobs/./"], ["/jobs/%2f"], ["/jobs/?x=1"], ["/jobs/#x"],
    ["/jobs/ x"], ["/jobs/", "/jobs/"], Array.from({ length: 21 }, (_, index) => `/jobs/${index}/`)]) {
    assert.equal(JobPostingJsonLdOptionsSchema.safeParse({ ...options, postingPathPrefixes }).success, false, JSON.stringify(postingPathPrefixes));
  }
  assert.equal(JobPostingJsonLdOptionsSchema.safeParse({ ...options, postingPathPrefixes: ["/jobs", "/职位/"] }).success, true);
});

test("source entry must exactly be the first reviewed list and adapter identity/version must match", () => {
  for (const changes of [{ entryUrl: undefined }, { entryUrl: "https://careers.example.com/" }, { entryUrl: `${entry}?page=2` },
    { adapterId: "mapped-json" }, { adapterVersion: "2" }]) assert.throws(() => validateJobPostingJsonLdSource(source(changes)), invalidInput);
});

test("source configuration validation does not authorize endpoints, enable sources or mutate refresh allowances", () => {
  const definition = source({ enabled: false, status: "needs-review", endpointPolicy: { allowedHosts: [], allowedPathPrefixes: [], requireHttps: true, allowRedirects: false, maxRedirects: 0 } });
  const before = JSON.stringify(definition);
  assert.equal(validateJobPostingJsonLdSource(definition).pageSize, 5);
  assert.equal(JSON.stringify(definition), before);
  assert.equal(definition.refreshPolicy.maxRecords, 20);
});
