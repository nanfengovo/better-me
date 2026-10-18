import test from "node:test";
import assert from "node:assert/strict";
import { resumeImageMime, resolveImageCrop, createCropTaskRunner } from "../src/lib/resume-image.js";

test("resume images are identified from binary signatures instead of being decoded as text", () => {
  assert.equal(resumeImageMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(resumeImageMime(Uint8Array.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])), "image/png");
  assert.equal(resumeImageMime(new TextEncoder().encode("RIFF1234WEBP")), "image/webp");
  for (const text of ["<svg><script>unsafe()</script></svg>", "not a JPEG", "%PDF-1.7", ""]) assert.equal(resumeImageMime(new TextEncoder().encode(text)), undefined);
  assert.equal(resumeImageMime(Uint8Array.from([0x89,0x50,0x4e,0x47])), undefined);
});

test("image crops reject zero area or out of bounds origins instead of producing blank edge images", () => {
  for (const rect of [{ x: 100, y: 0, width: 1, height: 20 }, { x: 0, y: 100, width: 20, height: 1 }, { x: 0, y: 0, width: 0, height: 20 }, { x: -1, y: 0, width: 20, height: 20 }, { x: NaN, y: 0, width: 20, height: 20 }, { x: 90, y: 90, width: 20, height: 20 }]) assert.throws(() => resolveImageCrop(rect, 1000, 2000));
  assert.deepEqual(resolveImageCrop({ x: 0, y: 16, width: 100, height: 64 }, 1000, 2000), { x: 0, y: 320, width: 1000, height: 1280 });
  assert.deepEqual(resolveImageCrop({ x: 99, y: 99, width: 1, height: 1 }, 1000, 2000), { x: 990, y: 1980, width: 10, height: 20 });
  assert.deepEqual(resolveImageCrop({ x: 9, y: 18, width: 1, height: 2 }, 10, 20, false), { x: 9, y: 18, width: 1, height: 2 });
  assert.throws(() => resolveImageCrop({ x: 9, y: 18, width: 2, height: 2 }, 10, 20, false));
});

test("cancelled crop results and errors cannot update a closed cropper or another file", async () => {
  const runner = createCropTaskRunner();
  const applied: string[] = [];
  let finish: (value: string) => void = () => {};
  const pending = runner.run(() => new Promise<string>((resolve) => { finish = resolve; }), (value) => applied.push(value));
  runner.cancel();
  finish("old-file-image");
  assert.equal(await pending, false);
  assert.deepEqual(applied, []);
  let fail: (error: Error) => void = () => {};
  const oldError = runner.run(() => new Promise<string>((_resolve, reject) => { fail = reject; }), (value) => applied.push(value));
  runner.cancel();
  fail(new Error("old-file-decode-failed"));
  assert.equal(await oldError, false);
  assert.equal(await runner.run(async () => "new-file-image", (value) => applied.push(value)), true);
  assert.deepEqual(applied, ["new-file-image"]);
});

test("a newer crop wins even when the older image finishes last", async () => {
  const runner = createCropTaskRunner();
  const applied: string[] = [];
  let finishOld: (value: string) => void = () => {};
  const old = runner.run(() => new Promise<string>((resolve) => { finishOld = resolve; }), (value) => applied.push(value));
  assert.equal(await runner.run(async () => "latest-region", (value) => applied.push(value)), true);
  finishOld("stale-region");
  assert.equal(await old, false);
  assert.deepEqual(applied, ["latest-region"]);
  await assert.rejects(runner.run(async () => { throw new Error("current failure"); }, () => {}), /current failure/);
});
