import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("the packager resolves the downloader cache API it actually calls", () => {
  const require = createRequire(new URL("../package.json", import.meta.url));
  const packagerRequire = createRequire(require.resolve("electron-builder/package.json"));
  const builderRequire = createRequire(packagerRequire.resolve("app-builder-lib/package.json"));
  const downloader = builderRequire("@electron/get");
  assert.equal(typeof downloader.ElectronDownloadCacheMode?.ReadWrite, "number");
  assert.equal(typeof downloader.downloadArtifact, "function");
});

test("the packaged native checkpoint addon uses the stable Node-API contract", () => {
  const require = createRequire(new URL("../package.json", import.meta.url));
  const desktop = require("./package.json");
  assert.equal(desktop.dependencies["better-sqlite3"], require("better-sqlite3/package.json").version);
  assert.equal(desktop.dependencies["better-sqlite3"], "13.0.0");
  assert.ok(require("better-sqlite3/package.json").dependencies["node-addon-api"]);
  assert.equal(require("./electron-builder.json").npmRebuild, false);
});

test("the desktop runtime resolves its own PDF parser and local resources", () => {
  const hostRequire = createRequire(new URL("../../agent-host/package.json", import.meta.url));
  // A TS runner can resolve through workspace hooks and hide a missing runtime
  // dependency. Probe plain Node at the real bundled entry, without those hooks.
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import {createRequire} from 'node:module'; import {readdirSync} from 'node:fs'; import path from 'node:path';
    const require=createRequire(${JSON.stringify(new URL("../dist/runtime/server.mjs", import.meta.url).href)});
    require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
    const directory=path.dirname(require.resolve('pdfjs-dist/package.json'));
    console.log(JSON.stringify({version:require('pdfjs-dist/package.json').version,resources:['cmaps','standard_fonts'].map(name=>readdirSync(path.join(directory,name)).length)}));
  `], { env: {}, encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const info = JSON.parse(result.stdout);
  assert.equal(info.version, hostRequire("pdfjs-dist/package.json").version);
  assert.ok(info.resources.every((count: number) => count > 0));
});
