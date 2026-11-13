import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createAgentServer } from "../../apps/agent-host/src/server.js";
import { registerTestIdentity } from "../../apps/agent-host/tests/fixtures/identity.js";
import { careerRuntimeBinding } from "../../packages/agent-contracts/src/career-task.js";
import { collectBenchmark } from "./collect.mjs";
import { digest } from "./gold/extract.mjs";
import { ComparisonConfigSchema, campaignComparisonEligibility, comparisonModelIdentity, prepareComparisonSelection, readComparisonConfig, reviewCampaignComparison } from "./comparison.mjs";
import { runPeriodicComparison } from "./periodic-report.mjs";

const { MemorySaver } = createRequire(new URL("../../apps/agent-host/package.json", import.meta.url))("@langchain/langgraph");
const datasetDirectory = fileURLToPath(new URL("./gold/v1/", import.meta.url));
const cases = ["gold-backend", "gold-data-engineer", "gold-frontend", "gold-fullstack", "gold-sre"];

test("pure policy distinguishes known failures from unequal-survivor quality, and never treats fixtures as two real models", () => {
  // Policy inputs only; these are NOT provider/model trials or quality claims.
  const sample = (key: string) => ({ metadata: { execution: "model" }, modelIdentity: { key }, realCaseIds: cases,
    conditionsSignature: "same-full-material-protocol-budget-template", results: cases.map(caseId => ({ caseId, outcome: "frozen", verifiedArchive: true })) });
  const a = sample("weight-a"), b = sample("weight-b");
  assert.equal(campaignComparisonEligibility([a, b]).qualityComparable, true);
  assert.equal(campaignComparisonEligibility([a, b]).bestModel, null);
  assert.equal(campaignComparisonEligibility([a, b]).overallQualityPassed, null);
  b.results[1]!.outcome = "failure";
  const knownFailure = campaignComparisonEligibility([a, b]);
  assert.equal(knownFailure.deliveryComparable, true); assert.equal(knownFailure.qualityComparable, false);
  assert.deepEqual(knownFailure.reasonCodes, ["not_all_planned_candidates_frozen"]);
  b.results[1]!.outcome = "unresolved"; b.results[1]!.verifiedArchive = false;
  assert.ok(campaignComparisonEligibility([a, b]).reasonCodes.includes("unresolved_or_unverified_case"));
  b.conditionsSignature = "different-protocol";
  assert.ok(campaignComparisonEligibility([a, b]).reasonCodes.includes("conditions_differ"));
  b.realCaseIds = cases.slice(0, 4);
  assert.ok(campaignComparisonEligibility([a, b]).reasonCodes.includes("at_least_five_real_cases_required"));
  assert.equal(campaignComparisonEligibility([a, { ...sample("weight-a"), metadata: { execution: "scripted_fixture" } }]).distinctRealModels, 1);
  assert.equal(campaignComparisonEligibility([a, sample("weight-a")]).deliveryComparable, false);
  assert.ok(campaignComparisonEligibility([a, { ...sample("unknown"), modelIdentity: { key: null } }]).reasonCodes.includes("underlying_model_identity_unverified"));
});

test("saved Ollama multi-blob aliases collapse to one weight identity; incomplete FROM/ADAPTER evidence remains unknown", () => {
  const metadata = { provider: "ollama", id: "alias-a", revision: "1".repeat(64) };
  const catalog = { entry: { name: metadata.id, digest: metadata.revision }, show: { modelfile:
    `FROM /models/sha256-${"2".repeat(64)}\nFROM /models/sha256-${"3".repeat(64)}\nPARAMETER num_ctx 65536\n` } };
  const a = comparisonModelIdentity(metadata, catalog);
  const other = { ...metadata, id: "different-context-alias", revision: "4".repeat(64) };
  const b = comparisonModelIdentity(other, { ...catalog, entry: { name: other.id, digest: other.revision } });
  assert.equal(a.key, b.key); assert.equal(a.weightBlobs.length, 2);
  assert.equal(comparisonModelIdentity(metadata).key, null);
  assert.equal(comparisonModelIdentity(metadata, { ...catalog, show: { modelfile: catalog.show.modelfile + "ADAPTER unknown-location\n" } }).key, null);
  assert.equal(comparisonModelIdentity(other, catalog).key, null);
  assert.equal(comparisonModelIdentity({ provider: "native", id: "codex-declared-model", revision: "declared" }).assurance, "declared_provider_model_revision");
});

test("strict explicit selection rejects secrets, unsafe recurrence and symlinked output overlap before writes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-comparison-authority-")), campaign = path.join(root, "campaign");
  await fs.mkdir(campaign);
  const config = { schemaVersion: 1, datasetDirectory, campaigns: [{ directory: campaign }] };
  assert.equal(ComparisonConfigSchema.safeParse({ ...config, apiKey: "NEVER" }).success, false);
  assert.equal(ComparisonConfigSchema.safeParse({ ...config, campaigns: [{ directory: "relative" }] }).success, false);
  assert.equal(ComparisonConfigSchema.safeParse({ ...config, campaigns: [{ directory: campaign, headers: { cookie: "NEVER" } }] }).success, false);
  const alias = path.join(root, "output-parent-alias"); await fs.symlink(campaign, alias);
  const selection = path.join(root, "config.json"); await fs.writeFile(selection, JSON.stringify(config));
  assert.deepEqual(await readComparisonConfig(selection), config, "OS parent aliases are accepted without accepting input-file links");
  const linkedSelection = path.join(root, "linked-config.json"); await fs.symlink(selection, linkedSelection);
  await assert.rejects(readComparisonConfig(linkedSelection), /explicit_regular_file_required/);
  await assert.rejects(prepareComparisonSelection({ config, outputDirectory: path.join(alias, "report") }), /overlaps_input/);
  await assert.rejects(runPeriodicComparison({ config, outputDirectory: path.join(alias, "periodic"), intervalMs: 1000, occurrences: 2 }), /overlaps_input/);
  await assert.rejects(fs.stat(path.join(campaign, "periodic")), /ENOENT/);
  await assert.rejects(runPeriodicComparison({ config, outputDirectory: path.join(root, "no-plan"), intervalMs: 0, occurrences: 2 }), /bounded_periodic_plan/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runPeriodicComparison({ config, outputDirectory: path.join(root, "already-aborted"), intervalMs: 1000, occurrences: 2, signal: controller.signal }), /stopped_before_start/);
  await assert.rejects(fs.stat(path.join(root, "already-aborted")), /ENOENT/);
});

test("actual HTTP fixtures retain full failures; periodic selection refreshes without inference and abort prevents a third cycle", { timeout: 150_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-comparison-http-"));
  const token = "synthetic-comparison-host-token", secret = "COMPARISON-FIXTURE-CREDENTIAL-MUST-NEVER-BE-ARCHIVED";
  const invalid = "invalid-json:" + "全量𠮷".repeat(12000) + "EXACT-FAILED-OUTPUT-END";
  let calls = 0;
  const server = createAgentServer({ host: "127.0.0.1", port: 0, authToken: token, allowedOrigins: [], runtimeDefinitions: [],
    identityDirectory: path.join(root, "accounts"), runsDirectory: path.join(root, "runs"), understandingDirectory: path.join(root, "understanding"),
    checkpointer: new MemorySaver() as never, careerTaskReasoner: async runtime => async prompt => {
      calls++;
      const state = JSON.parse(prompt.split("\n\n").at(-1)!), material = JSON.parse(state.conversation.messages[0].content).material;
      if (runtime.kind === "model" && runtime.modelSettings.model === "fixture-a" && material.caseId === "gold-data-engineer") return { text: invalid, finishReason: "stop" };
      const required = state.currentWorkInventory.requiredGroups.map((g: { id: string }) => g.id);
      const ids = required.length ? required : [material.candidate.groups[0].id];
      const bullets = ids.map((id: string, i: number) => {
        const e = material.candidate.evidence.find((e: { groupId: string; kind: string }) => e.groupId === id && !e.kind.endsWith("list"));
        return { id: `bullet-${i}`, text: e.text, evidenceIds: [e.id] };
      });
      return { text: JSON.stringify({ schemaVersion: 2, caseId: material.caseId, bullets, questions: ["Missing facts require confirmation."] }), finishReason: "stop" };
    } });
  await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`, account = await registerTestIdentity(baseUrl, token, "comparison-fixture");
  const selections = [];
  try {
    for (const name of ["fixture-a", "fixture-b"]) {
      const runtime = { kind: "model" as const, modelSettings: { provider: "ollama" as const, model: name,
        baseUrl: "http://127.0.0.1:11434/v1", apiKey: secret } };
      const runtimeBinding = careerRuntimeBinding(runtime), directory = path.join(root, name);
      const collected = await collectBenchmark({ datasetDirectory, caseIds: cases, campaignId: name,
        ownerId: account.principal.id, recordDirectory: path.join(root, "accounts", "owners", account.principal.id, "career-tasks-v1"),
        metadata: { execution: "scripted_fixture", provider: "fixture", id: name, revision: "test-only", runtimeId: runtimeBinding.id },
        runtimeBinding, runtime, budget: { maxModelCalls: 1, maxToolCalls: 1, maxActiveMs: 60_000 }, outputDirectory: directory,
        baseUrl, headers: { ...account.headers, Authorization: `Bearer ${token}` }, pollMs: 5, observationMs: 5000 });
      assert.equal(collected.frozen, name === "fixture-a" ? 4 : 5); assert.equal(collected.failed, name === "fixture-a" ? 1 : 0);
      selections.push({ directory });
    }
  } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
  assert.equal(calls, 10);
  const config = { schemaVersion: 1, datasetDirectory, campaigns: selections }, out = path.join(root, "comparison");
  const original = await Promise.all(selections.map(async s => digest(await fs.readFile(path.join(s.directory, "summary.json")))));
  const result = await reviewCampaignComparison({ config, outputDirectory: out });
  assert.equal(result.modelRequests, 0); assert.equal(result.deliveryComparable, false); assert.equal(result.distinctRealModels, 0);
  assert.equal(result.campaigns.length, 2); assert.equal(result.campaigns[0].planned, 5); assert.equal(result.campaigns[0].measuredRealCases, 4);
  const failed = result.campaigns[0].results.find((r: { outcome: string }) => r.outcome === "failure");
  assert.equal(failed.metrics, null); assert.equal(failed.observed.modelCalls, 1);
  let fullFailureFound = false;
  for (const file of result.files) {
    const content = await fs.readFile(path.join(out, file.path));
    assert.equal(content.length, file.bytes); assert.equal(digest(content), file.sha256);
    assert.equal(content.includes(Buffer.from(secret)), false);
    if (content.includes(Buffer.from(invalid))) fullFailureFound = true;
  }
  assert.equal(fullFailureFound, true, "the complete failed raw output is retained, not a summary or prefix");
  assert.match(await fs.readFile(path.join(out, "report.md"), "utf8"), /scripted_fixture/);
  assert.match(await fs.readFile(path.join(out, "report.md"), "utf8"), /失败\/未决各项为null/);
  assert.deepEqual(await Promise.all(selections.map(async s => digest(await fs.readFile(path.join(s.directory, "summary.json"))))), original);
  await assert.rejects(reviewCampaignComparison({ config, outputDirectory: out }), /EEXIST/);
  await assert.rejects(reviewCampaignComparison({ config: { ...config, campaigns: [selections[0], selections[0]] }, outputDirectory: path.join(root, "duplicate") }), /duplicate_comparison_campaign/);
  await assert.rejects(fs.stat(path.join(root, "duplicate")), /ENOENT/);
  const controller = new AbortController();
  const periodicDirectory = path.join(root, "periodic"), selectionFile = path.join(root, "explicit-selection.json");
  await fs.writeFile(selectionFile, JSON.stringify({ ...config, campaigns: [selections[0]] }));
  const periodic = await runPeriodicComparison({ selectionFile, outputDirectory: periodicDirectory,
    intervalMs: 1000, occurrences: 3, signal: controller.signal,
    onProgress: async (event: { stage: string; cycle: number }) => {
      if (event.stage === "cycle_completed" && event.cycle === 1) await fs.writeFile(selectionFile, JSON.stringify({ ...config, campaigns: [selections[1]] }));
      if (event.stage === "cycle_completed" && event.cycle === 2) controller.abort();
    } });
  assert.equal(periodic.completed, 2); assert.equal(periodic.stopped, true); assert.equal(periodic.modelRequests, 0);
  assert.equal(periodic.cycles[0].previousReportSha256, null);
  assert.equal(periodic.cycles[0].reportSha256, digest(await fs.readFile(path.join(periodicDirectory, "cycle-0001/comparison.json"))));
  assert.equal(periodic.cycles[1].previousReportSha256, periodic.cycles[0].reportSha256);
  assert.notEqual(periodic.cycles[1].selectionSha256, periodic.cycles[0].selectionSha256);
  const next = JSON.parse(await fs.readFile(path.join(periodicDirectory, "cycle-0002/comparison.json"), "utf8"));
  assert.equal(next.campaigns[0].frozen, 5); assert.equal(next.campaigns[0].metadata.id, "fixture-b");
  await assert.rejects(fs.stat(path.join(periodicDirectory, "cycle-0003")), /ENOENT/);
  assert.equal(calls, 10, "offline comparison/periodic output must never dispatch inference");
  const tampered = path.join(root, "tampered-campaign"); await fs.cp(selections[0].directory, tampered, { recursive: true });
  await assert.rejects(reviewCampaignComparison({ config: { ...config, campaigns: [selections[0], { directory: tampered }] }, outputDirectory: path.join(root, "duplicate-copy") }), /duplicate_comparison_campaign/);
  const summaryFile = path.join(tampered, "summary.json"), summary = JSON.parse(await fs.readFile(summaryFile, "utf8"));
  summary.results[0].observed.modelCalls++;
  await fs.writeFile(summaryFile, JSON.stringify(summary));
  await fs.writeFile(path.join(tampered, summary.results[0].caseId, "result.json"), JSON.stringify(summary.results[0]));
  await assert.rejects(reviewCampaignComparison({ config: { ...config, campaigns: [{ directory: tampered }] }, outputDirectory: path.join(root, "tampered-report") }), /collection_observed_ledger_changed/);
  await assert.rejects(fs.stat(path.join(root, "tampered-report")), /ENOENT/);
});
