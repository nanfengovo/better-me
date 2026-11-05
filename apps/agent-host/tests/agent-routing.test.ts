import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { RuntimeRegistry, BUILTIN_RUNTIME_DEFINITIONS } from "../src/runtime/registry.js";
import { NativeAccountTools, type NativeLease } from "../src/native-tools/service.js";
import { AgentRouting, RoutingError } from "../src/routing/service.js";
import { FixtureNativeProcess } from "./fixtures/native-process.js";
import { defaultAgentRoutingPolicy, type AgentRoutingPolicy } from "@better-me/agent-contracts";

const lease = (session = "a"): NativeLease => ({ session, valid: async () => true });
const signal = () => new AbortController().signal;
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-routing-test-"));
  const registry = new RuntimeRegistry({ definitions: BUILTIN_RUNTIME_DEFINITIONS.map(definition => ({ ...definition, command: process.execPath, fallbackCommands: [] })) });
  await registry.discoverExecutables();
  const runner = new FixtureNativeProcess();
  const native = new NativeAccountTools({ directory: path.join(directory, "native"), registry, runner });
  const routing = new AgentRouting({ directory: path.join(directory, "routing"), native, scan: async () => {} });
  const save = async (overrides: Partial<AgentRoutingPolicy> = {}) => {
    const input = { ...defaultAgentRoutingPolicy, ...overrides }; const { revision, ...policy } = input;
    return routing.update({ ...policy, expectedRevision: revision, consent: true }, lease());
  };
  const api = (id: string) => native.authorizeApi(id, { mode: "api-key", apiKey: "synthetic-only-private-key", model: "synthetic-model", consent: true }, lease());
  return { directory, native, routing, runner, save, api, async close() { await routing.close(); await native.close(); await fs.rm(directory, { recursive: true, force: true }); } };
}
test("routing read is non-mutating and defaults preserve all legacy choices/records", async () => {
  const f = await fixture();
  try { assert.deepEqual((await f.routing.status()).policy, defaultAgentRoutingPolicy); assert.deepEqual(await fs.readdir(f.directory), []); }
  finally { await f.close(); }
});
test("auto skips blocked/unapproved candidates and selects an installed independent tool without Codex", async () => {
  const f = await fixture();
  try {
    await f.api("opencode");
    const policy = await f.save({ mode: "auto", preferred: "codex", backups: ["opencode", "gemini-cli"], allowApiBackups: true });
    const reply = await f.routing.run(randomUUID(), policy.revision, "synthetic consented input", signal(), lease());
    assert.equal(reply.trace.runtimeId, "opencode"); assert.equal(f.runner.executions.length, 1);
    assert.ok(reply.trace.attempts.some(item => item.runtimeId === "codex" && item.status === "skipped" && item.code === "needs_authorization"));
    const receipt = await fs.readFile(path.join(f.directory, "routing", "receipts", `${reply.trace.id}.json`), "utf8");
    assert.ok(!receipt.includes("synthetic consented input")); assert.ok(!receipt.includes(f.runner.text)); assert.ok(!receipt.includes("synthetic-only-private-key"));
  } finally { await f.close(); }
});
test("auto never silently uses API credentials; manual explicitly selected API runtime works", async () => {
  const f = await fixture();
  try {
    await f.api("opencode");
    const auto = await f.save({ mode: "auto", preferred: "opencode", backups: ["codex"] });
    await assert.rejects(f.routing.run(randomUUID(), auto.revision, "synthetic", signal(), lease()), (error: unknown) => error instanceof RoutingError && error.code === "no_approved_runtime" && error.trace!.attempts.some(item => item.code === "api_backup_not_approved"));
    assert.equal(f.runner.executions.length, 0);
    const manual = await f.save({ revision: auto.revision, mode: "manual", preferred: "opencode", backups: [] });
    assert.equal((await f.routing.run(randomUUID(), manual.revision, "synthetic", signal(), lease())).trace.runtimeId, "opencode");
  } finally { await f.close(); }
});
test("native subscription login is preferred inside the approved chain, without Console/API fallback", async () => {
  const f = await fixture();
  try {
    await f.api("opencode"); await f.native.startClaudeLogin(lease());
    await f.native.submitClaudeCode({ code: "synthetic-code#synthetic-state" }, lease());
    for (let count = 0; count < 20 && (await f.native.loginStatus(lease())).state === "pending"; count++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await f.native.loginStatus(lease())).state, "complete");
    const policy = await f.save({ mode: "auto", preferred: "opencode", backups: ["claude-code"], allowApiBackups: true });
    const reply = await f.routing.run(randomUUID(), policy.revision, "synthetic", signal(), lease());
    assert.equal(reply.trace.runtimeId, "claude-code"); assert.equal(f.runner.executions.length, 1);
    const input = f.runner.executions[0]!;
    assert.ok(!input.args.includes("--bare")); assert.ok(!input.environment?.["ANTHROPIC_API_KEY"]);
    assert.deepEqual(input.args.slice(0, 2), ["--print", "--input-format"]);
  } finally { await f.close(); }
});
test("manual unavailable selection stops, and execution/protocol failure is never replayed on backups", async () => {
  const f = await fixture();
  try {
    await f.api("opencode"); await f.api("gemini-cli");
    const fixed = await f.save({ mode: "manual", preferred: "codex", backups: ["opencode"] });
    await assert.rejects(f.routing.run(randomUUID(), fixed.revision, "synthetic", signal(), lease()), /selected_runtime_unavailable/);
    const auto = await f.save({ revision: fixed.revision, mode: "auto", preferred: "opencode", backups: ["gemini-cli"], allowApiBackups: true });
    f.runner.text = "";
    await assert.rejects(f.routing.run(randomUUID(), auto.revision, "synthetic", signal(), lease()), /incomplete_result/);
    assert.equal(f.runner.executions.length, 1);
  } finally { await f.close(); }
});
test("revision CAS, unknown adapter rejection, idempotency and restart receipts prevent unsafe replay", async () => {
  const f = await fixture();
  try {
    await f.api("opencode"); const policy = await f.save({ mode: "manual", preferred: "opencode", backups: [] });
    await assert.rejects(f.save({ mode: "manual", preferred: "codex", backups: [] }), /routing_revision_conflict/);
    await assert.rejects(f.save({ revision: policy.revision, mode: "manual", preferred: "arbitrary-shell", backups: [] }), /unknown_runtime/);
    const id = randomUUID(); const first = await f.routing.run(id, policy.revision, "synthetic", signal(), lease());
    assert.deepEqual(await f.routing.run(id, policy.revision, "synthetic", signal(), lease()), first); assert.equal(f.runner.executions.length, 1);
    await assert.rejects(f.routing.run(id, policy.revision, "other", signal(), lease()), /routing_request_conflict/);
    await assert.rejects(f.routing.run(id, policy.revision, "synthetic", signal(), lease("different-session")), /routing_request_conflict/);
    const restarted = new AgentRouting({ directory: path.join(f.directory, "routing"), native: f.native, scan: async () => {} });
    await assert.rejects(restarted.run(id, policy.revision, "synthetic", signal(), lease()), /routing_result_unknown/); await restarted.close();
  } finally { await f.close(); }
});
test("change selection, revoke authorization, or invalidate identity rejects a deliberately late process", async () => {
  for (const action of ["selection", "authorization", "identity"] as const) {
    const f = await fixture(); let release!: () => void;
    try {
      await f.api("opencode"); const policy = await f.save({ mode: "manual", preferred: "opencode", backups: [] });
      f.runner.gate = new Promise<void>(resolve => { release = resolve; });
      const pending = f.routing.run(randomUUID(), policy.revision, "synthetic", signal(), lease());
      const rejected = assert.rejects(pending);
      for (let count = 0; count < 30 && !f.runner.executions.length; count++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(f.runner.executions.length, 1);
      if (action === "selection") await f.save({ revision: policy.revision, mode: "manual", preferred: "codex", backups: [] });
      else if (action === "authorization") await f.native.disconnect("opencode", lease());
      else { f.routing.invalidateSession("a"); await f.native.invalidateSession("a"); }
      release(); await rejected;
    } finally { release?.(); await f.close(); }
  }
});
test("an idempotent cached reply cannot cross a later authorization or selection boundary", async () => {
  for (const boundary of ["authorization", "selection"] as const) {
    const f = await fixture();
    try {
      await f.api("opencode"); const policy = await f.save({ mode: "manual", preferred: "opencode", backups: [] });
      const id = randomUUID(); await f.routing.run(id, policy.revision, "synthetic", signal(), lease());
      if (boundary === "authorization") await f.native.disconnect("opencode", lease());
      else await f.save({ ...policy, mode: "manual", preferred: "codex", backups: [] });
      await assert.rejects(f.routing.run(id, policy.revision, "synthetic", signal(), lease()), /authorization_changed|routing_revision_conflict/);
      assert.equal(f.runner.executions.length, 1, "revocation does not replay a cached request or switch providers");
    } finally { await f.close(); }
  }
});
