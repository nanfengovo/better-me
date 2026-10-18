import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import { buildPlatformSearchRequest } from "@better-me/source-adapters/browser-contracts";
import { readPlatformSearch, startPlatformSearch } from "../src/lib/platform-search-client.ts";
import { createJdStartRequestId } from "../src/lib/jd-start-request.ts";

const input = { provider: "liepin", keyword: "C#", regionId: "cn-shanghai" } as const;
const plan = buildPlatformSearchRequest(input);
const session = { sessionId: "synthetic-search-session-1234", platform: plan.platform, url: plan.url, expiresAt: "2026-10-18T18:00:00Z" };
const card = { platform: "猎聘", title: "Synthetic engineer", url: "https://www.liepin.com/job/1999999999.shtml", company: "Synthetic employer", cardText: "Synthetic list excerpt", evidence: { pageUrl: plan.url } };
const receipt = () => ({ status: "ready", platform: "猎聘", url: plan.url, cards: [card], partial: true, warnings: ["Single page only"], capturedAt: "2026-10-18T17:00:00Z" });
afterEach(() => mock.restoreAll());

test("platform client preserves exact search input and validates the returned session", async () => {
  const calls: unknown[] = [];
  const requestId = createJdStartRequestId();
  mock.method(globalThis, "fetch", async (url, options) => { assert.equal(url, "/api/jd/search-session"); calls.push(JSON.parse(String(options.body))); return Response.json(session); });
  assert.deepEqual(await startPlatformSearch(input, undefined, requestId), session);
  assert.deepEqual(calls, [{ action: "start", input, requestId }]);
});

test("list receipt keeps excerpt and publication unknown without substituting captured time", async () => {
  mock.method(globalThis, "fetch", async () => Response.json(receipt()));
  const found = await readPlatformSearch(session);
  assert.equal(found.cards[0]!.publicationText, undefined);
  assert.equal(found.capturedAt, "2026-10-18T17:00:00Z");
  assert.equal(found.partial, true);
});

test("client rejects changed region, cross-platform cards, duplicates and false empty status", async () => {
  for (const value of [
    { ...receipt(), url: plan.url.replace("dq=020", "dq=010").replace("city=020", "city=010") },
    { ...receipt(), cards: [{ ...card, url: "https://www.zhipin.com/job_detail/synthetic.html" }] },
    { ...receipt(), cards: [card, card] },
    { ...receipt(), status: "empty" },
    { ...receipt(), cards: [] },
  ]) {
    const fetcher = mock.method(globalThis, "fetch", async () => Response.json(value));
    await assert.rejects(readPlatformSearch(session)); fetcher.mock.restore();
  }
});

test("blocked and unavailable service outcomes are not converted into zero jobs", async () => {
  let value: unknown = { ...receipt(), status: "verification_required", cards: [] };
  mock.method(globalThis, "fetch", async () => Response.json(value));
  assert.equal((await readPlatformSearch(session)).status, "verification_required");
  value = { error: "Needs update", failure: { code: "service_unavailable", stage: "service", message: "Needs update" } };
  await assert.rejects(readPlatformSearch(session), /Needs update/);
});
