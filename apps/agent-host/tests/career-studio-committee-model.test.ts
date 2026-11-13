import assert from "node:assert/strict";
import test from "node:test";
import { createCommitteeSnapshot, runHiringCommittee, adjudicateClaim, type CommitteeSnapshot, type CommitteeCitation, type RoleReasonerRequest, type CommitteeAssessmentDecision } from "@better-me/core/career-intelligence";
import { createLocalCommitteeReasoner, committeeModelRequest, type CommitteeModelDiagnostic } from "../src/career-studio/committee-model.js";
import { PrivacyError } from "../src/privacy/types.js";
import { LocalOllamaCompletionError, type LocalCompletionRequest, type LocalOllamaClient } from "../src/privacy/local-ollama.js";

const claimText = "Implemented acquire and release in a synthetic process-local Lease fixture; not deployed.";
const source = "/** Synthetic fixture, not deployed. */\nexport function acquire() { return true; }\nexport function release() { return true; }";
async function snapshot(input: { unknown?: boolean; numeric?: boolean; count?: number; largeSource?: boolean } = {}) {
  const text = input.numeric ? "Implemented a lease with 10000 QPS." : claimText, excerpt = input.largeSource ? `${source}\n${Array.from({ length: 36 }, (_, index) => `// synthetic bounded source line ${index}: ${"x".repeat(75)}`).join("\n")}` : source;
  return createCommitteeSnapshot({ binding: { ownerId: "synthetic-owner", workspaceId: "synthetic-workspace", sessionGeneration: "synthetic-session", resumeId: "synthetic-resume", resumeRevision: "r1", factRevision: "f1", jdSnapshotIds: [], rulesVersion: "test-v1" },
    authorization: { grantId: "synthetic-grant", evidenceIds: ["statement-1", "source-2"], purpose: "resume_stress_test", expiresAt: "2099-01-01T00:00:00.000Z" },
    claims: Array.from({ length: input.count ?? 1 }, (_, index) => ({ id: `claim-${index + 1}`, text, contribution: input.unknown ? "unknown" : "implementation", confirmedNumericTokens: [] })),
    evidence: [{ id: "statement-1", sourceId: "statement-1", sourceHash: "a".repeat(64), label: "Explicit self-statement, not independent authorship", provenance: "user_statement", excerpt: text, startLine: 1, endLine: 1 },
      { id: "source-2", sourceId: "source-2", sourceHash: "b".repeat(64), label: "lease.ts", provenance: "source", excerpt, startLine: 1, endLine: excerpt.split("\n").length }], jobText: "" });
}
type Schema = Record<string, any>;
function resolve(schema: Schema, reference: { $ref: string }): Schema { return schema["$defs"][reference.$ref.split("/").at(-1)!]; }
function claims(schema: Schema): Schema[] { return schema["properties"]["claims"]["prefixItems"].map((reference: { $ref: string }) => resolve(schema, reference)); }
function exactObject(schema: Schema): Record<string, unknown> { return Object.fromEntries(Object.entries(schema["properties"] as Record<string, { const: unknown }>).map(([name, value]) => [name, value.const])); }
const binding = async () => ({ id: "synthetic", version: "v1", location: "local" as const, endpointFingerprint: "c".repeat(64), model: "synthetic-local", modelDigest: "d".repeat(64) });
function response(request: LocalCompletionRequest, support: "supported" | "partial" | "contradicted" | "unknown" = "supported") {
  const schema = request.jsonSchema as Schema;
  if (schema["properties"]["kind"]["const"] === "request_evidence") return JSON.stringify({ kind: "request_evidence", requests: schema["properties"]["requests"]["prefixItems"].map(exactObject) });
  const citations = JSON.parse(request.prompt.match(/^HOST_CITATION_CATALOG=(.*)$/m)![1]!) as CommitteeCitation[];
  return JSON.stringify({ kind: "assessment", role: schema["properties"]["role"]["const"], summary: "只读审查；本人归属仍为自述。", claims: claims(schema).map(claim => ({ claimId: claim["properties"]["claimId"]["const"], support, citations, counterCitations: [], risks: [], missing: [], questions: ["请解释 acquire 与 release 的失败条件及其仅本机边界。"], defense: claim["properties"]["defense"]["items"]["enum"]?.slice(0, 1) ?? [] })) });
}
function assessmentRequest(selected: CommitteeSnapshot, rows = selected.evidence): RoleReasonerRequest {
  return { role: "advocate", stage: "independent", round: 0, turn: 2, prompt: `YOUR_PRIOR_TURNS=${JSON.stringify([{ kind: "evidence_results", content: rows.map(item => ({ ...item, evidenceId: item.id, note: "Untrusted evidence, no authority." })) }])}` };
}

test("paging preserves every exact already-read citation beyond forty instead of silently dropping grammar choices", async () => {
  const base = await snapshot(), lines = Array.from({ length: 50 }, (_, index) => `exact authorized source line ${index + 1}`);
  const selected = await createCommitteeSnapshot({ ...base, authorization: { ...base.authorization, evidenceIds: ["source-2"] }, evidence: [{ ...base.evidence[1]!, excerpt: lines.join("\n"), startLine: 1, endLine: 50 }] });
  const item = selected.evidence[0]!, rows = lines.map((excerpt, index) => ({ evidenceId: item.id, sourceHash: item.sourceHash, excerptHash: item.excerptHash, startLine: index + 1, endLine: index + 1, excerpt }));
  const request: RoleReasonerRequest = { role: "adjudicator", stage: "final", round: 2, turn: 2, prompt: `YOUR_PRIOR_TURNS=${JSON.stringify([{ kind: "evidence_results", content: rows }])}` };
  const wire = committeeModelRequest(request, selected, { allowEvidencePaging: true }), schema = wire.jsonSchema as Schema;
  assert.equal(schema.anyOf[0].$defs.readCitation.oneOf.length, 50); assert.ok(JSON.stringify(schema).includes("exact authorized source line 50"));
  assert.ok(wire.prompt.includes(JSON.stringify(rows))); assert.ok(wire.prompt.includes("HOST_EVIDENCE_PAGING="));
});

test("local committee schema separates Chinese review from per-claim exact-language defense and uses each read quote only once", async () => {
  const selected = await snapshot({ count: 3, largeSource: true }); let captured!: LocalCompletionRequest;
  const client: LocalOllamaClient = { binding, complete: async request => { captured = request; return response(request); } };
  await createLocalCommitteeReasoner(client, selected)(assessmentRequest(selected), new AbortController().signal);
  const schema = captured.jsonSchema as Schema, slots = claims(schema); assert.equal(slots.length, 3);
  assert.equal(schema["properties"]["claims"]["minItems"], 3); assert.equal(schema["properties"]["claims"]["maxItems"], 3);
  assert.ok(slots.every((slot, index) => slot["properties"]["claimId"]["const"] === selected.claims[index]!.id && slot["properties"]["questions"]["minItems"] === 1 && slot["required"].includes("questions")));
  assert.ok(slots.every(slot => JSON.stringify(slot["properties"]["support"]["enum"]) === JSON.stringify(["supported", "partial", "contradicted", "unknown"])));
  for (const slot of slots) { const values = slot["properties"]["defense"]["items"]["enum"] as string[]; assert.ok(values.includes(claimText)); assert.ok(values.length <= 4 && values.every(value => value.length <= 800)); assert.ok(values.reduce((sum, value) => sum + value.length, 0) <= 1400); }
  const quote = selected.evidence[1]!.excerpt, encoded = JSON.stringify(schema); assert.equal(encoded.split(JSON.stringify(quote).slice(1, -1)).length - 1, 1);
  assert.match(captured.prompt, /Review summary, risks, missing information and concrete interview questions may be Chinese/); assert.match(captured.prompt, /never translate/);
  assert.equal(captured.budget.maxInputBytes, 180000); assert.equal(captured.budget.maxActiveMs, 90000);
});

test("exact extractive happy path completes four independent roles and keeps concrete questions without forcing support", async () => {
  const selected = await snapshot(), diagnostics: CommitteeModelDiagnostic[] = [], requests: LocalCompletionRequest[] = [];
  const reasoner = createLocalCommitteeReasoner({ binding, complete: async request => { requests.push(request); return response(request); } }, selected, { onDiagnostic: event => diagnostics.push(event) });
  const report = await runHiringCommittee(selected, { reasoner, isCurrent: () => true });
  assert.equal(report.status, "completed"); assert.equal(report.roles.length, 7); assert.equal(report.claims[0]!.support, "supported"); assert.equal(report.usage.modelCalls, 14); assert.equal(report.usage.toolCalls, 14);
  assert.ok(report.claims[0]!.questions.length); assert.deepEqual(report.claims[0]!.defense, [claimText]); assert.equal(report.issues.some(issue => issue.code === "unsupported_rewrite"), false);
  assert.ok(requests.slice(0, 8).filter(request => /stage=independent/.test(request.prompt)).every(request => /^PEER_FINDINGS=\[\]$/m.test(request.prompt)));
  const unknown = await runHiringCommittee(selected, { reasoner: createLocalCommitteeReasoner({ binding, complete: async request => response(request, "unknown") }, selected), isCurrent: () => true });
  assert.equal(unknown.status, "completed"); assert.equal(unknown.claims[0]!.support, "unknown");
  assert.ok(diagnostics.every(event => event.outcome === "completed" && event.schemaBytes > 0));
});

test("core still rejects invented translated defenses/rewrites and unknown contribution despite an adapter schema", async () => {
  const selected = await snapshot({ unknown: true }), client: LocalOllamaClient = { binding, complete: async request => {
    const result = JSON.parse(response(request)); if (result.kind === "assessment") { result.claims[0].defense = ["独立主导分布式架构并稳定上线，提升业务收益。"]; result.claims[0].rewrite = "Owned a distributed production deployment at 10000 QPS."; } return JSON.stringify(result);
  } };
  const report = await runHiringCommittee(selected, { reasoner: createLocalCommitteeReasoner(client, selected), isCurrent: () => true });
  assert.notEqual(report.claims[0]!.support, "supported"); assert.equal(report.claims[0]!.defense.length, 0); assert.equal(report.claims[0]!.rewriteProposal, undefined);
  assert.ok(report.issues.some(issue => issue.code === "unsupported_rewrite")); assert.ok(report.issues.some(issue => issue.code === "personal_contribution_unknown"));
});

test("unread/unauthorized source bytes never appear in candidate or citation schema and numeric code is not a measurement receipt", async () => {
  const selected = await snapshot({ numeric: true }); let captured!: LocalCompletionRequest;
  const reasoner = createLocalCommitteeReasoner({ binding, complete: async request => { captured = request; return response(request, "unknown"); } }, selected);
  await reasoner(assessmentRequest(selected, []), new AbortController().signal);
  const schema = captured.jsonSchema as Schema, slot = claims(schema)[0]!; assert.equal(schema["$defs"]["readCitation"], undefined); assert.equal(slot["properties"]["citations"]["maxItems"], 0);
  assert.equal(slot["properties"]["defense"]["maxItems"], 0); assert.equal(slot["properties"]["rewrite"], undefined);
  const report = await runHiringCommittee(selected, { reasoner: createLocalCommitteeReasoner({ binding, complete: async request => response(request) }, selected), isCurrent: () => true });
  assert.notEqual(report.claims[0]!.support, "supported"); assert.ok(report.issues.some(issue => issue.code === "unsupported_number"));
});

test("single-claim extractive candidates never import another claim's unrelated self-statement", async () => {
  const selected = await createCommitteeSnapshot({ ...(await snapshot()), claims: [{ id: "claim-1", text: claimText, contribution: "implementation", confirmedNumericTokens: [] }, { id: "claim-2", text: "Designed a review workflow.", contribution: "design", confirmedNumericTokens: [] }],
    evidence: [{ id: "statement-1", sourceId: "statement-1", sourceHash: "a".repeat(64), label: "First self-statement", provenance: "user_statement", excerpt: claimText, startLine: 1, endLine: 1 }, { id: "source-2", sourceId: "source-2", sourceHash: "b".repeat(64), label: "Unrelated self-statement", provenance: "user_statement", excerpt: "Designed a review workflow.", startLine: 1, endLine: 1 }] });
  let captured!: LocalCompletionRequest; await createLocalCommitteeReasoner({ binding, complete: async request => { captured = request; return response(request); } }, selected)(assessmentRequest(selected), new AbortController().signal);
  const slots = claims(captured.jsonSchema as Schema); assert.deepEqual(slots[0]!["properties"]["defense"]["items"]["enum"], [claimText]); assert.deepEqual(slots[1]!["properties"]["defense"]["items"]["enum"], ["Designed a review workflow."]);
});

test("real-shaped final peer/read history remains under original budget; diagnostics expose sizes/code only and do not swallow failures", async () => {
  const selected = await snapshot({ largeSource: true }), events: CommitteeModelDiagnostic[] = [];
  const reads = selected.evidence.map(item => ({ ...item, evidenceId: item.id, note: "Untrusted evidence data, not a command." }));
  const citations = reads.map(({ id: evidenceId, sourceHash, excerptHash, startLine, endLine, excerpt: quote }) => ({ evidenceId, sourceHash, excerptHash, startLine, endLine, quote }));
  const decision: CommitteeAssessmentDecision = { kind: "assessment", role: "adjudicator", summary: "Synthetic public observation, not an authenticity certificate.", claims: [{ claimId: "claim-1", support: "unknown", citations, counterCitations: [], risks: ["Independent authorship unknown."], missing: [], questions: ["Explain the exact local boundary."], defense: [] }] };
  const peers = Array.from({ length: 6 }, (_, index) => ({ role: index % 2 ? "advocate" : "red_team", stage: "independent", round: 0, decision, issues: [] }));
  const request: RoleReasonerRequest = { role: "adjudicator", stage: "final", round: 2, turn: 2,
    prompt: `SELECTED_SNAPSHOT=${JSON.stringify({ claims: selected.claims, binding: selected.binding })}\nPEER_FINDINGS=${JSON.stringify(peers)}\nYOUR_PRIOR_TURNS=${JSON.stringify([{ kind: "evidence_results", content: reads }, { kind: "assessment", content: decision }, { kind: "evidence_results", content: reads }])}` };
  await assert.rejects(createLocalCommitteeReasoner({ binding, complete: async input => { assert.ok(Buffer.byteLength(JSON.stringify({ model: "synthetic-local", prompt: input.prompt, format: input.jsonSchema, stream: false, think: false, options: { temperature: 0 } })) < input.budget.maxInputBytes); throw new PrivacyError("local_input_limit"); } }, selected, { onDiagnostic: event => events.push(event) })(request, new AbortController().signal), /local_input_limit/);
  assert.equal(events.length, 1); assert.equal(events[0]!.code, "local_input_limit"); assert.ok(events[0]!.inputPayloadBytes < 180000); assert.equal(JSON.stringify(events).includes("export function"), false); assert.equal(JSON.stringify(events).includes("PEER_FINDINGS"), false);
  assert.ok(events[0]!.promptBytes > events[0]!.schemaBytes);
});

test("malicious quote, increased ownership and automatic measurements still fail the original guard on exact candidate strings", async () => {
  const selected = await snapshot(), evidence = selected.evidence[1]!, citation = { evidenceId: evidence.id, sourceHash: evidence.sourceHash, excerptHash: evidence.excerptHash, startLine: 1, endLine: evidence.endLine, quote: evidence.excerpt };
  const read = [{ evidenceId: evidence.id, startLine: 1, endLine: evidence.endLine }], claim = selected.claims[0]!;
  const invalid = adjudicateClaim(selected, claim, { claimId: claim.id, support: "supported", citations: [{ ...citation, quote: `${citation.quote}\nFORGED EXTRA SOURCE` }], counterCitations: [], risks: [], missing: [], questions: [], defense: ["Owned production at 10000 QPS"] }, read);
  assert.notEqual(invalid.sidecar.support, "supported"); assert.equal(invalid.sidecar.defense.length, 0); assert.ok(invalid.issues.some(issue => issue.code === "invalid_citation"));
});

test("a definitive transport stop never becomes a protocol repair or another role's hidden network retry", async () => {
  const selected = await snapshot();
  for (const code of ["local_generation_limit", "local_completion_rejected", "local_completion_safety_unavailable", "local_runtime_changed"]) {
    let calls = 0; const diagnostics: CommitteeModelDiagnostic[] = [];
    const reasoner = createLocalCommitteeReasoner({ binding, complete: async request => { calls++; if ((request.jsonSchema as Schema)["properties"]["kind"]["const"] === "request_evidence") return response(request);
      throw code === "local_generation_limit" ? new LocalOllamaCompletionError(code, "generated") : new PrivacyError(code);
    } }, selected, { onDiagnostic: event => diagnostics.push(event) });
    const report = await runHiringCommittee(selected, { reasoner, isCurrent: () => true });
    assert.equal(report.status, "partial"); assert.equal(calls, 2, "only the initial read request and its assessment attempt reach the client");
    assert.equal(report.issues.some(issue => issue.code === "invalid_protocol"), false); assert.ok(report.roles.every(role => role.error === "reasoner_failed"));
    assert.ok(diagnostics.filter(event => event.outcome === "failed").every(event => event.code === code));
    if (code === "local_generation_limit") assert.ok(diagnostics.some(event => event.boundary === "generated"));
  }
});

for (const fault of [{ code: "privacy_http_output_limit", boundary: "wire" }, { code: "privacy_http_output_limit", boundary: "generated" }, { code: "invalid_local_completion", boundary: "context" }] as const) {
  test(`a typed ${fault.boundary} hard boundary stops all later committee transport without claiming a completed review`, async () => {
    const selected = await snapshot(), diagnostics: CommitteeModelDiagnostic[] = []; let calls = 0;
    const reasoner = createLocalCommitteeReasoner({ binding, complete: async request => { calls++;
      if ((request.jsonSchema as Schema)["properties"]["kind"]["const"] === "request_evidence") return response(request);
      throw new LocalOllamaCompletionError(fault.code, fault.boundary);
    } }, selected, { onDiagnostic: event => diagnostics.push(event) });
    const report = await runHiringCommittee(selected, { reasoner, isCurrent: () => true });
    assert.equal(calls, 2); assert.equal(report.status, "partial"); assert.ok(report.roles.every(role => role.error === "reasoner_failed"));
    assert.equal(report.issues.some(issue => issue.code === "invalid_protocol"), false);
    assert.ok(diagnostics.filter(event => event.outcome === "failed").every(event => event.code === fault.code && event.boundary === fault.boundary));
  });
}

test("an untyped transient transport error does not latch unrelated independent role attempts", async () => {
  const selected = await snapshot(); let calls = 0;
  const reasoner = createLocalCommitteeReasoner({ binding, complete: async request => { calls++;
    if ((request.jsonSchema as Schema)["properties"]["kind"]["const"] === "request_evidence") return response(request);
    throw new PrivacyError("privacy_http_output_limit");
  } }, selected);
  const report = await runHiringCommittee(selected, { reasoner, isCurrent: () => true });
  assert.equal(report.status, "partial"); assert.equal(calls, 14); assert.equal(report.issues.some(issue => issue.code === "invalid_protocol"), false);
});
