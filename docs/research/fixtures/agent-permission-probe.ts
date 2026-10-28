/**
 * Research-only red-capable audit fixture, not production or normal CI tests.
 * Baseline 2026-10-29: 7 expected failing assertions + 3 passing controls.
 * Only synthetic Node protocol output and in-memory graph state; no model/API calls.
 * Run from repo root: node node_modules/tsx/dist/cli.mjs --test docs/research/fixtures/agent-permission-probe.ts
 * A nonzero exit currently documents known defects; it does NOT indicate a completed fix.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import { AgentRunManager } from "../../../apps/agent-host/src/runs/run-manager.ts";
import { RuntimeRegistry } from "../../../apps/agent-host/src/runtime/registry.ts";
import { WorkerAdapterRegistry } from "../../../apps/agent-host/src/runtime/worker-adapter.ts";
import { buildCareerOrchestrator } from "../../../apps/agent-host/src/graphs/career/graph.ts";
import { buildJdMatchGraph } from "../../../apps/agent-host/src/graphs/jd-match/graph.ts";
import { adaptTool } from "../../../apps/agent-host/src/tool-adapter.ts";
import { createToolRegistry } from "../../../packages/opportunities/src/tools.ts";

const hostRequire = createRequire(new URL("../../../apps/agent-host/package.json", import.meta.url));
const { MemorySaver, Command } = hostRequire("@langchain/langgraph");
// Match the ESM Zod instance used by the existing opportunities registry.
// A CJS/ESM duplicate would make its instanceof guard reject the fixture itself.
const { z } = await import(new URL("../../../packages/opportunities/node_modules/zod/dist/esm/index.js", import.meta.url).href);

// Synthetic protocol replay: no real Claude, model, browser or user data access.
const refusal = "The command needs user approval to run. You can check the Claude Code CLI version yourself by running this in your terminal: claude --version";
const denied = { type: "result", subtype: "success", is_error: false, result: refusal, permission_denials: [{ tool_name: "Bash", tool_use_id: "toolu_fixture", tool_input: { command: "claude --version" } }] };
const runtime = {
  id: "claude-code", name: "Synthetic Claude replay", command: process.execPath,
  fallbackCommands: [], versionArgs: ["--version"], transport: "stream-json",
  capabilities: ["text", "streaming"], promptArgs: [], status: "available",
  resolvedCommand: process.execPath, checkedAt: "2026-10-29T00:00:00.000Z",
};

async function replay(message: Record<string, unknown>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-agent-protocol-replay-"));
  const frame = JSON.stringify(message) + "\n";
  const chunks = Array.from({ length: Math.ceil(frame.length / 180) }, (_, i) => frame.slice(i * 180, (i + 1) * 180));
  const definition = { ...runtime, promptArgs: ["-e", "process.stdout.write(process.argv.slice(1,-1).join(''))", ...chunks] };
  const registry = new RuntimeRegistry({ definitions: [definition] });
  const manager = new AgentRunManager({ registry, rootDirectory: root, sandboxMode: "disabled" });
  const started = await manager.start({ runtime: definition, workflow: "permission-protocol-audit", prompt: "check CLI version", timeoutMs: 2_000 });
  for (let n = 0; n < 100 && manager.get(started.id)?.status === "running"; n++) await delay(10);
  const record = manager.get(started.id)!;
  const events = manager.events.get(started.id);
  // Allow asynchronous record/event persistence to settle before inspection.
  await delay(30);
  return { root, status: record.status, eventTypes: events.map(e => e.type), output: await manager.getOutput(started.id) };
}

test("a denied version command must not be reported as completed merely because the CLI exits 0", async () => {
  const result = await replay(denied);
  console.log(JSON.stringify({ case: "permission_denial", status: result.status, events: result.eventTypes, fixtureDirectory: result.root }));
  assert.notEqual(result.status, "completed", "user task was blocked by tool approval, not completed");
});

test("nested Claude tool use must be observable instead of silently disappearing", () => {
  const adapter = new WorkerAdapterRegistry().get(runtime);
  const events = adapter.parseLine(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_fixture", name: "Bash", input: { command: "claude --version" } }] } }), "stdout");
  assert.ok(events.some(e => e.type === "tool.called"), "nested tool invocation should produce a real tool event");
});

test("CLI result is_error must not be reported as completed on exit 0", async () => {
  const result = await replay({ type: "result", subtype: "error_during_execution", is_error: true, result: "Tool execution failed" });
  console.log(JSON.stringify({ case: "structured_error", status: result.status, events: result.eventTypes }));
  assert.equal(result.status, "failed", "structured runtime error must affect task outcome");
});

test("nested Claude denied tool result must be observable", () => {
  const adapter = new WorkerAdapterRegistry().get(runtime);
  const events = adapter.parseLine(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_fixture", is_error: true, content: "Tool permission denied" }] } }), "stdout");
  assert.ok(events.some(e => e.type === "tool.result"), "nested denied tool result should reach outcome interpretation");
});

test("control: real text completion with no denied tools remains completed", async () => {
  const result = await replay({ type: "result", subtype: "success", is_error: false, result: "Synthetic CLI 1.0", permission_denials: [] });
  assert.equal(result.status, "completed");
  assert.equal(result.output.output, "Synthetic CLI 1.0");
});

const approval = { status: "approved", actorScope: "user", idempotencyKey: "synthetic-approval-12345678" };

test("current resume route input must not repeat intake/plan or duplicate artifacts", async () => {
  const graph = buildCareerOrchestrator(new MemorySaver());
  const config = { configurable: { thread_id: "synthetic-current-resume" } };
  const initial = await graph.invoke({ task: "Synthetic readonly fixture", workspaceId: "fixture" }, config);
  const resumed = await graph.invoke({ approval }, config);
  const intakeCount = resumed.stepLog.filter((x: string) => x.startsWith("intake:")).length;
  console.log(JSON.stringify({ case: "current_resume", artifactsBefore: initial.artifacts.length, artifactsAfter: resumed.artifacts.length, intakeCount, coverage: resumed.coverage }));
  assert.equal(intakeCount, 1, "approval resume should continue interrupted work, not start intake again");
  assert.equal(resumed.artifacts.length, initial.artifacts.length);
});

test("control: installed LangGraph Command resume continues exactly at interrupt", async () => {
  const graph = buildCareerOrchestrator(new MemorySaver());
  const config = { configurable: { thread_id: "synthetic-command-resume" } };
  const initial = await graph.invoke({ task: "Synthetic readonly fixture", workspaceId: "fixture" }, config);
  const resumed = await graph.invoke(new Command({ resume: approval }), config);
  assert.equal(resumed.stepLog.filter((x: string) => x.startsWith("intake:")).length, 1);
  assert.equal(resumed.artifacts.length, initial.artifacts.length);
  assert.equal(resumed.approval.status, "approved");
});

test("session-only claims must not remain in checkpoint state despite the current privacy contract", async () => {
  let call = 0;
  const fakeModel = { invoke: async () => ({ content: JSON.stringify(++call === 1
    ? { title: "Synthetic job", company: "Fixture", location: "Fixture", requirements: ["TypeScript"], preferences: [], compensationRaw: null, techStack: ["TypeScript"] }
    : [{ jdItem: "TypeScript", evidenceType: "claimed", suggestion: "Synthetic suggestion", rationale: "Synthetic rationale" }]) }) };
  const graph = buildJdMatchGraph(fakeModel, new MemorySaver());
  const config = { configurable: { thread_id: "synthetic-checkpoint-privacy" } };
  await graph.invoke({ rawJd: "SYNTHETIC_JD_MARKER", allowedProfileEntryIds: [], sessionClaims: { draft: "SYNTHETIC_PRIVATE_CLAIM_MARKER" } }, config);
  const state = await graph.getState(config);
  console.log(JSON.stringify({ case: "checkpoint_privacy", retainsRawJd: state.values.rawJd === "SYNTHETIC_JD_MARKER", retainsSessionClaim: state.values.sessionClaims?.draft === "SYNTHETIC_PRIVATE_CLAIM_MARKER" }));
  assert.equal(state.values.sessionClaims?.draft, undefined, "documented session-only text is in checkpoint state");
});

test("tool adapter must enforce a zero-request budget instead of a no-op consumeRequests", async () => {
  const tool = {
    name: "fixture.consume", version: 1, description: "Synthetic budget counter", effect: "read-index",
    inputSchema: z.object({}), outputSchema: z.object({ reached: z.boolean() }),
    execute: (_input, context) => { context.consumeRequests(1); return { reached: true }; },
  };
  const adapted = adaptTool(tool, { threadId: "fixture-budget", stepIndex: 1, budget: { requests: 0, timeoutMs: 1_000, bytes: 1_024 } });
  let blocked = false;
  try { await adapted.invoke({}); } catch { blocked = true; }
  assert.equal(blocked, true, "adapter bypasses the trusted registry accounting path");
});

test("control: existing trusted tool registry enforces the same zero-request budget", async () => {
  const tool = {
    name: "fixture.consume", version: 1, description: "Synthetic budget counter", effect: "read-index",
    inputSchema: z.object({}), outputSchema: z.object({ reached: z.boolean() }),
    execute: (_input, context) => { context.consumeRequests(1); return { reached: true }; },
  };
  const registry = createToolRegistry([tool]);
  const result = await registry.execute("fixture.consume", {}, {
    requestId: "fixture-registry", actorScope: "agent-host/fixture", allowedEffects: ["read-index"],
    signal: new AbortController().signal, budget: { requests: 0, timeoutMs: 1_000, bytes: 1_024 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "budget-exceeded");
});
