import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { SourceDefinitionSchema, type SourceDefinition, type ToolResult, type TrustedToolContext } from "@better-me/opportunities";
import { CompanyCareerDiscoveryResultSchema, type SourceTransport } from "@better-me/source-adapters";
import { createJobApplication, type JobApplicationOptions } from "../src/application.ts";
import { openJobRepository, type JobRepository } from "../src/repository.ts";

const at = "2026-10-19T00:00:00.000Z";
const website = "https://careers.example.test/company";
const companyName = "Synthetic company";
const policy: SourceDefinition = {
  sourceId: "synthetic-company-policy", name: companyName, adapterId: "discovery-policy", adapterVersion: "1",
  capabilities: ["discover-sources"], runtime: ["local-service"], entityType: "company-directory", enabled: true, status: "active", remoteFilters: [],
  entryUrl: website, options: { companyName },
  endpointPolicy: { allowedHosts: ["careers.example.test"], allowedPathPrefixes: ["/company"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
  attribution: { label: "Synthetic access policy", homepageUrl: website, usage: "link-only", requiresAttribution: true },
  refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 20, maxPages: 1, requestsPerMinute: 6 },
};
function context(key: string, allowedEffects: TrustedToolContext["allowedEffects"] = ["read-index", "external-read", "local-write"]): TrustedToolContext {
  return { requestId: key, idempotencyKey: key, actorScope: "synthetic-policy-owner", signal: new AbortController().signal,
    allowedEffects, budget: { requests: 5, bytes: 1_000_000, timeoutMs: 1000 } };
}
function value(result: ToolResult) { assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) throw new Error(result.error.code); return result.value; }
function code(result: ToolResult) { assert.equal(result.ok, false, JSON.stringify(result)); return result.ok ? undefined : result.error.code; }
async function fixture(run: (repo: JobRepository, app: ReturnType<typeof createJobApplication>) => Promise<void>, options: Omit<JobApplicationOptions, "repository"> = {}) {
  const repo = openJobRepository(":memory:", { now: () => at });
  const app = createJobApplication({ repository: repo, now: () => at, ...options });
  try { await run(repo, app); } finally { await app.shutdown(); repo.close(); }
}
const noNetwork: SourceTransport = { request: async () => { throw new Error("Unexpected network in discovery-policy test"); } };

test("reusable policy example stays disabled for review and stages without network or job claims", async () => {
  const example = SourceDefinitionSchema.parse(JSON.parse(await readFile(new URL("../../../config/sources/company-career-discovery.example.json", import.meta.url), "utf8")));
  assert.equal(example.enabled, false); assert.equal(example.status, "needs-review"); assert.equal(example.adapterId, "discovery-policy");
  assert.deepEqual(example.capabilities, ["discover-sources"]); assert.equal(example.entityType, "company-directory");
  assert.deepEqual(example.endpointPolicy.allowedHosts, ["careers.example.org"]); assert.deepEqual(example.endpointPolicy.allowedPathPrefixes, ["/company"]);
  await fixture(async (repo, app) => {
    value(await app.registry.execute("sources.register", { source: example }, context("stage-example")));
    assert.deepEqual((await repo.readSnapshot()).sources, [example]); assert.deepEqual((await repo.readSnapshot()).jobs, []);
    assert.equal(code(await app.registry.execute("companies.discover-careers", { sourceId: example.sourceId, request: { companyName, companyWebsite: website } }, context("disabled-discovery"))), "unsupported-capability");
  }, { transport: noNetwork });
});

test("explicit registration and activation enables bounded website discovery without treating the same-name policy as a job source", async () => {
  const requests: string[] = [];
  await fixture(async (repo, app) => {
    value(await app.registry.execute("sources.register", { source: { ...policy, enabled: false, status: "needs-review" } }, context("stage-policy")));
    const staged = await repo.readSnapshot();
    value(await app.registry.execute("sources.register", { source: policy, expectedRevision: staged.revision }, context("activate-policy")));
    const before = await repo.backup();
    const nameOnly = CompanyCareerDiscoveryResultSchema.parse(value(await app.registry.execute("companies.discover-careers", { request: { companyName } }, context("name-only"))));
    assert.equal(nameOnly.status, "requires-company-website"); assert.deepEqual(nameOnly.matchedSources, []); assert.deepEqual(requests, []);
    const result = CompanyCareerDiscoveryResultSchema.parse(value(await app.registry.execute("companies.discover-careers", { sourceId: policy.sourceId,
      request: { companyName, companyWebsite: website, maxPages: 10 } }, context("discover-website"))));
    assert.deepEqual(requests, [website]); assert.deepEqual(result.visitedUrls, [website]); assert.equal(result.partial, true);
    assert.equal(result.status, "needs-review"); assert.deepEqual(result.matchedSources, []);
    assert.equal(result.candidates.length, 2); assert.ok(result.candidates.some(item => item.entryKind === "lever"));
    assert.ok(result.proposals.every(item => !item.source.enabled && item.source.status === "needs-review"));
    assert.deepEqual(await repo.backup(), before);
    const listed = value(await app.registry.execute("sources.list", {}, context("list-capabilities"))) as { adapters: Array<{ adapterId: string; capabilities: string[]; entityTypes: string[] }> };
    assert.deepEqual(listed.adapters.find(item => item.adapterId === "discovery-policy")?.capabilities, ["discover-sources"]);
  }, { transport: { request: async input => { requests.push(input.url); assert.deepEqual(input.source.endpointPolicy, policy.endpointPolicy);
    return { url: input.url, status: 200, headers: { "content-type": "text/html" }, text: '<html><a href="/company/careers">Careers</a><a href="https://jobs.lever.co/synthetic">招聘</a></html>' }; } } });
});

test("policy activation requires an installed matching identity, version, entity, runtime and discovery-only capability", async () => fixture(async (repo, app) => {
  const before = await repo.backup();
  for (const [index, mutation] of [
    { adapterId: "uninstalled-policy" }, { adapterVersion: "2" }, { entityType: "job-posting" }, { runtime: ["server"] },
    { capabilities: [] }, { capabilities: ["discover-sources", "read-detail"] }, { capabilities: ["list-jobs"] },
    { capabilities: ["discover-sources", "list-jobs"] }, { adapterId: "mapped-json" },
    { status: "needs-review" },
  ].entries()) {
    const changed = SourceDefinitionSchema.parse({ ...policy, ...mutation, sourceId: `rejected-policy-${index}` });
    assert.equal(code(await app.registry.execute("sources.register", { source: changed }, context(`reject-${index}`))), "unsupported-capability");
  }
  assert.deepEqual(await repo.backup(), before);
}, { transport: noNetwork }));

test("existing collectors retain their prior list-jobs registration semantics when also authorizing host discovery", async () => fixture(async (repo, app) => {
  const collector: SourceDefinition = { ...policy, adapterId: "mapped-json", sourceId: "synthetic-existing-collector", capabilities: ["list-jobs", "discover-sources"] };
  value(await app.registry.execute("sources.register", { source: collector }, context("register-existing-collector")));
  assert.deepEqual((await repo.readSnapshot()).sources, [collector]);
  const before = await repo.backup();
  const result = CompanyCareerDiscoveryResultSchema.parse(value(await app.registry.execute("companies.discover-careers", { request: { companyName } }, context("match-existing-collector"))));
  assert.equal(result.status, "matched-existing"); assert.equal(result.matchedSources[0]!.sourceId, collector.sourceId);
  assert.deepEqual(await repo.backup(), before);
}, { transport: noNetwork }));

test("a discovery access policy never supports preview or sync and rejected listing creates no runs", async () => fixture(async (repo, app) => {
  value(await app.registry.execute("sources.register", { source: policy }, context("register-list-denial")));
  const before = await repo.backup();
  for (const tool of ["sources.preview", "sources.sync"])
    assert.equal(code(await app.registry.execute(tool, { sourceId: policy.sourceId, scope: { roles: ["C#"], regions: [], companyNames: [] } }, context(tool))), "unsupported-capability");
  assert.deepEqual(await repo.backup(), before);
}, { transport: noNetwork }));

test("enabled discovery policies retain exact website host/path limits, secret-reference and write permission gates", async () => fixture(async (repo, app) => {
  assert.equal(code(await app.registry.execute("sources.register", { source: policy }, context("forbid-register", ["external-read", "read-index"]))), "not-authorized");
  assert.deepEqual((await repo.readSnapshot()).sources, []);
  value(await app.registry.execute("sources.register", { source: policy }, context("register-exact-policy")));
  const before = await repo.backup();
  for (const companyWebsite of ["https://outside.example.test/company", "https://careers.example.test/company-other", "https://careers.example.test/"])
    assert.equal(code(await app.registry.execute("companies.discover-careers", { sourceId: policy.sourceId, request: { companyName: "Synthetic unmatched", companyWebsite } }, context("forbid-endpoint"))), "not-authorized");
  assert.deepEqual(await repo.backup(), before);
  value(await app.registry.execute("sources.register", { source: { ...policy, secretRef: "synthetic-private-secret-reference" }, expectedRevision: (await repo.readSnapshot()).revision }, context("register-secret-policy")));
  const withSecret = await repo.backup();
  assert.equal(code(await app.registry.execute("companies.discover-careers", { sourceId: policy.sourceId, request: { companyName, companyWebsite: website } }, context("forbid-secret"))), "needs-auth");
  assert.deepEqual(await repo.backup(), withSecret);
}, { transport: noNetwork }));
