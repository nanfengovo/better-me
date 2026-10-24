import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readFileSync } from "node:fs";
import { SourceDefinitionSchema } from "@better-me/opportunities";
import { createSourceRegistry, greenhouseAdapter, leverAdapter, ashbyAdapter, remotiveAdapter, mappedJsonAdapter, githubJsonAdapter, tencentAdapter } from "@better-me/source-adapters";
import { sourceCatalog } from "../../web/src/components/atlas/source-catalog.js";

test("shipped source examples remain disabled and resolve to installed adapters after an explicit reviewed enable", async () => {
  const rows: unknown = JSON.parse(await readFile(new URL("../../../config/sources/examples.json", import.meta.url), "utf8"));
  assert.ok(Array.isArray(rows));
  assert.ok(rows.length > 0);
  const registry = createSourceRegistry([greenhouseAdapter, leverAdapter, ashbyAdapter, remotiveAdapter, mappedJsonAdapter, githubJsonAdapter, tencentAdapter]);
  const ids = new Set<string>();
  for (const row of rows) {
    const source = SourceDefinitionSchema.parse(row);
    assert.equal(source.enabled, false);
    assert.equal(source.status, "needs-review");
    assert.equal(ids.has(source.sourceId), false);
    ids.add(source.sourceId);
    const reviewed = { ...source, enabled: true, status: "active" as const };
    const resolved = registry.resolve(reviewed, "list-jobs", "local-service");
    assert.equal(resolved.adapter.adapterId, source.adapterId);
    if (source.adapterId === "github-json") {
      assert.equal(source.entityType, "company-directory");
      assert.deepEqual(resolved.adapter.entityTypes, ["discovery-lead"]);
    }
  }
});

test("Remotive reviewed catalog entry uses the installed adapter, honors source policy, and remains opt-in", () => {
  const catalog = JSON.parse(readFileSync(new URL("../../../config/sources/catalog.json", import.meta.url), "utf8")) as { entries: Array<{ source: unknown; coverage: string; evidenceUrls: string[] }> };
  const entry = catalog.entries.find((value) => (value.source as { adapterId?: string }).adapterId === "remotive");
  assert.ok(entry);
  const source = SourceDefinitionSchema.parse(entry.source);
  assert.equal(source.enabled, false); assert.equal(source.status, "needs-review");
  assert.equal(source.entryUrl, "https://remotive.com/api/remote-jobs");
  assert.deepEqual(source.endpointPolicy.allowedHosts, ["remotive.com"]);
  assert.deepEqual(source.endpointPolicy.allowedPathPrefixes, ["/api/remote-jobs"]);
  assert.equal(source.refreshPolicy.minIntervalSeconds, 6 * 60 * 60);
  assert.equal(source.refreshPolicy.requestsPerMinute, 2); assert.equal(source.refreshPolicy.maxRequestsPerUtcDay, 4); assert.equal(source.refreshPolicy.maxRecords, 100);
  assert.match(source.attribution.notes ?? "", /不转交其他招聘网站/);
  assert.match(entry.coverage, /不是工作办公室/);
  assert.ok(entry.evidenceUrls.includes("https://github.com/remotive-com/remote-jobs-api"));
  const uiEntry = sourceCatalog.find((value) => value.source.sourceId === source.sourceId);
  assert.ok(uiEntry, "the source must flow through the actual Atlas catalog UI");
  assert.deepEqual(uiEntry.source, source);
});
