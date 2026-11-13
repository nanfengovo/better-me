import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { COLLECTION_PROTOCOL } from "./collect.mjs";
import { decode, loadGoldCase, metadataSchema, prepareBenchmarkMaterial, prepareBenchmarkRequest, readRegular, verifyFrozenCandidate, verifyTaskFailure } from "./freeze.mjs";
import { ResumeQualityRunSchema } from "../../packages/core/src/career-intelligence/resume-quality.ts";
import { AgentTaskSchema } from "../../packages/agent-contracts/src/agent-task.ts";
import { digest } from "./gold/extract.mjs";
import { contextCheck } from "./ollama-context.mjs";
import { runResumeQualityReport } from "./report.mjs";

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const displayReason = result => {
  const terminal = typeof result.reason === "object" ? result.reason.code : result.reason ?? "—";
  return result.candidateRejections?.length ? `${terminal}；原候选拒绝：${result.candidateRejections.map(r => r.code).join(", ")}` : terminal;
};

/** Offline whole-campaign receipt. All planned cases remain visible, including zero valid candidates. */
export async function reviewCollection({ datasetDirectory, campaignDirectory, outputDirectory, contextDirectory, verifyOnly = false }) {
  campaignDirectory = await fs.realpath(campaignDirectory);
  const read = async relative => readRegular(path.join(campaignDirectory, relative));
  const intentBytes = await read("campaign.json"), summaryBytes = await read("summary.json"), events = await read("events.ndjson");
  const intent = JSON.parse(decode(intentBytes)), summary = JSON.parse(decode(summaryBytes)), metadata = metadataSchema.parse(intent.metadata);
  if (intent.protocolVersion !== COLLECTION_PROTOCOL || summary.protocolVersion !== COLLECTION_PROTOCOL || summary.campaignId !== intent.campaignId
    || !same(summary.metadata, metadata) || !Array.isArray(intent.caseIds) || !intent.caseIds.length || new Set(intent.caseIds).size !== intent.caseIds.length
    || !Array.isArray(intent.requests) || !same(intent.requests.map(r => r.caseId), intent.caseIds)
    || !Array.isArray(summary.results) || !same(summary.results.map(r => r.caseId), intent.caseIds) || summary.planned !== intent.caseIds.length) throw Error("collection_plan_or_result_set_changed");
  const files = new Map([["campaign.json", intentBytes], ["summary.json", summaryBytes], ["events.ndjson", events]]), results = [];
  for (const item of intent.requests) {
    const { caseId, request } = item, source = await loadGoldCase(datasetDirectory, caseId);
    const protocol = JSON.parse(request.conversation.messages[0].content).protocolVersion;
    const expected = await prepareBenchmarkRequest(source.test, source.groups, source.mapping, { workspaceKey: request.workspaceKey, rootScopeKey: request.rootScopeKey,
      idempotencyKey: request.idempotencyKey, runtimeBinding: intent.runtimeBinding, budget: intent.budget }, protocol);
    if (!same(expected, request)) throw Error("collection_request_changed");
    const resultBytes = await read(`${caseId}/result.json`), requestBytes = await read(`${caseId}/request.json`), result = JSON.parse(decode(resultBytes));
    if (!same(result, summary.results.find(r => r.caseId === caseId)) || !same(JSON.parse(decode(requestBytes)), expected)) throw Error("collection_case_result_changed");
    files.set(`${caseId}/result.json`, resultBytes); files.set(`${caseId}/request.json`, requestBytes);
    const caseSha256 = digest(JSON.stringify(source.test)), inputMaterialSha256 = digest(JSON.stringify(await prepareBenchmarkMaterial(source.test, source.groups, source.mapping, protocol)));
    let observed = null, candidateRejections = null;
    if (result.outcome === "frozen" || result.outcome === "failure") {
      if (!/^ct_[a-f0-9]{32}$/.test(result.taskId) || result.stem !== `${caseId}-${result.taskId}`) throw Error("collection_task_binding_changed");
      const subdir = result.outcome === "frozen" ? "frozen" : "failure", directory = path.join(campaignDirectory, caseId, subdir);
      const prefix = `${caseId}/${subdir}/`;
      if (result.outcome === "frozen") {
        const runBytes = await read(`${prefix}${result.stem}.run.json`), run = ResumeQualityRunSchema.parse(JSON.parse(decode(runBytes)));
        const frozen = await verifyFrozenCandidate(run, result.stem, directory, source.test);
        if (run.origin.taskId !== result.taskId || run.model.runtimeId !== metadata.runtimeId || !same(run.model, { provider: metadata.provider, id: metadata.id, revision: metadata.revision, runtimeId: metadata.runtimeId })
          || run.origin.execution !== metadata.execution || run.origin.inputMaterialSha256 !== inputMaterialSha256 || !same(run.budget, intent.budget)) throw Error("collection_frozen_metadata_changed");
        for (const [name, bytes] of frozen.files) files.set(prefix + name, bytes);
        files.set(`${prefix}${result.stem}.freeze.json`, frozen.manifestBytes); files.set(`${prefix}${result.stem}.run.json`, runBytes);
        observed = run.observed;
      } else {
        const failure = await verifyTaskFailure(directory, result.stem);
        if (failure.taskId !== result.taskId || failure.ownerId !== intent.ownerId || failure.caseSha256 !== caseSha256 || failure.inputMaterialSha256 !== inputMaterialSha256
          || !same(failure.metadata, metadata) || !same(failure.budget, intent.budget) || !same(failure.reason, result.reason)) throw Error("collection_failure_metadata_changed");
        for (const entry of failure.files) files.set(prefix + entry.path, await read(prefix + entry.path));
        files.set(`${prefix}${result.stem}.failure.json`, await read(`${prefix}${result.stem}.failure.json`)); observed = failure.observed;
      }
      const task = AgentTaskSchema.parse(JSON.parse(decode(files.get(`${prefix}${result.stem}.task.json`))));
      if (task.ownerId !== intent.ownerId || task.workspaceKey !== expected.workspaceKey || task.rootScopeKey !== expected.rootScopeKey
        || task.responseContract !== expected.responseContract || !same(task.candidateSource, expected.candidateSource) || !same(task.runtimeBinding, intent.runtimeBinding)) throw Error("collection_original_task_changed");
      if (!same(result.observed, observed)) throw Error("collection_observed_ledger_changed");
      if (["resume-quality-task-candidate-v6", "resume-quality-task-candidate-v7"].includes(protocol)) {
        const record = JSON.parse(decode(files.get(`${prefix}${result.stem}.records/${result.taskId}.json`)));
        candidateRejections = record.recent.filter(r => r.kind === "free_chat_rejected");
      }
    } else if (result.outcome !== "unresolved") throw Error("collection_outcome_invalid");
    results.push({ ...result, verifiedArchive: observed !== null, observed, caseSha256, inputMaterialSha256,
      ...(["resume-quality-task-candidate-v6", "resume-quality-task-candidate-v7"].includes(protocol) ? { candidateRejections } : {}) });
  }
  const frozen = results.filter(r => r.outcome === "frozen").length, failed = results.filter(r => r.outcome === "failure").length;
  if (summary.frozen !== frozen || summary.failed !== failed || summary.unresolved !== results.length - frozen - failed) throw Error("collection_summary_counts_changed");
  const observedModelCalls = results.every(r => r.observed !== null) ? results.reduce((sum, r) => sum + r.observed.modelCalls, 0) : null;
  if (observedModelCalls !== summary.observedModelCalls) throw Error("collection_summary_usage_changed");
  let capacityGuardVerified = false;
  if (contextDirectory !== undefined) {
    contextDirectory = await fs.realpath(contextDirectory);
    const names = ["local-model.json", ...intent.caseIds.flatMap(id => [`${id}-start_intent.context.json`, `${id}-case_result.context.json`])];
    for (const name of names) {
      const bytes = await readRegular(path.join(contextDirectory, name)), catalog = JSON.parse(decode(bytes));
      const check = contextCheck({ requests: intent.requests, ...catalog });
      const loaded = catalog.running.models?.filter(m => m.name === catalog.entry.name || m.model === catalog.entry.model);
      if (!check.passed || metadata.provider !== "ollama" || catalog.entry.name !== metadata.id || catalog.entry.digest !== metadata.revision
        || name.endsWith("-case_result.context.json") && loaded?.length !== 1) throw Error("collection_context_assurance_changed");
      files.set(`runtime-context/${name}`, bytes);
    }
    capacityGuardVerified = true;
  }
  const receipt = { schemaVersion: 1, protocolVersion: "resume-quality-collection-receipt-v1", campaignId: intent.campaignId, metadata,
    planned: results.length, frozen, failed, unresolved: results.length - frozen - failed, verifiedArchives: results.filter(r => r.verifiedArchive).length,
    observedModelCalls, comparable: false, capacityGuardVerified, candidateAcceptancePercent: 100 * frozen / results.length, results,
    files: [...files].map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: digest(bytes) })),
    limitations: ["All planned cases are retained; a failed or unresolved candidate is not assigned a fabricated four-axis score.",
      "This is a collection/provenance receipt, not a model ranking, semantic adjudication or scheduled multi-model quality report.",
      "Runtime context assurance is separate. A recorded full Host prompt does not by itself prove the provider processed all tokens.",
      "No model requests, recovery, adoption, FactBase writes or credential copying occur in this report."] };
  if (verifyOnly) return receipt;
  await fs.mkdir(outputDirectory, { mode: 0o700 });
  for (const [name, bytes] of files) {
    const target = path.join(outputDirectory, name); await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, bytes, { flag: "wx", mode: 0o600 });
  }
  await fs.writeFile(path.join(outputDirectory, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const rows = results.map(r => `| ${r.caseId} | ${r.taskId ?? "未知，保留原创建意图"} | ${r.outcome} | ${r.observed?.modelCalls ?? "未知"} | ${displayReason(r)} |`);
  const md = `# 完整批次采样回执\n\n${metadata.id} @ ${metadata.revision}，${metadata.execution}。\n\n计划 ${receipt.planned}；有效候选 ${frozen}；失败 ${failed}；未决 ${receipt.unresolved}。有效候选格式接受率 ${receipt.candidateAcceptancePercent}%，不是事实合规或简历质量分。实际根账模型派送 ${observedModelCalls ?? "未能完整核对"} 次。\n\n本机容量守卫原件重核：${capacityGuardVerified ? "通过（前后 catalog/show/ps 全文随回执保留；不是精确 tokenizer 或提供商处理全量 token 的签名证明）" : "未提供独立容量记录，不能从 Host 全文推断服务端处理完整性"}。\n\n| 案例 | 原任务 | 结果 | 根账模型次数 | 原因 |\n| --- | --- | --- | --- | --- |\n${rows.join("\n")}\n\n${receipt.limitations.map(x => `- ${x}`).join("\n")}\n`;
  await fs.writeFile(path.join(outputDirectory, "report.md"), md, { flag: "wx", mode: 0o600 });
  return receipt;
}

/** Full-denominator quality report. Frozen candidates are diagnosed; failed/unknown
 * cases stay visible with null scores. This is offline and never retries inference.
 */
export async function reviewCollectionQuality({ datasetDirectory, campaignDirectory, outputDirectory, contextDirectory }) {
  await fs.mkdir(outputDirectory, { mode: 0o700 }); outputDirectory = await fs.realpath(outputDirectory);
  const collectionDirectory = path.join(outputDirectory, "collection");
  const collection = await reviewCollection({ datasetDirectory, campaignDirectory, contextDirectory, outputDirectory: collectionDirectory });
  let quality = null;
  if (collection.frozen > 0) {
    const inputs = path.join(outputDirectory, "frozen-inputs"); await fs.mkdir(inputs, { mode: 0o700 });
    for (const result of collection.results.filter(r => r.outcome === "frozen")) {
      const prefix = `${result.caseId}/frozen/`;
      for (const file of collection.files.filter(f => f.path.startsWith(prefix))) {
        const bytes = await readRegular(path.join(collectionDirectory, file.path));
        if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw Error("collection_quality_input_changed");
        const target = path.join(inputs, file.path.slice(prefix.length));
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); await fs.writeFile(target, bytes, { flag: "wx", mode: 0o600 });
      }
    }
    quality = await runResumeQualityReport({ casesDirectory: path.join(datasetDirectory, "cases"), runsDirectory: inputs, outputDirectory: path.join(outputDirectory, "quality") });
  }
  const results = [];
  for (const result of collection.results) {
    let metrics = null;
    if (result.outcome === "frozen") {
      const full = JSON.parse(decode(await readRegular(path.join(outputDirectory, "quality", `${result.stem}.metrics.json`))));
      metrics = { coverage: full.coverage.percent, antiHallucination: full.antiHallucination.percent, star: full.star.percent,
        a4Passed: full.layout.passed, pages: full.layout.pages.length, automaticChecksPassed: full.automaticChecksPassed };
      if (full.editorialReview) metrics.editorial = { status: full.editorialReview.status,
        overallQualityPassed: full.editorialReview.overallQualityPassed, supportedCoverage: full.editorialReview.supportedRequirements.percent,
        omittedGroups: full.editorialReview.sourceGroups.omitted.map(g => g.id), findings: full.editorialReview.findings,
        automaticChecksScope: full.automaticChecksScope };
      if (full.currentWorkCoverage) metrics.currentWork = full.currentWorkCoverage;
    }
    results.push({ ...result, metrics });
  }
  const files = [];
  async function manifest(relative = "") {
    for (const name of (await fs.readdir(path.join(outputDirectory, relative))).sort()) {
      const item = path.join(relative, name), stat = await fs.lstat(path.join(outputDirectory, item));
      if (stat.isSymbolicLink()) throw Error("quality_report_link_rejected");
      if (stat.isDirectory()) await manifest(item);
      else { const bytes = await readRegular(path.join(outputDirectory, item)); files.push({ path: item, bytes: bytes.length, sha256: digest(bytes) }); }
    }
  }
  await manifest();
  const receipt = { schemaVersion: 1, protocolVersion: "resume-quality-full-collection-v1", campaignId: collection.campaignId, metadata: collection.metadata,
    planned: collection.planned, frozen: collection.frozen, failed: collection.failed, unresolved: collection.unresolved,
    qualityMeasured: results.filter(r => r.metrics !== null).length, allPlannedQualityMeasured: collection.frozen === collection.planned,
    candidateAcceptancePercent: collection.candidateAcceptancePercent, observedModelCalls: collection.observedModelCalls,
    capacityGuardVerified: collection.capacityGuardVerified, comparable: false, conditionalQuality: quality?.models ?? [], results, files,
    limitations: ["All planned cases remain the delivery denominator; failed/unresolved cases have null four-axis scores, never fabricated zero or perfect scores.",
      "Conditional quality statistics describe frozen candidates only. Source-exact/approved-paraphrase gates are conservative, not independent semantic certification.",
      "This single-campaign report is not a multi-model ranking or periodic execution. Different candidate protocols/configurations are not equivalent comparisons.",
      "No model requests, retries, recovery, adoption or FactBase writes occur. Full source, raw task output, failures, PDF and metrics are retained."] };
  await fs.writeFile(path.join(outputDirectory, "quality-receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const value = n => n === null ? "待独立复核" : `${n}%`;
  const rows = results.map(r => `| ${r.caseId} | ${r.outcome} | ${r.metrics ? value(r.metrics.coverage) : "—"} | ${r.metrics ? value(r.metrics.antiHallucination) : "—"} | ${r.metrics ? value(r.metrics.star) : "—"} | ${r.metrics ? `${r.metrics.pages}页 / ${r.metrics.a4Passed ? "通过" : "未通过"}` : "—"} | ${displayReason(r)} |`);
  await fs.writeFile(path.join(outputDirectory, "report.md"), `# 全计划候选交付与四轴质检\n\n计划 ${receipt.planned}；可冻结候选 ${receipt.frozen}；失败 ${receipt.failed}；未决 ${receipt.unresolved}。交付接受率 ${receipt.candidateAcceptancePercent}%，不是写作质量分。实际模型调用 ${receipt.observedModelCalls ?? "未知"} 次；本报告推理调用0次。\n\n质量实测 ${receipt.qualityMeasured}/${receipt.planned}，条件均值仅覆盖可冻结候选，不代表全计划质量，也不生成最佳模型结论。PDF保留所有页，版式失败不裁页。\n\n| 案例 | 交付 | JD覆盖 | 保守事实核准 | STAR | 实际A4 | 失败原因 |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows.join("\n")}\n\n${receipt.limitations.map(x => `- ${x}`).join("\n")}\n`, { flag: "wx", mode: 0o600 });
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), quality = args.at(-1) === "--quality";
  if (quality) args.pop();
  const [datasetDirectory, campaignDirectory, outputDirectory, contextDirectory] = args;
  if (!datasetDirectory || !campaignDirectory || !outputDirectory || ![3, 4].includes(args.length) || args.some(a => a.startsWith("--"))) throw Error("Usage: node --import tsx collection-report.mjs DATASET CAMPAIGN NEW_REPORT_DIR [EXPLICIT_CONTEXT_DIR] [--quality]");
  const receipt = await (quality ? reviewCollectionQuality : reviewCollection)({ datasetDirectory, campaignDirectory, outputDirectory, contextDirectory });
  console.log(JSON.stringify({ planned: receipt.planned, frozen: receipt.frozen, failed: receipt.failed, unresolved: receipt.unresolved, verifiedArchives: receipt.verifiedArchives, qualityMeasured: receipt.qualityMeasured, capacityGuardVerified: receipt.capacityGuardVerified, observedModelCalls: receipt.observedModelCalls, modelRequests: 0 }));
}
