import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import type { UnderstandingSession } from "@better-me/agent-contracts";
import { createAgentServer } from "../src/server.js";
import { ChatGptPlanService } from "../src/chatgpt/service.js";
import { chatGptProviderFixture } from "./fixtures/chatgpt-provider.js";

const summary = { summary: "虚构 RCS 编排搬运任务，不直接控制车辆。", terms: [{ term: "RCS", meaning: "本项目任务编排层", evidenceIds: [] }], boundaries: ["个人贡献另行核实"], claims: [], unknowns: ["尚未说明个人贡献"] };
const reply = (ready: boolean) => JSON.stringify({ kind: "reply", message: ready ? "请确认当前理解。" : "先核对项目边界。", understanding: summary, readyForConfirmation: ready,
  ...(ready ? {} : { question: { id: "scope", text: "此处 RCS 是否只负责编排？", why: "先对齐项目语言。", options: [{ id: "yes", label: "只编排任务" }, { id: "other", label: "我来补充" }], allowMultiple: false } }) });

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-chatgpt-http-"));
  const provider = await chatGptProviderFixture();
  const service = new ChatGptPlanService({ directory: path.join(directory, "oauth"), fetch: provider.fetch });
  const login = await provider.login(service); const profileId = login.state.profiles[0]!.id;
  let fallbackCalls = 0;
  const server = createAgentServer({ port: 0, host: "127.0.0.1", authToken: "fictional-agent-token", allowedOrigins: ["http://fixture.invalid"],
    checkpointer: new MemorySaver() as never, runtimeDefinitions: [], runsDirectory: path.join(directory, "runs"), understandingDirectory: path.join(directory, "understanding"), chatGptService: service,
    understandingReasoner: async () => { fallbackCalls++; throw new Error("Must not fall back to model/key/native path"); },
  });
  await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const request = (route: string, body?: unknown, headers: Record<string, string> = {}) => fetch(`${origin}/api/v1/agent${route}`, {
    method: body === undefined ? "GET" : "POST", headers: { Authorization: "Bearer fictional-agent-token", Origin: "http://fixture.invalid", "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const settled = async (id: string): Promise<UnderstandingSession> => {
    for (let i = 0; i < 200; i++) { const state: UnderstandingSession = await (await request(`/understanding/sessions/${id}`)).json(); if (state.phase !== "running") return state; await new Promise(resolve => setTimeout(resolve, 5)); }
    throw new Error("Fictional account turn did not settle");
  };
  return { directory, provider, service, profileId, request, settled, origin, get fallbackCalls() { return fallbackCalls; },
    close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); } };
}

test("ChatGPT HTTP requires local bearer/origin and explicit consent, exposes no OAuth credentials", async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(`${f.origin}/api/v1/agent/chatgpt/state`)).status, 401);
    assert.equal((await f.request("/chatgpt/state", undefined, { Origin: "http://untrusted.invalid" })).status, 403);
    const state = await f.request("/chatgpt/state"); assert.equal(state.headers.get("cache-control"), "no-store");
    assert.doesNotMatch(JSON.stringify(await state.json()), /FICTIONAL_ACCESS|FICTIONAL_REFRESH|idToken|clientId|subject/);
    const input = { profileId: f.profileId, model: "fixture-gpt", instructions: "Fictional only", input: [{ role: "user", content: "Fictional source" }] };
    assert.equal((await f.request("/chatgpt/response", input)).status, 400);
    assert.equal((await f.request("/chatgpt/response", { ...input, consentToSend: true, apiKey: "DO_NOT_USE" })).status, 400);
    assert.equal(f.provider.calls.filter(call => call.url.endsWith("/responses")).length, 0);
    f.provider.settings.responseText = "Complete fictional answer";
    const response = await f.request("/chatgpt/response", { ...input, consentToSend: true }); assert.equal(response.status, 200);
    assert.equal((await response.json()).text, "Complete fictional answer"); assert.equal(f.fallbackCalls, 0);
  } finally { await f.close(); }
});

test("ChatGPT account drives dynamic understanding, exact consensus confirmation and quota recovery without fallback", async () => {
  const f = await fixture();
  try {
    let session: UnderstandingSession = await (await f.request("/understanding/sessions", { workspaceKey: "fictional", projectKey: "rcs", label: "虚构项目", sourceText: "参与虚构 RCS 项目。" })).json();
    const runtime = { kind: "chatgpt", profileId: f.profileId, model: "fixture-gpt" };
    f.provider.settings.responseText = reply(false);
    assert.equal((await f.request(`/understanding/sessions/${session.id}/turns`, { expectedRevision: session.revision, idempotencyKey: "fictional-first-turn", answer: "先核对项目边界", consentToSend: true, runtime })).status, 202);
    session = await f.settled(session.id); assert.equal(session.phase, "awaiting-answer"); assert.ok(session.question?.options.length);
    f.provider.settings.responseText = reply(true);
    assert.equal((await f.request(`/understanding/sessions/${session.id}/turns`, { expectedRevision: session.revision, idempotencyKey: "fictional-second-turn", answer: "是，只编排任务。", selectedOptionIds: ["yes"], consentToSend: true, runtime })).status, 202);
    session = await f.settled(session.id); assert.equal(session.phase, "awaiting-confirmation");
    assert.equal((await f.request(`/understanding/sessions/${session.id}/confirm`, { expectedRevision: session.revision, summaryHash: "outdated" })).status, 409);
    session = await (await f.request(`/understanding/sessions/${session.id}/confirm`, { expectedRevision: session.revision, summaryHash: session.summaryHash })).json();
    assert.equal(session.phase, "confirmed"); assert.equal(f.fallbackCalls, 0);
    const payloads = f.provider.calls.filter(call => call.url.endsWith("/responses")).map(call => JSON.parse(String(call.init?.body)));
    assert.equal(payloads.length, 2); assert.ok(payloads.every(item => item.model === "fixture-gpt" && item.stream === true && item.store === false));
    f.provider.settings.responseStatus = 429; f.provider.settings.errorCode = "subscription_sharing_usage_limit_exceeded";
    await f.request(`/understanding/sessions/${session.id}/turns`, { expectedRevision: session.revision, idempotencyKey: "fictional-quota-turn", answer: "保留这条补充", consentToSend: true, runtime });
    session = await f.settled(session.id); assert.equal(session.phase, "error"); assert.match(session.error?.code ?? "", /chatgpt_subscription_sharing_usage_limit_exceeded/);
    assert.ok(session.messages.some(item => item.text.includes("保留这条补充")));
    const count = f.provider.calls.filter(call => call.url.endsWith("/responses")).length;
    await f.request(`/understanding/sessions/${session.id}/turns`, { expectedRevision: session.revision, idempotencyKey: "fictional-blocked-turn", answer: "仍不切换", consentToSend: true, runtime });
    await f.settled(session.id); assert.equal(f.provider.calls.filter(call => call.url.endsWith("/responses")).length, count); assert.equal(f.fallbackCalls, 0);
    const files = await readdir(path.join(f.directory, "understanding"));
    for (const name of files.filter(name => name.endsWith(".json"))) assert.doesNotMatch(await readFile(path.join(f.directory, "understanding", name), "utf8"), /FICTIONAL_ACCESS|FICTIONAL_REFRESH|idToken|oaiapp_fixture/);
  } finally { await f.close(); }
});

test("container/remote hosts fail before opening an unreachable loopback authorization", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-chatgpt-unavailable-"));
  let calls = 0;
  const service = new ChatGptPlanService({ directory, authorizationUnavailableReason: "需要本机 Agent Host", fetch: async () => { calls++; throw new Error("No network allowed"); } });
  try { assert.equal((await service.state()).authorizationUnavailableReason, "需要本机 Agent Host"); await assert.rejects(service.startSignIn(), /需要本机/); assert.equal(calls, 0); }
  finally { service.dispose(); await rm(directory, { recursive: true, force: true }); }
});
