import assert from "node:assert/strict";
import test from "node:test";
import {
  ImportReviewedCardsInputSchema, PreviewReviewedCardsInputSchema, ReviewedCardsCaptureSchema,
  REVIEWED_PLATFORM_NAMES, reviewedCardIdentity, reviewedCardsSearchPage,
  type ReviewedCardsCapture, type ReviewedSearchCard,
} from "../src/reviewed-cards.js";
import type { PlatformSearchProvider } from "../src/platform-search.js";

const urls = {
  "51job": ["https://we.51job.com/pc/search?keyword=C%23", "https://jobs.51job.com/shanghai-pdxq/123456.html"],
  boss: ["https://www.zhipin.com/web/geek/job?query=C%23", "https://www.zhipin.com/job_detail/Abc_42-xyz.html"],
  liepin: ["https://www.liepin.com/zhaopin/?key=C%23", "https://www.liepin.com/job/123456789.shtml"],
  linkedin: ["https://www.linkedin.com/jobs/search?keywords=C%23", "https://www.linkedin.com/jobs/view/synthetic-engineer-123456789/"],
} as const;
function capture(provider: PlatformSearchProvider = "liepin"): ReviewedCardsCapture {
  const [pageUrl, url] = urls[provider];
  const card: ReviewedSearchCard = {
    platform: REVIEWED_PLATFORM_NAMES[provider], url, title: "合成 C# 软件工程师", company: "合成企业",
    locationText: "上海·浦东", salaryText: "20–30k·13薪", publicationText: "3天前发布",
    cardText: "合成 C# 软件工程师 合成企业 上海·浦东 20–30k·13薪 3天前发布",
    evidence: { pageUrl, cardSelector: ".synthetic-card", fields: [
      { field: "url", selector: "a[href]", text: url }, { field: "title", selector: ".title", text: "合成 C# 软件工程师" },
      { field: "company", selector: ".company", text: "合成企业" }, { field: "locationText", selector: ".location", text: "上海·浦东" },
      { field: "salaryText", selector: ".salary", text: "20–30k·13薪" }, { field: "publicationText", selector: ".publication", text: "3天前发布" },
    ] },
  };
  return { provider, pageUrl, capturedAt: "2026-10-19T00:00:00.000Z", cards: [card] };
}

test("reviewed card contracts accept all four actual single-job URL shapes and preserve original fields", () => {
  for (const provider of Object.keys(urls) as PlatformSearchProvider[]) {
    const input = capture(provider);
    assert.deepEqual(ReviewedCardsCaptureSchema.parse(input), input);
    assert.equal(PreviewReviewedCardsInputSchema.parse({ ...input, expectedRevision: 0 }).expectedRevision, 0);
    assert.equal(ImportReviewedCardsInputSchema.parse({ ...input, expectedRevision: 1, previewFingerprint: "a".repeat(64), reviewed: true }).reviewed, true);
  }
});

test("identity survives tracking, host variants and LinkedIn title slugs without accepting share/search links", () => {
  assert.equal(reviewedCardIdentity("https://www.linkedin.com/jobs/view/renamed-title-123456789/?trk=search#top", "linkedin")?.id, "123456789");
  assert.equal(reviewedCardIdentity("https://de.linkedin.com/jobs/view/123456789/", "linkedin")?.id, "123456789");
  assert.equal(reviewedCardIdentity("https://m.zhipin.com/mpa/html/weijd/weijd-job/Abc_42-xyz", "boss")?.id, "Abc_42-xyz");
  for (const provider of Object.keys(urls) as PlatformSearchProvider[]) {
    assert.equal(reviewedCardIdentity(urls[provider][0], provider), undefined);
    assert.equal(reviewedCardsSearchPage(urls[provider][1], provider), undefined);
  }
});

test("exact official HTTPS boundary rejects suffix hosts, credentials, nonstandard ports and encoded lookalike paths", () => {
  for (const input of [
    "http://www.liepin.com/job/123.shtml", "https://www.liepin.com.evil.test/job/123.shtml",
    "https://user:secret@www.liepin.com/job/123.shtml", "https://www.liepin.com:444/job/123.shtml",
    "https://evil.test/job/123.shtml", "https://www.liepin.com/%6aob/123.shtml",
    "https://www.zhipin.com/job_detail/123.html", "https://www.liepin.com/job/123.shtml/extra",
  ]) assert.equal(reviewedCardIdentity(input, "liepin"), undefined, input);
});

test("reviewed contracts reject arbitrary domain state, availability claims, coordinates and incomplete company identity", () => {
  const input = capture();
  for (const extra of [{ dataset: {} }, { verified: true }, { availability: "open" }, { coordinates: { latitude: 31, longitude: 121 } }]) {
    assert.equal(ReviewedCardsCaptureSchema.safeParse({ ...input, ...extra }).success, false);
    assert.equal(ReviewedCardsCaptureSchema.safeParse({ ...input, cards: [{ ...input.cards[0], ...extra }] }).success, false);
  }
  assert.equal(ReviewedCardsCaptureSchema.safeParse({ ...input, cards: [{ ...input.cards[0], company: undefined }] }).success, false);
  assert.equal(ReviewedCardsCaptureSchema.safeParse({ ...input, cards: [] }).success, false);
  assert.equal(ReviewedCardsCaptureSchema.safeParse({ ...input, cards: Array.from({ length: 51 }, () => input.cards[0]) }).success, false);
  assert.equal(PreviewReviewedCardsInputSchema.safeParse(input).success, false);
  assert.equal(ImportReviewedCardsInputSchema.safeParse({ ...input, expectedRevision: 0, previewFingerprint: "a".repeat(64), reviewed: false }).success, false);
});

test("matching provider, search page, distinct stable IDs and field evidence are required together", () => {
  const input = capture();
  const card = input.cards[0]!;
  for (const cards of [
    [{ ...card, platform: "LinkedIn" }],
    [{ ...card, title: "证据外的岗位" }],
    [{ ...card, cardText: "无对应内容" }],
    [{ ...card, evidence: { ...card.evidence, pageUrl: "https://www.liepin.com/zhaopin/?key=java" } }],
    [{ ...card, evidence: { ...card.evidence, fields: card.evidence.fields.filter((field) => field.field !== "company") } }],
    [{ ...card, evidence: { ...card.evidence, fields: [...card.evidence.fields.slice(0, 5), card.evidence.fields[0]] } }],
    [card, { ...card, url: `${card.url}?tracking=duplicate`, evidence: { ...card.evidence,
      fields: card.evidence.fields.map((field) => field.field === "url" ? { ...field, text: `${card.url}?tracking=duplicate` } : field) } }],
  ]) assert.equal(ReviewedCardsCaptureSchema.safeParse({ ...input, cards }).success, false);
});

test("activity text cannot be relabeled as publication; absent optional disclosure remains absent", () => {
  const input = capture();
  const card = input.cards[0]!;
  const publicationText = "3天前更新";
  assert.equal(ReviewedCardsCaptureSchema.safeParse({ ...input, cards: [{ ...card, publicationText,
    cardText: card.cardText.replace("3天前发布", publicationText), evidence: { ...card.evidence,
      fields: card.evidence.fields.map((field) => field.field === "publicationText" ? { ...field, text: publicationText } : field) } }] }).success, false);
  const { locationText: _location, salaryText: _salary, publicationText: _publication, ...minimal } = card;
  const parsed = ReviewedCardsCaptureSchema.parse({ ...input, cards: [{ ...minimal, evidence: { ...card.evidence,
    fields: card.evidence.fields.filter((field) => ["url", "title", "company"].includes(field.field)) } }] });
  assert.equal(parsed.cards[0]!.locationText, undefined);
  assert.equal(parsed.cards[0]!.salaryText, undefined);
  assert.equal(parsed.cards[0]!.publicationText, undefined);
});
