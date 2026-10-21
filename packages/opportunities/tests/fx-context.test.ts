import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  ActivateFxSnapshotInputSchema, ConfirmFxImportInputSchema, FxImportDraftSchema, FxImportPreviewSchema,
  FxMutationReceiptSchema, FxQueryContextSchema, FxReferenceSnapshotSchema, FxStateSchema,
  MAX_FX_AGE_DAYS, MAX_FX_RAW_BYTES, MAX_FX_SNAPSHOTS, PreviewFxImportInputSchema, ReadFxStateInputSchema,
  buildFxImportPreview, buildFxReferenceSnapshot, fxReferenceAgeDays,
  validateFxQueryContext, validateFxReferenceSnapshot, validateFxState,
  type FxImportDraft, type FxReferenceSnapshot, type FxState,
} from "../src/fx-context.js";
import { FxSnapshotSchema, normalizeCompensation } from "../src/compensation.js";
import type { Compensation } from "../src/schema.js";

const now = "2026-10-21T12:00:00.000Z";
function draft(changes: Partial<FxImportDraft> = {}): FxImportDraft {
  return { schemaVersion: 1, provider: "Synthetic EUR reference", sourceUrl: "https://reference.example.test/eur/latest", retrievedAt: now,
    raw: '{"date":"2026-10-20","base":"EUR","rates":{"CNY":8,"USD":2,"JPY":160,"GBP":0.8}}', format: "eur-reference-json-v1", ...changes };
}
const clone = <T>(value: T): T => structuredClone(value);
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
function salary(currency = "USD"): Compensation {
  return { id: "salary.synthetic", raw: `Gross annual fixed salary ${currency} 100000–120000.`, currency, min: 100000, max: 120000,
    period: "year", tax: "gross", kind: "base", verification: "unverified", evidence: [{ observationId: "observation.synthetic", sourceUrl: "https://careers.example.test/jobs/one", observedAt: now, quote: `Gross annual fixed salary ${currency} 100000–120000.` }] };
}
function state(snapshot?: FxReferenceSnapshot): FxState {
  return { schemaVersion: 1, revision: 7, context: { schemaVersion: 1, datasetRevision: 7, asOf: now, ...(snapshot ? { activeSnapshot: snapshot } : {}) }, snapshots: snapshot ? [snapshot] : [] };
}

test("EUR publication converts each original currency to CNY without reversing its quote", async () => {
  const input = draft(); const original = clone(input);
  const snapshot = await buildFxReferenceSnapshot(input, { now });
  assert.deepEqual(snapshot.fx.ratesToCny, { CNY: 1, GBP: 10, JPY: 0.05, USD: 4, EUR: 8 });
  assert.equal(snapshot.contentHash, sha(input.raw));
  assert.equal(snapshot.raw, input.raw); assert.equal(snapshot.sourceUrl, input.sourceUrl); assert.equal(snapshot.retrievedAt, now);
  assert.equal(snapshot.provenance, "manual-import"); assert.equal(snapshot.fx.provider, input.provider);
  assert.match(snapshot.fx.id, /^fx_[a-f0-9]{64}$/); assert.deepEqual(input, original);
  assert.equal(FxSnapshotSchema.safeParse(snapshot.fx).success, true, "legacy FX consumers remain compatible");
  assert.deepEqual(normalizeCompensation(salary(), { now, fx: snapshot.fx }).cnyAnnual, { currency: "CNY", min: 400000, max: 480000 });
  assert.deepEqual(normalizeCompensation(salary("GBP"), { now, fx: snapshot.fx }).cnyAnnual, { currency: "CNY", min: 1000000, max: 1200000 });
  assert.deepEqual(normalizeCompensation(salary("EUR"), { now, fx: snapshot.fx }).cnyAnnual, { currency: "CNY", min: 800000, max: 960000 });
  assert.equal(normalizeCompensation(salary("CHF"), { now, fx: snapshot.fx }).reason, "fx-rate-missing");
});

test("manual reference preserves exact UTF-8 raw text, deterministic identities and deeply frozen rates", async () => {
  const input = draft({ provider: "合成参考源", raw: ` \n${draft().raw}\n` });
  const first = await buildFxReferenceSnapshot(input, { now }); const second = await buildFxReferenceSnapshot(clone(input), { now });
  assert.deepEqual(first, second); assert.equal(first.contentHash, sha(input.raw));
  assert.equal(Object.isFrozen(first), true); assert.equal(Object.isFrozen(first.fx), true); assert.equal(Object.isFrozen(first.fx.ratesToCny), true);
  assert.throws(() => { first.fx.ratesToCny.USD = 999; }, TypeError);
  assert.throws(() => { first.fx.provider = "changed"; }, TypeError);
  for (const changed of [draft({ ...input, provider: "Another reference" }), draft({ ...input, sourceUrl: "https://reference.example.test/eur/archive" }), draft({ ...input, retrievedAt: "2026-10-21T11:59:00Z" }), draft({ ...input, raw: `${input.raw} ` })]) {
    assert.notEqual((await buildFxReferenceSnapshot(changed, { now })).fx.id, first.fx.id);
  }
});

test("Frankfurter-style amount 1 and explicit EUR 1 are supported while retaining the publication body", async () => {
  const input = draft({ raw: '{"amount":1,"base":"EUR","date":"2026-10-20","rates":{"EUR":1,"CNY":8,"USD":2}}' });
  const snapshot = await buildFxReferenceSnapshot(input, { now });
  assert.equal(snapshot.raw, input.raw); assert.deepEqual(snapshot.fx.ratesToCny, { CNY: 1, EUR: 8, USD: 4 });
  assert.deepEqual(await validateFxReferenceSnapshot(clone(snapshot), { now }), snapshot);
});

test("Frankfurter V2 array is accepted only as an explicit same-day EUR publication with unique currency quotes", async () => {
  const entries = [{ date: "2026-10-20", base: "EUR", quote: "CNY", rate: 8 }, { date: "2026-10-20", base: "EUR", quote: "USD", rate: 2 }];
  const input = draft({ provider: "Frankfurter reference rates", sourceUrl: "https://api.frankfurter.dev/v2/rates", format: "frankfurter-v2-eur-json-v1", raw: JSON.stringify(entries) });
  const snapshot = await buildFxReferenceSnapshot(input, { now });
  assert.deepEqual(snapshot.fx.ratesToCny, { CNY: 1, USD: 4, EUR: 8 });
  assert.equal(snapshot.raw, input.raw); assert.equal(snapshot.contentHash, sha(input.raw)); assert.equal(snapshot.format, "frankfurter-v2-eur-json-v1");
  assert.deepEqual(await validateFxReferenceSnapshot(snapshot, { now }), snapshot);
  assert.deepEqual((await buildFxReferenceSnapshot({ ...input, raw: JSON.stringify([...entries, { date: "2026-10-20", base: "EUR", quote: "EUR", rate: 1 }]) }, { now })).fx.ratesToCny, { CNY: 1, EUR: 8, USD: 4 });
  for (const invalid of [
    [], entries[0], entries.slice(1), [...entries, entries[0]],
    [entries[0], { ...entries[1], date: "2026-10-19" }], [entries[0], { ...entries[1], date: "2026-10-22" }],
    [entries[0], { ...entries[1], base: "USD" }], [entries[0], { ...entries[1], rate: "2" }],
    [entries[0], { ...entries[1], rate: 0 }], [entries[0], { ...entries[1], rate: -1 }],
    [entries[0], { ...entries[1], extra: "not a quote" }], [entries[0], { ...entries[1], quote: "EUR", rate: 2 }],
    Array.from({ length: 201 }, () => entries[0]),
  ]) await assert.rejects(buildFxReferenceSnapshot({ ...input, raw: JSON.stringify(invalid) }, { now }));
  await assert.rejects(buildFxReferenceSnapshot({ ...input, raw: '[{"date":"2026-10-20","base":"EUR","quote":"CNY","rate":8,"rate":9}]' }, { now }), /duplicate-fx-json-field/);
  await assert.rejects(buildFxReferenceSnapshot({ ...input, format: "eur-reference-json-v1" }, { now }));
  await assert.rejects(buildFxReferenceSnapshot(draft({ format: "frankfurter-v2-eur-json-v1" }), { now }));
});

test("snapshot validation rebuilds retained evidence instead of trusting any stored hash, id or numerical rate", async () => {
  const snapshot = await buildFxReferenceSnapshot(draft(), { now });
  for (const change of [
    (value: FxReferenceSnapshot) => { value.contentHash = "a".repeat(64); },
    (value: FxReferenceSnapshot) => { value.fx.id = `fx_${"a".repeat(64)}`; },
    (value: FxReferenceSnapshot) => { value.fx.ratesToCny.USD = 5; },
    (value: FxReferenceSnapshot) => { delete value.fx.ratesToCny.CNY; },
    (value: FxReferenceSnapshot) => { value.fx.ratesToCny.CHF = 8; },
    (value: FxReferenceSnapshot) => { value.raw = value.raw.replace('"USD":2', '"USD":3'); },
    (value: FxReferenceSnapshot) => { value.raw = value.raw.replace('"USD":2', '"USD":3'); value.contentHash = sha(value.raw); },
    (value: FxReferenceSnapshot) => { value.fx.date = "2026-10-19"; },
    (value: FxReferenceSnapshot) => { value.fx.provider = "Another reference"; },
    (value: FxReferenceSnapshot) => { value.sourceUrl = "https://another.example.test/latest"; },
    (value: FxReferenceSnapshot) => { value.retrievedAt = "2026-10-21T11:59:00Z"; },
  ]) {
    const changed = clone(snapshot); change(changed);
    await assert.rejects(validateFxReferenceSnapshot(changed, { now }), /invalid-fx-reference-snapshot/);
  }
  await assert.rejects(validateFxReferenceSnapshot({ ...snapshot, provenance: "officially-verified" }, { now }));
});

test("a future publication, future retrieval or evidence dated after its retrieval is rejected", async () => {
  await assert.rejects(buildFxReferenceSnapshot(draft({ raw: draft().raw.replace("2026-10-20", "2026-10-22") }), { now }), /fx-future/);
  await assert.rejects(buildFxReferenceSnapshot(draft({ retrievedAt: "2026-10-21T12:00:00.001Z" }), { now }), /fx-future/);
  await assert.rejects(buildFxReferenceSnapshot(draft({ retrievedAt: "2026-10-19T23:59:59Z" }), { now }), /fx-future/);
  const offset = draft({ retrievedAt: "2026-10-21T20:00:00+08:00" });
  assert.equal((await buildFxReferenceSnapshot(offset, { now })).retrievedAt, offset.retrievedAt);
  for (const invalidNow of [NaN, Infinity, new Date(NaN), "2026-10-21", "invalid"]) await assert.rejects(buildFxReferenceSnapshot(draft(), { now: invalidNow }));
});

test("stale references remain inspectable but fail salary comparison after the inclusive 30 UTC-day window", async () => {
  assert.equal(MAX_FX_AGE_DAYS, 30);
  const snapshot = await buildFxReferenceSnapshot(draft({ retrievedAt: "2026-09-21T23:50:00Z", raw: draft().raw.replace("2026-10-20", "2026-09-21") }), { now });
  assert.equal(fxReferenceAgeDays(snapshot, "2026-10-21T23:59:59Z"), 30);
  assert.equal(normalizeCompensation(salary(), { fx: snapshot.fx, now: "2026-10-21T23:59:59Z" }).status, "comparable");
  const stale = normalizeCompensation(salary(), { fx: snapshot.fx, now: "2026-10-22T00:00:00Z" });
  assert.equal(stale.reason, "fx-stale"); assert.deepEqual(stale.originalAnnual, { currency: "USD", min: 100000, max: 120000 }); assert.equal(stale.cnyAnnual, undefined);
  assert.equal(normalizeCompensation(salary(), { fx: snapshot.fx, now: "2026-09-20T23:59:59Z" }).reason, "fx-future");
  assert.deepEqual(await validateFxReferenceSnapshot(snapshot, { now }), snapshot, "expiration is a query rule, never deletion of historical evidence");
});

test("strict reference format rejects missing or invented base/rates, coercion, duplicate keys and nonfinite math", async () => {
  const invalid = [
    {}, [], null, { date: "2026-10-20", rates: { CNY: 8 } }, { date: "2026-10-20", base: "USD", rates: { CNY: 8 } },
    { date: "2026-10-20", base: "EUR", rates: { USD: 2 } }, { date: "2026-10-20", base: "EUR", rates: { CNY: "8" } },
    { date: "2026-10-20", base: "EUR", rates: { CNY: 8, EUR: 0.9999 } },
    { date: "2026-10-20", base: "EUR", rates: { CNY: 8, usd: 2 } }, { date: "2026-10-20", base: "EUR", rates: { CNY: 8, US: 2 } },
    { date: "2026-10-20", base: "EUR", rates: { CNY: 8 }, amount: 2 }, { date: "2026-10-20", base: "EUR", rates: { CNY: 8 }, extra: "not reference data" },
    ...[0, -1, null, "NaN"].map(CNY => ({ date: "2026-10-20", base: "EUR", rates: { CNY } })),
    ...["2026-02-29", "2026-04-31", "2026-13-01", "2026-00-01", "2026-10-2"].map(date => ({ date, base: "EUR", rates: { CNY: 8 } })),
  ];
  for (const value of invalid) await assert.rejects(buildFxReferenceSnapshot(draft({ raw: JSON.stringify(value) }), { now }));
  for (const text of ["not JSON", `${draft().raw} trailing`, '{"date":"2026-10-20","date":"2026-10-19","base":"EUR","rates":{"CNY":8}}', '{"date":"2026-10-20","base":"EUR","rates":{"CNY":8,"CNY":9}}', '{"date":"2026-10-20","base":"EUR","rates":{"CNY":8,"C\\u004eY":9}}', '{"date":"2026-10-20","base":"EUR","rates":{"CNY":1e309}}', '{"date":"2026-10-20","base":"EUR","rates":{"CNY":8,"USD":5e-324}}']) {
    await assert.rejects(buildFxReferenceSnapshot(draft({ raw: text }), { now }));
  }
  assert.equal((await buildFxReferenceSnapshot(draft({ raw: draft().raw.replace("2026-10-20", "2024-02-29") }), { now })).fx.date, "2024-02-29");
});

test("raw bytes and currency counts are bounded, without a silent truncation or inferred missing currencies", async () => {
  assert.equal(MAX_FX_RAW_BYTES, 262144); assert.equal(MAX_FX_SNAPSHOTS, 1000);
  const atLimit = draft({ raw: `${draft().raw}${" ".repeat(MAX_FX_RAW_BYTES - Buffer.byteLength(draft().raw))}` });
  assert.equal((await buildFxReferenceSnapshot(atLimit, { now })).raw.length, MAX_FX_RAW_BYTES);
  assert.equal(FxImportDraftSchema.safeParse({ ...atLimit, raw: `${atLimit.raw} ` }).success, false);
  assert.equal(FxImportDraftSchema.safeParse(draft({ raw: "汉".repeat(Math.floor(MAX_FX_RAW_BYTES / 3) + 1) })).success, false);
  const rates: Record<string, number> = { CNY: 8 };
  for (let index = 0; Object.keys(rates).length < 200; index++) rates[`A${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + index % 26)}`] = 2;
  const input = draft({ raw: JSON.stringify({ date: "2026-10-20", base: "EUR", rates }) });
  assert.equal(Object.keys((await buildFxReferenceSnapshot(input, { now })).fx.ratesToCny).length, 201, "EUR is an explicitly defined base, not a guessed quote");
  rates.ZZZ = 2;
  await assert.rejects(buildFxReferenceSnapshot(draft({ raw: JSON.stringify({ date: "2026-10-20", base: "EUR", rates }) }), { now }));
});

test("reference links allow only bounded public selectors and reject credentials, query secrets, duplicates and fragments", async () => {
  for (const sourceUrl of ["http://reference.example.test/latest", "https://user:secret@reference.example.test/latest", "https://reference.example.test/latest?api_key=secret", "https://reference.example.test/latest#secret", " https://reference.example.test/latest", "https://reference.example.test/a b", "javascript:alert(1)", "file:///source.json",
    "https://reference.example.test/latest?providers=ECB&providers=FED", "https://reference.example.test/latest?providers=ECB&pro%76iders=ECB",
    "https://reference.example.test/latest?base=USD", "https://reference.example.test/latest?base=EUR&base=EUR", "https://reference.example.test/latest?date=2026-02-29",
    "https://reference.example.test/latest?date=2026-10-20&date=2026-10-20", "https://reference.example.test/latest?quotes=usd", "https://reference.example.test/latest?quotes=US",
    "https://reference.example.test/latest?quotes=CNY&quotes=USD", "https://reference.example.test/latest?providers=ecb", "https://reference.example.test/latest?providers=ECB%26api_key%3Dsecret",
    "https://reference.example.test/latest?token=secret&providers=ECB", `https://reference.example.test/latest?providers=${"A".repeat(161)}`, `https://reference.example.test/latest?quotes=${Array.from({ length: 201 }, () => "CNY").join(",")}`]) {
    assert.equal(FxImportDraftSchema.safeParse(draft({ sourceUrl })).success, false, sourceUrl);
  }
  for (const sourceUrl of ["https://api.frankfurter.dev/v1/latest", "https://api.frankfurter.dev/v2/rates?providers=ECB", "https://api.frankfurter.dev/v2/rates?providers=ECB,FED_1&base=EUR&date=2024-02-29&quotes=CNY,USD,JPY"]) {
    assert.equal(FxImportDraftSchema.safeParse(draft({ sourceUrl })).success, true, sourceUrl);
    assert.equal((await buildFxReferenceSnapshot(draft({ sourceUrl }), { now })).sourceUrl, sourceUrl, "the exact public request URL remains retained evidence");
  }
  for (const provider of ["", " source ", "source\nnext", "x".repeat(201)]) assert.equal(FxImportDraftSchema.safeParse(draft({ provider })).success, false);
  assert.equal(FxImportDraftSchema.safeParse({ ...draft(), script: "run" }).success, false);
  assert.equal(FxImportDraftSchema.safeParse({ ...draft(), format: "arbitrary-css" }).success, false);
});

test("preview binds exact evidence metadata and dataset revision without clock-dependent fingerprints", async () => {
  const input = { draft: draft(), expectedRevision: 7 };
  const first = await buildFxImportPreview(input, { now });
  const later = await buildFxImportPreview(input, { now: "2026-10-22T12:00:00Z" });
  assert.deepEqual(first, later); assert.equal(FxImportPreviewSchema.safeParse(first).success, true);
  assert.notEqual((await buildFxImportPreview({ ...input, expectedRevision: 8 }, { now })).previewFingerprint, first.previewFingerprint);
  assert.notEqual((await buildFxImportPreview({ ...input, draft: draft({ raw: `${draft().raw} ` }) }, { now })).previewFingerprint, first.previewFingerprint);
  assert.equal(ConfirmFxImportInputSchema.safeParse({ ...input, previewFingerprint: first.previewFingerprint, reviewed: true, activate: false }).success, true);
  for (const bad of [{ reviewed: false, activate: true }, { reviewed: true, activate: "yes" }, { reviewed: true }, { reviewed: true, activate: true, extra: 1 }]) {
    assert.equal(ConfirmFxImportInputSchema.safeParse({ ...input, previewFingerprint: first.previewFingerprint, ...bad }).success, false);
  }
  assert.equal(PreviewFxImportInputSchema.safeParse({ ...input, expectedRevision: -1 }).success, false);
  assert.equal(ReadFxStateInputSchema.safeParse({}).success, true); assert.equal(ReadFxStateInputSchema.safeParse({ expectedRevision: 7 }).success, true);
  assert.equal(ReadFxStateInputSchema.safeParse({ expectedRevision: "7" }).success, false);
  assert.equal(ActivateFxSnapshotInputSchema.safeParse({ snapshotId: null, expectedRevision: 7, reviewed: true }).success, true);
  assert.equal(ActivateFxSnapshotInputSchema.safeParse({ snapshotId: first.snapshot.fx.id, expectedRevision: 7, reviewed: true }).success, true);
  assert.equal(ActivateFxSnapshotInputSchema.safeParse({ snapshotId: "unknown", expectedRevision: 7, reviewed: true }).success, false);
  assert.equal(FxMutationReceiptSchema.safeParse({ ok: true, revision: 8, snapshotId: first.snapshot.fx.id, activeSnapshotId: null }).success, true);
});

test("fixed query context retains one coherent snapshot and time across later reads", async () => {
  const snapshot = await buildFxReferenceSnapshot(draft(), { now });
  const input = state(snapshot); const output = await validateFxState(input, { now });
  assert.deepEqual(output, input); assert.deepEqual(await validateFxQueryContext(input.context), input.context);
  assert.equal(FxStateSchema.safeParse(state()).success, true);
  const normalized = normalizeCompensation(salary(), { fx: output.context.activeSnapshot?.fx, now: output.context.asOf });
  assert.equal(normalized.reason, "comparable"); assert.equal(normalized.fx?.ageDays, 1);
  const later = await validateFxQueryContext({ ...input.context, asOf: "2026-11-21T12:00:00Z" });
  assert.equal(normalizeCompensation(salary(), { fx: later.activeSnapshot?.fx, now: later.asOf }).reason, "fx-stale");
  assert.equal(input.context.asOf, now);
  const unselected = state(); unselected.context.asOf = "2026-10-21T00:00:00Z"; unselected.snapshots = [snapshot];
  assert.deepEqual(await validateFxState(unselected, { now }), unselected, "an unselected midday import does not alter the fixed query time");
  await assert.rejects(validateFxState(unselected, { now: "2026-10-21T11:59:59Z" }), /fx-future/);
});

test("state refuses mixed revisions, missing/changed active identities, duplicate snapshots and future evidence", async () => {
  const snapshot = await buildFxReferenceSnapshot(draft(), { now });
  for (const change of [
    (value: FxState) => { value.revision++; },
    (value: FxState) => { value.context.datasetRevision++; },
    (value: FxState) => { value.snapshots = []; },
    (value: FxState) => { value.snapshots.push(clone(snapshot)); },
    (value: FxState) => { value.context.activeSnapshot = clone(value.context.activeSnapshot!); value.context.activeSnapshot.fx.ratesToCny.USD = 9; },
    (value: FxState) => { value.context.asOf = "2026-10-21T11:59:59Z"; },
  ]) {
    const value = clone(state(snapshot)); change(value); assert.equal(FxStateSchema.safeParse(value).success, false);
  }
  const bothTampered = clone(state(snapshot)); bothTampered.snapshots[0]!.fx.ratesToCny.USD = 9; bothTampered.context.activeSnapshot = bothTampered.snapshots[0];
  assert.equal(FxStateSchema.safeParse(bothTampered).success, true, "transport shape alone never claims evidence integrity");
  await assert.rejects(validateFxState(bothTampered, { now }), /invalid-fx-reference-snapshot/);
  const context = clone(state(snapshot).context); context.activeSnapshot!.contentHash = "a".repeat(64);
  await assert.rejects(validateFxQueryContext(context), /invalid-fx-reference-snapshot/);
  assert.equal(FxQueryContextSchema.safeParse({ ...state(snapshot).context, asOf: "2026-10-19T12:00:00Z" }).success, false);
  assert.equal(FxReferenceSnapshotSchema.safeParse({ ...snapshot, verified: true }).success, false);
  assert.equal(FxStateSchema.safeParse({ ...state(), snapshots: Array.from({ length: MAX_FX_SNAPSHOTS + 1 }, () => snapshot) }).success, false);
});
