import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { RuntimeRegistry, BUILTIN_RUNTIME_DEFINITIONS } from "../src/runtime/registry.js";
import { NativeAccountTools, type NativeLease } from "../src/native-tools/service.js";
import { NativeOutput } from "../src/native-tools/adapters.js";
import { IsolatedNativeProcess, NativeToolError, isPublicProviderAddress, nativeEnvironment, nativeSandboxProfile } from "../src/native-tools/process.js";
import { FixtureNativeProcess, nativeFrames } from "./fixtures/native-process.js";

const lease = (session = "session-a"): NativeLease => ({ session, valid: async () => true });
const authorization = (apiKey = "synthetic-account-a-key") => ({ mode: "api-key", apiKey, model: "synthetic-model", consent: true });

/** POSIX mode bits do not describe Windows access. Check the real synthetic file ACL there. */
async function assertPrivateCredentialFile(file: string) {
  const stats = await fs.lstat(file);
  assert.equal(stats.isFile() && !stats.isSymbolicLink(), true);
  if (process.platform !== "win32") { assert.equal(stats.mode & 0o777, 0o600); return; }
  const script = `$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath '${file.replaceAll("'", "''")}'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowed = @($sid, 'S-1-5-18', 'S-1-5-32-544')
if ($allowed -notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) { exit 2 }
$other = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | Where-Object { $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and $allowed -notcontains $_.IdentityReference.Value })
if ($other.Count -gt 0) { exit 3 }
Write-Output 'private-synthetic-credential-acl'`;
  const result = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", timeout: 15_000 });
  assert.equal(result.trim(), "private-synthetic-credential-acl", "Credential ACL permits only its owner, SYSTEM and local administrators");
}

test("production isolation never advertises an unsupported OS as sandboxed", async () => {
  const available = await new IsolatedNativeProcess().isolation();
  assert.equal(typeof available, "boolean");
  if (process.platform !== "darwin") assert.equal(available, false, "Unsupported production isolation must remain fail-closed, independent of fixture file permissions");
});
test("provider proxy rejects local, reserved, translated and tunnel addresses but accepts public IPv4 and IPv6", () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "172.16.1.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "198.18.0.1", "192.0.2.1", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "64:ff9b::7f00:1", "2002:7f00:1::", "2001:db8::1", "2001:0000:7f00:0001:0000:0000:0000:0001"]) assert.equal(isPublicProviderAddress(address), false, address);
  for (const address of ["1.1.1.1", "8.8.8.8", "2001:4860:4860::8888", "2606:4700:4700::1111"]) assert.equal(isPublicProviderAddress(address), true, address);
});
async function setup() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-native-test-"));
  const registry = new RuntimeRegistry({ definitions: BUILTIN_RUNTIME_DEFINITIONS.map(definition => ({ ...definition, command: process.execPath, fallbackCommands: [] })) });
  await registry.discoverExecutables();
  const runner = new FixtureNativeProcess();
  const a = new NativeAccountTools({ directory: path.join(directory, "a"), registry, runner });
  const b = new NativeAccountTools({ directory: path.join(directory, "b"), registry, runner });
  return { directory, runner, registry, a, b, async close() { await a.close(); await b.close(); await fs.rm(directory, { recursive: true, force: true }); } };
}

test("installed tools require fresh owner authorization; no shared environment/key/history import", async () => {
  const fixture = await setup();
  try {
    const statuses = await fixture.a.capabilities();
    for (const id of ["codex", "claude-code", "opencode", "gemini-cli"]) assert.equal(statuses.find(item => item.id === id)?.code, "needs_authorization");
    assert.equal(statuses.find(item => item.id === "pi")?.code, "adapter_missing");
    await assert.rejects(fixture.a.reasoner("codex", lease()), /authorization_required/);
    assert.equal(fixture.runner.executions.length, 0);
    const environment = nativeEnvironment("/synthetic/own");
    for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "NODE_OPTIONS", "SSH_AUTH_SOCK", "AWS_ACCESS_KEY_ID"]) assert.equal(environment[key], undefined);
    assert.equal(environment["CODEX_HOME"], path.join("/synthetic/own", "codex"));
    assert.equal(environment["CLAUDE_CODE_TMPDIR"], path.join("/synthetic/own", "tmp"), "Claude must not use its shared /tmp/claude-uid default");
  } finally { await fixture.close(); }
});

test("saved authorization remains visible and revocable when OS isolation later becomes unavailable", async () => {
  const f = await setup();
  try {
    await f.a.authorizeApi("opencode", authorization(), lease());
    f.runner.isolated = false;
    const blocked = (await f.a.capabilities()).find(item => item.id === "opencode");
    assert.equal(blocked?.code, "sandbox_unavailable"); assert.equal(blocked?.supported, false); assert.equal(blocked?.authorized, true);
    await f.a.disconnect("opencode", lease());
    assert.equal((await f.a.capabilities()).find(item => item.id === "opencode")?.authorized, false);
    assert.equal((await f.b.capabilities()).find(item => item.id === "opencode")?.authorized, false);
  } finally { await f.close(); }
});

for (const id of ["codex", "claude-code", "opencode", "gemini-cli"] as const) test(`${id}: production adapter with synthetic process verifies owner configuration, output protocol and revocation`, async () => {
  const f = await setup();
  try {
    await f.a.authorizeApi(id, authorization(), lease());
    assert.equal((await f.a.capabilities()).find(item => item.id === id)?.code, "needs_verification");
    assert.equal((await f.b.capabilities()).find(item => item.id === id)?.code, "needs_authorization");
    const run = await f.a.reasoner(id, lease());
    assert.equal(await run("only synthetic evidence", new AbortController().signal), f.runner.text);
    assert.equal((await f.a.capabilities()).find(item => item.id === id)?.code, "ready");
    const input = f.runner.executions[0]!;
    assert.ok(input.directory.startsWith(path.join(f.directory, "a")));
    assert.equal(input.stdin, "only synthetic evidence"); assert.ok(!input.args.includes("only synthetic evidence"));
    assert.equal(input.environment?.["OPENAI_API_KEY"], undefined);
    assert.ok(!JSON.stringify(await f.a.capabilities()).includes("synthetic-account-a-key"));
    await assertPrivateCredentialFile(path.join(f.directory, "a", id, "connection.json"));
    await f.a.disconnect(id, lease());
    await assert.rejects(run("late", new AbortController().signal), /authorization_changed/);
  } finally { await f.close(); }
});

test("logout invalidates both running and queued native calls, including A to B to A and an ignored abort", async () => {
  const f = await setup(); let release!: () => void;
  try {
    await f.a.authorizeApi("opencode", authorization(), lease());
    f.runner.gate = new Promise<void>(resolve => { release = resolve; });
    const run = await f.a.reasoner("opencode", lease());
    const first = run("first", new AbortController().signal); const rejected = assert.rejects(first);
    const queued = run("queued", new AbortController().signal); const rejectedQueued = assert.rejects(queued);
    while (!f.runner.executions.length) await new Promise(resolve => setTimeout(resolve, 1));
    await f.a.invalidateSession("session-a"); release();
    await Promise.all([rejected, rejectedQueued]);
    assert.equal(f.runner.executions.length, 1, "queued task never launched");
    assert.equal((await f.a.capabilities()).find(item => item.id === "opencode")?.code, "needs_verification");
    await assert.rejects(f.a.reasoner("opencode", lease()), /identity_changed/);
    const fresh = await f.a.reasoner("opencode", lease("session-a-returned")); assert.equal(await fresh("fresh", new AbortController().signal), f.runner.text);
  } finally { release?.(); await f.close(); }
});

test("reauthorization and source cancellation reject late success without overwriting current credentials", async () => {
  const f = await setup(); let release!: () => void;
  try {
    await f.a.authorizeApi("claude-code", authorization(), lease());
    f.runner.gate = new Promise<void>(resolve => { release = resolve; });
    const run = await f.a.reasoner("claude-code", lease());
    const signal = new AbortController(); const result = run("synthetic", signal.signal); const denied = assert.rejects(result);
    while (!f.runner.executions.length) await new Promise(resolve => setTimeout(resolve, 1));
    signal.abort(); await f.a.authorizeApi("claude-code", authorization("synthetic-account-a-replacement"), lease()); release(); await denied;
    const raw = await fs.readFile(path.join(f.directory, "a", "claude-code", "connection.json"), "utf8");
    assert.match(raw, /synthetic-account-a-replacement/); assert.doesNotMatch(raw, /verifiedAt/);
  } finally { release?.(); await f.close(); }
});

test("native device login is session-scoped, file-only and cannot commit after logout", async () => {
  const f = await setup(); let release!: () => void;
  try {
    f.runner.deviceGate = new Promise<void>(resolve => { release = resolve; });
    await f.a.startDeviceLogin(lease());
    const login = await f.a.loginStatus(lease()); assert.equal(login.userCode, "ABCD-EFGH");
    assert.equal((await f.a.loginStatus(lease("other-session"))).userCode, undefined);
    const invalidating = f.a.invalidateSession("session-a"); release(); await invalidating;
    assert.equal((await f.a.capabilities()).find(item => item.id === "codex")?.code, "needs_authorization");
    await assert.rejects(fs.readFile(path.join(f.directory, "a", "codex", "auth.json")), /ENOENT/);
  } finally { release?.(); await f.close(); }
});

test("native device login creates a new owner-local auth home without reading global auth, and is usable after service recreation", async () => {
  const f = await setup();
  try {
    await f.a.startDeviceLogin(lease());
    for (let i = 0; i < 100 && (await f.a.loginStatus(lease())).state === "pending"; i++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal((await f.a.loginStatus(lease())).state, "complete");
    assert.equal((await f.b.capabilities()).find(item => item.id === "codex")?.supported, false);
    const recreated = new NativeAccountTools({ directory: path.join(f.directory, "a"), registry: f.registry, runner: f.runner });
    try { const run = await recreated.reasoner("codex", lease()); assert.equal(await run("synthetic", new AbortController().signal), f.runner.text); } finally { await recreated.close(); }
  } finally { await f.close(); }
});

test("unavailable states are specific; sandbox failure never enables an unisolated fallback", async () => {
  const f = await setup();
  try {
    f.runner.isolated = false;
    assert.equal((await f.a.capabilities()).find(item => item.id === "codex")?.code, "sandbox_unavailable");
    await assert.rejects(f.a.authorizeApi("codex", authorization(), lease()), /sandbox_unavailable/);
    assert.equal(f.runner.executions.length, 0);
  } finally { await f.close(); }
});

test("managed policy and OS termination are typed blockers, not missing authorization or ordinary version mismatch", async () => {
  const f = await setup();
  try {
    const original = f.runner.run.bind(f.runner);
    f.runner.run = async input => {
      if (input.args.includes("--bare") && input.args.includes("--help")) throw new NativeToolError("runtime_terminated");
      if (input.environment?.["BETTERME_NATIVE_API_KEY"] === "betterme-offline-preflight-only") throw new NativeToolError("managed_policy_unavailable");
      return original(input);
    };
    const statuses = await f.a.capabilities();
    assert.equal(statuses.find(item => item.id === "claude-code")?.code, "runtime_terminated");
    assert.equal(statuses.find(item => item.id === "codex")?.code, "managed_policy_unavailable");
    await assert.rejects(f.a.startDeviceLogin(lease()), /managed_policy_unavailable/);
    assert.equal(f.runner.deviceStarts, 0);
    assert.equal((await fs.readdir(path.join(f.directory, "a"))).some(name => name === "codex"), false);
  } finally { await f.close(); }
});

test("unsafe endpoints, client owner fields, absent consent and credential exfiltration are rejected", async () => {
  const f = await setup();
  try {
    for (const extra of [{ endpoint: "http://127.0.0.1:5179" }, { ownerId: "bob" }, { consent: false }, { endpoint: "https://name:secret@example.com" }]) {
      await assert.rejects(f.a.authorizeApi("opencode", { ...authorization(), ...extra }, lease()));
    }
    await f.a.authorizeApi("opencode", authorization(), lease()); f.runner.text = "synthetic-account-a-key";
    await assert.rejects((await f.a.reasoner("opencode", lease()))("synthetic", new AbortController().signal), /sensitive_output/);
  } finally { await f.close(); }
});

test("Claude native subscription metadata cannot enable tools or replace a completed reply", () => {
  const data = nativeFrames("claude-code", "synthetic"), lines = data.trim().split("\n");
  const allowed = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", isUsingOverage: false }, uuid: "synthetic" }) + "\n";
  const valid = new NativeOutput("claude-code"); valid.feed(lines.slice(0, -1).join("\n") + "\n" + allowed + lines.at(-1) + "\n");
  assert.equal(valid.finish(), "synthetic"); assert.throws(() => valid.feed(allowed), /protocol_violation/);
  for (const frame of [allowed.replace('"allowed"', '"rejected"'), allowed.replace('"uuid":"synthetic"', '"tool_use":{"name":"shell"}')]) {
    const denied = new NativeOutput("claude-code"); denied.feed(lines[0] + "\n"); assert.throws(() => denied.feed(frame));
  }
  const incomplete = new NativeOutput("claude-code"); incomplete.feed(lines[0] + "\n" + allowed); assert.throws(() => incomplete.finish(), /incomplete_result/);
});

test("output decoders reject tools, duplicate completion, truncation and malformed JSON for every installed adapter", () => {
  for (const id of ["codex", "claude-code", "gemini-cli", "opencode"] as const) {
    const valid = new NativeOutput(id); const data = nativeFrames(id, "synthetic");
    for (const character of data) valid.feed(character); assert.equal(valid.finish(), "synthetic");
    const truncated = new NativeOutput(id); truncated.feed(data.split("\n").slice(0, -2).join("\n") + "\n"); assert.throws(() => truncated.finish());
    const tool = new NativeOutput(id); assert.throws(() => tool.feed('{"type":"tool_use","name":"read_file"}\n'));
    const duplicate = new NativeOutput(id); duplicate.feed(data); assert.throws(() => duplicate.feed('{"type":"result"}\n'));
  }
  const profile = nativeSandboxProfile("/synthetic/account-a/run", ["/synthetic/tool-code"], 12345);
  assert.doesNotMatch(profile, /subpath "\/private\/tmp"|subpath "\/Users"|subpath "\/System"|allow network-outbound\)/);
  assert.doesNotMatch(profile, /\(allow file-read-metadata\)/);
  assert.match(profile, /localhost:12345/);
});
