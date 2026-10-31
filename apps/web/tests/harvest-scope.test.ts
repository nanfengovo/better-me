import assert from "node:assert/strict";
import test from "node:test";
import { classifyHarvestLocation, harvestCardUrl, harvestMarketScope, selectHarvestIndexJobIds } from "../src/components/atlas/harvest-scope";
import { createAtlasDemo } from "../src/components/atlas/demo";

test("domestic geography uses disclosed location, not platform or company nationality", () => {
  const query = harvestMarketScope("domestic", "");
  assert.equal(classifyHarvestLocation("美国 俄亥俄州 哥伦布", query), "outside");
  assert.equal(classifyHarvestLocation("Columbus, Ohio, United States", query), "outside");
  assert.equal(classifyHarvestLocation("上海市浦东新区", query), "matching");
  assert.equal(classifyHarvestLocation("Shanghai, China", query), "matching");
  assert.equal(classifyHarvestLocation(undefined, query), "unknown");
  assert.equal(classifyHarvestLocation("Remote / Worldwide", query), "unknown");
  assert.equal(classifyHarvestLocation("未披露", query), "unknown");
  assert.equal(classifyHarvestLocation("China Grove, United States", query), "unknown");
  assert.equal(classifyHarvestLocation("中国香港 中环", { countryCodes: ["HK"] }), "matching");
  assert.equal(classifyHarvestLocation("印度尼西亚", { countryCodes: ["ID"] }), "matching");
  assert.equal(classifyHarvestLocation("内蒙古自治区呼和浩特市", query), "matching");
  assert.equal(classifyHarvestLocation("Inner Mongolia, China", query), "matching");
  assert.equal(classifyHarvestLocation("广东省", query), "matching");
  assert.equal(classifyHarvestLocation("蒙古 乌兰巴托", query), "outside");
});

test("country, city and district are independent required filters", () => {
  const query = { ...harvestMarketScope("domestic", ""), regionGroups: [["上海", "Shanghai"], ["浦东", "Pudong"]] };
  assert.equal(classifyHarvestLocation("中国 上海 浦东", query), "matching");
  assert.equal(classifyHarvestLocation("中国 上海 闵行", query), "outside");
  assert.equal(classifyHarvestLocation("United States, Shanghai", query), "outside");
  assert.equal(classifyHarvestLocation("United States, Columbus", harvestMarketScope("global", "US")), "matching");
  assert.equal(classifyHarvestLocation("Berlin, Germany", harvestMarketScope("global", "US")), "outside");
});

test("live map joins only captured listing URLs, never matching employer names", () => {
  const data = createAtlasDemo();
  const listing = data.listings[0]!;
  const card = { card: { url: `${listing.canonicalUrl}#tracking` } };
  // Only the URL field is read by this join; deliberately use a small structural fixture.
  const cards = [card] as Parameters<typeof selectHarvestIndexJobIds>[1];
  assert.deepEqual(selectHarvestIndexJobIds(data, cards), data.jobs.filter(job => job.listingIds.includes(listing.id)).map(job => job.id));
  assert.deepEqual(selectHarvestIndexJobIds(data, []), []);
  assert.deepEqual(selectHarvestIndexJobIds(null, cards), []);
});

test("listing identity drops tracking but retains job IDs and SPA routes", () => {
  assert.equal(harvestCardUrl("https://example.test/job?id=42&utm_source=fixture#section"), "https://example.test/job?id=42");
  assert.equal(harvestCardUrl("https://example.test/#/jobs/42"), "https://example.test/#/jobs/42");
  assert.notEqual(harvestCardUrl("https://example.test/#/jobs/42"), harvestCardUrl("https://example.test/#/jobs/43"));
});
