import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ATLAS_GEO_PUBLIC_FILES = [
  "world-countries-110m.geojson", "china-provinces-10m.geojson", "world-land-dots.geojson",
  "manifest.json", "dots-manifest.json", "NOTICE.md", "NATURAL-EARTH-LICENSE.md",
  "README.md", "RENDERER-NOTES.md", "build-assets.py", "build-dots.py", "requirements-build.txt",
];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function checkAtlasDistribution(directory) {
  const output = path.resolve(directory);
  const geo = path.join(root, "apps/web/src/components/atlas/geo");
  const legal = path.join(output, "legal/geography");
  assert.deepEqual((await readdir(legal)).sort(), [...ATLAS_GEO_PUBLIC_FILES, "index.html"].sort(), "Only the exact public geography allowlist is distributed");
  for (const file of ATLAS_GEO_PUBLIC_FILES) assert.deepEqual(await readFile(path.join(legal, file)), await readFile(path.join(geo, file)), `Unchanged geography distribution: ${file}`);
  const index = await readFile(path.join(legal, "index.html"), "utf8");
  for (const file of ATLAS_GEO_PUBLIC_FILES) assert.ok(index.includes(`href="${file}"`), `Geography index links ${file}`);
  const manifest = JSON.parse(await readFile(path.join(legal, "manifest.json"), "utf8"));
  const dots = JSON.parse(await readFile(path.join(legal, "dots-manifest.json"), "utf8"));
  const assets = await readdir(path.join(output, "assets"));
  const mapAssets = [];
  for (const asset of [...manifest.assets, dots]) {
    const candidates = assets.filter((file) => file.startsWith(`${path.parse(asset.file).name}-`) && file.endsWith(".geojson"));
    const matching = [];
    for (const file of candidates) if (digest(await readFile(path.join(output, "assets", file))) === asset.sha256) matching.push(file);
    assert.equal(matching.length, 1, `One content-matching Vite GeoJSON asset: ${asset.file}`);
    mapAssets.push(matching[0]);
  }
  const worker = assets.filter((file) => /^maplibre-gl-worker-[\w-]+\.mjs$/.test(file));
  assert.equal(worker.length, 1, "One standalone ESM MapLibre worker is distributed");
  const workerBytes = await readFile(path.join(output, "assets", worker[0]));
  assert.deepEqual(workerBytes, await readFile(path.join(root, "apps/web/node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs")), "MapLibre worker is the unchanged installed standalone module");
  const chunks = await Promise.all(assets.filter((file) => file.endsWith(".js")).map((file) => readFile(path.join(output, "assets", file), "utf8")));
  assert.ok(chunks.some((chunk) => chunk.includes(worker[0])), "The app references its shipped MapLibre worker");
  return { result: "passed", geographyPublicFiles: ATLAS_GEO_PUBLIC_FILES.length + 1, mapAssets, maplibreWorker: worker[0], workerBytes: workerBytes.length, scope: "Offline artifact hashes, exact geography allowlist and ESM worker distribution; no online tile requests or visual acceptance." };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length > 3) throw new Error("Usage: node scripts/check-atlas-distribution.mjs [web-dist-directory]");
  console.log(JSON.stringify(await checkAtlasDistribution(process.argv[2] ?? path.join(root, "apps/web/dist")), null, 2));
}
