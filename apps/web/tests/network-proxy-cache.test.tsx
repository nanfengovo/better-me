import assert from "node:assert/strict";
import { mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createNetworkRuntime } from "../server/network-proxy";

test("createNetworkRuntime caches unchanged settings, updates on saveSettings, and invalidates on external change or deletion", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "proxy-cache-"));
  const settingsFile = path.join(dir, "network.json");
  try {
    const runtime = createNetworkRuntime({ settingsFile, readEnv: () => ({}), readSystemProxy: async () => ({ enabled: false }) });

    // ENOENT -> default direct/auto
    const initial = await runtime.readSettings();
    assert.equal(initial.mode, "auto");

    // saveSettings primes cache and returns updated mode
    await runtime.saveSettings({ mode: "direct", proxyUrl: "", bypass: "" });
    assert.equal((await runtime.readSettings()).mode, "direct");

    // External atomic rename (even with similar size) invalidates via ino/mtimeNs change
    const temp = path.join(dir, "network.tmp");
    await writeFile(temp, JSON.stringify({ mode: "manual", proxyUrl: "http://127.0.0.1:7897", bypass: "" }) + "\n");
    await rename(temp, settingsFile);
    const updated = await runtime.readSettings();
    assert.equal(updated.mode, "manual");
    assert.equal(updated.proxyUrl, "http://127.0.0.1:7897");

    // Removing the settings file clears cached entry and falls back to defaults
    await unlink(settingsFile);
    const afterDelete = await runtime.readSettings();
    assert.equal(afterDelete.mode, "auto");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
