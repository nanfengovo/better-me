import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { once } from "node:events";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import type { UnderstandingRuntime } from "../src/understanding/http.js";
import { createAgentServer, type ServerOptions } from "../src/server.js";
import { registerTestIdentity } from "./fixtures/identity.js";
import {projectTaskHttp} from "./fixtures/project-task-http.js";
import {seedLegacyCareer} from "./fixtures/legacy-career.js";

async function fixture(t: TestContext, reasoner?: ServerOptions["careerTaskReasoner"]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-owner-concurrency-"));
  const sentinel = path.join(directory, "unowned-legacy.json");
  await writeFile(sentinel, '{"legacy":"synthetic existing record must remain unchanged"}');
  const checkpointer=new MemorySaver();
  const server = createAgentServer({ port: 0, host: "127.0.0.1", authToken: "isolated-concurrency-token",
    allowedOrigins: ["http://fixture.invalid"], runtimeDefinitions: [], checkpointer: checkpointer as never,
    identityDirectory: path.join(directory, "accounts"), runsDirectory: path.join(directory, "runs"),
    understandingDirectory: path.join(directory, "unowned-understanding"), careerTaskReasoner: reasoner,
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
  return { alice, bob, call, sentinel,checkpointer };
}

test("parallel same-key writes and read-only same-thread workflow history remain owner-scoped with exactly one CAS winner per account", async t => {
  const { alice, bob, call, sentinel,checkpointer } = await fixture(t);
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
    await seedLegacyCareer(checkpointer,account.principal.id,"identical-thread",`${account.principal.username}-private-career-target`,true);
    const response = await call(account.headers, "/workflows/career/start", {
      threadId: "identical-thread", workspaceId: "same", task: `${account.principal.username}-private-career-target`,
    });
    assert.equal(response.status, 410);
    const historical=await call(account.headers,"/workflows/career/state/identical-thread");assert.equal(historical.status,200);
    const record=await historical.json();assert.equal(record.state.approval.actorScope,account.principal.id);assert.equal(record.readOnly,true);return record;
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
  const tasks=(headers:Record<string,string>)=>projectTaskHttp((route,body)=>call(headers,route,body));
  const runtime:UnderstandingRuntime={kind:"model",modelSettings:{provider:"ollama",model:"deterministic-no-network",baseUrl:"http://127.0.0.1:1/v1"}};
  const sessions = await Promise.all([alice, bob].map(async account => {
    const marker = account === alice ? "ALICE-ONLY-SOURCE" : "BOB-ONLY-SOURCE";
    return tasks(account.headers).create({
      workspaceKey: "same", projectKey: "same-project", label: marker, sourceText: `${marker}: synthetic project evidence only`,
    },runtime);
  }));
  const sessionA = sessions[0]!, sessionB = sessions[1]!;
  const launches = await Promise.all([{ account: alice, session: sessionA }, { account: bob, session: sessionB }].map(async ({ account, session }) => {
    return tasks(account.headers).start(session.id,{ expectedRevision: session.revision,
      idempotencyKey: "identical-turn-key", answer: "Use only my synthetic project evidence", consentToSend: true,
      runtime,
    });
  }));
  for(const response of launches)assert.equal(response.status,202,await response.clone().text());
  await Promise.all([startedA.promise, startedB.promise]);
  assert.ok(prompts.alice.length && prompts.bob.length);
  assert.ok(prompts.alice.every(prompt => !prompt.includes("BOB-ONLY")));
  assert.ok(prompts.bob.every(prompt => !prompt.includes("ALICE-ONLY")));
  resultB.resolve(reply("BOB-ONLY"));
  const finishedB = await tasks(bob.headers).settled(sessionB.id);
  assert.equal(finishedB.understanding?.summary, "BOB-ONLY synthetic project summary; not a personal contribution claim.");
  assert.equal((await call(alice.headers, "/identity/sign-out", {})).status, 200);
  assert.equal((await call(alice.headers, `/tasks/${sessionA.id}`)).status, 401);
  resultA.resolve(reply("ALICE-ONLY"));
  assert.equal((await call(bob.headers, `/tasks/${sessionA.id}`)).status, 404);
  const login = await call({}, "/identity/sign-in", { username: "alice", password: "synthetic-only-password-2026" });
  assert.equal(login.status, 200);
  const headersA = { Cookie: login.headers.getSetCookie()[0]!.split(";")[0]!, "X-BetterMe-Owner": alice.principal.id };
  let finishedA = await tasks(headersA).settled(sessionA.id);
  assert.equal(finishedA.understanding,undefined,"logout fences ignored late output; logging in does not restore the old grant");
  assert.equal(finishedA.phase,"cancelled");
  assert.doesNotMatch(JSON.stringify(finishedA), /BOB-ONLY/);
  assert.deepEqual(await (await tasks(bob.headers).get(sessionB.id)).json(), finishedB,
    "Alice's late completion must leave Bob's entire saved session unchanged");
  assert.equal((await tasks(headersA).start(sessionA.id,{expectedRevision:finishedA.revision,idempotencyKey:"explicit-new-login-resume",answer:"I explicitly authorize this same synthetic task again",consentToSend:true,runtime})).status,202);
  finishedA=await tasks(headersA).settled(sessionA.id);
  assert.equal(finishedA.understanding?.summary,"ALICE-ONLY synthetic project summary; not a personal contribution claim.");
  const confirmed = await tasks(headersA).mutate(sessionA.id,"confirm",{ expectedRevision: finishedA.revision, summaryHash: finishedA.summaryHash });
  assert.equal(confirmed.status, 200);
  assert.equal((await confirmed.json()).phase, "confirmed");
  assert.equal((await call(bob.headers, `/tasks/${sessionA.id}/project/confirm`, { expectedRevision: finishedA.revision, summaryHash: finishedA.summaryHash })).status, 404);
  assert.equal(await readFile(sentinel, "utf8"), '{"legacy":"synthetic existing record must remain unchanged"}');
});

function reply(marker: string) {
  return JSON.stringify({ kind: "reply", message: `${marker} synthetic reply`, readyForConfirmation: true,
    understanding: { summary: `${marker} synthetic project summary; not a personal contribution claim.`, terms: [], claims: [], boundaries: ["Synthetic fixture only"], unknowns: ["Personal contribution is unconfirmed"] } });
}
