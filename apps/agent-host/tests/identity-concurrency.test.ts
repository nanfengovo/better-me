import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { once } from "node:events";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import type { UnderstandingSession } from "@better-me/agent-contracts";
import { createAgentServer, type ServerOptions } from "../src/server.js";
import { registerTestIdentity } from "./fixtures/identity.js";

async function fixture(t: TestContext, reasoner?: ServerOptions["understandingReasoner"]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-owner-concurrency-"));
  const sentinel = path.join(directory, "unowned-legacy.json");
  await writeFile(sentinel, '{"legacy":"synthetic existing record must remain unchanged"}');
  const server = createAgentServer({ port: 0, host: "127.0.0.1", authToken: "isolated-concurrency-token",
    allowedOrigins: ["http://fixture.invalid"], runtimeDefinitions: [], checkpointer: new MemorySaver() as never,
    identityDirectory: path.join(directory, "accounts"), runsDirectory: path.join(directory, "runs"),
    understandingDirectory: path.join(directory, "unowned-understanding"), understandingReasoner: reasoner,
  });
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const [alice, bob] = await Promise.all(["alice", "bob"].map(name => registerTestIdentity(base, "isolated-concurrency-token", name, "http://fixture.invalid")));
  assert.ok(alice && bob);
  const call = (headers: Record<string, string>, route: string, body?: unknown) => fetch(`${base}/api/v1/agent${route}`, {
    method: body === undefined ? "GET" : "POST", headers: { Authorization: "Bearer isolated-concurrency-token", Origin: "http://fixture.invalid", "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { alice, bob, call, sentinel };
}

test("parallel same-key writes and same-thread workflows remain owner-scoped with exactly one CAS winner per account", async t => {
  const { alice, bob, call, sentinel } = await fixture(t);
  const batches = await Promise.all([alice, bob].map(async account => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => call(account.headers, "/records/continuity?key=same", {
      expectedRevision: 0, value: { ownerId: account.principal.id, workspaceKey: "same", revision: 1, marker: `${account.principal.username}-only-${index}` },
    })));
    assert.equal(results.filter(response => response.status === 200).length, 1);
    assert.equal(results.filter(response => response.status === 409).length, 7);
    const saved = await (await call(account.headers, "/records/continuity?key=same")).json();
    assert.equal(saved.ownerId, account.principal.id);
    assert.equal(saved.revision, 1);
    assert.match(saved.value.marker, new RegExp(`^${account.principal.username}-only-`));
    return saved;
  }));
  assert.notEqual(batches[0].value.marker, batches[1].value.marker);
  const workflows = await Promise.all([alice, bob].map(async account => {
    const response = await call(account.headers, "/workflows/career/start", {
      threadId: "identical-thread", workspaceId: "same", task: `${account.principal.username}-private-career-target`,
    });
    assert.equal(response.status, 200);
    return response.json();
  }));
  assert.match(JSON.stringify(workflows[0]), /alice-private-career-target/);
  assert.match(JSON.stringify(workflows[1]), /bob-private-career-target/);
  assert.doesNotMatch(JSON.stringify(workflows[0]), /bob-private-career-target/);
  assert.doesNotMatch(JSON.stringify(workflows[1]), /alice-private-career-target/);
  for (const account of [alice, bob]) {
    assert.equal((await call(account.headers, "/records/growth?key=same", { expectedRevision: 0,
      value: { workspaceKey: "same", revision: 1, goal: `${account.principal.username}-private-growth` } })).status, 200);
    const growth = await (await call(account.headers, "/records/growth?key=same")).json();
    assert.equal(growth.value.goal, `${account.principal.username}-private-growth`);
    assert.equal((await (await call(account.headers, "/records/continuity?key=same")).json()).value.marker,
      batches.find(record => record.ownerId === account.principal.id).value.marker, "growth must not overwrite continuity");
  }
  assert.equal(await readFile(sentinel, "utf8"), '{"legacy":"synthetic existing record must remain unchanged"}');
});

test("concurrent project tasks finish out of order across logout without crossing prompts, history or saved consensus", async t => {
  const startedA = Promise.withResolvers<void>(), startedB = Promise.withResolvers<void>();
  const resultA = Promise.withResolvers<string>(), resultB = Promise.withResolvers<string>();
  const prompts: { alice: string[]; bob: string[] } = { alice: [], bob: [] };
  const { alice, bob, call, sentinel } = await fixture(t, async () => async prompt => {
    const isAlice = prompt.includes("ALICE-ONLY-SOURCE");
    prompts[isAlice ? "alice" : "bob"]!.push(prompt);
    (isAlice ? startedA : startedB).resolve();
    return (isAlice ? resultA : resultB).promise;
  });
  t.after(() => { resultA.resolve(reply("ALICE-ONLY")); resultB.resolve(reply("BOB-ONLY")); });
  const sessions = await Promise.all([alice, bob].map(async account => {
    const marker = account === alice ? "ALICE-ONLY-SOURCE" : "BOB-ONLY-SOURCE";
    const response = await call(account.headers, "/understanding/sessions", {
      workspaceKey: "same", projectKey: "same-project", label: marker, sourceText: `${marker}: synthetic project evidence only`,
    });
    assert.equal(response.status, 201);
    return await response.json() as UnderstandingSession;
  }));
  const sessionA = sessions[0]!, sessionB = sessions[1]!;
  const launches = await Promise.all([{ account: alice, session: sessionA }, { account: bob, session: sessionB }].map(async ({ account, session }) => {
    return call(account.headers, `/understanding/sessions/${session.id}/turns`, { expectedRevision: session.revision,
      idempotencyKey: "identical-turn-key", answer: "Use only my synthetic project evidence", consentToSend: true,
      runtime: { kind: "model", modelSettings: { provider: "ollama", model: "deterministic-no-network" } },
    });
  }));
  assert.ok(launches.every(response => response.status === 202));
  await Promise.all([startedA.promise, startedB.promise]);
  assert.ok(prompts.alice.length && prompts.bob.length);
  assert.ok(prompts.alice.every(prompt => !prompt.includes("BOB-ONLY")));
  assert.ok(prompts.bob.every(prompt => !prompt.includes("ALICE-ONLY")));
  resultB.resolve(reply("BOB-ONLY"));
  const finishedB = await settled(call, bob.headers, sessionB.id);
  assert.equal(finishedB.understanding?.summary, "BOB-ONLY synthetic project summary; not a personal contribution claim.");
  assert.equal((await call(alice.headers, "/identity/sign-out", {})).status, 200);
  assert.equal((await call(alice.headers, `/understanding/sessions/${sessionA.id}`)).status, 401);
  resultA.resolve(reply("ALICE-ONLY"));
  assert.equal((await call(bob.headers, `/understanding/sessions/${sessionA.id}`)).status, 404);
  const login = await call({}, "/identity/sign-in", { username: "alice", password: "synthetic-only-password-2026" });
  assert.equal(login.status, 200);
  const headersA = { Cookie: login.headers.getSetCookie()[0]!.split(";")[0]!, "X-BetterMe-Owner": alice.principal.id };
  const finishedA = await settled(call, headersA, sessionA.id);
  assert.equal(finishedA.understanding?.summary, "ALICE-ONLY synthetic project summary; not a personal contribution claim.");
  assert.doesNotMatch(JSON.stringify(finishedA), /BOB-ONLY/);
  assert.deepEqual(await (await call(bob.headers, `/understanding/sessions/${sessionB.id}`)).json(), finishedB,
    "Alice's late completion must leave Bob's entire saved session unchanged");
  const confirmed = await call(headersA, `/understanding/sessions/${sessionA.id}/confirm`, { expectedRevision: finishedA.revision, summaryHash: finishedA.summaryHash });
  assert.equal(confirmed.status, 200);
  assert.equal((await confirmed.json()).phase, "confirmed");
  assert.equal((await call(bob.headers, `/understanding/sessions/${sessionA.id}/confirm`, { expectedRevision: finishedA.revision, summaryHash: finishedA.summaryHash })).status, 404);
  assert.equal(await readFile(sentinel, "utf8"), '{"legacy":"synthetic existing record must remain unchanged"}');
});

function reply(marker: string) {
  return JSON.stringify({ kind: "reply", message: `${marker} synthetic reply`, readyForConfirmation: true,
    understanding: { summary: `${marker} synthetic project summary; not a personal contribution claim.`, terms: [], claims: [], boundaries: ["Synthetic fixture only"], unknowns: ["Personal contribution is unconfirmed"] } });
}
async function settled(call: (headers: Record<string, string>, route: string) => Promise<Response>, headers: Record<string, string>, id: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await call(headers, `/understanding/sessions/${id}`);
    assert.equal(response.status, 200);
    const session = await response.json() as UnderstandingSession;
    if (session.phase !== "running") return session;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Synthetic understanding task did not settle");
}
