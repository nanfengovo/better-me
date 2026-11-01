import assert from "node:assert/strict";
import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { RuntimeAgentDef } from "@better-me/agent-contracts";
import { RuntimeRegistry } from "../src/runtime/registry.ts";
import {
  createNativeUnderstandingReasoner,
  nativeUnderstandingCapabilities,
  type NativeUnderstandingOptions,
} from "../src/understanding/native-provider.ts";

// Only this Node fixture runs: no Claude, model call, user project or auth file.
const fixtureSource = String.raw`
const mode = process.argv[2];
const args = process.argv.slice(3);
const help = '--bare --print --tools --disallowedTools --strict-mcp-config --mcp-config --setting-sources --settings --disable-slash-commands --no-session-persistence --no-chrome --permission-mode --system-prompt --input-format --output-format --verbose stream-json';
if (args.includes('--help')) {
  process.stdout.write(mode === 'old-help' ? help.replace('--bare', '') : help);
  process.exit(0);
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
  if (mode === 'stderr') {
    process.stderr.write('SENSITIVE_DIAGNOSTIC ' + process.env.ANTHROPIC_API_KEY);
    process.exit(4);
  }
  if (mode === 'oversized') { process.stdout.write('x'.repeat(1000001)); return; }
  if (mode === 'malformed') { process.stdout.write('not json\n'); return; }
  if (mode === 'hook') { emit({ type: 'system', subtype: 'hook_started' }); return; }
  if (mode !== 'missing-init') emit({
    type: 'system', subtype: 'init',
    tools: mode === 'enabled-tool' ? ['Read'] : [],
    mcp_servers: mode === 'enabled-mcp' ? [{ name: 'private-server' }] : [],
    plugins: mode === 'enabled-plugin' ? [{ name: 'private-plugin' }] : [],
  });
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  if (mode === 'missing-result') return;
  if (mode === 'api-retry') emit({ type: 'system', subtype: 'api_retry', attempt: 1 });
  if (mode === 'tool-use') emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { path: '/synthetic/unapproved.cs' } }] } });
  if (mode === 'tool-result') emit({ type: 'user', message: { content: [{ type: 'tool_result', content: 'SYNTHETIC_UNAPPROVED' }] } });
  if (mode === 'success') emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'draft' }] } });
  emit({
    type: 'result', subtype: mode === 'runtime-error' ? 'error_during_execution' : 'success',
    is_error: mode === 'runtime-error',
    result: mode === 'secret-output' ? process.env.ANTHROPIC_API_KEY : JSON.stringify({ received: input, action: 'read', path: 'SyntheticFlow.cs' }),
    permission_denials: mode === 'denied' ? [{ tool_name: 'Read' }] : [],
  });
});
`;

const fakeKey = "synthetic-anthropic-auth-not-a-real-key";

test("understanding discovery resolves executables without launching legacy probes or reading auth config", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "understanding-discovery-"));
  const sentinel = path.join(directory, "legacy-probe-ran");
  try {
    const dangerousArgs = ["-e", `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'unexpected')`];
    const registry = new RuntimeRegistry({ definitions: [{ ...definition(), versionArgs: dangerousArgs, probeArgs: dangerousArgs, authFiles: [path.join(directory, "never-read-auth.json")] }] });
    const items = await registry.discoverExecutables();
    assert.equal(items[0]?.resolvedCommand, process.execPath);
    assert.equal(items[0]?.canRun, false);
    assert.deepEqual(items[0]?.checks, { version: "skipped", protocol: "skipped", auth: "unknown" });
    await assert.rejects(fs.stat(sentinel));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

function definition(id = "claude-code"): RuntimeAgentDef {
  return {
    id, name: `Fixture ${id}`, command: process.execPath, fallbackCommands: [],
    versionArgs: ["-e", "console.log('fixture-v1')"], transport: "stream-json", capabilities: ["text"],
    // These dangerous legacy arguments must never be inherited by this path.
    promptArgs: ["--dangerously-skip-permissions", "--add-dir", "/synthetic-unapproved"],
    requiredFlags: [], authEnvVars: [], authFiles: [],
  };
}

async function fixture(mode = "success", environment: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: fakeKey }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-native-fixture-"));
  const script = path.join(directory, "cli.cjs");
  await fs.writeFile(script, fixtureSource);
  const registry = new RuntimeRegistry({ definitions: [definition()] });
  await registry.scan();
  const launches: { command: string; args: string[]; options: SpawnOptionsWithoutStdio; pid?: number }[] = [];
  const options: NativeUnderstandingOptions = {
    environment, temporaryRoot: directory,
    spawnProcess(command, args, launchOptions) {
      const child = spawn(process.execPath, [script, mode, ...args], launchOptions);
      launches.push({ command, args: [...args], options: launchOptions, pid: child.pid });
      return child;
    },
  };
  return {
    registry, options, launches, directory,
    async close() { await fs.rm(directory, { recursive: true, force: true }); },
  };
}

test("native capabilities consume a snapshot and do not scan auth/config files", async () => {
  const registry = new RuntimeRegistry({ definitions: [definition()] });
  assert.deepEqual(await nativeUnderstandingCapabilities(registry), []);
  await assert.rejects(createNativeUnderstandingReasoner(registry, "claude-code"), /runtime_unavailable/);
});

test("OAuth-only and unverified runtimes fail closed without launching a process", async () => {
  const f = await fixture("success", { CLAUDE_CODE_OAUTH_TOKEN: "synthetic-oauth" });
  try {
    const caps = await nativeUnderstandingCapabilities(f.registry, f.options);
    assert.equal(caps[0]?.available, true);
    assert.equal(caps[0]?.supported, false);
    assert.match(caps[0]?.reason ?? "", /OAuth/);
    await assert.rejects(createNativeUnderstandingReasoner(f.registry, "claude-code", f.options), /unsupported/);
    assert.equal(f.launches.length, 0);
    const other = new RuntimeRegistry({ definitions: [definition("codex")] });
    await other.scan();
    const otherCaps = await nativeUnderstandingCapabilities(other, f.options);
    assert.equal(otherCaps[0]?.supported, false);
    assert.match(otherCaps[0]?.reason ?? "", /不会回退/);
    assert.equal(f.launches.length, 0);
  } finally { await f.close(); }
});

test("the installed help must confirm every strict flag before support is enabled", async () => {
  const old = await fixture("old-help");
  try {
    const caps = await nativeUnderstandingCapabilities(old.registry, old.options);
    assert.equal(caps[0]?.supported, false);
    await assert.rejects(createNativeUnderstandingReasoner(old.registry, "claude-code", old.options), /unsupported/);
    assert.ok(old.launches.every((launch) => launch.args.includes("--help")));
  } finally { await old.close(); }
  const current = await fixture();
  try {
    const caps = await nativeUnderstandingCapabilities(current.registry, current.options);
    assert.equal(caps[0]?.supported, true);
    assert.equal(current.launches[0]?.options.env?.ANTHROPIC_API_KEY, undefined, "even help receives no credential");
    assert.deepEqual(await fs.readdir(current.directory), ["cli.cjs"]);
  } finally { await current.close(); }
});

test("native reasoning uses broker evidence on stdin, no tools, isolated config and a minimal environment", async () => {
  const f = await fixture("success", {
    PATH: process.env.PATH,
    ANTHROPIC_API_KEY: fakeKey,
    ANTHROPIC_BASE_URL: "https://synthetic.invalid",
    ANTHROPIC_MODEL: "synthetic-model",
    OPENAI_API_KEY: "unrelated-provider-secret",
    PRIVATE_PROJECT_SECRET: "unapproved-secret",
    NODE_OPTIONS: "--require /synthetic/unapproved-hook.cjs",
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://synthetic-telemetry.invalid",
    CLAUDE_CODE_OAUTH_TOKEN: "unapproved-oauth",
    BASH_ENV: "/synthetic/unapproved-shell-hook",
  });
  try {
    const reason = await createNativeUnderstandingReasoner(f.registry, "claude-code", f.options);
    const prompt = "SYNTHETIC_BROKER_EVIDENCE at /not-granted/business.cs; propose a bounded read as JSON";
    const result = JSON.parse(await reason(prompt, new AbortController().signal));
    assert.equal(result.received, prompt);
    assert.equal(result.action, "read", "proposals remain text; the provider executes no broker request");
    const launch = f.launches.at(-1)!;
    assert.equal(launch.options.shell, false);
    assert.equal(launch.args.includes(prompt), false);
    assert.equal(launch.args.includes("--dangerously-skip-permissions"), false);
    assert.equal(launch.args.includes("--add-dir"), false);
    assert.equal(launch.args[launch.args.indexOf("--tools") + 1], "");
    assert.equal(launch.args[launch.args.indexOf("--disallowedTools") + 1], "*");
    assert.equal(launch.args[launch.args.indexOf("--mcp-config") + 1], '{"mcpServers":{}}');
    assert.equal(launch.args[launch.args.indexOf("--setting-sources") + 1], "");
    assert.equal(launch.args[launch.args.indexOf("--permission-mode") + 1], "dontAsk");
    for (const flag of ["--bare", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--no-chrome"]) {
      assert.ok(launch.args.includes(flag), flag);
    }
    const env = launch.options.env!;
    assert.equal(env.ANTHROPIC_API_KEY, fakeKey);
    assert.equal(env.ANTHROPIC_BASE_URL, "https://synthetic.invalid");
    for (const key of ["OPENAI_API_KEY", "PRIVATE_PROJECT_SECRET", "NODE_OPTIONS", "OTEL_EXPORTER_OTLP_ENDPOINT", "CLAUDE_CODE_OAUTH_TOKEN", "BASH_ENV"]) {
      assert.equal(env[key], undefined, `${key} must not cross the native boundary`);
    }
    assert.equal(env.DISABLE_TELEMETRY, "1");
    assert.equal(env.DISABLE_ERROR_REPORTING, "1");
    assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
    assert.equal(env.OTEL_SDK_DISABLED, "true");
    assert.equal(env.HOME, launch.options.cwd);
    assert.equal(env.CLAUDE_CONFIG_DIR, path.join(String(launch.options.cwd), "config"));
    assert.deepEqual(await fs.readdir(f.directory), ["cli.cjs"], "no prompt, transcripts or config retained");
  } finally { await f.close(); }
});

for (const mode of ["enabled-tool", "enabled-mcp", "enabled-plugin", "hook", "tool-use", "tool-result", "denied", "runtime-error", "missing-init", "malformed"]) {
  test(`native protocol rejects ${mode} even when the fixture exits zero`, async () => {
    const f = await fixture(mode);
    try {
      const reason = await createNativeUnderstandingReasoner(f.registry, "claude-code", f.options);
      await assert.rejects(reason("SYNTHETIC_EVIDENCE", new AbortController().signal), /protocol_violation/);
      assert.deepEqual(await fs.readdir(f.directory), ["cli.cjs"]);
    } finally { await f.close(); }
  });
}

test("native output requires a final result, is bounded, and cannot disclose auth or stderr", async () => {
  for (const [mode, expected] of [["missing-result", /incomplete_result/], ["oversized", /output_limit/], ["stderr", /process_failed/], ["secret-output", /sensitive_output/]] as const) {
    const f = await fixture(mode);
    try {
      const reason = await createNativeUnderstandingReasoner(f.registry, "claude-code", f.options);
      await assert.rejects(reason("SYNTHETIC_EVIDENCE", new AbortController().signal), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, expected);
        assert.doesNotMatch(error.message, /SENSITIVE_DIAGNOSTIC|synthetic-anthropic-auth/);
        return true;
      });
    } finally { await f.close(); }
  }
});

test("documented API retry metadata can precede the authoritative answer without enabling tools", async () => {
  const f = await fixture("api-retry");
  try {
    const reason = await createNativeUnderstandingReasoner(f.registry, "claude-code", f.options);
    const result = JSON.parse(await reason("SYNTHETIC_EVIDENCE", new AbortController().signal));
    assert.equal(result.received, "SYNTHETIC_EVIDENCE");
  } finally { await f.close(); }
});

test("abort stops the native process, rejects as AbortError and removes private scratch state", async () => {
  const f = await fixture("hang");
  try {
    const reason = await createNativeUnderstandingReasoner(f.registry, "claude-code", f.options);
    const already = new AbortController();
    already.abort();
    const launchCount = f.launches.length;
    await assert.rejects(reason("SYNTHETIC_EVIDENCE", already.signal), { name: "AbortError" });
    assert.equal(f.launches.length, launchCount);
    const controller = new AbortController();
    const running = reason("SYNTHETIC_EVIDENCE", controller.signal);
    const rejected = assert.rejects(running, { name: "AbortError" });
    while (f.launches.length === launchCount) await delay(5);
    await delay(30);
    controller.abort();
    await rejected;
    assert.deepEqual(await fs.readdir(f.directory), ["cli.cjs"]);
  } finally { await f.close(); }
});

test("timeout cannot fall back to an unrestricted run", async () => {
  const f = await fixture("hang");
  try {
    const reason = await createNativeUnderstandingReasoner(f.registry, "claude-code", { ...f.options, timeoutMs: 40 });
    await assert.rejects(reason("SYNTHETIC_EVIDENCE", new AbortController().signal), /timeout/);
    assert.equal(f.launches.length, 2, "one help probe and one strict run; no fallback");
    assert.deepEqual(await fs.readdir(f.directory), ["cli.cjs"]);
  } finally { await f.close(); }
});
