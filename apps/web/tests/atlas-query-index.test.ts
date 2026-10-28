import assert from "node:assert/strict";
import test from "node:test";
import { queryAtlasPageDirect } from "../src/components/atlas/client.ts";
import { syntheticAtlas } from "../../job-service/tests/synthetic-atlas.ts";

test("paging an unchanged search does not normalize every full job description again", async t => {
  const data = syntheticAtlas(2, "repeat-query-index");
  const query = { search: { text: "engineer" }, page: { limit: 1 } };
  const options = { now: "2026-10-28T01:00:00.000Z" };
  const normalize = String.prototype.normalize;
  let fullDocumentNormalizations = 0;
  String.prototype.normalize = function (form) {
    if (String(this).length > 100) fullDocumentNormalizations++;
    return normalize.call(this, form);
  };
  try {
    const first = await queryAtlasPageDirect(data, query, options);
    assert.equal(first.summary.totalJobs, 2);
    assert.equal(first.page.items.length, 1);
    const cold = fullDocumentNormalizations;
    fullDocumentNormalizations = 0;
    const next = await queryAtlasPageDirect(data, query, options, { pageIndex: 1 });
    assert.equal(next.summary.totalJobs, 2);
    assert.equal(next.page.items.length, 1);
    assert.notEqual(next.page.items[0]?.job.id, first.page.items[0]?.job.id);
    t.diagnostic(JSON.stringify({ syntheticJobs: data.jobs.length, coldFullDocumentNormalizations: cold,
      repeatedPageFullDocumentNormalizations: fullDocumentNormalizations }));
    assert.equal(fullDocumentNormalizations, 0,
      "same snapshot and search should reuse prepared documents and query results for another page");
  } finally {
    String.prototype.normalize = normalize;
  }
});
