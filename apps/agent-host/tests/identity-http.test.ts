import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MemorySaver } from "@langchain/langgraph";
import { createAgentServer } from "../src/server.js";
import { IdentityService } from "../src/identity/service.js";
import { registerTestIdentity } from "./fixtures/identity.js";
import {seedLegacyCareer} from "./fixtures/legacy-career.js";

test("A/B private records, source grants, provider profiles, task IDs and thread IDs never cross owners", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-identity-http-"));
  const identityDirectory = path.join(directory, "private");
  const legacy = path.join(directory, "legacy"); await mkdir(legacy); await writeFile(path.join(legacy, "old.json"), '{"legacy":"must remain unchanged"}');
  const checkpointer=new MemorySaver();
  const server = createAgentServer({ port: 0, host: "127.0.0.1", authToken: "fixture-transport", allowedOrigins: ["http://fixture.invalid"],
    checkpointer: checkpointer as never, identityDirectory, runtimeDefinitions: [], understandingDirectory: legacy,
  });
  await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const transport = { Authorization: "Bearer fixture-transport", "Content-Type": "application/json", Origin: "http://fixture.invalid" };
  const call = (headers: Record<string, string>, route: string, body?: unknown, method?: string) => fetch(`${base}/api/v1/agent${route}`, {
    method: method ?? (body === undefined ? "GET" : "POST"), headers: { ...transport, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    assert.equal((await call({}, "/understanding/sessions/known-id")).status, 401, "transport token is not a user");
    assert.equal((await call({}, "/identity/session")).status, 200);
    const a = await registerTestIdentity(base, "fixture-transport", "alice", "http://fixture.invalid");
    const b = await registerTestIdentity(base, "fixture-transport", "bob", "http://fixture.invalid");
    assert.notEqual(a.principal.id, b.principal.id);
    assert.equal((await call({ ...b.headers, "X-BetterMe-Owner": a.principal.id }, "/understanding/capabilities")).status, 409);
    assert.equal((await call({ ...a.headers, Origin: "http://evil.invalid" }, "/identity/session")).status, 403);
    const cookie = (await call({}, "/identity/sign-in", { username: "alice", password: "synthetic-only-password-2026" })).headers.getSetCookie()[0]!;
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.doesNotMatch(cookie, /synthetic-only|alice/);

    const input = { workspaceKey: "identical-workspace", projectKey: "identical-rcs", label: "A-private", sourceText: "A-only contribution" };
    const created = await call(a.headers, "/understanding/sessions", input); assert.equal(created.status, 201);
    const session = await created.json();
    assert.equal((await call(b.headers, `/understanding/sessions/${session.id}`)).status, 404);
    for (const [suffix, body, method] of [
      ["/source", { expectedRevision: 0, sourceText: "forged B" }, "POST"],
      ["/confirm", { expectedRevision: 0, summaryHash: "forged" }, "POST"],
      ["/cancel", { expectedTurnCount: 0 }, "POST"],
      ["/grants/known-grant", undefined, "DELETE"],
    ] as const) assert.equal((await call(b.headers, `/understanding/sessions/${session.id}${suffix}`, body, method)).status, 404);
    const bSession = await (await call(b.headers, "/understanding/sessions", { ...input, label: "B-private", sourceText: "B-only contribution" })).json();
    assert.notEqual(session.id, bSession.id);
    assert.equal((await call(b.headers, `/understanding/sessions/${bSession.id}/turns`, {
      expectedRevision: 0, idempotencyKey: "shared-cli-isolation", answer: "do not inherit an OS account's credentials", consentToSend: true,
      runtime: { kind: "native", runtimeId: "shared-cli" },
    })).status, 410, "legacy reasoning cannot bypass the task ledger even with explicit native credentials");
    assert.doesNotMatch(JSON.stringify(await (await call(b.headers, `/understanding/sessions/${bSession.id}`)).json()), /A-only contribution/);
    const source = path.join(directory, "source.ts"); await writeFile(source, "export const dispatch = 'fixture';\n");
    const granted = await (await call(a.headers, `/understanding/sessions/${session.id}/grants`, { path: source })).json();
    assert.equal(granted.grants.length, 1);
    assert.equal((await call(b.headers, `/understanding/sessions/${bSession.id}/grants/${granted.grants[0].id}`, undefined, "DELETE")).status, 404);
    assert.equal((await call(b.headers, `/understanding/sessions/${bSession.id}/grants`, { path: path.join(identityDirectory, "owners", a.principal.id, "understanding") })).status, 400);
    assert.equal((await call(b.headers, "/runs", { runtimeId: "any", prompt: "read private records" })).status, 410, "retired unrestricted CLI cannot bypass the owner task ledger");

    const value = { workspaceKey: "same", revision: 1, messages: ["A-secret"], ownerId: a.principal.id };
    assert.equal((await call(a.headers, "/records/continuity?key=same", { expectedRevision: 0, value })).status, 200);
    assert.equal((await call(b.headers, "/records/continuity?key=same")).status, 200);
    assert.equal((await (await call(b.headers, "/records/continuity?key=same")).json()).value, null);
    assert.equal((await call(a.headers, "/records/continuity?key=same", { expectedRevision: 0, value })).status, 409);
    assert.equal((await call(b.headers, "/records/continuity?key=same", { expectedRevision: 0, value, ownerId: a.principal.id })).status, 400);
    assert.equal((await call(b.headers, "/records/continuity?key=same", { expectedRevision: 0, value })).status, 400, "forged nested owner cannot be stored either");
    assert.equal((await call(a.headers, "/records/growth?key=same", { expectedRevision: 0, value: { workspaceKey: "same", revision: 1, goal: "A-private-growth" } })).status, 200);
    assert.equal((await (await call(b.headers, "/records/growth?key=same")).json()).value, null);
    for (const route of ["/runs/stolen-id", "/runs/stolen-id/events"]) assert.equal((await call(b.headers, route)).status, 404);
    assert.equal((await call(b.headers, "/runs/stolen-id/cancel", {})).status, 404);
    const workflow = { threadId: "same-thread", task: "A-secret-goal", workspaceId: "same" };
    const seeded=await seedLegacyCareer(checkpointer,a.principal.id,workflow.threadId,workflow.task,true),before=JSON.stringify(seeded.tuple);
    assert.equal((await call(a.headers, "/workflows/career/start", workflow)).status, 410);
    const approval = { threadId: "same-thread", approval: { status: "approved", actorScope: a.principal.id, idempotencyKey: "fixture-idempotency" } };
    for(const account of [a,b])assert.equal((await call(account.headers,"/workflows/career/resume",approval)).status,410);
    assert.equal((await call(b.headers,"/workflows/career/state/same-thread")).status,404);
    const historical=await(await call(a.headers,"/workflows/career/state/same-thread")).json();
    assert.equal(historical.state.approval.actorScope,a.principal.id);assert.equal(historical.state.task,workflow.task);assert.equal(historical.readOnly,true);
    assert.equal((await call({...b.headers,"X-BetterMe-Owner":a.principal.id},"/workflows/career/state/same-thread")).status,409);
    assert.equal(JSON.stringify(await checkpointer.getTuple(seeded.config)),before);
    assert.deepEqual((await (await call(b.headers, "/chatgpt/state")).json()).profiles, []);
    assert.equal((await call(b.headers, "/chatgpt/models", { profileId: "a-profile" })).status, 401);
    assert.equal((await call(a.headers, "/identity/sign-out", {})).status, 200);
    assert.equal((await call(a.headers, `/understanding/sessions/${session.id}`)).status, 401, "logout revokes the server session");
    const files = await readdir(identityDirectory); assert.ok(files.includes("identities.json"));
    const auth = await readFile(path.join(identityDirectory, "identities.json"), "utf8");
    assert.doesNotMatch(auth, /synthetic-only-password|betterme_session=/);
    assert.equal(await readFile(path.join(legacy, "old.json"), "utf8"), '{"legacy":"must remain unchanged"}');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});

test("sessions survive service recreation, expire with inactivity, reject spoofed principals and bounded login attempts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-identity-service-"));
  let time = Date.now(); const first = new IdentityService(directory, () => time);
  try {
    const login = await first.signIn({ username: "alice", password: "synthetic-password-2026" }, true, "fixture");
    const cookie = first.cookie(login.token, false);
    const reloaded = new IdentityService(directory, () => time);
    assert.equal((await reloaded.authenticate(cookie))?.id, login.principal.id);
    assert.equal(await reloaded.authenticate("betterme_session=forged"), undefined);
    time += 61 * 60_000;
    assert.equal(await reloaded.authenticate(cookie), undefined);
    await assert.rejects(first.signIn({ username: "alice", password: "synthetic-password-2026", userId: "forged" }, false, "fixture"));
    for (let i = 0; i < 10; i++) await assert.rejects(first.signIn({ username: "alice", password: "synthetic-wrong-password" }, false, "attacker"));
    await assert.rejects(first.signIn({ username: "alice", password: "synthetic-password-2026" }, false, "attacker"), /rate_limited/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
