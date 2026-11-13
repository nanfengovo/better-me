import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CodingTaskService, type CodingTaskLease, type CreateCodingTask } from "../src/sandbox/coding-tasks.js";

const grant = () => true;
const digest = "a".repeat(64);
const spec = (): CreateCodingTask => ({
  goal: "Double each synthetic number.",
  model: "fixture:small",
  cases: [{ id: "zero", input: 0, expected: 0 }, { id: "two", input: 2, expected: 4 }],
  consent: true,
  idempotencyKey: "synthetic-click",
});
type Dependencies = Omit<ConstructorParameters<typeof CodingTaskService>[0], "ownerId" | "directory">;
async function fixture(t: TestContext, dependencies: Dependencies = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-coding-synthetic-"));
  const options = { ownerId: "owner-A", directory, resolveModel: async () => digest, ...dependencies };
  const services: CodingTaskService[] = [];
  const open = (ownerId = options.ownerId) => { const s = new CodingTaskService({ ...options, ownerId }); services.push(s); return s; };
  t.after(async () => { for (const s of services) await s.close(); await rm(directory, { recursive: true, force: true }); });
  return { service: open(), open, directory };
}
function barrier<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve };
}

test("creation fixes a private, initially unverified checklist; reading never asks the model to write code", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-coding-synthetic-"));
  const service = new CodingTaskService({ ownerId: "owner-A", directory,
    resolveModel: async () => digest, generate: async () => { throw Error("unexpected inference"); } });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const input = spec(), created = await service.create(input, grant);
  input.cases[0]!.expected = "changed after admission";
  assert.equal(created.status, "ready");
  assert.equal(created.modelDigest, digest);
  assert.equal(created.attemptsUsed, 0);
  assert.equal(created.best, undefined);
  assert.deepEqual(created.history, []);
  assert.equal((await service.get(created.id, grant)).cases[0]!.expected, 0);
  assert.deepEqual(await service.list(grant), [created]);
  assert.deepEqual(await service.create(spec(), grant), created);
  await assert.rejects(service.create({ ...spec(), goal: "another task" }, grant), /idempotency_conflict/);
});

test("an explicit step targets one missing case, sees the previous code and full feedback, and promotes only independent checks", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-coding-synthetic-"));
  const sources = ["zero only", "two only", "both"];
  let calls = 0;
  const service = new CodingTaskService({ ownerId: "owner-A", directory, resolveModel: async () => digest,
    generate: async request => {
      const i = calls++;
      assert.deepEqual(Object.keys(request).sort(), [
        "goal", "cases", "targetCaseId", ...(i ? ["previousSource"] : []), "previousChecks", "model", "modelDigest",
      ].sort());
      assert.equal(request.targetCaseId, ["zero", "two", "zero"][i]);
      if (i) {
        assert.equal(request.previousSource, sources[i - 1]);
        assert.deepEqual(request.previousChecks.map(c => c.passed), i === 1 ? [true, false] : [false, true]);
      }
      return sources[i]!;
    }, verify: async (source, cases) => {
      assert.deepEqual(cases.map(c => c.id), ["zero", "two"]);
      return cases.map(c => ({ id: c.id, passed: source === "both" || source.startsWith(c.id) }));
    } });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  let state = await service.create(spec(), grant);
  state = await service.step(state.id, state.revision, grant);
  assert.equal(state.status, "ready"); assert.equal(state.best?.source, "zero only");
  state = await service.step(state.id, state.revision, grant);
  assert.equal(state.lastAttempt?.outcome, "regression"); assert.equal(state.best?.source, "zero only");
  assert.deepEqual(state.best?.checks.map(c => c.passed), [true, false]);
  state = await service.step(state.id, state.revision, grant);
  assert.equal(state.status, "review_ready"); assert.equal(state.attemptsUsed, 3);
  assert.equal(state.best?.source, "both"); assert.deepEqual(state.best?.checks.map(c => c.passed), [true, true]);
  assert.deepEqual(state.history.map(a => [a.number, a.targetCaseId, a.outcome, a.passedIds, a.failedIds]), [
    [1, "zero", "accepted", ["zero"], ["two"]], [2, "two", "regression", ["two"], ["zero"]],
    [3, "zero", "accepted", ["zero", "two"], []],
  ]);
  assert.equal(state.history[2]!.sourceHash, state.best?.sourceHash); assert.ok(state.history.every(a => a.activeMs >= 0));
  await assert.rejects(service.step(state.id, state.revision, grant), /not_runnable/);
  assert.equal(calls, 3);
});

test("the actual isolated verifier evaluates every case; one explicitly requested attempt may satisfy several cases", async t => {
  const { service } = await fixture(t, { generate: async () => "x => x * 2" });
  const created = await service.create(spec(), grant);
  const reviewed = await service.step(created.id, created.revision, grant);
  assert.equal(reviewed.status, "review_ready"); assert.equal(reviewed.attemptsUsed, 1);
  assert.deepEqual(reviewed.best?.checks, [{ id: "zero", passed: true }, { id: "two", passed: true }]);
});

test("concurrent starts cannot double spend; explicit pause aborts and a non-cooperative late response never wins", async t => {
  const entered = barrier<void>(), late = barrier<string>(); let calls = 0, aborted = false;
  const { service } = await fixture(t, { generate: async (_input, signal) => {
    calls++; signal.addEventListener("abort", () => { aborted = true; }); entered.resolve(); return late.promise;
  } });
  const first = await service.create(spec(), grant);
  const pending = service.step(first.id, first.revision, grant);
  await entered.promise;
  const running = await service.get(first.id, grant);
  assert.equal(running.status, "running"); assert.equal(running.attemptsUsed, 1);
  await assert.rejects(service.step(first.id, first.revision, grant), /revision_conflict/);
  await assert.rejects(service.step(first.id, running.revision, grant), /not_runnable/);
  const paused = await service.pause(first.id, running.revision, grant);
  assert.equal(paused.status, "paused"); assert.equal(paused.attemptsUsed, 1);
  assert.equal(paused.lastAttempt?.outcome, "interrupted"); assert.equal(aborted, true);
  await assert.rejects(pending, /superseded/);
  late.resolve("x => x * 2");
  assert.deepEqual(await service.get(first.id, grant), paused); assert.equal(calls, 1);
});

test("a real process exit after reservation survives reopen charged, never reissues inference, and needs an explicit step", async t => {
  let generations = 0;
  const { service, open, directory } = await fixture(t, { generate: async () => { generations++; return "x => x * 2"; } });
  const created = await service.create(spec(), grant);
  const competitor = open(); await assert.rejects(competitor.get(created.id, grant), /single_writer_required/); await competitor.close();
  if (process.platform !== "win32") {
    assert.equal((await lstat(directory)).mode & 0o777, 0o700);
    for (const name of await readdir(directory)) assert.equal((await lstat(path.join(directory, name))).mode & 0o077, 0);
  }
  await service.close();
  const child = [
    "const { CodingTaskService } = await import(process.argv[1]);",
    "const { directory,id,revision,digest }=JSON.parse(process.argv[2]);",
    "const service=new CodingTaskService({ownerId:'owner-A',directory,resolveModel:async()=>digest,generate:async()=>process.exit(17)});",
    "await service.step(id,revision,()=>true);",
  ].join("\n");
  await assert.rejects(promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", child,
    new URL("../src/sandbox/coding-tasks.ts", import.meta.url).href,
    JSON.stringify({ directory, id: created.id, revision: created.revision, digest })],
    // This is a separate Host process, not a child of the Web test runner's
    // loader configuration. Do not inherit its relative tsconfig or credentials.
    { cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 10_000, env: {
      TSX_TSCONFIG_PATH: fileURLToPath(new URL("../tsconfig.json", import.meta.url)), TSX_DISABLE_CACHE: "1",
      ...(process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    } }), (err: NodeJS.ErrnoException) => Number(err.code) === 17);
  const other = open("owner-B");
  await assert.rejects(other.get(created.id, grant), /owner_mismatch/); await other.close();
  const restored = open(), state = await restored.get(created.id, grant);
  assert.equal(state.status, "interrupted"); assert.equal(state.attemptsUsed, 1);
  assert.equal(state.lastAttempt?.outcome, "interrupted"); assert.equal(state.lastAttempt?.error, "coding_host_restarted");
  assert.deepEqual(state.history.map(a => a.outcome), ["interrupted"]);
  assert.deepEqual(await restored.list(grant), [state]); assert.equal(generations, 0);
  const finished = await restored.step(state.id, state.revision, grant);
  assert.equal(finished.status, "review_ready"); assert.equal(finished.attemptsUsed, 2); assert.equal(generations, 1);
  assert.deepEqual(finished.history.map(a => a.number), [1, 2]);
});

test("digest drift, disabled consent and malformed or forged criteria never authorize inference", async t => {
  let selectedDigest = digest, calls = 0, resolves = 0, touched = false;
  const { service } = await fixture(t, { resolveModel: async () => { resolves++; return selectedDigest; },
    generate: async () => { calls++; return "x => x"; } });
  for (const bad of [
    { consent: false }, { ownerId: "owner-B" }, { source: "forged" }, { model: "https://elsewhere/" },
    { cases: [{ id: "a", expected: 1 }] }, { cases: [spec().cases[0], spec().cases[0]] },
    { cases: [{ id: "a", input: 0, expected: 1, passed: true }] }, { maxAttempts: 9 },
    { cases: [{ id: "a", input: Number.NaN, expected: null }] },
    { cases: [{ id: "a", input: "x".repeat(32 * 1024 + 1), expected: null }] },
    { cases: [{ id: "a", input: Object.defineProperty({}, "bad", { enumerable: true, get() { touched = true; return "bad"; } }), expected: null }] },
  ]) await assert.rejects(service.create({ ...spec(), ...bad } as CreateCodingTask, grant));
  assert.equal(touched, false); assert.equal(resolves, 0);
  const initial = await service.create(spec(), grant); selectedDigest = "b".repeat(64);
  await assert.rejects(service.step(initial.id, initial.revision, grant), /digest_changed/);
  await assert.rejects(service.get(initial.id, () => false), /lease_invalid/);
  await assert.rejects(service.list(() => false), /lease_invalid/);
  await assert.rejects(service.get("../another-owner", grant), /not_found/);
  const drifted = await service.get(initial.id, grant);
  assert.equal(drifted.status, "paused"); assert.ok(drifted.revision > initial.revision);
  assert.equal(drifted.modelDigest, initial.modelDigest); assert.deepEqual(drifted.cases, initial.cases);
  assert.equal(drifted.attemptsUsed, 0); assert.deepEqual(drifted.history, []); assert.equal(drifted.best, undefined); assert.equal(calls, 0);
});

test("revoking the session aborts local metadata I/O and abandons a charged verification, even when its provider ignores abort", async t => {
  const init = barrier<void>(), never = barrier<string>(), verifying = barrier<void>(), late = barrier<{ id: string; passed: boolean }[]>();
  let resolveCount = 0, signalled = false;
  const { service } = await fixture(t, { resolveModel: async (_model, signal) => {
    if (++resolveCount !== 1) return digest;
    signal.addEventListener("abort", () => { signalled = true; }); init.resolve(); return never.promise;
  }, generate: async () => "x => x * 2", verify: async () => { verifying.resolve(); return late.promise; } });
  const token = new AbortController(), lease: CodingTaskLease = Object.assign(() => true, { signal: token.signal });
  const creating = service.create(spec(), lease); await init.promise; token.abort();
  await assert.rejects(creating, /lease_invalid/); assert.equal(signalled, true); assert.deepEqual(await service.list(grant), []);
  const first = await service.create(spec(), grant), stepToken = new AbortController();
  const stepping = service.step(first.id, first.revision, Object.assign(() => true, { signal: stepToken.signal }));
  await verifying.promise; stepToken.abort(); await assert.rejects(stepping, /lease_invalid/);
  late.resolve(first.cases.map(c => ({ id: c.id, passed: true })));
  const state = await service.get(first.id, grant);
  assert.equal(state.status, "paused"); assert.equal(state.lastAttempt?.error, "coding_lease_invalid");
  assert.equal(state.attemptsUsed, 1); assert.equal(state.best, undefined);
});

test("a partial or forged verifier report cannot promote a candidate; failure repairs keep code, not raw traces", async t => {
  let calls = 0, verifications = 0;
  const { service } = await fixture(t, { generate: async input => {
    if (++calls === 2) {
      assert.equal(input.previousSource, "x => 0");
      assert.ok(input.previousChecks.every(c => !c.passed && c.error === "candidate_not_verified"));
    }
    return "x => 0";
  }, verify: async () => ++verifications === 1 ? [{ id: "unknown", passed: true }]
    : [{ id: "zero", passed: true }, { id: "two", passed: false, error: "private untrusted error text" }] });
  let state = await service.create({ ...spec(), maxAttempts: 2 }, grant);
  state = await service.step(state.id, state.revision, grant);
  assert.equal(state.best, undefined); assert.equal(state.lastAttempt?.error, "coding_incomplete_verification");
  state = await service.step(state.id, state.revision, grant);
  assert.equal(state.status, "budget_exhausted"); assert.equal(state.best?.source, "x => 0");
  assert.deepEqual(state.history.map(a => a.outcome), ["failed", "accepted"]);
  assert.ok(!JSON.stringify(state).includes("private untrusted"));
  await assert.rejects(service.step(state.id, state.revision, grant), /budget_exhausted/);
  assert.equal(calls, 2);
});

test("active-time exhaustion interrupts a noncooperative generator, persists the charge, and never triggers retry", async t => {
  // Model slow preflight work, but select the generation phase by an actual
  // callback barrier instead of letting disk speed spend this 40ms deadline.
  // The separate preflight test below verifies exhaustion before generation.
  const wallDelay = delay;
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const late = barrier<string>(), entered = barrier<void>(); let calls = 0, pins = 0, aborted = false;
  const { service, open } = await fixture(t, { resolveModel: async () => {
    if (++pins === 2) await wallDelay(60);
    return digest;
  }, generate: async (_input, signal) => {
    calls++; signal.addEventListener("abort", () => { aborted = true; }, { once: true });
    entered.resolve(); return late.promise;
  } });
  const start = await service.create({ ...spec(), maxActiveMs: 40 }, grant);
  const step = service.step(start.id, start.revision, grant);
  const stopped = await (async () => {
    try {
      await Promise.race([entered.promise, step.then(() => assert.fail("generation must be entered before the controlled deadline"))]);
      assert.equal(calls, 1); assert.equal(pins, 2); assert.equal(aborted, false);
      t.mock.timers.tick(39); assert.equal(aborted, false);
      t.mock.timers.tick(1);
      return await step;
    } finally { late.resolve("x => x * 2"); await step.catch(() => {}); }
  })();
  assert.equal(aborted, true);
  assert.equal(stopped.status, "budget_exhausted"); assert.equal(stopped.activeMs, 40);
  assert.equal(stopped.attemptsUsed, 1); assert.equal(stopped.history[0]?.error, "coding_step_timeout");
  late.resolve("x => x * 2");
  await service.close(); const reopened = open();
  assert.deepEqual(await reopened.get(stopped.id, grant), stopped);
  await assert.rejects(reopened.step(stopped.id, stopped.revision, grant), /budget_exhausted/);
  assert.equal(calls, 1);
});

test("a stalled model metadata preflight exhausts the same active budget without spending an inference attempt", async t => {
  // Freeze persistence time, then advance the deadline only after the real
  // metadata callback is entered. A slow Windows fs must not win this race.
  t.mock.timers.enable({apis:["Date","setTimeout"],now:Date.now()});
  const late=barrier<string>(),entered=barrier<void>();let pins=0,calls=0,aborted=false;
  const {service,open}=await fixture(t,{resolveModel:async(_model,signal)=>{
    if(++pins===1)return digest;
    signal.addEventListener("abort",()=>{aborted=true;},{once:true});entered.resolve();return late.promise;
  },generate:async()=>{calls++;return "x => x * 2";}});
  const start=await service.create({...spec(),maxActiveMs:20},grant);
  const step=service.step(start.id,start.revision,grant);
  try {
    await entered.promise;t.mock.timers.tick(20);
    await assert.rejects(step,/coding_budget_exhausted/);
  } finally {late.resolve(digest);await step.catch(()=>{});}
  const state=await service.get(start.id,grant);assert.equal(aborted,true);
  assert.equal(state.status,"budget_exhausted");assert.equal(state.activeMs,20);assert.equal(state.attemptsUsed,0);
  assert.equal(calls,0);assert.deepEqual(state.history,[]);assert.equal(state.best,undefined);
  await service.close();assert.deepEqual(await open().get(start.id,grant),state);
});

test("the metadata preflight, generation, recheck and verification share one clock without double billing",async t=>{
  let now=Date.now(),pins=0;
  t.mock.method(Date,"now",()=>now);
  const {service}=await fixture(t,{resolveModel:async()=>{pins++;if(pins===2)now+=17;if(pins===3)now+=7;return digest;},
    generate:async()=>{now+=23;return "x => x * 2";},verify:async(_source,cases)=>{now+=11;return cases.map(({id})=>({id,passed:true}));}});
  const first=await service.create({...spec(),maxActiveMs:1000},grant);
  const done=await service.step(first.id,first.revision,grant);
  assert.equal(done.status,"review_ready");assert.equal(done.activeMs,58);
  assert.equal(done.history[0]?.activeMs,58);assert.equal(done.attemptsUsed,1);
});

test("pause and lease revocation each settle only metadata time; late probes cannot overwrite a newer grant",async t=>{
  const firstProbe=barrier<void>(),secondProbe=barrier<void>(),lateA=barrier<string>(),lateB=barrier<string>();
  let now=Date.now(),pins=0,calls=0;
  t.mock.method(Date,"now",()=>now);
  const {service}=await fixture(t,{resolveModel:async()=>{
    if(++pins===2){firstProbe.resolve();return lateA.promise;}
    if(pins===3){secondProbe.resolve();return lateB.promise;}return digest;
  },generate:async()=>{calls++;return "x => x * 2";},verify:async(_source,cases)=>cases.map(({id})=>({id,passed:true}))});
  const first=await service.create(spec(),grant),staleA=service.step(first.id,first.revision,grant);
  await firstProbe.promise;now+=13;
  const paused=await service.pause(first.id,first.revision,grant);await assert.rejects(staleA,/superseded/);
  assert.equal(paused.activeMs,13);assert.equal(paused.attemptsUsed,0);assert.deepEqual(paused.history,[]);
  const token=new AbortController();
  const staleB=service.step(first.id,paused.revision,Object.assign(()=>true,{signal:token.signal}));
  await secondProbe.promise;now+=19;token.abort();await assert.rejects(staleB,/lease_invalid/);
  const denied=await service.get(first.id,grant);assert.equal(denied.status,"paused");
  assert.equal(denied.activeMs,32);assert.equal(denied.attemptsUsed,0);assert.equal(calls,0);
  const done=await service.step(first.id,denied.revision,grant);lateA.resolve("b".repeat(64));lateB.resolve(digest);
  assert.equal(done.status,"review_ready");assert.equal(calls,1);assert.deepEqual(await service.get(first.id,grant),done);
});

test("a process loss during the model check recovers a bounded time charge, not a guessed inference",async t=>{
  let calls=0;const {service,open,directory}=await fixture(t,{generate:async()=>{calls++;return "x => x * 2";}});
  const first=await service.create({...spec(),maxActiveMs:30_000},grant);await service.close();
  const child=[
    "const {CodingTaskService}=await import(process.argv[1]);",
    "const {directory,id,revision}=JSON.parse(process.argv[2]);",
    "const s=new CodingTaskService({ownerId:'owner-A',directory,resolveModel:async()=>{await new Promise(r=>setTimeout(r,20));process.exit(19);},generate:async()=>process.exit(70)});",
    "await s.step(id,revision,()=>true);",
  ].join("\n");
  await assert.rejects(promisify(execFile)(process.execPath,["--import","tsx","--input-type=module","-e",child,
    new URL("../src/sandbox/coding-tasks.ts",import.meta.url).href,JSON.stringify({directory,id:first.id,revision:first.revision})],
    {cwd:fileURLToPath(new URL("../",import.meta.url)),timeout:10_000,env:{
      TSX_TSCONFIG_PATH:fileURLToPath(new URL("../tsconfig.json",import.meta.url)),TSX_DISABLE_CACHE:"1",
      ...(process.platform==="win32"&&process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})}}),
    (e:NodeJS.ErrnoException)=>Number(e.code)===19);
  const fresh=open(),seen=await fresh.get(first.id,grant);
  assert.equal(seen.status,"interrupted");assert.ok(seen.activeMs>0&&seen.activeMs<=10_000);
  assert.equal(seen.attemptsUsed,0);assert.deepEqual(seen.history,[]);assert.equal(seen.best,undefined);
  assert.deepEqual(await fresh.list(grant),[seen]);assert.equal(calls,0);
});

test("a model swap detected inside generation is charged, pauses, and declines unsafe diagnostics", async t => {
  const { service } = await fixture(t, { generate: async () => { throw Error("coding_model_changed"); } });
  const state = await service.create(spec(), grant), paused = await service.step(state.id, state.revision, grant);
  assert.equal(paused.status, "paused"); assert.equal(paused.attemptsUsed, 1); assert.equal(paused.best, undefined);
  assert.equal(paused.history[0]?.error, "coding_model_digest_changed");
});

test("closing a Host interrupts a stalled authorization lookup before any metadata or task is admitted", async t => {
  let lookups = 0;
  const { service, open } = await fixture(t, { resolveModel: async () => { lookups++; return digest; } });
  const entered = barrier<void>(), late = barrier<boolean>();
  const started = service.create(spec(), () => { entered.resolve(); return late.promise; });
  await entered.promise; await service.close();
  const refusal = assert.rejects(started, /service_closed/);
  await Promise.race([refusal, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error("stalled after close")), 150); timer.unref(); })]);
  late.resolve(true);
  assert.deepEqual(await open().list(grant), []); assert.equal(lookups, 0);
});
