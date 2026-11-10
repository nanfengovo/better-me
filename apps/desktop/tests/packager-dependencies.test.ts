import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

test("the packager resolves the downloader cache API it actually calls", () => {
  const require = createRequire(new URL("../package.json", import.meta.url));
  const packagerRequire = createRequire(require.resolve("electron-builder/package.json"));
  const builderRequire = createRequire(packagerRequire.resolve("app-builder-lib/package.json"));
  const downloader = builderRequire("@electron/get");
  assert.equal(typeof downloader.ElectronDownloadCacheMode?.ReadWrite, "number");
  assert.equal(typeof downloader.downloadArtifact, "function");
});
