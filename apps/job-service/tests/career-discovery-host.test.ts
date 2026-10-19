import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createToolRegistry, type SourceDefinition, type ToolResult, type TrustedToolContext } from "@better-me/opportunities";
import { CompanyCareerDiscoveryCapabilitiesSchema, CompanyCareerDiscoveryResultSchema, type CareerWebSearchProvider, type SourceTransport } from "@better-me/source-adapters";
import { createJobApplication, type JobApplicationOptions } from "../src/application.ts";
import { parseJobServiceArgs, runJobServiceCli } from "../src/cli.ts";
import { createJobHttpServer } from "../src/http.ts";
import { LocalJobServiceError, startLocalJobService, validateJobServiceConfig, type JobServiceConfig, type JobServiceDependencies, type LocalJobServiceHandle } from "../src/lifecycle.ts";
import { openJobRepository, type JobRepository } from "../src/repository.ts";

const at = "2026-10-19T00:00:00.000Z";
const token = "synthetic-company-discovery-http-token";
const origin = "http://synthetic-ui.invalid";
const source: SourceDefinition = {
  sourceId: "synthetic-career-policy", name: "Synthetic registered company", adapterId: "synthetic-discovery", adapterVersion: "1",
  capabilities: ["discover-sources"], runtime: ["local-service"], entityType: "company-directory", enabled: true, status: "active", remoteFilters: [],
  endpointPolicy: { allowedHosts: ["careers.example.test"], allowedPathPrefixes: ["/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
  attribution: { label: "Synthetic career policy", usage: "link-only", requiresAttribution: true },
  refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 20, maxPages: 3, requestsPerMinute: 30 },
};
function context(effects: TrustedToolContext["allowedEffects"] = ["read-index", "external-read"]): TrustedToolContext {
  return { requestId: "synthetic-career-discovery", actorScope: "local-owner", signal: new AbortController().signal,
    allowedEffects: effects, budget: { requests: 10, bytes: 4_000_000, timeoutMs: 5000 } };
}
function value(result: ToolResult) { assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) throw new Error(result.error.code); return result.value; }
function errorCode(result: ToolResult) { assert.equal(result.ok, false, JSON.stringify(result)); return result.ok ? undefined : result.error.code; }
async function fixture(run: (repo: JobRepository, app: ReturnType<typeof createJobApplication>) => Promise<void>, options: Omit<JobApplicationOptions, "repository"> = {}) {
  const repo = openJobRepository(":memory:", { now: () => at });
  const app = createJobApplication({ repository: repo, now: () => at, ...options });
  try { await run(repo, app); } finally { await app.shutdown(); repo.close(); }
}
const noNetwork: SourceTransport = { request: async () => { throw new Error("Unexpected synthetic network request"); } };

test("name-only discovery needs no stored policy, matches existing sources, and leaves an unconfigured host explicit", async () => fixture(async (repo, app) => {
  const before = await repo.backup();
  const missing = CompanyCareerDiscoveryResultSchema.parse(value(await app.registry.execute("companies.discover-careers", { request: { companyName: "Synthetic unknown company" } }, context())));
  assert.equal(missing.status, "requires-company-website"); assert.deepEqual(missing.candidates, []);
  assert.deepEqual(await repo.backup(), before);
  await repo.registerSource(source, { actorScope: "local-owner", idempotencyKey: "synthetic-source" });
  const stored = await repo.backup();
  const matched = CompanyCareerDiscoveryResultSchema.parse(value(await app.registry.execute("companies.discover-careers", { request: { companyName: source.name } }, context())));
  assert.equal(matched.status, "matched-existing"); assert.deepEqual(matched.matchedSources.map(item => item.sourceId), [source.sourceId]);
  assert.deepEqual(await repo.backup(), stored); assert.ok(!(await repo.readSnapshot()).sources.some(item => item.sourceId === "host-company-career-discovery"));
}, { transport: noNetwork }));

test("trusted provider receives the transient deny-all name policy and creates only disabled review proposals", async () => {
  let calls = 0;
  const provider: CareerWebSearchProvider = { metadata: { providerId: "host-installed", label: "Synthetic host search" }, search: async input => {
    calls++; assert.equal(input.source.sourceId, "host-company-career-discovery"); assert.deepEqual(input.source.endpointPolicy.allowedHosts, []);
    assert.deepEqual(input.source.endpointPolicy.allowedPathPrefixes, []); assert.equal(input.source.entryUrl, undefined);
    assert.equal(input.query, "Synthetic unknown company official careers 招聘"); assert.equal(input.transport, noNetwork);
    return { results: [{ url: "https://jobs.lever.co/synthetic-company", title: "Synthetic company careers" }], partial: false };
  } };
  await fixture(async (repo, app) => {
    const before = await repo.backup();
    const result = CompanyCareerDiscoveryResultSchema.parse(value(await app.registry.execute("companies.discover-careers", { request: { companyName: "Synthetic unknown company" } }, context())));
    assert.equal(result.status, "needs-review"); assert.equal(calls, 1); assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]!.companyAssociation, "unverified"); assert.equal(result.proposals[0]!.source.enabled, false);
    assert.equal(result.proposals[0]!.source.status, "needs-review"); assert.deepEqual(await repo.backup(), before);
  }, { careerWebSearchProvider: provider, transport: noNetwork });
});

test("supplied websites and seeds require an explicit policy; callers cannot supply provider configuration", async () => {
  let searches = 0;
  await fixture(async (repo, app) => {
    const before = await repo.backup();
    for (const input of [
      { request: { companyName: "Synthetic", companyWebsite: "https://careers.example.test/" } },
      { request: { companyName: "Synthetic", seedUrls: ["https://jobs.lever.co/synthetic"] } },
      { request: { companyName: "Synthetic", seedUrls: [] } },
      { request: { companyName: "Synthetic", provider: "duckduckgo-html" } },
      { request: { companyName: "Synthetic" }, endpoint: "https://private.example.test/" },
      { request: { companyName: "Synthetic" }, apiKey: "SYNTHETIC_PRIVATE_INPUT" },
    ]) assert.equal(errorCode(await app.registry.execute("companies.discover-careers", input, context())), "invalid-input");
    assert.equal(searches, 0); assert.deepEqual(await repo.backup(), before);
  }, { transport: noNetwork, careerWebSearchProvider: { search: async () => { searches++; return { results: [], partial: false }; } } });
});

test("explicit policies preserve status, capability, runtime, secret-reference and endpoint checks", async () => {
  let requests = 0, searches = 0;
  await fixture(async (repo, app) => {
    for (const [index, mutation, expected] of [
      [0, { enabled: false }, "unsupported-capability"], [1, { status: "needs-review" }, "unsupported-capability"],
      [2, { capabilities: [] }, "unsupported-capability"], [3, { runtime: ["server"] }, "unsupported-capability"],
      [4, { secretRef: "synthetic-secret-reference" }, "needs-auth"],
    ] as const) {
      const changed = { ...source, ...mutation, sourceId: `policy-${index}` } as SourceDefinition;
      await repo.registerSource(changed, { actorScope: "local-owner", idempotencyKey: `policy-${index}` });
      assert.equal(errorCode(await app.registry.execute("companies.discover-careers", { sourceId: changed.sourceId, request: { companyName: "Synthetic unmatched" } }, context())), expected);
    }
    assert.equal(errorCode(await app.registry.execute("companies.discover-careers", { sourceId: "missing-policy", request: { companyName: "Synthetic unmatched" } }, context())), "invalid-input");
    await repo.registerSource(source, { actorScope: "local-owner", idempotencyKey: "enabled-policy" });
    assert.equal(errorCode(await app.registry.execute("companies.discover-careers", { sourceId: source.sourceId, request: { companyName: "Synthetic unmatched", companyWebsite: "https://outside.example.test/" } }, context())), "not-authorized");
    assert.equal(requests, 0); assert.equal(searches, 0);
    const result = CompanyCareerDiscoveryResultSchema.parse(value(await app.registry.execute("companies.discover-careers", { sourceId: source.sourceId,
      request: { companyName: "Synthetic unmatched", companyWebsite: "https://careers.example.test/", maxPages: 1 } }, context())));
    assert.equal(requests, 1); assert.equal(searches, 0); assert.ok(result.candidates.some(item => item.candidate.homeUrl === "https://careers.example.test/careers"));
  }, { transport: { request: async input => { requests++; return { url: input.url, status: 200, headers: { "content-type": "text/html" }, text: '<html><a href="/careers">Careers</a></html>' }; } },
    careerWebSearchProvider: { search: async () => { searches++; return { results: [], partial: false }; } } });
});

test("capabilities are a read-index operation with no provider call, endpoint, configuration or index mutation", async () => {
  for (const provider of [undefined, { search: async () => { throw new Error("Must never probe the search provider"); } },
    { metadata: { providerId: "searxng" as const, label: "Synthetic SearxNG" }, endpoint: "https://PRIVATE_INSTANCE.example.test/", search: async () => { throw new Error("Must never probe the search provider"); } }]) {
    await fixture(async (repo, app) => {
      const before = await repo.backup();
      const result = CompanyCareerDiscoveryCapabilitiesSchema.parse(value(await app.registry.execute("companies.discovery-capabilities", {}, context(["read-index"]))));
      assert.deepEqual(result.webSearch, provider ? { configured: true, providerId: provider.metadata?.providerId ?? "host-installed", label: provider.metadata?.label ?? "Host-installed career search" } : { configured: false });
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_INSTANCE|endpoint|apiKey/); assert.deepEqual(await repo.backup(), before);
      assert.equal(errorCode(await app.registry.execute("companies.discovery-capabilities", { provider: "searxng" }, context(["read-index"]))), "invalid-input");
      assert.equal(errorCode(await app.registry.execute("companies.discovery-capabilities", {}, context(["external-read"]))), "not-authorized");
    }, { careerWebSearchProvider: provider, transport: noNetwork });
  }
});

test("authenticated HTTP exposes capabilities and name-only discovery through the same strict tools", async () => fixture(async (repo, app) => {
  const http = createJobHttpServer({ registry: app.registry, token, allowedOrigins: [origin], port: 0 });
  try {
    const { url } = await http.listen(); const headers = { Authorization: `Bearer ${token}`, Origin: origin, "Content-Type": "application/json" };
    const path = `${url}/api/v1/companies/discovery-capabilities`;
    assert.equal((await fetch(path)).status, 401); assert.equal((await fetch(path, { headers: { ...headers, Origin: "http://foreign.invalid" } })).status, 403);
    const response = await fetch(path, { headers }); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(CompanyCareerDiscoveryCapabilitiesSchema.parse(value(await response.json())), { schemaVersion: 1, webSearch: { configured: false } });
    const result = await fetch(`${url}/api/v1/companies/discover-careers`, { method: "POST", headers, body: JSON.stringify({ request: { companyName: "Synthetic unknown company" } }) });
    assert.equal(result.status, 200); assert.equal(CompanyCareerDiscoveryResultSchema.parse(value(await result.json())).status, "requires-company-website");
    assert.deepEqual((await repo.readSnapshot()).sources, []);
  } finally { await http.close(); }
}, { transport: noNetwork }));

test("provider failures redact private errors and external-read permission is checked before searching", async () => {
  let searches = 0;
  await fixture(async (_repo, app) => {
    assert.equal(errorCode(await app.registry.execute("companies.discover-careers", { request: { companyName: "Synthetic" } }, context(["read-index"]))), "not-authorized"); assert.equal(searches, 0);
    const result = await app.registry.execute("companies.discover-careers", { request: { companyName: "Synthetic" } }, context());
    assert.equal(errorCode(result), "internal-error"); assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_ENDPOINT/); assert.equal(searches, 1);
  }, { transport: noNetwork, careerWebSearchProvider: { search: async () => { searches++; throw new Error("SYNTHETIC_PRIVATE_ENDPOINT"); } } });
});

const args = (...extra: string[]) => ["--data-dir", join(tmpdir(), "better-me-career-cli-synthetic"), "--origin", origin, ...extra];
test("CLI career search is disabled by default and only explicit supported provider/endpoint pairs are accepted", () => {
  const defaults = parseJobServiceArgs(args()); if (defaults.help) throw new Error("Unexpected help"); assert.equal(defaults.config.careerSearch, undefined);
  const duck = parseJobServiceArgs(args("--career-search", "duckduckgo-html")); if (duck.help) throw new Error("Unexpected help"); assert.deepEqual(duck.config.careerSearch, { provider: "duckduckgo-html" });
  const searx = parseJobServiceArgs(args("--career-search", "searxng", "--career-search-endpoint", "https://search.example.org/")); if (searx.help) throw new Error("Unexpected help"); assert.equal(searx.config.careerSearch?.provider, "searxng");
  for (const extra of [["--career-search", "bing-rss"], ["--career-search", "searxng"], ["--career-search-endpoint", "https://search.example.test/"],
    ["--career-search", "duckduckgo-html", "--career-search-endpoint", "https://search.example.test/"], ["--career-search", "duckduckgo-html", "--career-search", "searxng"],
    ["--career-search", "searxng", "--career-search-endpoint", "http://search.example.test/"], ["--career-search-api-key", "synthetic-key"]])
    assert.throws(() => parseJobServiceArgs(args(...extra)), (error: unknown) => error instanceof LocalJobServiceError && error.code === "invalid-config");
});

test("lifecycle validates career configuration before acquiring ownership and injects the configured factory without probing", async () => {
  const base = { dataDirectory: join(tmpdir(), "better-me-career-lifecycle-synthetic"), allowedOrigins: [origin], port: 0 };
  for (const careerSearch of [{ provider: "unknown" }, { provider: "duckduckgo-html", apiKey: "SYNTHETIC_PRIVATE_KEY" }, { provider: "searxng", endpoint: "https://user:secret@search.example.test/" }])
    assert.throws(() => validateJobServiceConfig({ ...base, careerSearch } as JobServiceConfig), (error: unknown) => error instanceof LocalJobServiceError && error.code === "invalid-config" && !error.message.includes("SYNTHETIC_PRIVATE_KEY"));
  for (const careerSearch of [undefined, { provider: "duckduckgo-html" as const }, { provider: "searxng" as const, endpoint: "https://private-instance.example.org/" }]) {
    const directory = await mkdtemp(join(tmpdir(), "better-me-career-lifecycle-")); let captured: JobApplicationOptions | undefined;
    const deps: JobServiceDependencies = { openRepository: () => ({ recoverInterruptedRuns: async () => ({ recovered: 0 }), close() {} }) as JobRepository,
      createApplication: input => { captured = input; return { registry: createToolRegistry([]), shutdown: async () => {} }; },
      createHttpServer: () => ({ listen: async () => ({ url: "http://127.0.0.1:23456", port: 23456 }), close: async () => {} }) };
    let handle: LocalJobServiceHandle | undefined;
    try {
      handle = await startLocalJobService({ ...base, dataDirectory: directory, ...(careerSearch ? { careerSearch } : {}) }, deps);
      assert.ok(captured); assert.equal(captured.careerWebSearchProvider?.metadata?.providerId, careerSearch?.provider);
      assert.equal(typeof captured.careerWebSearchProvider?.search, careerSearch ? "function" : "undefined"); assert.doesNotMatch(JSON.stringify(handle), /private-instance|endpoint|careerSearch/);
    } finally { await handle?.close(); await rm(directory, { recursive: true, force: true }); }
  }
});

test("CLI passes explicit career config to startup while logs keep the endpoint private", async () => {
  const signals = new EventEmitter(); let output = "", resolveReady!: () => void, captured: JobServiceConfig | undefined;
  const ready = new Promise<void>(resolve => { resolveReady = resolve; });
  const running = runJobServiceCli(args("--career-search", "searxng", "--career-search-endpoint", "https://private-instance.example.org/"), {
    signals, stdout: text => { output += text; resolveReady(); }, start: async config => {
      captured = config; return { url: "http://127.0.0.1:23456", port: 23456, dataDirectory: config.dataDirectory, databasePath: join(config.dataDirectory, "jobs.sqlite"), tokenPath: join(config.dataDirectory, "service.token"), allowedOrigins: config.allowedOrigins, dns: "system", recoveredRuns: 0, close: async () => {} };
    },
  });
  await ready; signals.emit("SIGINT"); assert.equal(await running, 0); assert.equal(captured?.careerSearch?.provider, "searxng");
  assert.match(output, /Career search: searxng/); assert.doesNotMatch(output, /private-instance|https:\/\/private/);
});
