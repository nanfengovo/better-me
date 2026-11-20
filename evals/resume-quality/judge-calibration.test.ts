import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { digest } from "./gold/extract.mjs";
import { judgeMessages, scoreCalibration } from "./judge-calibration.mjs";

const data = JSON.parse(await readFile(new URL("./judge-calibration/cases.json", import.meta.url), "utf8"));
const model = { name: "scripted-test", digest: "b".repeat(64) };
type Sample = { id: string; expected: string; claim: string; sources: Array<{ id: string; text: string }>; citedIds: string[] };
const sampleFor = (expected: string): Sample => data.cases.find((c: Sample) => c.expected === expected);
function attempt(c: Sample, verdict: string, source = c.sources[0]!) {
  return {
    id: c.id, inputHash: digest(JSON.stringify(judgeMessages(c))), model: model.name, digest: model.digest,
    raw: JSON.stringify({ verdict, reason: "合成裁判输出", evidence: [{ sourceId: source.id, quote: source.text }] }),
    finish: "stop", error: null, wallMs: 10, inputTokens: 0, outputTokens: 3,
  };
}

test("the judge sees only the claim and its sources; the offline labels stay outside the prompt", () => {
  const c = sampleFor("supported");
  assert.deepEqual(JSON.parse(judgeMessages(c)[1].content), { sources: c.sources, citedIds: c.citedIds, claim: c.claim });
  assert.deepEqual(judgeMessages(c), judgeMessages({ ...c, expected: "uncertain", rationale: "PRIVATE RATING", id: "other-case" }));
  const totals = data.cases.reduce((counts: Record<string, number>, c: Sample) => {
    counts[c.expected] = (counts[c.expected] ?? 0) + 1;
    return counts;
  }, {});
  assert.deepEqual(totals, { supported: 3, unsupported: 3, wrong_citation: 3, uncertain: 3 });
});

test("invalid evidence, lost attempts and false support stay in the planned denominator", () => {
  const good = sampleFor("supported"), wrong = sampleFor("wrong_citation"), uncertain = sampleFor("uncertain");
  const invalid = attempt(wrong, "supported", wrong.sources.find(s => !wrong.citedIds.includes(s.id))!);
  const summary = scoreCalibration(data, [attempt(good, "supported"), invalid, attempt(uncertain, "supported"),
    { ...attempt(sampleFor("unsupported"), "unsupported"), inputTokens: null, outputTokens: null, error: "timeout" }], model);
  assert.deepEqual(summary.agreementAllPlanned, { count: 1, total: 12, rate: 1 / 12 });
  assert.equal(summary.agreementOnScored.total, 2);
  assert.equal(summary.confusion.wrong_citation.unscored, 3);
  assert.equal(summary.falseSupportAllNonSupporting.count, 1);
  assert.equal(summary.falseSupportAllNonSupporting.total, 9);
  assert.equal(summary.unscoredNonSupporting, 8);
  assert.equal(summary.cases.find((c: Sample) => c.id === wrong.id)?.disposition, "invalid_evidence");
  assert.deepEqual(summary.inputTokens, { observed: 3, attempted: 4, sum: 0 });
  assert.equal(summary.monetaryCost, null);
  assert.equal(scoreCalibration(data, [], model).outputTokens.sum, null);
  assert.equal(scoreCalibration(data, [], model).agreementOnScored.rate, null);
});

test("replay binds model, exact input, original quotes and one attempt per case", () => {
  const c = sampleFor("wrong_citation"), selected = c.sources.find(s => !c.citedIds.includes(s.id))!;
  const row = attempt(c, "wrong_citation", selected);
  assert.equal(scoreCalibration(data, [row], model).agreementAllPlanned.count, 1);
  for (const rows of [[row, row], [{ ...row, inputHash: "bad" }], [{ ...row, digest: "bad" }]]) {
    assert.throws(() => scoreCalibration(data, rows, model), /binding_changed/);
  }
  const invalid = attempt(c, "wrong_citation", { ...selected, text: "该原句并不存在" });
  assert.equal(scoreCalibration(data, [invalid], model).usableVerdicts.count, 0);
  assert.equal(scoreCalibration(data, [{ ...row, finish: "length" }], model).usableVerdicts.count, 0);
});
