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
import { registerTestIdentity } from "./fixtures/identity.js";
import {projectTaskHttp} from "./fixtures/project-task-http.js";
import type {UnderstandingRuntime} from "../src/understanding/http.js";

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
    runtimeDefinitions: [], careerTaskReasoner: async () => async () => reply(++calls > 1),
  });
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/v1/agent/understanding`;
  const identity = await registerTestIdentity(`http://127.0.0.1:${address.port}`, "isolated-test-token", "fixture-user", "http://fixture.invalid");
  const request = (url: string, method = "GET", body?: unknown) => fetch(base + url, { method, headers: { ...identity.headers, Authorization: "Bearer isolated-test-token", "Content-Type": "application/json", Origin: "http://fixture.invalid" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const taskApi=projectTaskHttp((route,body,method)=>fetch(`http://127.0.0.1:${address.port}/api/v1/agent${route}`,{method:method??(body===undefined?"GET":"POST"),headers:{...identity.headers,Authorization:"Bearer isolated-test-token","Content-Type":"application/json",Origin:"http://fixture.invalid"},...(body===undefined?{}:{body:JSON.stringify(body)})}));
  try {
    assert.equal((await fetch(`${base}/sessions/unknown`)).status, 401);
    const cors = await request("/sessions/unknown", "OPTIONS");
    assert.match(cors.headers.get("access-control-allow-methods") ?? "", /DELETE/);
    const runtime:UnderstandingRuntime = { kind: "model", modelSettings: { provider: "ollama", model: "fixture",baseUrl:"http://127.0.0.1:1/v1", apiKey: "NEVER-PERSIST-TEST-KEY" } };
    let session=await taskApi.create({workspaceKey:"synthetic",projectKey:"project",label:"虚构项目",sourceText:"RCS 搬运系统"},runtime);
    assert.equal((await request(`/sessions/${session.id}/turns`, "POST", { expectedRevision: session.revision, idempotencyKey: "no-consent", answer: "开始", runtime })).status, 410);
    const initial = { expectedRevision: session.revision, idempotencyKey: "first-turn-key", answer: "请先理解项目", consentToSend: true, runtime };
    const first=await taskApi.start(session.id,initial);assert.equal(first.status,202,await first.clone().text());
    session = await taskApi.settled(session.id);
    assert.equal(session.phase, "awaiting-answer"); assert.ok(session.question);
    assert.equal((await taskApi.start(session.id,initial)).status, 200);
    assert.equal(calls, 1, "retrying delivery is not a new model run");
    const next = { expectedRevision: session.revision, idempotencyKey: "second-turn-key", answer: "准确，仅任务编排。", selectedOptionIds: ["orchestration"], consentToSend: true, runtime };
    assert.equal((await taskApi.start(session.id,next)).status, 202);
    session = await taskApi.settled(session.id); assert.equal(session.phase, "awaiting-confirmation");
    assert.equal((await taskApi.mutate(session.id,"confirm",{ expectedRevision: session.revision - 1, summaryHash: session.summaryHash })).status, 409);
    const confirmed = await taskApi.mutate(session.id,"confirm",{ expectedRevision: session.revision, summaryHash: session.summaryHash });
    assert.equal(confirmed.status, 200); session = await confirmed.json(); assert.equal(session.phase, "confirmed");
    assert.equal(session.confirmation?.revision, session.revision);
    const fixture = path.join(dir, "sample.ts"); await writeFile(fixture, "export const taskType = 'fetch-and-put';\n");
    const granted = await taskApi.mutate(session.id,"grants",{expectedRevision:session.revision,path:fixture});
    assert.equal(granted.status, 200); session = await granted.json(); assert.equal(session.confirmation, undefined);
    const revoked = await taskApi.mutate(session.id,"revoke-grant",{expectedRevision:session.revision,grantId:session.grants[0]!.id});
    assert.equal(revoked.status, 200);
    const ownedDirectory = path.join(dir, "runs", "accounts-v1", "owners", identity.principal.id, "career-tasks-v1");
    const persisted = await Promise.all((await readdir(ownedDirectory)).filter(name => name.endsWith(".json")).map(name => readFile(path.join(ownedDirectory, name), "utf8")));
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
    // This hermetic single-owner fixture separately exercises the native compatibility gate.
    // Default multi-account rejection is covered by identity-http.test.ts.
    runtimeDefinitions: [definition], trustedSingleUserRuntimeExecution: true,
  });
  try {
    await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/api/v1/agent/understanding`;
    const identity = await registerTestIdentity(`http://127.0.0.1:${address.port}`, "isolated-discovery-token", "fixture-user", "http://fixture.invalid");
    const request = (url: string, method = "GET", body?: unknown) => fetch(base + url, { method,
      headers: { ...identity.headers, Authorization: "Bearer isolated-discovery-token", "Content-Type": "application/json", Origin: "http://fixture.invalid" },
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
    assert.equal(rejected.status, 410);
    assert.equal((await rejected.json()).error, "project_understanding_moved_to_tasks");
    const refreshed = await request(`/sessions/${session.id}`);
    assert.equal(refreshed.status, 200);
    assert.deepEqual(await refreshed.json(), session, "Rejected native turns must not alter revision, turn count or history");
    assert.equal(legacyScan.mock.callCount(), 0);
    await assert.rejects(readFile(sentinel, "utf8"), { code: "ENOENT" });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});
