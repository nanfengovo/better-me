import { createRequire } from "node:module";
import { rankEvidence } from "../../../apps/agent-host/src/kernel/evidence-retrieval.ts";
import { digest } from "../gold/extract.mjs";
import { summarizeProviderObservations } from "../runtime-quality.mjs";

const { z } = createRequire(new URL("../../../packages/core/package.json", import.meta.url))("zod");
const text = z.string().min(1);
const fact = z.object({ sourceId: text, quote: text }).strict();
const answer = z.object({
  facts: z.array(fact).max(8),
  interpretation: z.enum(["fact", "inference", "unknown"]),
  productionBenefit: z.enum(["supported", "unknown"]),
}).strict();
export const fixtureSchema = z.object({
  id: text, query: text, sources: z.array(z.object({ id: text, text }).strict()).min(1),
  expectedFacts: z.array(fact).min(1), expectedInterpretation: answer.shape.interpretation,
  expectedProductionBenefit: answer.shape.productionBenefit,
}).strict().refine(c => new Set(c.sources.map(s => s.id)).size === c.sources.length
  && new Set(c.expectedFacts.map(f => JSON.stringify(f))).size === c.expectedFacts.length
  && c.expectedFacts.every(f => c.sources.some(s => s.id === f.sourceId && s.text.includes(f.quote))));
export const profileSchema = z.object({
  prompts: z.array(z.object({ id: text, system: text }).strict()).min(1),
  agents: z.array(z.object({ id: z.enum(["bm25-v1", "hybrid-tfidf-v2"]), topK: z.number().int().positive().max(40) }).strict()).min(1),
}).strict().refine(p => [p.prompts, p.agents].every(items => new Set(items.map(i => i.id)).size === items.length));

export const sha = value => digest(JSON.stringify(value));
export const generationOptions = { temperature: 0, seed: 42, num_ctx: 4096, num_predict: 512 };
export function makeTurn(c, prompt, agent, model) {
  const sources = c.sources.map(({id, text}) => ({ id, kind: "source", label: id, sourceId: id,
    hash: digest(text), excerpt: text, startOffset: 0, endOffset: text.length, sourceLength: text.length }));
  const ranked = rankEvidence(sources, c.query, agent.topK, agent.id);
  if (ranked.policy !== agent.id) throw Error("retrieval_policy_mismatch");
  const selected = ranked.selected.map(({evidence}) => ({id: evidence.sourceId, text: evidence.excerpt}));
  const request = { model, stream: false, think: false, options: generationOptions, format: z.toJSONSchema(answer),
    messages: [{role:"system", content:prompt.system}, {role:"user", content:JSON.stringify({question:c.query, sources:selected})}] };
  return { selected, request };
}

export function grade(c, selected, body) {
  if (!body || body.done !== true || body.done_reason !== "stop") return {passed:false, reason:"incomplete_response"};
  let output;
  try { output = answer.parse(JSON.parse(body.message.content)); }
  catch { return {passed:false, reason:"invalid_answer"}; }
  const contains = (facts, ref) => facts.some(f => f.sourceId === ref.sourceId && f.quote === ref.quote);
  const checks = {
    citedOnlyRetrieved: output.facts.every(f => selected.some(s => s.id === f.sourceId && s.text.includes(f.quote))),
    requiredFacts: c.expectedFacts.filter(f => contains(output.facts, f)).length,
    expectedFacts: c.expectedFacts.length,
    onlyRequestedFacts: output.facts.length === c.expectedFacts.length && output.facts.every(f => contains(c.expectedFacts, f)),
    interpretation: output.interpretation === c.expectedInterpretation,
    productionBenefit: output.productionBenefit === c.expectedProductionBenefit,
  };
  const passed = checks.citedOnlyRetrieved && checks.requiredFacts === checks.expectedFacts
    && checks.onlyRequestedFacts && checks.interpretation && checks.productionBenefit;
  return { passed, reason: passed ? "passed" : "gold_mismatch", checks };
}

const pct = (n, d) => ({numerator:n, denominator:d, percent:d ? 100*n/d : null});
export function summarize(rows) {
  const observed = rows.filter(r => r.observation !== null).map(r => r.observation);
  const attempts = rows.filter(r => r.modelAttempted).length;
  return { planned: rows.length, completion: pct(rows.filter(r => r.grade.passed).length, rows.length),
    failed: rows.filter(r => r.state === "failed").length, unresolved: rows.filter(r => r.state === "unresolved").length,
    retrievalSuccess: pct(rows.filter(r => r.retrieval === "succeeded").length, rows.filter(r => r.retrieval !== null).length),
    modelCallsWithDispatchIntent:attempts, providerUsage:summarizeProviderObservations(observed, attempts), monetaryCost:null };
}

// Include a contrast only when exactly one selected dimension varies for the same frozen task.
export function contrasts(rows) {
  const dimensions = ["modelKey", "prompt", "agent"], pairs=[];
  for (const [i, left] of rows.entries()) for (const right of rows.slice(i+1)) {
    const changed = dimensions.filter(key => left[key] !== right[key]);
    if (changed.length !== 1 || left.taskInputSha256 !== right.taskInputSha256) continue;
    const delta = (x,y) => Number.isFinite(x) && Number.isFinite(y) ? y-x : null;
    pairs.push({dimension:changed[0], left:left.cell, right:right.cell,
      completionDeltaPoints:delta(Number(left.grade.passed)*100,Number(right.grade.passed)*100),
      inputTokensDelta:delta(left.observation?.inputTokens,right.observation?.inputTokens),
      outputTokensDelta:delta(left.observation?.outputTokens,right.observation?.outputTokens),
      hostWaitMsDelta:delta(left.observation?.wallMs,right.observation?.wallMs)});
  }
  return pairs;
}
