import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer } from "vite";

test("Vite denies sensitive fixture files even with import/raw query variants", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "betterme-vite-deny-"));
  const marker = "synthetic-denied-file-marker";
  await writeFile(path.join(root, ".env"), marker);
  await writeFile(path.join(root, "index.html"), "<p>synthetic fixture</p>");
  const server = await createServer({ root, configFile: false, envFile: false, logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, hmr: false, fs: { strict: true, allow: [root], deny: ["**/.env"] } } });
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`;
    assert.equal((await fetch(origin)).status, 200);
    for (const query of ["", "?raw", "?import&raw", "?import&url&inline"]) {
      const response = await fetch(`${origin}/.env${query}`);
      assert.equal(response.status, 403, query);
      assert.doesNotMatch(await response.text(), new RegExp(marker));
    }
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("lint and desktop matchers bound preprocessing while preserving file inclusion/exclusion", () => {
  const require = createRequire(import.meta.url);
  const lintRequire = createRequire(require.resolve("eslint"));
  const desktopRequire = createRequire(new URL("../../desktop/package.json", import.meta.url));
  const builderRequire = createRequire(createRequire(desktopRequire.resolve("electron-builder")).resolve("app-builder-lib"));
  for (const consumer of [lintRequire, builderRequire]) {
    const { Minimatch, minimatch } = consumer("minimatch");
    const bounded = new Minimatch("a/**/../b/c/**/../d/e", { optimizationLevel: 2, braceExpandMax: 2 });
    assert.ok(bounded.globParts.length <= 2, "globstar parent expansion must honor the configured cap");
    assert.equal(minimatch("src/fixture.ts", "**/*.{ts,tsx}"), true);
    assert.equal(minimatch("src/fixture.js", "**/*.{ts,tsx}"), false);
    assert.equal(new Minimatch("!**/*.map", { dot: true }).match("dist/runtime.js"), true);
    assert.equal(new Minimatch("!**/*.map", { dot: true }).match("dist/runtime.js.map"), false);
    assert.equal(new Minimatch("**/*", { dot: true }).match("dist/.fixture"), true);
    assert.equal(new Minimatch("C:/fixture/**/*.TS", { platform: "win32", nocase: true }).match("C:/fixture/nested/file.ts"), true);
  }
});
