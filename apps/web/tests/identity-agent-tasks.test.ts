import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { activatePrincipal, IdentityBoundaryError } from "../src/lib/identity";
import { BetterMeAgent } from "../src/lib/betterme-agent/kernel";
import { createMemoryAgentRepository, emptyAgentState } from "../src/lib/betterme-agent/storage";
import { fixtureSession, fixtureUnderstanding } from "./fixtures/project-understanding";

const alice = { id: "11111111-1111-4111-8111-111111111111", username: "alice", displayName: "Alice" };
const bob = { id: "22222222-2222-4222-8222-222222222222", username: "bob", displayName: "Bob" };
const descriptor = { id: "identical-task", origin: "companion" as const, label: "Synthetic task", destination: "deterministic fixture", input: "Synthetic input" };
const noSession = async () => { throw new Error("This fixture must not read any project session"); };
afterEach(() => activatePrincipal(undefined));

test("A→B→A rejects an uncooperative old task while each account can use the same workspace and task ID", async () => {
  activatePrincipal(alice);
  const repositoryA = createMemoryAgentRepository(), repositoryB = createMemoryAgentRepository();
  const a = new BetterMeAgent("same-workspace", repositoryA, noSession, alice.id);
  await a.ready;
  const started = Promise.withResolvers<void>(), result = Promise.withResolvers<string>();
  let taskSignal: AbortSignal | undefined;
  const oldTask = a.run(descriptor, async signal => { taskSignal = signal; started.resolve(); return result.promise; }, text => text);
  // Attach before switching: a correct implementation may reject immediately.
  const rejected = assert.rejects(oldTask, IdentityBoundaryError);
  await started.promise;
  activatePrincipal(bob);
  const b = new BetterMeAgent("same-workspace", repositoryB, noSession, bob.id);
  await b.ready;
  await b.run({ ...descriptor, input: "BOB-ONLY input" }, async () => "BOB-ONLY reply", text => text);
  activatePrincipal(alice);
  result.resolve("ALICE-LATE answer must not be adopted");
  await rejected;
  assert.equal(taskSignal?.aborted, true, "switching identity must cancel the original task lease");
  assert.ok(!a.getSnapshot().data.messages.some(message => message.text.includes("ALICE-LATE")));
  assert.deepEqual(b.getSnapshot().data.messages.map(message => message.text), ["BOB-ONLY input", "BOB-ONLY reply"]);
  const restored = new BetterMeAgent("same-workspace", repositoryA, noSession, alice.id);
  await restored.ready;
  assert.equal(restored.getSnapshot().data.ownerId, alice.id);
  assert.ok(restored.getSnapshot().data.messages.every(message => !/BOB-ONLY|ALICE-LATE/.test(message.text)));
  await restored.flush();
});

test("a delayed initial memory load cannot become usable after the account changes", async () => {
  activatePrincipal(alice);
  const result = Promise.withResolvers<ReturnType<typeof emptyAgentState>>();
  const memory = emptyAgentState("same-workspace", alice.id); memory.goal = "ALICE-ONLY delayed goal";
  let saves = 0;
  const agent = new BetterMeAgent("same-workspace", {
    load: () => result.promise, save: async () => { saves++; },
  }, noSession, alice.id);
  activatePrincipal(bob); result.resolve(memory);
  await agent.ready;
  assert.equal(agent.getSnapshot().data.goal, "");
  await assert.rejects(agent.flush(), IdentityBoundaryError);
  assert.throws(() => agent.setGoal("must not be written"), IdentityBoundaryError);
  assert.equal(saves, 0);
});

test("switching accounts while checking project memory prevents model submission even if the reader ignores cancellation", async () => {
  activatePrincipal(alice);
  const session = fixtureSession({ phase: "confirmed", revision: 2, summaryHash: "synthetic-hash", understanding: fixtureUnderstanding,
    confirmation: { revision: 2, summaryHash: "synthetic-hash", confirmedAt: "2026-11-03T01:00:00.000Z" } });
  const started = Promise.withResolvers<void>(), result = Promise.withResolvers<typeof session>();
  const agent = new BetterMeAgent("same-workspace", createMemoryAgentRepository(), async () => { started.resolve(); return result.promise; }, alice.id);
  await agent.ready;
  agent.reconcileSources([{ key: "synthetic-field", text: session.sourceText }]);
  agent.observeUnderstanding(session, "synthetic-field"); agent.shareMemory(`project:${session.id}`, true);
  let modelCalls = 0;
  const pending = agent.run({ ...descriptor, shareMemories: true }, async () => { modelCalls++; return "must not be generated"; }, text => text);
  const rejected = assert.rejects(pending, IdentityBoundaryError);
  await started.promise; activatePrincipal(bob); result.resolve(session);
  await rejected;
  assert.equal(modelCalls, 0);
  assert.ok(agent.getSnapshot().data.messages.every(message => message.text !== "must not be generated"));
});
