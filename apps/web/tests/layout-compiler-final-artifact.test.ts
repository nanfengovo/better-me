import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  A4_PAGE, finalArtifactSha256, inspectFinalLayoutArtifact, normalizeFinalLayoutBody,
  type FinalLayoutExpectedDocument, type FinalLayoutExportArtifact, type FinalLayoutExportContext, type FinalLayoutInspectionOptions, type FinalPdfObservation,
} from "../src/lib/layout-compiler";

const scope = { ownerId: "synthetic-owner", sessionGeneration: 1, documentId: "synthetic-resume", revision: "1", contentHash: "synthetic-source-hash" };
const context: FinalLayoutExportContext = { operationId: "synthetic-final-1", format: "pdf", scope, renderBinding: { candidateId: "original-source", fingerprint: "synthetic-source-payload" } };
const pdfBytes = new TextEncoder().encode("%PDF-1.7 SYNTHETIC_ENVELOPE_ONLY_NOT_A_PDF_FIXTURE");
const docxBytes = new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0, 1]);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const expected: FinalLayoutExpectedDocument = { page: A4_PAGE, bodyText: "参与 SQLite 方案，不负责生产部署，约 10ms [E1]。", links: ["https://example.invalid/evidence"],
  blocks: [{ id: "claim-1", anchor: "claim:c1", kind: "claim", text: "参与 SQLite 方案，不负责生产部署，约 10ms [E1]。" }] };
const observation: FinalPdfObservation = { parser: { name: "Synthetic parser contract fixture, NOT a file parser", version: "1" }, pageCount: 1,
  bodyText: expected.bodyText, links: [...expected.links], fontChecks: [], limitations: ["Synthetic rectangle fixture, not real browser or final-file acceptance."],
  blocks: [{ id: "actual-block-1", anchor: "claim:c1", kind: "claim", text: expected.bodyText, order: 1, pageNumber: 1,
    rect: { x: 0, y: 0, width: 300, height: 16 }, lines: [{ rect: { x: 0, y: 0, width: 300, height: 16 }, text: expected.bodyText }] }] };
function exported(value = context): FinalLayoutExportArtifact {
  return { ...value, scope: { ...value.scope }, renderBinding: { ...value.renderBinding }, artifact: { bytes: pdfBytes, sha256: hash(pdfBytes), filename: "synthetic.pdf" },
    receipt: { id: "host-receipt-1", renderer: { name: "Synthetic trusted exporter fixture", version: "1" }, renderedAt: "2026-11-09T00:00:00Z" } };
}
function options(overrides: Partial<FinalLayoutInspectionOptions> = {}): FinalLayoutInspectionOptions {
  return { context, expected, getCurrentScope: () => scope, exportArtifact: async () => exported(), parser: async () => structuredClone(observation), ...overrides };
}

test("exact artifact bytes are SHA-256 checked before parsing, and final report is separate from DOM estimates", async () => {
  assert.equal(await finalArtifactSha256(pdfBytes), hash(pdfBytes)); let parsed = 0;
  const result = await inspectFinalLayoutArtifact(options({ parser: async bytes => { parsed++; assert.equal(hash(bytes), hash(pdfBytes)); return structuredClone(observation); } }));
  assert.equal(result.status, "diagnosed"); if (result.status !== "diagnosed") return;
  assert.equal(parsed, 1); assert.equal(result.report.source, "pdf-final"); assert.equal(result.report.finalFileCheck, "body-text-verified");
  assert.equal(result.bodyTextCheck.status, "verified"); assert.equal(result.linkCheck.status, "verified"); assert.equal(result.artifact.sha256, hash(pdfBytes));
  assert.ok(result.limitations.some(value => value.includes("未完成逐页PNG"))); assert.notEqual(result.artifact.bytes, pdfBytes);
});

test("a plausible geometry JSON cannot override wrong bytes, operation, candidate, source or renderer provenance", async () => {
  let parses = 0;
  const variants = [{ ...exported(), operationId: "other" }, { ...exported(), renderBinding: { ...context.renderBinding, fingerprint: "different-text" } },
    { ...exported(), scope: { ...scope, sessionGeneration: 2 } }, { ...exported(), artifact: { ...exported().artifact, sha256: "f".repeat(64) } },
    { ...exported(), artifact: { ...exported().artifact, bytes: new TextEncoder().encode("not a pdf at all") } },
    { ...exported(), receipt: { ...exported().receipt, renderer: { name: "", version: "" } } }];
  for (const value of variants) assert.equal((await inspectFinalLayoutArtifact(options({ exportArtifact: async () => value,
    parser: async () => { parses++; return observation; } }))).status, "unavailable");
  assert.equal(parses, 0);
});

test("DOCX requires its original ZIP and a separately hashed trusted paginated PDF; PDF cannot substitute another PDF", async () => {
  const docxContext = { ...context, format: "docx" as const };
  const source = { bytes: docxBytes, sha256: hash(docxBytes), filename: "synthetic.docx" }, paginated = { bytes: pdfBytes, sha256: hash(pdfBytes), filename: "synthetic-paginated.pdf" };
  const docx = { ...exported(docxContext), artifact: source, renderedPdf: paginated };
  const result = await inspectFinalLayoutArtifact(options({ context: docxContext, exportArtifact: async () => docx }));
  assert.equal(result.status, "diagnosed"); if (result.status === "diagnosed") { assert.equal(result.report.source, "docx-final"); assert.equal(result.renderedPdf!.sha256, hash(pdfBytes)); assert.equal(result.artifact.sha256, hash(docxBytes)); }
  assert.equal((await inspectFinalLayoutArtifact(options({ context: docxContext, exportArtifact: async () => ({ ...docx, renderedPdf: undefined }) }))).status, "unavailable");
  assert.equal((await inspectFinalLayoutArtifact(options({ exportArtifact: async () => ({ ...exported(), renderedPdf: paginated }) }))).status, "unavailable");
});

test("all body text, numerical units, negation, ownership, references and entity spelling are checked; mismatches are not repaired", async () => {
  for (const bodyText of [expected.bodyText.replace("10ms", "100ms"), expected.bodyText.replace("不负责", "负责"), expected.bodyText.replace("参与", "主导"),
    expected.bodyText.replace("SQLite", "Rust"), expected.bodyText.replace("[E1]", "[E2]"), expected.bodyText + "额外履历"]) {
    const result = await inspectFinalLayoutArtifact(options({ parser: async () => ({ ...structuredClone(observation), bodyText }) }));
    assert.equal(result.status, "diagnosed"); if (result.status === "diagnosed") { assert.equal(result.bodyTextCheck.status, "mismatch"); assert.equal(result.report.finalFileCheck, "geometry-only"); }
  }
  assert.equal(normalizeFinalLayoutBody("• SQLite\n约 10ms [E1]"), "SQLite约10ms[E1]");
  assert.notEqual(normalizeFinalLayoutBody("Ａ １㎳"), normalizeFinalLayoutBody("A 1ms"), "compatibility glyphs are not silently rewritten by NFKC");
});

test("only standard Latin presentation ligatures and Kangxi radicals receive narrow extraction-compatible decomposition", () => {
  for (const [raw, plain] of [["ﬀ", "ff"], ["ﬁ", "fi"], ["ﬂ", "fl"], ["ﬃ", "ffi"], ["ﬄ", "ffl"], ["ﬅ", "st"], ["ﬆ", "st"],
    ["⼀", "一"], ["⼯", "工"], ["⾼", "高"], ["⿕", "龠"]]) assert.equal(normalizeFinalLayoutBody(raw!), plain);
  for (const [raw, different] of [["Ａ", "A"], ["１", "1"], ["①", "1"], ["Ⅱ", "II"], ["㎳", "ms"], ["²", "2"],
    ["不负责", "负责"], ["参与", "主导"], ["SQLite", "SQLITE"], ["[E1]", "[E2]"], ["\u2eff", "\u2f00"], ["\u2fd6", "\u2fd5"], ["\ufb07", "st"]]) {
    assert.notEqual(normalizeFinalLayoutBody(raw!), normalizeFinalLayoutBody(different!), "out-of-whitelist code points and protected content remain distinct");
  }
});

test("narrow PDF typography compatibility does not conceal changed numbers, entities, negation, ownership or citations", async () => {
  const bodyText = "参与 SQLite 高可用工程 fixture，不负责生产部署，约 10ms [E1]，API II。";
  const extracted = "参与 SQLite ⾼可⽤⼯程 ﬁxture，不负责⽣产部署，约 10ms [E1]，API II。";
  const source = { ...expected, bodyText };
  const inspect = (text: string) => inspectFinalLayoutArtifact(options({ expected: source, parser: async () => ({ ...structuredClone(observation), bodyText: text }) }));
  const compatible = await inspect(extracted); assert.equal(compatible.status, "diagnosed");
  if (compatible.status === "diagnosed") {
    assert.equal(compatible.bodyTextCheck.status, "verified"); assert.match(compatible.bodyTextCheck.method, /FB00.*FB06.*2F00.*2FD5/);
    assert.ok(compatible.limitations.some(value => /连字.*康熙部首/.test(value)));
  }
  for (const text of [extracted.replace("10ms", "100ms"), extracted.replace("SQLite", "Rust"), extracted.replace("不负责", "负责"),
    extracted.replace("参与", "主导"), extracted.replace("[E1]", "[E2]"), extracted.replace("10ms", "１０ms"),
    extracted.replace("[E1]", "[E①]"), extracted.replace("API II", "API Ⅱ"), extracted.replace("10ms", "10㎳")]) {
    const result = await inspect(text); assert.equal(result.status, "diagnosed");
    if (result.status === "diagnosed") assert.equal(result.bodyTextCheck.status, "mismatch");
  }
});

test("intentional radical or ligature symbols in the independent source cannot become verified through a reverse compatibility collision", async () => {
  const inspect = (source: string, actual: string) => inspectFinalLayoutArtifact(options({ expected: { ...expected, bodyText: source },
    parser: async () => ({ ...structuredClone(observation), bodyText: actual }) }));
  for (const [source, actual] of [["部首符号：⼀。", "部首符号：一。"], ["指定名字：ﬁ。", "指定名字：fi。"], ["指定名字：ﬅ。", "指定名字：st。"]]) {
    const result = await inspect(source!, actual!); assert.equal(result.status, "diagnosed");
    if (result.status === "diagnosed") {
      assert.equal(result.bodyTextCheck.status, "unknown"); assert.equal(result.report.finalFileCheck, "geometry-only");
      assert.ok(result.limitations.some(value => value.includes("源正文自身包含")));
    }
    const exact = await inspect(source!, `• ${source!}\n`); assert.equal(exact.status, "diagnosed");
    if (exact.status === "diagnosed") assert.equal(exact.bodyTextCheck.status, "verified", "unchanged intentional symbols remain exact under pre-existing whitespace/list-dot normalization");
  }
  const changedFact = await inspect("⼀；约10ms，不负责生产[E1]。", "一；约100ms，负责生产[E2]。");
  assert.ok(changedFact.status === "diagnosed" && changedFact.bodyTextCheck.status === "mismatch", "a source symbol does not downgrade known fact changes into a plausible compatibility pass");
});

test("unreliable extraction stays unknown, while URI links are independently checked without opening URLs", async () => {
  const result = await inspectFinalLayoutArtifact(options({ parser: async () => ({ ...structuredClone(observation), bodyText: "不可解码\ufffd", links: ["https://other.invalid/"] }) }));
  assert.equal(result.status, "diagnosed"); if (result.status !== "diagnosed") return;
  assert.equal(result.bodyTextCheck.status, "unknown"); assert.equal(result.linkCheck.status, "mismatch"); assert.equal(result.linkCheck.missingCount, 1); assert.equal(result.linkCheck.unexpectedCount, 1);
  const unsafe = await inspectFinalLayoutArtifact(options({ parser: async () => ({ ...structuredClone(observation), links: ["javascript:doNotRun()"] }) }));
  assert.equal(unsafe.status, "diagnosed"); if (unsafe.status === "diagnosed") assert.equal(unsafe.linkCheck.status, "unknown");
});

test("final page geometry must be observed per block, not continuous DOM y relabelled as a PDF", async () => {
  const malformed = structuredClone(observation); delete malformed.blocks[0]!.pageNumber;
  const result = await inspectFinalLayoutArtifact(options({ parser: async () => malformed })); assert.equal(result.status, "unavailable");
  const arbitrary = await inspectFinalLayoutArtifact(options({ parser: async () => ({ ...structuredClone(observation), pageCount: 3000 }) })); assert.equal(arbitrary.status, "unavailable");
});

test("cancellation, timeout and source advances discard late export/parser results without retry", async () => {
  let current = scope, complete!: (value: FinalLayoutExportArtifact) => void, exports = 0;
  const pending = inspectFinalLayoutArtifact(options({ getCurrentScope: () => current, exportArtifact: async () => { exports++; return new Promise(resolve => { complete = resolve; }); } }));
  await Promise.resolve(); current = { ...scope, revision: "2" }; complete(exported()); assert.equal((await pending).status, "stale"); assert.equal(exports, 1);
  const abort = new AbortController(); let parserSignal: AbortSignal | undefined;
  const cancelled = inspectFinalLayoutArtifact(options({ signal: abort.signal, parser: async (_bytes, _expected, signal) => { parserSignal = signal; abort.abort(); return new Promise(() => {}); } }));
  assert.equal((await cancelled).status, "cancelled"); assert.equal(parserSignal?.aborted, true);
  let timeoutSignal: AbortSignal | undefined;
  const timed = await inspectFinalLayoutArtifact(options({ timeoutMs: 10, exportArtifact: async (_context, signal) => { timeoutSignal = signal; return new Promise(() => {}); } }));
  assert.equal(timed.status, "timeout"); assert.equal(timeoutSignal?.aborted, true);
});

test("a source change during a hung export takes precedence over timeout and never produces downloadable old files", async () => {
  let current = scope;
  const pending = inspectFinalLayoutArtifact(options({ getCurrentScope: () => current, timeoutMs: 10, exportArtifact: async () => new Promise(() => {}) }));
  current = { ...scope, ownerId: "other-owner", sessionGeneration: 2 };
  const result = await pending; assert.equal(result.status, "stale"); assert.equal("artifact" in result, false);
});

test("adapter arguments are snapshots and invalid budgets, filenames, large payloads or missing crypto fail closed", async () => {
  const initial = structuredClone(expected), original = JSON.stringify(initial);
  const result = await inspectFinalLayoutArtifact(options({ expected: initial, exportArtifact: async supplied => { supplied.scope.ownerId = "mutated"; return exported(); },
    parser: async (_bytes, supplied) => { supplied.bodyText = "mutation"; return structuredClone(observation); } }));
  assert.equal(result.status, "diagnosed"); if (result.status === "diagnosed") assert.equal(result.bodyTextCheck.status, "verified"); assert.equal(JSON.stringify(initial), original);
  assert.equal((await inspectFinalLayoutArtifact(options({ timeoutMs: 0 }))).status, "unavailable");
  assert.equal((await inspectFinalLayoutArtifact(options({ exportArtifact: async () => ({ ...exported(), artifact: { ...exported().artifact, filename: "../synthetic.pdf" } }) }))).status, "unavailable");
  const property = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  try { Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined }); assert.equal((await inspectFinalLayoutArtifact(options())).status, "unavailable"); }
  finally { if (property) Object.defineProperty(globalThis, "crypto", property); else Reflect.deleteProperty(globalThis, "crypto"); }
});
