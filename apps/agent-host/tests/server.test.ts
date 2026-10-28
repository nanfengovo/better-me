import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { createAgentServer } from "../src/server.js";

describe("agent-host HTTP Server", () => {
  let server: http.Server;
  const port = 5199;
  const token = "test-agent-secret-token";
  const baseUrl = `http://127.0.0.1:${port}`;

  before(async () => {
    const checkpointer = new MemorySaver() as any;
    server = createAgentServer({
      port,
      host: "127.0.0.1",
      allowedOrigins: ["http://127.0.0.1:5173"],
      authToken: token,
      checkpointer,
    });
    await new Promise((resolve) => server.once("listening", resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("rejects unauthorized requests with 401", async () => {
    const res = await fetch(`${baseUrl}/api/v1/agent/jd-match/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 401);
  });

  it("exposes an explicit authenticated health endpoint", async () => {
    const res = await fetch(`${baseUrl}/api/v1/agent/health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok", service: "agent-host" });
  });

  it("rejects request bodies larger than the bounded JSON limit", async () => {
    const res = await fetch(`${baseUrl}/api/v1/agent/chat`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "x".repeat(16 * 1024 * 1024 + 1),
    });
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: "request_body_too_large" });
  });

  it("returns 404 when querying unknown thread state", async () => {
    const res = await fetch(`${baseUrl}/api/v1/agent/jd-match/state/unknown-thread-404`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, "thread_not_found");
  });

  it("exposes a stable local runtime inventory", async () => {
    const res = await fetch(`${baseUrl}/api/v1/agent/runtimes`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.runtimes.map((item: { id: string }) => item.id), [
      "claude-code",
      "opencode",
      "gemini-cli",
      "codex",
      "deepseek-harness",
      "pi",
      "antigravity",
    ]);
    assert.ok(body.runtimes.every((item: { status: string }) => ["available", "not-installed", "needs-config", "error"].includes(item.status)));
  });

  it("runs the default career workflow through its approval gate", async () => {
    const start = await fetch(`${baseUrl}/api/v1/agent/workflows/career/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: "career-http-test", task: "核实上海岗位与公司地点" }),
    });
    assert.equal(start.status, 200);
    const initial = await start.json();
    assert.equal(initial.status, "awaiting_approval");
    assert.equal(initial.workers.length, 5);
    assert.equal(initial.artifacts.at(-1).type, "CoverageReceipt");

    const resume = await fetch(`${baseUrl}/api/v1/agent/workflows/career/resume`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: "career-http-test", approval: { status: "approved", actorScope: "user", idempotencyKey: "career-http-12345678" } }),
    });
    assert.equal(resume.status, 200);
    const completed = await resume.json();
    assert.equal(completed.status, "complete");
  });
});

describe("agent-host runtime HTTP API", () => {
  let server: http.Server;
  let runsDirectory: string;
  const port = 5200;
  const token = "test-runtime-token";
  const baseUrl = `http://127.0.0.1:${port}`;

  before(async () => {
    runsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "better-me-http-runs-"));
    server = createAgentServer({
      port,
      host: "127.0.0.1",
      allowedOrigins: [],
      authToken: token,
      checkpointer: new MemorySaver() as any,
      runsDirectory,
      runtimeDefinitions: [{
        id: "pi",
        name: "Pi test runtime",
        command: process.execPath,
        fallbackCommands: [],
        versionArgs: ["--version"],
        transport: "stdio",
        capabilities: ["text", "streaming"],
        promptArgs: ["-e", "process.stdout.write('http-ok\\n')"],
      }],
    });
    await new Promise((resolve) => server.once("listening", resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(runsDirectory, { recursive: true, force: true });
  });

  it("starts a local run and supports SSE replay", async () => {
    const start = await fetch(`${baseUrl}/api/v1/agent/runs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ runtimeId: "pi", workflow: "http-test", prompt: "hello" }),
    });
    assert.equal(start.status, 202);
    const started = await start.json();
    const runId = started.run.id as string;

    let finalStatus: { run: { status: string }; output?: string; rawOutput?: string } | undefined;
    for (let i = 0; i < 50; i++) {
      const status = await fetch(`${baseUrl}/api/v1/agent/runs/${runId}`, { headers: { Authorization: `Bearer ${token}` } });
      finalStatus = await status.json();
      if (finalStatus.run.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(finalStatus?.run.status, "completed");
    assert.equal(finalStatus?.output, "http-ok");
    assert.match(finalStatus?.rawOutput ?? "", /http-ok/);

    const controller = new AbortController();
    const events = await fetch(`${baseUrl}/api/v1/agent/runs/${runId}/events?after=0`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    assert.equal(events.status, 200);
    const reader = events.body!.getReader();
    let text = "";
    for (let i = 0; i < 10 && !text.includes("run.completed"); i++) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    controller.abort();
    assert.match(text, /run\.started/);
    assert.match(text, /run\.completed/);

    const history = await fetch(`${baseUrl}/api/v1/agent/runs?limit=10`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(history.status, 200);
    const historyBody = await history.json();
    assert.ok(historyBody.runs.some((item: { id: string }) => item.id === runId));
  });
});
