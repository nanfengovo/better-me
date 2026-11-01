import assert from "node:assert/strict";
import test from "node:test";
import { classifyHarvestLocation, harvestCardUrl, harvestMarketScope, scopeLiveHarvestCards, selectHarvestIndexJobIds } from "../src/components/atlas/harvest-scope";
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

test("live map joins platform IDs across title slugs and tracking, but not lookalike hosts or other providers", () => {
  const data = createAtlasDemo();
  const listing = data.listings[0]!;
  listing.canonicalUrl = "https://cn.linkedin.com/jobs/view/csharp-4483096821?trackingId=old";
  const expected = data.jobs.filter(job => job.listingIds.includes(listing.id)).map(job => job.id);
  const cards = (provider: "linkedin" | "liepin", url: string) => [{ provider, card: { url } }] as Parameters<typeof selectHarvestIndexJobIds>[1];
  assert.deepEqual(selectHarvestIndexJobIds(data, cards("linkedin", "https://www.linkedin.com/jobs/view/new-slug-4483096821?trackingId=new")), expected);
  assert.deepEqual(selectHarvestIndexJobIds(data, cards("linkedin", "https://linkedin.com.evil.test/jobs/view/4483096821")), []);
  assert.deepEqual(selectHarvestIndexJobIds(data, cards("liepin", "https://www.liepin.com/job/4483096821.shtml")), []);
  assert.deepEqual(selectHarvestIndexJobIds(data, cards("linkedin", "https://www.linkedin.com/jobs/view/4483096822")), []);
});

test("title-backed Liepin locations are recovered before geography filtering without inventing company locations", () => {
  const entry = (title: string, extra = {}) => ({ provider: "liepin" as const, platform: "猎聘" as const,
    card: { url: "https://www.liepin.com/job/123456.shtml", title, company: "上海合成公司", platform: "猎聘" as const,
      cardText: `${title} 上海合成公司`, evidence: { pageUrl: "https://www.liepin.com/zhaopin/?key=C%23", cardSelector: ".card",
        fields: [{ field: "title" as const, selector: ".title", text: title }] }, ...extra } });
  const district = entry(".net开发工程师【上海-静安区】");
  const city = entry("C#工程师【上海】");
  const unproven = entry("上海平台 C#开发", { evidence: { pageUrl: "https://www.liepin.com/zhaopin/?key=C%23", cardSelector: ".card", fields: [] } });
  const conflict = entry("C#工程师【上海】", { locationText: "深圳市南山区" });
  const forged = entry("C#工程师【上海】", { evidence: { pageUrl: "https://www.liepin.com/zhaopin/?key=C%23", cardSelector: ".card", fields: [{ field: "title", selector: ".title", text: "C#工程师" }] } });
  const scoped = scopeLiveHarvestCards([district, city, unproven, conflict, forged], { keyword: "C#", countryCodes: ["CN"], regionGroups: [["上海", "Shanghai"]] });
  assert.deepEqual(scoped.matching.map(e=>e.card.locationText), ["上海-静安区", "上海"]);
  assert.equal(scoped.outside.length, 1);
  assert.equal(scoped.unknown.length, 2);
  assert.equal(district.card.locationText, undefined, "source input is not rewritten");
  assert.deepEqual(scoped.matching[0]!.card.evidence.fields.at(-1), { field: "locationText", selector: ".title", text: "上海-静安区" });
});
