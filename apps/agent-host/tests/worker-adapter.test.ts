import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WorkerAdapterRegistry, buildWorkerPrompt } from "../src/runtime/worker-adapter.js";
import type { ContextPack, RuntimeAgentInfo } from "@better-me/agent-contracts";

function runtime(overrides: Partial<RuntimeAgentInfo> = {}): RuntimeAgentInfo {
  return {
    id: "claude-code",
    name: "Claude Code",
    command: "claude",
    fallbackCommands: [],
    versionArgs: ["--version"],
    transport: "stream-json",
    capabilities: ["text", "structured-output", "streaming"],
    promptArgs: ["-p", "--output-format", "stream-json"],
    status: "available",
    resolvedCommand: "/usr/local/bin/claude",
    checkedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const contextPack: ContextPack = {
  role: "discovery-worker",
  task: "查找岗位",
  artifactRefs: ["search-plan-1"],
  toolAllowlist: ["jobs.search.read"],
  redactedFields: ["resume.phone"],
  content: { keywords: ["C#", ".NET"] },
  characterBudget: 1_000,
};

describe("worker adapters", () => {
  it("injects only the bounded structured ContextPack into a native launch", () => {
    const adapter = new WorkerAdapterRegistry().get(runtime());
    const launch = adapter.buildLaunch({ runtime: runtime(), prompt: "只读检索", contextPack });
    assert.equal(launch.command, "/usr/local/bin/claude");
    assert.deepEqual(launch.args.slice(0, 3), ["-p", "--output-format", "stream-json"]);
    assert.ok(launch.args.includes("--verbose"), "Claude stream-json print mode requires verbose output");
    assert.match(launch.args.at(-1)!, /ContextPack JSON/);
    assert.match(launch.args.at(-1)!, /search-plan-1/);
    assert.match(launch.args.at(-1)!, /resume\.phone/);
  });

  it("normalizes Claude content deltas and tool calls", () => {
    const adapter = new WorkerAdapterRegistry().get(runtime());
    const delta = adapter.parseLine(JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "hello" } }), "stdout");
    assert.deepEqual(delta, [{ type: "text.delta", payload: { stream: "stdout", text: "hello" } }]);
    const tool = adapter.parseLine(JSON.stringify({ type: "tool_use", name: "jobs.search.read", input: { q: "C#" } }), "stdout");
    assert.equal(tool[0]?.type, "tool.called");
    assert.equal(tool[0]?.payload["name"], "jobs.search.read");
  });

  it("keeps only Claude assistant text and treats its final message as authoritative", () => {
    const adapter = new WorkerAdapterRegistry().get(runtime());
    assert.deepEqual(adapter.parseLine(JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "user prompt" }] } }), "stdout"), []);
    const delta = adapter.parseLine(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } } }), "stdout");
    assert.equal(delta[0]?.payload["text"], "partial");
    const final = adapter.parseLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "complete answer" }] } }), "stdout");
    assert.equal(final[0]?.payload["text"], "complete answer");
    assert.equal(final[0]?.payload["replace"], true);
  });

  it("extracts completed Codex answers without concatenating transport deltas", () => {
    const codex = runtime({ id: "codex", name: "Codex", transport: "json-rpc" });
    const adapter = new WorkerAdapterRegistry().get(codex);
    const final = adapter.parseLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Codex answer" } }), "stdout");
    assert.equal(final[0]?.type, "text.delta");
    assert.equal(final[0]?.payload["text"], "Codex answer");
    assert.equal(final[0]?.payload["replace"], true);
  });

  it("extracts OpenCode text parts and ignores unrelated event payloads", () => {
    const opencode = runtime({ id: "opencode", name: "OpenCode", transport: "jsonl" });
    const adapter = new WorkerAdapterRegistry().get(opencode);
    const text = adapter.parseLine(JSON.stringify({ type: "text", part: { type: "text", text: "OpenCode answer" } }), "stdout");
    assert.equal(text[0]?.payload["text"], "OpenCode answer");
    assert.deepEqual(adapter.parseLine(JSON.stringify({ type: "step_finish", reason: "stop" }), "stdout"), [{ type: "agent.output", payload: { type: "step_finish", reason: "stop" } }]);
  });

  it("uses Gemini's final response over assistant deltas and ignores prompt echoes", () => {
    const gemini = runtime({ id: "gemini-cli", name: "Gemini CLI", resolvedCommand: "/usr/local/bin/gemini", transport: "stream-json" });
    const adapter = new WorkerAdapterRegistry().get(gemini);
    assert.deepEqual(adapter.parseLine(JSON.stringify({ type: "message", role: "user", content: "prompt echo" }), "stdout"), []);
    const delta = adapter.parseLine(JSON.stringify({ type: "message", role: "assistant", content: "partial", delta: true }), "stdout");
    assert.equal(delta[0]?.payload["text"], "partial");
    const final = adapter.parseLine(JSON.stringify({ type: "result", response: "complete answer" }), "stdout");
    assert.equal(final[0]?.payload["text"], "complete answer");
    assert.equal(final[0]?.payload["replace"], true);
  });

  it("keeps Gemini's prompt value directly after -p", () => {
    const adapter = new WorkerAdapterRegistry().get(runtime({ id: "gemini-cli", name: "Gemini CLI", resolvedCommand: "/usr/local/bin/gemini", transport: "stream-json" }));
    const launch = adapter.buildLaunch({ runtime: runtime({ id: "gemini-cli", name: "Gemini CLI", resolvedCommand: "/usr/local/bin/gemini", transport: "stream-json" }), prompt: "总结", contextPack });
    assert.equal(launch.args[0], "-p");
    assert.match(launch.args[1]!, /总结/);
    assert.deepEqual(launch.args.slice(2), ["--output-format", "stream-json", "--approval-mode", "plan"]);
  });

  it("treats human-readable stderr as diagnostic output", () => {
    const adapter = new WorkerAdapterRegistry().get(runtime({ id: "gemini-cli", name: "Gemini CLI" }));
    const events = adapter.parseLine("rate limited", "stderr");
    assert.deepEqual(events, [{ type: "agent.output", payload: { stream: "stderr", text: "rate limited" } }]);
  });

  it("caps an oversized ContextPack before passing it to a CLI", () => {
    const oversized = { ...contextPack, characterBudget: 20, content: { note: "x".repeat(2_000) } };
    const prompt = buildWorkerPrompt("task", oversized);
    assert.ok(prompt.length < 200);
    assert.match(prompt, /context truncated/);
  });

  it("preserves long single-line final answers and marks only the hard output cap", () => {
    const adapter = new WorkerAdapterRegistry().get(runtime());
    const answer = "long-answer-".repeat(2_000);
    const events = adapter.parseLine(JSON.stringify({ type: "result", result: answer }), "stdout");
    assert.equal(events[0]?.payload["text"], answer);
    assert.equal(events[0]?.payload["truncated"], undefined);

    const capped = adapter.parseLine(JSON.stringify({ type: "result", result: "x".repeat(80_001) }), "stdout");
    assert.equal(capped[0]?.payload["truncated"], true);
    assert.match(String(capped[0]?.payload["text"]), /truncated at 80000 characters/);
  });
});
