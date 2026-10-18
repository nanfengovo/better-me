import assert from "node:assert/strict";
import test from "node:test";
import { createJobApplication } from "../src/application.ts";
import { createJobHttpServer } from "../src/http.ts";
import { openJobRepository } from "../src/repository.ts";

test("reviewed cards use the authenticated application routes and become searchable with original evidence", async () => {
  const at = "2026-10-19T02:00:00Z";
  const token = "synthetic-reviewed-http-token-0123456789";
  const repository = openJobRepository(":memory:", { now: () => at });
  const app = createJobApplication({ repository, now: () => at });
  const server = createJobHttpServer({ registry: app.registry, token, allowedOrigins: ["http://atlas-ui.invalid"], port: 0 });
  const { url } = await server.listen();
  const pageUrl = "https://www.liepin.com/zhaopin/?key=C%23&city=020&dq=020";
  const card = { platform: "猎聘", url: "https://www.liepin.com/job/1234567890.shtml", title: "合成 C# 工程师", company: "合成上海企业", locationText: "上海-浦东新区",
    cardText: "合成 C# 工程师 合成上海企业 上海-浦东新区", evidence: { pageUrl, cardSelector: ".jobCardPcContainer", fields: [
      { field: "url", selector: "a[href]", text: "https://www.liepin.com/job/1234567890.shtml" },
      { field: "title", selector: ".title", text: "合成 C# 工程师" },
      { field: "company", selector: ".companyName", text: "合成上海企业" },
      { field: "locationText", selector: ".location", text: "上海-浦东新区" },
    ] } };
  async function request(path: string, payload?: unknown, key?: string) {
    const response = await fetch(`${url}/api/v1/${path}`, { method: payload === undefined ? "GET" : "POST", headers: {
      Authorization: `Bearer ${token}`, Origin: "http://atlas-ui.invalid", "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}),
    }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    const result = await response.json() as { ok: boolean; value: any };
    assert.equal(response.status, 200); assert.equal(result.ok, true); return result.value;
  }
  try {
    const input = { provider: "liepin", pageUrl, capturedAt: at, cards: [card], expectedRevision: 0 };
    const preview = await request("jobs/reviewed-cards/preview", input);
    assert.equal((await repository.readSnapshot()).jobs.length, 0);
    const command = { ...input, previewFingerprint: preview.previewFingerprint, reviewed: true };
    const receipt = await request("jobs/reviewed-cards/import", command, "synthetic-reviewed-key");
    assert.equal(receipt.counts.newJobs, 1);
    assert.deepEqual(await request("jobs/reviewed-cards/import", command, "synthetic-reviewed-key"), receipt);
    const result = await request("jobs/search", { search: { text: "C# 上海", mode: "fuzzy" }, market: "global" });
    assert.equal(result.totalJobs, 1);
    const detail = await request(`jobs/${preview.cards[0].jobId}`);
    assert.equal(detail.job.title.value, card.title); assert.equal(detail.company.names[0], card.company);
    assert.equal(detail.sources[0].attribution.label, "猎聘");
    assert.equal(detail.listings[0].canonicalUrl, card.url);
    assert.equal(detail.snapshots[0].completeness, "excerpt");
    assert.equal(detail.observations.length, 1); assert.equal(detail.observations[0].availability, "unknown");
    const snapshot = await request("dataset/export");
    assert.equal(snapshot.locations[0].raw, card.locationText); assert.equal(snapshot.locations[0].coordinates, undefined);
  } finally { await app.shutdown(); await server.close(); repository.close(); }
});
