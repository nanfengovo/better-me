import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { acquireRuntimeVolume } from "../server/runtime-volume.ts";
import { acquireDataDirectoryLock } from "../../job-service/src/lifecycle.ts";

test("runtime volume excludes concurrent owners and can be reacquired after release", async () => {
  const directory = await mkdtemp(join(tmpdir(), "betterme-volume-test-"));
  const lease = await acquireRuntimeVolume(directory);
  try { await assert.rejects(acquireRuntimeVolume(directory), /already owned/); }
  finally { lease.close(); }
  const next = await acquireRuntimeVolume(directory); next.close();
  await rm(directory, { recursive: true, force: true });
});
test("embedded job service keeps only its namespace lock on tmpfs, never moves the data directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "betterme-job-lease-test-"));
  const locks = join(directory, "ephemeral"), data = join(directory, "persistent");
  try {
    const lease = await acquireDataDirectoryLock(data, { lockDirectory: locks });
    assert.equal(lease.dataDirectory, await realpath(data));
    assert.equal(lease.lockPath, join(await realpath(locks), ".job-service.lock"));
    await assert.rejects(acquireDataDirectoryLock(data, { lockDirectory: locks }), /active or unverified/);
    await lease.release();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a crashed runtime releases its kernel lease without deleting persistent data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "betterme-crash-lease-test-"));
  const moduleUrl = new URL("../server/runtime-volume.ts", import.meta.url).href;
  const script = `import { acquireRuntimeVolume } from ${JSON.stringify(moduleUrl)}; await acquireRuntimeVolume(${JSON.stringify(directory)}); process.send('ready'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = ""; child.stderr?.on("data", value => { stderr += value; });
  try {
    await Promise.race([
      once(child, "message"),
      once(child, "exit").then(() => { throw new Error("Lease child exited before ready: " + stderr); }),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Lease child did not initialize")), 15_000); timer.unref(); }),
    ]);
    await assert.rejects(acquireRuntimeVolume(directory), /already owned/);
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    const restored = await acquireRuntimeVolume(directory); restored.close();
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
    await rm(directory, { recursive: true, force: true });
  }
});
