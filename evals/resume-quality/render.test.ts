import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { judgeResumeQuality } from "../../packages/core/src/career-intelligence/resume-quality.js";
import { syntheticQualityFixture } from "./fixtures.js";
import { renderResumeQuality } from "./render.mjs";
import { runResumeQualityReport } from "./report.mjs";

test("actual offline production-template A4 is one page with full text; long input stays multi-page instead of being clipped", { timeout: 60_000 }, async () => {
  const { test: fixture, run } = await syntheticQualityFixture(), judged = await judgeResumeQuality(fixture, run);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-quality-pdf-"));
  const short = await renderResumeQuality(judged.resume, path.join(directory, "short.pdf"));
  assert.equal(short.passed, true); assert.equal(short.pageCount, 1); assert.equal(short.a4, true);
  assert.deepEqual(short.pages[0]!.clippedText, []);
  assert.deepEqual(short.missingClaims, []); assert.deepEqual(short.orphanHeadings, []); assert.equal(short.blockedRequests, 0);
  const long = structuredClone(judged.resume);
  long.experiences[0]!.claims = Array.from({ length: 120 }, (_, i) => ({ id: `long-${i}`, kind: "action", tags: [], text: `CompleteContribution${i}. Implemented traceable request handling and retained the entire original output for explicit review.` }));
  const full = await renderResumeQuality(long, path.join(directory, "long.pdf"));
  assert.equal(full.passed, false); assert.ok(full.pageCount > 1); assert.equal(full.a4, true); assert.deepEqual(full.missingClaims, []);
  assert.match(full.pages.at(-1)!.text, /CompleteContribution119/);
  await assert.rejects(renderResumeQuality(judged.resume, path.join(directory, "short.pdf")), /EEXIST/);
});
test("offline report retains complete artifacts, excludes synthetic scores from real aggregates and refuses overwrite", { timeout: 60_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-quality-report-")), cases = path.join(root, "cases"), runs = path.join(root, "runs"), out = path.join(root, "report");
  await fs.mkdir(cases); await fs.mkdir(runs);
  const { test: fixture, run } = await syntheticQualityFixture();
  await fs.writeFile(path.join(cases, "synthetic.case.json"), JSON.stringify(fixture));
  await fs.writeFile(path.join(runs, "synthetic.run.json"), JSON.stringify(run));
  const result = await runResumeQualityReport({ casesDirectory: cases, runsDirectory: runs, outputDirectory: out });
  assert.equal(result.realCases, 0); assert.equal(result.syntheticCases, 1); assert.equal(result.comparable, false);
  assert.equal(result.models[0]!.antiHallucination, null); assert.equal(result.models[0]!.a4PassRate, null);
  const metrics = JSON.parse(await fs.readFile(path.join(out, "synthetic.metrics.json"), "utf8"));
  assert.equal(metrics.layout.passed, true); assert.equal(metrics.antiHallucination.percent, 100);
  assert.equal(await fs.readFile(path.join(out, "synthetic.run.json"), "utf8"), JSON.stringify(run));
  assert.match(await fs.readFile(path.join(out, "report.md"), "utf8"), /可直接比较：否/);
  await assert.rejects(runResumeQualityReport({ casesDirectory: cases, runsDirectory: runs, outputDirectory: out }), /EEXIST/);
});

test("kernel-labelled runs cannot bypass full output/task archive hashes or overwrite an existing report", { timeout: 15_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-quality-binding-")), cases = path.join(root, "cases"), runs = path.join(root, "runs");
  await fs.mkdir(cases); await fs.mkdir(runs);
  const { test: fixture, run } = await syntheticQualityFixture();
  const frozen = { ...run, origin: { kind: "kernel_task", taskId: `ct_${"1".repeat(32)}`, rootTaskId: `ct_${"1".repeat(32)}`,
    rawOutputSha256: "0".repeat(64), taskRecordSha256: "0".repeat(64) } };
  await fs.writeFile(path.join(cases, "synthetic.case.json"), JSON.stringify(fixture));
  await fs.writeFile(path.join(runs, "synthetic.run.json"), JSON.stringify(frozen));
  await fs.writeFile(path.join(runs, "synthetic.output.txt"), "complete original text with trailing spaces  ");
  await fs.writeFile(path.join(runs, "synthetic.task.json"), "{}");
  await assert.rejects(runResumeQualityReport({ casesDirectory: cases, runsDirectory: runs, outputDirectory: path.join(root, "report") }), /archive hash changed/);
  assert.equal(await fs.readFile(path.join(runs, "synthetic.output.txt"), "utf8"), "complete original text with trailing spaces  ");
});
test("real Gold report prints three source baselines without fabricating two timelines or a model ranking", { timeout: 60_000 }, async () => {
  const directory = fileURLToPath(new URL("./gold/v1/", import.meta.url));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-gold-report-test-")), outputDirectory = path.join(root, "report");
  const summary = await runResumeQualityReport({ casesDirectory: path.join(directory, "cases"), runsDirectory: path.join(directory, "baselines"), outputDirectory });
  assert.equal(summary.judgeVersion, "resume-quality-v2"); assert.equal(summary.realCases, 5); assert.equal(summary.syntheticCases, 0);
  assert.equal(summary.comparable, false); assert.equal(summary.models.length, 1);
  assert.equal(summary.models[0]!.origin, "extractive_baseline"); assert.equal(summary.models[0]!.realCases, 3);
  assert.equal(summary.models[0]!.a4PassRate, 100); assert.ok(summary.models[0]!.observed.every(o => o.modelCalls === 0));
  for (const id of ["gold-sre", "gold-fullstack", "gold-data-engineer"]) {
    const metrics = JSON.parse(await fs.readFile(path.join(outputDirectory, `${id}.metrics.json`), "utf8"));
    assert.equal(metrics.layout.pageCount, 1); assert.equal(metrics.layout.passed, true); assert.equal(metrics.antiHallucination.percent, 100);
    assert.equal(metrics.layout.blockedRequests, 0); assert.equal(metrics.layout.missingClaims.length, 0);
  }
  await assert.rejects(fs.stat(path.join(outputDirectory, "gold-backend.pdf")), { code: "ENOENT" });
});
