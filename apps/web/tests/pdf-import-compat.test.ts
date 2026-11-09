import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build, normalizePath } from "vite";

const runFile = promisify(execFile);
const require = createRequire(import.meta.url);
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const parserPath = path.join(webRoot, "src/lib/file-parsers.ts");
const expectedText = "Compatibility fixture only. Local PDF import retains this exact text.";

// Synthetic, in-memory ASCII PDF; no personal file, account or model is used.
function fixturePdf(): Uint8Array {
  const content = `BT /F1 12 Tf 40 750 Td (${expectedText}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.7\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

async function productionSdkPair(): Promise<{ sdk: string; worker: string }> {
  const source = await readFile(parserPath, "utf8");
  const sdk = source.match(/import\s+\*\s+as\s+pdfjsLib\s+from\s+["']([^"']+)["']/)?.[1];
  const worker = source.match(/import\s+pdfWorkerUrl\s+from\s+["']([^"']+)\?url["']/)?.[1];
  assert.ok(sdk, "the production PDF importer must select its installed PDF.js SDK");
  assert.ok(worker, "the production PDF importer must select its locally bundled PDF.js worker");
  return { sdk, worker };
}

test("production PDF import bundles the compatible main SDK and its exact local worker together", async () => {
  const output = await build({
    root: webRoot, configFile: false, logLevel: "silent",
    build: { write: false, minify: false, assetsInlineLimit: 0, rollupOptions: { input: parserPath } },
  });
  assert.ok(!Array.isArray(output) && "output" in output);
  const chunks = output.output.filter(entry => entry.type === "chunk");
  const bundledModules = chunks.flatMap(chunk => Object.keys(chunk.modules).map(normalizePath));
  assert.ok(bundledModules.some(id => /\/pdfjs-dist\/legacy\/build\/pdf\.mjs$/.test(id)), "the production entry must actually bundle the legacy SDK, not only mention it in a comment");
  assert.equal(bundledModules.some(id => /\/pdfjs-dist\/build\/pdf\.mjs$/.test(id)), false, "modern PDF.js must not remain the production import SDK");

  const expectedWorker = await readFile(require.resolve("pdfjs-dist/legacy/build/pdf.worker.min.mjs"));
  const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const workers = output.output.filter(entry => entry.type === "asset")
    .filter(entry => /pdf\.worker\.min[^/]*\.mjs$/.test(entry.fileName));
  assert.equal(workers.length, 1, "one matching worker must be emitted, without a modern/legacy mix");
  assert.equal(digest(workers[0].source), digest(expectedWorker), "the emitted worker bytes must be from the same installed legacy SDK package");
  assert.doesNotMatch(chunks.map(chunk => chunk.code).join("\n"), /https:\/\/unpkg\.com\/pdfjs-dist/, "PDF import must not require a CDN worker");
});

test("the production-selected installed PDF SDK parses a PDF when Uint8Array hex APIs are absent", { timeout: 30_000 }, async () => {
  const pair = await productionSdkPair();
  const sdkUrl = pathToFileURL(require.resolve(pair.sdk)).href;
  const workerUrl = pathToFileURL(require.resolve(pair.worker)).href;
  const script = `
    import assert from "node:assert/strict";
    // A fresh process is essential: legacy PDF.js may install its own polyfills.
    // Removing APIs in the test runner would contaminate other concurrent tests.
    delete Uint8Array.prototype.toHex;
    delete Uint8Array.fromHex;
    assert.equal(typeof Uint8Array.prototype.toHex, "undefined");
    assert.equal(typeof Uint8Array.fromHex, "undefined");
    let networkCalls = 0;
    globalThis.fetch = async () => { networkCalls++; throw new Error("PDF compatibility test forbids network"); };
    const sdk = await import(${JSON.stringify(sdkUrl)});
    sdk.GlobalWorkerOptions.workerSrc = ${JSON.stringify(workerUrl)};
    const loading = sdk.getDocument({
      data: new Uint8Array(${JSON.stringify([...fixturePdf()])}),
      disableFontFace: true, useSystemFonts: true, useWorkerFetch: false,
      isEvalSupported: false, verbosity: 0,
    });
    try {
      const pdf = await loading.promise;
      assert.equal(pdf.numPages, 1);
      const page = await pdf.getPage(1);
      const content = await page.getTextContent();
      const text = content.items.filter(item => "str" in item).map(item => item.str).join(" ").replace(/\\s+/g, " ").trim();
      assert.equal(text, ${JSON.stringify(expectedText)});
      assert.equal(networkCalls, 0);
      console.log("PDF_COMPAT_RESULT " + JSON.stringify({ pages: pdf.numPages, text, networkCalls, sdkVersion: sdk.version }));
    } finally {
      await loading.destroy();
    }
  `;
  // Node uses PDF.js's fake-worker path here. This guards the real installed
  // parser and selected worker bytes; it is NOT a browser/Renderer Worker test
  // and does not claim coverage of canvas rendering or the import dialog UI.
  const { stdout } = await runFile(process.execPath, ["--input-type=module", "-e", script], {
    timeout: 20_000, maxBuffer: 256 * 1024, windowsHide: true,
  });
  const line = stdout.split(/\r?\n/).find(value => value.startsWith("PDF_COMPAT_RESULT "));
  assert.ok(line, "the isolated parser must return actual PDF text, not merely exit without an error");
  const result = JSON.parse(line.slice("PDF_COMPAT_RESULT ".length)) as { pages: number; text: string; networkCalls: number; sdkVersion: string };
  assert.equal(result.pages, 1);
  assert.equal(result.text, expectedText);
  assert.equal(result.networkCalls, 0);
  assert.ok(result.sdkVersion);
});
