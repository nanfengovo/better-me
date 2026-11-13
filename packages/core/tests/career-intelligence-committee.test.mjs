import assert from "node:assert/strict";
import test from "node:test";
import { createCareerIntelligenceGoldenFixtures, runCareerIntelligenceGoldenFixture, scriptedGoldenReasoner } from "../../../evals/career-intelligence/fixtures.ts";
import { createCommitteeSnapshot, hashCommitteeText, committeeFingerprint, committeeDecisionJsonSchema } from "../src/career-intelligence/contracts.ts";
import { adjudicateClaim, committeeNumericTokens, validateCommitteeCitation, validateCommitteeSnapshot } from "../src/career-intelligence/claims.ts";
import { runHiringCommittee, isCommitteeReportCurrent } from "../src/career-intelligence/committee.ts";
import { judgeCommitteeGoldenCase, runGoldenEvals } from "../src/career-intelligence/evals.ts";

const fixtures = await createCareerIntelligenceGoldenFixtures();
const fixture = (id) => { const item = fixtures.find(candidate => candidate.id === id); assert.ok(item); return item; };

test("36 independent Golden fixtures cover semantic claims and protocol/permission faults", async () => {
  assert.ok(fixtures.length >= 20);
  assert.equal(new Set(fixtures.map(item => item.id)).size, fixtures.length);
  const summary = await runGoldenEvals(fixtures, { adapterId: "scripted-protocol-regression", run: runCareerIntelligenceGoldenFixture });
  const failed = summary.cases.filter(item => !item.passed);
  assert.deepEqual(failed, [], JSON.stringify(failed, null, 2));
  assert.equal(summary.metrics.expectationPassRate, 1);
  assert.equal(summary.metrics.faithfulness, 1);
  assert.equal(summary.metrics.citationPrecision, 1);
  assert.ok(summary.metrics.incompleteRate > 0, "expected adverse cases remain incomplete, not fabricated successes");
  assert.ok(summary.metrics.toolSteps.total > 0);
  assert.ok(summary.metrics.modelCalls > 0);
  assert.match(summary.limitations.join(" "), /not real-model semantic accuracy/);
});

test("independent first rounds have no peer leakage; cross reviews and final verdict are bounded", async () => {
  const selected = fixture("source-with-explicit-contribution");
  const adapter = scriptedGoldenReasoner(selected);
  const requests = [];
  const report = await runHiringCommittee(selected.snapshot, {
    isCurrent: () => true, reasoner: async (request, signal) => { requests.push(request); return adapter(request, signal); },
  });
  assert.equal(report.status, "completed");
  assert.equal(report.roles.length, 7);
  assert.deepEqual(report.roles.slice(0, 4).map(role => [role.role, role.stage]), [
    ["recruiter", "independent"], ["red_team", "independent"], ["advocate", "independent"], ["adjudicator", "independent"],
  ]);
  for (const request of requests.filter(item => item.stage === "independent"))
    assert.equal(JSON.parse(request.prompt.match(/^PEER_FINDINGS=(.*)$/m)[1]).length, 0);
  for (const request of requests.filter(item => item.stage === "cross_review")) {
    const peers = JSON.parse(request.prompt.match(/^PEER_FINDINGS=(.*)$/m)[1]);
    assert.equal(peers.length, 1);
    assert.equal(peers[0].role, request.role === "red_team" ? "advocate" : "red_team");
  }
  assert.equal(report.usage.modelCalls, 14);
  assert.equal(report.usage.toolCalls, 7);
});

test("source sidecar binds claim/version/support/provenance without mutating a Fact or input", async () => {
  const selected = fixture("source-with-explicit-contribution");
  const before = structuredClone(selected.snapshot);
  const report = await runCareerIntelligenceGoldenFixture(selected);
  assert.deepEqual(selected.snapshot, before);
  const claim = report.claims[0];
  assert.equal(claim.claimHash, selected.snapshot.claims[0].hash);
  assert.equal(claim.snapshotFingerprint, selected.snapshot.fingerprint);
  assert.equal(claim.support, "supported");
  assert.equal(claim.contribution, "implementation");
  assert.deepEqual(claim.provenance, ["source"]);
  assert.ok(!("verified" in claim));
  assert.match(claim.limitations.join(" "), /not a Fact promotion/);
});

test("a safe extractive proposal remains pending human review, never a saved change", async () => {
  const report = await runCareerIntelligenceGoldenFixture(fixture("extractive-safe-rewrite"));
  assert.equal(report.claims[0].rewriteProposal.status, "pending_review");
  assert.equal(report.claims[0].rewriteProposal.proposedText, "实现本机单写者租约。");
  assert.ok(!("receipt" in report));
});

test("explicit self-confirmation and measured verification remain distinct", async () => {
  const self = await runCareerIntelligenceGoldenFixture(fixture("confirmed-self-reported-number"));
  const measured = await runCareerIntelligenceGoldenFixture(fixture("matching-measurement-receipt"));
  assert.equal(self.claims[0].support, "supported");
  assert.match(self.claims[0].limitations.join(" "), /self-reported/);
  assert.deepEqual(measured.claims[0].provenance, ["assessment"]);
  const altered = structuredClone(fixture("matching-measurement-receipt"));
  altered.snapshot.evidence[0].measurement.claimIds = ["another-claim"];
  const { fingerprint: _old, ...unsigned } = altered.snapshot;
  altered.snapshot.fingerprint = await committeeFingerprint(unsigned);
  const result = await runCareerIntelligenceGoldenFixture(altered);
  assert.equal(result.claims[0].support, "partial");
  assert.ok(result.issues.some(issue => issue.code === "unsupported_number"));
});

test("hash, version and session revalidation is required before presenting adoption", async () => {
  const selected = fixture("source-with-explicit-contribution");
  const report = await runCareerIntelligenceGoldenFixture(selected);
  assert.equal(await isCommitteeReportCurrent(report, selected.snapshot, () => true), true);
  assert.equal(await isCommitteeReportCurrent(report, selected.snapshot, () => false), false);
  const changed = structuredClone(selected.snapshot);
  changed.claims[0].text += "新增语句。";
  await assert.rejects(validateCommitteeSnapshot(changed), /snapshot_fingerprint_changed/);
  assert.equal(await isCommitteeReportCurrent(report, changed, () => true), false);
  const { fingerprint: _old, ...unsigned } = changed;
  changed.fingerprint = await committeeFingerprint(unsigned);
  await assert.rejects(validateCommitteeSnapshot(changed), /claim_hash_changed/);
  const nextRevision = structuredClone(selected.snapshot);
  nextRevision.binding.resumeRevision = "resume-v2";
  const { fingerprint: _previous, ...updated } = nextRevision;
  nextRevision.fingerprint = await committeeFingerprint(updated);
  assert.equal(await isCommitteeReportCurrent(report, nextRevision, () => true), false);
});

test("citations check source version, excerpt version, exact line range and verbatim quote", async () => {
  const snapshot = fixture("source-with-explicit-contribution").snapshot;
  const evidence = snapshot.evidence[0];
  const citation = { evidenceId: evidence.id, sourceHash: evidence.sourceHash, excerptHash: evidence.excerptHash,
    startLine: evidence.startLine, endLine: evidence.endLine, quote: evidence.excerpt };
  const reads = [{ evidenceId: evidence.id, startLine: evidence.startLine, endLine: evidence.endLine }];
  assert.equal(validateCommitteeCitation(citation, snapshot, reads), undefined);
  assert.equal(validateCommitteeCitation({ ...citation, sourceHash: "f".repeat(64) }, snapshot, reads).code, "invalid_citation");
  assert.equal(validateCommitteeCitation({ ...citation, quote: "invented quote" }, snapshot, reads).code, "invalid_citation");
  assert.equal(validateCommitteeCitation(citation, snapshot, []).code, "unread_evidence");
  assert.equal(validateCommitteeCitation({ ...citation, evidenceId: "unknown" }, snapshot, reads).code, "evidence_not_granted");
});

test("uncooperative model adapter is bounded by deadline and late results cannot be accepted", async () => {
  const selected = fixture("source-with-explicit-contribution");
  const report = await runHiringCommittee(selected.snapshot, {
    isCurrent: () => true, budget: { maxDurationMs: 20 }, reasoner: () => new Promise(() => {}),
  });
  assert.equal(report.status, "budget_exhausted");
  assert.equal(report.stopReason, "duration_budget_exhausted");
  assert.equal(report.usage.modelCalls, 1);
  assert.equal(report.claims[0].support, "unknown");
});

test("uncooperative identity/source validator is also bounded before any model dispatch", async () => {
  const selected = fixture("source-with-explicit-contribution");
  const report = await runHiringCommittee(selected.snapshot, {
    isCurrent: () => new Promise(() => {}), budget: { maxDurationMs: 20 }, reasoner: async () => { throw new Error("must not dispatch"); },
  });
  assert.equal(report.status, "budget_exhausted");
  assert.equal(report.usage.modelCalls, 0);
});

test("external cancellation before dispatch makes zero model/tool calls", async () => {
  const selected = fixture("source-with-explicit-contribution");
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const report = await runHiringCommittee(selected.snapshot, {
    isCurrent: () => true, signal: controller.signal, reasoner: async () => { calls++; throw new Error("must not run"); },
  });
  assert.equal(report.status, "cancelled");
  assert.equal(calls, 0);
  assert.equal(report.usage.toolCalls, 0);
});

test("adapter failures preserve partial reviews without leaking provider error text", async () => {
  const selected = fixture("source-with-explicit-contribution");
  const report = await runHiringCommittee(selected.snapshot, { isCurrent: () => true,
    reasoner: async () => { throw new Error("secret-provider-diagnostic-must-not-be-returned"); },
  });
  assert.equal(report.status, "partial");
  assert.equal(report.roles.length, 7);
  assert.ok(report.roles.every(role => role.error === "reasoner_failed"));
  assert.doesNotMatch(JSON.stringify(report), /secret-provider-diagnostic/);
});

test("the Golden judge is independent from generating opinions and reports zero-sample precision as null", async () => {
  const selected = fixture("source-with-explicit-contribution");
  const report = await runCareerIntelligenceGoldenFixture(selected);
  const wrongExpectation = { ...selected, expected: { ...selected.expected, support: "contradicted" } };
  assert.equal(judgeCommitteeGoldenCase(wrongExpectation, report).passed, false);
  const wrongClaim = structuredClone(report); wrongClaim.claims[0].claimId = "a-different-claim";
  assert.equal(judgeCommitteeGoldenCase(selected, wrongClaim).passed, false);
  const wrongQuote = structuredClone(report); wrongQuote.claims[0].citations[0].quote = "Invented independent-judge citation";
  assert.equal(judgeCommitteeGoldenCase(selected, wrongQuote).citations.correct, 0);
  const expired = fixture("expired-grant-zero-dispatch");
  const summary = await runGoldenEvals([expired], { adapterId: "scripted", run: runCareerIntelligenceGoldenFixture });
  assert.equal(summary.metrics.citationPrecision, null);
  await assert.rejects(runGoldenEvals([], { adapterId: "scripted", run: runCareerIntelligenceGoldenFixture }), /nonempty/);
  await assert.rejects(runGoldenEvals([selected, selected], { adapterId: "scripted", run: runCareerIntelligenceGoldenFixture }), /uniquely/);
});

test("numeric tokens preserve units and normalize QPS-prefix notation", () => {
  assert.deepEqual(committeeNumericTokens("QPS 8,000 与8000TPS；降低30%，连续3年。"), ["8000qps", "8000tps", "30%", "3年"]);
  assert.deepEqual(committeeNumericTokens("SQLite3 processed 10000 requests with 42 workers"), ["10000", "42"]);
});

test("an explicit non-deployment qualifier is not an affirmative deployment claim", async () => {
  for (const text of ["实现本机单写者租约，未上线。", "实现本机单写者租约，尚未上线。", "Implemented the lease; not in production."]) {
    const snapshot = structuredClone(fixture("source-with-explicit-contribution").snapshot);
    const claim = { ...snapshot.claims[0], text, hash: await hashCommitteeText(text) };
    const source = snapshot.evidence[0]; source.excerpt = text; source.endLine = source.startLine;
    source.sourceHash = source.excerptHash = await hashCommitteeText(text);
    const citation = { evidenceId: source.id, sourceHash: source.sourceHash, excerptHash: source.excerptHash,
      startLine: source.startLine, endLine: source.endLine, quote: text };
    const outcome = adjudicateClaim(snapshot, claim, { claimId: claim.id, support: "supported", citations: [citation], counterCitations: [], defense: [], risks: [], missing: [], questions: [] },
      [{ evidenceId: source.id, startLine: source.startLine, endLine: source.endLine }]);
    assert.equal(outcome.sidecar.support, "supported", text);
    assert.ok(!outcome.issues.some(issue => issue.code === "design_is_not_implementation"), text);
    const affirmative = { ...claim, text: text + " Subsequently deployed to production." };
    const rejected = adjudicateClaim(snapshot, affirmative, { claimId: claim.id, support: "supported", citations: [citation], counterCitations: [], defense: [], risks: [], missing: [], questions: [] },
      [{ evidenceId: source.id, startLine: source.startLine, endLine: source.endLine }]);
    assert.equal(rejected.sidecar.support, "contradicted", "a separate positive deployment assertion must still be checked");
  }
});

test("snapshot construction checks excerpt range and does not interpret source instructions", async () => {
  const selected = fixture("source-with-explicit-contribution").snapshot;
  const { fingerprint: _fingerprint, schemaVersion: _schemaVersion, ...input } = selected;
  const invalid = { ...input, claims: input.claims.map(({ hash: _hash, ...claim }) => claim),
    evidence: input.evidence.map(({ excerptHash: _hash, ...evidence }) => ({ ...evidence, endLine: evidence.endLine + 1 })) };
  await assert.rejects(createCommitteeSnapshot(invalid), /exact line range/);
  assert.equal((await hashCommitteeText("same")).length, 64);
  assert.equal(await hashCommitteeText("same"), await hashCommitteeText("same"));
});

test("provider JSON schemas constrain exact role, enum, evidence grant and protocol mode without weakening runtime validation", () => {
  const request = committeeDecisionJsonSchema("red_team", ["evidence-1"], "request_evidence");
  assert.equal(request.additionalProperties, false);
  assert.equal(request.properties.kind.const, "request_evidence");
  assert.deepEqual(request.properties.requests.items.properties.evidenceId.enum, ["evidence-1"]);
  const assessment = committeeDecisionJsonSchema("advocate", ["evidence-1"], "assessment");
  assert.equal(assessment.properties.role.const, "advocate");
  assert.deepEqual(assessment.properties.claims.items.properties.support.enum, ["supported", "partial", "contradicted", "unknown"]);
  assert.deepEqual(assessment.properties.claims.items.required, ["claimId", "support", "citations"]);
  assert.equal(committeeDecisionJsonSchema("recruiter", []).anyOf.length, 2);
  assert.throws(() => committeeDecisionJsonSchema("not-a-role", ["evidence-1"]));
});

test("invalid assessment citations receive only bounded correction opportunities and corrected results can complete", async () => {
  const selected = fixture("source-with-explicit-contribution"), adapter = scriptedGoldenReasoner(selected);
  const report = await runHiringCommittee(selected.snapshot, { isCurrent: () => true, reasoner: async (request, signal) => {
    const decision = await adapter(request, signal);
    if (request.turn === 2 && decision.kind === "assessment") decision.claims[0].citations[0].quote = "wrong quote";
    return decision;
  } });
  assert.equal(report.status, "completed");
  assert.equal(report.claims[0].support, "supported");
  assert.equal(report.usage.modelCalls, 21);
  assert.equal(report.usage.toolCalls, 7);
  assert.ok(report.issues.some(issue => issue.code === "invalid_citation"), "rejected attempts remain observable");
  assert.ok(report.roles.every(role => !role.error));
});
