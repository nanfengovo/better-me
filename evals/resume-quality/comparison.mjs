import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { reportFileManifest, reviewCollection, reviewCollectionQuality } from "./collection-report.mjs";
import { decode, loadGoldCase, readRegular } from "./freeze.mjs";
import { digest } from "./gold/extract.mjs";

const { z } = createRequire(new URL("../../packages/core/package.json", import.meta.url))("zod");
const absolute = z.string().min(1).refine(path.isAbsolute, "explicit_absolute_directory_required");
export const ComparisonConfigSchema = z.object({ schemaVersion: z.literal(1), datasetDirectory: absolute,
  campaigns: z.array(z.object({ directory: absolute, contextDirectory: absolute.optional() }).strict()).min(1).max(32) }).strict();
const bytes = value => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const write = (file, value) => fs.writeFile(file, bytes(value), { flag: "wx", mode: 0o600 });
const mean = values => values.length && values.every(n => typeof n === "number")
  ? Number((values.reduce((sum, n) => sum + n, 0) / values.length).toFixed(2)) : null;
const escape = value => String(value).replace(/\|/g, "\\|").replace(/[\r\n]/g, " ");
const percent = value => value === null ? "待判定" : `${value}%`;
const inside = (parent, child) => { const relative = path.relative(parent, child); return !relative || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative); };

export async function readComparisonConfig(file) {
  const canonical = path.join(await fs.realpath(path.dirname(file)), path.basename(file));
  return ComparisonConfigSchema.parse(JSON.parse(decode(await readRegular(canonical))));
}

/** Shared write-authority check, including symlinked OUTPUT parents. */
export async function prepareComparisonSelection({ config, outputDirectory }) {
  config = ComparisonConfigSchema.parse(config);
  if (!path.isAbsolute(outputDirectory)) throw Error("explicit_absolute_output_required");
  outputDirectory = path.join(await fs.realpath(path.dirname(outputDirectory)), path.basename(outputDirectory));
  const datasetDirectory = await fs.realpath(config.datasetDirectory), campaigns = [];
  for (const campaign of config.campaigns) campaigns.push({ directory: await fs.realpath(campaign.directory),
    ...(campaign.contextDirectory === undefined ? {} : { contextDirectory: await fs.realpath(campaign.contextDirectory) }) });
  for (const source of [datasetDirectory, ...campaigns.flatMap(c => [c.directory, c.contextDirectory])].filter(Boolean))
    if (inside(source, outputDirectory) || inside(outputDirectory, source)) throw Error("comparison_output_overlaps_input");
  return { config: { schemaVersion: 1, datasetDirectory, campaigns }, outputDirectory };
}

/** Local aliases/configurations with the same weight blobs are ONE model.
 * This is saved catalog provenance, not an attestation of each inference. */
export function comparisonModelIdentity(metadata, catalog) {
  if (metadata.provider !== "ollama") return { key: JSON.stringify([metadata.provider, metadata.id, metadata.revision]),
    assurance: "declared_provider_model_revision", weightBlobs: null };
  const directives = typeof catalog?.show?.modelfile === "string"
    ? catalog.show.modelfile.split(/\r?\n/).filter(line => /^(?:FROM|ADAPTER)\s/u.test(line)) : [];
  const hashes = directives.map(line => /^(?:FROM|ADAPTER)\s+\S*sha256[-:]([a-f0-9]{64})\s*$/u.exec(line)?.[1]);
  if (catalog?.entry?.name !== metadata.id || catalog?.entry?.digest !== metadata.revision || !hashes.length || hashes.some(h => !h))
    return { key: null, assurance: "local_weight_identity_unverified", weightBlobs: null };
  const weightBlobs = [...new Set(hashes)].sort();
  return { key: JSON.stringify([metadata.provider, weightBlobs]), assurance: "saved_local_weight_blobs", weightBlobs };
}

/** Pure comparison policy; callers still have to verify full campaigns first. */
export function campaignComparisonEligibility(campaigns) {
  const actual = campaigns.filter(c => c.metadata.execution === "model"), reasons = [];
  if (new Set(actual.map(c => c.modelIdentity.key).filter(Boolean)).size < 2) reasons.push("different_real_models_required");
  if (actual.some(c => c.modelIdentity.key === null)) reasons.push("underlying_model_identity_unverified");
  if (!actual.length || actual.some(c => c.realCaseIds.length < 5)) reasons.push("at_least_five_real_cases_required");
  if (new Set(actual.map(c => c.conditionsSignature)).size > 1) reasons.push("conditions_differ");
  if (actual.some(c => c.results.some(r => !r.verifiedArchive || r.outcome === "unresolved"))) reasons.push("unresolved_or_unverified_case");
  const deliveryComparable = reasons.length === 0;
  const qualityComparable = deliveryComparable && actual.every(c => c.results.every(r => r.outcome === "frozen"));
  return { deliveryComparable, qualityComparable, reasonCodes: [...reasons,
    ...(deliveryComparable && !qualityComparable ? ["not_all_planned_candidates_frozen"] : [])],
    distinctRealModels: new Set(actual.map(c => c.modelIdentity.key).filter(Boolean)).size,
    bestModel: null, overallQualityPassed: null };
}

const evaluatorFiles = ["evals/resume-quality/comparison.mjs", "evals/resume-quality/collection-report.mjs", "evals/resume-quality/report.mjs",
  "evals/resume-quality/render.mjs", "evals/resume-quality/freeze.mjs", "evals/resume-quality/editorial.mjs",
  "packages/core/src/career-intelligence/resume-quality.ts", "packages/agent-contracts/src/resume-candidate.ts",
  "apps/agent-host/src/kernel/free-chat.ts", "apps/web/src/components/ResumeTemplate.tsx",
  "apps/web/src/components/resume-paper.css", "apps/web/src/lib/resume-print.ts"];

/** One explicit offline snapshot. No provider, login, retry, recovery or adoption.
 * Every campaign is reverified and all frozen PDFs are regenerated into NEW files;
 * original failures, full source/output and planned-case denominators are retained. */
export async function reviewCampaignComparison({ config, outputDirectory }) {
  ({ config, outputDirectory } = await prepareComparisonSelection({ config, outputDirectory }));
  const datasetDirectory = config.datasetDirectory, plans = [], seenPaths = new Set(), seenIntents = new Set();
  for (const input of config.campaigns) {
    const directory = await fs.realpath(input.directory), contextDirectory = input.contextDirectory === undefined ? undefined : await fs.realpath(input.contextDirectory);
    if (seenPaths.has(directory)) throw Error("duplicate_comparison_campaign"); seenPaths.add(directory);
    const intentBytes = await readRegular(path.join(directory, "campaign.json")), intent = JSON.parse(decode(intentBytes));
    if (seenIntents.has(digest(intentBytes))) throw Error("duplicate_comparison_campaign"); seenIntents.add(digest(intentBytes));
    const collection = await reviewCollection({ datasetDirectory, campaignDirectory: directory, contextDirectory, verifyOnly: true });
    const conditions = [], realCaseIds = [];
    for (const result of collection.results) {
      const { test } = await loadGoldCase(datasetDirectory, result.caseId);
      if (test.dataKind === "real_anonymized") realCaseIds.push(test.id);
      const request = intent.requests.find(p => p.caseId === result.caseId).request;
      conditions.push([result.caseId, result.caseSha256, result.inputMaterialSha256,
        JSON.parse(request.conversation.messages[0].content).protocolVersion, request.budget]);
    }
    const catalog = contextDirectory === undefined ? undefined : JSON.parse(decode(await readRegular(path.join(contextDirectory, "local-model.json"))));
    plans.push({ directory, contextDirectory, intentSha256: digest(intentBytes), collection, collectionSha256: digest(bytes(collection)),
      realCaseIds: realCaseIds.sort(), conditions: conditions.sort((a, b) => a[0].localeCompare(b[0])),
      modelIdentity: comparisonModelIdentity(collection.metadata, catalog) });
  }
  // Existing output directories cannot be restarted, overwritten or adopted.
  await fs.mkdir(outputDirectory, { mode: 0o700 }); outputDirectory = await fs.realpath(outputDirectory);
  await write(path.join(outputDirectory, "selection.json"), config);
  const snapshots = [];
  for (const file of evaluatorFiles) {
    const content = await readRegular(fileURLToPath(new URL(`../../${file}`, import.meta.url)));
    const target = path.join(outputDirectory, "evaluation-sources", file); await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, content, { flag: "wx", mode: 0o600 }); snapshots.push({ path: file, bytes: content.length, sha256: digest(content) });
  }
  const evaluationFingerprint = digest(bytes(snapshots)), campaigns = [];
  for (const [index, plan] of plans.entries()) {
    const relative = `campaign-${String(index + 1).padStart(3, "0")}`, destination = path.join(outputDirectory, relative);
    const quality = await reviewCollectionQuality({ datasetDirectory, campaignDirectory: plan.directory, contextDirectory: plan.contextDirectory, outputDirectory: destination });
    if (digest(await readRegular(path.join(destination, "collection/receipt.json"))) !== plan.collectionSha256) throw Error("comparison_source_changed_during_review");
    const measured = quality.results.filter(r => r.metrics !== null && plan.realCaseIds.includes(r.caseId));
    campaigns.push({ campaignId: quality.campaignId, metadata: quality.metadata, modelIdentity: plan.modelIdentity, realCaseIds: plan.realCaseIds,
      conditions: plan.conditions, conditionsSignature: digest(bytes([plan.conditions, evaluationFingerprint])),
      intentSha256: plan.intentSha256, collectionSha256: plan.collectionSha256, qualityReceiptSha256: digest(bytes(quality)), archiveDirectory: relative,
      planned: quality.planned, frozen: quality.frozen, failed: quality.failed, unresolved: quality.unresolved,
      observedModelCalls: quality.observedModelCalls, recordedMonetaryCost: null,
      candidateAcceptancePercent: quality.candidateAcceptancePercent, measuredRealCases: measured.length,
      conditionalQuality: { coverage: mean(measured.map(r => r.metrics.coverage)), antiHallucination: mean(measured.map(r => r.metrics.antiHallucination)),
        star: mean(measured.map(r => r.metrics.star)), a4PassRate: measured.length ? 100 * measured.filter(r => r.metrics.a4Passed).length / measured.length : null },
      capacityGuardVerified: quality.capacityGuardVerified, results: quality.results });
  }
  const eligibility = campaignComparisonEligibility(campaigns);
  const receipt = { schemaVersion: 1, protocolVersion: "resume-quality-campaign-comparison-v1", generatedAt: new Date().toISOString(),
    ...eligibility, modelRequests: 0, evaluationFingerprint, evaluationSources: snapshots, campaigns,
    limitations: ["Each campaign is completely reverified from original Host records, source and full wire; failures/unresolved cases remain planned cases with null quality, never substituted zeros.",
      "Conditional quality means measured frozen REAL cases only. Comparison of delivery does not make unequal surviving subsets a quality ranking.",
      "Two aliases/configurations of the same saved local weight blobs are one model. Other provider identities/revisions are declared provenance, not cryptographic weight attestations.",
      "This offline snapshot issues no inference, recovery or adoption. Reprinting the same collected outputs is not a new model trial or evidence of periodic model execution.",
      "Evaluator fingerprint covers the explicitly archived direct evaluation/template sources, not every transitive dependency, browser, font or original provider setting.",
      "Costs were not recorded by collection and remain null. Rule/STAR diagnostics do not certify semantic support, employment, personal attribution or an excellent resume. No composite best-model ranking is invented."] };
  const rows = campaigns.map(c => `| ${escape(c.metadata.id)} @ ${escape(c.metadata.revision)} | ${escape(c.metadata.execution)} | ${c.frozen}/${c.planned}; ${c.failed}/${c.unresolved} | ${percent(c.candidateAcceptancePercent)} | ${c.measuredRealCases}/${c.realCaseIds.length} | ${percent(c.conditionalQuality.coverage)} | ${percent(c.conditionalQuality.antiHallucination)} | ${percent(c.conditionalQuality.star)} | ${percent(c.conditionalQuality.a4PassRate)} | ${c.observedModelCalls ?? "未知"} |`);
  await fs.writeFile(path.join(outputDirectory, "report.md"), `# 完整批次模型诊断对比\n\n交付可比：${eligibility.deliveryComparable ? "是" : "否"}；全计划四轴可比：${eligibility.qualityComparable ? "是（仅诊断）" : "否"}。原因：${eligibility.reasonCodes.join(", ") || "可比条件已具备，仍非总体质量认证"}。不同真实模型：${eligibility.distinctRealModels}；本报告模型请求0次；最佳模型未自动指定。\n\n| 模型/版本 | 执行来源 | 冻结/计划; 失败/未决 | 交付接受率 | 质量实测真实案例 | JD覆盖* | 事实规则* | STAR* | A4* | 原根模型派送 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n${rows.join("\n")}\n\n* 条件均值只包含可冻结的真实案例；失败/未决各项为null，不计作满分或零分。逐例全部结果、完整来源/wire/私有根成员及新打印的全部页PDF在各campaign目录，原输入不变。规则事实分和STAR字面结构不是人工语义质量分，版面占用不是审美分。\n\n${receipt.limitations.map(l => `- ${l}`).join("\n")}\n`, { flag: "wx", mode: 0o600 });
  receipt.files = await reportFileManifest(outputDirectory);
  await write(path.join(outputDirectory, "comparison.json"), receipt);
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--config" || args[2] !== "--out") throw Error("Usage: node --import tsx comparison.mjs --config ABSOLUTE_CONFIG_JSON --out NEW_ABSOLUTE_DIR");
  const result = await reviewCampaignComparison({ config: await readComparisonConfig(path.resolve(args[1])), outputDirectory: path.resolve(args[3]) });
  console.log(JSON.stringify({ deliveryComparable: result.deliveryComparable, qualityComparable: result.qualityComparable, reasonCodes: result.reasonCodes, modelRequests: 0 }));
}
