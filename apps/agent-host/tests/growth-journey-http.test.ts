import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { MemorySaver } from "@langchain/langgraph";
import { GROWTH_PRACTICE_STARTER_SOURCE } from "@better-me/agent-contracts";
import { createAgentServer } from "../src/server.js";
import { registerTestIdentity } from "./fixtures/identity.js";

type Journey = {
  id: string;
  ownerId: string;
  revision: number;
  mode: "synthetic";
  stage: "choose_source" | "practice" | "checkpoint_saved" | "verification_failed" | "ready_for_acceptance" | "completed" | "outcome_unknown";
  goal: { id: string; revision: 1; title: string; targetWeeks: number; weeklyHours: number; successCriteria: string };
  source?: { id: string; version: string; title: string; text: string; hash: string; locator: string; provenance: "authored_synthetic" };
  task?: { id: string; revision: number; status: string; practice: { phase: string; checkpoint?: { lookupCalls: number }; verification?: { passed: number; total: number; checks: { id: string; passed: boolean }[] }; verificationHash?: string } };
  project?: { scope: "synthetic_practice"; mastery: "pending_retest"; reportHash: string };
};

const token = "synthetic-growth-http-token";
const create = {
  mode: "synthetic" as const,
  goal: { title: "三个月建立 Agent 工程能力", targetWeeks: 12, weeklyHours: 5 },
  idempotencyKey: "synthetic-growth-first-journey",
  consent: true as const,
};

test("authenticated synthetic growth journeys are owner-isolated and idempotent without career inputs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-growth-http-"));
  let server: http.Server | undefined;
  try {
    server = createAgentServer({ host: "127.0.0.1", port: 0, authToken: token, allowedOrigins: [], runtimeDefinitions: [],
      identityDirectory: path.join(directory, "identity"), runsDirectory: path.join(directory, "runs"),
      understandingDirectory: path.join(directory, "understanding"), checkpointer: new MemorySaver() as never });
    await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`, base = `${origin}/api/v1/agent/growth`;
    const alice = await registerTestIdentity(origin, token, "growth-alice");
    const bob = await registerTestIdentity(origin, token, "growth-bob");
    const headers = (owner: Record<string, string>) => ({ ...owner, Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
    const call = (owner: Record<string, string>, suffix: string, body?: unknown) => fetch(`${base}${suffix}`, {
      method: body === undefined ? "GET" : "POST", headers: headers(owner),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = async (response: Response) => { const payload = await response.json() as { journey: Journey }; assert.ok(response.ok, JSON.stringify(payload)); return payload.journey; };

    assert.equal((await fetch(`${base}/journeys`)).status, 401);
    const sourceResponse = await call(alice.headers, "/sources"); assert.equal(sourceResponse.status, 200, await sourceResponse.clone().text());
    const sourcePayload = await sourceResponse.json() as { sources: Journey["source"][] };
    assert.ok(sourcePayload.sources.length >= 1);
    assert.equal(sourcePayload.sources[0]?.provenance, "authored_synthetic");
    assert.match(sourcePayload.sources[0]?.locator ?? "", /合成|synthetic/i);

    const journey = await parsed(await call(alice.headers, "/journeys", create));
    assert.equal(journey.ownerId, alice.principal.id);
    assert.equal(journey.mode, "synthetic");
    assert.equal(journey.stage, "choose_source");
    assert.equal(journey.goal.title, create.goal.title);
    assert.equal("resume" in journey, false);
    assert.equal("job" in journey, false);
    assert.equal((await parsed(await call(alice.headers, "/journeys", create))).id, journey.id);

    const aliceResponse = await call(alice.headers, "/journeys"); assert.equal(aliceResponse.status, 200, await aliceResponse.clone().text());
    const aliceList = await aliceResponse.json() as { journeys: Journey[] };
    assert.deepEqual(aliceList.journeys.map(row => row.id), [journey.id]);
    assert.equal((await call(bob.headers, `/journeys/${journey.id}`)).status, 404);
    const bobResponse = await call(bob.headers, "/journeys"); assert.equal(bobResponse.status, 200, await bobResponse.clone().text());
    const bobList = await bobResponse.json() as { journeys: Journey[] };
    assert.deepEqual(bobList.journeys, []);
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("a saved lookup checkpoint survives a Host restart and explicit continuation verifies without another lookup", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-growth-restart-http-"));
  let server: http.Server | undefined, base = "";
  const open = async () => {
    server = createAgentServer({ host: "127.0.0.1", port: 0, authToken: token, allowedOrigins: [], runtimeDefinitions: [],
      identityDirectory: path.join(directory, "identity"), runsDirectory: path.join(directory, "runs"),
      understandingDirectory: path.join(directory, "understanding"), checkpointer: new MemorySaver() as never });
    await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address !== "string");
    base = `http://127.0.0.1:${address.port}`;
  };
  const shut = async () => { if (!server) return; const current = server; server = undefined; await new Promise<void>(resolve => current.close(() => resolve())); };
  try {
    await open();
    const alice = await registerTestIdentity(base, token, "growth-restart-alice");
    const headers = { ...alice.headers, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const call = (suffix: string, body?: unknown) => fetch(`${base}/api/v1/agent/growth${suffix}`, {
      method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = async (response: Response) => { const payload = await response.json() as { journey: Journey }; assert.ok(response.ok, JSON.stringify(payload)); return payload.journey; };
    const command = (journey: Journey, value: Record<string, unknown>) => call(`/journeys/${journey.id}/commands`, { expectedRevision: journey.revision, consent: true, ...value });

    const sourcesResponse = await call("/sources"); assert.equal(sourcesResponse.status, 200);
    const sources = (await sourcesResponse.json() as { sources: NonNullable<Journey["source"]>[] }).sources;
    const careerRecordUrl = () => `${base}/api/v1/agent/records/growth?key=synthetic-career-shadow`;
    const syntheticCareerShadow = { workspaceKey: "synthetic-career-shadow", revision: 1,
      settings: { goal: "原有职业成长记录保持不变" }, records: [{ id: "career-existing-synthetic" }] };
    const seeded = await fetch(careerRecordUrl(), { method: "POST", headers,
      body: JSON.stringify({ expectedRevision: 0, value: syntheticCareerShadow }) });
    assert.equal(seeded.status, 200, await seeded.clone().text());
    let growth = await parsed(await call("/journeys", { ...create, idempotencyKey: "synthetic-growth-restart-journey" }));
    growth = await parsed(await command(growth, { kind: "select_source", requestId: "select-checkpoint-source", sourceVersion: sources[0]!.version }));
    assert.equal(growth.stage, "practice");
    growth = await parsed(await command(growth, { kind: "submit_practice", requestId: "submit-checkpoint-practice",
      sourceCode: GROWTH_PRACTICE_STARTER_SOURCE, answer: "先读取已保存的检查点，再继续构造结果。",
      explanation: "工具结果已经持久化，因此恢复后不能再次调用相同 lookup。", attribution: "guided_example" }));
    assert.equal(growth.task?.practice.phase, "ready");
    growth = await parsed(await command(growth, { kind: "step_practice", requestId: "save-lookup-checkpoint",
      taskId: growth.task!.id, expectedTaskRevision: growth.task!.revision }));
    assert.equal(growth.stage, "checkpoint_saved");
    assert.equal(growth.task?.practice.phase, "lookup_saved");
    assert.equal(growth.task?.practice.checkpoint?.lookupCalls, 1);
    const checkpoint = growth.task!.practice.checkpoint;
    const beforeRestart = JSON.stringify(growth);

    await shut(); await open();
    const restored = await parsed(await call(`/journeys/${growth.id}`));
    assert.equal(JSON.stringify(restored), beforeRestart, "GET after restart is a byte-equivalent read of the same public record");
    assert.deepEqual(restored.task?.practice.checkpoint, checkpoint);
    assert.equal(restored.task?.practice.checkpoint?.lookupCalls, 1);
    const taskList = await (await fetch(`${base}/api/v1/agent/tasks`, { headers })).json() as { tasks: Record<string, unknown>[] };
    assert.deepEqual(taskList.tasks, [], "the isolated practice does not enter the real career task directory");

    growth = await parsed(await command(restored, { kind: "step_practice", requestId: "verify-from-saved-checkpoint",
      taskId: restored.task!.id, expectedTaskRevision: restored.task!.revision }));
    assert.equal(growth.stage, "ready_for_acceptance");
    assert.equal(growth.task?.practice.phase, "verified");
    assert.equal(growth.task?.practice.checkpoint?.lookupCalls, 1);
    assert.equal(growth.task?.practice.verification?.passed, 4);
    assert.equal(growth.task?.practice.verification?.total, 4);
    assert.equal(growth.task?.practice.verification?.checks.every(check => check.passed), true);
    assert.ok(growth.task?.practice.verificationHash);
    const careerShadow = await (await fetch(careerRecordUrl(), { headers })).json() as { revision: number; value: unknown };
    assert.equal(careerShadow.revision, 1); assert.deepEqual(careerShadow.value, syntheticCareerShadow);
    const accept = { kind: "accept_project", expectedRevision: growth.revision, consent: true, requestId: "accept-synthetic-project",
      taskId: growth.task!.id, reportHash: growth.task!.practice.verificationHash };
    growth = await parsed(await call(`/journeys/${growth.id}/commands`, accept));
    assert.equal(growth.stage, "completed");
    assert.equal(growth.project?.scope, "synthetic_practice");
    assert.equal(growth.project?.mastery, "pending_retest");
    assert.equal(growth.project?.reportHash, growth.task?.practice.verificationHash);
    assert.equal((await parsed(await call(`/journeys/${growth.id}/commands`, accept))).id, growth.id);
  } finally { await shut(); await rm(directory, { recursive: true, force: true }); }
});
