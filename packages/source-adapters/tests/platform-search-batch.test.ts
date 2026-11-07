import assert from "node:assert/strict";
import test from "node:test";
import {
  PlatformSearchBatchError, appendPlatformSearchBatch, createPlatformSearchBatch,
  flattenPlatformSearchBatch, readyPlatformSearchPageCaptures,
  type PlatformSearchBatchPageInput,
} from "../src/platform-search-batch.js";
import type { PlatformSearchInput } from "../src/platform-search.js";

const input: PlatformSearchInput = { provider: "liepin", keyword: "C#", regionId: "cn-shanghai" };
const card = (id: string, pageUrl: string) => ({
  platform: "猎聘" as const, url: `https://www.liepin.com/job/${id}.shtml`, title: `C# 工程师 ${id}`, company: "合成企业",
  locationText: "上海·浦东", cardText: `C# 工程师 ${id} 合成企业 上海·浦东`, evidence: { pageUrl, cardSelector: ".job-card", fields: [
    { field: "url" as const, selector: "a", text: `https://www.liepin.com/job/${id}.shtml` },
    { field: "title" as const, selector: ".title", text: `C# 工程师 ${id}` },
    { field: "company" as const, selector: ".company", text: "合成企业" },
    { field: "locationText" as const, selector: ".location", text: "上海·浦东" },
  ] },
});
const page = (pageIndex: number, ids: string[], status: "ready" | "empty" = "ready", pageUrl = `https://www.liepin.com/zhaopin/?key=C%23&city=020&dq=020&page=${pageIndex + 1}`): PlatformSearchBatchPageInput => ({
  provider: "liepin", pageUrl, capturedAt: "2026-10-24T00:00:00.000Z", pageIndex, status, cards: ids.map(id => card(id, pageUrl)), partial: false, warnings: [],
});

test("batch preserves page evidence and deduplicates stable platform IDs across manual pages", () => {
  const first = createPlatformSearchBatch(input, "search-session-123456", page(0, ["100", "101"]));
  const second = appendPlatformSearchBatch(first, page(1, ["101", "102"]));
  assert.deepEqual(second.pages.map(value => value.pageIndex), [0, 1]);
  assert.deepEqual(flattenPlatformSearchBatch(second).map(value => value.url), [
    "https://www.liepin.com/job/100.shtml", "https://www.liepin.com/job/101.shtml", "https://www.liepin.com/job/102.shtml",
  ]);
  const captures = readyPlatformSearchPageCaptures(second);
  assert.equal(captures.length, 2);
  assert.equal(captures[0]!.pageUrl.endsWith("page=1"), true);
  assert.equal(captures[1]!.cards[0]!.evidence.pageUrl.endsWith("page=2"), true);
});

test("batch rejects scope changes, non-increasing pages and gate pages", () => {
  const first = createPlatformSearchBatch(input, "search-session-123456", page(0, ["100"]));
  assert.throws(() => appendPlatformSearchBatch(first, page(1, ["101"], "ready", "https://www.liepin.com/zhaopin/?key=Python&page=2")), (error: unknown) => error instanceof PlatformSearchBatchError && error.code === "scope-changed");
  assert.throws(() => appendPlatformSearchBatch(first, page(0, ["101"], "ready", "https://www.liepin.com/zhaopin/?key=C%23&city=020&dq=020&page=2")), (error: unknown) => error instanceof PlatformSearchBatchError && error.code === "page-order");
  assert.throws(() => appendPlatformSearchBatch(first, page(1, ["101"], "ready", "https://www.liepin.com/zhaopin/?key=C%23&city=020&dq=020&page=1")), (error: unknown) => error instanceof PlatformSearchBatchError && error.code === "duplicate-page");
  assert.throws(() => appendPlatformSearchBatch(first, { ...page(1, []), status: "verification_required", warnings: ["人工验证"] }), (error: unknown) => error instanceof PlatformSearchBatchError && error.code === "unsupported-page");
  assert.throws(() => createPlatformSearchBatch(input, "short", page(0, ["100"])), (error: unknown) => error instanceof PlatformSearchBatchError && error.code === "invalid-batch");
});

test("empty pages remain explicit diagnostics and contribute no cards", () => {
  const batch = createPlatformSearchBatch(input, "search-session-123456", page(0, [], "empty"));
  assert.deepEqual(flattenPlatformSearchBatch(batch), []);
  assert.deepEqual(readyPlatformSearchPageCaptures(batch), []);
  assert.equal(batch.pages[0]!.status, "empty");
});

test("legacy page captures omit cards with unknown employers and skip pages with no importable cards", () => {
  const firstPage = page(0, ["100", "101"]);
  const firstCard = firstPage.cards[0]!;
  const { company: _company, ...cardWithoutCompany } = firstCard;
  const missingEmployerPage = {
    ...firstPage,
    cards: [{ ...cardWithoutCompany, evidence: { ...cardWithoutCompany.evidence, fields: cardWithoutCompany.evidence.fields.filter(field => field.field !== "company") } }],
  };
  const secondPage = page(1, ["102"], "ready", "https://www.liepin.com/zhaopin/?key=C%23&city=020&dq=020&page=2");
  const thirdPage = page(2, ["103"], "ready", "https://www.liepin.com/zhaopin/?key=C%23&city=020&dq=020&page=3");
  const thirdCard = thirdPage.cards[0]!;
  const { company: _thirdCompany, ...thirdCardWithoutCompany } = thirdCard;
  const onlyUnknownEmployerPage = {
    ...thirdPage,
    cards: [{ ...thirdCardWithoutCompany, evidence: { ...thirdCardWithoutCompany.evidence, fields: thirdCardWithoutCompany.evidence.fields.filter(field => field.field !== "company") } }],
  };
  const batch = createPlatformSearchBatch(input, "search-session-123456", missingEmployerPage);
  const withImportablePage = appendPlatformSearchBatch(batch, secondPage);
  const allPages = appendPlatformSearchBatch(withImportablePage, onlyUnknownEmployerPage);
  const captures = readyPlatformSearchPageCaptures(allPages);
  assert.equal(captures.length, 1);
  assert.equal(captures[0]!.cards.length, 1);
  assert.equal(captures[0]!.cards[0]!.url, secondPage.cards[0]!.url);
  assert.equal(allPages.pages.reduce((count, page) => count + page.cards.length, 0), 3);
});
