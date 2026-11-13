import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { reviewCollection } from "./collection-report.mjs";
import { digest } from "./gold/extract.mjs";
import { readRegular, decode } from "./freeze.mjs";
import { ResumeCandidateSourceSchema, resumeCandidateBoundSchema } from "../../packages/agent-contracts/src/resume-candidate.ts";

const { z } = createRequire(new URL("../../packages/core/package.json", import.meta.url))("zod");
const sha = z.string().regex(/^[a-f0-9]{64}$/), text = z.string().min(1).refine(value => value.trim().length > 0);
const span = z.object({ evidenceId: text, sourceSha256: sha, start: z.number().int().nonnegative(), end: z.number().int().positive(), quote: z.string().min(1) }).strict();
const component = z.enum(["present", "not_stated", "uncertain"]);
const claimReview = z.object({ claimId: text, textSha256: sha, citedEvidenceIds: z.array(text).min(1),
  verdict: z.enum(["supported", "wrong_citation", "uncertain"]), reason: text,
  supportingSpans: z.array(span), contrastingSpans: z.array(span),
  star: z.object({ situation: component, task: component, action: component,
    result: z.enum(["present", "purpose_only", "not_stated", "uncertain"]), reason: text, resultSpans: z.array(span) }).strict(),
}).strict();
const reviewSchema = z.object({ schemaVersion: z.literal(1), campaignId: text, collectionReceiptSha256: sha,
  reviewer: z.object({ kind: z.literal("operator_source_review"), label: text, externalHuman: z.literal(false), blind: z.literal(false), providerAttestation: z.literal(false) }).strict(),
  cases: z.array(z.object({ caseId: text, taskId: text, caseSha256: sha, inputMaterialSha256: sha,
    outputs: z.array(z.object({ outputIndex: z.number().int().nonnegative(), outputSha256: sha,
      unreviewableReason: z.string().nullable(), claims: z.array(claimReview) }).strict()) }).strict()).min(1),
}).strict();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const need = (condition, code) => { if (!condition) throw Error(code); };

/** Full-batch source material for a separate operator review. Every raw attempt,
 * including rejected/invalid/overflow output, remains bound and visible. No SDK,
 * inference, generator self-score, Gold edits or factual approval occurs here. */
export async function loadSemanticReviewMaterial(options) {
  const campaignDirectory = await fs.realpath(options.campaignDirectory);
  const receipt = await reviewCollection({ ...options, campaignDirectory, verifyOnly: true });
  need(receipt.verifiedArchives === receipt.planned && receipt.unresolved === 0, "semantic_terminal_archives_required");
  const files = new Map();
  for (const item of receipt.files) {
    const bytes = await readRegular(path.join(campaignDirectory, item.path));
    need(bytes.length === item.bytes && digest(bytes) === item.sha256, "semantic_archive_changed");
    files.set(item.path, bytes);
  }
  const json = name => { need(files.has(name), "semantic_archive_member_missing"); return JSON.parse(decode(files.get(name))); };
  const cases = receipt.results.map(result => {
    const prefix = `${result.caseId}/${result.outcome === "frozen" ? "frozen" : "failure"}/${result.stem}`;
    const plan = json(`${prefix}.plan.json`), record = json(`${prefix}.records/${result.taskId}.json`);
    need(["resume-quality-task-candidate-v4", "resume-quality-task-candidate-v5", "resume-quality-task-candidate-v6", "resume-quality-task-candidate-v7"].includes(plan.protocolVersion), "semantic_bound_protocol_required");
    const source = ResumeCandidateSourceSchema.parse(plan.material);
    const attempts = record.recent.filter(r => ["free_chat_output", "free_chat_output_artifact"].includes(r.kind));
    need(attempts.length <= record.task.usage.modelCalls, "semantic_output_count_exceeds_model_calls");
    const outputs = attempts.map((attempt, outputIndex) => {
      let raw;
      if (attempt.kind === "free_chat_output") { need(typeof attempt.output === "string", "semantic_raw_output_missing"); raw = attempt.output; }
      else {
        const name = `${prefix}.records/outputs/${result.taskId}/${attempt.artifact.id}.txt`, bytes = files.get(name);
        need(bytes && bytes.length === attempt.artifact.bytes && digest(bytes) === attempt.artifact.hash, "semantic_full_artifact_required"); raw = decode(bytes);
      }
      let candidate, unreviewableReason = null;
      try { const parsed = resumeCandidateBoundSchema(source).safeParse(JSON.parse(raw));
        if (parsed.success) candidate = parsed.data; else unreviewableReason = "invalid_bound_candidate_contract";
      } catch { unreviewableReason = "invalid_json"; }
      return { outputIndex, outputSha256: digest(raw), raw, finishReason: attempt.finishReason ?? null,
        disposition: result.outcome === "frozen" && outputIndex === attempts.length - 1 && raw === record.task.reply?.content ? "accepted_candidate" : "rejected_output",
        unreviewableReason, claims: candidate?.bullets.map(bullet => ({ id: bullet.id, text: bullet.text, textSha256: digest(bullet.text),
          citedEvidenceIds: bullet.evidenceIds, groupId: source.candidate.evidence.find(e => e.id === bullet.evidenceIds[0]).groupId })) ?? [] };
    });
    return { caseId: result.caseId, taskId: result.taskId, caseSha256: result.caseSha256, inputMaterialSha256: result.inputMaterialSha256,
      outcome: result.outcome, model: receipt.metadata, protocolVersion: plan.protocolVersion,
      unrecordedModelOutputs: record.task.usage.modelCalls - attempts.length, source, outputs };
  });
  return { schemaVersion: 1, campaignId: receipt.campaignId, collectionReceiptSha256: digest(JSON.stringify(receipt, null, 2) + "\n"), cases,
    modelRequests: 0, sourcePolicy: "Author self-report, not independently verified employment. Operator annotations are separate from generation and original Gold/rule scores." };
}

function validateReview(material, rawReview) {
  const review = reviewSchema.parse(rawReview);
  need(review.campaignId === material.campaignId && review.collectionReceiptSha256 === material.collectionReceiptSha256, "semantic_campaign_binding_changed");
  need(same(review.cases.map(c => c.caseId), material.cases.map(c => c.caseId)), "semantic_complete_case_set_required");
  const results = material.cases.map((sourceCase, caseIndex) => {
    const annotations = review.cases[caseIndex];
    for (const key of ["taskId", "caseSha256", "inputMaterialSha256"]) need(annotations[key] === sourceCase[key], "semantic_case_binding_changed");
    need(same(annotations.outputs.map(o => o.outputIndex), sourceCase.outputs.map(o => o.outputIndex)), "semantic_complete_output_set_required");
    const outputs = sourceCase.outputs.map((output, outputIndex) => {
      const annotation = annotations.outputs[outputIndex];
      need(annotation.outputSha256 === output.outputSha256 && annotation.unreviewableReason === output.unreviewableReason, "semantic_output_binding_changed");
      need(same(annotation.claims.map(c => c.claimId), output.claims.map(c => c.id)), "semantic_complete_claim_set_required");
      const claims = output.claims.map((claim, claimIndex) => {
        const judgement = annotation.claims[claimIndex];
        need(judgement.textSha256 === claim.textSha256 && same(judgement.citedEvidenceIds, claim.citedEvidenceIds), "semantic_claim_binding_changed");
        const checkSpans = (spans, cited) => {
          for (const ref of spans) {
            const evidence = sourceCase.source.candidate.evidence.find(e => e.id === ref.evidenceId);
            need(evidence && ref.sourceSha256 === evidence.sha256 && ref.end > ref.start && ref.end <= evidence.text.length && evidence.text.slice(ref.start, ref.end) === ref.quote, "semantic_exact_source_span_required");
            need(claim.citedEvidenceIds.includes(ref.evidenceId) === cited, "semantic_span_citation_scope_changed");
          }
        };
        checkSpans(judgement.supportingSpans, true); checkSpans(judgement.contrastingSpans, false); checkSpans(judgement.star.resultSpans, true);
        if (judgement.verdict === "supported") need(judgement.supportingSpans.length > 0 && judgement.contrastingSpans.length === 0, "semantic_cited_support_required");
        if (judgement.verdict === "wrong_citation") need(judgement.contrastingSpans.length > 0, "semantic_contrasting_source_required");
        if (judgement.verdict !== "supported") need(Object.entries(judgement.star).filter(([key]) => ["situation", "task", "action", "result"].includes(key)).every(([, value]) => value === "uncertain"), "semantic_unsupported_star_credit_forbidden");
        if (judgement.star.result === "present") need(judgement.verdict === "supported" && judgement.star.resultSpans.length > 0, "semantic_result_source_required");
        else need(judgement.star.resultSpans.length === 0, "semantic_result_spans_without_observed_result");
        return { ...claim, review: judgement };
      });
      return { ...output, claims };
    });
    return { ...sourceCase, outputs };
  });
  return { review, results };
}

/** Validates exhaustive bindings and writes a separate review overlay. A valid
 * receipt attests to byte/source coverage, not correctness of reviewer judgement.
 * Existing quality scores, Gold labels, candidate status and PDF stay untouched. */
export async function reviewSemanticCampaign({ review, outputDirectory, ...options }) {
  const material = await loadSemanticReviewMaterial(options), checked = validateReview(material, review);
  const claims = checked.results.flatMap(c => c.outputs.flatMap(o => o.claims.map(claim => ({ ...claim, disposition: o.disposition }))));
  const summarize = selected => ({ claims: selected.length,
    supported: selected.filter(c => c.review.verdict === "supported").length,
    wrongCitation: selected.filter(c => c.review.verdict === "wrong_citation").length,
    uncertain: selected.filter(c => c.review.verdict === "uncertain").length,
    sourceStatedResults: selected.filter(c => c.review.verdict === "supported" && c.review.star.result === "present").length,
    purposeOnly: selected.filter(c => c.review.verdict === "supported" && c.review.star.result === "purpose_only").length });
  const receipt = { schemaVersion: 1, protocolVersion: "resume-source-review-v1", campaignId: material.campaignId,
    collectionReceiptSha256: material.collectionReceiptSha256, reviewSha256: digest(JSON.stringify(checked.review)), reviewer: checked.review.reviewer,
    modelRequests: 0, overallQualityPassed: null,
    coverage: { cases: checked.results.length,
      recordedOutputs: checked.results.reduce((n, c) => n + c.outputs.length, 0),
      unreviewableOutputs: checked.results.reduce((n, c) => n + c.outputs.filter(o => o.unreviewableReason !== null).length, 0),
      unrecordedModelOutputs: checked.results.reduce((n, c) => n + c.unrecordedModelOutputs, 0) },
    total: summarize(claims),
    accepted: summarize(claims.filter(c => c.disposition === "accepted_candidate")), rejected: summarize(claims.filter(c => c.disposition === "rejected_output")),
    cases: checked.results, limitations: [
      "Operator source review is neither external human certification nor a blind or provider-attested model evaluation.",
      "Exact bindings validate the review coverage and cited bytes, not the semantic correctness of its judgements.",
      "Source support preserves author self-report; it does not independently verify employment, personal ownership or claimed metrics.",
      "Source-stated results and purpose are distinct. This overlay does not change original Gold, rule scores, failed status, wire or PDF.",
      "Unparseable recorded outputs remain complete in material.json and receipt.json. Calls without recorded output are reported as missing, never as empty successful claims.",
      "No overall quality pass, second-model generation comparison, periodic run or business adoption is inferred.",
    ] };
  await fs.mkdir(outputDirectory, { mode: 0o700 });
  for (const [name, value] of [["material.json", material], ["review.json", checked.review], ["receipt.json", receipt]])
    await fs.writeFile(path.join(outputDirectory, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const rows = checked.results.flatMap(c => c.outputs.flatMap(o => o.claims.map(claim => `| ${c.caseId} | ${o.outputIndex} / ${o.disposition} | ${claim.id} | ${claim.review.verdict} | ${claim.review.star.result} | ${claim.review.reason.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`)));
  const inventory = checked.results.flatMap(c => [
    ...c.outputs.map(o => `| ${c.caseId} | ${o.outputIndex} / ${o.disposition} | ${Buffer.byteLength(o.raw, "utf8")} | ${o.outputSha256} | ${o.unreviewableReason ?? "可解析"} |`),
    ...(c.unrecordedModelOutputs ? [`| ${c.caseId} | 无已记录输出的调用 ${c.unrecordedModelOutputs} 次 | 未知 | 未知 | 无法审阅，不计成功 |`] : []),
  ]);
  const details = checked.results.flatMap(c => c.outputs.flatMap(o => o.claims.map(claim => {
    const r = claim.review;
    const sources = claim.citedEvidenceIds.map(id => {
      const e = c.source.candidate.evidence.find(e => e.id === id);
      return { evidenceId: id, kind: e.kind, groupId: e.groupId, sourceSha256: e.sha256, text: e.text };
    });
    return `### ${c.caseId} / output-${o.outputIndex} / ${claim.id}\n\n` +
      `正文：${JSON.stringify(claim.text)}\n\n判读：${r.verdict}。${r.reason}\n\n` +
      `STAR：S=${r.star.situation}，T=${r.star.task}，A=${r.star.action}，R=${r.star.result}。${r.star.reason}\n\n` +
      `实际所引来源（完整）：\n\n\`\`\`json\n${JSON.stringify(sources, null, 2)}\n\`\`\`\n\n` +
      `支持/对照/结果原文坐标：\n\n\`\`\`json\n${JSON.stringify({ supportingSpans: r.supportingSpans, contrastingSpans: r.contrastingSpans, resultSpans: r.star.resultSpans }, null, 2)}\n\`\`\``;
  })));
  const report = `# 来源支持与行动结果逐条审阅\n\n审阅者：${checked.review.reviewer.label}（操作者源审，非外部人工认证、非盲评）。推理调用0次，总体质量状态未知。\n\n完整覆盖${material.cases.length}例、${receipt.coverage.recordedOutputs}份已记录原始输出、${claims.length}条可解析正文，包括失败/被拒输出。无法解析${receipt.coverage.unreviewableOutputs}份；另有${receipt.coverage.unrecordedModelOutputs}次调用没有已记录输出，不能推定可审阅或成功。源内支持${receipt.total.supported}，错引${receipt.total.wrongCitation}，不确定${receipt.total.uncertain}。成功候选与失败输出分账，原规则分数不改。\n\n## 完整输出清单\n\n所有原始字节对应的全文保存在 material.json / receipt.json，不裁短无效或超大输出。\n\n| 案例 | 原输出 | UTF-8字节 | SHA-256 | 可审阅状态 |\n| --- | --- | --- | --- | --- |\n${inventory.join("\n")}\n\n## 逐条判读\n\n| 案例 | 原输出 | 正文ID | 来源判读 | 结果判读 | 理由 |\n| --- | --- | --- | --- | --- | --- |\n${rows.join("\n")}\n\n${details.join("\n\n")}\n\n## 限制\n\n${receipt.limitations.map(l => `- ${l}`).join("\n")}\n`;
  await fs.writeFile(path.join(outputDirectory, "report.md"), report, { flag: "wx", mode: 0o600 });
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), flags = ["--dataset", "--campaign", "--context", "--review", "--out"];
  need(args.length === flags.length * 2 && flags.every((f, i) => args[2 * i] === f), "Usage: node --import tsx semantic-review.mjs --dataset GOLD --campaign VERIFIED_CAMPAIGN --context CONTEXT_DIR --review ANNOTATIONS_JSON --out NEW_DIR");
  const result = await reviewSemanticCampaign({ datasetDirectory: path.resolve(args[1]), campaignDirectory: path.resolve(args[3]),
    contextDirectory: path.resolve(args[5]), review: JSON.parse(decode(await readRegular(path.resolve(args[7])))), outputDirectory: path.resolve(args[9]) });
  console.log(JSON.stringify({ campaignId: result.campaignId, modelRequests: result.modelRequests, total: result.total, accepted: result.accepted, rejected: result.rejected, overallQualityPassed: result.overallQualityPassed }));
}
