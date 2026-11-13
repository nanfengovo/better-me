import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = fileURLToPath(new URL("../scripts/verify-release.mjs", import.meta.url));
test("release gate rejects missing platforms, tampering, missing hashes and mismatched tags", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "betterme-release-verifier-"));
  const assets = path.join(root, "assets"); await mkdir(assets);
  const version = "1.1.0";
  const names = ["macos-arm64.dmg", "macos-arm64.zip", "macos-x64.dmg", "macos-x64.zip", "windows-x64-setup.exe", "linux-x64.AppImage"].map(suffix => `BetterMe-${version}-${suffix}`);
  const payload = "Synthetic release-gate fixture, not an installer.";
  const digest = createHash("sha256").update(payload).digest("hex");
  const manifest = names.map(name => digest + "  " + name).join("\n") + "\n";
  const check = (tag = "v1.1.0") => spawnSync(process.execPath, [script, assets], { cwd: root, env: { ...process.env, GITHUB_REF_NAME: tag }, encoding: "utf8" });
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ version }));
    for (const name of names) await writeFile(path.join(assets, name), payload);
    await writeFile(path.join(assets, "SHA256SUMS-fixture.txt"), manifest);
    assert.equal(check().status, 0);
    assert.notEqual(check("v9.9.9").status, 0);
    await rm(path.join(assets, names[0]!)); assert.notEqual(check().status, 0);
    await writeFile(path.join(assets, names[0]!), "tampered"); assert.notEqual(check().status, 0);
    await writeFile(path.join(assets, names[0]!), payload);
    await writeFile(path.join(assets, "SHA256SUMS-fixture.txt"), ""); assert.notEqual(check().status, 0);
    await writeFile(path.join(assets, "SHA256SUMS-fixture.txt"), manifest.replace(names[0]!, "../escape")); assert.notEqual(check().status, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
