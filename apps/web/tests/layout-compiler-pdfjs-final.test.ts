import assert from "node:assert/strict";
import test from "node:test";
import { A4_PAGE, finalArtifactSha256, inspectFinalLayoutArtifact, type FinalLayoutExpectedDocument } from "../src/lib/layout-compiler";
import { createPdfJsFinalParser } from "../src/lib/layout-compiler/pdfjs-final";

// A static ASCII-only, synthetic PDF contract fixture, assembled in memory for
// the actual installed PDF.js engine. It is not a user resume, a new deliverable,
// a screenshot acceptance, or an injected page/geometry JSON observation.
function fixturePdf(options: { image?: boolean; rotated?: boolean; wrongSize?: boolean } = {}): Uint8Array {
  const text = options.rotated ? "BT /F1 12 Tf 0 1 -1 0 50 780 Tm (Sample Engineer) Tj ET" : "BT /F1 12 Tf 50 790 Td (Sample Engineer) Tj 0 -28 Td (Built 10ms safe.) Tj ET";
  const first = text + (options.image ? " q 40 0 0 40 50 600 cm /Im1 Do Q" : "");
  const second = "BT /F1 12 Tf 50 790 Td (Follow-up note.) Tj ET";
  const stream = (value: string) => `<< /Length ${value.length} >>\nstream\n${value}\nendstream`;
  const box = options.wrongSize ? "0 0 612 792" : "0 0 595.27559 841.88976";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [${box}] /Resources << /Font << /F1 7 0 R >> ${options.image ? "/XObject << /Im1 9 0 R >>" : ""} >> /Contents 4 0 R /Annots [8 0 R] >>`, stream(first),
    `<< /Type /Page /Parent 2 0 R /MediaBox [${box}] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>`, stream(second),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Annot /Subtype /Link /Rect [50 750 180 770] /Border [0 0 0] /A << /S /URI /URI (https://example.invalid/evidence) >> >>",
    "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\nFF0000>\nendstream",
  ];
  let output = "%PDF-1.7\n", index = 0; const offsets = [0];
  for (const object of objects) { offsets.push(output.length); output += `${++index} 0 obj\n${object}\nendobj\n`; }
  const xref = output.length; output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(output);
}
const sdk = await import("pdfjs-dist/legacy/build/pdf.mjs");
const parse = createPdfJsFinalParser(async () => sdk);
const expected: FinalLayoutExpectedDocument = { page: A4_PAGE, bodyText: "Sample Engineer Built 10ms safe. Follow-up note.", links: ["https://example.invalid/evidence"],
  blocks: [{ id: "name", anchor: "profile:displayName", kind: "heading", text: "Sample Engineer", keepWithNext: true },
    { id: "claim", anchor: "claim:c1", kind: "claim", text: "Built 10ms safe." }, { id: "note", kind: "text", text: "Follow-up note." }] };

/** Chromium/Skia's actual CJK export uses Type3 subsets with a negative y
 * FontMatrix and no TextStyle ascent. This is a real PDF char-proc, not geometry
 * injected into the parser and not a guessed 0.8 ascent fallback. */
function type3Pdf(withBBox = true): Uint8Array {
  const content = "BT /F1 12 Tf 50 790 Td (AAAA) Tj ET", glyph = withBBox ? "600 0 0 -800 600 200 d1 0 -800 600 1000 re f" : "600 0 d0 0 -800 600 1000 re f";
  const stream = (value: string) => `<< /Length ${value.length} >>\nstream\n${value}\nendstream`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.27559 841.88976] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>", stream(content),
    `<< /Type /Font /Subtype /Type3 /FontBBox [${withBBox ? "0 -800 600 200" : "0 0 0 0"}] /FontMatrix [0.001 0 0 -0.001 0 0] /CharProcs << /A 6 0 R >> /Encoding << /Type /Encoding /Differences [65 /A] >> /FirstChar 65 /LastChar 65 /Widths [600] /Resources << >> >>`, stream(glyph)];
  let pdf = "%PDF-1.7\n"; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length; pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

test("installed PDF.js parses actual final PDF byte pages, text transformations and URI annotations without network", async () => {
  const originalFetch = globalThis.fetch; let network = 0;
  globalThis.fetch = async () => { network++; throw new Error("No network in actual PDF-byte test"); };
  try {
    const bytes = fixturePdf(), observation = await parse(bytes, expected, new AbortController().signal);
    assert.equal(observation.pageCount, 2); assert.match(observation.bodyText, /Sample Engineer/); assert.deepEqual(observation.links, expected.links);
    const claim = observation.blocks.find(block => block.anchor === "claim:c1"); assert.ok(claim); assert.equal(claim.pageNumber, 1);
    assert.ok(claim.rect.width > 50); assert.ok(claim.rect.height > 10); assert.ok(observation.blocks.some(block => block.pageNumber === 2)); assert.ok(observation.parser.version);
    const scope = { ownerId: "synthetic-owner", sessionGeneration: 1, documentId: "synthetic-doc", revision: "1", contentHash: "synthetic-input" };
    const context = { operationId: "actual-pdf-parser-fixture", scope, format: "pdf" as const, renderBinding: { candidateId: "original", fingerprint: "synthetic-source" } };
    const result = await inspectFinalLayoutArtifact({ context, expected, getCurrentScope: () => scope, parser: parse,
      exportArtifact: async () => ({ ...context, artifact: { bytes, sha256: await finalArtifactSha256(bytes), filename: "synthetic.pdf" },
        receipt: { id: "synthetic-render-receipt", renderer: { name: "Static synthetic PDF fixture", version: "1" }, renderedAt: "2026-11-09T00:00:00Z" } }) });
    assert.equal(result.status, "diagnosed"); if (result.status === "diagnosed") { assert.equal(result.bodyTextCheck.status, "verified"); assert.equal(result.linkCheck.status, "verified"); assert.equal(result.report.source, "pdf-final"); assert.ok(result.report.issues.some(issue => issue.kind === "orphan-page" && issue.pageNumber === 2)); }
    assert.equal(network, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("actual image operators provide their real page geometry, not a fake full-page image or absent-image assumption", async () => {
  const observation = await parse(fixturePdf({ image: true }), expected, new AbortController().signal);
  const image = observation.blocks.find(block => block.kind === "image"); assert.ok(image); assert.equal(image.pageNumber, 1);
  assert.ok(Math.abs(image.rect.width - 40 * 96 / 72) < .01); assert.ok(Math.abs(image.rect.height - 40 * 96 / 72) < .01);
  assert.ok(image.rect.width < 100); assert.equal(image.lines.length, 0);
});

test("unsupported rotated text or mismatched paper is unavailable rather than stretched into the requested print geometry", async () => {
  await assert.rejects(parse(fixturePdf({ rotated: true }), expected, new AbortController().signal), /竖排|旋转/);
  await assert.rejects(parse(fixturePdf({ wrongSize: true }), expected, new AbortController().signal), /纸张尺寸/);
  const abort = new AbortController(); abort.abort(); await assert.rejects(parse(fixturePdf(), expected, abort.signal));
});

test("actual Chromium-style Type3 PDF uses its embedded FontBBox and FontMatrix when TextStyle ascent is absent", async () => {
  const source: FinalLayoutExpectedDocument = { page: A4_PAGE, bodyText: "AAAA", links: [], blocks: [{ id: "type3", anchor: "claim:type3", kind: "claim", text: "AAAA" }] };
  const observation = await parse(type3Pdf(), source, new AbortController().signal);
  assert.equal(observation.pageCount, 1); assert.equal(observation.bodyText, "AAAA");
  const block = observation.blocks.find(item => item.anchor === "claim:type3"); assert.ok(block);
  // Exact PDF font y range [-800,200], transformed by negative .001 matrix,
  // 12 pt and 96/72 viewport: top is baseline-12.8, bottom baseline+3.2.
  const baseline = (841.88976 - 790) * 96 / 72 - 16 * 96 / 25.4;
  assert.ok(Math.abs(block.rect.y - (baseline - 12.8)) < .01); assert.ok(Math.abs(block.rect.height - 16) < .01);
  assert.ok(observation.limitations.some(item => /Type3.*FontBBox/.test(item)));
});
