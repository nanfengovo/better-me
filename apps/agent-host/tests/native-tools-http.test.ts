import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { MemorySaver } from "@langchain/langgraph";
import type { UnderstandingSession } from "@better-me/agent-contracts";
import { createAgentServer } from "../src/server.js";
import { RuntimeRegistry, BUILTIN_RUNTIME_DEFINITIONS } from "../src/runtime/registry.js";
import { registerTestIdentity } from "./fixtures/identity.js";
import { FixtureNativeProcess } from "./fixtures/native-process.js";

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-native-http-"));
  const runner = new FixtureNativeProcess();
  runner.text = JSON.stringify({ kind: "reply", message: "请核对合成项目理解。", readyForConfirmation: true,
    understanding: { summary: "合成项目只做任务编排。", terms: [], boundaries: ["不推断个人贡献"], claims: [], unknowns: ["个人贡献未确认"] } });
  const legacy = path.join(directory, "legacy.json"); await fs.writeFile(legacy, '{"real-record-sentinel":"untouched"}');
  const server = createAgentServer({ host: "127.0.0.1", port: 0, authToken: "fixture-native-token", allowedOrigins: ["http://fixture.invalid"],
    checkpointer: new MemorySaver() as never, identityDirectory: path.join(directory, "identity"), nativeProcessRunner: runner,
    runtimeDefinitions: BUILTIN_RUNTIME_DEFINITIONS.map(value => ({ ...value, command: process.execPath, fallbackCommands: [] })),
  });
  await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const a = await registerTestIdentity(origin, "fixture-native-token", "native-alice", "http://fixture.invalid");
  const b = await registerTestIdentity(origin, "fixture-native-token", "native-bob", "http://fixture.invalid");
  const call = (headers: Record<string, string>, route: string, body?: unknown, method?: string) => fetch(`${origin}/api/v1/agent${route}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { Authorization: "Bearer fixture-native-token", Origin: "http://fixture.invalid", "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const create = async (headers: Record<string, string>) => (await (await call(headers, "/understanding/sessions", {
    workspaceKey: "same-synthetic", projectKey: "same-project", label: "合成项目", sourceText: "仅用于验收，不是真实简历。",
  })).json()) as UnderstandingSession;
  const turn = (session: UnderstandingSession, runtimeId: string) => ({ expectedRevision: session.revision, idempotencyKey: `synthetic-${session.id}-${session.revision}`, answer: "仅合成资料", consentToSend: true, runtime: { kind: "native", runtimeId } });
  const get = async (headers: Record<string, string>, id: string) => (await (await call(headers, `/understanding/sessions/${id}`)).json()) as UnderstandingSession;
  async function settle(headers: Record<string, string>, id: string) {
    for (let i = 0; i < 200; i++) { const value = await get(headers, id); if (value.phase !== "running") return value; await new Promise(resolve => setTimeout(resolve, 5)); }
    throw new Error("synthetic native HTTP turn did not settle");
  }
  return { directory, legacy, runner, a, b, call, create, get, turn, settle,
    async close() { await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); } };
}

test("real HTTP identities own native authorization independently; no provider secrets or existing records leak", async t => {
  const legacyScan = t.mock.method(RuntimeRegistry.prototype, "scan", async () => { throw new Error("shared credential scanning forbidden"); });
  const f = await fixture();
  try {
    assert.equal((await f.call({}, "/understanding/native/codex/login", { consent: true })).status, 401);
    assert.equal((await f.call(f.a.headers, "/runtimes")).status, 200);
    assert.equal((await f.call(f.a.headers, "/runtimes/scan", {})).status, 200);
    assert.equal(legacyScan.mock.callCount(), 0);
    const aSession = await f.create(f.a.headers), bSession = await f.create(f.b.headers);
    assert.equal((await f.call(f.a.headers, `/understanding/sessions/${aSession.id}/turns`, f.turn(aSession, "codex"))).status, 403);
    assert.deepEqual(await f.get(f.a.headers, aSession.id), aSession, "denied native requests do not alter history");
    for (const runtimeId of ["codex", "claude-code", "gemini-cli", "opencode"]) {
      const route = `/understanding/native/${runtimeId}/authorization`;
      const input = { mode: "api-key", apiKey: `synthetic-${runtimeId}-a`, model: "synthetic-model", consent: true };
      assert.equal((await f.call(f.a.headers, route, { ...input, ownerId: f.b.principal.id })).status, 400);
      assert.equal((await f.call(f.a.headers, route, input)).status, 200);
      const other = await (await f.call(f.b.headers, "/understanding/capabilities")).json();
      assert.equal(other.runtimes.find((value: { id: string }) => value.id === runtimeId).code, "needs_authorization");
      assert.doesNotMatch(JSON.stringify(other), /synthetic-.*-a/);
      assert.equal((await f.call(f.b.headers, `/understanding/sessions/${bSession.id}/turns`, f.turn(bSession, runtimeId))).status, 403);
      const session = await f.create(f.a.headers);
      assert.equal((await f.call(f.a.headers, `/understanding/sessions/${session.id}/turns`, f.turn(session, runtimeId))).status, 202);
      const final = await f.settle(f.a.headers, session.id); assert.equal(final.phase, "awaiting-confirmation");
      assert.doesNotMatch(JSON.stringify(final), /synthetic-.*-a|apiKey|CODEX_HOME/);
      assert.equal((await f.call(f.a.headers, route, undefined, "DELETE")).status, 200);
    }
    assert.equal((await f.call(f.a.headers, "/runs", { runtimeId: "codex", prompt: "arbitrary task" })).status, 403);
    assert.equal(await fs.readFile(f.legacy, "utf8"), '{"real-record-sentinel":"untouched"}');
  } finally { await f.close(); }
});

test("HTTP revocation and logout stop native turns before ignored late output can update owner history", async () => {
  const f = await fixture(); let release!: () => void;
  try {
    for (const action of ["revoke", "logout"] as const) {
      const identity = action === "revoke" ? f.a : f.b;
      assert.equal((await f.call(identity.headers, "/understanding/native/opencode/authorization", { mode: "api-key", apiKey: "synthetic-native-key", model: "synthetic-model", consent: true })).status, 200);
      const session = await f.create(identity.headers), before = f.runner.executions.length;
      f.runner.gate = new Promise<void>(resolve => { release = resolve; });
      assert.equal((await f.call(identity.headers, `/understanding/sessions/${session.id}/turns`, f.turn(session, "opencode"))).status, 202);
      assert.equal((await f.call(identity.headers, `/understanding/sessions/${session.id}/turns`, f.turn(session, "opencode"))).status, 202, "delivery retry keeps the original revocation watcher");
      for (let i = 0; i < 100 && f.runner.executions.length === before; i++) await new Promise(resolve => setTimeout(resolve, 2));
      const response = action === "revoke" ? await f.call(identity.headers, "/understanding/native/opencode/authorization", undefined, "DELETE") : await f.call(identity.headers, "/identity/sign-out", {});
      assert.equal(response.status, 200); release();
      if (action === "revoke") { const final = await f.settle(identity.headers, session.id); assert.equal(final.phase, "cancelled"); assert.ok(!final.messages.some(message => message.text.includes("请核对合成"))); }
      else assert.equal((await f.call(identity.headers, `/understanding/sessions/${session.id}`)).status, 401);
    }
  } finally { release?.(); await f.close(); }
});

test("concurrent device login requests start one process and disclose the device code only to its initiating session", async () => {
  const f = await fixture(); let release!: () => void;
  try {
    f.runner.deviceGate = new Promise<void>(resolve => { release = resolve; });
    const [one, two] = await Promise.all([f.call(f.a.headers, "/understanding/native/codex/login", { consent: true }), f.call(f.a.headers, "/understanding/native/codex/login", { consent: true })]);
    assert.equal(one.status, 202); assert.equal(two.status, 202); assert.equal(f.runner.deviceStarts, 1);
    assert.equal((await (await f.call(f.a.headers, "/understanding/native/codex/login")).json()).userCode, "ABCD-EFGH");
    assert.equal((await (await f.call(f.b.headers, "/understanding/native/codex/login")).json()).userCode, undefined);
    const signingOut = f.call(f.a.headers, "/identity/sign-out", {}); release(); assert.equal((await signingOut).status, 200);
    assert.equal(f.runner.executions.length, 0, "login does not send evidence or invoke a model");
  } finally { release?.(); await f.close(); }
});

test("unified routing HTTP isolates account policy and traces, backs up before dispatch, and feeds the existing evidence loop", async () => {
  const f = await fixture();
  try {
    const before = await f.create(f.a.headers);
    assert.equal((await f.call({}, "/routing")).status, 401);
    const update = { expectedRevision: 0, mode: "auto", preferred: "codex", backups: ["opencode", "claude-code"], allowApiBackups: true, consent: true };
    assert.equal((await f.call(f.a.headers, "/routing", { ...update, ownerId: f.b.principal.id }, "PUT")).status, 400);
    assert.equal((await f.call(f.a.headers, "/routing", update, "PUT")).status, 200);
    assert.equal((await (await f.call(f.b.headers, "/routing")).json()).policy.mode, "legacy");
    assert.deepEqual(await f.get(f.a.headers, before.id), before, "changing a base does not rewrite existing project sessions");
    await f.call(f.a.headers, "/understanding/native/opencode/authorization", { mode: "api-key", apiKey: "synthetic-routing-only-key", model: "synthetic-model", consent: true });
    const input = { id: randomUUID(), expectedRevision: 1, consentToSend: true, instructions: "Synthetic text task only", messages: [{ role: "user", content: "synthetic routing task" }] };
    const result = await f.call(f.a.headers, "/routing/respond", input); assert.equal(result.status, 200);
    const reply = await result.json(); assert.equal(reply.trace.runtimeId, "opencode"); assert.ok(reply.trace.attempts.some((attempt: { runtimeId: string; status: string }) => attempt.runtimeId === "codex" && attempt.status === "skipped"));
    assert.equal((await f.call(f.b.headers, "/routing/respond", input)).status, 409);
    const other = await (await f.call(f.b.headers, "/routing")).json(); assert.equal(other.trace, undefined);
    assert.equal((await f.call(f.a.headers, `/understanding/sessions/${before.id}/turns`, { ...f.turn(before, "opencode"), runtime: { kind: "unified", expectedRevision: 1 } })).status, 202);
    assert.equal((await f.settle(f.a.headers, before.id)).phase, "awaiting-confirmation");
    assert.equal(await fs.readFile(f.legacy, "utf8"), '{"real-record-sentinel":"untouched"}');
    const status = JSON.stringify(await (await f.call(f.a.headers, "/routing")).json());
    assert.doesNotMatch(status, /synthetic-routing-only-key|synthetic routing task|请核对合成项目/);
  } finally { await f.close(); }
});

test("Claude native authorization HTTP binds the official code and credential to the initiating BetterMe session", async () => {
  const f = await fixture();
  try {
    const route = "/understanding/native/claude-code";
    assert.equal((await f.call(f.a.headers, `${route}/login`, { consent: true })).status, 202);
    const login = await (await f.call(f.a.headers, `${route}/login`)).json();
    assert.match(login.verificationUrl, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
    assert.equal((await (await f.call(f.b.headers, `${route}/login`)).json()).verificationUrl, undefined);
    assert.equal((await f.call(f.b.headers, `${route}/login-code`, { code: "synthetic-code#synthetic-state" })).status, 409);
    assert.equal((await f.call(f.a.headers, `${route}/login-code`, { code: "synthetic-code#another-state" })).status, 409);
    assert.equal((await f.call(f.a.headers, `${route}/login-code`, { code: "synthetic-code#synthetic-state" })).status, 202);
    for (let count = 0; count < 20 && (await (await f.call(f.a.headers, `${route}/login`)).json()).state === "pending"; count++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await (await f.call(f.a.headers, `${route}/login`)).json()).state, "complete");
    const caps = await (await f.call(f.a.headers, "/understanding/capabilities")).json();
    assert.equal(caps.runtimes.find((item: { id: string }) => item.id === "claude-code").authorizationMode, "native");
    assert.equal(f.runner.executions.length, 0, "native login must not call a model");
  } finally { await f.close(); }
});

test("unified broker turn retains its cancellation fence across idempotent retries and rejects late output after revocation or selection change", async () => {
  const f = await fixture(); let release!: () => void;
  try {
    for (const action of ["selection", "revoke"] as const) {
      const previous = (await (await f.call(f.a.headers, "/routing")).json()).policy;
      const policy = await (await f.call(f.a.headers, "/routing", { expectedRevision: previous.revision, mode: "auto", preferred: "opencode", backups: ["gemini-cli"], allowApiBackups: true, consent: true }, "PUT")).json();
      await f.call(f.a.headers, "/understanding/native/opencode/authorization", { mode: "api-key", apiKey: "synthetic-cancellable-key", model: "synthetic-model", consent: true });
      const before = await f.create(f.a.headers), count = f.runner.executions.length;
      f.runner.gate = new Promise<void>(resolve => { release = resolve; });
      const input = { ...f.turn(before, "opencode"), runtime: { kind: "unified", expectedRevision: policy.policy.revision } };
      const endpoint = `/understanding/sessions/${before.id}/turns`;
      assert.equal((await f.call(f.a.headers, endpoint, input)).status, 202);
      assert.equal((await f.call(f.a.headers, endpoint, input)).status, 202);
      for (let countWait = 0; countWait < 100 && f.runner.executions.length === count; countWait++) await new Promise(resolve => setTimeout(resolve, 2));
      assert.equal(f.runner.executions.length, count + 1);
      const stopped = action === "revoke" ? await f.call(f.a.headers, "/understanding/native/opencode/authorization", undefined, "DELETE")
        : await f.call(f.a.headers, "/routing", { expectedRevision: policy.policy.revision, mode: "manual", preferred: "codex", backups: [], allowApiBackups: false, consent: true }, "PUT");
      assert.equal(stopped.status, 200); release();
      const final = await f.settle(f.a.headers, before.id); assert.equal(final.phase, "cancelled");
      assert.ok(!final.messages.some(message => message.text.includes("请核对合成项目")));
    }
  } finally { release?.(); await f.close(); }
});
