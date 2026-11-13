import path from "node:path";
import { runResumeQualityReport } from "./report.mjs";

const args = process.argv.slice(2), options = new Map();
for (let i = 0; i < args.length; i += 2) {
  const flag = args[i], value = args[i + 1];
  if (!["--cases", "--runs", "--out"].includes(flag) || !value || value.startsWith("--") || options.has(flag)) throw new Error("Use --cases DIR --runs DIR --out NEW_DIR. No model execution or cloud fallback.");
  options.set(flag, path.resolve(value));
}
if (options.size !== 3) throw new Error("Explicit --cases, --runs and fresh --out directories are required.");
const summary = await runResumeQualityReport({ casesDirectory: options.get("--cases"), runsDirectory: options.get("--runs"), outputDirectory: options.get("--out") });
console.log(JSON.stringify({ outputDirectory: options.get("--out"), realCases: summary.realCases, syntheticCases: summary.syntheticCases, comparable: summary.comparable, models: summary.models.length, modelRequests: 0 }));
