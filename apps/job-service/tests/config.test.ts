import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { SourceDefinitionSchema } from "@better-me/opportunities";
import { createSourceRegistry, greenhouseAdapter, leverAdapter, ashbyAdapter, mappedJsonAdapter, githubJsonAdapter, tencentAdapter } from "@better-me/source-adapters";

test("shipped source examples remain disabled and resolve to installed adapters after an explicit reviewed enable", async () => {
  const rows: unknown = JSON.parse(await readFile(new URL("../../../config/sources/examples.json", import.meta.url), "utf8"));
  assert.ok(Array.isArray(rows));
  assert.ok(rows.length > 0);
  const registry = createSourceRegistry([greenhouseAdapter, leverAdapter, ashbyAdapter, mappedJsonAdapter, githubJsonAdapter, tencentAdapter]);
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
