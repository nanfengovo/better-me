import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { StudioDesign, TrainingCareerContext, TrainingView, TrainingWritingInput } from "@better-me/agent-contracts";
import { TrainingKits } from "../src/growth/training-kits.js";
import { LearningStore } from "../src/growth/learning-store.js";
import type { TrainingAuthor } from "../src/growth/training-model.js";

const owner = "synthetic-writer", pin = "a".repeat(64);
const goal = "Explain an uncertain release date";
const original = "  We shipped on Friday, but testing is still in progress.\n";
const quote = "We shipped on Friday";
const rewrite = "\nTesting is in progress. I will confirm the release date on Friday.  ";
const feedback = { quote, comment: "The opening sounds final while the test is still in progress.",
  revisionPrompt: "Distinguish the confirmed test from the target release date." };
const makeScene = (topic: string, days: number) => ({
  brief: topic, situation: topic + " depends on an unfinished test.",
  steps: [
    { mode: "write" as const, prompt: "Update the reader about " + topic, followUp: "Name a confirmed fact.", extend: "Try a different audience." },
    { mode: "quantity" as const, prompt: "Calculate the combined delay", values: [days, 2], operation: "sum" as const,
      followUp: "List both delays.", extend: "Allow an extra day." },
  ],
});
const design: StudioDesign = { kind: "studio", title: "Communicating changes",
  scenes: [makeScene("Integration", 3), makeScene("Deployment", 4)] };
const request = () => ({ requestId: randomUUID(), consent: true, goal, engine: { type: "local", model: "synthetic-local" } });
const access = { session: "synthetic-session", valid: async () => true };
const reviewCommand = (kit: TrainingView) => ({ action: "review-writing", round: "practice", key: "part1",
  revision: kit.revision, questionVersion: kit.attempts[0]?.questionVersion ?? kit.questionVersion,
  consent: true, requestId: randomUUID() });
const rewriteCommand = (kit: TrainingView) => ({ action: "save-rewrite", round: "practice", key: "part1",
  revision: kit.revision, questionVersion: kit.attempts[0]!.questionVersion, answer: rewrite });
async function setup(t: TestContext, options: Partial<TrainingAuthor> = {}, target?: TrainingCareerContext) {
  const root = await mkdtemp(path.join(tmpdir(), "betterme-writing-test-"));
  const requests: TrainingWritingInput[] = [];
  const author: TrainingAuthor = {
    pin: async () => pin,
    diagnose: async () => ({ route: "studio", observation: "Observe a short response", nextStep: "Write an update" }),
    design: async () => design,
    program: async () => { throw Error("unexpected program"); },
    reviewWriting: async (_model, _pin, input) => { requests.push(input); return feedback; },
    ...options,
  };
  let now = Date.now();
  let activeTarget = target;
  const entries: { kits: TrainingKits; store: LearningStore }[] = [];
  function open(id = owner) {
    const store = new LearningStore(id, path.join(root, id));
    const kits = new TrainingKits(store, author, () => now, async () => activeTarget);
    entries.push({ kits, store });
    return kits;
  }
  async function closeAll() {
    for (const { kits, store } of entries.splice(0)) { kits.close(); await store.close(); }
  }
  t.after(async () => { await closeAll(); await rm(root, { recursive: true, force: true }); });
  const kits = open();
  const careerTarget = target && { workspaceKey: target.workspaceKey, targetId: target.targetId };
  const plan = await kits.plan({ ...request(), careerTarget }, access);
  const draft = await kits.build({ planId: plan.id, requestId: randomUUID(), consent: true }, access);
  async function saved() {
    const submission = await kits.command(draft.id, { action: "submit", round: "practice", revision: draft.revision,
      answer: { parts: { part1: original, part2: "836" } } }, access);
    return (await kits.command(draft.id, { action: "keep", revision: submission.kit!.revision }, access)).kit!;
  }
  return { kits, draft, saved, requests, open, closeAll, advance: () => { now += 86400001; },
    archive: () => { activeTarget = undefined; } };
}

test("a cited comment and a learner rewrite survive restart and retain the two distinct follow-up sources", async t => {
  const h = await setup(t);
  const saved = await h.saved();
  const first = saved.attempts[0]!;
  const reviewed = (await h.kits.command(saved.id, reviewCommand(saved), access)).kit!;
  assert.deepEqual(h.requests, [{ goal, material: [design.scenes[0]!.brief, design.scenes[0]!.situation],
    question: design.scenes[0]!.steps[0]!.prompt, answer: original }]);
  const note = reviewed.attempts[0]!.writingReviews![0]!;
  assert.deepEqual({ quote: note.quote, comment: note.comment, revisionPrompt: note.revisionPrompt }, feedback);
  assert.equal(note.modelDigest, pin);
  assert.equal(note.questionVersion, first.questionVersion);
  await assert.rejects(h.kits.command(saved.id, reviewCommand(reviewed), access), /already_reviewed/);
  await assert.rejects(h.kits.command(saved.id, { ...rewriteCommand(reviewed), answer: original }, access), /unchanged/);
  await assert.rejects(h.kits.command(saved.id, { ...rewriteCommand(reviewed), answer: "  " }, access));
  const changed = (await h.kits.command(saved.id, rewriteCommand(reviewed), access)).kit!;
  assert.equal(changed.version, saved.version);
  assert.equal(changed.stage, "waiting");
  assert.equal(changed.dueAt, saved.dueAt);
  const revisedAttempt = changed.attempts[0]!;
  assert.equal(revisedAttempt.writingReviews![0]!.rewrite!.answer, rewrite);
  const { writingReviews: _reviews, ...snapshot } = revisedAttempt;
  assert.deepEqual(snapshot, first);
  assert.equal(revisedAttempt.feedback.evidence![0]!.status, "recorded");
  await assert.rejects(h.kits.command(saved.id, rewriteCommand(changed), access), /rewrite_exists/);
  await h.closeAll();
  const restored = h.open();
  assert.deepEqual((await restored.get(saved.id, access)).attempts[0], revisedAttempt);
  const ref = { kitId: saved.id, version: saved.version, round: "practice", key: "part1" };
  const originalPlan = await restored.plan({ ...request(), followFrom: ref }, access);
  assert.equal(originalPlan.followFrom!.answer, original);
  assert.equal(originalPlan.followFrom!.usedPreview, false);
  const revisedPlan = await restored.plan({ ...request(), followFrom: { ...ref, useRewrite: true } }, access);
  assert.equal(revisedPlan.followFrom!.answer, rewrite);
  assert.equal(revisedPlan.followFrom!.usedPreview, true);
  assert.equal(revisedPlan.followFrom!.nextStep, feedback.revisionPrompt);
  assert.equal(h.requests.length, 1);
});

test("writing review requires explicit consent, a saved selected open answer and the original model pin", async t => {
  let bypass = false;
  const h = await setup(t, { pin: async () => bypass ? "f".repeat(64) : pin });
  await assert.rejects(h.kits.command(h.draft.id, reviewCommand(h.draft), access), /unavailable/);
  const s = await h.saved();
  await assert.rejects(h.kits.command(s.id, { ...reviewCommand(s), consent: false }, access));
  await assert.rejects(h.kits.command(s.id, { ...reviewCommand(s), key: "part2" }, access), /unavailable/);
  await assert.rejects(h.kits.command(s.id, { ...reviewCommand(s), questionVersion: "f".repeat(64) }, access), /unavailable/);
  await assert.rejects(h.kits.command(s.id, { ...reviewCommand(s), round: "retest" }, access), /unavailable/);
  await assert.rejects(h.kits.command(s.id, rewriteCommand(s), access), /review_required/);
  await assert.rejects(h.open("other-synthetic").command(s.id, reviewCommand(s), access), /not_found/);
  const ref = { kitId: s.id, version: s.version, round: "practice", key: "part1", useRewrite: true };
  await assert.rejects(h.kits.plan({ ...request(), followFrom: ref }, access), /source_changed/);
  bypass = true;
  await assert.rejects(h.kits.command(s.id, reviewCommand(s), access), /model_changed/);
  assert.equal(h.requests.length, 0);
});

test("fabricated quotes and replayed review requests cannot change evidence", async t => {
  let calls = 0;
  const h = await setup(t, { reviewWriting: async () => { calls++; return { ...feedback, quote: "  We shipped on Thursday" }; } });
  const s = await h.saved(), command = reviewCommand(s);
  await assert.rejects(h.kits.command(s.id, command, access), /quote_invalid/);
  await assert.rejects(h.kits.command(s.id, command, access), /already_used/);
  assert.equal(calls, 1);
  assert.deepEqual(await h.kits.get(s.id, access), s);
});

test("discard during model verification keeps the answer out of inference", async t => {
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  let delay = false;
  const h = await setup(t, { pin: async () => {
    if (delay) { started.resolve(); await finish.promise; }
    return pin;
  } });
  const s = await h.saved();
  delay = true;
  const reviewing = h.kits.command(s.id, reviewCommand(s), access);
  await started.promise;
  try { await h.kits.command(s.id, { action: "discard", revision: s.revision }, access); }
  finally { finish.resolve(); }
  await assert.rejects(reviewing, /kit_not_found/);
  assert.equal(h.requests.length, 0);
});

test("archiving a career target during review rejects its pending result and further requests", async t => {
  const target: TrainingCareerContext = { workspaceKey: "example-workspace", targetId: randomUUID(),
    goalId: "goal", goal, planId: "plan", planTitle: "Communication plan", taskId: "task",
    taskTitle: "Explain a delay", competency: goal, criterion: "Distinguish assumptions and facts",
    requirement: { title: "Release manager", company: "Synthetic company", itemId: "release",
      snapshotVersion: "e".repeat(64), quote: "Communicate release updates" } };
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  let calls = 0;
  const h = await setup(t, { reviewWriting: async () => {
    calls++; started.resolve(); await finish.promise; return feedback;
  } }, target);
  const s = await h.saved();
  const reviewing = h.kits.command(s.id, reviewCommand(s), access);
  await started.promise;
  h.archive();
  finish.resolve();
  await assert.rejects(reviewing, /career_target_changed/);
  await assert.rejects(h.kits.command(s.id, reviewCommand(s), access), /career_target_changed/);
  assert.deepEqual(await h.kits.get(s.id, access), s);
  assert.equal(calls, 1);
});

for (const change of ["discard", "submit retest", "revoke"] as const)
  test("pending review discards late results after " + change, async t => {
    const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
    let calls = 0;
    const h = await setup(t, { reviewWriting: async () => {
      calls++; started.resolve(); await finish.promise; return feedback;
    } });
    const s = await h.saved(), cmd = reviewCommand(s);
    const response = h.kits.command(s.id, cmd, access);
    await started.promise;
    try {
      await assert.rejects(h.kits.command(s.id, reviewCommand(s), access), /busy/);
      if (change === "discard") {
        await h.kits.command(s.id, { action: "discard", revision: s.revision }, access);
      } else if (change === "submit retest") {
        h.advance();
        await h.kits.command(s.id, { action: "submit", round: "retest", revision: s.revision,
          answer: { parts: { part1: "I will confirm the migration date after the deployment test.", part2: "6" } } }, access);
      } else h.kits.invalidate(access.session);
    } finally { finish.resolve(); }
    await assert.rejects(response);
    assert.equal(calls, 1);
    if (change === "discard") await assert.rejects(h.kits.get(s.id, access), /not_found/);
    else {
      const current = await h.kits.get(s.id, { ...access, session: "new-session" });
      assert.equal(current.attempts[0]!.writingReviews, undefined);
      assert.equal(current.attempts.length, change === "submit retest" ? 2 : 1);
    }
  });
