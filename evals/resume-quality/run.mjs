import path from "node:path";
import { readRegular } from "./freeze.mjs";
import { rateCard } from "./token-cost.mjs";
import { runResumeQualityReport } from "./report.mjs";
import { reviewCollectionQuality } from "./collection-report.mjs";

const args = process.argv.slice(2), options = new Map();
const usage = [
  "pnpm evals:resume-quality --cases DIR --runs DIR --out NEW_DIR",
  "pnpm evals:resume-quality --dataset GOLD_DIR --campaign COLLECTED_DIR --out NEW_DIR [--context CONTEXT_DIR] [--rates RATE_CARD.json]",
  "第一种方式评估已有候选。第二种方式离线核验整批交付、根账运行数据和已冻结候选的四轴质量。",
].join("\n");
if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
  console.log(usage);
  process.exit(0);
}
for (let i = 0; i < args.length; i += 2) {
  const flag = args[i], value = args[i + 1];
  if (!["--cases", "--runs", "--dataset", "--campaign", "--out", "--context", "--rates"].includes(flag) || !value || value.startsWith("--") || options.has(flag)) throw new Error(usage);
  options.set(flag, path.resolve(value));
}
if (options.has("--campaign") && options.has("--dataset") && options.has("--out") && !options.has("--cases") && !options.has("--runs")) {
  const rates = options.has("--rates") ? rateCard.parse(JSON.parse(await readRegular(options.get("--rates")))) : undefined;
  const summary = await reviewCollectionQuality({ datasetDirectory: options.get("--dataset"), campaignDirectory: options.get("--campaign"),
    outputDirectory: options.get("--out"), contextDirectory: options.get("--context"), rates });
  console.log(JSON.stringify({ outputDirectory: options.get("--out"), planned: summary.planned, runtimeQuality: summary.runtimeQuality, costEstimate: summary.costEstimate, modelRequests: 0 }));
} else if (options.size === 3 && ["--cases", "--runs", "--out"].every(key => options.has(key))) {
  const summary = await runResumeQualityReport({ casesDirectory: options.get("--cases"), runsDirectory: options.get("--runs"), outputDirectory: options.get("--out") });
  console.log(JSON.stringify({ outputDirectory: options.get("--out"), realCases: summary.realCases, syntheticCases: summary.syntheticCases, comparable: summary.comparable, models: summary.models.length, modelRequests: 0 }));
} else throw new Error(usage);
