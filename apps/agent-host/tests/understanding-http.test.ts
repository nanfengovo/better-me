import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import type { RuntimeAgentDef, UnderstandingSession } from "@better-me/agent-contracts";
import { createAgentServer } from "../src/server.js";
import { RuntimeRegistry } from "../src/runtime/registry.js";

const summary = {
  summary: "虚构项目负责把外部运单转为内部搬运任务。", terms: [{ term: "RCS", meaning: "本项目的任务编排层，非车端运动控制器。", evidenceIds: [] }],
  boundaries: ["不推断个人实现范围"], claims: [], unknowns: ["个人贡献尚未访谈"],
};
const reply = (ready: boolean) => JSON.stringify({ kind: "reply", message: ready ? "请核对本项目理解。" : "先对齐项目语言。", understanding: summary, readyForConfirmation: ready,
  ...(ready ? {} : { question: { id: "scope", text: "这里的 RCS 是否负责运单编排？", why: "缩写不能代表项目含义。", options: [{ id: "orchestration", label: "是，负责运单编排" }, { id: "other", label: "不完全是，我补充" }], allowMultiple: false } }),
});

test("understanding HTTP authenticates, keeps consensus separate and guards exact confirmation revision", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "betterme-understanding-http-"));
  let calls = 0;
  const server = createAgentServer({ port: 0, host: "127.0.0.1", authToken: "isolated-test-token", allowedOrigins: ["http://fixture.invalid"],
    checkpointer: new MemorySaver() as never, runsDirectory: path.join(dir, "runs"), understandingDirectory: path.join(dir, "sessions"),
    runtimeDefinitions: [], understandingReasoner: async () => async () => reply(++calls > 1),
  });
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/v1/agent/understanding`;
  const request = (url: string, method = "GET", body?: unknown) => fetch(base + url, { method, headers: { Authorization: "Bearer isolated-test-token", "Content-Type": "application/json", Origin: "http://fixture.invalid" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const settled = async (id: string): Promise<UnderstandingSession> => {
    for (let i = 0; i < 100; i++) {
      const state: UnderstandingSession = await (await request(`/sessions/${id}`)).json();
      if (state.phase !== "running") return state;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("test turn did not settle");
  };
  try {
    assert.equal((await fetch(`${base}/sessions/unknown`)).status, 401);
    const cors = await request("/sessions/unknown", "OPTIONS");
    assert.match(cors.headers.get("access-control-allow-methods") ?? "", /DELETE/);
    const created = await request("/sessions", "POST", { workspaceKey: "synthetic", projectKey: "project", label: "虚构项目", sourceText: "RCS 搬运系统" });
    assert.equal(created.status, 201);
    let session: UnderstandingSession = await created.json();
    const runtime = { kind: "model", modelSettings: { provider: "ollama", model: "fixture", apiKey: "NEVER-PERSIST-TEST-KEY" } };
    assert.equal((await request(`/sessions/${session.id}/turns`, "POST", { expectedRevision: session.revision, idempotencyKey: "no-consent", answer: "开始", runtime })).status, 400);
    const initial = { expectedRevision: session.revision, idempotencyKey: "first-turn-key", answer: "请先理解项目", consentToSend: true, runtime };
    assert.equal((await request(`/sessions/${session.id}/turns`, "POST", initial)).status, 202);
    session = await settled(session.id);
    assert.equal(session.phase, "awaiting-answer"); assert.ok(session.question);
    assert.equal((await request(`/sessions/${session.id}/turns`, "POST", initial)).status, 202);
    assert.equal(calls, 1, "retrying delivery is not a new model run");
    const next = { expectedRevision: session.revision, idempotencyKey: "second-turn-key", answer: "准确，仅任务编排。", selectedOptionIds: ["orchestration"], consentToSend: true, runtime };
    assert.equal((await request(`/sessions/${session.id}/turns`, "POST", next)).status, 202);
    session = await settled(session.id); assert.equal(session.phase, "awaiting-confirmation");
    assert.equal((await request(`/sessions/${session.id}/confirm`, "POST", { expectedRevision: session.revision - 1, summaryHash: session.summaryHash })).status, 409);
    const confirmed = await request(`/sessions/${session.id}/confirm`, "POST", { expectedRevision: session.revision, summaryHash: session.summaryHash });
    assert.equal(confirmed.status, 200); session = await confirmed.json(); assert.equal(session.phase, "confirmed");
    assert.equal(session.confirmation?.revision, session.revision);
    const fixture = path.join(dir, "sample.ts"); await writeFile(fixture, "export const taskType = 'fetch-and-put';\n");
    const granted = await request(`/sessions/${session.id}/grants`, "POST", { path: fixture });
    assert.equal(granted.status, 200); session = await granted.json(); assert.equal(session.confirmation, undefined);
    const revoked = await request(`/sessions/${session.id}/grants/${session.grants[0]!.id}`, "DELETE");
    assert.equal(revoked.status, 200);
    const persisted = await Promise.all((await readdir(path.join(dir, "sessions"))).filter(name => name.endsWith(".json")).map(name => readFile(path.join(dir, "sessions", name), "utf8")));
    assert.ok(persisted.length); assert.ok(persisted.every(text => !text.includes("NEVER-PERSIST-TEST-KEY")));
    assert.equal((await request("/sessions/../outside")).status, 404);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});

test("understanding HTTP discovers unsupported runtimes without legacy probes and rejects native turns without changing history", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "betterme-understanding-http-discovery-"));
  const sentinel = path.join(dir, "legacy-probe-ran");
  const probeArgs = ["-e", `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'unexpected')`];
  const definition: RuntimeAgentDef = {
    id: "fixture-native", name: "Synthetic native runtime", command: process.execPath, fallbackCommands: [],
    versionArgs: probeArgs, probeArgs, requiredFlags: [], promptArgs: [], transport: "stdio", capabilities: ["text"],
    authEnvVars: [], authFiles: [path.join(dir, "never-read-auth.json")],
  };
  // Safety tripwire: a regressed route fails before legacy process/config probes
  // can run. The unsupported ID also prevents the intentional Claude bare probe.
  const legacyScan = t.mock.method(RuntimeRegistry.prototype, "scan", async () => {
    throw new Error("Understanding HTTP must not invoke legacy runtime discovery");
  });
  const server = createAgentServer({ port: 0, host: "127.0.0.1", authToken: "isolated-discovery-token", allowedOrigins: ["http://fixture.invalid"],
    checkpointer: new MemorySaver() as never, runsDirectory: path.join(dir, "runs"), understandingDirectory: path.join(dir, "sessions"),
    runtimeDefinitions: [definition],
  });
  try {
    await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/api/v1/agent/understanding`;
    const request = (url: string, method = "GET", body?: unknown) => fetch(base + url, { method,
      headers: { Authorization: "Bearer isolated-discovery-token", "Content-Type": "application/json", Origin: "http://fixture.invalid" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    const capabilities = await request("/capabilities");
    assert.equal(capabilities.status, 200);
    const payload: { runtimes: Array<{ id: string; available: boolean; supported: boolean }> } = await capabilities.json();
    assert.equal(payload.runtimes.length, 1);
    assert.equal(payload.runtimes[0]?.id, "fixture-native");
    assert.equal(payload.runtimes[0]?.available, true);
    assert.equal(payload.runtimes[0]?.supported, false);
    assert.equal(legacyScan.mock.callCount(), 0);
    await assert.rejects(readFile(sentinel, "utf8"), { code: "ENOENT" });

    const created = await request("/sessions", "POST", { workspaceKey: "synthetic", projectKey: "native-discovery", label: "Synthetic project", sourceText: "Synthetic source only" });
    assert.equal(created.status, 201);
    const session: UnderstandingSession = await created.json();
    const rejected = await request(`/sessions/${session.id}/turns`, "POST", {
      expectedRevision: session.revision, idempotencyKey: "unsupported-native-turn", answer: "Synthetic correction", consentToSend: true,
      runtime: { kind: "native", runtimeId: "fixture-native" },
    });
    assert.equal(rejected.status, 422);
    assert.equal((await rejected.json()).error, "native_runtime_unavailable");
    const refreshed = await request(`/sessions/${session.id}`);
    assert.equal(refreshed.status, 200);
    assert.deepEqual(await refreshed.json(), session, "Rejected native turns must not alter revision, turn count or history");
    assert.equal(legacyScan.mock.callCount(), 0);
    await assert.rejects(readFile(sentinel, "utf8"), { code: "ENOENT" });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});
