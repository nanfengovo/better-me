import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { activatePrincipal, IdentityBoundaryError } from "../src/lib/identity";
import { createGrowthJourneyClient } from "../src/services/growth-journey-client";

const ownerA = { id: "11111111-1111-4111-8111-111111111111", username: "growth-a", displayName: "Growth A" };
const ownerB = { id: "22222222-2222-4222-8222-222222222222", username: "growth-b", displayName: "Growth B" };
const input = { mode: "synthetic" as const, goal: { title: "三个月建立 Agent 工程能力", targetWeeks: 12, weeklyHours: 5 },
  idempotencyKey: "synthetic-growth-client-create", consent: true as const };
const journey = { id: "gj_fixture", ownerId: ownerA.id, revision: 1, mode: "synthetic" as const,
  createdAt: "2026-11-13T00:00:00.000Z", updatedAt: "2026-11-13T00:00:00.000Z",
  goal: { id: "gg_fixture", revision: 1 as const, ...input.goal, successCriteria: "完成一项有回执的合成实践，并保留待复测边界。" },
  stage: "choose_source" as const, taskIds: [], events: [{ sequence: 1, kind: "goal_created" as const, at: "2026-11-13T00:00:00.000Z", detail: "合成成长目标已建立。" }] };

afterEach(() => activatePrincipal(undefined));

test("the growth client creates only an owner-bound synthetic journey and validates the returned owner", async () => {
  let calls = 0;
  const client = createGrowthJourneyClient({ baseUrl: "http://growth-client.invalid", fetch: async (request, init) => {
    calls++;
    assert.equal(new URL(String(request)).pathname, "/api/v1/agent/growth/journeys");
    assert.equal(init?.method, "POST");
    assert.equal(init?.credentials, "include");
    assert.equal(new Headers(init?.headers).get("X-BetterMe-Owner"), ownerA.id);
    assert.deepEqual(JSON.parse(String(init?.body)), input);
    return Response.json({ journey });
  } });
  await assert.rejects(client.create(input), /登录|identity/i); assert.equal(calls, 0);
  activatePrincipal(ownerA);
  assert.deepEqual(await client.create(input), journey); assert.equal(calls, 1);

  const foreign = createGrowthJourneyClient({ baseUrl: "http://growth-client.invalid", fetch: async () => Response.json({ journey: { ...journey, ownerId: ownerB.id } }) });
  await assert.rejects(foreign.create(input), IdentityBoundaryError);
});

test("catalog, list, read and one command use the growth routes once and never retry a rejected mutation", async () => {
  activatePrincipal(ownerA);
  const source = { id: "checkpoint-note-v1" as const, version: "checkpoint.v1", title: "合成检查点教材", text: "保存工具结果后只读恢复。",
    hash: "a".repeat(64), locator: "合成教材 · 第 1 节", provenance: "authored_synthetic" as const };
  const summary = { id: journey.id, ownerId: journey.ownerId, revision: journey.revision, goal: journey.goal, stage: journey.stage, updatedAt: journey.updatedAt };
  const selected = { ...journey, revision: 2, updatedAt: "2026-11-13T00:01:00.000Z", stage: "practice" as const, source,
    events: [...journey.events, { sequence: 2, kind: "source_selected" as const, at: "2026-11-13T00:01:00.000Z", detail: "选择合成资料。" }] };
  const wire: { path: string; method: string; body?: unknown }[] = [];
  const responses = [Response.json({ sources: [source] }), Response.json({ journeys: [summary] }), Response.json({ journey }), Response.json({ journey: selected })];
  const client = createGrowthJourneyClient({ baseUrl: "http://growth-client.invalid", fetch: async (request, init) => {
    wire.push({ path: new URL(String(request)).pathname, method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    return responses.shift()!;
  } });
  assert.deepEqual(await client.sources(), [source]);
  assert.deepEqual(await client.list(), [summary]);
  assert.deepEqual(await client.get(journey.id), journey);
  const select = { kind: "select_source" as const, expectedRevision: 1, requestId: "select-source-client", consent: true as const, sourceVersion: source.version };
  assert.deepEqual(await client.command(journey.id, select), selected);
  assert.deepEqual(wire, [
    { path: "/api/v1/agent/growth/sources", method: "GET" },
    { path: "/api/v1/agent/growth/journeys", method: "GET" },
    { path: `/api/v1/agent/growth/journeys/${journey.id}`, method: "GET" },
    { path: `/api/v1/agent/growth/journeys/${journey.id}/commands`, method: "POST", body: select },
  ]);

  let rejected = 0;
  const conflict = createGrowthJourneyClient({ baseUrl: "http://growth-client.invalid", fetch: async () => { rejected++; return Response.json({ error: "growth_revision_conflict" }, { status: 409 }); } });
  await assert.rejects(conflict.command(journey.id, select), /growth_revision_conflict/); assert.equal(rejected, 1);
});

test("an account switch rejects a late successful growth response", async () => {
  activatePrincipal(ownerA); let release!: (value: Response) => void;
  const client = createGrowthJourneyClient({ baseUrl: "http://growth-client.invalid", fetch: async () => new Promise<Response>(resolve => { release = resolve; }) });
  const pending = client.get(journey.id); activatePrincipal(ownerB); release(Response.json({ journey }));
  await assert.rejects(pending, IdentityBoundaryError);
});
