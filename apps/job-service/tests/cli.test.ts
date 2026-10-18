import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JOB_SERVICE_USAGE, parseJobServiceArgs, runJobServiceCli } from "../src/cli.ts";
import { LocalJobServiceError, type LocalJobServiceHandle } from "../src/lifecycle.ts";

const argumentsFor = (...extra: string[]) => ["--data-dir", join(tmpdir(), "better-me-cli-synthetic-only"), "--origin", "http://localhost:5173", ...extra];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function service(close: () => Promise<void> = async () => {}): LocalJobServiceHandle {
  return { url: "http://127.0.0.1:5178", port: 5178, dataDirectory: join(tmpdir(), "better-me-synthetic"), databasePath: join(tmpdir(), "better-me-synthetic", "jobs.sqlite"), tokenPath: join(tmpdir(), "better-me-synthetic", "service.token"), allowedOrigins: ["http://localhost:5173"], dns: "system", recoveredRuns: 0, close };
}
test("CLI defaults loopback and 5178 with explicit directory and origin; DNS and multiple origins are configurable", () => {
  const parsed = parseJobServiceArgs(argumentsFor());
  assert.equal(parsed.help, false);
  if (!parsed.help) { assert.equal(parsed.config.host, "127.0.0.1"); assert.equal(parsed.config.port, 5178); assert.equal(parsed.config.dns, "system"); }
  const custom = parseJobServiceArgs(argumentsFor("--dns", "google-doh", "--host", "::1", "--port", "5190", "--origin", "http://127.0.0.1:5173"));
  if (!custom.help) { assert.equal(custom.config.dns, "google-doh"); assert.equal(custom.config.host, "::1"); assert.equal(custom.config.port, 5190); assert.equal(custom.config.allowedOrigins.length, 2); }
});
test("CLI rejects ambiguous, missing, public-bind and wildcard configuration", () => {
  for (const args of [[], ["--data-dir", tmpdir()], ["--origin", "http://localhost:5173"], argumentsFor("--port", "0"), argumentsFor("--port", "1.2"), argumentsFor("--port", "65536"), argumentsFor("--host", "0.0.0.0"), argumentsFor("--origin", "*"), argumentsFor("--dns", "custom"), argumentsFor("--dns", "https://resolver.example.test"), argumentsFor("--port", "5178", "--port", "5179"), argumentsFor("--token", "secret"), argumentsFor("--port"), argumentsFor("unexpected")]) assert.throws(() => parseJobServiceArgs(args), (error: unknown) => error instanceof LocalJobServiceError && error.code === "invalid-config");
});
test("help prints usage without starting a service", async () => {
  let starts = 0; let output = "";
  const exit = await runJobServiceCli(["--help"], { stdout: (text) => { output += text; }, start: async () => { starts++; return service(); } });
  assert.equal(exit, 0); assert.equal(starts, 0); assert.equal(output, JOB_SERVICE_USAGE);
});
test("logs expose token path only and signal shutdown waits for writes", async () => {
  const signals = new EventEmitter(); const ready = deferred(); const writes = deferred();
  let output = ""; let closed = false;
  const running = runJobServiceCli(argumentsFor(), { signals, stdout: (text) => { output += text; ready.resolve(); }, start: async () => service(async () => { await writes.promise; closed = true; }) });
  await ready.promise;
  assert.match(output, /Token file: .*service\.token/); assert.match(output, /DNS provider: system/);
  assert.equal(/Bearer\s|token=[A-Za-z0-9_-]{32}/.test(output), false);
  signals.emit("SIGINT"); signals.emit("SIGINT"); signals.emit("SIGTERM"); await new Promise<void>((done) => setImmediate(done));
  assert.equal(closed, false); assert.equal(output.includes("service stopped"), false);
  writes.resolve(); assert.equal(await running, 0); assert.equal(closed, true);
  assert.equal(signals.listenerCount("SIGINT"), 0); assert.equal(signals.listenerCount("SIGTERM"), 0);
});
test("a signal arriving during startup is honored after ownership is initialized", async () => {
  const signals = new EventEmitter(); const startup = deferred(); let closed = 0;
  const running = runJobServiceCli(argumentsFor(), { signals, stdout: () => {}, start: async () => { await startup.promise; return service(async () => { closed++; }); } });
  signals.emit("SIGTERM"); startup.resolve(); assert.equal(await running, 0); assert.equal(closed, 1);
});
test("configuration and startup errors return useful exit codes without dumping secret-bearing errors", async () => {
  let errors = "";
  assert.equal(await runJobServiceCli([], { stderr: (text) => { errors += text; } }), 2);
  assert.match(errors, /absolute data directory/);
  errors = "";
  assert.equal(await runJobServiceCli(argumentsFor(), { stderr: (text) => { errors += text; }, start: async () => { throw new Error("SECRET_SYNTHETIC_TOKEN_SHOULD_NOT_BE_LOGGED"); } }), 1);
  assert.equal(errors.includes("SECRET_SYNTHETIC"), false);
});
