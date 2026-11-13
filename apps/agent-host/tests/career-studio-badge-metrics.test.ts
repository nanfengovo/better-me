import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { EvidenceBroker } from "../src/understanding/evidence-broker.js";
import { GitEvidenceSource } from "../src/evidence-harvester/git-source.js";
import { readBadgeMetricEvidence, collectBadgeMetrics, type BadgeMetricEvidence, type BadgeMetricOptions } from "../src/career-studio/badge-metrics.js";
import { compileEvidenceBadge } from "../src/career-studio/evidence-badge.js";

const targetHash = "f".repeat(64), current = { isCurrent: () => true };
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const exec = promisify(execFile);
async function setup(t: test.TestContext) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "betterme-badge-metrics-"))), broker = new EvidenceBroker(), grant = await broker.grant(directory);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const write = async (relative: string, text: string) => { const file = path.join(directory, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text, { mode: 0o600 }); return file; };
  const read = async (relative: string, text: string, authority: BadgeMetricOptions["isCurrent"] = current.isCurrent, startLine = 1, endLine = text.split(/\r?\n/).length) => {
    await write(relative, text); return readBadgeMetricEvidence({ broker, grant, selection: { path: relative, startLine, endLine }, isCurrent: authority });
  };
  return { directory, broker, grant, write, read };
}
async function coverageFixture(t: test.TestContext) {
  const fixture = await setup(t), sourceText = 'const initial = "idle";\nconst lease = true;\nexport { initial, lease };', reportText = "TN:synthetic\nSF:/synthetic/project/src/state.ts\nDA:1,2\nDA:2,0\nDA:3,1\nLF:3\nLH:2\nend_of_record";
  const source = await fixture.read("src/state.ts", sourceText), report = await fixture.read("reports/line-hits.txt", reportText);
  const manifestText = JSON.stringify({ protocol: "betterme.coverage-source-binding.v1", reportHash: digest(reportText), files: [{ reportPath: "/synthetic/project/src/state.ts", sourcePath: "src/state.ts", sourceHash: digest(sourceText) }] });
  const manifest = await fixture.read("reports/source-binding.json", manifestText);
  return { ...fixture, sourceText, reportText, manifestText, source, report, manifest };
}

test("actual broker handles bind explicit JSON transition entries to source hash/range without evaluating project code or claiming runtime complexity", async t => {
  const fixture = await setup(t), source = '{"idle":{"START":"running"},"running":{"DONE":"done","FAIL":"idle"},"done":{}}', evidence = await fixture.read("state-table.json", source);
  const result = await collectBadgeMetrics({ targetHash, transition: { evidence, format: "json" } }, current);
  assert.equal(result.status, "observed"); assert.equal(result.metrics.declaredTransitionEntries!.value, 3); assert.equal("stateTransitions" in result.metrics, false);
  assert.deepEqual(result.metrics.declaredTransitionEntries!.sourceHashes, [digest(source)]); assert.notEqual(evidence.sourceHash, targetHash);
  const receipt = result.metricReceipts[0]!; assert.equal(receipt.targetHash, targetHash); assert.equal(receipt.executionVerified, false); assert.equal(receipt.inputs[0]!.kind, "broker_excerpt");
  assert.match(receipt.limitations.join(" "), /不是运行时状态机复杂度/); assert.equal(result.metrics.testCoveragePercent, undefined); assert.equal(result.metrics.evolutionDays, undefined);
  assert.ok(Object.isFrozen(evidence));
  await assert.rejects(collectBadgeMetrics({ targetHash, transition: { evidence: JSON.parse(JSON.stringify(evidence)) as BadgeMetricEvidence, format: "json" } }, current));
});

test("compiler binds each collected measurement receipt without substituting a claim hash for actual code hashes; tampering cannot change visual channels", async t => {
  const fixture = await setup(t), evidence = await fixture.read("states.json", '{"idle":{"START":"running","CANCEL":"done"},"running":{"DONE":"done"}}');
  const measurement = await collectBadgeMetrics({ targetHash, transition: { evidence, format: "json" } }, current);
  const observation = { schemaVersion: 1 as const, artifactId: "synthetic-publication", sourceHash: targetHash,
    receipt: { id: "synthetic-verification", targetHash, status: "passed" as const, verifierVersion: "synthetic-v1", checks: ["selected source bytes only"], at: new Date().toISOString() },
    metrics: measurement.metrics, metricReceipts: measurement.metricReceipts, skillIds: ["sqlite"], personalContribution: "implementation" as const };
  const badge = compileEvidenceBadge(observation); assert.equal(badge.parameters.facets, 8); assert.equal(badge.mapping[0]!.metric, "declaredTransitionEntries");
  assert.notEqual(badge.observation.sourceHash, badge.observation.metrics.declaredTransitionEntries!.sourceHashes[0]);
  assert.throws(() => compileEvidenceBadge({ ...observation, metricReceipts: [] }), /badge_metric_receipt_missing/);
  assert.throws(() => compileEvidenceBadge({ ...observation, metrics: { declaredTransitionEntries: { ...measurement.metrics.declaredTransitionEntries!, value: 1000 } } }), /badge_metric_receipt_mismatch/);
  const changed = structuredClone(observation); changed.metricReceipts[0]!.scope = "pretend whole project";
  assert.throws(() => compileEvidenceBadge(changed), /badge_metric_receipt_mismatch/);
});

test("LCOV coverage stays unknown without a broker-read source manifest and only counts reported hits within explicitly selected exact-version source ranges", async t => {
  const fixture = await coverageFixture(t);
  const unbound = await collectBadgeMetrics({ targetHash, coverage: { report: fixture.report, format: "lcov", sources: [fixture.source] } }, current);
  assert.equal(unbound.metrics.testCoveragePercent, undefined); assert.ok(unbound.unknowns.includes("testCoveragePercent:coverage_source_hash_manifest_required"));
  const result = await collectBadgeMetrics({ targetHash, coverage: { report: fixture.report, format: "lcov", manifest: fixture.manifest, sources: [fixture.source] } }, current);
  assert.equal(result.metrics.testCoveragePercent!.value, 66.6667); assert.equal(result.metricReceipts[0]!.executionVerified, false);
  assert.deepEqual(result.metrics.testCoveragePercent!.sourceHashes, [digest(fixture.reportText), digest(fixture.manifestText), digest(fixture.sourceText)]);
  assert.match(result.metrics.testCoveragePercent!.scope, /报告列明DA行3、命中2/); assert.match(result.metricReceipts[0]!.limitations.join(" "), /不证明报告真实运行/);
  const partialSource = await readBadgeMetricEvidence({ broker: fixture.broker, grant: fixture.grant, selection: { path: "src/state.ts", startLine: 1, endLine: 2, expectedSourceHash: fixture.source.sourceHash }, ...current });
  const selected = await collectBadgeMetrics({ targetHash, coverage: { report: fixture.report, format: "lcov", manifest: fixture.manifest, sources: [partialSource] } }, current);
  assert.equal(selected.metrics.testCoveragePercent!.value, 50); assert.match(selected.metrics.testCoveragePercent!.scope, /不是全项目覆盖率/);
});

test("a manifest cannot bind the wrong source/report hash or guessed basename; Cobertura stays explicitly unsupported rather than executing XML", async t => {
  const fixture = await coverageFixture(t), base = JSON.parse(fixture.manifestText) as { protocol: string; reportHash: string; files: Array<{ reportPath: string; sourcePath: string; sourceHash: string }> };
  for (const mutation of [
    { ...base, reportHash: "0".repeat(64) }, { ...base, files: [{ ...base.files[0]!, sourceHash: "0".repeat(64) }] },
    { ...base, files: [{ ...base.files[0]!, reportPath: "state.ts" }] }, { ...base, files: [base.files[0]!, base.files[0]!] },
  ]) {
    const manifest = await fixture.read("reports/changed-manifest.json", JSON.stringify(mutation));
    const result = await collectBadgeMetrics({ targetHash, coverage: { report: fixture.report, format: "lcov", manifest, sources: [fixture.source] } }, current);
    assert.equal(result.metrics.testCoveragePercent, undefined); assert.equal(result.metricReceipts.length, 0);
  }
  const result = await collectBadgeMetrics({ targetHash, coverage: { report: fixture.report, format: "cobertura", manifest: fixture.manifest, sources: [fixture.source] } }, current);
  assert.equal(result.metrics.testCoveragePercent, undefined); assert.ok(result.unknowns.includes("testCoveragePercent:cobertura_parser_not_available"));
});

test("malformed, incomplete and inconsistent LCOV never supplies a coverage metric", async t => {
  const fixture = await coverageFixture(t);
  for (const reportText of [
    fixture.reportText.replace("DA:2,0", "DA:2,-1"), fixture.reportText.replace("LH:2", "LH:3"), fixture.reportText.replace("end_of_record", ""),
    fixture.reportText.replace("DA:2,0", "DA:1,0"), fixture.reportText.replace("LF:3", "LF:4"), "SF:/synthetic/project/src/state.ts\nLF:0\nLH:0\nend_of_record",
  ]) {
    const report = await fixture.read("reports/invalid-hits.txt", reportText), manifest = await fixture.read("reports/invalid-hits-bindings.json", JSON.stringify({ protocol: "betterme.coverage-source-binding.v1", reportHash: digest(reportText), files: [{ reportPath: "/synthetic/project/src/state.ts", sourcePath: "src/state.ts", sourceHash: fixture.source.sourceHash }] }));
    const result = await collectBadgeMetrics({ targetHash, coverage: { report, format: "lcov", manifest, sources: [fixture.source] } }, current);
    assert.equal(result.metrics.testCoveragePercent, undefined); assert.equal(result.metricReceipts.length, 0);
  }
});

test("literal table parsing rejects executable syntax and non-string transition targets without counting source cases, lines or tests as complexity", async t => {
  const fixture = await setup(t);
  for (const source of ['{"idle":{"START":{"target":"running"}}}', '{"idle":{"START":42}}', '{"idle":["running"]}', '(()=>{globalThis.__badgeFixtureExecuted=true; return {idle:{START:"running"}};})()', 'const states = { idle: { START: "running" } };']) {
    const evidence = await fixture.read("unsupported-table.txt", source), result = await collectBadgeMetrics({ targetHash, transition: { evidence, format: "json" } }, current);
    assert.equal(result.metrics.declaredTransitionEntries, undefined); assert.equal(result.metrics.testCoveragePercent, undefined);
  }
  assert.equal(Reflect.get(globalThis, "__badgeFixtureExecuted"), undefined);
  const empty = await fixture.read("empty-table.json", "{}"), result = await collectBadgeMetrics({ targetHash, transition: { evidence: empty, format: "json" } }, current); assert.equal(result.metrics.declaredTransitionEntries!.value, 0);
});

test("source changes and late identity revocation erase every provisional metric rather than publishing a stale measurement", async t => {
  const fixture = await setup(t), evidence = await fixture.read("states.json", '{"idle":{"START":"running"}}');
  await fixture.write("states.json", '{"idle":{"START":"running","CANCEL":"done"}}');
  const stale = await collectBadgeMetrics({ targetHash, transition: { evidence, format: "json" } }, current); assert.equal(stale.status, "stale"); assert.deepEqual(stale.metrics, {}); assert.deepEqual(stale.metricReceipts, []);
  let active = true; const fresh = await fixture.read("fresh-states.json", '{"idle":{"START":"running"}}', () => active);
  const late = await collectBadgeMetrics({ targetHash, transition: { evidence: fresh, format: "json" }, git: { repositoryId: "a".repeat(64), selectedCommits: ["b".repeat(40), "c".repeat(40)] } }, {
    isCurrent: () => active, resolveGitCaptures: async () => { active = false; return [{ repositoryId: "a".repeat(64), commit: "b".repeat(40), committedAt: "2026-01-01T00:00:00.000Z" }, { repositoryId: "a".repeat(64), commit: "c".repeat(40), committedAt: "2026-01-03T00:00:00.000Z" }]; },
  });
  assert.equal(late.status, "stale"); assert.deepEqual(late.metrics, {}); assert.deepEqual(late.metricReceipts, []);
});

test("broker rules still deny excluded report directories/extensions, oversized or truncated selections, secrets and revoked grants", async t => {
  const fixture = await setup(t); await fixture.write("coverage/report.txt", "SF:src/state.ts\nend_of_record"); await fixture.write("report.info", "SF:src/state.ts\nend_of_record"); await fixture.write("one-line.txt", "one line");
  for (const [file, endLine] of [["coverage/report.txt", 2], ["report.info", 2], ["one-line.txt", 2]] as const) await assert.rejects(readBadgeMetricEvidence({ broker: fixture.broker, grant: fixture.grant, selection: { path: file, startLine: 1, endLine }, ...current }));
  await assert.rejects(readBadgeMetricEvidence({ broker: fixture.broker, grant: fixture.grant, selection: { path: "one-line.txt", startLine: 1, endLine: 201 }, ...current }));
  await fixture.write("sensitive-source.ts", "const api_key = 'synthetic-credential-not-real';"); await assert.rejects(readBadgeMetricEvidence({ broker: fixture.broker, grant: fixture.grant, selection: { path: "sensitive-source.ts", startLine: 1, endLine: 1 }, ...current }));
  await assert.rejects(readBadgeMetricEvidence({ broker: fixture.broker, grant: fixture.grant, selection: { path: "one-line.txt", startLine: 1, endLine: 1, expectedSourceHash: "0".repeat(64) }, ...current }), /badge_metric_source_changed/);
  fixture.grant.revokedAt = new Date().toISOString(); await assert.rejects(readBadgeMetricEvidence({ broker: fixture.broker, grant: fixture.grant, selection: { path: "one-line.txt", startLine: 1, endLine: 1 }, ...current }), /revoked/);
});

test("evolution days derive only from exact authorized same-repository Git capture timestamps, not commit authors, code size or invented work duration", async t => {
  const fixture = await setup(t), gitEnvironment = { ...process.env, GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  const git = async (args: string[], when?: string) => exec("git", ["-c", "user.name=Synthetic Fixture", "-c", "user.email=synthetic@example.invalid", "-c", "core.hooksPath=unused-fixture-hooks", ...args], {
    cwd: fixture.directory, timeout: 8000, maxBuffer: 64000, env: { ...gitEnvironment, ...(when ? { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } : {}) },
  });
  await git(["init", "--quiet"]); await fixture.write("module.ts", "export const first = true;"); await git(["add", "--", "module.ts"]); await git(["commit", "--quiet", "-m", "synthetic first"], "2026-01-01T00:00:00Z");
  const source = new GitEvidenceSource(), preview = await source.preview(fixture.directory), first = await source.capture(preview, preview.head);
  await fixture.write("module.ts", "export const first = true;\nexport const second = true;"); await git(["add", "--", "module.ts"]); await git(["commit", "--quiet", "-m", "synthetic second"], "2026-01-04T12:00:00Z");
  const head = (await git(["rev-parse", "HEAD"])).stdout.trim(), second = await source.capture(preview, head), selected = { repositoryId: preview.repositoryId, selectedCommits: [first.commit, second.commit] };
  const absent = await collectBadgeMetrics({ targetHash, git: selected }, current); assert.equal(absent.metrics.evolutionDays, undefined); assert.ok(absent.unknowns.includes("evolutionDays:authorized_capture_provider_unavailable"));
  let resolved = 0; const measured = await collectBadgeMetrics({ targetHash, git: selected }, { ...current, resolveGitCaptures: async selection => { resolved++; assert.deepEqual(selection, selected); return [second, first]; } });
  assert.equal(resolved, 1); assert.equal(measured.metrics.evolutionDays!.value, 3.5); assert.equal(measured.metricReceipts[0]!.inputs.length, 2);
  assert.match(measured.metricReceipts[0]!.limitations.join(" "), /时间戳可被设置/); assert.match(measured.metrics.evolutionDays!.scope, /不是连续开发时长/);
  const crossRepository = await collectBadgeMetrics({ targetHash, git: selected }, { ...current, resolveGitCaptures: async () => [first, { ...second, repositoryId: "0".repeat(64) }] });
  assert.equal(crossRepository.metrics.evolutionDays, undefined); assert.ok(crossRepository.unknowns.includes("evolutionDays:badge_git_capture_scope_mismatch"));
  await assert.rejects(collectBadgeMetrics({ targetHash, git: { ...selected, selectedCommits: Array.from({ length: 33 }, () => first.commit) } }, current));
});

test("cancellation and bounded current/capture deadlines return no provisional metrics and never fall back to arbitrary filesystem or model numbers", async t => {
  const fixture = await setup(t), evidence = await fixture.read("states.json", '{"idle":{"START":"running"}}'), controller = new AbortController(); controller.abort();
  const cancelled = await collectBadgeMetrics({ targetHash, transition: { evidence, format: "json" } }, { ...current, signal: controller.signal }); assert.equal(cancelled.status, "cancelled"); assert.deepEqual(cancelled.metrics, {});
  const withinTest = async <T>(promise: Promise<T>) => { let timeout: ReturnType<typeof setTimeout> | undefined; try { return await Promise.race([promise, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(Error("badge metric budget failed to stop")), 500); })]); } finally { if (timeout) clearTimeout(timeout); } };
  const hungCurrent = await withinTest(collectBadgeMetrics({ targetHash }, { isCurrent: () => new Promise(() => {}), timeoutMs: 10 })); assert.equal(hungCurrent.status, "unknown"); assert.deepEqual(hungCurrent.metrics, {});
  const hungCapture = await withinTest(collectBadgeMetrics({ targetHash, transition: { evidence, format: "json" }, git: { repositoryId: "a".repeat(64), selectedCommits: ["b".repeat(40), "c".repeat(40)] } }, { ...current, timeoutMs: 10, resolveGitCaptures: async () => new Promise(() => {}) }));
  assert.equal(hungCapture.status, "unknown"); assert.deepEqual(hungCapture.metrics, {}); assert.deepEqual(hungCapture.metricReceipts, []);
  await assert.rejects(withinTest(readBadgeMetricEvidence({ broker: fixture.broker, grant: fixture.grant, selection: { path: "states.json", startLine: 1, endLine: 1 }, isCurrent: () => new Promise(() => {}), timeoutMs: 10 })), /badge_metric_cancelled/);
  await assert.rejects(collectBadgeMetrics({ targetHash, metrics: { testCoveragePercent: 100 } } as unknown as Parameters<typeof collectBadgeMetrics>[0], current));
});
