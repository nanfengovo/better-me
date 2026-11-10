import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const root = path.resolve(process.argv[2] ?? "release-assets");
const version = JSON.parse(await readFile("package.json", "utf8")).version;
assert.equal(process.env.GITHUB_REF_NAME, "v" + version, "Tag and packaged version must agree.");
async function walk(directory) {
  const result = [];
  for (const name of await readdir(directory)) {
    const file = path.join(directory, name);
    if ((await stat(file)).isDirectory()) result.push(...await walk(file)); else result.push(file);
  }
  return result;
}
const files = await walk(root), names = files.map(file => path.basename(file));
const expected = ["macos-arm64.dmg", "macos-arm64.zip", "macos-x64.dmg", "macos-x64.zip", "windows-x64-setup.exe", "linux-x64.AppImage"].map(suffix => `BetterMe-${version}-${suffix}`);
for (const name of expected) assert.equal(names.filter(value => value === name).length, 1, `Missing or duplicate release asset: ${name}`);
const verified = new Set();
for (const checksum of files.filter(file => path.basename(file).startsWith("SHA256SUMS-"))) {
  for (const line of (await readFile(checksum, "utf8")).trim().split("\n").filter(Boolean)) {
    const match = /^([a-f0-9]{64})  ([^/\\]+)$/.exec(line); assert.ok(match, "Invalid checksum entry.");
    const file = files.find(file => path.basename(file) === match[2]); assert.ok(file, "Checksum target missing.");
    assert.equal(createHash("sha256").update(await readFile(file)).digest("hex"), match[1], "Artifact checksum mismatch.");
    verified.add(match[2]);
  }
}
for (const name of expected) assert.ok(verified.has(name), `Release asset has no checksum: ${name}`);
console.log(`Verified ${expected.length} installers/archives and all platform checksums for v${version}.`);
if (process.argv.includes("--publish")) {
  const assets = files.filter(file => expected.includes(path.basename(file)) || /^SHA256SUMS-[a-z0-9-]+\.txt$/.test(path.basename(file)));
  const result = spawnSync("gh", ["release", "create", "v" + version, "--verify-tag", "--title", "BetterMe v" + version, "--notes-file", `docs/releases/v${version}.md`, ...assets], { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
