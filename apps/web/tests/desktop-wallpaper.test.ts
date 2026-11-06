import assert from "node:assert/strict";
import { test } from "node:test";
import "fake-indexeddb/auto";
import { readWallpaper, writeWallpaper, validateWallpaperFile, type LocalWallpaper } from "../src/lib/desktop-wallpaper";

test("original image bytes and 8K dimensions survive storage, fit changes and preset switching", async () => {
  const blob = new Blob([new Uint8Array([1, 3, 9, 27])], { type: "image/png" });
  const value: LocalWallpaper = { blob, width: 7680, height: 4320, name: "8k.png", enabled: true, fit: "cover" };
  await writeWallpaper(value);
  const loaded = (await readWallpaper())!;
  assert.equal(loaded.width, 7680);
  assert.equal(loaded.height, 4320);
  assert.deepEqual(await loaded.blob.arrayBuffer(), await blob.arrayBuffer());
  await writeWallpaper({ ...loaded, fit: "contain", enabled: false });
  const disabled = (await readWallpaper())!;
  assert.equal(disabled.fit, "contain");
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.blob.size, blob.size);
  await writeWallpaper(null);
  assert.equal(await readWallpaper(), null);
});

test("rejects unsupported, empty and oversized images", () => {
  assert.throws(() => validateWallpaperFile(new Blob(["<svg />"], { type: "image/svg+xml" })), /请选择/);
  assert.throws(() => validateWallpaperFile(new Blob([], { type: "image/png" })), /不能为空/);
  assert.throws(() => validateWallpaperFile({ type: "image/jpeg", size: 51 * 1024 * 1024 } as Blob), /50 MB/);
  assert.doesNotThrow(() => validateWallpaperFile(new Blob(["image"], { type: "image/avif" })));
});
