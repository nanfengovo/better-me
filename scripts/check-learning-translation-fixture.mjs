/** Original checkpoint-notes-v1 fixture only. These mechanical checks do NOT
 * certify translation semantics, reading order, rendering or general PDFs. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
const text = await fs.readFile(process.argv[2], "utf8");
const pages = text.split("\f").filter(page => page.trim());
const checks = {
  threePages: pages.length === 3,
  noDebugOverlayText: !/(?:fallback_line|paragraph\[[^\]]+\]|pagenumber:)/.test(text),
  operationId: /op-17/.test(pages[1] ?? ""),
  duration: /42\s*ms/.test(pages[1] ?? ""),
  finiteToolBudget: /32\s+tool\s+steps/i.test(pages[1] ?? ""),
  checkpointTerm: /checkpoint/i.test(text),
  secondHeading: /receipt[\s\S]{0,50}read[\s\S]{0,35}continu/i.test((pages[1] ?? "").slice(0,300)),
  additiveFormula: /total\s+steps\s*=[^\n]*[\s\S]{0,100}\+[^\f]{0,100}(?:verification|validation)\s+steps/i.test(pages[2] ?? ""),
  noKnownBrokenBudgetWord: !/\bb\s*\nudget\b/.test(pages[1] ?? ""),
  noKnownFormulaVerbError: !/total\s+steps\s*=\s*(?:have|has)\s+(?:been\s+)?saved/i.test((pages[2] ?? "").replace(/\s+/g, " ")),
};
console.log(JSON.stringify({ fixture: "checkpoint-notes-v1", checks, automaticQualityCertification: false }, null, 2));
assert.ok(Object.values(checks).every(Boolean), "Original fixture mechanical checks failed; inspect all rendered pages separately");
