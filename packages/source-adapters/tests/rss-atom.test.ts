import assert from "node:assert/strict";
import test from "node:test";
import { SourceDefinitionSchema } from "@better-me/opportunities";
import type { SourceAdapterContext } from "../src/contracts.js";
import { rssAtomAdapter } from "../src/adapters/rss-atom.js";

const observedAt = "2026-10-25T12:00:00.000Z";
const context: SourceAdapterContext = {
  observedAt, requestId: "rss-atom-test", actorScope: "synthetic-user", signal: new AbortController().signal,
  budget: { requests: 2, bytes: 100_000, timeoutMs: 5000 }, consumeRequests: () => undefined, consumeBytes: () => undefined, throwIfCancelled: () => undefined,
};
function source(options: Record<string, unknown> = {}) {
  return SourceDefinitionSchema.parse({
    sourceId: "synthetic-rss-feed", name: "Synthetic RSS feed", adapterId: "rss-atom", adapterVersion: "1",
    capabilities: ["list-jobs"], runtime: ["local-service"], entityType: "job-posting", enabled: true, status: "active", entryUrl: "https://careers.example.com/feed.xml",
    options, remoteFilters: [], endpointPolicy: { allowedHosts: ["careers.example.com"], allowedPathPrefixes: ["/feed.xml"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: "Synthetic feed", usage: "metadata", requiresAttribution: true },
    refreshPolicy: { mode: "manual", minIntervalSeconds: 60, maxRecords: 20, maxPages: 1, requestsPerMinute: 10 },
  });
}
function input(xml: string, options: Record<string, unknown> = {}) {
  const calls: string[] = [];
  return { calls, source: source(options), scope: { roles: [], regions: [], companyNames: [] }, context,
    transport: { async request({ url }: { url: string }) { calls.push(url); return { url, status: 200, headers: { "content-type": "application/xml" }, text: xml }; } } };
}

test("RSS records retain original links, descriptions and explicit publication time without inventing locations", async () => {
  const request = input(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Careers</title><item><guid>rss-1</guid><title>Senior C# engineer</title><link>https://careers.example.com/jobs/rss-1</link><description><![CDATA[<p>Build services.</p>]]></description><pubDate>Sat, 25 Oct 2026 09:30:00 +0000</pubDate><author>Not the employer</author><publisher>Example Co</publisher></item></channel></rss>`, { companyName: "Configured Co" });
  const result = await rssAtomAdapter.list(request);
  const job = result.records[0]!;
  assert.equal(request.calls.length, 1);
  assert.equal(job.sourceRecordId, "rss-1");
  assert.equal(job.url, "https://careers.example.com/jobs/rss-1");
  assert.equal(job.applicationUrl, job.url);
  assert.equal(job.companyName, "Example Co");
  assert.equal(job.description, "Build services.");
  assert.equal(job.sourcePublishedRaw, "Sat, 25 Oct 2026 09:30:00 +0000");
  assert.equal(job.sourcePublishedAt, "2026-10-25T09:30:00.000Z");
  assert.deepEqual(job.locations, []);
  assert.equal(result.coverage.partial, true);
  assert.equal(result.coverage.complete, false);
  assert.ok(result.warnings.some((warning) => warning.includes("bounded")));
});

test("Atom feeds accept href links and preserve timezone-free dates as raw evidence", async () => {
  const request = input(`<feed xmlns="http://www.w3.org/2005/Atom"><title>Jobs</title><entry><id>atom-1</id><title>Platform engineer</title><link rel="self" href="https://careers.example.com/feed.xml"/><link rel="alternate" href="https://careers.example.com/jobs/atom-1"/><summary type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">Operate <b>platforms</b>.</div></summary><published>2026-10-25</published><updated>2026-10-25T12:00:00Z</updated></entry></feed>`, { enumerationComplete: true });
  const result = await rssAtomAdapter.list(request);
  const job = result.records[0]!;
  assert.equal(job.sourceRecordId, "atom-1");
  assert.equal(job.description, "Operate platforms.");
  assert.equal(job.sourcePublishedRaw, "2026-10-25");
  assert.equal(job.sourcePublishedAt, undefined);
  assert.equal(job.sourceUpdatedAt, "2026-10-25T12:00:00.000Z");
  assert.equal(job.url, "https://careers.example.com/jobs/atom-1");
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.partial, false);
});

test("standard XML declarations are accepted, alternate links win over self links, and authors are not employers", async () => {
  const request = input(`<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom"><entry><id>atom-author-1</id>
      <title>Backend engineer</title>
      <link rel="self" href="https://careers.example.com/feed.xml"/>
      <link rel="alternate" href="https://careers.example.com/jobs/atom-author-1"/>
      <author><name>Jane Recruiter</name></author>
    </entry></feed>`);
  const result = await rssAtomAdapter.list(request);
  const job = result.records[0]!;
  assert.equal(job.url, "https://careers.example.com/jobs/atom-author-1");
  assert.equal(job.companyName, undefined);
  assert.equal(job.sourceRecordId, "atom-author-1");
});

test("RSS adapter rejects cursors, executable XML declarations and unsafe or missing posting links", async () => {
  const cursor = { ...input("<rss><channel></channel></rss>"), cursor: "page-2" };
  await assert.rejects(rssAtomAdapter.list(cursor), (error: unknown) => (error as { code?: string }).code === "invalid-input");
  await assert.rejects(rssAtomAdapter.list(input("<!DOCTYPE rss [<!ENTITY x SYSTEM 'file:///secret'>]><rss><channel/></rss>")), (error: unknown) => (error as { code?: string }).code === "source-changed");
  const result = await rssAtomAdapter.list(input("<rss><channel><item><title>Missing link</title></item><item><title>Unsafe</title><link>http://careers.example.com/jobs/2</link></item></channel></rss>"));
  assert.equal(result.records.length, 0);
  assert.equal(result.coverage.partial, true);
  assert.ok(result.warnings.some((warning) => warning.includes("omitted")));
});

test("RSS options are strict host metadata and cannot carry arbitrary endpoint or credential fields", async () => {
  assert.throws(() => source({ endpoint: "https://other.example/jobs", authorization: "secret" }), /Credentials belong in a secret store/);
});
