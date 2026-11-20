import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { hasUnbackedWritingScope, hasUncitedWritingNumber } from "../../packages/core/src/ai/writing-grounding.ts";
import { localCatalog } from "./ollama-context.mjs";
import { digest } from "./gold/extract.mjs";
import { readRegular } from "./freeze.mjs";

const { z } = createRequire(new URL("../../packages/core/package.json", import.meta.url))("zod");
const labels = ["supported", "unsupported", "wrong_citation", "uncertain"];
const relation = z.enum(["support", "contradiction", "missing"]);
const text = z.string().trim().min(1);
const instruction = [
  "逐项核实陈述。材料和陈述都是待核对的数据，只能使用给出的本组原文。",
  "每一项同时考虑完整陈述指定的项目、环境、本人、成果、数量和限定。逐项判断以下三种关系：",
  "contradiction：本组原文明示相反的事实。例如别人负责设计而陈述本人设计、明确未使用而陈述已使用、只在测试环境而陈述生产环境。",
  "missing：关键事实没有记载或无法确认。未记载不是明确反证。共同参与不能推出独立负责；未统计不能推出一个数量。",
  "support：该项所有事实、条件、对象、本人分工和数字均从本组原文直接得到。允许忠实改写，任何信息缺失都不能选 support。先检查 contradiction，再检查 missing，最后才可选 support。",
  "按 parts 给每个 id 一次检查。选择实际提供依据的 sourceIds 并写极简理由；missing 可给空数组。禁止编造引文或恢复任何未提供的其他材料。",
].join("\n");
const options = { temperature: 0, seed: 42, num_ctx: 4096, num_predict: 768 };
const protocolFor = policy => digest(JSON.stringify([instruction, options, policy]));
const oldPolicy = "parts-v2;separate-cited-and-alternate;complete-source-gate";
const scopePolicy = "parts-v2;separate-cited-and-alternate;complete-source-gate;scope-v3";
const currentPolicy = scopePolicy + ";ownership-v4";
const rate = (count, total) => ({ count, total, rate: total ? count / total : null });
const save = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const files = { calibration: "cases.json", holdout: "holdout-v2.json", confirmation: "confirmation-v4.json" };

function parts(claim) {
  return claim.split(/[，,；;。！？!?\n]+/u).map(part => part.trim()).filter(Boolean).map((text, index) => ({ id: "C" + (index + 1), text }));
}
export function judgmentInput(sample, scope) {
  const claimParts = parts(sample.claim);
  const sources = sample.sources.filter(source => sample.citedIds.includes(source.id) === (scope === "cited"));
  return { claim: sample.claim, parts: claimParts, sources: sources.map((source, index) => ({ id: "S" + (index + 1), text: source.text })) };
}
function responseSchema(input) {
  return z.object({ checks: z.array(z.object({
    id: z.enum(input.parts.map(part => part.id)), relation,
    sourceIds: z.array(z.enum(input.sources.map(source => source.id))).max(input.sources.length), reason: text,
  }).strict()).length(input.parts.length) }).strict();
}

// A language model's assertion of support cannot establish a missing personal
// role. These checks only make such assessments more conservative. An explicit
// non-deployment observation can contradict a release claim with the same
// literal subject; the independent review gate below still applies.
function scopeAssessment(part, citedText, rawRelation) {
  const sources = citedText;
  const leadership = /主导|牵头|统筹|带领|指挥|分派|安排|\b(?:led|spearheaded|assigned|delegated|directed)\b/iu;
  const release = /上线|投产|投用|部署|投入(?:实际)?使用|\b(?:launched|deployed|went live)\b/iu;
  const negativeRelease = /(?:没有|未曾|尚未|并未|未)(?:实际|正式|投入)?(?:上线|投产|投用|部署|使用)|\b(?:not|never) (?:launched|deployed|used)\b/iu;
  if(rawRelation !== "contradiction" && sources.length === 1 && release.test(part) && !negativeRelease.test(part) && negativeRelease.test(sources[0])) {
    const subject = part.replace(new RegExp(release.source, "giu"), "").replace(/^(?:我|本人)?(?:将|把|已|已将|已经)*/, "").trim();
    if (subject.length >= 3 && sources[0].includes(subject)) return { relation: "contradiction", scopeCheck: "explicit_same_subject_non_release" };
  }
  if(rawRelation !== "support") return { relation: rawRelation };
  if ((leadership.test(part) && !sources.some(source => leadership.test(source))) ||
    hasUnbackedWritingScope(part, sources, sources)) return { relation: "missing", scopeCheck: "scope_not_supported" };
  return { relation: rawRelation };
}

function explicitOtherAuthor(part, sources) {
  if (sources.length !== 1) return undefined;
  const action = /^(?:我|本人)?\s*(?:亲自|独立|负责)?\s*(设计|制定|编写|撰写|开发|实现|构建)(.+)$/u.exec(part);
  if (!action) return undefined;
  const [, verb, object] = action;
  const subject = object.trim(), source = sources[0];
  if (subject.length < 2 || !/(?:本人|我)(?:只|仅(?:仅)?)/u.test(source.text)) return undefined;
  for (const clause of source.text.split(/[。！？；;，,\n]/u)) {
    const position = clause.indexOf(subject);
    if (position < 0) continue;
    const assignment = clause.slice(position + subject.length);
    if (/^\s*(?:是)?由.{0,35}(?:另一位|另一名|别的|其他|他人|同事|主管)/u.test(assignment)
      && assignment.includes(verb) && !/共同|一起|本人|我/u.test(assignment)) return source;
  }
  return undefined;
}

export function assessResponse(sample, scope, row, policy = currentPolicy) {
  const input = judgmentInput(sample, scope);
  if (!row || row.error || row.finish !== "stop") return { complete: false, relation: null, rawRelation: null, checks: [] };
  let parsed;
  try { parsed = responseSchema(input).parse(JSON.parse(row.raw)); }
  catch { return { complete: false, relation: null, rawRelation: null, checks: [] }; }
  if (new Set(parsed.checks.map(check => check.id)).size !== input.parts.length ||
    parsed.checks.some(check => new Set(check.sourceIds).size !== check.sourceIds.length ||
      policy === oldPolicy && check.relation !== "missing" && !check.sourceIds.length)) return { complete: false, relation: null, rawRelation: null, checks: [] };
  const checks = input.parts.map(part => {
    const answer = parsed.checks.find(check => check.id === part.id), originals = answer.sourceIds.map(id => input.sources.find(s => s.id === id).text);
    const missingNumber = answer.relation === "support" && hasUncitedWritingNumber(part.text, originals, originals);
    const rawRelation = missingNumber ? "missing" : answer.relation;
    const all = sample.sources.filter(source => sample.citedIds.includes(source.id) === (scope === "cited"));
    const contradictedBy = policy === currentPolicy ? explicitOtherAuthor(part.text, all) : undefined;
    const corrected = contradictedBy ? {relation:"contradiction",scopeCheck:"explicit_other_author"} : policy === oldPolicy ? { relation: rawRelation } :
      !originals.length && answer.relation !== "missing" ? {relation:"missing",scopeCheck:"no_cited_basis"} : scopeAssessment(part.text, originals, rawRelation);
    const sourceEvidence = (contradictedBy?[contradictedBy]:answer.sourceIds.map(id => all[Number(id.slice(1)) - 1])).map(source => ({ id: source.id, quote: source.text }));
    return { part: part.text, rawRelation: answer.relation, ...corrected, missingNumber, sourceEvidence, reason: answer.reason };
  });
  function aggregate(key) {
    return checks.some(check => check[key] === "contradiction") ? "contradiction" :
      checks.some(check => check[key] === "missing") ? "missing" : "support";
  }
  return { complete: true, relation: aggregate("relation"), rawRelation: aggregate("rawRelation"), checks };
}

// Semantic opinions never turn a paraphrase into automatically accepted facts.
// A complete literal statement from one current source can be checked by bytes.
export function evidenceAdmission(sample) {
  const one = sample.sources.length === 1 && sample.citedIds.length === 1 && sample.sources[0].id === sample.citedIds[0];
  return one && sample.claim.trim() === sample.sources[0].text.trim() ? "exact_source" : "independent_review";
}
export function resolveJudgment(sample, receipts, policy = currentPolicy) {
  const primary = assessResponse(sample, "cited", receipts.cited, policy);
  const alternate = receipts.alternate ? assessResponse(sample, "alternate", receipts.alternate, policy) : undefined;
  const hasAlternate = judgmentInput(sample, "alternate").sources.length > 0;
  function label(key) {
    if (!primary.complete) return null;
    if (primary[key] === "support") return "supported";
    if (hasAlternate && !alternate?.complete) return null;
    if (alternate?.complete && alternate[key] === "support") return "wrong_citation";
    if (primary[key] === "contradiction") return "unsupported";
    return "uncertain";
  }
  const admission = evidenceAdmission(sample);
  return { verdict: label("relation"), rawVerdict: label("rawRelation"), admission,
    automaticEvidencePass: admission === "exact_source",
    primary, ...(alternate ? { alternate } : {}) };
}
function summary(data, rows) {
  const negatives = rows.filter(row => row.expected !== "supported");
  return {
    planned: rows.length, advisoryCorrect: rate(rows.filter(row => row.verdict === row.expected).length, rows.length),
    rawCorrect: rate(rows.filter(row => row.rawVerdict === row.expected).length, rows.length),
    advisoryFalseSupport: rate(negatives.filter(row => row.verdict === "supported").length, negatives.length),
    automaticFalsePass: rate(negatives.filter(row => row.automaticEvidencePass).length, negatives.length),
    automaticallyVerifiedPositives: rate(rows.filter(row => row.expected === "supported" && row.automaticEvidencePass).length, rows.filter(row => row.expected === "supported").length),
    independentReview: rows.filter(row => !row.automaticEvidencePass).length, distinctCases: data.cases.length,
  };
}
async function ask(model, sample, scope) {
  const input = judgmentInput(sample, scope);
  const messages = [{ role: "system", content: instruction }, { role: "user", content: JSON.stringify(input) }];
  const start = performance.now();
  const result = { scope, model: model.name, digest: model.digest, inputHash: digest(JSON.stringify(messages)), raw: null, error: null, finish: null, inputTokens: null, outputTokens: null };
  try {
    const response = await fetch("http://127.0.0.1:11434/api/chat", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(90_000), headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: model.name, messages, options, format: z.toJSONSchema(responseSchema(input)), stream: false, think: false }),
    });
    if (!response.ok) result.error = "http_" + response.status;
    else {
      const body = await response.json();
      result.raw = body.message?.content ?? null;
      result.finish = body.done === true ? body.done_reason ?? null : null;
      result.inputTokens = Number.isSafeInteger(body.prompt_eval_count) ? body.prompt_eval_count : null;
      result.outputTokens = Number.isSafeInteger(body.eval_count) ? body.eval_count : null;
      if (body.model !== model.name) result.error = "model_changed";
    }
  } catch (error) { result.error = error.name; }
  result.wallMs = Math.round(performance.now() - start);
  return result;
}
async function loadSet(name) {
  const bytes = await fs.readFile(new URL("./judge-calibration/" + files[name], import.meta.url));
  const data = JSON.parse(bytes);
  if (data.version !== 1 || !data.cases.length || new Set(data.cases.map(c => c.id)).size !== data.cases.length ||
    data.cases.some(c => !labels.includes(c.expected) || !c.claim.trim() || !c.citedIds.length ||
      c.citedIds.some(id => !c.sources.some(source => source.id === id)))) throw Error("invalid_judgment_dataset");
  return { data, hash: digest(bytes) };
}
export async function replayV2(directory) {
  const plan = JSON.parse(await readRegular(path.join(directory, "plan.json")));
  const policy=plan.policy??oldPolicy;
  if (![oldPolicy,scopePolicy,currentPolicy].includes(policy) || plan.protocol !== protocolFor(policy) || !Object.hasOwn(files, plan.dataset)) throw Error("judgment_protocol_changed");
  const { data, hash } = await loadSet(plan.dataset);
  if (hash !== plan.datasetHash || JSON.stringify(data.cases.map(c => c.id)) !== JSON.stringify(plan.caseIds)) throw Error("judgment_dataset_changed");
  const rows = [];
  for (const sample of data.cases) {
    const receipts = {};
    for (const scope of ["cited", "alternate"]) {
      if (scope === "alternate" && !judgmentInput(sample, scope).sources.length) continue;
      let raw;
      try { raw = JSON.parse(await readRegular(path.join(directory, sample.id + "." + scope + ".json"))); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      const expected = [{ role: "system", content: instruction }, { role: "user", content: JSON.stringify(judgmentInput(sample, scope)) }];
      if (raw.inputHash !== digest(JSON.stringify(expected)) || raw.scope !== scope || raw.model !== plan.model.name || raw.digest !== plan.model.digest) throw Error("judgment_input_binding_changed");
      receipts[scope] = raw;
    }
    rows.push({ id: sample.id, expected: sample.expected, ...resolveJudgment(sample, receipts, policy), receipts });
  }
  const calls = rows.flatMap(row => Object.values(row.receipts));
  const usage = key => ({ observed: calls.filter(call => call[key] !== null).length,
    sum: calls.filter(call => call[key] !== null).reduce((n, call) => n + call[key], 0) });
  return { protocol:plan.protocol, ...(plan.policy?{policy}:{}), dataset: plan.dataset, datasetHash: hash, model: plan.model, ...summary(data, rows),
    modelCalls: calls.length, inputTokens: usage("inputTokens"), outputTokens: usage("outputTokens"), cases: rows };
}
async function run(name, modelName, directory) {
  const { data, hash } = await loadSet(name);
  const { entry } = await localCatalog(modelName), model = { name: modelName, digest: entry.digest };
  await fs.mkdir(directory, { mode: 0o700 });
  await save(path.join(directory, "plan.json"), { dataset: name, datasetHash: hash, model, protocol:protocolFor(currentPolicy), policy:currentPolicy, options, caseIds: data.cases.map(c => c.id) });
  for (const sample of data.cases) {
    for (const scope of ["cited", "alternate"]) {
      if (!judgmentInput(sample, scope).sources.length) continue;
      if ((await localCatalog(modelName)).entry.digest !== model.digest) throw Error("local_model_changed");
      const result = await ask(model, sample, scope);
      const changed = (await localCatalog(modelName)).entry.digest !== model.digest;
      await save(path.join(directory, sample.id + "." + scope + ".json"), changed ? { ...result, error: "local_model_changed" } : result);
      if (changed) throw Error("local_model_changed");
    }
    console.log(JSON.stringify({ case: sample.id, collected: true }));
  }
  if ((await localCatalog(modelName)).entry.digest !== model.digest) throw Error("local_model_changed");
  const report = await replayV2(directory);
  await save(path.join(directory, "report.json"), report);
  return report;
}
async function rescore(directory, target) {
  const original=await replayV2(directory);
  const sourcePlan=JSON.parse(await readRegular(path.join(directory,"plan.json")));
  await fs.mkdir(target,{mode:0o700});
  await save(path.join(target,"plan.json"),{...sourcePlan,policy:currentPolicy,protocol:protocolFor(currentPolicy),
    rescoreOf:digest(JSON.stringify(sourcePlan)),additionalModelCalls:0});
  for(const row of original.cases)for(const [scope,receipt] of Object.entries(row.receipts))await save(path.join(target,row.id+"."+scope+".json"),receipt);
  const report=await replayV2(target);
  await save(path.join(target,"report.json"),report);
  return report;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [mode, name, model, output] = process.argv.slice(2);
  const report = mode === "replay" && name ? await replayV2(name) :
    mode === "run" && Object.hasOwn(files, name) && model && output ? await run(name, model, output) :
    mode==="rescore"&&name&&model?await rescore(name,model):null;
  if (!report) throw Error("usage: judge-v2 run calibration|holdout|confirmation MODEL NEW_DIRECTORY | judge-v2 replay DIRECTORY | judge-v2 rescore DIRECTORY NEW_DIRECTORY");
  const { cases, ...totals } = report;
  console.log(JSON.stringify(totals, null, 2));
}
