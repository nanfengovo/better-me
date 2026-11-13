import assert from "node:assert/strict";
import test from "node:test";
import { createUnderstandingClient, UnderstandingClientError } from "../src/services/understanding-client";
import { fixtureSession } from "./fixtures/project-understanding";

test("legacy records retain manual safety controls but cannot execute configured/native reasoning through the old client",async()=>{
  let calls=0;const client=createUnderstandingClient({fetch:async()=>{calls++;return Response.json(fixtureSession());}});
  await client.getSession("understanding_legacy");assert.equal(calls,1);
  await assert.rejects(client.startTurn("understanding_legacy",{expectedRevision:1,idempotencyKey:"same-request-key",answer:"原有草稿",selectedOptionIds:[],runtime:{kind:"native",runtimeId:"codex"},consentToSend:true}),(error:unknown)=>error instanceof UnderstandingClientError&&error.code==="legacy_project_execution_disabled");
  assert.equal(calls,1,"opening old history never replays inference or mutates old authority");
  await assert.rejects(client.createSession({workspaceKey:"workspace",projectKey:"project",label:"项目",sourceText:"完整原文"}),(error:unknown)=>error instanceof UnderstandingClientError&&error.code==="explicit_selected_runtime_required");assert.equal(calls,1);
  await client.revokeGrant("understanding_legacy","grant");await client.cancel("understanding_legacy",1);assert.equal(calls,3,"manual revocation and cancellation stay available during migration");
});
test("ChatGPT also refuses legacy reasoning; unauthenticated task creation cannot borrow an old account session",async()=>{
  let calls=0;const client=createUnderstandingClient({fetch:async()=>{calls++;throw Error("no old HTTP dispatch");}});
  await assert.rejects(client.createSession({workspaceKey:"workspace",projectKey:"project",label:"项目",sourceText:"完整原文",runtimeBinding:{id:"chatgpt:profile:explicit-model",label:"explicit-model",location:"cloud"}}), (error:unknown)=>error instanceof UnderstandingClientError&&error.code==="identity_required");
  const turn={expectedRevision:1,idempotencyKey:"explicit-account-turn",answer:"完整补充",selectedOptionIds:[],runtime:{kind:"chatgpt" as const,profileId:"profile",model:"explicit-model"},consentToSend:true as const};
  await assert.rejects(client.startTurn("understanding_legacy",turn),(error:unknown)=>error instanceof UnderstandingClientError&&error.code==="legacy_project_execution_disabled");assert.equal(calls,0);
});
test("invalid responses fail closed and provider error content is not surfaced", async () => {
  const malformed = createUnderstandingClient({ fetch: async () => Response.json({ id: "incomplete", phase: "confirmed" }) });
  await assert.rejects(malformed.getSession("one"), (error: unknown) => error instanceof UnderstandingClientError && error.code === "invalid_response");
  const conflict = createUnderstandingClient({ fetch: async () => Response.json({ error: "revision_conflict", message: "SYNTHETIC_SECRET_PROVIDER_DETAIL" }, { status: 409 }) });
  await assert.rejects(conflict.getSession("one"), (error: unknown) => {
    assert.ok(error instanceof UnderstandingClientError); assert.equal(error.status, 409); assert.equal(error.code, "revision_conflict");
    assert.doesNotMatch(error.message, /SYNTHETIC_SECRET/); return true;
  });
});
test("capabilities preserve unsupported reasons and transport does not silently fall back", async () => {
  let calls = 0;
  const capability = { id: "fixture-native", name: "合成 Agent", supported: false, available: true, reason: "未验证只读能力" };
  const client = createUnderstandingClient({ fetch: async () => { calls++; return Response.json({ runtimes: [capability] }); } });
  assert.deepEqual(await client.getCapabilities(), [capability]); assert.equal(calls, 1);
  const unavailable = createUnderstandingClient({ fetch: async () => { calls++; throw new TypeError("fetch failed"); } });
  await assert.rejects(unavailable.getSession("one"), (error: unknown) => error instanceof UnderstandingClientError && error.code === "unavailable");
  assert.equal(calls, 2);
});
