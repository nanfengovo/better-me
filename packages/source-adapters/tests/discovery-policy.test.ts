import assert from "node:assert/strict";
import test from "node:test";
import type { SourceDefinition } from "@better-me/opportunities";
import { discoveryPolicyAdapter } from "../src/adapters/discovery-policy.js";
import { SourceRegistryError, type SourceAdapterRequest } from "../src/contracts.js";
import { createSourceRegistry } from "../src/registry.js";

const source: SourceDefinition = {
  sourceId: "synthetic-policy", name: "Synthetic policy", adapterId: "discovery-policy", adapterVersion: "1",
  capabilities: ["discover-sources"], runtime: ["local-service"], entityType: "company-directory", enabled: true, status: "active", remoteFilters: [],
  endpointPolicy: { allowedHosts: ["careers.example.test"], allowedPathPrefixes: ["/company"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
  attribution: { label: "Synthetic policy", usage: "link-only", requiresAttribution: true },
  refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 20, maxPages: 2, requestsPerMinute: 6 },
};
const code = (expected: string) => (error: unknown) => error instanceof SourceRegistryError && error.code === expected;

test("installed discovery-policy advertises only discovery leads and resolves company-directory without claiming job listing", () => {
  const registry = createSourceRegistry([discoveryPolicyAdapter]);
  assert.deepEqual(registry.describe(), [{ adapterId: "discovery-policy", version: "1", capabilities: ["discover-sources"], remoteFilters: [], entityTypes: ["discovery-lead"] }]);
  assert.deepEqual(registry.resolve(source, "discover-sources", "local-service").capabilities, ["discover-sources"]);
  assert.throws(() => registry.resolve(source), code("unsupported-capability"));
  assert.throws(() => registry.resolve({ ...source, capabilities: ["discover-sources", "list-jobs"] }), code("unsupported-capability"));
});

test("discovery-policy list rejects before transport even when called directly", async () => {
  const input: SourceAdapterRequest = { source, scope: { roles: [], regions: [], companyNames: [] },
    context: { requestId: "synthetic-policy-list", actorScope: "synthetic-owner", observedAt: "2026-10-19T00:00:00.000Z", signal: new AbortController().signal,
      budget: { requests: 1, bytes: 1024, timeoutMs: 1000 }, throwIfCancelled() {}, consumeRequests() {}, consumeBytes() {} },
    transport: { request: async () => { throw new Error("A discovery policy must never list or fetch jobs"); } } };
  await assert.rejects(createSourceRegistry([discoveryPolicyAdapter]).list(input), code("unsupported-capability"));
  await assert.rejects(discoveryPolicyAdapter.list(input), code("unsupported-capability"));
});

test("discovery-policy obeys installed version, source status, entity and runtime checks", () => {
  const registry = createSourceRegistry([discoveryPolicyAdapter]);
  for (const disabled of [{ enabled: false }, { status: "needs-review" as const }, { status: "unavailable" as const }])
    assert.throws(() => registry.resolve({ ...source, ...disabled }, "discover-sources", "local-service"), code("source-disabled"));
  assert.throws(() => registry.resolve({ ...source, adapterVersion: "2" }, "discover-sources", "local-service"), code("unsupported-version"));
  assert.throws(() => registry.resolve({ ...source, entityType: "job-posting" }, "discover-sources", "local-service"), code("unsupported-capability"));
  assert.throws(() => registry.resolve({ ...source, runtime: ["server"] }, "discover-sources", "local-service"), code("unsupported-capability"));
});
