import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { careerRuntimeBinding } from "@better-me/agent-contracts";
import { ChatGptPlanService } from "../src/chatgpt/service.js";
import { createCareerTaskRuntimeResolver } from "../src/tasks/runtime.js";
import { modelOutputIncomplete, modelOutputText, type CareerTaskModelPhase } from "../src/kernel/model-protocol.js";
import type { NativeAccountTools } from "../src/native-tools/service.js";
import type { AgentRouting } from "../src/routing/service.js";
import { chatGptProviderFixture } from "./fixtures/chatgpt-provider.js";

const lease = { session: "synthetic-account-task", valid: async () => true };
async function fixture(t: { after: (fn: () => Promise<void>) => void }, expiresIn = 3600) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-task-chatgpt-"));
  const provider = await chatGptProviderFixture(); provider.settings.expiresIn = expiresIn;
  const account = new ChatGptPlanService({ directory, fetch: provider.fetch });
  const login = await provider.login(account), profileId = login.state.profiles[0]!.id;
  const runtime = { kind: "chatgpt" as const, profileId, model: "fixture-gpt" };
  const sample = { id: "synthetic-account-task", runtimeBinding: careerRuntimeBinding(runtime) };
  const resolve = createCareerTaskRuntimeResolver({ chatGpt: account, nativeTools: {} as NativeAccountTools, routing: {} as AgentRouting, scan: async () => { throw Error("account path must not scan native tools"); } });
  t.after(async () => { resolve.close(); account.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { directory, provider, account, profileId, runtime, sample, resolve };
}

test("explicit ChatGPT account sends one complete phase contract per invocation with no alternate billing or transport", async t => {
  const f = await fixture(t), first = await f.resolve(f.runtime, lease, f.sample, async () => {});
  const second = await f.resolve(f.runtime, lease, { ...f.sample, id: "synthetic-second-task" }, async () => {});
  assert.equal(first.runtimeFingerprint, second.runtimeFingerprint); assert.equal(first.supportsImages, false);
  const prompt = "完整授权原文\r\n🚧".repeat(14000) + "EXACT-INPUT-END";
  const phases: CareerTaskModelPhase[] = ["free_chat", "resume_candidate", "experience_refine", "project_understanding", "jd_match", "mock_interview", "decision", "tool_source"];
  for (const phase of phases) {
    f.provider.settings.responseText = `Full ${phase} response`;
    const output = await first.reasoner(prompt, new AbortController().signal, phase);
    assert.equal(modelOutputText(output), f.provider.settings.responseText); assert.equal(modelOutputIncomplete(output), false);
    const wire = JSON.parse(String(f.provider.calls.filter(call => call.url.endsWith("/responses")).at(-1)!.init?.body));
    assert.equal(wire.model, "fixture-gpt"); assert.equal(wire.input[0].content, prompt);
    assert.match(wire.instructions, /Host output schema:/); assert.equal(wire.store, false); assert.equal(wire.stream, true);
    if (phase === "resume_candidate") { assert.match(wire.instructions, /Host output schema:.*"caseId"/); assert.match(wire.instructions, /not a reply envelope/); }
    assert.equal(wire.max_output_tokens, undefined);
  }
  assert.equal(f.provider.calls.filter(call => call.url.endsWith("/responses")).length, phases.length);
  await assert.rejects(first.reasoner(prompt, new AbortController().signal, "free_chat", [{ messageId: "u1", name: "image.png", mimeType: "image/png", dataUrl: "data:image/png;base64,AAAA" }]), /task_images_not_supported/);
  await assert.rejects(Reflect.apply(first.reasoner, undefined, [prompt, new AbortController().signal, "constructor"]), /invalid_model_phase/);
  assert.equal(f.provider.calls.filter(call => call.url.endsWith("/responses")).length, phases.length);
  assert.ok(f.provider.calls.every(call => !call.url.includes("chat/completions") && !call.url.includes("backend-api")));
});

test("account grant pin survives refresh and host reconstruction but not explicit reauthorization", async t => {
  const f = await fixture(t, 1), first = await f.resolve(f.runtime, lease, f.sample, async () => {});
  f.provider.settings.expiresIn = 3600;
  await first.reasoner("synthetic", new AbortController().signal, "free_chat"); assert.equal(f.provider.refreshCount, 1);
  const afterRefresh = await f.resolve(f.runtime, lease, f.sample, async () => {});
  assert.equal(afterRefresh.runtimeFingerprint, first.runtimeFingerprint);
  const reopened = new ChatGptPlanService({ directory: f.directory, fetch: f.provider.fetch });
  try { assert.equal(await reopened.authorizationFingerprint(f.profileId), await f.account.authorizationFingerprint(f.profileId)); }
  finally { reopened.dispose(); }
  await f.provider.login(f.account, f.profileId);
  await assert.rejects(first.reasoner("never send with replacement grant", new AbortController().signal, "free_chat"), /authorization_changed/);
  const changed = await f.resolve(f.runtime, lease, f.sample, async () => {}); assert.notEqual(changed.runtimeFingerprint, first.runtimeFingerprint);
  assert.equal(f.provider.calls.filter(call => call.url.endsWith("/responses")).length, 1);
  await assert.rejects(f.resolve({ ...f.runtime, model: "different-model" }, lease, f.sample, async () => {}), /runtime_binding_changed/);
});

test("source-bound candidate carries each exact source grammar through the existing account adapter without leaking a previous case", async t => {
  const f = await fixture(t), runtime = await f.resolve(f.runtime, lease, f.sample, async () => {});
  const prompt = " \r\nFull authorized material😀\r\n".repeat(3000) + "EXACT-END  ";
  f.provider.settings.responseText = " \r\nComplete raw candidate output.  ";
  for (const id of ["first-evidence", "second-evidence"]) {
    const text = "Source data only.", sha256 = createHash("sha256").update(text).digest("hex");
    const source = { caseId: `case-${id}`, candidate: { groups: [{ id: "work-1" }], evidence: [{ id, groupId: "work-1", text, sha256 }] } };
    const output = await runtime.reasoner(prompt, new AbortController().signal, "resume_candidate_bound", undefined, source);
    assert.equal(modelOutputText(output), f.provider.settings.responseText);
    const wire = JSON.parse(String(f.provider.calls.filter(call => call.url.endsWith("/responses")).at(-1)!.init?.body));
    assert.equal(wire.input[0].content, prompt);
    const schema = JSON.parse(wire.instructions.split("Host output schema: ")[1]);
    assert.equal(schema.properties.caseId.const, source.caseId); assert.equal(schema.properties.groups, undefined);
    assert.ok(JSON.stringify(schema).includes(id));
    assert.ok(!JSON.stringify(schema).includes(id === "first-evidence" ? "second-evidence" : "first-evidence"));
  }
  await assert.rejects(runtime.reasoner(prompt, new AbortController().signal, "resume_candidate_bound"));
  assert.equal(f.provider.calls.filter(call => call.url.endsWith("/responses")).length, 2);
});

for (const mode of ["incomplete", "interrupted", "stream-limit", "long-complete"] as const) test(`task account preserves full ${mode} output without an internal continuation`, async t => {
  const f = await fixture(t), selected = await f.resolve(f.runtime, lease, f.sample, async () => {});
  const text = "完整输出\r\n🚧".repeat(20000) + "FULL-OUTPUT-END";
  f.provider.settings.responseText = text;
  if (mode === "incomplete") f.provider.settings.incomplete = true;
  if (mode === "interrupted") f.provider.settings.noTerminal = true;
  if (mode === "stream-limit") f.provider.settings.errorCode = "subscription_sharing_usage_limit_exceeded";
  const output = await selected.reasoner("synthetic", new AbortController().signal, "free_chat");
  assert.equal(modelOutputText(output), text); assert.equal(modelOutputIncomplete(output), mode !== "long-complete");
  assert.equal(f.provider.calls.filter(call => call.url.endsWith("/responses")).length, 1);
  const profile = (await f.account.state()).profiles[0]!;
  assert.equal(Boolean(profile.lastCompletedAt), mode === "long-complete");
  if (mode === "stream-limit") assert.equal(profile.issue?.code, "subscription_sharing_usage_limit_exceeded");
});

test("account sign-out aborts an in-flight task dispatch; a stale BetterMe lease never starts another", async t => {
  const f = await fixture(t); let valid = true;
  const selected = await f.resolve(f.runtime, { ...lease, valid: async () => valid }, f.sample, async () => {});
  f.provider.settings.responseDelayMs = 1000;
  const pending = selected.reasoner("synthetic", new AbortController().signal, "free_chat");
  // Attach rejection before sign-out aborts the public task interface.
  const rejected = assert.rejects(pending, /request_cancelled|authorization_required|account_disconnecting/);
  for (let i = 0; i < 150 && !f.provider.calls.some(call => call.url.endsWith("/responses")); i++) await delay(2);
  assert.equal(f.provider.calls.filter(call => call.url.endsWith("/responses")).length, 1);
  await f.account.signOut(f.profileId); await rejected;
  valid = false;
  await assert.rejects(selected.reasoner("late", new AbortController().signal, "free_chat"), /identity_changed/);
  assert.equal(f.provider.calls.filter(call => call.url.endsWith("/responses")).length, 1);
});

test("a superseded refresh failure cannot erase or poison a newly authorized account grant", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-grant-refresh-race-")), provider = await chatGptProviderFixture();
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  provider.settings.expiresIn = 1;
  const account = new ChatGptPlanService({ directory, fetch: async (url, init) => {
    if (String(url).endsWith("/oauth/token") && new URLSearchParams(String(init?.body)).get("grant_type") === "refresh_token") {
      entered.resolve(); await finish.promise;
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    return provider.fetch(url, init);
  } });
  t.after(async () => { finish.resolve(); account.dispose(); await rm(directory, { recursive: true, force: true }); });
  const first = await provider.login(account), id = first.state.profiles[0]!.id, oldPin = await account.authorizationFingerprint(id);
  const pending = account.models(id), rejected = assert.rejects(pending, error => error instanceof Error && "issue" in error && (error.issue as { code: string }).code === "authorization_changed");
  await entered.promise; provider.settings.expiresIn = 3600; await provider.login(account, id);
  const newPin = await account.authorizationFingerprint(id); assert.notEqual(newPin, oldPin);
  finish.resolve(); await rejected;
  const current = (await account.state()).profiles[0]!;
  assert.equal(current.state, "connected"); assert.equal(current.issue, undefined); assert.equal(await account.authorizationFingerprint(id), newPin);
  assert.equal((await account.models(id))[0]?.slug, "fixture-gpt");
});

test("a superseded model catalog failure cannot publish an issue against a replacement account grant", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-grant-catalog-race-")), provider = await chatGptProviderFixture();
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>(); let first = true;
  const account = new ChatGptPlanService({ directory, fetch: async (url, init) => {
    if (String(url).endsWith("/models") && first) { first = false; entered.resolve(); await finish.promise; return Response.json({ detail: "old grant unavailable" }, { status: 503 }); }
    return provider.fetch(url, init);
  } });
  t.after(async () => { finish.resolve(); account.dispose(); await rm(directory, { recursive: true, force: true }); });
  const login = await provider.login(account), id = login.state.profiles[0]!.id;
  const pending = account.models(id), rejected = assert.rejects(pending, error => error instanceof Error && "issue" in error && (error.issue as { code: string }).code === "authorization_changed");
  await entered.promise; await provider.login(account, id); finish.resolve(); await rejected;
  assert.equal((await account.state()).profiles[0]!.issue, undefined);
  assert.equal((await account.models(id))[0]?.slug, "fixture-gpt");
});
