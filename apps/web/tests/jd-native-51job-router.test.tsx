import assert from "node:assert/strict";
import test from "node:test";
import { createJobSessionRouter, type JobSessionBackend } from "../server/jd-session-router.ts";
import type { BrowserSessionInfo } from "../server/jd-browser-session.ts";
import { JdExtractionError } from "../src/lib/jd-errors.ts";
import { normalizeJobShare } from "../src/lib/jd-source.ts";
import { JD_START_REQUEST_WINDOW_MS } from "../src/lib/jd-start-request.ts";

const inputs = {
  job51: "https://jobs.51job.com/shanghai/166509900.html",
  other51: "https://msearch.51job.com/jobs/all/166761768.html",
  otherDesktop51: "https://jobs.51job.com/shanghai/166509901.html",
  liepin: "https://m.liepin.com/job/1984701079.shtml?mscid=wx_h5_001",
  boss: "https://www.zhipin.com/job_detail/bossFixture.html",
  linkedin: "https://www.linkedin.com/jobs/view/123456789/",
};
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const failure = (code: "job_mismatch" | "browser_session_expired") => new JdExtractionError({ code, stage: "service", message: `fake ${code}` });
const code = (expected: string) => (error: unknown) => error instanceof JdExtractionError && error.failure.code === expected;
const base = Date.now();
const key = (n: number, createdAt = base) => `${createdAt.toString(36)}_00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

function fake(name: string, now: () => number) {
  const pages = new Map<string, { owner: string; active: boolean; info: BrowserSessionInfo }>();
  const calls: string[] = [];
  let starts = 0, closeFailure = false, startWait: Promise<void> | undefined;
  const lookup = (owner: string, id: string) => {
    const page = pages.get(id);
    if (page && page.owner !== owner) throw failure("job_mismatch");
    if (!page || !page.active || Date.parse(page.info.expiresAt) <= now()) throw failure("browser_session_expired");
    return page;
  };
  const backend: JobSessionBackend = {
    async start(owner, input) {
      calls.push("start"); starts++;
      // Deliberately ignore cancellation while gated: the router must drain a
      // late acquired page itself instead of assuming AbortSignal released it.
      if (startWait) await startWait;
      const info = { sessionId: `${name}_${starts}`, ...normalizeJobShare(input), expiresAt: new Date(now() + 600_000).toISOString() };
      pages.set(info.sessionId, { owner, active: true, info });
      return { ...info };
    },
    async read(owner, id, signal) { calls.push(`read:${id}`); signal?.throwIfAborted(); const page = lookup(owner, id); return { text: `${name} complete fixture description`, method: "fake", provenance: { kind: "link", platform: page.info.platform, url: page.info.url, observedAt: new Date(now()).toISOString() } }; },
    async inspect(owner, id, signal) { calls.push(`inspect:${id}`); signal?.throwIfAborted(); lookup(owner, id); throw new Error(`${name} inspection marker`); },
    async focus(owner, id, signal) { calls.push(`focus:${id}`); signal?.throwIfAborted(); lookup(owner, id); return { activationRequested: true }; },
    async extend(owner, id, signal) { calls.push(`extend:${id}`); signal?.throwIfAborted(); const page = lookup(owner, id); page.info.expiresAt = new Date(Math.max(Date.parse(page.info.expiresAt), now() + 600_000)).toISOString(); return { ...page.info }; },
    async close(owner, id) { calls.push(`close:${id}`); const page = pages.get(id); if (page?.owner === owner) { page.active = false; if (closeFailure) throw new Error(`${name} retained close failure`); pages.delete(id); } return { closed: true }; },
    async closeAll() { calls.push("closeAll"); for (const [id, page] of pages) await backend.close(page.owner, id); },
    async stopBrowser(mode = "explicit") { calls.push(`stop:${mode}`); pages.clear(); },
    async recoverExited() { calls.push("recoverExited"); return false; },
    async retryEnded(owner) { calls.push(`retryEnded:${owner}`); for (const [id, page] of pages) if (page.owner === owner && !page.active) await backend.close(owner, id); },
    owns: id => pages.has(id),
    isActive: (owner, id) => { const page = pages.get(id); return page?.owner === owner && page.active && Date.parse(page.info.expiresAt) > now(); },
    hasSession: () => pages.size > 0,
  };
  return { backend, pages, calls, get starts() { return starts; }, failClose(value: boolean) { closeFailure = value; }, waitStart(wait: Promise<void>) { startWait = wait; } };
}

function fixture(native = true) {
  let time = base;
  const engines = { standard: fake("standard", () => time), liepin: fake("nativeLiepin", () => time), boss: fake("nativeBoss", () => time), job51: fake("native51", () => time) };
  const router = createJobSessionRouter(engines.standard.backend, engines.liepin.backend, {
    useNativeLiepin: native, useNativeBoss: native, useNative51Job: native,
    nativeBoss: engines.boss.backend, native51Job: engines.job51.backend, requestOptions: { now: () => time },
  });
  return { router, engines, tick(ms: number) { time += ms; }, now: () => time };
}

test("legacy default selects standard for 51job while explicit flags select three distinct native engines", async () => {
  for (const native of [false, true]) {
    const f = fixture(native);
    for (const [input, engine] of [[inputs.job51, f.engines.job51], [inputs.liepin, f.engines.liepin], [inputs.boss, f.engines.boss], [inputs.linkedin, f.engines.standard]] as const) {
      const selected = native ? engine : f.engines.standard;
      const info = await f.router.start("owner", input);
      assert.equal(selected.pages.has(info.sessionId), true);
      assert.equal(info.url, normalizeJobShare(input).url);
      await f.router.close("owner", info.sessionId);
    }
    assert.equal(f.router.hasSession(), false);
  }
});


test("51job route recovery keeps mobile standard and selects native only for the normalized exact desktop detail URL", async () => {
  const scenarios = [
    { input: inputs.job51, native: true },
    { input: inputs.job51 + '?from=share', native: true },
    { input: 'http://JOBS.51JOB.COM:443/shanghai/166509900.html', native: true },
    { input: inputs.other51, native: false },
    { input: 'https://jobs.51job.com/jobs/all/166761768.html', native: false },
    { input: 'https://jobs.51job.com/jobs/166761768.html', native: false },
    { input: 'https://jobs.51job.com/JOBS/166761768.html', native: false },
    { input: 'https://jobs.51job.com/shanghai/extra/166509900.html', native: false },
    { input: 'https://jobs.51job.com/shanghai/166509900.html/', native: false },
    { input: 'https://jobs.51job.com/shanghai/not-a-number.html', native: false },
    { input: 'https://jobs.51job.com/', native: false },
    { input: 'https://m.51job.com/shanghai/166509900.html', native: false },
    { input: 'https://www.51job.com/shanghai/166509900.html', native: false },
    { input: '分享原岗位 https://www.51job.com/share?url=' + encodeURIComponent(inputs.other51), native: false },
    { input: '分享原岗位 https://www.51job.com/share?url=' + encodeURIComponent(inputs.job51), native: true },
  ];
  for (const scenario of scenarios) for (const action of ['start', 'startRequest'] as const) {
    const f = fixture();
    const info = action === 'start' ? await f.router.start('owner', scenario.input) : await f.router.startRequest('owner', scenario.input, key(100));
    assert.match(info.sessionId, scenario.native ? /^native51_/ : /^standard_/, scenario.input);
    assert.equal(info.url, normalizeJobShare(scenario.input).url);
    assert.equal(f.engines.job51.starts, scenario.native ? 1 : 0); assert.equal(f.engines.standard.starts, scenario.native ? 0 : 1);
    await f.router.close('owner', info.sessionId);
  }
});

test("51job route recovery rejects invalid credentials and nonstandard ports before selecting any backend", async () => {
  for (const input of ['https://user:secret@jobs.51job.com/shanghai/166509900.html', 'https://jobs.51job.com:8443/shanghai/166509900.html']) {
    const f=fixture();
    await assert.rejects(f.router.start('owner',input),code('invalid_link'));
    await assert.rejects(f.router.startRequest('owner',input,key(101)),code('invalid_link'));
    assert.ok(Object.values(f.engines).every(engine=>engine.starts===0));
  }
});

test("51job route recovery dispatches an existing mobile native SID by ownership until it is precisely closed", async () => {
  const f=fixture();
  // Model a page owned before this routing policy was loaded; selection applies
  // only to a new start and must never reinterpret an already owned SID.
  const old=await f.engines.job51.backend.start('owner',inputs.other51);
  assert.match((await f.router.read('owner',old.sessionId)).text,/native51/);
  await assert.rejects(f.router.inspect('owner',old.sessionId),/native51 inspection marker/);
  assert.deepEqual(await f.router.focus('owner',old.sessionId),{activationRequested:true});
  await assert.rejects(f.router.start('owner',inputs.other51),code('browser_unavailable'));
  await f.router.close('owner',old.sessionId);
  assert.equal(f.engines.job51.pages.size,0);
  const current=await f.router.start('owner',inputs.other51);
  assert.match(current.sessionId,/^standard_/);
  assert.equal(f.engines.job51.calls.filter(call=>call=== 'close:'+old.sessionId).length,1);
  await f.router.close('owner',current.sessionId);
});

test("51job route recovery retains standard mobile receipts across idle native flag changes and cannot close a new desktop page", async () => {
  const f=fixture();const oldId=key(102),currentId=key(103);
  const old=await f.router.startRequest('owner',inputs.other51,oldId);assert.match(old.sessionId,/^standard_/);
  await f.router.close('owner',old.sessionId);
  f.router.configure({useNativeLiepin:true,useNative51Job:false});
  f.router.configure({useNativeLiepin:true,useNative51Job:true});
  const current=await f.router.startRequest('owner',inputs.job51,currentId);assert.match(current.sessionId,/^native51_/);
  await assert.rejects(f.router.startRequest('owner',inputs.other51,oldId),code('browser_session_expired'));
  assert.deepEqual(await f.router.cancelStart('owner',inputs.other51,oldId),{cancelled:true,closed:true});
  assert.equal(f.engines.standard.calls.filter(call=>call==='close:'+old.sessionId).length,2);
  assert.equal(f.engines.job51.backend.isActive?.('owner',current.sessionId),true);
  assert.equal(f.engines.job51.calls.some(call=>call.startsWith('close:')),false);
  await f.router.close('owner',current.sessionId);
});

test("51job route recovery does not switch engines after a standard mobile read failure", async () => {
  const f=fixture();f.engines.standard.backend.read=async()=>{throw new Error('fake mobile incomplete description');};
  await assert.rejects(f.router.readOnce('owner',inputs.other51),/fake mobile incomplete description/);
  assert.equal(f.engines.standard.starts,1);assert.equal(f.engines.standard.pages.size,0);
  assert.equal(f.engines.job51.starts,0);assert.equal(f.engines.job51.calls.some(call=>call.startsWith('read:')||call.startsWith('close:')),false);
});

test("missing native 51job cannot fall back, and failed configuration does not apply other flags", async () => {
  const standard = fake("standard", () => base), liepin = fake("liepin", () => base);
  const router = createJobSessionRouter(standard.backend, liepin.backend);
  assert.throws(() => router.configure({ useNativeLiepin: true, useNative51Job: true }), code("browser_unavailable"));
  const old = await router.start("owner", inputs.liepin);
  assert.equal(old.sessionId, "standard_1", "the failed update cannot partially enable native Liepin");
  await router.close("owner", old.sessionId);
  const missing = createJobSessionRouter(standard.backend, liepin.backend, { useNative51Job: true });
  await assert.rejects(missing.start("owner", inputs.job51), code("browser_unavailable"));
  await assert.rejects(missing.startRequest("owner", inputs.job51, key(1)), code("browser_unavailable"));
  assert.equal(standard.starts, 1); assert.equal(liepin.starts, 0);
});

test("native 51job read, inspect, focus, extend and close dispatch by SID ownership and preserve owner checks", async () => {
  const f = fixture(), selected = f.engines.job51;
  const info = await f.router.start("owner", inputs.job51);
  assert.match((await f.router.read("owner", info.sessionId)).text, /native51/);
  await assert.rejects(f.router.inspect("owner", info.sessionId), /native51 inspection marker/);
  assert.deepEqual(await f.router.focus("owner", info.sessionId), { activationRequested: true });
  f.tick(540_000); const extended = await f.router.extend("owner", info.sessionId);
  assert.equal(extended.sessionId, info.sessionId); assert.ok(extended.expiresAt > info.expiresAt);
  for (const action of ["read", "inspect", "focus", "extend"] as const) await assert.rejects(f.router[action]("foreign", info.sessionId), code("job_mismatch"));
  await f.router.close("foreign", info.sessionId);
  assert.equal(selected.backend.isActive?.("owner", info.sessionId), true);
  assert.throws(() => f.router.configure({ useNativeLiepin: true, useNative51Job: false }), code("browser_unavailable"));
  assert.ok([f.engines.standard, f.engines.liepin, f.engines.boss].every(engine => !engine.calls.some(call => /^(?:read|inspect|focus|extend|close):/.test(call))));
  await f.router.close("owner", info.sessionId);
  assert.equal(f.router.owns(info.sessionId), false); assert.equal(selected.pages.size, 0);
});

test("lost native 51job start response and concurrent replay recover one SID and its unchanged TTL", async () => {
  const f = fixture(), gate = deferred(), controller = new AbortController(); f.engines.job51.waitStart(gate.promise);
  const first = f.router.startRequest("owner", inputs.job51, key(2), controller.signal);
  const firstRejected = assert.rejects(first, error => error instanceof DOMException && error.name === "AbortError");
  await turn(); const retry = f.router.startRequest("owner", inputs.job51, key(2));
  controller.abort(new DOMException("lost HTTP waiter", "AbortError")); await firstRejected;
  gate.resolve(); const info = await retry; f.tick(15_000);
  assert.deepEqual(await f.router.startRequest("owner", inputs.job51, key(2)), info);
  assert.equal(f.engines.job51.starts, 1); assert.equal(f.engines.standard.starts, 0);
  assert.equal(f.engines.job51.calls.some(call => call.startsWith("close:")), false);
  await f.router.close("owner", info.sessionId);
});

test("native 51job extension updates the original start-request receipt without relaunch or navigation", async () => {
  const f = fixture(), info = await f.router.startRequest("owner", inputs.job51, key(3));
  f.tick(540_000); const renewed = await f.router.extend("owner", info.sessionId);
  assert.deepEqual(await f.router.startRequest("owner", inputs.job51, key(3)), renewed);
  assert.equal(f.engines.job51.starts, 1); assert.equal(renewed.sessionId, info.sessionId);
  await f.router.close("owner", info.sessionId);
  await assert.rejects(f.router.startRequest("owner", inputs.job51, key(3)), code("browser_session_expired"));
});

test("native 51job failed close retains its owning engine and only same-owner recovery can release it", async () => {
  const f = fixture(), info = await f.router.start("owner", inputs.job51); f.engines.job51.failClose(true);
  await assert.rejects(f.router.close("owner", info.sessionId), /native51 retained close failure/);
  assert.equal(f.router.owns(info.sessionId), true);
  await assert.rejects(f.router.start("foreign", inputs.boss), code("browser_unavailable"));
  assert.equal(f.engines.job51.calls.filter(call => call.startsWith("close:")).length, 1);
  await assert.rejects(f.router.start("owner", inputs.boss), /native51 retained close failure/);
  assert.equal(f.engines.boss.starts, 0);
  assert.throws(() => f.router.configure({ useNativeLiepin: true, useNative51Job: false }), code("browser_unavailable"));
  f.engines.job51.failClose(false); const next = await f.router.start("owner", inputs.boss);
  assert.equal(f.router.owns(info.sessionId), false); assert.match(next.sessionId, /^nativeBoss_/);
  assert.ok(Object.values(f.engines).every(engine => !engine.calls.some(call => call.startsWith("stop:"))));
  await f.router.close("owner", next.sessionId);
});

test("closeAll drains a late acquired native 51job page and every engine before allowing routing changes", async () => {
  const f = fixture(), gate = deferred(); f.engines.job51.waitStart(gate.promise);
  const opening = f.router.start("owner", inputs.job51); const rejected = assert.rejects(opening, code("browser_unavailable"));
  await turn(); assert.equal(f.engines.job51.starts, 1);
  const closing = f.router.closeAll();
  await assert.rejects(f.router.start("owner", inputs.liepin), code("browser_unavailable"));
  assert.throws(() => f.router.configure({ useNativeLiepin: false, useNative51Job: false }), code("browser_unavailable"));
  gate.resolve(); await rejected; await closing;
  assert.equal(f.router.hasSession(), false);
  for (const engine of Object.values(f.engines)) { assert.equal(engine.pages.size, 0); assert.equal(engine.calls.filter(call => call === "closeAll").length, 2); }
  assert.equal(f.engines.job51.calls.filter(call => call.startsWith("close:")).length, 1);
});

test("stop modes reach all four backends even if one stop fails", async () => {
  for (const mode of ["owned-only", "explicit"] as const) {
    const f = fixture(); await f.router.start("owner", inputs.job51);
    f.engines.liepin.backend.stopBrowser = async value => { f.engines.liepin.calls.push(`stop:${value}`); throw new Error("fake stop failed"); };
    await assert.rejects(f.router.stopBrowser(mode), /fake stop failed/);
    for (const engine of Object.values(f.engines)) assert.equal(engine.calls.filter(call => call === `stop:${mode}`).length, 1);
    assert.equal(f.router.hasSession(), false);
  }
});

test("native 51job exit preflight holds the shared reservation until all engines settle and cannot launch after cancellation", async () => {
  const f = fixture(), gate = deferred(); f.engines.job51.backend.recoverExited = async () => { await gate.promise; return false; };
  const controller = new AbortController(), reason = new Error("cancel fake preflight");
  const opening = f.router.start("owner", inputs.boss, controller.signal); const rejected = assert.rejects(opening, error => error === reason);
  await turn(); controller.abort(reason);
  assert.equal(f.router.hasSession(), true);
  await assert.rejects(f.router.start("owner", inputs.job51), code("browser_unavailable"));
  assert.throws(() => f.router.configure({ useNativeLiepin: true, useNative51Job: false }), code("browser_unavailable"));
  gate.resolve(); await rejected;
  assert.equal(f.router.hasSession(), false); assert.ok(Object.values(f.engines).every(engine => engine.starts === 0));
});

test("an ended native 51job request remains bound to its original engine after an idle route switch", async () => {
  const f = fixture(), oldId = key(4), old = await f.router.startRequest("owner", inputs.job51, oldId);
  await f.router.close("owner", old.sessionId);
  f.router.configure({ useNativeLiepin: true, useNative51Job: false });
  const current = await f.router.startRequest("owner", inputs.job51, key(5));
  assert.match(current.sessionId, /^standard_/);
  await assert.rejects(f.router.startRequest("owner", inputs.job51, oldId), code("browser_session_expired"));
  for (const action of ["startRequest", "cancelStart"] as const) {
    await assert.rejects(f.router[action]("foreign", inputs.job51, oldId), code("job_mismatch"));
    await assert.rejects(f.router[action]("owner", inputs.other51, oldId), code("job_mismatch"));
  }
  assert.deepEqual(await f.router.cancelStart("owner", inputs.job51, oldId), { cancelled: true, closed: true });
  assert.equal(f.engines.job51.calls.filter(call => call === `close:${old.sessionId}`).length, 2);
  assert.equal(f.engines.standard.calls.some(call => call.startsWith("close:")), false);
  assert.equal(f.engines.standard.backend.isActive?.("owner", current.sessionId), true);
  assert.equal(f.engines.job51.starts, 1); assert.equal(f.engines.standard.starts, 1);
  await f.router.close("owner", current.sessionId);
});

test("native 51job request binding rejects foreign owners and wrong jobs without closing the active page", async () => {
  const f = fixture(), info = await f.router.startRequest("owner", inputs.job51, key(6));
  for (const action of ["startRequest", "cancelStart"] as const) {
    await assert.rejects(f.router[action]("foreign", inputs.job51, key(6)), code("job_mismatch"));
    await assert.rejects(f.router[action]("owner", inputs.other51, key(6)), code("job_mismatch"));
  }
  await assert.rejects(f.router.startRequest("owner", inputs.otherDesktop51, key(7)), code("browser_unavailable"));
  assert.equal(f.engines.job51.backend.isActive?.("owner", info.sessionId), true);
  assert.deepEqual(await f.router.cancelStart("owner", inputs.otherDesktop51, key(7)), { cancelled: true, closed: false });
  assert.equal(f.engines.job51.calls.some(call => call.startsWith("close:")), false);
  await f.router.close("owner", info.sessionId);
});


test("a mobile cancellation tombstone cannot close a different active native desktop page", async () => {
  const f=fixture(), info=await f.router.startRequest('owner',inputs.job51,key(104));
  await assert.rejects(f.router.startRequest('owner',inputs.other51,key(105)),code('browser_unavailable'));
  assert.deepEqual(await f.router.cancelStart('owner',inputs.other51,key(105)),{cancelled:true,closed:true});
  assert.equal(f.engines.job51.backend.isActive?.('owner',info.sessionId),true);
  assert.equal(f.engines.job51.calls.some(call=>call.startsWith('close:')),false);
  assert.equal(f.engines.standard.starts,0);
  await f.router.close('owner',info.sessionId);
});

test("mobile standard routing does not require a missing native backend for new starts or exact cancellation", async () => {
  const standard=fake('standard',()=>base),liepin=fake('liepin',()=>base);
  const router=createJobSessionRouter(standard.backend,liepin.backend,{useNative51Job:true});
  const info=await router.startRequest('owner',inputs.other51,key(106));assert.match(info.sessionId,/^standard_/);
  assert.deepEqual(await router.cancelStart('owner',inputs.other51,key(106)),{cancelled:true,closed:true});
  assert.equal(standard.pages.size,0);assert.equal(standard.starts,1);
  await assert.rejects(router.startRequest('owner',inputs.job51,key(107)),code('browser_unavailable'));
});

test("native 51job natural TTL and cancellation tombstones never launch another page", async () => {
  const f = fixture(), info = await f.router.startRequest("owner", inputs.job51, key(8));
  f.tick(600_000);
  await assert.rejects(f.router.startRequest("owner", inputs.job51, key(8)), code("browser_session_expired"));
  await assert.rejects(f.router.read("owner", info.sessionId), code("browser_session_expired"));
  await f.router.cancelStart("owner", inputs.job51, key(8));
  const nextId = key(9, f.now());
  assert.deepEqual(await f.router.cancelStart("owner", inputs.job51, nextId), { cancelled: true, closed: true });
  await assert.rejects(f.router.startRequest("owner", inputs.job51, nextId), code("browser_session_expired"));
  await assert.rejects(f.router.startRequest("owner", inputs.job51, key(10, f.now() - JD_START_REQUEST_WINDOW_MS - 1)), code("browser_session_expired"));
  assert.equal(f.engines.job51.starts, 1); assert.equal(f.engines.standard.starts, 0);
});

test("omitted routing flags preserve native 51job, explicit disabling selects standard only for future starts", async () => {
  const f = fixture(); f.router.configure({ useNativeLiepin: false });
  const native = await f.router.start("owner", inputs.job51); assert.match(native.sessionId, /^native51_/);
  await f.router.close("owner", native.sessionId);
  f.router.configure({ useNativeLiepin: false, useNative51Job: false });
  const standard = await f.router.start("owner", inputs.job51); assert.match(standard.sessionId, /^standard_/);
  await f.router.close("owner", standard.sessionId);
  const boss = await f.router.start("owner", inputs.boss); assert.match(boss.sessionId, /^nativeBoss_/);
  await f.router.close("owner", boss.sessionId);
});

test("native 51job readOnce cleans only its own page on extraction failure and does not fall back", async () => {
  const f = fixture(); f.engines.job51.backend.read = async () => { throw new Error("fake incomplete description"); };
  await assert.rejects(f.router.readOnce("owner", inputs.job51), /fake incomplete description/);
  assert.equal(f.engines.job51.starts, 1); assert.equal(f.engines.job51.pages.size, 0);
  assert.ok([f.engines.standard, f.engines.liepin, f.engines.boss].every(engine => engine.starts === 0 && !engine.calls.some(call => call.startsWith("close:"))));
});

test("adding native 51job does not duplicate lifecycle calls when a caller deliberately shares a backend", async () => {
  const common = fake("shared", () => base);
  const router = createJobSessionRouter(common.backend, common.backend, { nativeBoss: common.backend, native51Job: common.backend });
  await router.stopBrowser("owned-only");
  assert.deepEqual(common.calls, ["closeAll", "stop:owned-only"]);
});
