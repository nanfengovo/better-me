import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createCareerLayoutModelAdapter, careerLayoutPayloadHash, type CareerLayoutModelRequest, type CareerLayoutModelResponse } from "../src/services/career-layout-model";
import { REQUIRED_SEMANTIC_CHECKS, type LayoutCandidate, type LayoutDiagnosis, type LayoutInput, type LayoutScope } from "../src/lib/layout-compiler";

const scope: LayoutScope = { ownerId: "synthetic-model-owner", sessionGeneration: 1, documentId: "synthetic-document", revision: "1", contentHash: "synthetic-source" };
const runtime = { model: "synthetic-local-model", modelDigest: "synthetic-digest" };
const input: LayoutInput = { scope, texts: [{ anchor: "claim:c1", text: "可靠工程实践" }] };
const candidate: LayoutCandidate = { id: "candidate-1", baseScope: scope, replacements: [{ anchor: "claim:c1", before: "可靠工程实践", after: "可靠性工程实践" }] };
const report: LayoutDiagnosis = { status: "diagnosed", scope, source: "dom-estimate", pages: [], issues: [{ id: "global-page-space", kind: "trailing-whitespace", severity: "notice", pageNumber: 1,
  detail: "Synthetic measured page whitespace", metrics: { ratio: 0.4 } }], penalty: 1, finalFileCheck: "not-performed", limitations: [] };
function response(body: CareerLayoutModelRequest, output: unknown): CareerLayoutModelResponse {
  return { output, contextId: body.contextId, inputHash: createHash("sha256").update(JSON.stringify(body.payload)).digest("hex"), runtime, adopted: false };
}
function adapter(request: (body: CareerLayoutModelRequest, signal: AbortSignal) => Promise<CareerLayoutModelResponse>, getCurrentScope = () => scope) {
  return createCareerLayoutModelAdapter({ contextId: "synthetic-context", scope, runtime, getCurrentScope, request, reviewUsesFreshContext: true });
}
const rewriteRequest = { input, current: { id: "base", baseScope: scope, replacements: [] }, report, iteration: 1, maxCandidates: 3 };
const signal = () => new AbortController().signal;

test("browser payload SHA-256 matches the Host JSON.stringify byte-for-byte including CJK", async () => {
  const payload = { contract: { type: "object" }, data: { 中文: "授权文本", nested: [1, { b: 2, a: 3 }] } };
  assert.equal(await careerLayoutPayloadHash(payload), createHash("sha256").update(JSON.stringify(payload)).digest("hex"));
});

test("rewrite receives no tools and cannot supply authority metadata; Adapter binds scope and deterministic input receipts", async () => {
  let dispatched: CareerLayoutModelRequest | undefined;
  const model = adapter(async body => { dispatched = body; return response(body, { candidates: [{ replacements: candidate.replacements, explanation: "更紧凑的同义候选" }] }); });
  const result = await model.rewrite(rewriteRequest, signal());
  assert.equal(dispatched?.purpose, "layout_rewrite"); assert.equal(dispatched?.consent, true);
  assert.equal(dispatched?.payload.contract.type, "object"); assert.equal(JSON.stringify(dispatched?.payload.contract).includes("$ref"), false);
  assert.equal("tools" in dispatched!, false); assert.equal(result[0]?.baseScope.ownerId, scope.ownerId);
  assert.match(result[0]!.id, /^local-layout-/); assert.equal(model.location, "local");
});

test("a measured claim issue restricts the model contract to its exact anchor and supplies advisory-only original-text targets", async () => {
  const selected: LayoutInput = { scope, texts: [
    { anchor: "profile:headline", text: "全栈工程师", protectedSpans: [{ kind: "entity", text: "全栈工程师" }] },
    { anchor: "claim:c1", text: "Untargeted synthetic wording." },
    { anchor: "claim:c2", text: "Implemented the synthetic local test fixture.", protectedSpans: [{ kind: "entity", text: "fixture" }] },
  ] };
  const diagnosis: LayoutDiagnosis = { ...report, penalty: 2, issues: [{ id: "short-claim-2", kind: "short-last-line", severity: "notice", pageNumber: 2,
    anchor: "claim:c2", detail: "The last measured line is short.", metrics: { words: 1 } }] };
  let dispatched!: CareerLayoutModelRequest;
  const result = await adapter(async body => { dispatched = body; return response(body, { candidates: [] }); }).rewrite({ ...rewriteRequest, input: selected, report: diagnosis }, signal());
  const schema = dispatched.payload.contract as { properties: { candidates: { maxItems: number; items: { properties: { replacements: { items: { properties: { anchor: { enum: string[] } } } } } } } } };
  assert.deepEqual(schema.properties.candidates.items.properties.replacements.items.properties.anchor.enum, ["claim:c2"]);
  const data = dispatched.payload.data as { targeting: string; direction: string; instruction: string; eligibleTargets: Array<{ anchor: string; before: string; protectedSpans: unknown[]; originalCharacters: number; suggestedTargetCharacters: number; budgetIsHint: boolean }> };
  assert.equal(data.targeting, "issue-anchors"); assert.equal(data.direction, "compress");
  assert.deepEqual(data.eligibleTargets.map(target => target.anchor), ["claim:c2"]);
  assert.equal(data.eligibleTargets[0]!.before, "Implemented the synthetic local test fixture.");
  assert.deepEqual(data.eligibleTargets[0]!.protectedSpans, [{ kind: "entity", text: "fixture" }]);
  assert.equal(data.eligibleTargets[0]!.budgetIsHint, true);
  assert.ok(data.eligibleTargets[0]!.suggestedTargetCharacters < data.eligibleTargets[0]!.originalCharacters);
  assert.match(data.instruction, /翻译/); assert.match(data.instruction, /姓名/);
  assert.deepEqual(result, []);
  await assert.rejects(adapter(async body => response(body, { candidates: [{ replacements: [{ anchor: "claim:c1", before: "Untargeted synthetic wording.", after: "Synthetic wording." }], explanation: "Wrong target" }] }))
    .rewrite({ ...rewriteRequest, input: selected, report: diagnosis }, signal()), /目标|定位/);
});

test("an explicit unknown or noneditable issue anchor cannot fall back to unrelated resume text even beside a global page issue", async () => {
  for (const anchor of ["claim:not-in-this-input", "profile:displayName", "", " "]) {
    let dispatched = 0;
    const model = adapter(async body => { dispatched++; return response(body, { candidates: [] }); });
    const diagnosis: LayoutDiagnosis = { ...report, penalty: 10, issues: [
      { id: "global", kind: "trailing-whitespace", severity: "notice", pageNumber: 2, detail: "Global page whitespace", metrics: { ratio: 0.7 } },
      { id: "unknown-target", kind: "short-last-line", severity: "notice", pageNumber: 2, anchor, detail: "No editable target at this anchor", metrics: {} },
    ] };
    assert.deepEqual(await model.rewrite({ ...rewriteRequest, report: diagnosis }, signal()), []);
    assert.equal(dispatched, 0, "Unknown measured anchors must not expand the model's rewrite scope");
  }
});

test("only an unanchored global pagination issue can open the authorized text fallback", async () => {
  for (const issues of [[], [{ id: "unlocated", kind: "overflow" as const, severity: "error" as const, pageNumber: 1, detail: "No text anchor was located", metrics: {} }]]) {
    let dispatched = 0;
    const model = adapter(async body => { dispatched++; return response(body, { candidates: [] }); });
    assert.deepEqual(await model.rewrite({ ...rewriteRequest, report: { ...report, issues } }, signal()), []);
    assert.equal(dispatched, 0, "No layout issue, or a missing local anchor, does not authorize arbitrary text changes");
  }
});

test("zero candidate allowance never dispatches or grows the model budget", async () => {
  let dispatched = 0;
  const model = adapter(async body => { dispatched++; return response(body, { candidates: [] }); });
  assert.deepEqual(await model.rewrite({ ...rewriteRequest, maxCandidates: 0 }, signal()), []);
  for (const maxCandidates of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(model.rewrite({ ...rewriteRequest, maxCandidates }, signal()), /预算/);
  }
  assert.equal(dispatched, 0);
});

test("global whitespace permits only existing authorized text anchors and labels expansion counts as hints, not resume facts", async () => {
  const selected: LayoutInput = { scope, texts: [{ anchor: "claim:c1", text: "Local synthetic wording." }, { anchor: "claim:c2", text: "Another synthetic sentence." }] };
  let dispatched!: CareerLayoutModelRequest;
  await adapter(async body => { dispatched = body; return response(body, { candidates: [], unknowns: ["No safe wording change was found."] }); })
    .rewrite({ ...rewriteRequest, input: selected, maxCandidates: 1 }, signal());
  const data = dispatched.payload.data as { targeting: string; direction: string; maxCandidates: number; eligibleTargets: Array<{ anchor: string; before: string; originalCharacters: number; suggestedTargetCharacters: number; budgetIsHint: boolean }> };
  assert.equal(data.targeting, "global-pagination"); assert.equal(data.direction, "expand"); assert.equal(data.maxCandidates, 1);
  assert.deepEqual(data.eligibleTargets.map(target => [target.anchor, target.before]), [["claim:c1", "Local synthetic wording."], ["claim:c2", "Another synthetic sentence."]]);
  assert.ok(data.eligibleTargets.every(target => target.budgetIsHint && target.suggestedTargetCharacters > target.originalCharacters));
  const schema = dispatched.payload.contract as { properties: { candidates: { maxItems: number; items: { properties: { replacements: { items: { properties: { anchor: { enum: string[] } } } } } } } } };
  assert.equal(schema.properties.candidates.maxItems, 1);
  assert.deepEqual(schema.properties.candidates.items.properties.replacements.items.properties.anchor.enum, ["claim:c1", "claim:c2"]);
  assert.equal(JSON.stringify(schema).includes("$ref"), false);
});

test("narrowed rewrite still rejects entity removal, translation and protected-token association changes instead of repairing model output", async () => {
  const before = "Implemented a SQLite fixture; not deployed.";
  const selected: LayoutInput = { scope, texts: [{ anchor: "claim:c1", text: before, protectedSpans: [{ text: "SQLite", kind: "entity" }] }] };
  for (const after of ["Implemented a local fixture; not deployed.", "实现SQLite样例；未上线。", "not Implemented a SQLite fixture; deployed."]) {
    const purposes: string[] = [];
    await assert.rejects(adapter(async body => { purposes.push(body.purpose); return response(body, { candidates: [{ replacements: [{ anchor: "claim:c1", before, after }], explanation: "Unsafe synthetic proposal" }] }); })
      .rewrite({ ...rewriteRequest, input: selected }, signal()), /Protected content changed/);
    assert.deepEqual(purposes, ["layout_rewrite"]);
  }
});

test("a valid targeted wording candidate still requires its separate fresh-purpose seven-check review", async () => {
  const before = "Implemented a synthetic local fixture with local checks; not deployed.";
  const after = "Implemented a synthetic local fixture with checks; not deployed.";
  const selected: LayoutInput = { scope, texts: [{ anchor: "claim:c1", text: before }] };
  const diagnosis: LayoutDiagnosis = { ...report, penalty: 2, issues: [{ id: "short", kind: "short-last-line", severity: "notice", pageNumber: 1, anchor: "claim:c1", detail: "Synthetic short line", metrics: {} }] };
  const requests: CareerLayoutModelRequest[] = [];
  const model = adapter(async body => { requests.push(body); return response(body, body.purpose === "layout_rewrite"
    ? { candidates: [{ replacements: [{ anchor: "claim:c1", before, after }], explanation: "Synthetic pending wording proposal" }] }
    : { verdict: "equivalent", checks: REQUIRED_SEMANTIC_CHECKS.map(kind => ({ kind, passed: true, reason: "Synthetic external boundary response" })), detail: "Fixture verdict, not a real model acceptance." }); });
  const proposed = await model.rewrite({ ...rewriteRequest, input: selected, report: diagnosis }, signal());
  assert.deepEqual(requests.map(request => request.purpose), ["layout_rewrite"]);
  assert.equal(proposed[0]!.replacements[0]!.after, after);
  const verdict = await model.verifySemantics({ input: selected, candidate: proposed[0]! }, signal());
  assert.deepEqual(requests.map(request => request.purpose), ["layout_rewrite", "layout_review"]);
  const reviewData = requests[1]!.payload.data as { input: LayoutInput; candidate: LayoutCandidate };
  assert.equal(reviewData.input.texts[0]!.text, before); assert.equal(reviewData.candidate.replacements[0]!.after, after);
  assert.equal("current" in reviewData, false); assert.equal("report" in reviewData, false);
  assert.equal(verdict.verdict, "equivalent"); assert.equal(verdict.method, "independent-review"); assert.deepEqual(verdict.checks, REQUIRED_SEMANTIC_CHECKS);
});

test("semantic review is a separate purpose call with seven explicit checks and Host-owned provenance", async () => {
  const purposes: string[] = [];
  const model = adapter(async body => { purposes.push(body.purpose); return response(body, { verdict: "equivalent", checks: REQUIRED_SEMANTIC_CHECKS.map(kind => ({ kind, passed: true, reason: "合成检查理由" })), detail: "仅是措辞关系的审查。" }); });
  const verdict = await model.verifySemantics({ input, candidate }, signal());
  assert.deepEqual(purposes, ["layout_review"]); assert.equal(verdict.method, "independent-review");
  assert.match(verdict.detail, /不是独立事实认证/); assert.equal(verdict.scope.ownerId, scope.ownerId);
  assert.deepEqual(verdict.checks, REQUIRED_SEMANTIC_CHECKS);
});

test("hash, context and runtime mismatches reject responses instead of trusting a plausible output", async () => {
  for (const field of ["inputHash", "contextId", "runtime"] as const) {
    const model = adapter(async body => ({ ...response(body, { candidates: [] }), [field]: field === "runtime" ? { ...runtime, modelDigest: "changed" } : "mismatch" }));
    await assert.rejects(model.rewrite(rewriteRequest, signal()), /SHA-256输入或固定运行时不匹配/);
  }
});

test("unknown extra fields, invented source scope and out-of-schema layout parameters fail closed", async () => {
  for (const output of [
    { candidates: [], ownerId: "model-claimed-owner" },
    { candidates: [{ replacements: [], explanation: "x", baseScope: scope }] },
    { candidates: [{ replacements: [], explanation: "x", parameters: { lineHeight: 1.1 } }] },
    { candidates: [{ replacements: [], explanation: "x", parameters: { execute: "shell" } }] },
  ]) await assert.rejects(adapter(async body => response(body, output)).rewrite(rewriteRequest, signal()));
});

test("semantic missing/duplicate checks and numerical changes cannot become approved equivalents", async () => {
  const duplicate = [...REQUIRED_SEMANTIC_CHECKS.slice(0, 6), "meaning", "meaning"];
  await assert.rejects(adapter(async body => response(body, { verdict: "equivalent", checks: duplicate.map(kind => ({ kind, passed: true, reason: "fixture" })), detail: "x" })).verifySemantics({ input, candidate }, signal()));
  const partial = await adapter(async body => response(body, { verdict: "equivalent", checks: REQUIRED_SEMANTIC_CHECKS.map(kind => ({ kind, passed: kind !== "meaning", reason: "fixture" })), detail: "含义仍未知" })).verifySemantics({ input, candidate }, signal());
  assert.equal(partial.verdict, "unknown"); assert.equal(partial.checks.includes("meaning"), false);
  const numericInput: LayoutInput = { scope, texts: [{ anchor: "claim:c1", text: "参与实现 10ms 延迟" }] };
  let calls = 0;
  await assert.rejects(adapter(async body => { calls++; return response(body, {}); }).verifySemantics({ input: numericInput, candidate: { ...candidate, replacements: [{ anchor: "claim:c1", before: "参与实现 10ms 延迟", after: "主导实现 5ms 延迟" }] } }, signal()));
  assert.equal(calls, 0);
});

test("input payload limits reject rather than truncate private text; account switches discard late replies", async () => {
  let calls = 0;
  const model = adapter(async body => { calls++; return response(body, { candidates: [] }); });
  await assert.rejects(model.rewrite({ ...rewriteRequest, input: { scope, texts: [{ anchor: "claim:huge", text: "授权合成文本".repeat(30000) }] } }, signal()), /载荷预算/);
  assert.equal(calls, 0);
  let current = scope;
  const switched = adapter(async body => { current = { ...scope, ownerId: "other" }; return response(body, { candidates: [] }); }, () => current);
  await assert.rejects(switched.rewrite(rewriteRequest, signal()), /会话或固定模型已变化/);
});

test("a fixed runtime change and cancellation prevent dispatch; failures never select another model", async () => {
  let calls = 0;
  const model = createCareerLayoutModelAdapter({ contextId: "c", scope, runtime, getCurrentScope: () => scope, getCurrentRuntime: () => ({ ...runtime, modelDigest: "new" }), reviewUsesFreshContext: true,
    request: async body => { calls++; return response(body, { candidates: [] }); } });
  await assert.rejects(model.rewrite(rewriteRequest, signal())); assert.equal(calls, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(adapter(async body => { calls++; return response(body, { candidates: [] }); }).rewrite(rewriteRequest, controller.signal));
  assert.equal(calls, 0);
  await assert.rejects(adapter(async () => { calls++; throw new Error("synthetic provider failure"); }).rewrite(rewriteRequest, signal()));
  assert.equal(calls, 1);
});
