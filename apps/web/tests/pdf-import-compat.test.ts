import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build, normalizePath } from "vite";

const require = createRequire(import.meta.url);
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const parserPath = path.join(webRoot, "src/lib/file-parsers.ts");
const expectedText = "Compatibility fixture only. Local PDF import retains this exact text.";

// This plain-Node child intentionally does not need the parent's TS/test loader.
// The handshake distinguishes startup, SDK import, parsing and cleanup failures.
function runIsolatedPdfScript(script: string, options: { environment?: NodeJS.ProcessEnv; runTimeoutMs?: number; signal?: AbortSignal } = {}) {
  return new Promise<{ result: unknown; stages: string[] }>((resolve, reject) => {
    const environment = { ...(options.environment ?? process.env) };
    const runnerKeys = new Set(["NODE_OPTIONS", "NODE_TEST_CONTEXT", "NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE"]);
    for (const name of Object.keys(environment)) if (runnerKeys.has(name.toUpperCase())) delete environment[name];
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      const start = new Promise(resolve => process.once("message", message => {
        if (message?.type !== "run") throw new Error("Unexpected PDF child start message");
        resolve();
      }));
      process.send({ type: "ready" });
      await start;
      const reportStage = stage => process.send({ type: "stage", stage });
      const finish = result => process.send({ type: "result", result });
      ${script}
      process.disconnect();
    `], { env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    const stages: string[] = [];
    let ready = false, received = false, closed = false;
    let result: unknown, failure: string | undefined;
    let stdout = "", stderr = "", outputBytes = 0;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: string) => {
      if (closed || failure) return;
      failure = reason;
      child.kill();
      killTimer = setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 1_000);
      killTimer.unref();
    };
    let timer = setTimeout(() => stop("startup deadline exceeded"), 5_000);
    const abort = () => stop("aborted");
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    for (const [stream, append] of [
      [child.stdout, (value: string) => { stdout += value; }],
      [child.stderr, (value: string) => { stderr += value; }],
    ] as const) stream.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes <= 256 * 1024) append(chunk.toString());
      else stop("output limit exceeded");
    });
    child.on("message", message => {
      if (failure || closed || typeof message !== "object" || message === null) return;
      if ("type" in message && message.type === "ready" && !ready) {
        ready = true;
        stages.push("ready");
        clearTimeout(timer);
        timer = setTimeout(() => stop("execution deadline exceeded"), options.runTimeoutMs ?? 20_000);
        child.send({ type: "run" }, error => { if (error) stop("start message failed"); });
      } else if (ready && "type" in message && message.type === "stage" && "stage" in message && typeof message.stage === "string") {
        stages.push(message.stage);
      } else if (ready && "type" in message && message.type === "result" && "result" in message && !received) {
        received = true;
        result = message.result;
      } else stop("unexpected child protocol message");
    });
    child.once("error", error => stop(`spawn error: ${error.message}`));
    child.once("close", (code, signal) => {
      closed = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      if (!failure && code === 0 && signal === null && received) resolve({ result, stages });
      else reject(Object.assign(new Error(`PDF compatibility child ${failure ?? (received ? "did not exit successfully" : "exited without a result")}; stage=${stages.at(-1) ?? "not-ready"}; exit=${code}; signal=${signal}; stdout=${stdout}; stderr=${stderr}`), { stages, closed, resultReceived: received, exitCode: code, signal }));
    });
  });
}

test("the isolated PDF child does not execute inherited Node startup hooks", async t => {
  // Only presence is recorded; startup-hook paths and environment values may be private.
  t.diagnostic(`PDF_COMPAT_PARENT ${JSON.stringify({ nodeOptionsPresent: !!process.env.NODE_OPTIONS, runnerContextPresent: !!process.env.NODE_TEST_CONTEXT, channelFdPresent: !!process.env.NODE_CHANNEL_FD, importArgPresent: process.execArgv.some(value => /^--(?:import|loader|experimental-loader)(?:=|$)/.test(value)) })}`);
  const poison = `--import=data:text/javascript,${encodeURIComponent('throw new Error("PDF_COMPAT_INHERITED_PRELOAD_EXECUTED")')}`;
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_OPTIONS: poison, nOdE_OpTiOnS: poison,
    NODE_TEST_CONTEXT: "child-v8", NODE_CHANNEL_FD: "999999", NODE_CHANNEL_SERIALIZATION_MODE: "json",
    PDF_COMPAT_SENTINEL: "preserved",
  };
  const before = { ...environment };
  const { result, stages } = await runIsolatedPdfScript(`finish({
    controls: Object.keys(process.env).filter(name => ["NODE_OPTIONS", "NODE_TEST_CONTEXT", "NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE"].includes(name.toUpperCase())),
    sentinel: process.env.PDF_COMPAT_SENTINEL,
  });`, { environment });
  assert.deepEqual(result, { controls: [], sentinel: "preserved" });
  assert.deepEqual(stages, ["ready"]);
  assert.equal(Object.keys(environment).length === Object.keys(before).length && Object.entries(before).every(([name, value]) => environment[name] === value), true, "the parent environment object must not be mutated");
});

test("the isolated PDF child requires a result and normal exit, with observable bounded failure", async t => {
  const cases = [
    { name: "a result followed by an abnormal exit is not success", script: 'finish({ incomplete: true }); process.exitCode = 7;', message: /did not exit successfully; stage=ready; exit=7/, stages: ["ready"], resultReceived: true, runTimeoutMs: 20_000 },
    { name: "normal exit without a result is not success", script: 'reportStage("sdk-imported");', message: /exited without a result; stage=sdk-imported; exit=0/, stages: ["ready", "sdk-imported"], resultReceived: false, runTimeoutMs: 20_000 },
    { name: "a stalled SDK stage is killed and closed", script: 'reportStage("sdk-imported"); await new Promise(() => setInterval(() => {}, 1_000));', message: /execution deadline exceeded; stage=sdk-imported/, stages: ["ready", "sdk-imported"], resultReceived: false, runTimeoutMs: 500 },
    { name: "receiving a result does not bypass a child that never closes", script: 'finish({ incomplete: true }); setInterval(() => {}, 1_000);', message: /execution deadline exceeded; stage=ready/, stages: ["ready"], resultReceived: true, runTimeoutMs: 500 },
  ];
  for (const item of cases) await t.test(item.name, async () => {
    await assert.rejects(runIsolatedPdfScript(item.script, { runTimeoutMs: item.runTimeoutMs }), error => {
      assert.ok(error instanceof Error && "closed" in error && "stages" in error && "resultReceived" in error);
      assert.match(error.message, item.message);
      assert.equal(error.closed, true, "a rejected run must have observed its own child close");
      assert.deepEqual(error.stages, item.stages);
      assert.equal(error.resultReceived, item.resultReceived, "the fixture must reach the protocol state it claims to exercise");
      return true;
    });
  });
});

test("aborting an isolated PDF child kills it and observes close before rejecting", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 200);
  try {
    await assert.rejects(runIsolatedPdfScript('await new Promise(() => setInterval(() => {}, 1_000));', { signal: controller.signal }), error => {
      assert.ok(error instanceof Error && "closed" in error);
      assert.match(error.message, /PDF compatibility child aborted;/);
      assert.equal(error.closed, true);
      return true;
    });
  } finally { clearTimeout(timer); }
});

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

test("the production-selected installed PDF SDK parses a PDF when Uint8Array hex APIs are absent", { timeout: 30_000 }, async t => {
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
    reportStage("hex-apis-absent");
    let networkCalls = 0;
    globalThis.fetch = async () => { networkCalls++; throw new Error("PDF compatibility test forbids network"); };
    const sdk = await import(${JSON.stringify(sdkUrl)});
    reportStage("sdk-imported");
    sdk.GlobalWorkerOptions.workerSrc = ${JSON.stringify(workerUrl)};
    const loading = sdk.getDocument({
      data: new Uint8Array(${JSON.stringify([...fixturePdf()])}),
      disableFontFace: true, useSystemFonts: true, useWorkerFetch: false,
      isEvalSupported: false, verbosity: 0,
    });
    reportStage("document-requested");
    let result;
    try {
      const pdf = await loading.promise;
      assert.equal(pdf.numPages, 1);
      const page = await pdf.getPage(1);
      const content = await page.getTextContent();
      const text = content.items.filter(item => "str" in item).map(item => item.str).join(" ").replace(/\\s+/g, " ").trim();
      assert.equal(text, ${JSON.stringify(expectedText)});
      assert.equal(networkCalls, 0);
      reportStage("text-extracted");
      result = { pages: pdf.numPages, text, networkCalls, sdkVersion: sdk.version };
    } finally {
      await loading.destroy();
      reportStage("destroyed");
    }
    assert.equal(networkCalls, 0);
    finish(result);
  `;
  // Node uses PDF.js's fake-worker path here. This guards the real installed
  // parser and selected worker bytes; it is NOT a browser/Renderer Worker test
  // and does not claim coverage of canvas rendering or the import dialog UI.
  const completed = await runIsolatedPdfScript(script, { signal: t.signal });
  assert.deepEqual(completed.stages, ["ready", "hex-apis-absent", "sdk-imported", "document-requested", "text-extracted", "destroyed"]);
  const result = completed.result as { pages: number; text: string; networkCalls: number; sdkVersion: string };
  assert.equal(result.pages, 1);
  assert.equal(result.text, expectedText);
  assert.equal(result.networkCalls, 0);
  assert.ok(result.sdkVersion);
});
