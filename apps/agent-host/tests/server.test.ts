import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { createAgentServer } from "../src/server.js";
import { registerTestIdentity } from "./fixtures/identity.js";
import {seedLegacyCareer} from "./fixtures/legacy-career.js";

describe("agent-host HTTP Server", () => {
  let server: http.Server;
  let directory: string;
  let identityHeaders: Record<string, string>;
  let checkpointer: MemorySaver;
  const port = 5199;
  const token = "test-agent-secret-token";
  const baseUrl = `http://127.0.0.1:${port}`;

  before(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-http-identity-"));
    checkpointer = new MemorySaver();
    server = createAgentServer({
      port,
      host: "127.0.0.1",
      allowedOrigins: ["http://127.0.0.1:5173"],
      authToken: token,
      checkpointer:checkpointer as never,
      runsDirectory: directory,
    });
    await new Promise((resolve) => server.once("listening", resolve));
    identityHeaders = (await registerTestIdentity(baseUrl, token)).headers;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
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

  it("allows the configured origin to preflight account-scoped routing updates", async () => {
    const response = await fetch(`${baseUrl}/api/v1/agent/routing`, {
      method: "OPTIONS",
      headers: { Origin: "http://127.0.0.1:5173", "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "Content-Type, Authorization, X-BetterMe-Owner" },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "http://127.0.0.1:5173");
    assert.ok(response.headers.get("access-control-allow-methods")?.split(/,\s*/).includes("PUT"));
    assert.equal(response.headers.get("access-control-allow-credentials"), "true");
    const rejected = await fetch(`${baseUrl}/api/v1/agent/routing`, {
      method: "OPTIONS", headers: { Origin: "https://untrusted.invalid", "Access-Control-Request-Method": "PUT" },
    });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.get("access-control-allow-origin"), null);
  });

  it("rejects request bodies larger than the bounded JSON limit", async () => {
    const res = await fetch(`${baseUrl}/api/v1/agent/tasks`, {
      method: "POST",
      headers: { ...identityHeaders, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "x".repeat(16 * 1024 * 1024 + 1),
    });
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: "request_body_too_large" });
  });

  it("returns 404 when querying unknown thread state", async () => {
    const res = await fetch(`${baseUrl}/api/v1/agent/jd-match/state/unknown-thread-404`, {
      headers: { ...identityHeaders, Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, "thread_not_found");
  });

  it("exposes a stable local runtime inventory", async () => {
    const res = await fetch(`${baseUrl}/api/v1/agent/runtimes`, {
      headers: { ...identityHeaders, Authorization: `Bearer ${token}` },
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

  it("retains full pending and approved workflow history but never restarts a retired graph", async () => {
    const identity=await registerTestIdentity(baseUrl,token,"legacy-career-http");
    const source="  旧工作流完整原文😀\r\n"+"真实未核实。".repeat(5000)+"HISTORY-END  ";
    const seeded=await seedLegacyCareer(checkpointer,identity.principal.id,"career-http-test",source);
    const before=JSON.stringify(seeded.tuple);
    const start = await fetch(`${baseUrl}/api/v1/agent/workflows/career/start`, {
      method: "POST",
      headers: { ...identity.headers, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: "career-http-test", task: "核实上海岗位与公司地点" }),
    });
    assert.equal(start.status, 410);
    const read=()=>fetch(`${baseUrl}/api/v1/agent/workflows/career/state/career-http-test`,{headers:{...identity.headers,Authorization:`Bearer ${token}`}});
    const initial=await(await read()).json();
    assert.equal(initial.readOnly,true);assert.equal(initial.legacy,true);assert.equal(initial.state.task,source);
    assert.equal(initial.state.workers.length,5);assert.equal(initial.state.artifacts[0].payload.task,source);assert.equal(initial.state.artifacts.at(-1).type,"CoverageReceipt");
    assert.deepEqual(initial.pendingWrites,JSON.parse(before).pendingWrites);

    const resume = await fetch(`${baseUrl}/api/v1/agent/workflows/career/resume`, {
      method: "POST",
      headers: { ...identity.headers, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: "career-http-test", approval: { status: "approved", actorScope: "user", idempotencyKey: "career-http-12345678" } }),
    });
    assert.equal(resume.status, 410);
    assert.deepEqual(await(await read()).json(),initial);assert.equal(JSON.stringify(await checkpointer.getTuple(seeded.config)),before);
    await seedLegacyCareer(checkpointer,identity.principal.id,"career-approved-test",source,true);
    const approved=await(await fetch(`${baseUrl}/api/v1/agent/workflows/career/state/career-approved-test`,{headers:{...identity.headers,Authorization:`Bearer ${token}`}})).json();
    assert.equal(approved.state.approval.actorScope,identity.principal.id);assert.equal(approved.state.task,source);assert.equal(approved.readOnly,true);
    const duplicate = await fetch(`${baseUrl}/api/v1/agent/workflows/career/resume`, {
      method: "POST", headers: { ...identityHeaders, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: "career-http-test", approval: { status: "approved", actorScope: "user", idempotencyKey: "career-http-12345678" } }),
    });
    assert.equal(duplicate.status, 410, "even a repeated approval cannot restart a retired graph");
  });
});

describe("agent-host runtime HTTP API", () => {
  let server: http.Server;
  let runsDirectory: string;
  let identityHeaders: Record<string, string>;
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
      trustedSingleUserRuntimeExecution: true,
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
    identityHeaders = (await registerTestIdentity(baseUrl, token)).headers;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(runsDirectory, { recursive: true, force: true });
  });

  it("refuses new local execution even in trusted mode but retains complete legacy output and SSE history", async () => {
    const identity=await registerTestIdentity(baseUrl,token,"legacy-run-fixture");identityHeaders=identity.headers;
    const runId="run_legacy_synthetic",now="2026-11-12T00:00:00.000Z";
    const runDirectory=path.join(runsDirectory,"accounts-v1","owners",identity.principal.id,"runs",runId),outputDirectory=path.join(runDirectory,"output");
    await fs.mkdir(outputDirectory,{recursive:true});
    await fs.writeFile(path.join(runDirectory,"run.json"),JSON.stringify({id:runId,workflow:"http-test",runtimeId:"pi",status:"completed",createdAt:now,startedAt:now,finishedAt:now,runDirectory,outputDirectory,isolation:"process"}));
    await fs.writeFile(path.join(outputDirectory,"result.json"),JSON.stringify({answer:"http-ok",output:"http-ok\n"}));
    await fs.writeFile(path.join(runDirectory,"events.ndjson"),["run.started","run.completed"].map((type,index)=>JSON.stringify({id:`${runId}:${index+1}:synthetic`,runId,sequence:index+1,type,timestamp:now,payload:{}})).join("\n"));
    const start = await fetch(`${baseUrl}/api/v1/agent/runs`, {
      method: "POST",
      headers: { ...identityHeaders, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ runtimeId: "pi", workflow: "http-test", prompt: "hello" }),
    });
    assert.equal(start.status, 410);
    assert.deepEqual(await start.json(),{error:"runtime_run_moved_to_tasks",next:"/api/v1/agent/tasks"});

    let finalStatus: { run: { status: string }; output?: string; rawOutput?: string } | undefined;
    for (let i = 0; i < 50; i++) {
      const status = await fetch(`${baseUrl}/api/v1/agent/runs/${runId}`, { headers: { ...identityHeaders, Authorization: `Bearer ${token}` } });
      finalStatus = await status.json();
      if (finalStatus.run.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(finalStatus?.run.status, "completed");
    assert.equal(finalStatus?.output, "http-ok");
    assert.match(finalStatus?.rawOutput ?? "", /http-ok/);

    const controller = new AbortController();
    const events = await fetch(`${baseUrl}/api/v1/agent/runs/${runId}/events?after=0`, {
      headers: { ...identityHeaders, Authorization: `Bearer ${token}` },
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

    const history = await fetch(`${baseUrl}/api/v1/agent/runs?limit=10`, { headers: { ...identityHeaders, Authorization: `Bearer ${token}` } });
    assert.equal(history.status, 200);
    const historyBody = await history.json();
    assert.ok(historyBody.runs.some((item: { id: string }) => item.id === runId));
  });
});
