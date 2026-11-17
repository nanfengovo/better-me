import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const base = new URL("../public/speech/vosk-cn-v1/", import.meta.url);
test("ordinary checkout ships the pinned offline Mandarin components and upstream notices, not LFS pointers or CDN placeholders", async () => {
  for (const [file, expected] of [
    ["vosk.js","29504515526e974f4cb053cf08811c4de5fb2a74007c0a5a957db50eaa8d5d0c"],
    ["small-cn-0.22.tar.gz","096ead2d82a3fb2568d0e583bb4b376b6fc26491fb65600b1838269d9864315a"],
  ] as const) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(new URL(file,base))) hash.update(chunk);
    assert.equal(hash.digest("hex"), expected, file);
  }
  for (const [file,required] of [["UPSTREAM-NOTICE.txt","Denis Treskunov"],["LICENSE-UUID.txt","Robert Kieffer"],["LICENSE-APACHE-2.0.txt","Apache License"]])
    assert.ok((await readFile(new URL(file!, base),"utf8")).includes(required!));
});

test("Git checkout preserves the pinned upstream speech bytes even with Windows autocrlf enabled", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-speech-checkout-"));
  const file = "apps/web/public/speech/vosk-cn-v1/vosk.js";
  try {
    await promisify(execFile)("git", ["-c", "core.autocrlf=true", "checkout-index", `--prefix=${directory.replaceAll("\\", "/")}/`, "--", file], {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    });
    const hash = createHash("sha256").update(await readFile(path.join(directory, file))).digest("hex");
    assert.equal(hash, "29504515526e974f4cb053cf08811c4de5fb2a74007c0a5a957db50eaa8d5d0c");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
