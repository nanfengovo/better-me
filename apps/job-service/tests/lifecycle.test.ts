import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import filesystem from "node:fs/promises";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createToolRegistry } from "@better-me/opportunities";
import { acquireDataDirectoryLock, loadOrCreateServiceToken, LocalJobServiceError, startLocalJobService, validateJobServiceConfig, type JobServiceDependencies } from "../src/lifecycle.ts";
import type { JobRepository } from "../src/repository.ts";

async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "better-me-lifecycle-test-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
const code = (expected: string) => (error: unknown) => error instanceof LocalJobServiceError && error.code === expected;
const config = (directory: string) => ({ dataDirectory: directory, allowedOrigins: ["http://localhost:5173"], port: 0 });
async function staleLock(directory: string, changes: Record<string, unknown> = {}) {
  const path = join(directory, ".job-service.lock");
  await mkdir(path);
  const owner = { schemaVersion: 1, pid: 1234567, owner: randomUUID(), hostname: hostname(), createdAt: "2026-10-18T00:00:00.000Z", ...changes };
  await writeFile(join(path, "owner.json"), JSON.stringify(owner));
  return { path, owner };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function dependencies(events: string[], overrides: {
  recover?: () => Promise<{ recovered: number }>;
  shutdown?: () => Promise<void>;
  listen?: () => Promise<{ url: string; port: number }>;
  httpClose?: () => Promise<void>;
} = {}): JobServiceDependencies {
  return {
    openRepository: () => {
      events.push("repository-open");
      return { recoverInterruptedRuns: async () => { events.push("recover"); return overrides.recover ? overrides.recover() : { recovered: 2 }; }, close: () => { events.push("repository-close"); } } as JobRepository;
    },
    createApplication: () => {
      events.push("application-create");
      return { registry: createToolRegistry([]), shutdown: async () => { events.push("shutdown-start"); await overrides.shutdown?.(); events.push("shutdown-finished"); } };
    },
    createHttpServer: () => ({ listen: async () => { events.push("listen"); return overrides.listen ? overrides.listen() : { url: "http://127.0.0.1:23456", port: 23456 }; }, close: async () => { events.push("http-close"); await overrides.httpClose?.(); } }),
  };
}

test("service configuration requires an explicit absolute directory and exact origins", () => {
  for (const dataDirectory of ["", "relative/private"]) assert.throws(() => validateJobServiceConfig({ dataDirectory, allowedOrigins: ["http://localhost:5173"] }), code("invalid-config"));
  for (const origin of ["*", "http://*.example.test", "http://localhost:5173/", "http://localhost:5173/path", "http://localhost:5173?x=1", "file:///local", "https://user:pass@example.test"]) assert.throws(() => validateJobServiceConfig({ dataDirectory: tmpdir(), allowedOrigins: [origin] }), code("invalid-config"));
  assert.throws(() => validateJobServiceConfig({ dataDirectory: tmpdir(), allowedOrigins: [] }), code("invalid-config"));
  assert.throws(() => validateJobServiceConfig({ ...config(tmpdir()), host: "0.0.0.0" as "127.0.0.1" }), code("invalid-config"));
  const validated = validateJobServiceConfig({ dataDirectory: tmpdir(), allowedOrigins: ["http://localhost:5173", "http://localhost:5173", "https://example.test"] });
  assert.equal(validated.host, "127.0.0.1"); assert.equal(validated.port, 5178); assert.equal(validated.dns, "system");
  assert.deepEqual(validated.allowedOrigins, ["http://localhost:5173", "https://example.test"]);
});
test("only one concurrent service acquires a directory; release is idempotent", async () => temporary(async (directory) => {
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => acquireDataDirectoryLock(directory)));
  const owners = attempts.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  assert.equal(owners.length, 1);
  await owners[0]!.release(); await owners[0]!.release();
  const next = await acquireDataDirectoryLock(directory); await next.release();
}));
test("a live PID prevents takeover without sending a termination signal", async () => temporary(async (directory) => {
  const lock = await acquireDataDirectoryLock(directory);
  try { await assert.rejects(acquireDataDirectoryLock(directory), code("data-directory-busy")); assert.equal(JSON.parse(await readFile(join(lock.lockPath, "owner.json"), "utf8")).pid, process.pid); }
  finally { await lock.release(); }
}));
test("dead local ownership is quarantined once, preserving its original metadata", async () => temporary(async (directory) => {
  const stale = await staleLock(directory);
  const lock = await acquireDataDirectoryLock(directory, { processAlive: () => false });
  const quarantine = (await readdir(directory)).find((name) => name.startsWith(".job-service-stale-"));
  assert.ok(quarantine);
  assert.deepEqual(JSON.parse(await readFile(join(directory, quarantine, "owner.json"), "utf8")), stale.owner);
  assert.notEqual(JSON.parse(await readFile(join(lock.lockPath, "owner.json"), "utf8")).owner, stale.owner.owner);
  await lock.release();
}));
test("concurrent stale recovery has one owner and never removes its replacement", async () => temporary(async (directory) => {
  await staleLock(directory);
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => acquireDataDirectoryLock(directory, { processAlive: (pid) => pid === process.pid })));
  const owners = attempts.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  assert.equal(owners.length, 1);
  const metadata = JSON.parse(await readFile(join(owners[0]!.lockPath, "owner.json"), "utf8"));
  assert.equal(metadata.pid, process.pid);
  await owners[0]!.release();
}));

/** Keep syscall injection local to this sequential test file; production has no test-only hooks. */
async function withRename(override: (original: typeof filesystem.rename) => typeof filesystem.rename, run: () => Promise<void>) {
  const original = filesystem.rename;
  filesystem.rename = override(original); syncBuiltinESMExports();
  try { await run(); } finally { filesystem.rename = original; syncBuiltinESMExports(); }
}

test("stale recovery retains its claim while transient Windows rename conflicts settle", async () => {
  for (const transient of ["EPERM", "EACCES", "EBUSY"]) await temporary(async directory => {
    const stale = await staleLock(directory); let calls = 0;
    await withRename(original => async (...args) => {
      if (++calls <= 2) throw Object.assign(new Error("Synthetic competing metadata handle"), { code: transient });
      await original(...args);
    }, async () => {
      const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => acquireDataDirectoryLock(directory, { processAlive: pid => pid === process.pid })));
      const owners = attempts.flatMap(value => value.status === "fulfilled" ? [value.value] : []);
      assert.equal(owners.length, 1); assert.equal(calls, 3);
      const quarantines = (await readdir(directory)).filter(value => value.startsWith(".job-service-stale-"));
      assert.equal(quarantines.length, 1);
      assert.deepEqual(JSON.parse(await readFile(join(directory, quarantines[0]!, "owner.json"), "utf8")), stale.owner);
      assert.equal(JSON.parse(await readFile(join(owners[0]!.lockPath, "owner.json"), "utf8")).pid, process.pid);
      await owners[0]!.release();
    });
  });
});

test("persistent rename conflicts stop after a fixed budget and preserve the stale lock and unrelated files", async () => temporary(async directory => {
  const stale = await staleLock(directory); let calls = 0;
  await writeFile(join(stale.path, "unrecognized"), "preserve");
  await withRename(() => async () => { calls++; throw Object.assign(new Error("Synthetic persistent denied rename"), { code: "EPERM" }); }, async () => {
    await assert.rejects(acquireDataDirectoryLock(directory, { processAlive: () => false }), code("data-directory-busy"));
  });
  assert.equal(calls, 6);
  assert.deepEqual(JSON.parse(await readFile(join(stale.path, "owner.json"), "utf8")), stale.owner);
  assert.equal(await readFile(join(stale.path, "unrecognized"), "utf8"), "preserve");
  assert.deepEqual((await readdir(stale.path)).sort(), ["owner.json", "unrecognized"]);
  assert.deepEqual(await readdir(directory), [".job-service.lock"]);
}));

test("a stale PID becoming live between rename attempts immediately prevents takeover", async () => temporary(async directory => {
  const stale = await staleLock(directory); let calls = 0, live = false;
  await withRename(() => async () => { calls++; live = true; throw Object.assign(new Error("Synthetic handle conflict"), { code: "EPERM" }); }, async () => {
    await assert.rejects(acquireDataDirectoryLock(directory, { processAlive: () => live }), code("data-directory-busy"));
  });
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(await readFile(join(stale.path, "owner.json"), "utf8")), stale.owner);
  assert.deepEqual(await readdir(stale.path), ["owner.json"]);
}));

test("ownership replacement during a retry preserves the replacement lock and its guard", async () => temporary(async directory => {
  const stale = await staleLock(directory); let calls = 0;
  const replacement = { ...stale.owner, pid: process.pid, owner: randomUUID() };
  await withRename(() => async () => {
    calls++; await writeFile(join(stale.path, "owner.json"), JSON.stringify(replacement));
    await writeFile(join(stale.path, "replacement-marker"), "preserve replacement");
    throw Object.assign(new Error("Synthetic handle conflict"), { code: "EACCES" });
  }, async () => { await assert.rejects(acquireDataDirectoryLock(directory, { processAlive: pid => pid === process.pid }), code("data-directory-busy")); });
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(await readFile(join(stale.path, "owner.json"), "utf8")), replacement);
  assert.equal(await readFile(join(stale.path, "replacement-marker"), "utf8"), "preserve replacement");
  assert.ok((await readdir(stale.path)).includes(".reclaim"));
}));

test("a changed reclaim owner is never treated as this process's removable guard", async () => temporary(async directory => {
  const stale = await staleLock(directory); let calls = 0;
  const replacement = { ...stale.owner, pid: process.pid, owner: randomUUID() };
  await withRename(() => async () => {
    calls++; await writeFile(join(stale.path, ".reclaim", "owner.json"), JSON.stringify(replacement));
    throw Object.assign(new Error("Synthetic handle conflict"), { code: "EBUSY" });
  }, async () => { await assert.rejects(acquireDataDirectoryLock(directory, { processAlive: () => false }), code("data-directory-busy")); });
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(await readFile(join(stale.path, ".reclaim", "owner.json"), "utf8")), replacement);
  assert.deepEqual(JSON.parse(await readFile(join(stale.path, "owner.json"), "utf8")), stale.owner);
}));

test("a replacement reclaim directory cannot acquire ownership by copying the prior guard metadata", async () => temporary(async directory => {
  const stale = await staleLock(directory); let calls = 0;
  await withRename(original => async () => {
    calls++; const claim = join(stale.path, ".reclaim");
    const metadata = await readFile(join(claim, "owner.json"), "utf8");
    await original(claim, join(stale.path, ".reclaim-preserved"));
    await mkdir(claim); await writeFile(join(claim, "owner.json"), metadata);
    throw Object.assign(new Error("Synthetic handle conflict"), { code: "EPERM" });
  }, async () => { await assert.rejects(acquireDataDirectoryLock(directory, { processAlive: () => false }), code("data-directory-busy")); });
  assert.equal(calls, 1);
  assert.deepEqual((await readdir(stale.path)).sort(), [".reclaim", ".reclaim-preserved", "owner.json"]);
}));
test("foreign host, malformed metadata, and abandoned reclaim guard remain blocked", async () => temporary(async (directory) => {
  const foreign = join(directory, "foreign"); await mkdir(foreign); await staleLock(foreign, { hostname: "different-host" });
  await assert.rejects(acquireDataDirectoryLock(foreign, { processAlive: () => false }), code("data-directory-busy"));
  const malformed = join(directory, "malformed"); await mkdir(join(malformed, ".job-service.lock"), { recursive: true });
  await writeFile(join(malformed, ".job-service.lock", "owner.json"), "unfinished");
  await assert.rejects(acquireDataDirectoryLock(malformed), code("invalid-lock"));
  assert.equal(await readFile(join(malformed, ".job-service.lock", "owner.json"), "utf8"), "unfinished");
  const abandoned = join(directory, "abandoned"); await mkdir(abandoned); const old = await staleLock(abandoned); await mkdir(join(old.path, ".reclaim"));
  await assert.rejects(acquireDataDirectoryLock(abandoned, { processAlive: () => false }), code("data-directory-busy"));
}));
test("changed ownership and unexpected lock files are preserved on release", async () => temporary(async (directory) => {
  const lock = await acquireDataDirectoryLock(directory);
  const metadata = JSON.parse(await readFile(join(lock.lockPath, "owner.json"), "utf8"));
  await writeFile(join(lock.lockPath, "owner.json"), JSON.stringify({ ...metadata, owner: randomUUID() }));
  await assert.rejects(lock.release(), code("lock-ownership-changed"));
  await writeFile(join(lock.lockPath, "owner.json"), JSON.stringify(metadata));
  await writeFile(join(lock.lockPath, "unrecognized"), "preserve");
  await assert.rejects(lock.release(), code("lock-ownership-changed"));
  assert.equal(await readFile(join(lock.lockPath, "unrecognized"), "utf8"), "preserve");
  assert.equal(JSON.parse(await readFile(join(lock.lockPath, "owner.json"), "utf8")).owner, metadata.owner);
}));
test("tokens are strong, stable across restarts, and invalid files are never overwritten", async () => temporary(async (directory) => {
  const first = await loadOrCreateServiceToken(directory);
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(await loadOrCreateServiceToken(directory), first);
  if (process.platform !== "win32") assert.equal((await stat(first.tokenPath)).mode & 0o777, 0o600);
  await writeFile(first.tokenPath, "invalid-token\n");
  await assert.rejects(loadOrCreateServiceToken(directory), code("invalid-token"));
  assert.equal(await readFile(first.tokenPath, "utf8"), "invalid-token\n");
}));
test("token and lock symbolic links or Windows junctions are refused without following them", async () => temporary(async (directory) => {
  const target = join(directory, "target"); await mkdir(target);
  await writeFile(join(target, "token"), "A".repeat(43));
  const credentials = join(directory, "credentials"); await mkdir(credentials);
  await symlink(process.platform === "win32" ? target : join(target, "token"), join(credentials, "service.token"), process.platform === "win32" ? "junction" : "file");
  await assert.rejects(loadOrCreateServiceToken(credentials), code("invalid-token"));
  const locked = join(directory, "locked"); await mkdir(locked);
  await symlink(target, join(locked, ".job-service.lock"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(acquireDataDirectoryLock(locked), code("invalid-lock"));
  assert.equal(await readFile(join(target, "token"), "utf8"), "A".repeat(43));
  const linkedDirectory = join(directory, "linked-directory"); await symlink(target, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(acquireDataDirectoryLock(linkedDirectory), code("data-directory-unavailable"));
}));
test("recovery runs only after exclusive directory ownership", async () => temporary(async (directory) => {
  const events: string[] = [];
  const service = await startLocalJobService(config(directory), dependencies(events, { recover: async () => { await assert.rejects(acquireDataDirectoryLock(directory), code("data-directory-busy")); return { recovered: 4 }; } }));
  assert.equal(service.recoveredRuns, 4);
  assert.deepEqual(events, ["repository-open", "recover", "application-create", "listen"]);
  assert.equal("token" in service, false);
  await service.close();
}));
test("shutdown waits for HTTP and pending writes before closing the repository and releasing ownership", async () => temporary(async (directory) => {
  const events: string[] = [];
  const writes = deferred(); const http = deferred();
  const service = await startLocalJobService(config(directory), dependencies(events, { shutdown: () => writes.promise, httpClose: () => http.promise }));
  const closing = service.close(); assert.equal(service.close(), closing);
  await new Promise<void>((done) => setImmediate(done));
  assert.ok(events.includes("http-close")); assert.ok(events.includes("shutdown-start")); assert.equal(events.includes("repository-close"), false);
  await assert.rejects(acquireDataDirectoryLock(directory), code("data-directory-busy"));
  http.resolve(); await new Promise<void>((done) => setImmediate(done));
  assert.equal(events.includes("repository-close"), false);
  writes.resolve(); await closing;
  assert.ok(events.indexOf("repository-close") > events.indexOf("shutdown-finished"));
  const replacement = await acquireDataDirectoryLock(directory); await replacement.release();
}));
test("failed drain retains database and lock, and may be retried after work has stopped", async () => temporary(async (directory) => {
  const events: string[] = []; let attempt = 0;
  const service = await startLocalJobService(config(directory), dependencies(events, { shutdown: async () => { if (!attempt++) throw new Error("synthetic drain error"); } }));
  await assert.rejects(service.close(), code("shutdown-failed"));
  assert.equal(events.includes("repository-close"), false);
  await assert.rejects(acquireDataDirectoryLock(directory), code("data-directory-busy"));
  await service.close(); assert.equal(events.filter((event) => event === "http-close").length, 1);
}));
test("failed listener startup drains application and releases ownership while preserving token", async () => temporary(async (directory) => {
  const events: string[] = [];
  await assert.rejects(startLocalJobService(config(directory), dependencies(events, { listen: async () => { throw Object.assign(new Error("synthetic occupied port"), { code: "EADDRINUSE" }); } })), (error: unknown) => code("startup-failed")(error) && (error as Error).message.includes("already in use"));
  assert.equal(events.includes("http-close"), false);
  assert.ok(events.indexOf("repository-close") > events.indexOf("shutdown-finished"));
  assert.match(await readFile(join(directory, "service.token"), "utf8"), /^[A-Za-z0-9_-]{43}\n$/);
  const replacement = await acquireDataDirectoryLock(directory); await replacement.release();
}));
test("real ephemeral service persists SQLite and uses its private token with an exact allowed Origin", async () => temporary(async (directory) => {
  const service = await startLocalJobService(config(directory));
  const token = (await readFile(service.tokenPath, "utf8")).trim();
  try {
    assert.ok(service.port > 0); assert.match(service.url, /^http:\/\/127\.0\.0\.1:/);
    assert.equal((await fetch(`${service.url}/healthz`)).status, 401);
    const headers = { authorization: `Bearer ${token}`, origin: "http://localhost:5173" };
    assert.equal((await fetch(`${service.url}/healthz`, { headers })).status, 200);
    assert.equal((await fetch(`${service.url}/healthz`, { headers: { ...headers, origin: "http://untrusted.example" } })).status, 403);
    const exported = await fetch(`${service.url}/api/v1/dataset/export`, { headers });
    const body = await exported.json();
    assert.equal(exported.status, 200); assert.equal(body.ok, true); assert.equal(JSON.stringify(body).includes(token), false);
  } finally { await service.close(); }
  assert.ok((await stat(service.databasePath)).size > 0);
  const restarted = await startLocalJobService(config(directory));
  try { assert.equal((await readFile(restarted.tokenPath, "utf8")).trim(), token); assert.equal(restarted.recoveredRuns, 0); }
  finally { await restarted.close(); }
}));
