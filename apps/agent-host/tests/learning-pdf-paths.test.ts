import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { learningPdfAssetDirectories } from "../src/growth/learning-pdf.js";

for (const [name, paths, root] of [
  ["POSIX", path.posix, "/synthetic/pdfjs-dist"],
  ["Windows", path.win32, "C:\\synthetic\\pdfjs-dist"],
] as const) {
  test(`PDF parser factory directories satisfy PDF.js trailing-slash contract over native ${name} paths`, () => {
    const directories = learningPdfAssetDirectories(root, paths);
    for (const [kind, directory] of Object.entries(directories)) {
      assert.ok(directory.endsWith("/"), `${kind}: PDF.js getFactoryUrlProp requires a forward slash on every platform`);
      assert.equal(paths.normalize(directory), paths.join(root, kind === "cmaps" ? "cmaps" : "standard_fonts") + paths.sep);
      assert.ok(paths.isAbsolute(directory), "Node's data factory must receive an absolute filesystem path, not a file URL string");
    }
  });
}
