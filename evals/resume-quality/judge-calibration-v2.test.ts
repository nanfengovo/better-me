import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { evidenceAdmission, judgmentInput, resolveJudgment } from "./judge-calibration-v2.mjs";

const data = JSON.parse(await readFile(new URL("./judge-calibration/cases.json", import.meta.url), "utf8"));
const holdout = JSON.parse(await readFile(new URL("./judge-calibration/holdout-v2.json", import.meta.url), "utf8"));
const sample = (id: string) => [...data.cases, ...holdout.cases].find(c => c.id === id);
function response(c: ReturnType<typeof sample>, scope: string, relations: string[]) {
  const input = judgmentInput(c, scope);
  return { finish: "stop", error: null, raw: JSON.stringify({ checks: input.parts.map((p: {id:string}, i: number) =>
    ({ id: p.id, relation: relations[i], sourceIds: relations[i] === "missing" ? [] : [input.sources[0].id], reason: "synthetic assessment" })) }) };
}
test("judgment receives only the specified source group; hidden labels do not change its input", () => {
  const c = sample("H03");
  const cited = judgmentInput(c, "cited"), alternative = judgmentInput(c, "alternate");
  assert.deepEqual(judgmentInput({ ...c, expected: "unsupported", rationale: "private" }, "cited"), cited);
  assert.ok(cited.sources[0].text.includes("乙组"));
  assert.ok(alternative.sources[0].text.includes("甲组"));
  assert.equal(resolveJudgment(c, { cited: response(c, "cited", ["missing"]), alternate: response(c, "alternate", ["support"]) }).verdict, "wrong_citation");
  assert.equal(resolveJudgment(c, { cited: response(c, "cited", ["missing"]) }).verdict, null);
});
test("all assertions must be supported; a model's erroneous support cannot admit a changed factual claim", () => {
  const ownership = sample("J02"), claims = response(ownership, "cited", ["support", "support"]);
  assert.equal(resolveJudgment(ownership, {cited: claims}).verdict, "supported");
  assert.equal(resolveJudgment(ownership, {cited: claims}).automaticEvidencePass, false);
  assert.equal(resolveJudgment(ownership, {cited: response(ownership, "cited", ["contradiction", "support"])}).verdict, "unsupported");
  const explicit = sample("H02");
  const unbound = response(explicit,"cited",["contradiction","support"]);
  const unboundRaw=JSON.parse(unbound.raw);unboundRaw.checks[0].sourceIds=[];
  const checked=resolveJudgment(explicit,{cited:{...unbound,raw:JSON.stringify(unboundRaw)}});
  assert.equal(checked.verdict,"unsupported");
  assert.equal(checked.primary.checks[0].scopeCheck,"explicit_other_author");
  assert.equal(checked.primary.checks[0].sourceEvidence[0].quote,explicit.sources[0].text);
  const number = sample("J12");
  const result = resolveJudgment(number, {cited: response(number, "cited", ["support"])});
  assert.equal(result.rawVerdict, "supported");
  assert.equal(result.verdict, "uncertain");
  assert.equal(result.automaticEvidencePass, false);
  const literal = sample("J01");
  assert.equal(evidenceAdmission(literal), "exact_source");
  assert.equal(evidenceAdmission({...literal, sources:[...literal.sources, {id:"other",text:"可能存在更正"}]}), "independent_review");
  for (const c of [...data.cases, ...holdout.cases].filter(c => c.expected !== "supported")) assert.equal(evidenceAdmission(c), "independent_review");
  const incomplete = response(ownership, "cited", ["support", "support"]);
  const raw = JSON.parse(incomplete.raw); raw.checks[1].id = raw.checks[0].id;
  assert.equal(resolveJudgment(ownership, {cited:{...incomplete,raw:JSON.stringify(raw)}}).verdict, null);
});
