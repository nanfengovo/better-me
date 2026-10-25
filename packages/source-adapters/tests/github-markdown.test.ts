import assert from "node:assert/strict";
import test from "node:test";
import { SourceDefinitionSchema } from "@better-me/opportunities";
import type { SourceAdapterContext } from "../src/contracts.js";
import { githubMarkdownAdapter } from "../src/adapters/github-markdown.js";

const observedAt = "2026-10-25T12:00:00.000Z";
const context: SourceAdapterContext = {
  observedAt, requestId: "github-markdown-test", actorScope: "synthetic-user", signal: new AbortController().signal,
  budget: { requests: 2, bytes: 100_000, timeoutMs: 5000 }, consumeRequests: () => undefined, consumeBytes: () => undefined, throwIfCancelled: () => undefined,
};
function source(options: Record<string, unknown> = {}) {
  return SourceDefinitionSchema.parse({
    sourceId: "simplifyjobs-synthetic", name: "Synthetic GitHub table", adapterId: "github-markdown", adapterVersion: "1",
    capabilities: ["list-jobs"], runtime: ["local-service"], entityType: "company-directory", enabled: true, status: "active",
    entryUrl: "https://raw.githubusercontent.com/example/jobs/dev/README.md", options, remoteFilters: [],
    endpointPolicy: { allowedHosts: ["raw.githubusercontent.com"], allowedPathPrefixes: ["/example/jobs/dev/README.md"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: "Synthetic GitHub list", usage: "link-only", requiresAttribution: true },
    refreshPolicy: { mode: "manual", minIntervalSeconds: 60, maxRecords: 20, maxPages: 1, requestsPerMinute: 10 },
  });
}
function input(markdown: string, options: Record<string, unknown> = {}) {
  const calls: string[] = [];
  return { calls, source: source(options), scope: { roles: [], regions: [], companyNames: [] }, context,
    transport: { async request({ url }: { url: string }) { calls.push(url); return { url, status: 200, headers: { "content-type": "text/plain" }, text: markdown }; } } };
}

test("parses a GitHub HTML table into discovery leads with raw evidence", async () => {
  const request = input(`<script><table><tr><th>Title</th><th>Link</th></tr><tr><td>Hidden</td><td>https://bad.example/hidden</td></tr></table></script><table><tr><th>Company</th><th>Title</th><th>Location</th><th>Apply</th><th>Posted</th></tr><tr><td>Example Co</td><td>Platform Engineer</td><td>Shanghai</td><td><a href="https://careers.example.com/jobs/1">Apply</a></td><td>2026-10-20</td></tr></table>`, { tableIndex: 0 });
  const result = await githubMarkdownAdapter.list(request);
  assert.equal(request.calls.length, 1);
  assert.equal(result.records.length, 1);
  const record = result.records[0]!;
  assert.equal(record.entityType, "discovery-lead");
  assert.equal(record.companyName, "Example Co");
  assert.deepEqual(record.locations, [{ raw: "Shanghai" }]);
  assert.equal(record.url, "https://careers.example.com/jobs/1");
  assert.equal(record.sourcePublishedRaw, "2026-10-20");
  assert.equal(record.sourcePublishedAt, undefined);
  assert.ok(record.evidence.every((item) => item.sourceUrl.startsWith("https://raw.githubusercontent.com/")));
  assert.equal(result.coverage.partial, true);
  assert.equal(result.stopReason, "page-limit");
});

test("parses Markdown links, collapses duplicate links, and skips rows without original URLs", async () => {
  const request = input(`| Company | Role | Location | Application | Age |\n| --- | --- | --- | --- | --- |\n| Example | Engineer | Berlin | [Apply](https://careers.example.com/jobs/2) | 3d |\n| Example | Same role | Berlin | [Apply again](https://careers.example.com/jobs/2) | 4d |\n| Missing | No link | Berlin | - | 1d |`);
  const result = await githubMarkdownAdapter.list(request);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0]!.url, "https://careers.example.com/jobs/2");
  assert.ok(result.warnings.some((warning) => warning.includes("duplicate")));
  assert.equal(result.coverage.partial, true);
});

test("respects output limits, cancellation, and Raw GitHub URL policy", async () => {
  const request = input(`| Company | Title | URL |\n| --- | --- | --- |\n| A | One | https://careers.example.com/1 |\n| B | Two | https://careers.example.com/2 |`, { enumerationComplete: true });
  request.source.refreshPolicy.maxRecords = 1;
  const result = await githubMarkdownAdapter.list(request);
  assert.equal(result.records.length, 1);
  assert.equal(result.coverage.partial, true);
  await assert.rejects(githubMarkdownAdapter.list({ ...request, source: { ...request.source, entryUrl: "https://raw.githubusercontent.com:443/example/jobs/dev/README.md" } }), { code: "invalid-input" });
  const cancelled = input(`| Title | URL |\n| --- | --- |\n| One | https://careers.example.com/1 |`);
  cancelled.context.throwIfCancelled = () => { throw new DOMException("Aborted", "AbortError"); };
  await assert.rejects(githubMarkdownAdapter.list(cancelled), { name: "AbortError" });
});
