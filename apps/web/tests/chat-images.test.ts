import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { readChatImage, MAX_CHAT_IMAGE_BYTES, chatImageErrorMessage } from "../src/lib/chat-images";

const dom = new Window();
Object.defineProperty(globalThis, "FileReader", { configurable: true, value: dom.FileReader });

test("both chat surfaces read exact original image bytes, format and filename without a canvas", async () => {
  const bytes = Buffer.from([0, 255, 127, 128, 13, 10, 0, 32]);
  for (const type of ["image/png", "image/jpeg", "image/webp"]) {
    const file = new dom.File([bytes], " 原始文件.png ", { type });
    const image = await readChatImage(file as unknown as File);
    assert.equal(image.name, file.name);
    assert.equal(image.mimeType, type);
    assert.equal(image.dataUrl, `data:${type};base64,${bytes.toString("base64")}`);
    assert.deepEqual(Buffer.from(image.dataUrl.split(",")[1]!, "base64"), bytes);
  }
});

test("original-image limits reject rather than compress, crop, rename or silently discard material", async () => {
  const exact = new dom.File([Buffer.alloc(MAX_CHAT_IMAGE_BYTES, 77)], "limit.png", { type: "image/png" });
  assert.equal(Buffer.from((await readChatImage(exact as unknown as File)).dataUrl.split(",")[1]!, "base64").length, MAX_CHAT_IMAGE_BYTES);
  for (const [file, code] of [
    [new dom.File([Buffer.alloc(MAX_CHAT_IMAGE_BYTES + 1)], "too-large.png", { type: "image/png" }), "image_too_large"],
    [new dom.File([], "empty.png", { type: "image/png" }), "image_too_large"],
    [new dom.File(["svg"], "unsupported.svg", { type: "image/svg+xml" }), "unsupported_type"],
    [new dom.File(["png"], "n".repeat(161), { type: "image/png" }), "image_name_too_long"],
  ] as const) await assert.rejects(readChatImage(file as unknown as File), new RegExp(code));
  assert.match(chatImageErrorMessage(new Error("image_too_large"), zh => zh), /未压缩或裁切/);
  assert.match(chatImageErrorMessage(new Error("image_name_too_long"), zh => zh), /未截短/);
});
