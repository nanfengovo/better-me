import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { AgentTaskSchema, reviewResumeCandidateWorkCoverage } from "../../packages/agent-contracts/src/agent-task.ts";
import { judgeResumeQuality, RESUME_QUALITY_JUDGE, ResumeQualityRunSchema, validateResumeQualityCase } from "../../packages/core/src/career-intelligence/resume-quality.ts";
import { renderResumeQuality } from "./render.mjs";
import { verifyFrozenCandidate } from "./freeze.mjs";
import { reviewEditorialCompleteness } from "./editorial.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
async function readRegular(file) {
  if (!(await fs.lstat(file)).isFile() || await fs.realpath(file) !== path.resolve(file)) throw new Error("Only explicit regular, non-symlink input files are accepted.");
  return fs.readFile(file);
}
async function inputs(directory, suffix) {
  const files = (await fs.readdir(directory)).filter(name => name.endsWith(suffix)).sort();
  if (!files.length) throw new Error(`No ${suffix} files in the explicit input directory.`);
  if (files.some(name => !/^[a-z0-9][a-z0-9_.-]+$/.test(name))) throw new Error("Unsafe benchmark filename.");
  return Promise.all(files.map(async name => ({ name, bytes: await readRegular(path.join(directory, name)) })));
}
async function archiveKernelRun(run, name, directory, out, test) {
  if (run.origin.kind !== "kernel_task") return;
  const stem = name.slice(0, -".run.json".length);
  if ("sourceCandidate" in run || run.origin.freezeManifestSha256) {
    const frozen = await verifyFrozenCandidate(run, stem, directory, test);
    for (const [relative, bytes] of frozen.files) {
      const target = path.join(out, relative); await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, bytes, { flag: "wx", mode: 0o600 });
    }
    await fs.writeFile(path.join(out, `${stem}.freeze.json`), frozen.manifestBytes, { flag: "wx", mode: 0o600 });
    return frozen;
  }
  const taskBytes = await readRegular(path.join(directory, `${stem}.task.json`));
  const outputBytes = await readRegular(path.join(directory, `${stem}.output.txt`));
  if (sha256(taskBytes) !== run.origin.taskRecordSha256 || sha256(outputBytes) !== run.origin.rawOutputSha256) throw new Error("Full task/output archive hash changed.");
  const task = AgentTaskSchema.parse(JSON.parse(taskBytes.toString("utf8")));
  if (task.id !== run.origin.taskId || task.rootTaskId !== run.origin.rootTaskId || task.runtimeBinding.id !== run.model.runtimeId) throw new Error("Task/root/runtime binding changed.");
  const budget = task.rootLedger?.budget ?? task.budget, usage = task.rootLedger?.usage ?? task.usage;
  for (const key of ["maxModelCalls", "maxToolCalls", "maxActiveMs"]) if (run.budget[key] !== budget[key]) throw new Error("Root budget differs from archived task.");
  for (const key of ["modelCalls", "toolCalls", "activeMs"]) if (run.observed[key] !== usage[key]) throw new Error("Observed root usage differs from archived task.");
  await fs.writeFile(path.join(out, `${stem}.task.json`), taskBytes, { flag: "wx", mode: 0o600 });
  await fs.writeFile(path.join(out, `${stem}.output.txt`), outputBytes, { flag: "wx", mode: 0o600 });
}
const mean = values => values.length && values.every(n => n !== null) ? Number((values.reduce((sum, n) => sum + n, 0) / values.length).toFixed(2)) : null;
const cell = value => value === null ? "未判定" : `${value}%`;
const escape = text => String(text).replace(/\|/g, "\\|").replace(/[\r\n]/g, " ");

export function modelsAreComparable(models, realCount) {
  const actual = models.filter(m => m.origin === "kernel_task" && m.execution === "model" && m.validatedFreeze);
  // Frozen-only rows do not carry complete local catalog/weight provenance or
  // planned failure denominators. Full campaign comparison is the local-model
  // authority; two context aliases must not be counted as two model weights.
  if (actual.some(m => m.model?.provider === "ollama")) return false;
  const identities = new Set(actual.map(m => JSON.stringify([m.model?.provider, m.model?.id, m.model?.revision])));
  return identities.size >= 2 && realCount >= 5 && new Set(actual.map(m => m.comparisonSignature)).size === 1
    && actual.every(m => m.realCases === realCount);
}

/** Re-runnable offline report. It has no provider client, network or automatic task executor. */
export async function runResumeQualityReport({ casesDirectory, runsDirectory, outputDirectory }) {
  // Resolve the explicitly chosen directories once (macOS /tmp and /var are OS aliases).
  // Individual input-file symlinks remain rejected by readRegular.
  casesDirectory = await fs.realpath(casesDirectory); runsDirectory = await fs.realpath(runsDirectory);
  for (const dir of [casesDirectory, runsDirectory]) if (!(await fs.stat(dir)).isDirectory()) throw new Error("Input directories are required.");
  const caseFiles = await inputs(casesDirectory, ".case.json"), runFiles = await inputs(runsDirectory, ".run.json");
  const cases = new Map();
  for (const input of caseFiles) {
    const test = await validateResumeQualityCase(JSON.parse(input.bytes.toString("utf8")));
    if (cases.has(test.id)) throw new Error("Duplicate benchmark case ID.");
    cases.set(test.id, test);
  }
  const runs = runFiles.map(file => ({ ...file, run: ResumeQualityRunSchema.parse(JSON.parse(file.bytes.toString("utf8"))) }));
  const seen = new Set();
  for (const { run } of runs) {
    const key = JSON.stringify([run.model, run.caseId, run.origin.kind]);
    if (seen.has(key)) throw new Error("Duplicate model/case run; select one frozen run per comparison.");
    seen.add(key);
    if (!cases.has(run.caseId)) throw new Error("Run references an unknown benchmark case.");
  }
  // A fresh directory is the write authority. Existing reports and inputs are never overwritten.
  await fs.mkdir(outputDirectory, { mode: 0o700 });
  const results = [];
  for (const input of caseFiles) await fs.writeFile(path.join(outputDirectory, input.name), input.bytes, { flag: "wx", mode: 0o600 });
  for (const input of runs) {
    const judged = await judgeResumeQuality(cases.get(input.run.caseId), input.run);
    const archive = await archiveKernelRun(input.run, input.name, runsDirectory, outputDirectory, cases.get(input.run.caseId));
    const stem = input.name.slice(0, -".run.json".length);
    const layout = await renderResumeQuality(judged.resume, path.join(outputDirectory, `${stem}.pdf`));
    await fs.writeFile(path.join(outputDirectory, input.name), input.bytes, { flag: "wx", mode: 0o600 });
    const result = { ...judged, inputFileSha256: sha256(input.bytes), layout,
      pdfSha256: sha256(await fs.readFile(path.join(outputDirectory, `${stem}.pdf`))),
      automaticChecksPassed: judged.antiHallucination.percent === 100 && layout.passed };
    if (["resume-quality-task-candidate-v5", "resume-quality-task-candidate-v6", "resume-quality-task-candidate-v7"].includes(input.run.protocolVersion)) {
      if (!archive) throw Error("editorial_verified_freeze_required");
      const plan = JSON.parse(archive.files.get(`${stem}.plan.json`).toString("utf8"));
      result.automaticChecksScope = ["antiHallucination", "layout"];
      result.editorialReview = await reviewEditorialCompleteness(cases.get(input.run.caseId), input.run, plan.material);
      if (input.run.protocolVersion === "resume-quality-task-candidate-v7")
        result.currentWorkCoverage = reviewResumeCandidateWorkCoverage(plan.material, JSON.parse(archive.files.get(`${stem}.reply.txt`).toString("utf8")));
    }
    results.push(result);
    await fs.writeFile(path.join(outputDirectory, `${stem}.metrics.json`), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 });
  }
  const groupKey = r => JSON.stringify([r.model, r.origin.kind, r.origin.execution]);
  const models = [...new Set(results.map(groupKey))].map(key => {
    const group = results.filter(r => groupKey(r) === key);
    const real = group.filter(r => r.dataKind === "real_anonymized"), synthetic = group.filter(r => r.dataKind === "synthetic_protocol");
    return { model: group[0].model, origin: group[0].origin.kind, execution: group[0].origin.execution, realCases: real.length, syntheticCases: synthetic.length,
      validatedFreeze: group.every(r => Boolean(r.origin.freezeManifestSha256 && r.origin.inputMaterialSha256)),
      coverage: mean(real.map(r => r.coverage.percent)), antiHallucination: mean(real.map(r => r.antiHallucination.percent)), star: mean(real.map(r => r.star.percent)),
      a4PassRate: real.length ? 100 * real.filter(r => r.layout.passed).length / real.length : null,
      comparisonSignature: JSON.stringify(group.map(r => [r.caseId, r.caseSha256, r.origin.inputMaterialSha256, r.protocolVersion, r.budget]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))),
      observed: group.map(r => ({ caseId: r.caseId, ...r.observed })) };
  });
  const realCount = [...cases.values()].filter(c => c.dataKind === "real_anonymized").length;
  const comparable = modelsAreComparable(models, realCount);
  const summary = { schemaVersion: 1, judgeVersion: RESUME_QUALITY_JUDGE, realCases: realCount,
    syntheticCases: cases.size - realCount, comparable, models,
    limitations: ["Only real_anonymized cases enter aggregate scores; model, scripted extractive and human baselines remain separately labelled. Partial support never receives full JD coverage credit.",
      "Comparable requires two kernel-run models, the identical complete real case set (at least five), input hashes, protocol and root ceilings. A protocol fixture is not a real-model score.",
      "Model revision is supplied provenance, not independently verified provider weights. Frozen source/task/output archives are retained whole.",
      "Source candidates are reconstructed from full archived Host records and wire output; read-only source dates never become invented FactBase months. Neither export nor report adopts a proposal.",
      "This command makes zero model requests and schedules nothing; periodic reporting can rerun it against new explicitly collected runs."] };
  const rows = models.map(m => `| ${escape(m.model.id)} @ ${escape(m.model.revision)} | ${m.origin}${m.execution ? ` / ${m.execution}` : ""} | ${m.realCases} / ${m.syntheticCases} | ${cell(m.coverage)} | ${cell(m.antiHallucination)} | ${cell(m.star)} | ${cell(m.a4PassRate)} |`);
  const md = `# 简历四轴评测报告\n\n可直接比较：${comparable ? "是" : "否（样本、实际模型运行或可比条件尚不足）"}。真实 ${realCount} 组；合成 ${cases.size - realCount} 组。\n\n| 模型 / 版本 | 来源 | 真实 / 合成 | JD覆盖 | 事实合规 | STAR | 实际A4通过 |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows.join("\n")}\n\n各项是独立诊断，不将覆盖率抵消事实违规或排版失败。完整逐条检查、来源、任务原文与PDF保留于本目录。\n\n${summary.limitations.map(x => `- ${x}`).join("\n")}\n`;
  await fs.writeFile(path.join(outputDirectory, "summary.json"), JSON.stringify(summary, null, 2), { flag: "wx", mode: 0o600 });
  await fs.writeFile(path.join(outputDirectory, "report.md"), md, { flag: "wx", mode: 0o600 });
  return summary;
}
