import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  careerRuntimeBinding, CareerTaskSchema, type CareerTask, type CareerTaskEvidence,
} from "@better-me/agent-contracts";
import { observedRuntime } from "../../../evals/resume-quality/runtime-quality.mjs";
import golden from "../../../evals/resume-quality/gold/warehouse-replay-v1.json" with { type: "json" };
import { registerTestIdentity } from "./fixtures/identity.js";

const token = "synthetic-restart-test";
const targetRef = { kind: "profile_headline", locale: "zh" } as const;
const original = "维护仓储项目 Redis 重复请求回放用例。";
const [dedup, replay] = golden.expectedFacts;
const unknown = "上线收益未知。";

async function startHost(directory: string) {
  const child = spawn(process.execPath, [
    "--import", "tsx", "src/cli.ts", "--host", "127.0.0.1", "--port", "0",
    "--runs-dir", path.join(directory, "runs"), "--token", token,
  ], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      TEMP: os.tmpdir(), TMP: os.tmpdir(), BETTERME_AUTH_MODE: "local",
      AGENT_CHECKPOINT_DIR: path.join(directory, "checkpoints"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ready = Promise.withResolvers<string>();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    const address = /^\[agent-host\] listening on (http:\/\/127\.0\.0\.1:[1-9]\d*)$/.exec(line);
    if (address) ready.resolve(address[1]!);
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-1500); });
  const closed = once(child, "close");
  void closed.then(([code, signal]) => ready.reject(Error(`Host exited (${code ?? signal}): ${stderr}`)), ready.reject);
  const timer = setTimeout(() => ready.reject(Error("Host did not publish a listening address: " + stderr)), 45_000);
  async function stop() {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  }
  try {
    return { origin: await ready.promise, pid: child.pid!, stop };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

interface ModelContext {
  evidence: CareerTaskEvidence[];
  recentObservations: Array<{tool?: string; request?: {id?: string}; result?: {error?: string}}>;
}

async function startProvider() {
  const requests: ModelContext[] = [];
  const blocked = new Set<string>();
  const server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.url, "/v1/chat/completions");
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const state: ModelContext = JSON.parse(body.messages.at(-1).content.split("\n\n").at(-1));
      requests.push(state);
      const has = (id: string) => state.evidence.some(e => e.sourceId === id);
      // Hold one decision after each durable tool result. The first Host gets
      // an explicit pause; the next is killed without any shutdown hook.
      const stage = has("job") ? "job" : has("material:" + dedup!.sourceId) ? "material" : undefined;
      if (stage && !blocked.has(stage)) {
        blocked.add(stage);
        return;
      }
      let decision;
      if (!state.recentObservations.some(e => e.tool === "discover_tools")) {
        decision = { kind: "tool", tool: "discover_tools" };
      } else if (!state.recentObservations.some(e => e.request?.id === "unselected" && e.result?.error === "material_not_granted")) {
        decision = { kind: "tool", tool: "read_material", id: "unselected" };
      } else if (!has("material:" + dedup!.sourceId)) {
        decision = { kind: "tool", tool: "read_material", id: dedup!.sourceId };
      } else if (!has("job")) {
        decision = { kind: "tool", tool: "read_job" };
      } else if (!has("material:" + replay!.sourceId)) {
        decision = { kind: "tool", tool: "read_material", id: replay!.sourceId };
      } else if (!has("resume:headline")) {
        decision = { kind: "tool", tool: "read_resume", id: "headline" };
      } else {
        decision = { kind: "draft", patches: [{
          fieldId: "headline", targetRef, originalText: original, proposedText: "维护仓储项目的 Redis 重复请求回放用例。",
          rationale: "保留已提供的技术证据。", evidenceIds: state.evidence.map(e => e.id),
        }], unknowns: [unknown] };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "synthetic", object: "chat.completion", model: body.model, created: 1,
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(decision) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      }));
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    requests, blocked, baseUrl: `http://127.0.0.1:${address.port}/v1`,
    async close() {
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}

test("resume_tailor keeps tool checkpoints through pause, process death, concurrent resume and human receipt", { timeout: 180_000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-runtime-restart-"));
  // close the writer before removing its files, including when an assertion fails
  const cleanup: Array<() => Promise<unknown>> = [() => rm(directory, { recursive: true, force: true })];
  t.after(async () => { for (const dispose of cleanup.reverse()) await dispose(); });
  const provider = await startProvider();
  cleanup.push(() => provider.close());
  let host = await startHost(directory);
  cleanup.push(() => host.stop());
  const pids = [host.pid];
  async function restart() {
    await host.stop();
    host = await startHost(directory);
    pids.push(host.pid);
  }
  const identity = await registerTestIdentity(host.origin, token, "warehouse-fixture");
  const headers = { ...identity.headers, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const runtime = { kind: "model" as const, modelSettings: {
    provider: "ollama" as const, baseUrl: provider.baseUrl, model: "synthetic-warehouse", apiKey: "synthetic",
  } };
  const runtimeBinding = careerRuntimeBinding(runtime);
  const materials = golden.sources.map(source => ({ ...source, kind: "source", label: source.id }));
  const input = { kind: "resume_tailor", workspaceKey: "warehouse-synthetic", idempotencyKey: "warehouse-restart",
    objective: golden.query, consent: true, runtimeBinding, materials,
    job: { id: "warehouse-job", title: "仓储研发", company: "合成公司", description: "关注重复请求去重与回放测试。" },
    resume: { id: "warehouse-resume", name: "合成简历", sourceFingerprint: "warehouse-source-v1",
      fields: [{ id: "headline", targetRef, originalText: original }] },
  };
  const request = (suffix: string, data?: unknown) => fetch(host.origin + "/api/v1/agent/tasks" + suffix, {
    method: data === undefined ? "GET" : "POST", headers, ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  async function result(response: Response): Promise<CareerTask> {
    const value = await response.json();
    assert.ok(response.ok, JSON.stringify(value));
    return CareerTaskSchema.parse(value.task);
  }
  let task = await result(await request("", input));
  const route = "/" + task.id;
  const command = () => ({ expectedRevision: task.revision, sourceFingerprint: input.resume.sourceFingerprint, consent: true, runtimeBinding, runtime });
  const get = async () => result(await request(route));
  async function until(predicate: (state: CareerTask) => boolean) {
    const start = Date.now();
    while (Date.now() - start < 25_000) {
      const state = await get();
      if (predicate(state)) return state;
      assert.equal(state.status, "running", JSON.stringify({status:state.status,error:state.error,events:state.events.slice(-4)}));
      await delay(30);
    }
    throw Error("Timed out waiting for checkpoint");
  }
  const catalog: Array<{tool: string}> = (await (await request(route + "/tools")).json()).tools;
  assert.ok(catalog.some(entry => entry.tool === "read_material"));
  assert.ok(!catalog.some(entry => entry.tool === "read_file"));
  task = await result(await request(route + "/start", command()));
  await until(state => provider.blocked.has("material") && state.usage.toolCalls === 3);
  task = await result(await request(route + "/pause", { expectedRevision: task.revision }));
  assert.equal(task.status, "paused");
  const paused = task;
  const evidence = paused.evidence.find(e => e.sourceId === "material:" + dedup!.sourceId);
  assert.equal(evidence?.excerpt, dedup!.quote);
  assert.ok(paused.events.some(e => e.kind === "tool_result" && e.detail.includes("material_not_granted")));

  await restart();
  task = await get();
  assert.deepEqual(task, paused);
  assert.equal((await request(route + "/resume", { ...command(), consent: false })).status, 400);
  assert.equal((await request(route + "/resume", { ...command(), sourceFingerprint: "stale" })).status, 409);
  assert.equal((await request(route + "/resume", { ...command(), runtime: {
    ...runtime, modelSettings: { ...runtime.modelSettings, model: "unapproved-model" },
  } })).status, 409);
  assert.deepEqual((await get()).usage, paused.usage);
  assert.equal(provider.requests.length, 4);
  const parallel = await Promise.all([request(route + "/resume", command()), request(route + "/resume", command())]);
  assert.deepEqual(parallel.map(r => r.status).sort(), [202, 409]);
  const beforeCrash = await until(state => provider.blocked.has("job") && state.usage.toolCalls === 4);
  assert.equal(beforeCrash.status, "running");
  await restart();
  task = await get();
  assert.equal(task.status, "interrupted");
  assert.equal(task.error, "host_restarted");
  assert.deepEqual(task.evidence, beforeCrash.evidence);
  assert.deepEqual(task.events.slice(0, beforeCrash.events.length), beforeCrash.events);
  assert.equal(task.usage.modelCalls, beforeCrash.usage.modelCalls);
  assert.equal(task.usage.toolCalls, beforeCrash.usage.toolCalls);
  assert.equal(provider.requests.length, 6);

  assert.equal((await request(route + "/resume", command())).status, 202);
  task = await until(state => state.status === "awaiting_review");
  assert.deepEqual(task.draft?.unknowns, [unknown]);
  assert.equal(task.receipt, undefined);
  for (const fact of golden.expectedFacts) {
    const item = task.evidence.find(e => e.sourceId === "material:" + fact.sourceId);
    assert.equal(item?.excerpt, fact.quote);
    assert.ok(task.draft?.patches[0]?.evidenceIds.includes(item!.id));
  }
  const approval = { expectedRevision: task.revision, draftHash: task.draft!.hash,
    approvedPatchIds: [task.draft!.patches[0]!.id], versionId: "synthetic-version", receiptId: "synthetic-confirmation" };
  assert.equal((await request(route + "/receipt", { ...approval, draftHash: "stale" })).status, 409);
  task = await result(await request(route + "/receipt", approval));
  assert.equal(task.status, "completed");
  const completed = task;
  await restart();
  assert.deepEqual(await result(await request(route + "/receipt", approval)), completed);
  const observed = (await get()).events;
  const toolCalls = observed.filter(e => e.kind === "tool_call").map(e => e.detail);
  assert.deepEqual(toolCalls, ["discover_tools", "read_material", "read_material", "read_job", "read_material", "read_resume"]);
  assert.equal(observed.filter(e => e.kind === "receipt").length, 1);
  assert.equal(task.usage.modelCalls, provider.requests.length);
  assert.equal(task.usage.modelCalls, 9);
  assert.equal(new Set(pids).size, 4);
  const journalPath = path.join(directory, "runs", "accounts-v1", "owners", identity.principal.id, "career-tasks-v1", task.id + ".json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  const { succeeded, failed } = observedRuntime(task, [journal], "scripted_fixture");
  assert.deepEqual({ succeeded, failed }, { succeeded: 5, failed: 1 });
  t.diagnostic(JSON.stringify({
    scenario: "warehouse-resume-runtime-restart", goldenCase: golden.id, taskId: task.id, hostPids: pids, model: runtime.modelSettings.model,
    statuses: [paused.status, beforeCrash.status, "interrupted", "awaiting_review", task.status],
    completedToolCalls: observed.filter(e => e.kind === "tool_result").map(e => e.detail),
    persistedEvidence: task.evidence.map(({id,sourceId,hash}) => ({id,sourceId,hash})),
    prePauseModelCalls: paused.usage.modelCalls, preCrashModelCalls: beforeCrash.usage.modelCalls,
    toolOutcomes: { succeeded, failed }, totalModelCalls: task.usage.modelCalls, toolCalls: task.usage.toolCalls, receiptCount: 1, externalModelCalls: 0,
  }));
});
