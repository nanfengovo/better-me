import assert from "node:assert/strict";
import test from "node:test";
import { AtlasDatasetSchema, queryJobs } from "@better-me/opportunities";
import { createAtlasDemo } from "../src/components/atlas/demo.ts";
import { buildAtlasListingPresentations, createAtlasListingPresenter, formatAtlasPublication, getAtlasSourceBadge, getDefaultAtlasPresentationConfig, parseAtlasPresentationConfig } from "../src/components/atlas/presentation.ts";

const NOW = "2026-10-18T12:00:00.000Z";
const publication = (publishedAt: string, now = NOW, timeZone = "Asia/Shanghai") => formatAtlasPublication({ publishedAt }, { now, timeZone });

test("source colors match explicit IDs, adapters and platforms in order; unknown sources have stable finite colors", () => {
  assert.equal(getAtlasSourceBadge({ sourceId: "51job", adapterId: "greenhouse" }).id, "51job");
  assert.equal(getAtlasSourceBadge({ sourceId: "company-board", adapterId: "greenhouse" }).id, "greenhouse");
  assert.equal(getAtlasSourceBadge({ sourceId: "browser-result", platform: "BOSS直聘" }).id, "boss");
  assert.equal(getAtlasSourceBadge({ sourceId: "browser-result", platform: " 领英 " }).id, "linkedin");
  const first = getAtlasSourceBadge({ sourceId: "a-new-source", platform: "Unknown board" });
  assert.equal(first.matchedBy, "fallback");
  assert.deepEqual(getAtlasSourceBadge({ sourceId: "a-new-source", platform: "Different display name" }), first);
  assert.deepEqual(getAtlasSourceBadge({ sourceId: "A-NEW-SOURCE" }), first);
  assert.ok([first.foreground, first.background, first.border].every((color) => /^#[\dA-Fa-f]{6}$/.test(color)));
});

test("JSON overrides are detached and reject CSS, unsupported versions, unknown fields and invalid timezones", () => {
  const config = getDefaultAtlasPresentationConfig();
  config.sourceRules.unshift({ id: "personal-source", sourceIds: ["company-board"], colors: { foreground: "#112233", background: "#EEDDCC", border: "#AABBCC" } });
  assert.equal(getAtlasSourceBadge({ sourceId: "company-board", adapterId: "greenhouse" }, config).id, "personal-source");
  config.publicationColors.fresh.foreground = "#123456";
  assert.equal(formatAtlasPublication({ publishedAt: NOW }, { now: NOW, config }).colors.foreground, "#123456");
  assert.notEqual(getDefaultAtlasPresentationConfig().publicationColors.fresh.foreground, "#123456");
  const parsed = parseAtlasPresentationConfig(config); parsed.sourceRules[0]!.colors.foreground = "#000000";
  assert.equal(config.sourceRules[0]!.colors.foreground, "#112233");
  for (const input of [
    { ...config, schemaVersion: 2 }, { ...config, css: "body {}" }, { ...config, timeZone: "Invalid/Timezone" },
    { ...config, sourcePalette: [] }, { ...config, sourceRules: [...config.sourceRules, config.sourceRules[0]] },
    { ...config, sourcePalette: [{ foreground: "red;position:fixed", background: "#FFFFFF", border: "#000000" }] },
    { ...config, sourceRules: [{ id: "bad", sourceIds: ["source"], colors: { foreground: "url(https://example.invalid)", background: "#FFFFFF", border: "#000000" } }] },
  ]) assert.throws(() => parseAtlasPresentationConfig(input));
});

test("recent exact publications use elapsed hours and days, with a distinct color from unknown or older dates", () => {
  assert.equal(publication("2026-10-18T11:30:00.000Z").label, "刚刚发布（不足 1 小时）");
  assert.equal(publication("2026-10-18T10:00:00.000Z").label, "2 小时前发布");
  assert.equal(publication("2026-10-16T12:00:00.000Z").label, "2 天前发布");
  assert.equal(publication("2026-10-18T10:00:00.000Z").precision, "instant");
  assert.equal(publication("2026-10-18T10:00:00.000Z").status, "fresh");
  assert.equal(publication("2026-10-16T12:00:00.000Z").status, "recent");
  assert.notDeepEqual(publication(NOW).colors, formatAtlasPublication({}, { now: NOW }).colors);
});

test("the one-calendar-month boundary preserves the clock and clamps January 31 in leap and ordinary February", () => {
  assert.equal(publication("2026-01-31T10:00:00Z", "2026-02-28T09:59:59Z", "UTC").status, "recent");
  const exact = publication("2026-01-31T10:00:00Z", "2026-02-28T10:00:00Z", "UTC");
  assert.equal(exact.status, "older"); assert.equal(exact.label, "2026-01-31 发布");
  assert.equal(publication("2024-01-31T10:00:00Z", "2024-02-28T10:00:00Z", "UTC").status, "recent");
  assert.equal(publication("2024-01-31T10:00:00Z", "2024-02-29T10:00:00Z", "UTC").status, "older");
  assert.equal(publication("2025-12-31T10:00:00Z", "2026-01-31T10:00:00Z", "UTC").label, "2025-12-31 发布");
});

test("publication display explicitly follows the requested timezone rather than the machine timezone", () => {
  const at = "2026-09-17T20:00:00Z";
  assert.equal(publication(at, NOW, "Asia/Shanghai").calendarDate, "2026-09-18");
  assert.equal(publication(at, NOW, "UTC").calendarDate, "2026-09-17");
  assert.equal(publication(at, NOW, "America/New_York").timeZone, "America/New_York");
  assert.throws(() => publication(at, NOW, "Not/A_Zone"));
  assert.throws(() => formatAtlasPublication({ publishedAt: at }, { now: "invalid" }));
  assert.throws(() => formatAtlasPublication({ publishedAt: at }, { now: "2026-10-18 09:00:00" }));
});

test("date-only source disclosures preserve day precision without inventing an instant or midnight", () => {
  const today = formatAtlasPublication({ publishedRaw: "2026-10-18" }, { now: NOW });
  assert.equal(today.label, "今天发布（仅日期）"); assert.equal(today.precision, "date"); assert.equal(today.publishedAt, undefined);
  const twoDays = formatAtlasPublication({ publishedRaw: "2026-10-16" }, { now: NOW });
  assert.equal(twoDays.label, "2 天前发布（仅日期）");
  const month = formatAtlasPublication({ publishedRaw: "2026-09-18" }, { now: NOW });
  assert.equal(month.label, "2026-09-18 发布（仅日期）"); assert.equal(month.status, "older");
  // Raw source precision takes precedence over a separately normalized midnight field.
  assert.equal(formatAtlasPublication({ publishedRaw: "2026-10-18", publishedAt: "2026-10-18T00:00:00Z" }, { now: NOW }).precision, "date");
});

test("relative text, timezone-free dates and month-only dates remain raw; invalid and future dates require review", () => {
  for (const raw of ["3天前", "刚刚", "2026-10", "2026-10-18 09:00:00", "Oct 18"]) {
    const result = formatAtlasPublication({ publishedRaw: raw }, { now: NOW });
    assert.equal(result.precision, "raw"); assert.equal(result.status, "unknown"); assert.equal(result.raw, raw);
    assert.equal(result.publishedAt, undefined); assert.equal(result.calendarDate, undefined);
  }
  for (const input of [{ publishedRaw: "2026-02-30" }, { publishedAt: "2026-02-30T10:00:00Z" }, { publishedAt: "not-a-time" }]) {
    assert.equal(formatAtlasPublication(input, { now: NOW }).reason, "invalid-date");
  }
  assert.equal(publication("2026-10-18T12:00:00.001Z").reason, "future");
  assert.equal(formatAtlasPublication({ publishedRaw: "2026-10-19" }, { now: NOW }).reason, "future");
  assert.equal(formatAtlasPublication({}, { now: NOW }).label, "发布时间未知");
});

test("each listing keeps its publication time, not fetch/update times or another source's disclosure", async () => {
  const data = createAtlasDemo();
  const job = data.jobs[0]!, listing = data.listings[0]!, observation = data.observations[0]!;
  data.sources[0]!.adapterId = "greenhouse";
  observation.sourcePublishedAt = "2026-10-18T10:00:00Z"; observation.fetchedAt = NOW;
  observation.sourceUpdatedAt = NOW; job.updatedAt = NOW;
  data.sources.push({ ...data.sources[0]!, sourceId: "other-source", adapterId: "lever", attribution: { ...data.sources[0]!.attribution, label: "第二来源" } });
  data.listings.push({ ...listing, id: "other-listing", sourceId: "other-source", canonicalUrl: "https://example.invalid/other", observationIds: ["other-observation", "failed-observation"] });
  job.listingIds.push("other-listing");
  data.observations.push({ ...observation, id: "other-observation", listingId: "other-listing", sourcePublishedAt: "2026-08-01T00:00:00Z" },
    { ...observation, id: "failed-observation", listingId: "other-listing", result: "failed", fetchedAt: "2026-10-18T13:00:00Z", sourcePublishedAt: "2026-10-18T11:00:00Z" });
  const parsed = AtlasDatasetSchema.parse(data);
  const item = (await queryJobs(parsed, { jobIds: [job.id] }, { now: NOW })).items[0]!;
  const rows = buildAtlasListingPresentations(parsed, item, { now: NOW });
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.publication.label, "2 小时前发布"); assert.equal(rows[0]!.badge.id, "greenhouse");
  assert.equal(rows[1]!.publication.label, "2026-08-01 发布"); assert.equal(rows[1]!.badge.id, "lever");
  assert.equal(rows[1]!.publication.observationId, "other-observation");
  assert.deepEqual(createAtlasListingPresenter(parsed, { now: NOW })(item), rows);
  delete observation.sourcePublishedAt;
  const missing = buildAtlasListingPresentations(data, item, { now: NOW });
  assert.equal(missing[0]!.publication.status, "unknown"); assert.equal(missing[0]!.publication.publishedAt, undefined);
});

test("source publication survives a later successful response with no disclosed date and conflicting simultaneous disclosures stay visible", async () => {
  const data = createAtlasDemo();
  const original = data.observations[0]!, listing = data.listings[0]!;
  original.sourcePublishedRaw = "2026-09-01";
  data.observations.push({ ...original, id: "without-date", fetchedAt: NOW, sourcePublishedRaw: undefined }); listing.observationIds.push("without-date");
  const item = (await queryJobs(data, { jobIds: [data.jobs[0]!.id] }, { now: NOW })).items[0]!;
  assert.equal(buildAtlasListingPresentations(data, item, { now: NOW })[0]!.publication.label, "2026-09-01 发布（仅日期）");
  data.observations.push({ ...original, id: "conflicting-date", sourcePublishedRaw: "2026-09-02" }); listing.observationIds.push("conflicting-date");
  const conflict = buildAtlasListingPresentations(data, item, { now: NOW })[0]!.publication;
  assert.equal(conflict.status, "review"); assert.equal(conflict.reason, "conflicting-publication");
});

test("equivalent timestamp offsets do not create false publication conflicts, but exact simultaneous conflicting dates do", async () => {
  const data = createAtlasDemo();
  const original = data.observations[0]!, listing = data.listings[0]!;
  original.sourcePublishedRaw = "2026-10-18T10:00:00Z"; original.fetchedAt = "2026-10-18T12:00:00Z";
  const other = { ...original, id: "equivalent-offset", sourcePublishedRaw: "2026-10-18T18:00:00+08:00", fetchedAt: "2026-10-18T20:00:00+08:00" };
  data.observations.push(other); listing.observationIds.push(other.id);
  const item = (await queryJobs(data, { jobIds: [data.jobs[0]!.id] }, { now: NOW })).items[0]!;
  assert.equal(buildAtlasListingPresentations(data, item, { now: NOW })[0]!.publication.status, "fresh");
  other.sourcePublishedRaw = "2026-10-16";
  assert.equal(buildAtlasListingPresentations(data, item, { now: NOW })[0]!.publication.reason, "conflicting-publication");
});
