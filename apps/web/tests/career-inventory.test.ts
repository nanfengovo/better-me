import assert from "node:assert/strict";
import test from "node:test";
import type { FactBase } from "@better-me/core";
import { inventorySource } from "../src/lib/inventory-source";

export const sample: FactBase = {
  schemaVersion: 1, updatedAt: "2026-01-01T00:00:00.000Z",
  profile: { displayName: { zh: "合成用户" }, email: "synthetic@example.invalid", links: [{ label: "独立作品集", url: "https://example.invalid/portfolio" }], traits: [], constraints: [], targetRoles: [] },
  experiences: [["edu","education","学校","2016-09","2020-06"],["old","work","旧岗位","2020-07","2021-10"],["new","work","最近的岗位","2021-11",null]].map(([id,type,title,start,end]) => ({
    id: id!, type: type as "work" | "education", title: { zh: title! }, org: { zh: "示例" }, start: start!, end: end ?? null, techStack: [], claims: [],
  })),
  importSource: { fileName: "fixture.txt", importedAt: "2026-01-01T00:00:00.000Z", rawText: "PRIVATE_RAW_SENTINEL", unparsedLines: ["未归位的作品"] },
};

test("inventory sees the newest work, standalone portfolio and unparsed material before school; source does not share contact or raw import", () => {
  const source = inventorySource("doc-A", "view-A", sample);
  assert.deepEqual(source.groups.map(g => g.kind), ["work","work","link","unparsed","education"]);
  assert.equal(source.groups[0]?.experienceId, "new");
  assert.doesNotMatch(JSON.stringify(source), /synthetic@example|PRIVATE_RAW_SENTINEL/);
});
