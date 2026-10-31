import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer, build } from "vite";

const webRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = path.resolve(webRoot, "../..");
const require = createRequire(import.meta.url);
const workerPath = require.resolve("pdfjs-dist/build/pdf.worker.min.mjs");

test("PDF worker remains readable with linked dependencies and a restricted Vite filesystem", async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "betterme-pdf-worker-"));
  const server = await createServer({
    root: webRoot, configFile: false, cacheDir, logLevel: "silent",
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null, fs: { strict: true, allow: [repositoryRoot] } },
  });
  try {
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const parser = await fetch(`${origin}/src/lib/file-parsers.ts`);
    assert.equal(parser.status, 200);
    await parser.text();
    const worker = await fetch(`${origin}/@fs${encodeURI(workerPath)}`);
    assert.equal(worker.status, 200, "the actual worker request must not return 403 Restricted");
    assert.match(worker.headers.get("content-type") ?? "", /javascript/);
    assert.match(await worker.text(), /WorkerMessageHandler/);
    // A URL import must not open the whole linked package or its parent directory.
    if (!workerPath.startsWith(`${repositoryRoot}${path.sep}`)) {
      const adjacent = await fetch(`${origin}/@fs${encodeURI(path.resolve(workerPath, "../../README.md"))}`);
      assert.equal(adjacent.status, 403);
    }
  } finally {
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("production PDF extraction bundles a local worker without a CDN fallback", async () => {
  const result = await build({
    root: webRoot, configFile: false, logLevel: "silent",
    build: { write: false, minify: false, assetsInlineLimit: 0, rollupOptions: { input: path.join(webRoot, "src/lib/file-parsers.ts") } },
  });
  assert.ok(!Array.isArray(result) && "output" in result);
  const assets = result.output.filter(file => file.type === "asset");
  assert.ok(assets.some(asset => /pdf\.worker\.min[^/]*\.mjs$/.test(asset.fileName)));
  const chunks = result.output.filter(file => file.type === "chunk").map(chunk => chunk.code).join("\n");
  assert.equal(/https:\/\/unpkg\.com\/pdfjs-dist/.test(chunks), false, "worker loading must not depend on a CDN fallback");
});
