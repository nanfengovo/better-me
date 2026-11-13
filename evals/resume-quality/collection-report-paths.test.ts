import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { reportFileManifest } from "./collection-report.mjs";

for (const [platform, paths, root] of [["POSIX", path.posix, "/synthetic-report"], ["Windows", path.win32, "C:\\synthetic-report"]] as const) {
  test(`complete report manifest keeps portable PDF paths and exact bytes over native ${platform} access`, async () => {
    const folders = new Map([
      ["", ["quality", "collection"]], ["quality", ["nested space", "first.pdf", "second.pdf"]],
      ["quality/nested space", ["third😀.pdf"]], ["collection", ["failure.txt"]],
    ]), content = new Map([
      ["collection/failure.txt", Buffer.from("FULL-INVALID-OUTPUT\r\nEXACT-END")],
      ["quality/first.pdf", Buffer.from("%PDF-synthetic-first\r\n%%EOF")],
      ["quality/nested space/third😀.pdf", Buffer.from([0, 255, 128, 13, 10])],
      ["quality/second.pdf", Buffer.from("%PDF-synthetic-second\n%%EOF")],
    ]), opened: string[] = [];
    const relative = (file: string) => { assert.ok(paths.isAbsolute(file)); return paths.relative(root, file).split(paths.sep).join("/"); };
    const readDirectory = async (file: string) => { const names = folders.get(relative(file)); assert.ok(names, `Unknown directory: ${file}`); return names.slice(); };
    const inspect = async (file: string) => {
      const name = relative(file), folder = folders.has(name);
      assert.ok(folder || content.has(name), `Unknown file: ${file}`);
      return { isSymbolicLink: () => false, isDirectory: () => folder, isFile: () => !folder };
    };
    const read = async (file: string) => { opened.push(file); const bytes = content.get(relative(file)); assert.ok(bytes, `Unknown file: ${file}`); return bytes; };
    const files = await reportFileManifest(root, { paths, readDirectory, inspect, read });
    assert.equal(files.filter(file => file.path.startsWith("quality/") && file.path.endsWith(".pdf")).length, 3);
    assert.deepEqual(files, [...content].map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") })));
    assert.deepEqual(opened, [...content.keys()].map(name => paths.join(root, name)), "physical access must retain native path semantics");
    await assert.rejects(reportFileManifest(root, { paths, readDirectory, read, inspect: async () => ({ isSymbolicLink: () => true, isDirectory: () => true, isFile: () => false }) }), /quality_report_link_rejected/);
    await assert.rejects(reportFileManifest(root, { paths, readDirectory, read, inspect: async () => ({ isSymbolicLink: () => false, isDirectory: () => false, isFile: () => false }) }), /explicit_regular_file_required/);
    assert.equal(opened.length, content.size, "rejected entries must never be opened");
  });
}
