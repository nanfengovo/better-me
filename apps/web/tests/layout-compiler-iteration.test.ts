import assert from "node:assert/strict";
import test from "node:test";
import {
  checkTextProtection, compileLayoutProposals, layoutCandidateFingerprint, REQUIRED_SEMANTIC_CHECKS,
  type LayoutCandidate, type LayoutCompilerAdapters, type LayoutInput, type LayoutMeasurement,
  type LayoutScope, type LayoutSemanticVerdict, type MeasuredLayout,
} from "../src/lib/layout-compiler/index";

const scope: LayoutScope = { ownerId: "synthetic-owner", sessionGeneration: 1, documentId: "synthetic-resume", revision: "1", contentHash: "synthetic-content" };
const input: LayoutInput = { scope, texts: [{ anchor: "claim:synthetic", text: "构建可靠服务并保持可观测性。" }] };
const page = { widthMm: 100 * 25.4 / 96, heightMm: 100 * 25.4 / 96, marginMm: { top: 0, right: 0, bottom: 0, left: 0 } };
function geometry(clean = false): MeasuredLayout {
  return { status: "measured", scope: { ...scope }, source: "dom-estimate", page, measuredAt: "2026-11-09T00:00:00Z", pageCount: 1, limitations: ["synthetic geometry fixture, not a real browser"], blocks: [
    { id: "synthetic", anchor: "claim:synthetic", kind: "claim", order: 0, text: input.texts[0]!.text,
      rect: { x: 0, y: clean ? 80 : 10, width: 90, height: clean ? 10 : 20 }, lines: clean
        ? [{ rect: { x: 0, y: 80, width: 90, height: 10 }, text: input.texts[0]!.text }]
        : [{ rect: { x: 0, y: 10, width: 90, height: 10 }, text: "构建可靠服务并保持" }, { rect: { x: 0, y: 20, width: 10, height: 10 }, text: "可观测性" }] },
  ] };
}
function candidate(id = "compact"): LayoutCandidate {
  return { id, baseScope: { ...scope }, replacements: [{ anchor: "claim:synthetic", before: input.texts[0]!.text, after: "构建可靠且可观测的服务。" }] };
}
function semantics(proposed: LayoutCandidate, overrides: Partial<LayoutSemanticVerdict> = {}): LayoutSemanticVerdict {
  return { verdict: "equivalent", method: "independent-review", verifierId: "synthetic-independent-verifier", candidateId: proposed.id, candidateFingerprint: layoutCandidateFingerprint(proposed), scope: { ...scope }, checks: REQUIRED_SEMANTIC_CHECKS, detail: "Unit-test fixture; not real semantic evidence", ...overrides };
}
function adapters(overrides: Partial<LayoutCompilerAdapters> = {}): LayoutCompilerAdapters {
  const render = overrides.render ?? (async proposed => geometry(proposed.id !== "layout-baseline"));
  return { rewrite: async () => [candidate()], verifySemantics: async ({ candidate: proposed }) => semantics(proposed), getCurrentScope: () => scope, ...overrides,
    render: async (proposed, signal, binding) => {
      const result = await render(proposed, signal, binding);
      return result.status === "measured" && !result.renderBinding ? { ...result, renderBinding: { ...binding } } : result;
    } };
}

test("a measured improvement remains a version-bound, explicit confirmation proposal", async () => {
  const original = JSON.stringify(input);
  const result = await compileLayoutProposals(input, adapters());
  assert.equal(result.status, "proposed");
  assert.equal(result.requiresConfirmation, true);
  assert.equal(result.proposal?.requiresConfirmation, true);
  assert.equal(result.proposal?.needsSeparateFinalFileChecks, true);
  assert.equal(result.proposal?.report.finalFileCheck, "not-performed");
  assert.equal(result.renderedCandidates, 2);
  assert.equal(JSON.stringify(input), original);
});

test("an already-clean DOM report does not call a rewriting model or claim final-file acceptance", async () => {
  const result = await compileLayoutProposals(input, adapters({ render: async () => geometry(true), rewrite: async () => { throw new Error("must not rewrite"); } }));
  assert.equal(result.status, "unchanged");
  assert.equal(result.proposal, undefined);
  assert.equal(result.renderedCandidates, 1);
  assert.match(result.reason, /final-file/);
});

test("wording without an independent verifier, self-review and incomplete checks are not rendered", async () => {
  for (const verifier of [undefined,
    async ({ candidate: proposed }: { candidate: LayoutCandidate }) => semantics(proposed, { method: "model-self-review" }),
    async ({ candidate: proposed }: { candidate: LayoutCandidate }) => semantics(proposed, { checks: ["meaning"] }),
    async ({ candidate: proposed }: { candidate: LayoutCandidate }) => semantics(proposed, { verdict: "unknown" }),
  ]) {
    const result = await compileLayoutProposals(input, adapters({ verifySemantics: verifier }), { maxIterations: 1 });
    assert.equal(result.status, "nonconvergent");
    assert.equal(result.renderedCandidates, 1);
    assert.equal(result.proposal, undefined);
    assert.equal(result.events.some(event => event.kind === "rejected"), true);
  }
});

test("numbers, units, entities, negation, qualifiers, attribution and citations are protected in both directions", () => {
  const before = "本人仅参与 SQLite 优化，未主导；约 10ms，预算 3万元，见 [证据](https://synthetic.invalid/evidence)。";
  const inventory = [{ text: "SQLite", kind: "entity" as const }];
  for (const after of [before.replace("10ms", "8ms"), before.replace("3万元", "3万欧元"), before.replace("SQLite", "Redis"),
    before.replace("未主导", "主导"), before.replace("约 ", ""), before.replace("参与", "主导"),
    before.replace("https://synthetic.invalid/evidence", "https://synthetic.invalid/other"), `${before} 提升 30%。`]) {
    assert.equal(checkTextProtection(before, after, inventory).accepted, false, after);
  }
  assert.equal(checkTextProtection(before, before, inventory).accepted, true);
});

test("same token counts cannot move a negation or ownership to a different protected entity", () => {
  const inventory = [{ text: "项目甲", kind: "entity" as const }, { text: "项目乙", kind: "entity" as const }];
  const result = checkTextProtection("未主导项目甲，仅参与项目乙", "主导项目甲，未仅参与项目乙", inventory);
  assert.equal(result.accepted, false);
  assert.equal(result.violations.some(violation => violation.kind === "ordering"), true);
});

test("a generator cannot override lexical protection by returning a positive semantic verdict", async () => {
  const numericInput: LayoutInput = { ...input, texts: [{ anchor: "claim:synthetic", text: "参与实现 10ms 响应。" }] };
  let reviewed = false;
  const proposed: LayoutCandidate = { id: "inflated", baseScope: scope, replacements: [{ anchor: "claim:synthetic", before: numericInput.texts[0]!.text, after: "主导实现 5ms 响应。" }] };
  const result = await compileLayoutProposals(numericInput, adapters({ rewrite: async () => [proposed], verifySemantics: async () => { reviewed = true; return semantics(proposed); } }), { maxIterations: 1 });
  assert.equal(result.renderedCandidates, 1);
  assert.equal(reviewed, false);
  assert.equal(result.proposal, undefined);
});

test("layout-only candidates use readability bounds but need no wording equivalence assertion", async () => {
  const layoutOnly: LayoutCandidate = { id: "spacing", baseScope: scope, replacements: [], parameters: { lineHeight: 1.2, marginMm: 16 } };
  const result = await compileLayoutProposals(input, adapters({ rewrite: async () => [layoutOnly], verifySemantics: undefined }));
  assert.equal(result.status, "proposed");
  assert.equal(result.proposal?.semanticVerdict, undefined);
  const unsafe = await compileLayoutProposals(input, adapters({ rewrite: async () => [{ ...layoutOnly, parameters: { bodyFontPt: 6 } }] }), { maxIterations: 1 });
  assert.equal(unsafe.proposal, undefined);
  assert.equal(unsafe.renderedCandidates, 1);
});

test("invented anchors, duplicate patches, blank content and a changed base version are rejected", async () => {
  const proposed = candidate();
  const invalid = [
    { ...proposed, replacements: [{ ...proposed.replacements[0]!, anchor: "claim:invented" }] },
    { ...proposed, replacements: [proposed.replacements[0]!, proposed.replacements[0]!] },
    { ...proposed, replacements: [{ ...proposed.replacements[0]!, after: " " }] },
    { ...proposed, baseScope: { ...scope, sessionGeneration: 2 } },
    { ...proposed, replacements: [{ ...proposed.replacements[0]!, before: "not the original" }] },
  ];
  for (const malformed of invalid) {
    const result = await compileLayoutProposals(input, adapters({ rewrite: async () => [malformed] }), { maxIterations: 1 });
    assert.equal(result.proposal, undefined);
    assert.equal(result.renderedCandidates, 1);
  }
});

test("duplicate candidates do not re-render and a hard candidate budget bounds nonconvergence", async () => {
  let rewriteCalls = 0;
  const result = await compileLayoutProposals(input, adapters({ render: async () => geometry(), rewrite: async () => { rewriteCalls++; return [candidate(`same-${rewriteCalls}`)]; } }), { maxIterations: 10, maxTotalCandidates: 3 });
  assert.equal(result.status, "nonconvergent");
  assert.equal(rewriteCalls, 3);
  assert.equal(result.renderedCandidates, 2);
  assert.equal(result.events.filter(event => event.kind === "duplicate").length, 2);
});

test("Adapters receive snapshots, so mutating a rewrite request cannot corrupt the baseline or input", async () => {
  const result = await compileLayoutProposals(input, adapters({ rewrite: async request => {
    (request.input.texts[0] as { text: string }).text = "generator tampering";
    request.report.penalty = -100;
    request.report.issues.splice(0);
    return [candidate()];
  } }));
  assert.equal(result.status, "proposed");
  if (result.baseline?.status === "diagnosed") assert.ok(result.baseline.penalty > 0);
  assert.equal(input.texts[0]?.text, "构建可靠服务并保持可观测性。");
});

test("cancellation interrupts a renderer that ignores AbortSignal and discards its late result", async () => {
  const controller = new AbortController();
  let resolveRender!: (measurement: LayoutMeasurement) => void;
  let adapterSignal!: AbortSignal;
  const pending = compileLayoutProposals(input, adapters({ render: async (_candidate, signal) => { adapterSignal = signal; return new Promise(resolve => { resolveRender = resolve; }); } }), { signal: controller.signal, maxDurationMs: 1000 });
  controller.abort();
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.equal(result.proposal, undefined);
  assert.equal(adapterSignal.aborted, true);
  resolveRender(geometry(true));
  await Promise.resolve();
  assert.equal(result.renderedCandidates, 0);
});

test("owner/session/input changes and a stale renderer binding invalidate proposals", async () => {
  for (const field of ["ownerId", "sessionGeneration", "revision", "contentHash"] as const) {
    let current = scope;
    const result = await compileLayoutProposals(input, adapters({ render: async () => {
      current = { ...scope, [field]: field === "sessionGeneration" ? 2 : "changed" };
      return geometry();
    }, getCurrentScope: () => current }));
    assert.equal(result.status, "stale");
    assert.equal(result.proposal, undefined);
  }
  const result = await compileLayoutProposals(input, adapters({ render: async () => ({ ...geometry(), scope: { ...scope, revision: "old" } }) }));
  assert.equal(result.status, "stale");
});

test("deadline termination is bounded even if a rewriting Adapter never settles", async () => {
  let signal!: AbortSignal;
  const start = Date.now();
  const result = await compileLayoutProposals(input, adapters({ rewrite: async (_request, given) => { signal = given; return new Promise(() => {}); } }), { maxDurationMs: 15 });
  assert.equal(result.status, "nonconvergent");
  assert.match(result.reason, /deadline/);
  assert.equal(signal.aborted, true);
  assert.ok(Date.now() - start < 1000);
});

test("a version switch during a hung continuation invalidates an earlier provisional improvement", async () => {
  let current = scope;
  const result = await compileLayoutProposals(input, adapters({
    render: async proposed => proposed.id === "layout-baseline" ? geometry() : { ...geometry(), blocks: [{ ...geometry().blocks[0]!, lines: [{ rect: { x: 0, y: 50, width: 90, height: 10 }, text: "improved but still too much whitespace" }] }] },
    rewrite: async request => {
      if (request.iteration === 1) return [candidate()];
      current = { ...scope, revision: "2" };
      return new Promise(() => {});
    }, getCurrentScope: () => current,
  }), { maxDurationMs: 20 });
  assert.equal(result.status, "stale");
  assert.equal(result.proposal, undefined);
});

test("candidate render failure does not invent geometry and remaining budget may try another candidate", async () => {
  const result = await compileLayoutProposals(input, adapters({
    rewrite: async () => [{ id: "bad-render", baseScope: scope, replacements: [], parameters: { marginMm: 17 } }, candidate()],
    render: async proposed => { if (proposed.id === "bad-render") throw new Error("synthetic renderer error"); return geometry(proposed.id !== "layout-baseline"); },
  }));
  assert.equal(result.status, "proposed");
  assert.equal(result.events.some(event => event.kind === "unavailable"), true);
});

test("an unavailable baseline stays unavailable and final-file sources cannot silently degrade to DOM estimates", async () => {
  const unavailable = await compileLayoutProposals(input, adapters({ render: async () => ({ status: "unavailable", scope, reason: "hidden", detail: "synthetic hidden sheet", limitations: [] }) }));
  assert.equal(unavailable.status, "unavailable");
  const wrongSource = await compileLayoutProposals(input, adapters(), { requiredSource: "pdf-final" });
  assert.equal(wrongSource.status, "unavailable");
  assert.equal(wrongSource.proposal, undefined);
});

test("geometry and semantic verdicts must bind to the exact candidate payload, not only a reused ID", async () => {
  const wrongGeometry = await compileLayoutProposals(input, adapters({ render: async () => ({ ...geometry(true), renderBinding: { candidateId: "layout-baseline", fingerprint: "old payload" } }) }));
  assert.equal(wrongGeometry.status, "unavailable");
  const wrongVerdict = await compileLayoutProposals(input, adapters({ verifySemantics: async ({ candidate: proposed }) => semantics(proposed, { candidateFingerprint: "old payload" }) }), { maxIterations: 1 });
  assert.equal(wrongVerdict.proposal, undefined);
  assert.equal(wrongVerdict.renderedCandidates, 1);
});

test("final-file body mismatches cannot be accepted merely because page geometry looks clean", async () => {
  const output = geometry(true);
  output.source = "pdf-final";
  output.blocks[0]!.pageNumber = 1;
  output.finalEvidence = { format: "pdf", artifactSha256: "a".repeat(64), inputContentHash: scope.contentHash,
    renderer: { name: "synthetic-renderer", version: "1" }, renderedAt: "2026-11-09T00:00:00Z", pageCount: 1,
    bodyTextCheck: { status: "mismatch", method: "synthetic text check" } };
  const result = await compileLayoutProposals(input, adapters({ render: async () => output }));
  assert.equal(result.status, "unavailable");
  assert.equal(result.proposal, undefined);
});
