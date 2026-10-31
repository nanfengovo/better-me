import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AgentEventBus,
  AgentRunManager,
  RuntimeRegistry,
  probeRuntime,
  encodeSseEvent,
} from "../src/index.js";
import type { RuntimeAgentDef, RuntimeAgentInfo } from "@better-me/agent-contracts";

const fixedNow = () => new Date("2026-01-01T00:00:00.000Z");

function definition(overrides: Partial<RuntimeAgentDef> = {}): RuntimeAgentDef {
  return {
    id: "pi",
    name: "Pi",
    command: "definitely-not-installed",
    fallbackCommands: [],
    versionArgs: ["--version"],
    transport: "stdio",
    capabilities: ["text"],
    promptArgs: [],
    ...overrides,
  };
}

describe("runtime registry", () => {
  it("keeps an explicit not-installed result stable", async () => {
    const result = await probeRuntime(definition(), { env: { PATH: "" }, homeDirectory: "/tmp/no-agent-home", now: fixedNow });
    assert.equal(result.status, "not-installed");
    assert.equal(result.checkedAt, "2026-01-01T00:00:00.000Z");
    assert.match(result.detail ?? "", /未找到/);
  });

  it("resolves an executable through fallback commands", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "better-me-runtime-"));
    const fallback = path.join(temp, "agent-fallback");
    await fs.writeFile(fallback, "#!/bin/sh\nprintf 'fallback-v1\\n'\n");
    await fs.chmod(fallback, 0o755);
    try {
      const result = await probeRuntime(definition({ command: path.join(temp, "missing"), fallbackCommands: [fallback] }), { now: fixedNow });
      assert.equal(result.status, "available");
      assert.equal(result.resolvedCommand, fallback);
      assert.equal(result.version, "fallback-v1");
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  });

  it("returns all built-in definitions after a scan", async () => {
    const registry = new RuntimeRegistry({ env: { PATH: "" }, homeDirectory: "/tmp/no-agent-home", now: fixedNow });
    const snapshot = await registry.scan();
    assert.equal(snapshot.length, 7);
    assert.deepEqual(snapshot.map((item) => item.id), [
      "claude-code",
      "opencode",
      "gemini-cli",
      "codex",
      "deepseek-harness",
      "pi",
      "antigravity",
    ]);
    assert.ok(snapshot.every((item) => ["available", "not-installed", "needs-config", "error"].includes(item.status)));
  });

  it("does not treat a version-only match as runnable when the protocol probe fails", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "better-me-runtime-probe-"));
    const executable = path.join(temp, "fixture-agent");
    await fs.writeFile(executable, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'fixture 1.0\\n'; exit 0; fi\nprintf 'unknown option: %s\\n' \"$1\" >&2\nexit 2\n");
    await fs.chmod(executable, 0o755);
    try {
      const result = await probeRuntime(definition({
        command: executable,
        probeArgs: ["--help"],
        requiredFlags: ["--prompt"],
      }), { now: fixedNow });
      assert.equal(result.status, "available");
      assert.equal(result.readiness, "unsupported");
      assert.equal(result.canRun, false);
      assert.equal(result.checks?.protocol, "failed");
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  });

  it("surfaces Gemini personal OAuth retirement instead of reporting ready", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "better-me-gemini-home-"));
    const geminiDirectory = path.join(home, ".gemini");
    await fs.mkdir(geminiDirectory, { recursive: true });
    await fs.writeFile(path.join(geminiDirectory, "settings.json"), JSON.stringify({ security: { auth: { selectedType: "oauth-personal" } } }));
    const executable = path.join(home, "gemini");
    await fs.writeFile(executable, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf '0.34.0\\n'; exit 0; fi\nprintf 'Usage: gemini --prompt --output-format stream-json\\n'; exit 0\n");
    await fs.chmod(executable, 0o755);
    try {
      const result = await probeRuntime({
        ...definition({ id: "gemini-cli", name: "Gemini CLI", transport: "stream-json" }),
        command: executable,
        probeArgs: ["--help"],
        requiredFlags: ["--prompt", "--output-format", "stream-json"],
        authEnvVars: ["GEMINI_API_KEY"],
        authFiles: ["~/.gemini/oauth_creds.json"],
      }, { env: { PATH: "", HOME: home }, homeDirectory: home, now: fixedNow });
      assert.equal(result.status, "available");
      assert.equal(result.readiness, "unsupported");
      assert.equal(result.canRun, false);
      assert.equal(result.checks?.auth, "unsupported");
      assert.match(result.detail ?? "", /Antigravity/);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

describe("agent event bus", () => {
  it("assigns monotonic sequence numbers and replays after a cursor", () => {
    const bus = new AgentEventBus();
    const first = bus.publish("run-1", "run.started", { runtimeId: "pi" });
    const second = bus.publish("run-1", "text.delta", { text: "hello" }, "pi");
    assert.equal(first.sequence, 1);
    assert.equal(second.sequence, 2);
    assert.deepEqual(bus.get("run-1", 1).map((event) => event.sequence), [2]);
    assert.match(encodeSseEvent(second), /^id: run-1:2:/);
    assert.match(encodeSseEvent(second), /event: text\.delta/);
  });
});

describe("agent run manager", () => {
  it("runs with an isolated directory and emits completion events", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "better-me-runs-"));
    const runtimeDefinition = definition({ command: process.execPath, promptArgs: ["-e", "process.stdout.write('hello\\n')"] });
    const registry = new RuntimeRegistry({ definitions: [runtimeDefinition] });
    const runtime = (await registry.scan())[0]! as RuntimeAgentInfo;
    const manager = new AgentRunManager({ rootDirectory: root, registry });
    try {
      const run = await manager.start({
        runtime,
        workflow: "test-workflow",
        prompt: "ignored prompt",
        contextPack: { role: "test", task: "emit hello", artifactRefs: [], toolAllowlist: [], redactedFields: [], content: {}, characterBudget: 1000 },
        timeoutMs: 5_000,
      });
      for (let i = 0; i < 50; i++) {
        if (manager.get(run.id)?.status !== "running") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const completed = manager.get(run.id)!;
      assert.equal(completed.status, "completed");
      assert.equal(completed.runDirectory, path.join(root, run.id));
      assert.equal(completed.outputDirectory, path.join(root, run.id, "output"));
      assert.equal(completed.isolation, "process");
      assert.deepEqual(completed.allowedReadPaths, []);
      assert.equal(JSON.parse(await fs.readFile(path.join(run.runDirectory, "input", "task.json"), "utf8")).workflow, "test-workflow");
      assert.equal(JSON.parse(await fs.readFile(path.join(run.runDirectory, "input", "access.json"), "utf8")).isolation, "process");
      const result = JSON.parse(await fs.readFile(path.join(run.outputDirectory, "result.json"), "utf8"));
      assert.match(result.output, /hello/);
      assert.ok(manager.events.get(run.id).some((event) => event.type === "run.completed"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("prefers a CLI's authoritative completed answer over earlier streaming chunks", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "better-me-final-answer-"));
    const finalEvent = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "完整最终答复" } });
    const script = `process.stdout.write('临时片段\\n'+${JSON.stringify(finalEvent)}+'\\n')`;
    const runtimeDefinition = definition({ id: "codex", name: "Codex", command: process.execPath, transport: "json-rpc", promptArgs: ["-e", script] });
    const registry = new RuntimeRegistry({ definitions: [runtimeDefinition] });
    const runtime = (await registry.scan())[0]! as RuntimeAgentInfo;
    const manager = new AgentRunManager({ rootDirectory: root, registry });
    try {
      const run = await manager.start({ runtime, workflow: "final-answer-test", prompt: "emit answer", timeoutMs: 5_000 });
      for (let i = 0; i < 50 && manager.get(run.id)?.status === "running"; i++) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(manager.get(run.id)?.status, "completed");
      const output = await manager.getOutput(run.id);
      assert.equal(output.output, "完整最终答复");
      assert.match(output.rawOutput ?? "", /临时片段/);
      assert.match(output.rawOutput ?? "", /完整最终答复/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps answer lines that arrive after the first 500 lines in one output chunk", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "better-me-many-answer-lines-"));
    const expectedLines = Array.from({ length: 750 }, (_, index) => `answer-line-${index + 1}`);
    const script = 'process.stdout.write(Array.from({length:750},(_,i)=>"answer-line-"+(i+1)).join("\\n")+"\\n")';
    const runtimeDefinition = definition({ command: process.execPath, promptArgs: ["-e", script] });
    const registry = new RuntimeRegistry({ definitions: [runtimeDefinition] });
    const runtime = (await registry.scan())[0]! as RuntimeAgentInfo;
    const manager = new AgentRunManager({ rootDirectory: root, registry });
    try {
      const run = await manager.start({ runtime, workflow: "many-answer-lines", prompt: "emit answer", timeoutMs: 5_000 });
      for (let i = 0; i < 50 && manager.get(run.id)?.status === "running"; i++) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(manager.get(run.id)?.status, "completed");
      const output = await manager.getOutput(run.id);
      for (const expected of [expectedLines[0]!, expectedLines[500]!, expectedLines.at(-1)!]) {
        assert.ok(output.output?.includes(expected), `expected complete answer to include ${expected}`);
      }
      const eventLogPath = path.join(run.runDirectory, "events.ndjson");
      await manager.flush(run.id);
      assert.match(await fs.readFile(eventLogPath, "utf8"), /"type":"run\.completed"/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("restores completed run records and event history after a host restart", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "better-me-persisted-runs-"));
    const runtimeDefinition = definition({ command: process.execPath, promptArgs: ["-e", "process.stdout.write('persisted\\n')"] });
    const registry = new RuntimeRegistry({ definitions: [runtimeDefinition] });
    const runtime = (await registry.scan())[0]! as RuntimeAgentInfo;
    try {
      const firstManager = new AgentRunManager({ rootDirectory: root, registry });
      const started = await firstManager.start({ runtime, workflow: "persist-test", prompt: "ignored", timeoutMs: 5_000 });
      for (let i = 0; i < 50 && firstManager.get(started.id)?.status === "running"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(firstManager.get(started.id)?.status, "completed");
      await firstManager.flush(started.id);

      const restartedManager = new AgentRunManager({ rootDirectory: root, registry });
      await restartedManager.ready();
      assert.equal(restartedManager.get(started.id)?.status, "completed");
      assert.ok(restartedManager.list().some((record) => record.id === started.id));
      assert.ok(restartedManager.events.get(started.id).some((event) => event.type === "run.completed"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
