import assert from "node:assert/strict";
import test from "node:test";
import {
  CompensationReviewProposalSchema, CompensationReviewSourceBindingSchema, ConfirmCompensationReviewInputSchema, PreviewCompensationReviewInputSchema,
  activeCompensationReviewDecision, applyCompensationReviewConfirmation, captureCompensationReviewSourceBinding, getInvalidatedCompensationReviewIds,
  projectCompensationReviews, validateCompensationReviewProposal,
  type CompensationReviewConfirmation, type CompensationReviewDecision, type CompensationReviewField, type CompensationReviewProposal,
} from "../src/compensation-review.js";
import { AtlasDatasetSchema, type AtlasDataset, type Compensation } from "../src/schema.js";
import { normalizeCompensation } from "../src/compensation.js";
import { queryJobs } from "../src/query.js";

const at = "2026-10-21T00:00:00Z";
const salaryQuote = "税前固定月薪人民币20,000-30,000元。";
const monthsQuote = "每年保证发放12个月固定工资。";
const url = "https://careers.example.test/jobs/one";
const reference = (quote: string) => ({ observationId: "observation.one", sourceUrl: url, quote, observedAt: at });

function dataset(): AtlasDataset {
  return AtlasDatasetSchema.parse({ schemaVersion: 1, revision: 20,
    sources: [{ sourceId: "source.one", name: "Synthetic salary evidence", adapterId: "synthetic", adapterVersion: "1", capabilities: ["read-detail"], runtime: ["local-service"], entityType: "job-posting", enabled: true, status: "active", remoteFilters: [], endpointPolicy: { allowedHosts: ["careers.example.test"], allowedPathPrefixes: ["/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 }, attribution: { label: "Synthetic evidence", usage: "metadata", requiresAttribution: true }, refreshPolicy: { mode: "manual", minIntervalSeconds: 60, maxRecords: 100, maxPages: 10, requestsPerMinute: 30 } }],
    companies: [{ id: "company.one", names: ["Synthetic employer"], domains: [], parentCompanyIds: [], manualOverrides: [], ultimateControllers: { value: [], evidence: [], method: "manual", verification: "unknown", revision: 0 } }],
    jobs: [{ id: "job.one", companyId: "company.one", title: { value: "Synthetic engineer", evidence: [], method: "manual", verification: "unverified", revision: 0 }, description: "Synthetic role", locationIds: [], compensationIds: ["compensation.one"], listingIds: ["listing.one"], workMode: "unknown", employmentType: "unknown", remoteEligibleRegions: [], status: "open", revision: 0, updatedAt: at }],
    locations: [], compensations: [{ id: "compensation.one", raw: `${salaryQuote}\n${monthsQuote}`, period: "unknown", tax: "unknown", kind: "unknown", verification: "unknown", evidence: [reference(salaryQuote)] }],
    listings: [{ id: "listing.one", sourceId: "source.one", sourceRecordId: "one", canonicalUrl: url, canonicalJobId: "job.one", compensationIds: ["compensation.one"], observationIds: ["observation.one"], firstDiscoveredAt: at }],
    observations: [{ id: "observation.one", listingId: "listing.one", fetchedAt: at, result: "read", availability: "unknown", completeness: "detail", warnings: [], rawText: `${salaryQuote}\n${monthsQuote}` }],
    snapshots: [],
  });
}

function proposal(overrides: Partial<Omit<CompensationReviewProposal, "supports">> = {}, quote = salaryQuote, annualization = monthsQuote): CompensationReviewProposal {
  const fields = { min: 20000, max: 30000, currency: "CNY", period: "month" as const, tax: "gross" as const, kind: "base" as const, monthsPerYear: 12, ...overrides };
  return CompensationReviewProposalSchema.parse({ basis: "manual-evidence-review", ...fields,
    supports: (Object.entries(fields) as Array<[CompensationReviewField, unknown]>).filter(([, value]) => value !== undefined && value !== "unknown").map(([field]) => ({ field, reference: reference(field.endsWith("PerYear") ? annualization : quote) })),
  });
}
function binding(base: AtlasDataset, proposed = proposal()) { return { jobId: "job.one", listingId: "listing.one", compensationId: "compensation.one", sourceCompensation: structuredClone(base.compensations[0]!), proposal: proposed }; }
function confirm(base: AtlasDataset, id = "decision.one", revision = 10, proposed = proposal()): CompensationReviewConfirmation {
  const source = binding(base, proposed);
  return { ...source, sourceBinding: captureCompensationReviewSourceBinding(base, source), kind: "confirm", id, actorScope: "local.user", at, revision, reason: "Read the retained disclosure" };
}
function revoke(base: AtlasDataset, targetDecisionId = "decision.one", revision = 11): CompensationReviewDecision {
  return { kind: "revoke", id: `revoke.${revision}`, jobId: "job.one", listingId: "listing.one", compensationId: "compensation.one", sourceCompensation: structuredClone(base.compensations[0]!), sourceBinding: captureCompensationReviewSourceBinding(base, { listingId: "listing.one", sourceCompensation: base.compensations[0]! }), targetDecisionId, actorScope: "local.user", at, revision, reason: "Withdraw my interpretation" };
}
function replaceText(base: AtlasDataset, text: string) {
  base.observations[0]!.rawText = text;
  base.compensations[0]!.raw = text;
  base.compensations[0]!.evidence = [reference(text)];
}

test("field-by-field retained disclosure produces CNY annual gross fixed cash without claiming employer verification", async () => {
  const base = dataset(); const original = structuredClone(base);
  const effective = validateCompensationReviewProposal(base, binding(base));
  assert.equal(effective.verification, "unverified"); assert.equal(effective.raw, base.compensations[0]!.raw);
  assert.deepEqual(effective.evidence[0], base.compensations[0]!.evidence[0]);
  assert.deepEqual(normalizeCompensation(effective).cnyAnnual, { currency: "CNY", min: 240000, max: 360000 });
  const projected = projectCompensationReviews(base, [confirm(base)]);
  const result = await queryJobs(projected, { salary: { range: { min: 240000 }, includeUnknown: false } });
  assert.equal(result.totalJobs, 1);
  assert.deepEqual(base, original, "preview and replay never mutate their input");
});

test("review inputs reject arbitrary executable styles, missing field evidence, coercion, unordered bounds and incompatible annualization", () => {
  const input = { jobId: "job.one", compensationId: "compensation.one", expectedRevision: 20, reason: "Review", proposal: proposal() };
  assert.equal(PreviewCompensationReviewInputSchema.safeParse(input).success, true);
  for (const change of [
    (value: Record<string, unknown>) => { value.script = "execute"; },
    (value: Record<string, unknown>) => { (value.proposal as CompensationReviewProposal).supports = []; },
    (value: Record<string, unknown>) => { (value.proposal as Record<string, unknown>).min = "20000"; },
    (value: Record<string, unknown>) => { (value.proposal as CompensationReviewProposal).max = 1; },
    (value: Record<string, unknown>) => { (value.proposal as CompensationReviewProposal).period = "year"; },
    (value: Record<string, unknown>) => { (value.proposal as CompensationReviewProposal).kind = "unknown"; },
  ]) { const value = structuredClone(input) as Record<string, unknown>; change(value); assert.equal(PreviewCompensationReviewInputSchema.safeParse(value).success, false); }
  assert.equal(ConfirmCompensationReviewInputSchema.safeParse({ ...input, previewFingerprint: "a".repeat(64), reviewed: false }).success, false);
});

test("evidence must be literal retained same-listing text, with exact observed time and a bound source URL", () => {
  const base = dataset();
  for (const change of [
    (value: CompensationReviewProposal) => { value.supports[0]!.reference.quote = "CNY 20000-30000 fictional salary"; },
    (value: CompensationReviewProposal) => { value.supports[0]!.reference.observationId = "observation.unknown"; },
    (value: CompensationReviewProposal) => { value.supports[0]!.reference.sourceUrl = "https://other.example.test/fiction"; },
    (value: CompensationReviewProposal) => { value.supports[0]!.reference.observedAt = "2026-10-20T00:00:00Z"; },
    (value: CompensationReviewProposal) => { value.supports[0]!.snapshotId = "snapshot.missing"; },
  ]) { const value = proposal(); change(value); assert.throws(() => validateCompensationReviewProposal(base, binding(base, value)), /invalid-compensation-review-evidence/); }
});

test("a different listing's matching passage cannot certify this compensation", () => {
  const base = dataset();
  base.listings.push({ ...structuredClone(base.listings[0]!), id: "listing.other", canonicalJobId: undefined, compensationIds: [], observationIds: ["observation.other"] });
  base.observations.push({ ...structuredClone(base.observations[0]!), id: "observation.other", listingId: "listing.other" });
  const value = proposal(); value.supports[0]!.reference.observationId = "observation.other";
  assert.throws(() => validateCompensationReviewProposal(base, binding(base, value)), /invalid-compensation-review-evidence/);
});

test("JD snapshot evidence is checked against its immutable listing, observation, URL and exact content", () => {
  const base = dataset(); base.observations[0]!.rawText = "Source metadata only";
  base.snapshots.push({ id: "snapshot.one", listingId: "listing.one", observationId: "observation.one", text: `${salaryQuote}\n${monthsQuote}`, contentHash: "a".repeat(64), createdAt: at, sourceUrl: url, extractionMethod: "parser", completeness: "detail" });
  const value = proposal(); value.supports.forEach(support => { support.snapshotId = "snapshot.one"; });
  assert.equal(validateCompensationReviewProposal(base, binding(base, value)).min, 20000);
  base.snapshots[0]!.listingId = "listing.other";
  assert.throws(() => validateCompensationReviewProposal(base, binding(base, value)), /invalid-compensation-review-evidence/);
});

test("failed or needs-human reads never become usable salary evidence", () => {
  for (const result of ["failed", "needs-human"] as const) {
    const base = dataset(); base.observations[0]!.result = result;
    assert.throws(() => validateCompensationReviewProposal(base, binding(base)), /invalid-compensation-review-evidence/);
  }
});

test("source/job/listing/compensation ownership is unique and cannot be selected by array order", () => {
  for (const change of [
    (base: AtlasDataset) => { base.jobs[0]!.listingIds = []; },
    (base: AtlasDataset) => { base.listings[0]!.compensationIds = []; base.listings.push({ ...structuredClone(base.listings[0]!), id: "listing.other", canonicalJobId: undefined, observationIds: [], compensationIds: ["compensation.one"] }); },
    (base: AtlasDataset) => { base.jobs.push({ ...structuredClone(base.jobs[0]!), id: "job.other", listingIds: [] }); },
    (base: AtlasDataset) => { base.compensations[0]!.evidence[0]!.observationId = "observation.missing"; },
  ]) { const base = dataset(); change(base); assert.throws(() => validateCompensationReviewProposal(base, binding(base)), /invalid-compensation-review-source/); }
});

test("maximum 13 salaries and performance bonuses do not become guaranteed thirteen gross base payments", () => {
  for (const quote of ["最高13薪", "每年最多发放13个月固定工资", "每年保证发放13个月固定工资，视绩效而定", "预计每年保证发放13个月固定工资", "13薪含年终奖", "guaranteed 13 months of base salary per year, discretionary bonus"]) {
    const base = dataset(); base.observations[0]!.rawText += `\n${quote}`;
    const value = proposal({ monthsPerYear: 13 }, salaryQuote, quote);
    assert.throws(() => validateCompensationReviewProposal(base, binding(base, value)), /unsupported-compensation-review-field:monthsPerYear/);
  }
  const base = dataset(); const value = proposal({ monthsPerYear: undefined });
  const effective = validateCompensationReviewProposal(base, binding(base, value));
  assert.equal(normalizeCompensation(effective).reason, "missing-months-per-year");
});

test("a missing gross or fixed-base disclosure remains unknown even if the person checks a box", () => {
  for (const quote of ["月薪人民币20,000-30,000元。", "税后固定月薪人民币20,000-30,000元。", "并非税前固定月薪人民币20,000-30,000元。", "税前总包月薪人民币20,000-30,000元含奖金。", "税前固定月薪人民币20,000-30,000元，仅供参考。" ]) {
    const base = dataset(); replaceText(base, `${quote}\n${monthsQuote}`);
    assert.throws(() => validateCompensationReviewProposal(base, binding(base, proposal({}, quote))), /unsupported-compensation-review-field/);
  }
  const base = dataset(); const quote = "月薪人民币20,000-30,000元。"; replaceText(base, quote);
  const effective = validateCompensationReviewProposal(base, binding(base, proposal({ tax: "unknown", kind: "unknown", monthsPerYear: undefined }, quote)));
  assert.equal(effective.tax, "unknown"); assert.equal(effective.kind, "unknown");
  assert.equal(normalizeCompensation(effective).cnyAnnual, undefined);
});

test("range endpoints cannot be swapped, multiplied by 1000, chosen as midpoint, or taken from a bonus", () => {
  for (const [min, max] of [[25000, 30000], [20000, 35000], [20, 30], [20000000, 30000000]]) {
    const base = dataset(); assert.throws(() => validateCompensationReviewProposal(base, binding(base, proposal({ min, max }))), /unsupported-compensation-review-field/);
  }
  const base = dataset(); const quote = "税前奖金月薪人民币20,000-30,000元。"; replaceText(base, quote);
  const value = proposal({ monthsPerYear: undefined }, quote); value.supports.find(support => support.field === "kind")!.reference.quote = "固定月薪";
  base.observations[0]!.rawText += "\n固定月薪";
  assert.throws(() => validateCompensationReviewProposal(base, binding(base, value)), /unsupported-compensation-review-field:min/);
});

test("explicit decimal k and Chinese ten-thousand units use disclosed scale", () => {
  for (const quote of ["税前固定月薪人民币20-30k。", "税前固定月薪人民币2-3万。", "税前固定月薪人民币20k-3万。"] ) {
    const base = dataset(); replaceText(base, `${quote}\n${monthsQuote}`);
    assert.equal(validateCompensationReviewProposal(base, binding(base, proposal({}, quote))).max, 30000);
  }
});

test("foreign currency review retains original annual salary and supplies no invented FX", () => {
  const quote = "Annual gross base salary USD 100000-150000."; const base = dataset(); replaceText(base, quote);
  const value = proposal({ min: 100000, max: 150000, currency: "USD", period: "year", monthsPerYear: undefined }, quote);
  const normalized = normalizeCompensation(validateCompensationReviewProposal(base, binding(base, value)));
  assert.deepEqual(normalized.originalAnnual, { currency: "USD", min: 100000, max: 150000 });
  assert.equal(normalized.reason, "fx-missing"); assert.equal(normalized.cnyAnnual, undefined); assert.equal(normalized.fx, undefined);
});

test("a bare dollar sign and a conflicting currency or period do not become a selected currency/period", () => {
  for (const quote of ["Annual gross base salary $100000-150000.", "Annual gross base salary USD 100000-150000 or EUR equivalent.", "Annual gross base salary USD 100000-150000, monthly option."]) {
    const base = dataset(); replaceText(base, quote);
    const value = proposal({ min: 100000, max: 150000, currency: "USD", period: "year", monthsPerYear: undefined }, quote);
    assert.throws(() => validateCompensationReviewProposal(base, binding(base, value)), /unsupported-compensation-review-field/);
  }
});

test("review omits and clears parser guesses; monthly salary never inherits thirteen unsupported months", () => {
  const base = dataset(); base.compensations[0] = { ...base.compensations[0]!, min: 1, max: 2, monthsPerYear: 13, hoursPerYear: 2000 };
  const result = validateCompensationReviewProposal(base, binding(base, proposal({ monthsPerYear: undefined })));
  assert.equal(result.min, 20000); assert.equal(result.monthsPerYear, undefined); assert.equal(result.hoursPerYear, undefined);
  assert.equal(normalizeCompensation(result).reason, "missing-months-per-year");
});

test("hour/day/week annualization requires explicit fixed annual working units and does not guess 2080 hours", () => {
  for (const [period, field, amountQuote, annualQuote, annualUnits] of [
    ["hour", "hoursPerYear", "Gross base salary CNY 100-200 per hour.", "guaranteed 1800 hours per year", 1800],
    ["day", "daysPerYear", "Gross base salary CNY 100-200 per day.", "fixed 200 days per year", 200],
    ["week", "weeksPerYear", "Gross base salary CNY 100-200 per week.", "guaranteed 48 weeks per year", 48],
  ] as const) {
    const base = dataset(); replaceText(base, `${amountQuote}\n${annualQuote}`);
    const value = proposal({ min: 100, max: 200, period, monthsPerYear: undefined, [field]: annualUnits }, amountQuote, annualQuote);
    const effective = validateCompensationReviewProposal(base, binding(base, value));
    assert.equal(normalizeCompensation(effective).cnyAnnual?.min, 100 * annualUnits);
    value[field] = annualUnits + 1;
    assert.throws(() => validateCompensationReviewProposal(base, binding(base, value)), new RegExp(`unsupported-compensation-review-field:${field}`));
  }
});

test("replay selects latest applicable confirmation; revoke returns previous review then original source", () => {
  const base = dataset(); const first = confirm(base); const second = confirm(base, "decision.two", 11, proposal({ monthsPerYear: undefined }));
  assert.equal(activeCompensationReviewDecision(base, [first, second], "compensation.one")?.id, second.id);
  assert.equal(projectCompensationReviews(base, [first, second]).compensations[0]!.monthsPerYear, undefined);
  const undoSecond = revoke(base, second.id, 12);
  assert.equal(projectCompensationReviews(base, [first, second, undoSecond]).compensations[0]!.monthsPerYear, 12);
  assert.deepEqual(projectCompensationReviews(base, [first, second, undoSecond, revoke(base, first.id, 13)]).compensations, base.compensations);
});

test("source A→B→A cannot revive a review after an append-only source-change invalidation", () => {
  const a = dataset(); const decision = confirm(a);
  const b = structuredClone(a); b.compensations[0]!.raw = "New source salary disclosure";
  assert.deepEqual(getInvalidatedCompensationReviewIds(b, [decision]), [decision.id]);
  assert.deepEqual(projectCompensationReviews(b, [decision]).compensations, b.compensations);
  const invalidation: CompensationReviewDecision = { id: "invalidate.one", kind: "invalidate", at, actorScope: "local.service", revision: 11, reason: "source-changed", targetDecisionIds: [decision.id] };
  assert.deepEqual(projectCompensationReviews(a, [decision, invalidation]).compensations, a.compensations);
  assert.equal(activeCompensationReviewDecision(a, [decision, invalidation], "compensation.one"), undefined);
  assert.deepEqual(getInvalidatedCompensationReviewIds(a, [decision, invalidation]), []);
  assert.deepEqual(projectCompensationReviews(a, [decision, invalidation, revoke(a, decision.id, 12)]).compensations, a.compensations, "a person can withdraw even an already source-invalidated historical review");
});

test("ownership changes, removals and evidence-only source changes permanently invalidate all affected confirmations", () => {
  const base = dataset(); const decisions = [confirm(base), confirm(base, "decision.two", 11)];
  for (const change of [
    (value: AtlasDataset) => { value.jobs[0]!.compensationIds = []; },
    (value: AtlasDataset) => { value.jobs[0]!.listingIds = []; },
    (value: AtlasDataset) => { value.compensations = []; },
    (value: AtlasDataset) => { value.compensations[0]!.evidence[0]!.selector = "changed"; },
  ]) { const next = structuredClone(base); change(next); assert.deepEqual(getInvalidatedCompensationReviewIds(next, decisions), decisions.map(value => value.id)); }
});

test("forged actor revocation, duplicate IDs, out-of-order revisions and missing invalidation targets fail closed", () => {
  const base = dataset(); const decision = confirm(base);
  const wrongActor = revoke(base); wrongActor.actorScope = "different.user";
  const invalidation: CompensationReviewDecision = { id: "invalidate.one", kind: "invalidate", at, actorScope: "local.service", revision: 11, reason: "source-changed", targetDecisionIds: ["decision.missing"] };
  for (const decisions of [[decision, decision], [decision, { ...confirm(base, "decision.two"), revision: 9 }], [decision, wrongActor], [decision, revoke(base), revoke(base, decision.id, 12)], [decision, invalidation]]) {
    assert.throws(() => projectCompensationReviews(base, decisions), /invalid-compensation-review/);
  }
  const forged = confirm(base); forged.proposal.min = 99999;
  assert.throws(() => applyCompensationReviewConfirmation(base.compensations[0]!, forged), /bounds|salary|field|upper/i);
});

test("projection preserves location scope, raw disclosure, job facts, JD snapshots and all unrelated rows", () => {
  const base = dataset(); const decision = confirm(base);
  const actual = projectCompensationReviews(base, [decision]);
  for (const table of ["sources", "companies", "jobs", "locations", "listings", "observations", "snapshots"] as const) assert.deepEqual(actual[table], base[table]);
  assert.equal(actual.compensations[0]!.raw, base.compensations[0]!.raw);
  assert.deepEqual(actual.compensations[0]!.locationIds, base.compensations[0]!.locationIds);
});

test("annual exact and one-sided amounts preserve missing endpoints instead of constructing a midpoint", () => {
  for (const [quote, values] of [
    ["Annual gross base salary CNY 240000.", { min: 240000, max: 240000 }],
    ["Annual gross base salary CNY 240000, maximum.", { min: undefined, max: 240000 }],
  ] as const) {
    const base = dataset(); replaceText(base, quote);
    const value = proposal({ ...values, period: "year", monthsPerYear: undefined }, quote);
    const effective = validateCompensationReviewProposal(base, binding(base, value));
    assert.equal(effective.min, values.min); assert.equal(effective.max, values.max);
  }
});

test("listing URL and publisher identity changes invalidate permanently even with identical compensation objects", () => {
  const source = dataset(); const decision = confirm(source);
  for (const change of [
    (value: AtlasDataset) => { value.listings[0]!.canonicalUrl = "https://careers.example.test/jobs/replaced"; },
    (value: AtlasDataset) => { value.listings[0]!.applicationUrl = "https://careers.example.test/apply/replaced"; },
    (value: AtlasDataset) => { value.listings[0]!.sourceId = "source.changed"; },
    (value: AtlasDataset) => { value.listings[0]!.sourceRecordId = "changed-record"; },
  ]) {
    const next = structuredClone(source); change(next);
    assert.deepEqual(getInvalidatedCompensationReviewIds(next, [decision]), [decision.id]);
    const invalidation: CompensationReviewDecision = { id: "invalidate.identity", kind: "invalidate", actorScope: "local.service", at, revision: 11, reason: "source-changed", targetDecisionIds: [decision.id] };
    assert.deepEqual(projectCompensationReviews(source, [decision, invalidation]).compensations, source.compensations);
  }
});

test("changed or missing retained supporting materials invalidate but archived review history remains replayable", () => {
  const source = dataset(); const decision = confirm(source);
  const changed = structuredClone(source); changed.observations[0]!.rawText = "Source removed or changed its salary disclosure";
  assert.deepEqual(getInvalidatedCompensationReviewIds(changed, [decision]), [decision.id]);
  assert.deepEqual(projectCompensationReviews(changed, [decision]).compensations, changed.compensations);
  const missing = structuredClone(source); missing.observations = [];
  assert.deepEqual(getInvalidatedCompensationReviewIds(missing, [decision]), [decision.id], "refresh can record invalidation before source reference repair");
  const invalidation: CompensationReviewDecision = { id: "invalidate.material", kind: "invalidate", actorScope: "local.service", at, revision: 11, reason: "source-changed", targetDecisionIds: [decision.id] };
  assert.deepEqual(projectCompensationReviews(changed, [decision, invalidation]).compensations, changed.compensations);
  assert.equal(decision.sourceBinding.observations[0]!.rawText, source.observations[0]!.rawText, "captured evidence is independent of refreshed source rows");
});

test("immutable JD snapshot changes and deletion are detected even when current compensation is byte-identical", () => {
  const source = dataset();
  source.snapshots.push({ id: "snapshot.one", listingId: "listing.one", observationId: "observation.one", text: `${salaryQuote}\n${monthsQuote}`, contentHash: "a".repeat(64), createdAt: at, sourceUrl: url, extractionMethod: "parser", completeness: "detail" });
  const value = proposal(); value.supports.forEach(support => { support.snapshotId = "snapshot.one"; });
  const decision = confirm(source, "decision.snapshot", 10, value);
  for (const change of [
    (base: AtlasDataset) => { base.snapshots[0]!.text = "Replacement salary"; },
    (base: AtlasDataset) => { base.snapshots = []; },
  ]) { const next = structuredClone(source); change(next); assert.deepEqual(getInvalidatedCompensationReviewIds(next, [decision]), [decision.id]); }
  const forged = structuredClone(decision); forged.sourceBinding.snapshots[0]!.text = "Not the quoted salary";
  assert.throws(() => projectCompensationReviews(source, [forged]), /invalid-compensation-review-evidence/);
});

test("source-material binding rejects cross-listing snapshots, duplicate rows and mismatched observation snapshot hashes", () => {
  const source = dataset();
  source.observations[0]!.snapshotId = "snapshot.one"; source.observations[0]!.contentHash = "a".repeat(64);
  source.snapshots.push({ id: "snapshot.one", listingId: "listing.one", observationId: "observation.one", text: `${salaryQuote}\n${monthsQuote}`, contentHash: "a".repeat(64), createdAt: at, sourceUrl: url, extractionMethod: "parser", completeness: "detail" });
  const original = captureCompensationReviewSourceBinding(source, binding(source));
  for (const change of [
    (value: typeof original) => { value.snapshots[0]!.listingId = "listing.other"; },
    (value: typeof original) => { value.snapshots[0]!.observationId = "observation.other"; },
    (value: typeof original) => { value.observations.push(structuredClone(value.observations[0]!)); },
    (value: typeof original) => { value.snapshots[0]!.contentHash = "b".repeat(64); },
  ]) { const value = structuredClone(original); change(value); assert.equal(CompensationReviewSourceBindingSchema.safeParse(value).success, false); }
});

test("separate quotations cannot re-label a monthly range as annual pay or CNY range as USD", () => {
  const source = dataset(); source.observations[0]!.rawText += "\nAnnual gross base salary USD 20000-30000.";
  for (const override of [{ period: "year", monthsPerYear: undefined }, { currency: "USD" }] as const) {
    const value = proposal(override);
    const field = "currency" in override ? "currency" : "period";
    value.supports.find(support => support.field === field)!.reference.quote = "Annual gross base salary USD 20000-30000.";
    assert.throws(() => validateCompensationReviewProposal(source, binding(source, value)), /unsupported-compensation-review-field:min/);
  }
});
