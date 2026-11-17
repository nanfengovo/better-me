import { globSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const unitTestPatterns = [
  "packages/core/tests/*.test.mjs",
  "packages/storage/tests/*.test.ts",
  "packages/opportunities/tests/*.test.ts",
  "packages/source-adapters/tests/*.test.ts",
  "apps/job-service/tests/*.test.ts",
  "apps/agent-host/tests/*.test.ts",
  "apps/web/tests/*.test.ts",
  "apps/web/tests/*.test.tsx",
];
export const pdfParserTest = "apps/agent-host/tests/learning-pdf.test.ts";

export function discoverUnitTests(root) {
  const files = unitTestPatterns.flatMap(pattern => {
    const matches = [...globSync(pattern, { cwd: root })];
    if (!matches.length) throw new Error(`No test files matched ${pattern}`);
    return matches.map(file => file.split(path.sep).join("/"));
  });
  return [...new Set(files)].sort();
}

export function planUnitTests(files) {
  if (!files.includes(pdfParserTest)) throw new Error("Missing bounded PDF parser regression");
  // Exercise the real parser with its unchanged 20-second production limit,
  // before parallel UI/HTTP fixtures can starve worker startup on Windows.
  return [
    { name: "bounded PDF parser (isolated)", concurrency: 1, files: [pdfParserTest] },
    { name: "remaining complete unit suite", concurrency: 4, files: files.filter(file => file !== pdfParserTest) },
  ];
}

export function runUnitTests(root, spawn = spawnSync) {
  const require = createRequire(import.meta.url);
  for (const group of planUnitTests(discoverUnitTests(root))) {
    console.log(`[unit-tests] ${group.name}: ${group.files.length} files, concurrency ${group.concurrency}`);
    const result = spawn(process.execPath, [require.resolve("tsx/cli"),
      "--tsconfig", "apps/web/tsconfig.json", "--test", "--test-reporter=tap",
      `--test-concurrency=${group.concurrency}`, ...group.files], { cwd: root, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runUnitTests(fileURLToPath(new URL("../", import.meta.url)));
}
