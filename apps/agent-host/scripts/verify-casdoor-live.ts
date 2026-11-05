// Isolated protocol acceptance against the actual loopback Casdoor, never the user's data/identity directory.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { MemorySaver } from "@langchain/langgraph";
import { createAgentServer } from "../src/server.js";
import { loadOidcOptions } from "../src/identity/oidc.js";

const configured = await loadOidcOptions(process.env["BETTERME_OIDC_CONFIG"] ?? path.join(os.homedir(), "Library/Application Support/BetterMe/agent/oidc.json"));
assert.ok(configured && new URL(configured.issuer).hostname === "127.0.0.1", "This opt-in test creates synthetic accounts on a loopback Casdoor only.");
const config = configured;
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-real-casdoor-test-"));
const users = ["alice", "bob"].map(name => ({ name: `isolation-${name}-${randomBytes(5).toString("hex")}`, password: randomBytes(24).toString("base64url") }));
const frontend = new URL(config.callbackUrl).origin;
const starts = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>(), results = new Map<string, ReturnType<typeof Promise.withResolvers<string>>>();
for (const marker of ["ALICE-ONLY", "BOB-ONLY"]) { starts.set(marker, Promise.withResolvers<void>()); results.set(marker, Promise.withResolvers<string>()); }
const server = createAgentServer({ port: 0, host: "127.0.0.1", authToken: "synthetic-fixture", allowedOrigins: [frontend],
  identityDirectory: path.join(directory, "identity"), runtimeDefinitions: [], checkpointer: new MemorySaver() as never, oidc: config,
  understandingReasoner: async () => async prompt => {
    const marker = prompt.includes("ALICE-ONLY") ? "ALICE-ONLY" : "BOB-ONLY";
    assert.equal(prompt.includes(marker === "ALICE-ONLY" ? "BOB-ONLY" : "ALICE-ONLY"), false);
    starts.get(marker)!.resolve(); return results.get(marker)!.promise;
  } });
await once(server, "listening"); const a = server.address(); assert.ok(a && typeof a !== "string"); const host = `http://127.0.0.1:${a.port}`;
const request = async (route: string, body?: unknown, headers = {}) => fetch(host + "/api/v1/agent" + route, { method: body ? "POST" : "GET", headers: { Authorization: "Bearer synthetic-fixture", Origin: frontend, "Content-Type": "application/json", ...headers }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: "manual" });
async function login(user: typeof users[number]) {
  const started = await request("/identity/oidc/start", { intent: "login" }); assert.equal(started.status, 200);
  const flowCookie = started.headers.getSetCookie()[0]!.split(";")[0]!, auth = new URL((await started.json()).url);
  const query = new URLSearchParams();
  for (const [to, from] of Object.entries({ clientId: "client_id", responseType: "response_type", redirectUri: "redirect_uri", scope: "scope", state: "state", nonce: "nonce", code_challenge: "code_challenge", code_challenge_method: "code_challenge_method" })) query.set(to, auth.searchParams.get(from)!);
  const response = await fetch(config.issuer + "/api/login?" + query, { method: "POST", headers: { "Content-Type": "application/json", Origin: config.issuer },
    body: JSON.stringify({ type: "code", signinMethod: "Password", application: "app-betterme", organization: "betterme", username: user.name, password: user.password, autoSignin: false }) });
  const payload = await response.json();
  if (payload.status !== "ok" || typeof payload.data !== "string") throw new Error(`Casdoor synthetic code rejected: ${payload.msg}`);
  const result = await fetch(host + "/api/v1/agent/identity/oidc/callback?" + new URLSearchParams({ code: payload.data, state: auth.searchParams.get("state")!, iss: config.issuer }), { headers: { Cookie: flowCookie }, redirect: "manual" });
  assert.equal(result.status, 303, await result.clone().text());
  const cookie = result.headers.getSetCookie().find(value => value.startsWith("betterme_session="))!.split(";")[0]!;
  const principal = (await (await request("/identity/session", undefined, { Cookie: cookie })).json()).principal;
  return { Cookie: cookie, "X-BetterMe-Owner": principal.id, id: principal.id };
}
const reply = (marker: string) => JSON.stringify({ kind: "reply", message: marker + " synthetic reply", readyForConfirmation: true,
  understanding: { summary: marker + " synthetic summary", terms: [], claims: [], boundaries: ["synthetic"], unknowns: [] } });
async function settled(headers: Record<string, string>, session: string) {
  for (let index = 0; index < 100; index++) {
    const response = await request(`/understanding/sessions/${session}`, undefined, headers); assert.equal(response.status, 200);
    const value = await response.json(); if (value.phase !== "running") return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Synthetic task did not settle");
}
try {
  for (const user of users) {
    const response = await fetch(config.issuer + "/api/signup", { method: "POST", headers: { "Content-Type": "application/json", Origin: config.issuer },
      body: JSON.stringify({ application: "app-betterme", organization: "betterme", username: user.name, name: "Synthetic isolation fixture", password: user.password }) });
    const result = await response.json();
    if (result.status !== "ok") throw new Error(`Casdoor synthetic registration rejected: ${result.msg}`);
  }
  const [alice, bob] = await Promise.all(users.map(login)); assert.notEqual(alice.id, bob.id);
  const value = { workspaceKey: "same", ownerId: alice.id, revision: 1, messages: ["SYNTHETIC ALICE ONLY"] };
  assert.equal((await request("/records/continuity?key=same", { expectedRevision: 0, value }, alice)).status, 200);
  assert.equal((await (await request("/records/continuity?key=same", undefined, bob)).json()).value, null);
  const duplicate = await login(users[0]!); assert.equal(duplicate.id, alice.id);
  const sessions: string[] = [];
  for (const [index, account] of [alice, bob].entries()) {
    const marker = index === 0 ? "ALICE-ONLY" : "BOB-ONLY";
    const session = await (await request("/understanding/sessions", { workspaceKey: "same", projectKey: "same", label: marker, sourceText: marker + " synthetic material" }, account)).json();
    sessions.push(session.id);
    assert.equal((await request(`/understanding/sessions/${session.id}/turns`, { expectedRevision: session.revision, idempotencyKey: "same-key-synthetic", answer: "synthetic", consentToSend: true,
      runtime: { kind: "model", modelSettings: { provider: "ollama", model: "injected-no-network" } } }, account)).status, 202);
  }
  await Promise.all([...starts.values()].map(value => value.promise));
  results.get("BOB-ONLY")!.resolve(reply("BOB-ONLY")); const finishedBob = await settled(bob, sessions[1]!);
  assert.equal(finishedBob.understanding.summary, "BOB-ONLY synthetic summary");
  assert.equal((await request("/identity/sign-out", {}, alice)).status, 200);
  results.get("ALICE-ONLY")!.resolve(reply("ALICE-ONLY"));
  assert.equal((await request(`/understanding/sessions/${sessions[0]}`, undefined, bob)).status, 404);
  const returnedAlice = await login(users[0]!); assert.equal(returnedAlice.id, alice.id);
  const finishedAlice = await settled(returnedAlice, sessions[0]!); assert.equal(finishedAlice.understanding.summary, "ALICE-ONLY synthetic summary");
  assert.deepEqual(await (await request(`/understanding/sessions/${sessions[1]}`, undefined, bob)).json(), finishedBob);
  await fs.writeFile(path.join(directory, "fixture-credentials.json"), JSON.stringify({ users, config: { issuer: config.issuer, callbackUrl: config.callbackUrl } }), { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ status: "real-casdoor-code-pkce-signed-jwt-passed", syntheticAccounts: 2, ownersSeparated: true, repeatedLoginSameOwner: true,
    concurrentTasksAndLateCompletion: "passed", privateTestDirectory: directory, realResumeOrHistoryUsed: false }));
} finally {
  for (const [marker, result] of results) result.resolve(reply(marker));
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
}
