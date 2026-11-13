import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { buildSync } from "esbuild";

const require = createRequire(import.meta.url);
const bundle = buildSync({ entryPoints: [path.resolve(import.meta.dirname, "../src/evidence-harvester/git-source.ts")], bundle: true,
  platform: "node", format: "cjs", write: false }).outputFiles[0]!.text;
for (const actualRoot of ["C:/synthetic/repo", "C:\\synthetic\\repo", "C:/synthetic/other"]) {
  test(`Git preview compares canonical Windows roots, not separator spelling: ${actualRoot}`, async () => {
    const root = "C:\\synthetic\\repo", exports = { exports: {} as { GitEvidenceSource: new () => { preview(root: string): Promise<{ root: string }> } } };
    const reads: string[] = [];
    vm.runInNewContext(bundle, { module: exports, exports: exports.exports, Buffer, AbortController,
      require: (id: string) => id === "node:path" ? path.win32 : id === "node:fs/promises" ? {
        realpath: async (value: string) => { reads.push(value); return path.win32.normalize(value); },
      } : require(id) });
    const source = new exports.exports.GitEvidenceSource();
    Reflect.set(source, "metadataIdentity", async () => "synthetic-metadata");
    Reflect.set(source, "git", async (_root: string, args: string[]) => Buffer.from(args.includes("--show-toplevel") ? actualRoot : args.includes("--show-object-format") ? "sha1" : "a".repeat(40)));
    if (actualRoot.endsWith("other")) await assert.rejects(source.preview(root), /repository_root_mismatch/);
    else assert.equal((await source.preview(root)).root, root);
    assert.deepEqual(reads, [root, actualRoot]);
  });
}
