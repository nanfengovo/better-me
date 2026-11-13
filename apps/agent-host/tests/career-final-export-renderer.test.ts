import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import test from "node:test";
import { zipSync, strToU8 } from "fflate";
import { createFinalExportRenderer, inspectFinalDocx } from "../src/career-studio/final-export-renderer.js";

const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex"), contentHash = "a".repeat(64), signal = () => new AbortController().signal;
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; };
const contentTypes = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
const relationships = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rDocument" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
function documentXml(body = "<w:p><w:r><w:t>Candidate engineering evidence</w:t></w:r></w:p><w:p><w:r><w:t>Implemented CAS guarded state restoration with explicit unknown outcomes.</w:t></w:r></w:p>") { return `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="907" w:right="907" w:bottom="907" w:left="907"/></w:sectPr></w:body></w:document>`; }
function docx(extra: Record<string, string> = {}) { return Buffer.from(zipSync(Object.fromEntries(Object.entries({ "[Content_Types].xml": contentTypes, "_rels/.rels": relationships, "word/document.xml": documentXml(), ...extra }).map(([name, text]) => [name, strToU8(text)])), { level: 6 })); }
async function temp(t: { after(fn: () => Promise<void> | void): void }) { const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "betterme-final-render-test-"))); t.after(() => fs.rm(directory, { recursive: true, force: true })); return directory; }
const chromiumPath = process.env.BETTERME_TEST_FINAL_CHROMIUM, sofficePath = process.env.BETTERME_TEST_FINAL_SOFFICE, officeRuntime = process.env.BETTERME_TEST_FINAL_SOFFICE_RUNTIME;
const chromiumEnabled = !!chromiumPath, officeEnabled = !!sofficePath && !!officeRuntime && ["darwin", "linux"].includes(process.platform);
const html = Buffer.from(`<!doctype html><html lang="en"><head><meta charset="utf-8"><style>@page{size:A4;margin:16mm}body{font-family:Arial,sans-serif;font-size:12pt;color:#111}h1{font-size:22pt}p{line-height:1.5}</style></head><body><h1>Candidate engineering evidence</h1><p>Implemented CAS guarded state restoration with explicit unknown outcomes.</p><a href="https://synthetic-public.invalid/evidence">Published evidence</a></body></html>`);

test("final renderer unconfigured, malformed binding, oversized input and cancelled owner state never choose a default renderer", async () => {
  const renderer = createFinalExportRenderer({});
  await assert.rejects(renderer.render({ format: "pdf", input: html, inputContentHash: contentHash, signal: signal(), isCurrent: async () => true }), /final_export_renderer_not_configured/);
  await assert.rejects(renderer.render({ format: "pdf", input: html, inputContentHash: "not-a-hash", signal: signal(), isCurrent: async () => true }), /final_export_input_invalid_or_oversized/);
  const configured = createFinalExportRenderer({ chromium: { executablePath: "/synthetic-not-executed" } });
  await assert.rejects(configured.render({ format: "pdf", input: html, inputContentHash: contentHash, signal: signal(), isCurrent: async () => false }), /final_export_stale/);
  const controller = new AbortController(); controller.abort(); await assert.rejects(configured.render({ format: "pdf", input: html, inputContentHash: contentHash, signal: controller.signal, isCurrent: async () => true }), /final_export_cancelled/);
});

test("final renderer enforces process-wide single concurrency, timeout and close even when the Host current callback hangs", async () => {
  const waiting = deferred<boolean>(), started = deferred<void>(), renderer = createFinalExportRenderer({ chromium: { executablePath: "/synthetic-not-executed" } });
  const pending = renderer.render({ format: "pdf", input: html, inputContentHash: contentHash, signal: signal(), isCurrent: async () => { started.resolve(); return waiting.promise; } }); await started.promise;
  await assert.rejects(renderer.render({ format: "pdf", input: html, inputContentHash: contentHash, signal: signal(), isCurrent: async () => true }), /final_export_renderer_busy/); renderer.close(); await assert.rejects(pending, /final_export_cancelled/); waiting.resolve(true);
  const timed = createFinalExportRenderer({ chromium: { executablePath: "/synthetic-not-executed" }, maxActiveMs: 20 }); const before = Date.now();
  await assert.rejects(timed.render({ format: "pdf", input: html, inputContentHash: contentHash, signal: signal(), isCurrent: async () => new Promise<boolean>(() => {}) }), /final_export_cancelled/); assert.ok(Date.now() - before < 1000);
});

test("final DOCX preflight validates a real OOXML ZIP and permits safe external hyperlinks only as inert annotations", async () => {
  await inspectFinalDocx(docx(), signal());
  await inspectFinalDocx(docx({ "word/_rels/document.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rPublic" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://synthetic-public.invalid/evidence" TargetMode="External"/></Relationships>` }), signal());
});

test("final DOCX preflight blocks macros, OLE, external resource/template, active fields, DTD, traversal and ambiguous parts", async () => {
  const unsafe = [docx({ "word/vbaProject.bin": "SYNTHETIC_MACRO_CANARY" }), docx({ "word/document.xml": documentXml("<w:p><w:r><w:instrText>DDEAUTO external dangerous</w:instrText></w:r></w:p>") }), docx({ "word/document.xml": documentXml("<w:altChunk r:id=\"external\"/>") }), docx({ "word/_rels/document.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rExternal" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://synthetic-external.invalid/private.png" TargetMode="External"/></Relationships>` }), docx({ "word/_rels/document.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rExternal" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="file:///Users/synthetic/private" TargetMode="External"/></Relationships>` }), docx({ "word/document.xml": `<!DOCTYPE w:document [<!ENTITY secret SYSTEM "file:///Users/synthetic/private">]>${documentXml()}` }), docx({ "../outside.xml": "<outside/>" }), docx({ "WORD/DOCUMENT.XML": documentXml() })];
  for (const input of unsafe) await assert.rejects(inspectFinalDocx(input, signal()), error => { assert.equal(String(error).includes("CANARY"), false); assert.equal(String(error).includes("/Users/synthetic"), false); return error instanceof Error && error.message.startsWith("final_export_docx_"); });
});

test("final DOCX preflight detects actual inflate/CRC mismatch and compressed zip bombs without extraction", async () => {
  const bomb = docx({ "word/oversized.xml": `<a>${"synthetic".repeat(300_000)}</a>` }); await assert.rejects(inspectFinalDocx(bomb, signal()), /final_export_docx_zip_budget/);
  const corrupted = Buffer.from(docx()), central = corrupted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); assert.ok(central > 0); corrupted.writeUInt32LE((corrupted.readUInt32LE(central + 16) ^ 1) >>> 0, central + 16); await assert.rejects(inspectFinalDocx(corrupted, signal()), /final_export_docx_crc_or_size_mismatch/);
  const forged = Buffer.from(docx()), record = forged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); forged.writeUInt32LE(1, record + 24); await assert.rejects(inspectFinalDocx(forged, signal()), /final_export_docx_/);
});

test("final PDF actual trusted Chromium print binds exact source and output bytes without claiming visual acceptance", { skip: !chromiumEnabled && "No explicitly configured QA Chromium" }, async t => {
  const directory = await temp(t), renderer = createFinalExportRenderer({ chromium: { executablePath: chromiumPath! }, tempRoot: directory }); t.after(() => renderer.close());
  const output = await renderer.render({ format: "pdf", input: html, inputContentHash: contentHash, signal: signal(), isCurrent: async () => true });
  assert.equal(output.sourceSha256, sha(html)); assert.equal(output.renderedSha256, sha(output.pdfBytes)); assert.deepEqual(output.sourceBytes, html); assert.equal(output.inputContentHash, contentHash); assert.equal(output.pdfBytes.subarray(0, 5).toString(), "%PDF-"); assert.match(output.renderer.name, /existing-resume-print-html/); assert.match(output.renderer.version, /sha256:/); assert.equal("visualChecked" in output, false); assert.deepEqual(await fs.readdir(directory), []);
});

test("final PDF actual browser blocks network/file/script/active SVG and never substitutes missing assets", { skip: !chromiumEnabled && "No explicitly configured QA Chromium" }, async t => {
  let requests = 0; const server = createServer((_req, response) => { requests++; response.end("UNAUTHORIZED_NETWORK_CANARY"); }); server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address === "object");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const directory = await temp(t), renderer = createFinalExportRenderer({ chromium: { executablePath: chromiumPath! }, tempRoot: directory }); t.after(() => renderer.close());
  for (const body of [`<img src="http://127.0.0.1:${address.port}/capture">`, `<img src="file:///Users/synthetic/private.png">`, `<script>fetch('http://127.0.0.1:${address.port}/capture')</script>`, `<img src="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"><script>unsafe</script></svg>')}">`]) await assert.rejects(renderer.render({ format: "pdf", input: Buffer.from(`<!doctype html><html><body>${body}</body></html>`), inputContentHash: contentHash, signal: signal(), isCurrent: async () => true }), /final_export_(?:html|external|svg)/);
  assert.equal(requests, 0); assert.deepEqual(await fs.readdir(directory), []);
});

test("final PDF actual Chromium accepts a locally embedded static SVG and rejects late owner generation before publishing bytes", { skip: !chromiumEnabled && "No explicitly configured QA Chromium" }, async t => {
  const directory = await temp(t), renderer = createFinalExportRenderer({ chromium: { executablePath: chromiumPath! }, tempRoot: directory }); t.after(() => renderer.close());
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M1 1H9V9H1Z" fill="black"/></svg>`, embedded = Buffer.from(`<html><body><p>Approved static graphic</p><img width="32" height="32" src="data:image/svg+xml,${encodeURIComponent(svg)}"></body></html>`);
  const output = await renderer.render({ format: "pdf", input: embedded, inputContentHash: contentHash, signal: signal(), isCurrent: async () => true }); assert.equal(output.sourceSha256, sha(embedded));
  let checks = 0; await assert.rejects(renderer.render({ format: "pdf", input: html, inputContentHash: contentHash, signal: signal(), isCurrent: async () => ++checks < 5 }), /final_export_stale/); assert.equal(checks, 5); assert.deepEqual(await fs.readdir(directory), []);
});

test("final DOCX actual bundled isolated LibreOffice paginates exact source with mandatory OS sandbox and clears private profile", { skip: !officeEnabled && "No explicitly configured QA bundled soffice/runtime or unsupported OS sandbox platform" }, async t => {
  const directory = await temp(t), renderer = createFinalExportRenderer({ soffice: { executablePath: sofficePath!, runtimeReadPaths: [officeRuntime!] }, tempRoot: directory }); t.after(() => renderer.close());
  const source = docx(), output = await renderer.render({ format: "docx", input: source, inputContentHash: contentHash, signal: signal(), isCurrent: async () => true });
  assert.equal(output.sourceSha256, sha(source)); assert.deepEqual(output.sourceBytes, source); assert.equal(output.renderedSha256, sha(output.pdfBytes)); assert.equal(output.pdfBytes.subarray(0, 5).toString(), "%PDF-"); assert.match(output.renderer.name, /isolated-bundled-libreoffice/); assert.deepEqual(await fs.readdir(directory), []);
});

test("final DOCX actual macOS isolated conversion embeds the selected public CJK font, not only extractable Unicode with missing glyphs", { skip: (!officeEnabled || process.platform !== "darwin") && "Requires explicitly configured QA bundled soffice/runtime and macOS public CJK fonts" }, async t => {
  const directory = await temp(t), renderer = createFinalExportRenderer({ soffice: { executablePath: sofficePath!, runtimeReadPaths: [officeRuntime!] }, tempRoot: directory }); t.after(() => renderer.close());
  const source = docx({ "word/document.xml": documentXml('<w:p><w:r><w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="Hiragino Sans GB"/></w:rPr><w:t>中文可读验收：获取租约并保留撤销边界。 English.</w:t></w:r></w:p>') });
  const output = await renderer.render({ format: "docx", input: source, inputContentHash: contentHash, signal: signal(), isCurrent: async () => true });
  // Unicode extraction alone passes even for tofu/blank output. The selected
  // CJK font must actually be embedded; page-image QA remains a separate step.
  const hasEmbeddedCjk = output.pdfBytes.toString("latin1").split("endobj").some(object => /\/Type\s*\/FontDescriptor/.test(object) && /\/FontName\s*\/[^\s/<>]*HiraginoSansGB/.test(object) && /\/FontFile(?:2|3)?\s+\d+\s+0\s+R/.test(object));
  assert.ok(hasEmbeddedCjk, "The selected public CJK font was not embedded"); assert.deepEqual(output.sourceBytes, source); assert.deepEqual(await fs.readdir(directory), []);
});

test("final DOCX actual in-process conversion cancellation terminates its process group and never returns late bytes", { skip: !officeEnabled && "No explicitly configured QA bundled soffice/runtime or unsupported OS sandbox platform" }, async t => {
  const directory = await temp(t), renderer = createFinalExportRenderer({ soffice: { executablePath: sofficePath!, runtimeReadPaths: [officeRuntime!] }, tempRoot: directory }), controller = new AbortController(); t.after(() => renderer.close());
  let checks = 0; await assert.rejects(renderer.render({ format: "docx", input: docx(), inputContentHash: contentHash, signal: controller.signal, isCurrent: async () => { if (++checks === 3) setTimeout(() => controller.abort(), 30); return true; } }), /final_export_cancelled/); assert.ok(checks >= 3); assert.deepEqual(await fs.readdir(directory), []);
});
