import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { trainingTransferInput, type StudioDesign, type TrainingCareerContext, type TrainingTransferAdvice, type TrainingTransferInput, type TrainingView } from "@better-me/agent-contracts";
import { LearningStore } from "../src/growth/learning-store.js";
import { TrainingKits } from "../src/growth/training-kits.js";
import type { TrainingAuthor } from "../src/growth/training-model.js";

const pin = "a".repeat(64), goal = "Explain the costs and choices behind a project.";
const access = { session: "synthetic-session", valid: async () => true };
const consent = () => ({ requestId: randomUUID(), consent: true as const });
const start = () => ({ ...consent(), goal, engine: { type: "local", model: "fixture" } });
const writing = (prompt: string) => ({ mode: "write" as const, prompt, followUp: "Clarify the tradeoff.", extend: "Try a new constraint." });
const quantity = (value: number) => ({ mode: "quantity" as const, prompt: "Compute the total", operation: "sum" as const, values: [value, 1], followUp: "Check the values.", extend: "Change the quantity." });
const design: StudioDesign = { kind: "studio", title: "Project decisions", scenes: [
  { brief: "Maintenance", situation: "Version one costs 2 units plus 1 unit for reviews.", steps: [writing("Explain the maintenance tradeoff"), quantity(2)] },
  { brief: "Delivery", situation: "The other project costs 5 units plus 1 unit for reviews.", steps: [quantity(5), writing("Describe the delivery risk")] },
] };
const advice = (input: TrainingTransferInput): TrainingTransferAdvice => ({
  direction: "verify", nextGoal: "Explain one assumption in a different estimate", actions: ["write"],
  reasons: input.evidence.map(item => ({ evidenceId: item.id, reason: item.question + " — " + item.status })),
});
const command = (v: TrainingView) => ({ action: "recommend-transfer", revision: v.revision, ...consent() });
const source = (v: TrainingView) => ({ kitId: v.id, version: v.version, evidenceVersion: v.transferDecision!.evidenceVersion });
async function setup(t: TestContext, override: Partial<TrainingAuthor> = {}, career?: TrainingCareerContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "betterme-transfer-"));
  let now = Date.now(), reviews = 0, diagnoses = 0;
  const inputs: TrainingTransferInput[] = [];
  const author: TrainingAuthor = {
    pin: async () => pin, diagnose: async () => { diagnoses++; return { route: "studio", observation: "Compare estimates.", nextStep: "Make a choice." }; },
    design: async p => p.transferFrom ? { ...design, title: p.advice.nextStep,
      scenes: design.scenes.map(scene => ({ ...scene, steps: [writing(p.advice.nextStep)] })) } : design,
    reviewWriting: async () => { reviews++; return { quote: "time", comment: "Be specific.", revisionPrompt: "Identify one uncertainty." }; },
    recommendTransfer: async (_model, _pin, input) => { inputs.push(input); return advice(input); },
    program: async () => { throw Error("Unexpected author call"); }, ...override,
  };
  const handles: {kits: TrainingKits; store: LearningStore}[] = [];
  function open(owner = "learner") {
    const store = new LearningStore(owner, path.join(directory, owner));
    const kits = new TrainingKits(store, author, () => now, async ref =>
      career && ref.workspaceKey === career.workspaceKey && ref.targetId === career.targetId ? career : undefined);
    handles.push({ store, kits }); return { store, kits };
  }
  t.after(async () => { for (const { kits, store } of handles) { kits.close(); await store.close(); } await rm(directory, { recursive: true, force: true }); });
  const { kits, store } = open();
  const careerTarget = career && { workspaceKey: career.workspaceKey, targetId: career.targetId };
  const plan = await kits.plan({ ...start(), careerTarget }, access);
  const draft = await kits.build({ ...consent(), planId: plan.id }, access);
  const first = (await kits.command(draft.id, { action: "submit", revision: draft.revision, round: "practice",
    answer: { parts: { part1: "More time is helpful.", part2: "3" } } }, access)).kit!;
  const saved = (await kits.command(draft.id, { action: "keep", revision: first.revision }, access)).kit!;
  async function rewrite(k: TrainingView) {
    const fields = { round: "practice", questionVersion: first.questionVersion, key: "part1" };
    const reviewed = (await kits.command(k.id, { ...consent(), ...fields, action: "review-writing", revision: k.revision }, access)).kit!;
    return (await kits.command(k.id, { ...fields, action: "save-rewrite", revision: reviewed.revision, answer: "We need reviewer time before the estimate holds." }, access)).kit!;
  }
  const advance = (ms = 86401000) => { now += ms; };
  async function submit(k: TrainingView, total = "6") {
    return (await kits.command(k.id, { action: "submit", revision: k.revision, round: "retest", answer: {
      parts: { part1: total, part2: "The estimate depends on the client approving the work." },
    } }, access)).kit!;
  }
  return { kits, store, saved, draft, inputs, advance, submit, rewrite, open, counts: () => ({ reviews, diagnoses }) };
}

test("independent transfer binds both different questions and the assisted rewrite, then builds the recommended practice", async t => {
  const h = await setup(t);
  await assert.rejects(h.kits.command(h.saved.id, command(h.saved), access), /training_transfer_unavailable/);
  const rewritten = await h.rewrite(h.saved);
  h.advance();
  const complete = await h.submit(rewritten);
  const originalAttempts = structuredClone(complete.attempts);
  const result = (await h.kits.command(complete.id, command(complete), access)).kit!;
  assert.deepEqual(result.attempts, originalAttempts);
  const input = h.inputs[0]!;
  assert.deepEqual(input.evidence.map(i => i.id), ["practice.part1", "rewrite.part1", "practice.part2", "retest.part1", "retest.part2"]);
  assert.equal(input.evidence[1]!.rewriteTiming, "before-retest");
  assert.equal(input.evidence[1]!.usedPreview, true);
  assert.equal(input.evidence[3]!.control, "quantity");
  assert.equal(input.evidence[3]!.status, "met");
  assert.equal(input.retest.independence, "independent");
  assert.deepEqual(result.attempts[1]?.aids, { preview: false, practiceReference: false });
  assert.equal(result.transferDecision!.modelDigest, pin);
  await assert.rejects(h.kits.command(result.id, command(result), access), /already_recommended/);
  await assert.rejects(h.open("another").kits.plan({ ...start(), transferFrom: source(result) }, access), /not_found/);
  await assert.rejects(h.kits.plan({ ...start(), goal: "outside goal", transferFrom: source(result) }, access), /source_changed/);
  const plan = await h.kits.plan({ ...start(), transferFrom: source(result) }, access);
  assert.equal(plan.modelCalls, 0);
  assert.deepEqual(h.counts(), { diagnoses: 1, reviews: 1 });
  assert.equal(h.inputs.length, 1);
  assert.equal(plan.advice.nextStep, result.transferDecision!.nextGoal);
  assert.deepEqual(plan.transferFrom!.citations, input.evidence);
  assert.equal(plan.transferFrom!.retestVersion, complete.attempts[1]!.questionVersion);
  await assert.rejects(h.kits.build({ ...consent(), planId: plan.id, actions: ["quantity"] }, access), /actions_changed/);
  const child = await h.kits.build({ ...consent(), planId: plan.id }, access);
  assert.equal(child.title, plan.advice.nextStep);
  assert.deepEqual(child.transferFrom, plan.transferFrom);
  assert.deepEqual(child.screen.fields.map(f => f.control), ["write"]);
  h.kits.close(); await h.store.close();
  assert.deepEqual((await h.open().kits.get(result.id, access)).transferDecision, result.transferDecision);
});

test("the host tracks first-attempt consultation and previews separately; a legacy untracked round cannot claim independence", async t => {
  let direction: TrainingTransferAdvice["direction"] = "extend";
  const h = await setup(t, { recommendTransfer: async (_model, _pin, input) => ({ ...advice(input), direction }) });
  await assert.rejects(h.kits.command(h.saved.id, { action: "view-practice", revision: h.saved.revision }, access), /round_changed/);
  h.advance();
  const hidden = await h.kits.get(h.saved.id, access);
  assert.equal(hidden.stage, "retest");
  assert.deepEqual(hidden.attempts, []);
  assert.ok(!JSON.stringify(hidden).includes("More time is helpful."));
  const practiceRef = { kitId: hidden.id, version: hidden.version, round: "practice", key: "part1" };
  await assert.rejects(h.kits.plan({ ...start(), followFrom: practiceRef }, access), /practice_reference_required/);
  await assert.rejects(h.kits.command(hidden.id, { ...consent(), action: "review-writing", revision: hidden.revision,
    questionVersion: h.saved.questionVersion, round: "practice", key: "part1" }, access), /practice_reference_required/);
  const seen = (await h.kits.command(h.saved.id, { action: "view-practice", revision: h.saved.revision }, access)).kit!;
  assert.deepEqual(seen.attempts, h.saved.attempts);
  assert.deepEqual(seen.retestAids, { preview: false, practiceReference: true });
  assert.equal((await h.kits.command(seen.id, { action: "view-practice", revision: seen.revision }, access)).kit!.revision, seen.revision);
  const previewed = (await h.kits.command(seen.id, { action: "explore", revision: seen.revision, round: "retest",
    answer: { parts: { part1: "6", part2: "Draft." } } }, access)).kit!;
  const done = await h.submit(previewed);
  assert.deepEqual(done.attempts[1]!.aids, { preview: true, practiceReference: true });
  assert.equal(trainingTransferInput(goal, done.attempts)?.retest.independence, "assisted");
  await assert.rejects(h.kits.command(done.id, command(done), access), /transfer_invalid/);
  direction = "reinforce";
  await assert.rejects(h.kits.command(done.id, command(done), access), /transfer_invalid/);
  await h.store.run(access, db => {
    const row = JSON.parse(String(db.prepare("SELECT body FROM training_kits WHERE id=?").get(done.id)!.body));
    delete row.practiceReferenceViewed; delete row.attempts[1].aids; row.attempts[1].usedPreview = false;
    db.prepare("UPDATE training_kits SET body=? WHERE id=?").run(JSON.stringify(row),done.id);
  });
  const legacy = await h.kits.get(done.id, access);
  assert.equal(trainingTransferInput(goal, legacy.attempts)?.retest.independence, "untracked");
  await assert.rejects(h.kits.command(done.id, command(legacy), access), /transfer_invalid/);
});

test("a rewrite added after retest invalidates recommendation and draft; the new comparison records its timing", async t => {
  const h = await setup(t); h.advance();
  const done = await h.submit(h.saved);
  const reviewed = (await h.kits.command(done.id, command(done), access)).kit!;
  const old = source(reviewed);
  const plan = await h.kits.plan({ ...start(), transferFrom: old }, access);
  h.advance(1000);
  const updated = await h.rewrite(reviewed);
  assert.equal(updated.transferDecision, undefined);
  await assert.rejects(h.kits.build({ ...consent(), planId: plan.id }, access), /source_changed/);
  await assert.rejects(h.kits.plan({ ...start(), transferFrom: old }, access), /source_changed/);
  const renewed = (await h.kits.command(done.id, command(updated), access)).kit!;
  assert.notEqual(renewed.transferDecision!.evidenceVersion, old.evidenceVersion);
  assert.equal(h.inputs[1]!.evidence.find(item => item.phase === "rewrite")?.rewriteTiming, "after-retest");
});

test("failed or duplicate requests, missing phases and invalid evidence references cannot create advice", async t => {
  let count = 0;
  const h = await setup(t, { recommendTransfer: async (_model, _pin, input) => {
    count++; const a = advice(input);
    if (count === 1) a.reasons = a.reasons.filter(x => !x.evidenceId.startsWith("rewrite."));
    if (count === 2) a.reasons[0]!.evidenceId = "practice.part4";
    if (count === 3) a.reasons[1] = a.reasons[0]!;
    if (count === 4) a.direction = "extend";
    return a;
  } });
  const rewritten = await h.rewrite(h.saved); h.advance(); const done = await h.submit(rewritten, "11");
  const cmd = command(done);
  await assert.rejects(h.kits.command(done.id, { ...cmd, consent: false }, access));
  await assert.rejects(h.kits.command(done.id, cmd, access), /transfer_invalid/);
  await assert.rejects(h.kits.command(done.id, cmd, access), /already_used/);
  for (let i=0; i<3; i++) await assert.rejects(h.kits.command(done.id, command(done), access), /transfer_invalid/);
  assert.equal(count, 4);
  assert.equal((await h.kits.get(done.id, access)).transferDecision, undefined);
});

test("concurrent recommendation cannot survive source deletion", async t => {
  const began = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const h = await setup(t, { recommendTransfer: async (_m, _p, input) => { began.resolve(); await finish.promise; return advice(input); } });
  h.advance(); const done = await h.submit(h.saved);
  const cmd = command(done);
  const pending = h.kits.command(done.id, cmd, access); await began.promise;
  await assert.rejects(h.kits.command(done.id, command(done), access), /training_busy/);
  await h.kits.command(done.id, { action: "discard", revision: done.revision }, access); finish.resolve();
  await assert.rejects(pending, /revision_conflict/);
  await assert.rejects(h.kits.get(done.id, access), /not_found/);
});

test("an invalidated session cannot settle or automatically replay a recommendation", async t => {
  const began = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>(); let calls = 0;
  const h = await setup(t, { recommendTransfer: async (_m,_p,input) => { calls++; began.resolve(); await finish.promise; return advice(input); } });
  h.advance(); const done = await h.submit(h.saved); const cmd = command(done);
  const pending = h.kits.command(done.id, cmd, access); await began.promise;
  h.kits.invalidate(access.session); finish.resolve(); await assert.rejects(pending);
  h.kits.close(); await h.store.close();
  const restored = h.open().kits; assert.equal((await restored.get(done.id, access)).transferDecision, undefined);
  await assert.rejects(restored.command(done.id, cmd, access), /already_used/); assert.equal(calls, 1);
});

test("a verified independent round allows a harder exercise; a changed model pin prevents inference", async t => {
  let pinChanged = false, calls = 0;
  const h = await setup(t, {
    pin: async () => pinChanged ? "d".repeat(64) : pin,
    recommendTransfer: async (_model, _pin, input) => { calls++; return { ...advice(input), direction: "extend" }; },
  });
  h.advance(); const done = await h.submit(h.saved);
  pinChanged = true;
  await assert.rejects(h.kits.command(done.id, command(done), access), /transfer_model_changed/);
  assert.equal(calls, 0);
  pinChanged = false;
  const advanced = (await h.kits.command(done.id, command(done), access)).kit!;
  assert.equal(advanced.transferDecision?.direction, "extend");
  assert.equal(advanced.transferDecision?.reasons.some(r => r.evidenceId.startsWith("rewrite.")), false);
});

test("a new first-round rewrite wins over an in-flight recommendation", async t => {
  const began = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const h = await setup(t, { recommendTransfer: async (_model,_pin,input) => { began.resolve(); await finish.promise; return advice(input); } });
  h.advance(); const done = await h.submit(h.saved);
  const pending = h.kits.command(done.id, command(done), access); await began.promise;
  const changed = await h.rewrite(done);
  finish.resolve(); await assert.rejects(pending, /revision_conflict/);
  const saved = await h.kits.get(done.id, access);
  assert.equal(saved.revision, changed.revision);
  assert.equal(saved.transferDecision, undefined);
  assert.equal(saved.attempts[0]?.writingReviews?.[0]?.rewrite?.answer, "We need reviewer time before the estimate holds.");
});

test("simultaneous reference and submission cannot both disclose the first round and record an independent retest", async t => {
  const h = await setup(t); h.advance();
  const due = await h.kits.get(h.saved.id, access);
  const [show, submit] = await Promise.allSettled([
    h.kits.command(due.id, { action: "view-practice", revision: due.revision }, access),
    h.submit(due),
  ]);
  assert.equal([show, submit].filter(result => result.status === "fulfilled").length, 1);
  const latest = await h.kits.get(due.id, access);
  if (show.status === "fulfilled") {
    assert.deepEqual(show.value.kit!.attempts, h.saved.attempts);
    const completed = await h.submit(latest);
    assert.equal(completed.attempts[1]?.aids?.practiceReference, true);
  } else {
    assert.equal(latest.attempts[1]?.aids?.practiceReference, false);
    assert.equal(latest.stage, "complete");
  }
});

test("first authenticated workshop access upgrades unopened legacy retests and preserves overdue and completed evidence", async t => {
  const h = await setup(t);
  h.advance();
  const complete = await h.submit(h.saved);
  const activated = Date.parse(complete.attempts[1]!.at);
  const ids = { unstarted: randomUUID(), waiting: randomUUID(), due: randomUUID(), complete: complete.id };
  await h.store.run(access, db => {
    const base = JSON.parse(String(db.prepare("SELECT body FROM training_kits WHERE id=?").get(complete.id)!.body));
    delete base.practiceReferenceViewed;
    delete base.attempts[1].aids;
    const insert = db.prepare("INSERT OR REPLACE INTO training_kits(id,body,active) VALUES(?,?,1)");
    for (const [state, id] of Object.entries(ids)) {
      const row = structuredClone(base);
      row.id = id;
      if (state !== "complete") row.attempts.length = state === "unstarted" ? 0 : 1;
      if (state === "waiting" || state === "due") {
        row.attempts[0].at = new Date(activated - (state === "waiting" ? 86400000 - 1 : 86400000)).toISOString();
      }
      insert.run(id, JSON.stringify(row));
    }
  });
  const bodies = (store: LearningStore) => store.run(access, db => new Map(
    db.prepare("SELECT id,body FROM training_kits").all().map(row => [String(row.id), String(row.body)]),
  ));
  const old = await bodies(h.store);
  h.kits.close(); await h.store.close();
  const upgrade = h.open();
  await upgrade.kits.list(access);
  const migrated = await bodies(upgrade.store);
  assert.equal(migrated.get(ids.due), old.get(ids.due), "already eligible at activation");
  assert.equal(migrated.get(ids.complete), old.get(ids.complete), "completed evidence must be byte-for-byte unchanged");
  for (const id of [ids.unstarted, ids.waiting]) {
    assert.deepEqual(JSON.parse(migrated.get(id)!), { ...JSON.parse(old.get(id)!), practiceReferenceViewed: false });
  }
  upgrade.kits.close(); await upgrade.store.close(); h.advance(1);
  const reopened = h.open();
  await reopened.kits.list(access);
  assert.deepEqual(await bodies(reopened.store), migrated, "restarting the workshop is idempotent");
  async function finish(id: string) {
    const due = await reopened.kits.get(id, access);
    assert.equal(due.stage, "retest");
    assert.deepEqual(due.attempts, [], "even an already-due legacy retest now hides history");
    const submitted = await reopened.kits.command(id, { action: "submit", round: "retest", revision: due.revision,
      answer: { parts: { part1: "6", part2: "The estimate depends on approval." } } }, access);
    return trainingTransferInput(goal, submitted.kit!.attempts)!.retest.independence;
  }
  assert.equal(await finish(ids.waiting), "independent");
  assert.equal(await finish(ids.due), "untracked");
  const first = await reopened.kits.get(ids.unstarted, access);
  await reopened.kits.command(first.id, { action: "submit", round: "practice", revision: first.revision,
    answer: { parts: { part1: "Approval takes time.", part2: "3" } } }, access);
  h.advance();
  assert.equal(await finish(first.id), "independent");
  assert.equal((await bodies(reopened.store)).get(ids.complete), old.get(ids.complete));
});

test("a second transfer decision targets the adopted specialty and cites the child rounds within the original career task", async t => {
  const career: TrainingCareerContext = {
    workspaceKey: "synthetic-project-estimates", targetId: randomUUID(), goalId: "project-lead", goal: "Lead a project",
    planId: "growth-plan", planTitle: "Project decisions", taskId: "estimate-task", taskTitle: "Explain a project estimate",
    competency: goal, criterion: "State a dependency that could change the estimate.",
    requirement: { title: "Engineering lead", company: "Fixture", itemId: "estimate", snapshotVersion: "f".repeat(64), quote: "Explain project estimates." },
  };
  const observed: TrainingTransferInput[] = [];
  const nextSpecialty = "Define a fallback if the approver misses the deadline.";
  const h = await setup(t, {
    recommendTransfer: async (_model, _pin, input) => {
      observed.push(input);
      const result = advice(input);
      return observed.length === 2 ? { ...result, nextGoal: nextSpecialty } : result;
    },
  }, career);
  const adopt = (kit: TrainingView) => h.kits.plan({ ...start(),
    careerTarget: { workspaceKey: career.workspaceKey, targetId: career.targetId }, transferFrom: source(kit) }, access);
  h.advance();
  const rootRetest = await h.submit(h.saved);
  const parent = (await h.kits.command(rootRetest.id, command(rootRetest), access)).kit!;
  const firstSpecialty = parent.transferDecision!.nextGoal;
  const firstPlan = await adopt(parent);
  const child = await h.kits.build({ ...consent(), planId: firstPlan.id }, access);
  const answers = ["I assume a second reviewer is available.", "Approval by the supplier is the remaining dependency."] as const;
  const practiced = (await h.kits.command(child.id, { action: "submit", round: "practice", revision: child.revision,
    answer: { parts: { part1: answers[0] } } }, access)).kit!;
  const saved = (await h.kits.command(child.id, { action: "keep", revision: practiced.revision }, access)).kit!;
  h.advance();
  const retest = (await h.kits.command(child.id, { action: "submit", round: "retest", revision: saved.revision,
    answer: { parts: { part1: answers[1] } } }, access)).kit!;
  const decided = (await h.kits.command(child.id, command(retest), access)).kit!;
  assert.equal(observed.length, 2);
  assert.equal(observed[0]!.goal, goal);
  assert.equal(observed[1]!.goal, firstSpecialty);
  assert.equal(observed[1]!.overallGoal, goal);
  assert.deepEqual(observed[1]!.evidence.map(i => i.answer), answers);
  assert.equal(observed[1]!.retest.independence, "independent");

  const nextPlan = await adopt(decided);
  assert.equal(nextPlan.goal, goal);
  assert.equal(nextPlan.advice.nextStep, nextSpecialty);
  assert.deepEqual(nextPlan.career, career);
  const from = nextPlan.transferFrom!;
  assert.equal(from.kitId, child.id);
  assert.equal(from.version, child.version);
  assert.equal(from.evidenceVersion, decided.transferDecision!.evidenceVersion);
  assert.deepEqual(from.citations.map(i => i.answer), answers);
  assert.equal(from.practiceVersion, practiced.attempts[0]!.questionVersion);
  assert.equal(from.retestVersion, retest.attempts[1]!.questionVersion);
  assert.notEqual(from.retestVersion, rootRetest.attempts[1]!.questionVersion);
  const next = await h.kits.build({ ...consent(), planId: nextPlan.id }, access);
  assert.equal(next.title, nextSpecialty);
  assert.deepEqual(next.career, career);
  assert.deepEqual(next.transferFrom, from);
});

test("writing transfer can only advance on changed frozen conditions and an exact passage of the learner's response", async t => {
  const answer = "I will request a new signature before publishing.";
  const scenes = ["Alex has the project.", "Blair has the project."].map(situation => ({
    brief: "Handoff", situation, steps: [writing("Explain the decision"), writing("List the next step")],
  }));
  for (const changed of [false, true]) {
    let cited = "This passage was never written.";
    const h = await setup(t, {
      design: async () => ({ kind: "studio", title: "Approval", scenes,
        ...(changed ? { decisionCondition: { subject: "Client signature", firstState: "confirmed" } } : {}) }),
      recommendTransfer: async (_m,_p,input) => ({ ...advice(input), direction: "extend",
        reasons: advice(input).reasons.map(reason => reason.evidenceId === "retest.part1" ? { ...reason, answerQuote: cited } : reason) }),
    });
    h.advance();
    const done = await h.submit(h.saved, answer);
    await assert.rejects(h.kits.command(done.id, command(done), access), /training_transfer_invalid/);
    cited = "request a new signature";
    if (!changed) {
      assert.equal(done.attempts[1]!.retestChange, undefined);
      await assert.rejects(h.kits.command(done.id, command(done), access), /training_transfer_invalid/);
      continue;
    }
    const change = done.attempts[1]!.retestChange!;
    assert.ok(done.attempts[0]!.question!.notes.includes(change.before));
    assert.ok(done.attempts[1]!.question!.notes.includes(change.after));
    assert.ok(done.attempts[1]!.question!.notes.includes(change.criterion));
    const result = (await h.kits.command(done.id, command(done), access)).kit!;
    h.kits.close(); await h.store.close();
    const resumed = h.open();
    const reopened = await resumed.kits.get(result.id, access);
    assert.deepEqual(reopened.attempts[1]?.retestChange, change);
    assert.deepEqual(reopened.transferDecision, result.transferDecision);
    assert.equal(reopened.transferDecision?.reasons.find(reason => reason.evidenceId === "retest.part1")?.answerQuote, cited);
    const plan = await resumed.kits.plan({ ...start(), transferFrom: source(reopened) }, access);
    assert.deepEqual(plan.transferFrom?.retestChange, change);
  }
});
