import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { previewLegacyImport, applyLegacyBindings, resolveLegacyCountryCode, LegacyImportError, type LegacyImportPreview } from "../src/legacy.ts";
import { defineTool, createToolRegistry, ToolError, type ToolDefinition, type TrustedToolContext, type ToolEffect, type ToolResult } from "../src/tools.ts";
import { AtlasDatasetSchema } from "../src/schema.ts";

const AT = "2026-10-17T02:00:00.000Z";
const LATER = "2026-10-18T03:00:00.000Z";
const PRIVATE = "PRIVATE_SENTINEL_DO_NOT_INDEX_829461";
function fixture() {
  return {
    schemaVersion: 1, revision: 3, updatedAt: LATER,
    facts: [{ text: PRIVATE }], apiKey: PRIVATE,
    jobs: [{
      id: "legacy-one", company: "合成示例公司", title: "工程师", description: "公开职责原文\n保留逐字正文。", sourceUrl: "https://careers.example.com/jobs/42?utm_source=test",
      applicationUrl: "https://apply.example.com/?job=42", discoveryUrl: "https://github.com/example/jobs", sourcePlatform: "合成官网",
      publisherType: "company", market: "domestic", workMode: "hybrid", employmentType: "social", location: { country: "中国", region: "上海", city: "上海" },
      remoteEligibleRegions: [], salaryText: "20k–30k，薪数未披露", sourceJobId: "42", sourcePublishedText: "2026年10月15日",
      sourcePublishedAt: "2026-10-15T00:00:00+08:00", sourceUpdatedAt: AT,
      applicationDeadlineText: "月底", firstDiscoveredAt: AT, collectedAt: LATER,
      lastVerifiedAt: AT, lastVerificationMethod: "source-read", status: "open",
      application: { stage: "interview", notes: PRIVATE, nextAction: PRIVATE, channel: PRIVATE, contactName: PRIVATE, contactDetails: PRIVATE, history: [{ id: PRIVATE, notes: PRIVATE, stage: "interview", changedAt: LATER }], communications: [{ contact: PRIVATE, summary: PRIVATE }] },
      materials: [{ id: PRIVATE, resumeViewId: PRIVATE, resumeName: PRIVATE, markdown: `# ${PRIVATE}`, createdAt: AT }],
      unknownPrivateField: { key: PRIVATE }, createdAt: AT, updatedAt: LATER,
    }],
  };
}
function receipt(preview: LegacyImportPreview) { return { ok: true as const, jobIds: preview.dataset.jobs.map((job) => job.id), snapshotIds: preview.dataset.snapshots.map((snapshot) => snapshot.id) }; }
function applyOptions(preview: LegacyImportPreview) { return { expectedRevision: preview.sourceRevision, expectedFingerprint: preview.sourceFingerprint, privateBindings: preview.privateBindings, receipt: receipt(preview) }; }

test("legacy preview whitelists public fields, preserves the original library and stable references", async () => {
  const original = fixture();
  const before = JSON.stringify(original);
  const preview = await previewLegacyImport(original);
  assert.equal(JSON.stringify(original), before);
  assert.equal(AtlasDatasetSchema.safeParse(preview.dataset).success, true);
  assert.equal(JSON.stringify({ dataset: preview.dataset, warnings: preview.warnings }).includes(PRIVATE), false);
  assert.equal(preview.dataset.jobs[0]!.description, original.jobs[0]!.description);
  assert.equal(preview.dataset.snapshots[0]!.text, original.jobs[0]!.description);
  assert.equal(preview.dataset.listings[0]!.canonicalUrl, "https://careers.example.com/jobs/42");
  assert.equal(preview.dataset.listings[0]!.applicationUrl, original.jobs[0]!.applicationUrl);
  assert.deepEqual(preview.dataset.listings[0]!.discoveredViaUrls, [original.jobs[0]!.discoveryUrl]);
  assert.equal(preview.dataset.observations[0]!.sourcePublishedAt, "2026-10-14T16:00:00.000Z");
  assert.equal(preview.dataset.observations[0]!.sourceUpdatedAt, AT);
  assert.equal(preview.dataset.observations[0]!.fetchedAt, LATER);
  assert.equal(preview.privateBindings[0]!.oldOpportunityId, "legacy-one");
  assert.deepEqual(await previewLegacyImport(original), preview);
});

test("historical source-read / manual status never creates ownership or fresh availability verification", async () => {
  for (const method of ["source-read", "manual"] as const) {
    const original = fixture(); original.jobs[0]!.lastVerificationMethod = method;
    const { dataset } = await previewLegacyImport(original);
    assert.equal(dataset.companies[0]!.ultimateControllers.verification, "unknown");
    assert.deepEqual(dataset.companies[0]!.ultimateControllers.value, []);
    assert.deepEqual(dataset.companies[0]!.domains, []);
    assert.equal(dataset.jobs[0]!.status, "unknown");
    assert.equal(dataset.observations[0]!.availability, "unknown");
    assert.equal(dataset.observations[0]!.availabilityVerifiedAt, undefined);
    assert.match(dataset.observations[0]!.warnings.join(" "), /status=open/);
    assert.match(dataset.observations[0]!.warnings.join(" "), new RegExp(method));
    assert.equal(dataset.locations[0]!.coordinates, undefined);
    assert.equal(dataset.compensations[0]!.min, undefined);
    assert.equal(dataset.compensations[0]!.currency, undefined);
  }
});

test("manual opportunities do not invent URLs, snapshots, country codes or coordinates", async () => {
  const original = fixture();
  Object.assign(original.jobs[0]!, { sourceUrl: "", applicationUrl: "", discoveryUrl: "", sourceJobId: "", description: "", salaryText: "", location: { country: "", region: "", city: "" } });
  const result = await previewLegacyImport(original);
  assert.equal(result.dataset.sources[0]!.sourceId, "manual-source");
  assert.equal(result.dataset.sources[0]!.entryUrl, undefined);
  assert.equal(result.dataset.listings[0]!.canonicalUrl, undefined);
  assert.equal(result.dataset.listings[0]!.applicationUrl, undefined);
  assert.ok(result.dataset.listings[0]!.sourceRecordId);
  assert.deepEqual(result.dataset.snapshots, []);
  assert.equal(result.privateBindings[0]!.snapshotId, undefined);
  assert.deepEqual(result.dataset.locations, []);
  assert.ok(result.warnings.some((warning) => warning.code === "manual-source"));
});

test("legacy country aliases are exact and preserve separate work jurisdictions", async () => {
  for (const [country, expected] of [["中国", "CN"], ["中国内地", "CN"], ["  Mainland   China  ", "CN"], ["ＣＮ", "CN"],
    ["中国香港", "HK"], ["Hong Kong", "HK"], ["澳门", "MO"], ["Taiwan", "TW"], ["uSa", "US"], ["英国", "GB"], ["新加坡", "SG"], ["India", "IN"], ["印度", "IN"]]) {
    assert.equal(resolveLegacyCountryCode(country!), expected);
    const original = fixture(); original.jobs[0]!.location.country = country!;
    const { dataset } = await previewLegacyImport(original);
    assert.equal(dataset.locations[0]!.countryCode, expected);
    assert.equal(dataset.locations[0]!.precision, "unknown"); assert.equal(dataset.locations[0]!.coordinates, undefined);
  }
  for (const country of ["", "上海", "Europe", "全球", "中国/美国", "美国公司", "CN/US", "domestic", "China - Shanghai"]) {
    assert.equal(resolveLegacyCountryCode(country), undefined);
    const original = fixture(); original.jobs[0]!.location.country = country;
    const { dataset } = await previewLegacyImport(original);
    assert.equal(dataset.locations[0]!.countryCode, undefined, country);
  }
});

test("market and city labels never become country evidence or override an explicit saved country", async () => {
  const original = fixture(); original.jobs[0]!.location.country = "";
  const unknown = await previewLegacyImport(original);
  assert.equal(unknown.dataset.locations[0]!.countryCode, undefined, "domestic market plus Shanghai city is insufficient");
  original.jobs[0]!.location.country = "United States";
  const explicit = await previewLegacyImport(original);
  assert.equal(explicit.dataset.locations[0]!.countryCode, "US", "explicit country is preserved despite domestic market and Shanghai text");
  assert.match(explicit.dataset.locations[0]!.raw, /United States/);
});

test("public changes create new immutable observations while private edits do not change public IDs", async () => {
  const original = fixture();
  const before = await previewLegacyImport(original);
  original.jobs[0]!.application.notes = "other private note";
  original.jobs[0]!.materials[0]!.markdown += "private update";
  const privateChange = await previewLegacyImport(original);
  assert.deepEqual(privateChange.dataset, before.dataset);
  assert.notEqual(privateChange.sourceFingerprint, before.sourceFingerprint);
  original.jobs[0]!.sourcePublishedText = "源发布文案已变化";
  const publicChange = await previewLegacyImport(original);
  assert.equal(publicChange.dataset.jobs[0]!.id, before.dataset.jobs[0]!.id);
  assert.notEqual(publicChange.dataset.observations[0]!.id, before.dataset.observations[0]!.id);
});

test("legacy preview rejects malformed, duplicate, oversized and unsafe inputs without private error details", async () => {
  const variants: unknown[] = [null, [], { ...fixture(), schemaVersion: 999 }, { ...fixture(), revision: -1 }, { ...fixture(), jobs: [{ ...fixture().jobs[0], title: null, notes: PRIVATE }] }];
  const duplicate = fixture(); duplicate.jobs.push({ ...duplicate.jobs[0]! }); variants.push(duplicate);
  const huge = fixture(); huge.apiKey = PRIVATE.repeat(120_000); variants.push(huge);
  for (const url of ["javascript:alert(1)", "file:///private", "https://user:secret@example.com/", "http://127.0.0.1/private", "https://169.254.169.254/", "http://[::1]/private", "http://[fc00::1]/private", `https://example.com/jobs?apiKey=${PRIVATE}`, `https://example.com/jobs#access_token=${PRIVATE}`]) {
    const original = fixture(); original.jobs[0]!.sourceUrl = url; variants.push(original);
  }
  for (const variant of variants) {
    await assert.rejects(previewLegacyImport(variant), (error: unknown) => {
      assert.ok(error instanceof LegacyImportError);
      assert.equal(JSON.stringify({ message: error.message, ...error }).includes(PRIVATE), false);
      return true;
    });
  }
  const publicIpv6 = fixture(); publicIpv6.jobs[0]!.sourceUrl = "https://[2606:4700:4700::1111]/jobs/42";
  assert.equal((await previewLegacyImport(publicIpv6)).dataset.listings[0]!.canonicalUrl, publicIpv6.jobs[0]!.sourceUrl);
});

test("imported getters / toJSON are not executed and timezone-less source dates follow v1 convention", async () => {
  const getterLibrary = fixture(); let called = false;
  Object.defineProperty(getterLibrary.jobs[0], "hiddenPrivate", { enumerable: true, get() { called = true; return PRIVATE; } });
  await assert.rejects(previewLegacyImport(getterLibrary), LegacyImportError);
  assert.equal(called, false);
  const inheritedHook = fixture();
  Object.setPrototypeOf(inheritedHook.jobs, { toJSON() { called = true; return PRIVATE; } });
  await assert.rejects(previewLegacyImport(inheritedHook), LegacyImportError);
  assert.equal(called, false);
  const original = fixture(); original.jobs[0]!.collectedAt = "2026-10-17T10:00:00";
  const result = await previewLegacyImport(original);
  assert.equal(result.dataset.observations[0]!.fetchedAt, AT);
  assert.equal(original.jobs[0]!.collectedAt, "2026-10-17T10:00:00");
});

test("binding applies only confirmed receipts at the same revision/fingerprint and is idempotent", async () => {
  const original = fixture(); const before = JSON.stringify(original); const preview = await previewLegacyImport(original);
  const first = await applyLegacyBindings(original, applyOptions(preview));
  assert.equal(first.library, original);
  assert.equal(JSON.stringify(first.library), before);
  const second = await applyLegacyBindings(original, { ...applyOptions(preview), previous: first.references });
  assert.equal(second.references, first.references);
  assert.deepEqual(first.references.bindings, preview.privateBindings);
  assert.equal(original.jobs[0]!.materials[0]!.markdown, `# ${PRIVATE}`);
  assert.equal(original.jobs[0]!.id, "legacy-one");
  for (const options of [
    { ...applyOptions(preview), expectedRevision: 2 },
    { ...applyOptions(preview), expectedFingerprint: "0".repeat(64) },
    { ...applyOptions(preview), receipt: { ok: false as const } },
    { ...applyOptions(preview), receipt: { ok: true as const, jobIds: [], snapshotIds: [] } },
    { ...applyOptions(preview), privateBindings: [] },
    { ...applyOptions(preview), privateBindings: [{ ...preview.privateBindings[0]!, jobId: "job_forged" }], receipt: { ok: true as const, jobIds: ["job_forged"], snapshotIds: preview.dataset.snapshots.map((snapshot) => snapshot.id) } },
  ]) await assert.rejects(applyLegacyBindings(original, options), LegacyImportError);
  const editedWithoutSave = structuredClone(original); editedWithoutSave.jobs[0]!.materials[0]!.markdown += " newer";
  await assert.rejects(applyLegacyBindings(editedWithoutSave, applyOptions(preview)), (error: unknown) => error instanceof LegacyImportError && error.code === "stale-version");
  assert.equal(JSON.stringify(original), before);
});

test("async migration hashes use one snapshot and reject live edits made while binding is pending", async () => {
  const original = fixture();
  original.jobs.push({ ...structuredClone(original.jobs[0]!), id: "legacy-two", sourceUrl: "https://careers.example.com/jobs/43", sourceJobId: "43", title: "原第二岗位" });
  const pending = previewLegacyImport(original);
  original.jobs[1]!.title = "稍后编辑的第二岗位";
  const preview = await pending;
  assert.equal(preview.dataset.jobs[1]!.title.value, "原第二岗位");
  const currentPreview = await previewLegacyImport(original);
  const applying = applyLegacyBindings(original, applyOptions(currentPreview));
  original.jobs[0]!.application.notes += "during hashing";
  await assert.rejects(applying, (error: unknown) => error instanceof LegacyImportError && error.code === "stale-version");
});

function context(overrides: Partial<TrustedToolContext> = {}): TrustedToolContext {
  return { requestId: "req-1", actorScope: "local-ui:test", signal: new AbortController().signal, budget: { requests: 3, timeoutMs: 1000, bytes: 100_000 }, allowedEffects: ["read-index"], ...overrides };
}
function tool(effect: ToolEffect = "read-index", execute: (input: { count: number }) => unknown = ({ count }) => ({ total: count })) {
  return defineTool({ name: "jobs.count", version: 1, description: "合成共享服务工具", inputSchema: z.object({ count: z.number().int().min(0) }).strict(), outputSchema: z.object({ total: z.number().int() }).strict(), effect, execute });
}
function errorCode(result: ToolResult) { assert.equal(result.ok, false); return result.ok ? undefined : result.error.code; }

test("same actual tool can be called through UI/HTTP/Agent-style wrappers with schema validation", async () => {
  const registry = createToolRegistry([tool()]);
  for (const actorScope of ["ui:test", "http:test", "agent:test"]) {
    const result = await registry.execute("jobs.count", { count: 2 }, context({ actorScope }));
    assert.deepEqual(result, { ok: true, requestId: "req-1", value: { total: 2 } });
  }
  assert.equal(errorCode(await registry.execute("jobs.count", { count: "2" }, context())), "invalid-input");
  assert.equal(errorCode(await registry.execute("jobs.count", { count: 2, allowedEffects: ["local-write"] }, context())), "invalid-input");
  assert.equal(errorCode(await registry.execute("missing.tool", {}, context())), "unsupported-capability");
  assert.deepEqual(registry.list().map(({ name, effect, version }) => ({ name, effect, version })), [{ name: "jobs.count", effect: "read-index", version: 1 }]);
});

test("registry rejects duplicate names and schemas that cannot validate runtime values", () => {
  assert.throws(() => createToolRegistry([tool(), tool()]), ToolError);
  assert.throws(() => defineTool({ ...tool(), inputSchema: {} } as ToolDefinition), ToolError);
  assert.throws(() => defineTool(null as unknown as ToolDefinition), ToolError);
  assert.throws(() => defineTool({ ...tool(), name: "Jobs unsafe" }), ToolError);
});

test("effect authorization and idempotency belong to the trusted executor", async () => {
  let calls = 0;
  const registry = createToolRegistry([tool("local-write", ({ count }) => { calls++; return { total: count }; })]);
  assert.equal(errorCode(await registry.execute("jobs.count", { count: 2 }, context())), "not-authorized");
  assert.equal(calls, 0);
  const allowed = context({ allowedEffects: ["local-write"], idempotencyKey: "write-1" });
  const first = await registry.execute("jobs.count", { count: 2 }, allowed);
  const repeated = await registry.execute("jobs.count", { count: 2 }, { ...allowed, requestId: "req-2" });
  assert.equal(first.ok, true); assert.equal(repeated.ok, true); assert.equal(repeated.requestId, "req-2"); assert.equal(calls, 1);
  assert.equal(errorCode(await registry.execute("jobs.count", { count: 3 }, allowed)), "idempotency-conflict");
  assert.equal(errorCode(await registry.execute("jobs.count", { count: 2 }, context({ allowedEffects: ["local-write"] }))), "invalid-context");
  await registry.execute("jobs.count", { count: 2 }, { ...allowed, actorScope: "another-user" });
  assert.equal(calls, 2);
});

test("callers cannot mutate a successful receipt to poison later idempotent replays", async () => {
  const registry = createToolRegistry([tool("local-write")]);
  const trusted = context({ allowedEffects: ["local-write"], idempotencyKey: "receipt-mutation" });
  const first = await registry.execute<{ total: number }>("jobs.count", { count: 2 }, trusted);
  assert.ok(first.ok); first.value.total = 999;
  const replay = await registry.execute<{ total: number }>("jobs.count", { count: 2 }, trusted);
  assert.ok(replay.ok); assert.equal(replay.value.total, 2);
});

test("tool output never forwards internal exception text and rejects non-JSON or invalid outputs", async () => {
  const invalidOutputs: unknown[] = [{ total: "2" }, undefined, { total: NaN }, new Date(), { total: 2n }, { total: 2, secret: PRIVATE }];
  const cycle: Record<string, unknown> = {}; cycle.self = cycle; invalidOutputs.push(cycle);
  for (const output of invalidOutputs) {
    const registry = createToolRegistry([tool("read-index", () => output)]);
    assert.equal(errorCode(await registry.execute("jobs.count", { count: 2 }, context())), "invalid-output");
  }
  const registry = createToolRegistry([tool("read-index", () => { throw new Error(PRIVATE); })]);
  const result = await registry.execute("jobs.count", { count: 2 }, context());
  assert.equal(errorCode(result), "internal-error"); assert.equal(JSON.stringify(result).includes(PRIVATE), false);
});

test("typed unsupported, needs-human, stale and source failures remain actionable and contain fixed text", async () => {
  for (const code of ["unsupported-capability", "needs-auth", "needs-human-verification", "stale-version", "source-changed"] as const) {
    const registry = createToolRegistry([tool("read-index", () => { throw new ToolError(code); })]);
    assert.equal(errorCode(await registry.execute("jobs.count", { count: 2 }, context())), code);
  }
});

test("budget tracks injected adapter requests and bytes and validates serialized response size", async () => {
  const accounted = defineTool({ ...tool(), execute: (_input, ctx) => { ctx.consumeRequests(2); ctx.consumeBytes(10); return { total: 1 }; } });
  assert.equal(errorCode(await createToolRegistry([accounted]).execute("jobs.count", { count: 1 }, context({ budget: { requests: 1, timeoutMs: 1000, bytes: 100 } }))), "budget-exceeded");
  assert.equal(errorCode(await createToolRegistry([accounted]).execute("jobs.count", { count: 1 }, context({ budget: { requests: 3, timeoutMs: 1000, bytes: 15 } }))), "budget-exceeded");
  assert.equal(errorCode(await createToolRegistry([tool()]).execute("jobs.count", { count: 1 }, context({ budget: { requests: 3, timeoutMs: 1000, bytes: 3 } }))), "budget-exceeded");
});

test("JSON budget includes UTF-8 and escaping, and accessor inputs never execute a handler", async () => {
  const resultTool = defineTool({ name: "jobs.text", version: 1, description: "合成字节边界工具", effect: "read-index", inputSchema: z.object({}).strict(), outputSchema: z.string(), execute: () => "中\n😀" });
  const registry = createToolRegistry([resultTool]);
  // Quotes + Chinese UTF-8 + escaped newline + supplementary code point = 11 bytes.
  assert.equal(errorCode(await registry.execute("jobs.text", {}, context({ budget: { requests: 0, timeoutMs: 1000, bytes: 10 } }))), "budget-exceeded");
  assert.equal((await registry.execute("jobs.text", {}, context({ budget: { requests: 0, timeoutMs: 1000, bytes: 11 } }))).ok, true);
  let accessed = false; let called = false;
  const input = Object.defineProperty({}, "count", { enumerable: true, get() { accessed = true; return 1; } });
  const guarded = createToolRegistry([tool("read-index", () => { called = true; return { total: 1 }; })]);
  assert.equal(errorCode(await guarded.execute("jobs.count", input, context())), "invalid-input");
  assert.equal(accessed, false); assert.equal(called, false);
  const huge = defineTool({ ...resultTool, execute: () => "x".repeat(1_000_000) });
  assert.equal(errorCode(await createToolRegistry([huge]).execute("jobs.text", {}, context({ budget: { requests: 0, timeoutMs: 1000, bytes: 100 } }))), "budget-exceeded");
});

test("pre-cancellation, in-flight cancellation and timeouts isolate late results", async () => {
  const controller = new AbortController(); controller.abort(); let called = false;
  const registry = createToolRegistry([tool("read-index", () => { called = true; return { total: 1 }; })]);
  assert.equal(errorCode(await registry.execute("jobs.count", { count: 1 }, context({ signal: controller.signal }))), "cancelled");
  assert.equal(called, false);
  let handlerSignal: AbortSignal | undefined;
  const hanging = defineTool({ ...tool(), execute: (_input, ctx) => { handlerSignal = ctx.signal; return new Promise<{ total: number }>(() => {}); } });
  const active = new AbortController();
  const pending = createToolRegistry([hanging]).execute("jobs.count", { count: 1 }, context({ signal: active.signal }));
  setTimeout(() => active.abort(), 10);
  assert.equal(errorCode(await pending), "cancelled"); assert.equal(handlerSignal?.aborted, true);
  const timeout = await createToolRegistry([hanging]).execute("jobs.count", { count: 1 }, context({ budget: { requests: 1, timeoutMs: 10, bytes: 1000 } }));
  assert.equal(errorCode(timeout), "timeout"); assert.equal(handlerSignal?.aborted, true);
});

test("a synchronous handler that overruns its deadline cannot publish a successful late result", async () => {
  const registry = createToolRegistry([tool("read-index", () => {
    const until = Date.now() + 20;
    while (Date.now() < until) { /* Simulate one bounded CPU-bound service call. */ }
    return { total: 1 };
  })]);
  assert.equal(errorCode(await registry.execute("jobs.count", { count: 1 }, context({ budget: { requests: 0, timeoutMs: 5, bytes: 1000 } }))), "timeout");
});

test("concurrent identical writes share one execution while each caller can cancel its own wait", async () => {
  let calls = 0; let resolve!: (value: { total: number }) => void;
  const deferred = defineTool({ ...tool("local-write"), execute: () => { calls++; return new Promise<{ total: number }>((done) => { resolve = done; }); } });
  const registry = createToolRegistry([deferred]);
  const base = context({ allowedEffects: ["local-write"], idempotencyKey: "same" });
  const first = registry.execute("jobs.count", { count: 2 }, base);
  const abort = new AbortController();
  const second = registry.execute("jobs.count", { count: 2 }, { ...base, signal: abort.signal, requestId: "req-2" });
  abort.abort();
  assert.equal(errorCode(await second), "cancelled");
  // Let the independently owned first execution finish.
  await new Promise<void>((done) => setTimeout(done, 0));
  resolve({ total: 2 });
  assert.equal((await first).ok, true); assert.equal(calls, 1);
  assert.equal((await registry.execute("jobs.count", { count: 2 }, base)).ok, true); assert.equal(calls, 1);
});
