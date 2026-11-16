import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";

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
