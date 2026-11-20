import assert from "node:assert/strict";
import test from "node:test";
import { campaignRuntimeQuality, observedRuntime, runtimeQualityMarkdown } from "./runtime-quality.mjs";

const started = { kind: "started", sequence: 2, at: "2026-11-01T10:00:00.000Z" };
const time = "2026-11-01T10:00:00.120Z";
const full = [
  { caseId: "a", outcome: "frozen" }, { caseId: "b", outcome: "failure" }, { caseId: "c", outcome: "unresolved" },
];

test("frozen delivery includes archived failures and unresolved plans, with separately covered latency, tool outcomes and provider metrics", () => {
  const task = { id: "a", kind: "free_chat", events: [started], status: "awaiting_answer", reply: { createdAt: time },
    usage: { activeMs: 25, modelCalls: 2, toolCalls: 0 } };
  const child = { id: "child", rootTaskId: "a", kind: "resume_tailor", usage: { activeMs: 30, modelCalls: 0, toolCalls: 3 } };
  const a = observedRuntime({ ...task, rootLedger: { rootTaskId: "a", memberCount: 2,
    budget: { maxActiveMs: 2000 }, usage: { activeMs: 55, modelCalls: 2, toolCalls: 3 } } }, [
    { task, recent: [{ kind: "free_chat_output", output: "model text" }] },
    { task: child, recent: [
      { tool: "read_job", result: { revision: "v1" }, evidenceIds: ["ev1"] },
      { tool: "read_resume", result: { error: "unknown_evidence" }, evidenceIds: [] },
    ] },
  ]);
  const b = { ...a, rootId: "b", activeMs: 10, modelCalls: 1, toolCalls: 0, succeeded: 0, failed: 0, taskElapsedMs: null };
  const summary = campaignRuntimeQuality(full, new Map([["a", a], ["b", b]]));
  assert.deepEqual(summary.taskDelivery, { numerator: 1, denominator: 3, percent: 100 / 3, failed: 1, unresolved: 1 });
  assert.deepEqual(summary.userAdoption, { observedDecisions: 0, frozenCandidates: 1, adopted: null, percent: null });
  assert.equal(summary.ledgerCoverage.numerator, 2);
  assert.deepEqual(summary.budget, { activeMs: 65, maxActiveMsForVerifiedRoots: 4000, modelCharges: 3, toolCharges: 3 });
  assert.equal(summary.taskElapsed.medianMs, 120);
  assert.deepEqual(summary.taskElapsed.caseCoverage, { numerator: 1, denominator: 3, percent: 100 / 3 });
  assert.deepEqual(summary.tools.returnedSuccess, { numerator: 1, denominator: 2, percent: 50 });
  assert.equal(summary.tools.chargesWithoutOutcome, 1);
  assert.equal(summary.tools.campaignSuccessPercent, null);
  for (const coverage of [summary.providerUsage.billingCoverage, summary.providerUsage.tokenCoverage, summary.providerUsage.timingCoverage])
    assert.deepEqual(coverage, { numerator: 0, denominator: 3, percent: 0 });
  assert.equal(summary.providerUsage.inputTokens, null);
  assert.equal(summary.providerUsage.billedAmount, null);
  assert.equal(summary.providerUsage.providerLatencyMs, null);
  assert.match(runtimeQualityMarkdown(summary), /结果覆盖 2\/3/);
});

test("mixed tool journals keep legacy results and distinguish new observed, reserved, denied and conflicting calls", () => {
  const usage = { modelCalls: 0, toolCalls: 7, activeMs: 10 };
  const task = { id: "mixed", kind: "resume_tailor", usage, status: "paused", events: [] };
  const rootLedger = { rootTaskId: task.id, memberCount: 1, usage, budget: { maxActiveMs: 1000 } };
  const observed = (call: number, tool: string, result: object = {}) => ({
    call, status: "observed", request: { kind: "tool", tool }, tool, evidenceIds: [], result,
  });
  const recent = [
    { tool: "read_job", result: { revision: "v1" }, evidenceIds: ["legacy-ev"] },
    observed(2, "build_tool", { versionId: "fixture" }),
    observed(3, "read_material", { error: "material_not_granted" }),
    { ...observed(4, "read_file"), status: "reserved" },
    { ...observed(5, "read_resume"), request: { kind: "tool", tool: "read_job" } },
    observed(6, "use_tool", { records: [] }),
    observed(7, "read_job"), observed(7, "read_job", { error: "conflicting" }),
    observed(8, "read_job"),
  ];
  const measured = observedRuntime({ ...task, rootLedger }, [{ task, recent }]);
  const quality = campaignRuntimeQuality([{ caseId: "mixed", outcome: "unresolved" }], new Map([["mixed", measured]]));
  assert.equal(measured.succeeded, 3);
  assert.equal(measured.failed, 1);
  assert.deepEqual(quality.tools.returnedSuccess, { numerator: 3, denominator: 4, percent: 75 });
  assert.equal(quality.tools.chargesWithoutOutcome, 3);
  assert.equal(quality.tools.campaignSuccessPercent, null);
});

test("distinguishes missing archives from fully observed zero tool charges and from a known failed dispatch", () => {
  const unobserved = campaignRuntimeQuality([full[2]], new Map());
  assert.equal(unobserved.budget.modelCharges, null);
  assert.equal(unobserved.budget.activeMs, null);
  assert.equal(unobserved.tools.outcomeCoverageOfCharges.denominator, null);
  assert.equal(unobserved.providerUsage.billingCoverage.denominator, null);
  assert.equal(unobserved.taskElapsed.medianMs, null);
  assert.match(runtimeQualityMarkdown(unobserved), /实付费用凭据覆盖 0\/未知/);
  const usage = { modelCalls: 1, toolCalls: 0, activeMs: 8 };
  const archived = { id: "b", kind: "free_chat", usage, status: "failed", events: [started, { kind: "stopped", sequence: 4, at: time }] };
  const root = { rootTaskId: "b", memberCount: 1, budget: { maxActiveMs: 1000 }, usage };
  const row = observedRuntime({ ...archived, rootLedger: root }, [{ task: archived, recent: [] }]);
  assert.equal(row.taskElapsedMs, 120);
  const zero = campaignRuntimeQuality([full[1]], new Map([["b", row]]));
  assert.deepEqual(zero.tools.returnedSuccess, { numerator: 0, denominator: 0, percent: null });
  assert.equal(zero.tools.campaignSuccessPercent, null);
  assert.equal(zero.budget.toolCharges, 0);
  const bad = { ...row, toolCalls: 1, failed: 1 };
  const observedFailure = campaignRuntimeQuality([full[1]], new Map([["b", bad]]));
  assert.equal(observedFailure.tools.campaignSuccessPercent, 0);
  assert.deepEqual(observedFailure.tools.returnedSuccess, { numerator: 0, denominator: 1, percent: 0 });
  assert.throws(() => campaignRuntimeQuality(full, new Map([["a", row], ["b", row]])), /root_reused/);
  assert.throws(() => observedRuntime({ ...archived, rootLedger: root }, []), /root_members_changed/);
});

test("project dispatch and source verification account for their actual per-call outcomes and provider receipts", () => {
  const usage={modelCalls:2,toolCalls:5,activeMs:100};
  const task={id:"project",kind:"project_understanding",status:"awaiting_review",events:[started],usage,
    rootLedger:{rootTaskId:"project",memberCount:1,budget:{maxActiveMs:1000},usage}};
  const check={kind:"project_verification_result",check:"selected_quote",grantId:"g",path:"a.md",hash:"sha",result:{verified:true}};
  const output={kind:"project_understanding_output",turn:1,output:"{}",providerCallOrdinal:1,providerObservation:{wallMs:80,inputTokens:20,outputTokens:30}};
  const recent=[{call:1,operation:"read",request:{operation:"read"},evidenceIds:["ev"],result:{truncated:false}},
    {...check,call:2}, {...check,call:3,result:{error:{code:"source_changed_new_comparison_required"}}},
    {...check,call:4}, {...check,call:4}, output, { ...output, providerCallOrdinal:2, providerObservation:{wallMs:20,inputTokens:10,outputTokens:4}}];
  const record=observedRuntime(task,[{task,recent}],"model");
  assert.equal(record.succeeded,2);
  assert.equal(record.failed,1);
  const report=campaignRuntimeQuality([{caseId:"project",outcome:"frozen"}],new Map([["project",record]]));
  assert.equal(report.tools.chargesWithoutOutcome,2);
  assert.deepEqual(report.providerUsage.tokenCoverage,{numerator:2,denominator:2,percent:100});
  assert.deepEqual(report.providerUsage.pairedTokens,{inputTokens:30,outputTokens:34});
  assert.equal(report.providerUsage.billedAmount,null);
});

test("counts verified Host provider returns once per member and call, preserving one-sided token counters, zeros, late outputs and missing failures", () => {
  const artifact = { id: "distinct-output", hash: "captured-hash", bytes: 130000 };
  const main = { id: "a", kind: "free_chat", usage: { modelCalls: 5, toolCalls: 0, activeMs: 100 },
    outputArtifacts: [artifact], status: "failed", events: [started, { kind: "stopped", sequence: 3, at: time }] };
  const child = { id: "b", rootTaskId: "a", kind: "resume_tailor", usage: { modelCalls: 1, toolCalls: 0, activeMs: 12 } };
  const task = { ...main, rootLedger: { rootTaskId: "a", memberCount: 2,
    usage: { modelCalls: 6, toolCalls: 0, activeMs: 112 }, budget: { maxActiveMs: 1000 } } };
  const pair = { kind: "free_chat_output", turn: 1, output: "returned", providerCallOrdinal: 1, providerObservation: { wallMs: 0, inputTokens: 0, outputTokens: 8 } };
  const records = [{ task: main, recent: [pair, { ...pair },
    { kind: "free_chat_output_artifact", turn: 1, artifact, providerCallOrdinal: 2, providerObservation: { wallMs: 20, outputTokens: 0 } },
    { ...pair, providerCallOrdinal: 3, providerObservation: { wallMs: 8 } },
    { ...pair, providerCallOrdinal: 4, providerObservation: { wallMs: 2, inputTokens: 2 } },
    { ...pair, providerCallOrdinal: 4, providerObservation: { wallMs: 3, inputTokens: 4 } },
    { kind: "free_chat_rejected", providerCallOrdinal: 5, providerObservation: { wallMs: 9, inputTokens: 40 } },
    { kind: "free_chat_output", turn: 1, output: JSON.stringify(pair), providerCallOrdinal: 5 },
    { ...pair, providerCallOrdinal: 6 },
  ] }, { task: child, recent: [
    { writingPhase: "resume_text_draft", output: "late", runGeneration: 1, late: true,
      providerCallOrdinal: 1, providerObservation: { wallMs: 9, inputTokens: 12 } },
  ] }];
  const plan = full[1];
  const summarize = (execution: string) => campaignRuntimeQuality([plan], new Map([[plan.caseId, observedRuntime(task, records, execution)]])).providerUsage;
  const usage = summarize("model");
  assert.equal(usage.inputTokens, 12);
  assert.equal(usage.outputTokens, 8);
  assert.deepEqual(usage.pairedTokens, { inputTokens: 0, outputTokens: 8 });
  assert.deepEqual(usage.tokenCoverage, { numerator: 1, denominator: 6, percent: 100 / 6 });
  assert.equal(usage.inputTokenCoverage.numerator, 2);
  assert.equal(usage.outputTokenCoverage.numerator, 2);
  assert.equal(usage.timingCoverage.numerator, 4);
  assert.deepEqual(usage.hostWaitMs, { observedSum: 37, median: 8.5, maximum: 20 });
  assert.equal(usage.chargesWithoutProviderObservation, 2);
  assert.equal(usage.billedAmount, null);
  const offline = summarize("scripted_fixture");
  assert.equal(offline.tokenCoverage.numerator, 0);
  assert.equal(offline.timingCoverage.numerator, 0);
  assert.equal(offline.inputTokens, null);
});
