import assert from "node:assert/strict";
import test from "node:test";
import { ReviewedCardsCaptureSchema } from "@better-me/source-adapters/browser-contracts";
import { groupLiveCardsForReviewedImport } from "../src/components/atlas/live-platform-import-utils";

type Card = { url: string; evidence: { pageUrl: string } };

function card(id: number, page: number): Card {
  return {
    url: `https://www.liepin.com/job/${id}.shtml`,
    evidence: { pageUrl: `https://www.liepin.com/zhaopin/?key=java&page=${page}` },
  };
}

test("groups cards by evidence page, deduplicates across pages, and chunks at 50", () => {
  const input = [
    ...Array.from({ length: 51 }, (_, index) => card(index + 1, 1)),
    card(1, 2), // Duplicate identity on a later page: keep its first evidence.
    card(52, 2),
  ];

  const chunks = groupLiveCardsForReviewedImport(input, "liepin");

  assert.deepEqual(chunks.map(({ pageUrl, cards }) => [pageUrl, cards.length]), [
    ["https://www.liepin.com/zhaopin/?key=java&page=1", 50],
    ["https://www.liepin.com/zhaopin/?key=java&page=1", 1],
    ["https://www.liepin.com/zhaopin/?key=java&page=2", 1],
  ]);
  for (const { pageUrl, cards } of chunks) {
    assert.ok(cards.length <= 50);
    assert.ok(cards.every((item) => item.evidence.pageUrl === pageUrl));
  }
  assert.equal(chunks.flatMap(({ cards }) => cards).length, 52);
  assert.equal(chunks.flatMap(({ cards }) => cards).filter(({ url }) => url.endsWith("/1.shtml")).length, 1);
});

test("recovers only an explicitly disclosed city-and-district title into location evidence", () => {
  const pageUrl = "https://www.liepin.com/zhaopin/?key=C%23&city=020";
  const title = "C#软件开发工程师【上海-浦东新区】";
  const cardText = `${title} 小鳄生物技术（苏州）有限公司 20-40k·14薪`;
  const captured = {
    ...card(160085567, 1),
    platform: "猎聘",
    title,
    company: "小鳄生物技术（苏州）有限公司",
    cardText,
    evidence: {
      pageUrl,
      cardSelector: ".job-card",
      fields: [
        { field: "url", selector: "a[href]", text: "https://www.liepin.com/job/160085567.shtml" },
        { field: "title", selector: ".jname", text: title },
        { field: "company", selector: ".company", text: "小鳄生物技术（苏州）有限公司" },
      ],
    },
  };

  const imported = groupLiveCardsForReviewedImport([captured], "liepin")[0]!.cards[0]! as typeof captured & { locationText?: string };
  assert.equal(imported.locationText, "上海-浦东新区");
  assert.deepEqual(imported.evidence.fields.at(-1), {
    field: "locationText",
    selector: ".jname",
    text: "上海-浦东新区",
  });
  assert.ok(imported.cardText.includes(imported.locationText));
  const parsedCapture = ReviewedCardsCaptureSchema.parse({
    provider: "liepin",
    pageUrl,
    capturedAt: "2026-10-26T00:00:00.000Z",
    cards: [imported],
  });
  assert.equal(parsedCapture.cards[0]!.locationText, "上海-浦东新区");
});

test("does not invent a city/district location when the title only mentions a city or unrelated places", () => {
  const onlyCity = {
    ...card(20001, 1),
    title: "C#工程师 上海团队",
    cardText: "C#工程师 上海团队 合成企业",
    evidence: {
      pageUrl: "https://www.liepin.com/zhaopin/?key=C%23&page=1",
      cardSelector: ".job-card",
      fields: [
        { field: "url", selector: "a[href]", text: "https://www.liepin.com/job/20001.shtml" },
        { field: "title", selector: ".jname", text: "C#工程师 上海团队" },
        { field: "company", selector: ".company", text: "合成企业" },
      ],
    },
  };
  const unrelatedDistrict = {
    ...onlyCity,
    title: "C#工程师【上海团队】负责闵行区项目",
    cardText: "C#工程师【上海团队】负责闵行区项目 合成企业",
    evidence: { ...onlyCity.evidence, fields: onlyCity.evidence.fields.map((field) => field.field === "title" ? { ...field, text: "C#工程师【上海团队】负责闵行区项目" } : field) },
  };

  const cityOnlyResult = groupLiveCardsForReviewedImport([onlyCity], "liepin")[0]!.cards[0]!;
  const unrelatedResult = groupLiveCardsForReviewedImport([unrelatedDistrict], "liepin")[0]!.cards[0]!;
  assert.equal("locationText" in cityOnlyResult ? cityOnlyResult.locationText : undefined, undefined);
  assert.equal("locationText" in unrelatedResult ? unrelatedResult.locationText : undefined, undefined);
});

test("allows explicit smaller chunks for deterministic callers", () => {
  const chunks = groupLiveCardsForReviewedImport([card(1, 1), card(2, 1), card(3, 1)], "liepin", 2);
  assert.deepEqual(chunks.map(({ cards }) => cards.length), [2, 1]);
});

test("recovers an explicitly labelled location from a card excerpt without using employer geography", () => {
  const makeCard = (cardText: string) => ({
    ...card(30001, 1), platform: "猎聘", title: ".NET开发工程师", company: "苏州合成科技有限公司", cardText,
    evidence: { pageUrl: "https://www.liepin.com/zhaopin/?key=C%23&page=1", cardSelector: ".job-card", fields: [
      { field: "url", selector: "a", text: "https://www.liepin.com/job/30001.shtml" },
      { field: "title", selector: ".title", text: ".NET开发工程师" },
      { field: "company", selector: ".company", text: "苏州合成科技有限公司" },
    ] },
  });
  const source = makeCard(".NET开发工程师 苏州合成科技有限公司\n工作地点：上海-闵行区\n20-30k");
  const recovered = groupLiveCardsForReviewedImport([source], "liepin")[0]!.cards[0]! as typeof source & { locationText?: string };
  assert.equal(recovered.locationText, "上海-闵行区");
  assert.deepEqual(recovered.evidence.fields.at(-1), { field: "locationText", selector: ".job-card", text: "上海-闵行区" });
  ReviewedCardsCaptureSchema.parse({ provider: "liepin", pageUrl: recovered.evidence.pageUrl, capturedAt: "2026-10-26T00:00:00.000Z", cards: [recovered] });
  const unrelated = makeCard(".NET开发工程师 苏州合成科技有限公司\n公司介绍：服务上海-闵行区客户");
  const untouched = groupLiveCardsForReviewedImport([unrelated], "liepin")[0]!.cards[0]!;
  assert.equal("locationText" in untouched, false);
});

test("restores an existing literal location evidence value without duplicating evidence", () => {
  const source = {
    ...card(30002, 1), platform: "猎聘", title: ".NET开发工程师", company: "合成科技有限公司",
    cardText: ".NET开发工程师 合成科技有限公司 上海",
    evidence: { pageUrl: "https://www.liepin.com/zhaopin/?key=C%23&page=1", cardSelector: ".job-card", fields: [
      { field: "url", selector: "a", text: "https://www.liepin.com/job/30002.shtml" },
      { field: "title", selector: ".title", text: ".NET开发工程师" },
      { field: "company", selector: ".company", text: "合成科技有限公司" },
      { field: "locationText", selector: ".area", text: "上海" },
    ] },
  };
  const recovered = groupLiveCardsForReviewedImport([source], "liepin")[0]!.cards[0]! as typeof source & { locationText?: string };
  assert.equal(recovered.locationText, "上海");
  assert.equal(recovered.evidence.fields.filter((field) => field.field === "locationText").length, 1);
  ReviewedCardsCaptureSchema.parse({ provider: "liepin", pageUrl: recovered.evidence.pageUrl, capturedAt: "2026-10-26T00:00:00.000Z", cards: [recovered] });
});

test("rejects invalid chunk limits", () => {
  assert.throws(() => groupLiveCardsForReviewedImport([], "liepin", 0), /positive integer/);
});

test("rejects cards without an official search-page source or single-job URL", () => {
  assert.throws(() => groupLiveCardsForReviewedImport([
    { ...card(1, 1), evidence: { pageUrl: "https://example.invalid/search?q=java" } },
  ], "liepin"), /official search page/);
  assert.throws(() => groupLiveCardsForReviewedImport([
    { ...card(1, 1), url: "https://www.liepin.com/zhaopin/?key=java" },
  ], "liepin"), /single-job identity/);
});
