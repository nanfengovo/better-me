import assert from "node:assert/strict";
import test from "node:test";
import { buildLiveBatchSearchPlans } from "../server/jd-live-batch-search";
import { resolvePlatformSearchRegion } from "@better-me/source-adapters/browser-contracts";
test("LinkedIn explicitly submits the configured country rather than using a default location", () => {
  for (const regionId of ["中国", "美国", "Germany"]) {
    const plan = buildLiveBatchSearchPlans({ keyword: "C#", regionId, providers: ["linkedin"], depth: "quick" })[0]!;
    assert.equal(new URL(plan.url).searchParams.get("location"), resolvePlatformSearchRegion(regionId)!.platforms.linkedin);
  }
});
test("unmapped native city filters disclose the fallback instead of claiming requested-region coverage", () => {
  const plan = buildLiveBatchSearchPlans({ keyword: "C#", regionId: "美国", providers: ["51job"], depth: "quick" })[0]!;
  assert.ok(plan.warnings.some(warning => warning.includes("不代表已覆盖请求地区")));
});
