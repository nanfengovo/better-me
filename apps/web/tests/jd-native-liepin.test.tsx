import assert from "node:assert/strict";
import { buildPlatformSearchRequest } from "@better-me/source-adapters/browser-contracts";
import test from "node:test";
import { createNativeLiepinSessions } from "../server/jd-native-liepin.ts";
import { NativeCaptureError, NativePageAcquisitionError, type NativeJobPlatform, type NativeLiepinPage, type NativeCapture } from "../server/jd-native-liepin-browser.ts";
import { JdExtractionError } from "../src/lib/jd-errors.ts";
import type { NetworkOperation } from "../server/network-proxy.ts";
import { createNativeCdp, closeNativeTarget, type NativeCdp } from "../server/jd-native-cdp.ts";

const source = "https://m.liepin.com/job/1984701079.shtml?mscid=wx_h5_001";
const description = "岗位职责：维护企业网络与服务器，记录故障和处理结果，完成完整配置审查。任职要求：熟悉域服务、网络设备和故障排查，能够清晰沟通并编写文档。";
const html = `<title>本地测试工程师</title><link rel="canonical" href="https://www.liepin.com/job/1984701079.shtml"><section class="job-intro-content">${description}</section>`;
const bossSource = "https://m.zhipin.com/mpa/html/weijd/weijd-job/anonymousJob?fromSource=2";
const bossHtml = `<title>本地测试工程师</title><section class="job-sec-text">${description}</section>`;
const job51Source = "https://jobs.51job.com/shanghai/166509900.html";
const job51Html = `<title>本地测试工程师</title><link rel="canonical" href="${job51Source}"><section class="job_msg">${description}</section>`;
const platformSources = { 猎聘: source, BOSS直聘: bossSource, "51JOB": job51Source };
const isFailure = (code: string) => (error: unknown) => error instanceof JdExtractionError && error.failure.code === code;
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
function fixture(platform: NativeJobPlatform = "猎聘") {
  let clock = 1_700_000_000_000; let captures = 0; let releases = 0; let browserStops = 0; let navigations = 0; let closeFails = false; let proxyUrl: string | undefined;
  const initial = { 猎聘: { html, url: "https://www.liepin.com/job/1984701079.shtml" }, BOSS直聘: { html: bossHtml, url: bossSource }, "51JOB": { html: job51Html, url: job51Source } }[platform];
  let snapshot: NativeCapture = { state: "ready", identity: "generation-1", snapshot: { ...initial, title: "本地测试工程师", pageLoad: { readyState: "complete", content: "visible_text", visibleFrames: 0 } } };
  let current = true; let onCapture: ((count: number) => void) | undefined;
  const page: NativeLiepinPage = {
    closed: false, navigate: async () => { navigations++; },
    capture: async () => { captures++; onCapture?.(captures); return structuredClone(snapshot); },
    current: async () => current,
    inspect: () => ({ resources: [], mainDocument: { state: "response", status: 200 }, truncated: false, blockedPopups: 0, blockedSockets: 0, scriptErrors: 0 }),
    focus: async () => undefined,
    release: async () => { releases++; if (closeFails) throw new Error("fixture close failure"); },
  };
  const operation = () => Promise.resolve({ fetch, routeFor: () => ({ mode: "direct", source: "local fixture", proxyUrl }) } as NetworkOperation);
  const manager = createNativeLiepinSessions({ platform, browser: { acquire: async () => page, stop: async () => { browserStops++; } }, getOperation: operation, now: () => clock, sleep: async (ms, signal) => { if (signal?.aborted) throw signal.reason; clock += ms; } });
  return { manager, page, get captures() { return captures; }, get releases() { return releases; }, get browserStops() { return browserStops; }, get navigations() { return navigations; },
    setSnapshot: (value: NativeCapture) => { snapshot = value; }, setCloseFails: (value: boolean) => { closeFails = value; }, setProxy: (value: string) => { proxyUrl = value; }, setCurrent: (value: boolean) => { current = value; }, onCapture: (value: typeof onCapture) => { onCapture = value; }, advance: (ms: number) => { clock += ms; } };
}

const nativeSearchProviders = { 猎聘: "liepin", BOSS直聘: "boss", "51JOB": "51job" } as const;
function searchSnapshot(platform: NativeJobPlatform, url: string): NativeCapture {
  const cardClass = { 猎聘: "job-card-pc-container", BOSS直聘: "job-card-wrapper", "51JOB": "joblist-item" }[platform];
  return { state: "ready", identity: "search-document-1", snapshot: { url, title: "岗位搜索", html: `<div class="${cardClass}"><a class="job-title" href="${platformSources[platform]}">软件工程师</a><span class="company-name">测试公司</span><span class="salary">20-30K</span></div>` } };
}

for (const platform of ["猎聘", "BOSS直聘", "51JOB"] as const) {
  test(`native ${platform} search uses the same owner-bound lease, keeps detail readers separate and confirms fresh identity`, async () => {
    const f = fixture(platform);
    const input = { provider: nativeSearchProviders[platform], keyword: "软件", regionId: "cn-beijing" };
    const planned = buildPlatformSearchRequest(input);
    const capture = f.page.capture;
    f.page.capture = async (...args) => { assert.equal(args[1], 1000); assert.equal(args[2], planned.url); assert.deepEqual(args[3], { purpose: "search" }); return capture(...args); };
    f.setSnapshot(searchSnapshot(platform, planned.url));
    try {
      const info = await f.manager.startSearch("owner", input);
      assert.equal(info.url, planned.url); assert.equal(info.platform, platform); assert.equal(f.navigations, 1);
      await assert.rejects(f.manager.read("owner", info.sessionId), isFailure("unsupported_page"));
      await assert.rejects(f.manager.readSearch("other", info.sessionId), isFailure("browser_session_expired"));
      assert.equal(f.captures, 0);
      await assert.rejects(f.manager.start("owner", platformSources[platform]), isFailure("browser_unavailable"));
      const result = await f.manager.readSearch("owner", info.sessionId);
      assert.equal(result.status, "ready"); assert.equal(result.cards.length, 1); assert.equal(result.cards[0].title, "软件工程师");
      assert.ok(f.captures >= 5); assert.equal(f.navigations, 1); assert.equal(f.releases, 0);
      f.advance(1000); assert.equal((await f.manager.extend("owner", info.sessionId)).sessionId, info.sessionId);
      assert.deepEqual(await f.manager.focus("owner", info.sessionId), { activationRequested: true });
      await f.manager.close("other", info.sessionId); assert.equal(f.manager.hasSession(), true);
      await f.manager.close("owner", info.sessionId); assert.equal(f.releases, 1);
      const detail = await f.manager.start("owner", platformSources[platform]);
      await assert.rejects(f.manager.readSearch("owner", detail.sessionId), isFailure("unsupported_page"));
    } finally { await f.manager.stopBrowser(); }
  });
}

test("native search preserves the page on gates, rejects changed conditions and never accepts stale document receipts", async () => {
  for (const mode of ["gate", "keyword", "region", "stale", "network"] as const) {
    const f = fixture(); const input = { provider: "liepin", keyword: "软件", regionId: "cn-beijing" } as const;
    const planned = buildPlatformSearchRequest(input), snapshot = searchSnapshot("猎聘", planned.url);
    const info = await f.manager.startSearch("owner", input);
    try {
      if (mode === "gate") snapshot.snapshot!.gate = "login_required";
      if (mode === "keyword" || mode === "region") { const url = new URL(planned.url); url.searchParams.set(mode === "keyword" ? "key" : "city", "changed"); snapshot.snapshot!.url = url.href; }
      if (mode === "stale") f.setCurrent(false);
      if (mode === "network") f.setProxy("http://127.0.0.1:1234");
      f.setSnapshot(snapshot);
      await assert.rejects(f.manager.readSearch("owner", info.sessionId), isFailure(mode === "gate" ? "login_required" : mode === "stale" ? "unsupported_page" : mode === "network" ? "browser_unavailable" : "job_mismatch"));
      assert.equal(f.releases, 0); assert.equal(f.manager.isActive("owner", info.sessionId), true);
      if (mode === "network") assert.equal(f.captures, 0);
    } finally { await f.manager.stopBrowser(); }
  }
});

test("cancelled native search capture keeps its lease busy until the command settles and TTL still ends the page", async () => {
  const f = fixture(); const input = { provider: "liepin", keyword: "软件" } as const;
  const planned = buildPlatformSearchRequest(input), ready = searchSnapshot("猎聘", planned.url);
  const entered = deferred<AbortSignal>(), pending = deferred<NativeCapture>();
  f.page.capture = async signal => { entered.resolve(signal); return pending.promise; };
  const info = await f.manager.startSearch("owner", input), cancel = new AbortController();
  try {
    const work = f.manager.readSearch("owner", info.sessionId, cancel.signal); const signal = await entered.promise;
    const rejected = assert.rejects(work, /cancel search/); cancel.abort(new Error("cancel search")); await rejected;
    assert.equal(signal.aborted, true); assert.equal(f.releases, 0);
    await assert.rejects(f.manager.extend("owner", info.sessionId), isFailure("browser_unavailable"));
    pending.resolve(ready); await new Promise(resolve => setImmediate(resolve));
    f.page.capture = async () => structuredClone(ready);
    assert.equal((await f.manager.readSearch("owner", info.sessionId)).status, "ready");
    f.advance(600_000);
    await assert.rejects(f.manager.readSearch("owner", info.sessionId), isFailure("browser_session_expired"));
    await new Promise(resolve => setImmediate(resolve)); assert.equal(f.releases, 1);
  } finally { pending.resolve(ready); await f.manager.stopBrowser(); }
});

test("native extraction carries only the accepted JobPosting publication with unchanged raw precision", async () => {
  for (const platform of ["猎聘", "BOSS直聘", "51JOB"] as const) for (const datePosted of ["2026-09-01T12:34:56.789Z", "2026-09-01"]) {
    const f = fixture(platform);
    const capture = await f.page.capture(new AbortController().signal);
    assert.ok(capture.snapshot);
    const metadata = { "@type": "JobPosting", title: "本地测试工程师", url: platformSources[platform], description, datePosted };
    capture.snapshot.html += `<script type="application/ld+json">${JSON.stringify(metadata)}</script>`;
    f.setSnapshot(capture);
    try {
      const info = await f.manager.start("owner", platformSources[platform]);
      const result = await f.manager.read("owner", info.sessionId);
      assert.equal(result.provenance.sourcePublishedText, datePosted); assert.equal(result.provenance.sourcePublishedAt, datePosted.includes("T") ? datePosted : undefined);
      assert.notEqual(result.provenance.observedAt, datePosted);
    } finally { await f.manager.stopBrowser(); }
  }
});

test("native isActive is an owner-bound synchronous query and TTL expiry never captures or releases", async () => {
  for (const platform of ["猎聘", "BOSS直聘", "51JOB"] as const) {
    const f = fixture(platform);
    try {
      assert.equal(f.manager.isActive("owner", "unknown"), false);
      const info = await f.manager.start("owner", platformSources[platform]);
      const before = { captures: f.captures, releases: f.releases, browserStops: f.browserStops };
      assert.equal(f.manager.isActive("owner", info.sessionId), true);
      assert.equal(f.manager.isActive("other", info.sessionId), false);
      assert.equal(f.manager.isActive("owner", "unknown"), false);
      f.advance(599_999); assert.equal(f.manager.isActive("owner", info.sessionId), true);
      f.advance(1); assert.equal(f.manager.isActive("owner", info.sessionId), false);
      assert.equal(f.manager.owns(info.sessionId), true, "an expired retained record is not an active session");
      assert.deepEqual({ captures: f.captures, releases: f.releases, browserStops: f.browserStops }, before);
    } finally { await f.manager.stopBrowser(); }
  }
});

test("native isActive keeps busy leases live and rejects closed pages or ended records after release failure", async () => {
  const f = fixture(); const entered = deferred<void>(), pending = deferred<NativeCapture>();
  const capture = f.page.capture;
  try {
    const info = await f.manager.start("owner", source);
    f.page.capture = async () => { entered.resolve(); return pending.promise; };
    const inspection = f.manager.inspect("owner", info.sessionId); await entered.promise;
    assert.equal(f.manager.isActive("owner", info.sessionId), true);
    pending.resolve(await capture(new AbortController().signal)); await inspection;
    Object.assign(f.page, { closed: true }); assert.equal(f.manager.isActive("owner", info.sessionId), false);
    Object.assign(f.page, { closed: false }); f.setCloseFails(true);
    await assert.rejects(f.manager.close("owner", info.sessionId));
    assert.equal(f.manager.owns(info.sessionId), true);
    assert.equal(f.manager.isActive("owner", info.sessionId), false);
  } finally { pending.resolve({ state: "failed" }); f.setCloseFails(false); await f.manager.stopBrowser(); }
});

const collapsedForExpansion = (): NativeCapture => ({
  state: "failed", failure: "visibility_unsupported", identity: "folded-original-loader", frameId: "original-frame",
  diagnostic: { stage: "projection", reason: "snapshot_visibility_unsupported", detail: "boss_description_collapsed" },
  expansionPlan: { controlBackendNodeId: 8, descriptionBackendNodeId: 6, hitBackendNodeIds: [8, 9] },
});

test("BOSS inspect stays read-only; read expands once then verifies stable full text and repeated read uses the expanded page", async () => {
  const f = fixture("BOSS直聘"); const ready = await f.page.capture(new AbortController().signal); let clicks = 0;
  f.setSnapshot(collapsedForExpansion());
  f.page.expandDescription = async (signal, url, expected) => {
    assert.equal(signal.aborted, false); assert.equal(url, bossSource); assert.equal(expected, "folded-original-loader");
    clicks++; f.setSnapshot(ready); return true;
  };
  const session = await f.manager.start("owner", bossSource);
  try {
    const inspected = await f.manager.inspect("owner", session.sessionId);
    assert.equal(inspected.snapshotFailure?.detail, "boss_description_collapsed"); assert.equal(clicks, 0);
    await assert.rejects(f.manager.read("other", session.sessionId), isFailure("browser_session_expired")); assert.equal(clicks, 0);
    const result = await f.manager.read("owner", session.sessionId);
    assert.ok(result.text.includes(description)); assert.equal(result.provenance.url, bossSource); assert.equal(clicks, 1);
    assert.ok(f.captures >= 7);
    assert.equal((await f.manager.read("owner", session.sessionId)).text, result.text); assert.equal(clicks, 1);
    assert.equal(f.releases, 0); assert.equal(f.browserStops, 0);
  } finally { await f.manager.stopBrowser(); }
});

test("BOSS read never repeats an ineffective expansion or turns a rejected control into partial text", async () => {
  for (const clicked of [false, true]) {
    const f = fixture("BOSS直聘"); let attempts = 0; f.setSnapshot(collapsedForExpansion());
    f.page.expandDescription = async () => { attempts++; return clicked; };
    const session = await f.manager.start("owner", bossSource);
    try {
      await assert.rejects(f.manager.read("owner", session.sessionId), (error: unknown) => isFailure("unsupported_page")(error) && (error as Error).message.includes("查看全部"));
      assert.equal(attempts, 1); assert.equal(f.releases, 0);
    } finally { await f.manager.stopBrowser(); }
  }
});

test("only a validated BOSS fold plan can invoke expansion, never Liepin, a bare fold diagnosis, or other clipping", async () => {
  for (const kind of ["liepin", "missing_plan", "other_clip"] as const) {
    const f = fixture(kind === "liepin" ? "猎聘" : "BOSS直聘"); let attempts = 0;
    const folded = collapsedForExpansion();
    if (kind === "missing_plan") delete folded.expansionPlan;
    if (kind === "other_clip") folded.diagnostic!.detail = "overflow_clip_or_scroll";
    f.setSnapshot(folded); f.page.expandDescription = async () => { attempts++; return true; };
    const session = await f.manager.start("owner", kind === "liepin" ? source : bossSource);
    try { await assert.rejects(f.manager.read("owner", session.sessionId), isFailure("unsupported_page")); assert.equal(attempts, 0); }
    finally { await f.manager.stopBrowser(); }
  }
});

test("post-click gates and clipping still reject; a click is never proof of complete original text", async () => {
  for (const kind of ["gate", "clip"] as const) {
    const f = fixture("BOSS直聘"); let attempts = 0; f.setSnapshot(collapsedForExpansion());
    f.page.expandDescription = async () => {
      attempts++;
      f.setSnapshot(kind === "gate"
        ? { state: "ready", identity: "post-click-gate", snapshot: { html: "<body>请先登录</body>", url: bossSource, title: "登录", gate: "login_required" } }
        : { state: "failed", failure: "visibility_unsupported", diagnostic: { stage: "projection", reason: "snapshot_visibility_unsupported", detail: "overflow_clip_or_scroll" } });
      return true;
    };
    const session = await f.manager.start("owner", bossSource);
    try { await assert.rejects(f.manager.read("owner", session.sessionId), isFailure(kind === "gate" ? "login_required" : "unsupported_page")); assert.equal(attempts, 1); }
    finally { await f.manager.stopBrowser(); }
  }
});

test("cancelling BOSS expansion aborts the owned operation and never resumes extraction from a late result", async () => {
  const f = fixture("BOSS直聘"); f.setSnapshot(collapsedForExpansion()); const entered = deferred<AbortSignal>(); const completion = deferred<boolean>();
  f.page.expandDescription = async signal => { entered.resolve(signal); return completion.promise; };
  const session = await f.manager.start("owner", bossSource); const cancel = new AbortController();
  try {
    const reading = f.manager.read("owner", session.sessionId, cancel.signal);
    const operation = await entered.promise; const count = f.captures;
    cancel.abort(new Error("cancel owned expansion"));
    await assert.rejects(reading, /cancel owned expansion/); assert.equal(operation.aborted, true); assert.equal(f.releases, 0);
    assert.equal(f.manager.isActive("owner", session.sessionId), true);
    await assert.rejects(f.manager.read("owner", session.sessionId), isFailure("browser_unavailable"));
    completion.resolve(true); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.captures, count); assert.equal(f.manager.owns(session.sessionId), true);
    await f.manager.close("owner", session.sessionId); assert.equal(f.releases, 1);
  } finally { completion.resolve(false); await f.manager.stopBrowser(); }
});

for (const platform of ["猎聘", "BOSS直聘", "51JOB"] as const) {
  for (const action of ["read", "inspect"] as const) {
    for (const interruption of ["cancel", "timeout"] as const) {
      test(`native retained page ${platform} ${action} ${interruption} keeps the same lease busy until capture settles, then retries`, async t => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const f = fixture(platform), entered = deferred<AbortSignal>(), pending = deferred<NativeCapture>();
        const original = f.page.capture, ready = await original(new AbortController().signal);
        const input = platformSources[platform];
        const info = await f.manager.start("owner", input), controller = new AbortController();
        f.page.capture = async signal => { entered.resolve(signal); return pending.promise; };
        try {
          const reading = f.manager[action]("owner", info.sessionId, controller.signal);
          const operation = await entered.promise;
          const rejected = assert.rejects(reading, interruption === "cancel" ? /cancel retained page/ : isFailure("timeout"));
          if (interruption === "cancel") controller.abort(new Error("cancel retained page"));
          else t.mock.timers.tick(action === "read" ? 45_000 : 10_000);
          await rejected;
          assert.equal(operation.aborted, true);
          assert.equal(f.releases, 0, "a bounded operation failure must preserve the live page");
          assert.equal(f.manager.isActive("owner", info.sessionId), true);
          for (const operation of ["read", "inspect", "focus", "extend"] as const) {
            await assert.rejects(f.manager[operation]("owner", info.sessionId), isFailure("browser_unavailable"));
          }
          pending.resolve(ready); await new Promise(resolve => setImmediate(resolve));
          f.page.capture = original;
          assert.equal((await f.manager.inspect("owner", info.sessionId)).pageState, "original_job");
          const result = await f.manager.read("owner", info.sessionId);
          assert.equal(result.provenance.url, input); assert.ok(result.text.includes(description));
          assert.equal(f.releases, 0); assert.equal(f.browserStops, 0);
          assert.equal((await f.manager.extend("owner", info.sessionId)).sessionId, info.sessionId);
        } finally { pending.resolve(ready); await f.manager.stopBrowser(); }
      });
    }
  }
  for (const ending of ["close", "ttl", "stop"] as const) {
    test(`native retained page ${platform} ${ending} still ends a cancelled pending read and its late result cannot revive a successor`, async () => {
      const f = fixture(platform), entered = deferred<void>(), pending = deferred<NativeCapture>();
      const original = f.page.capture, ready = await original(new AbortController().signal);
      const input = platformSources[platform];
      const info = await f.manager.start("owner", input), controller = new AbortController();
      f.page.capture = async () => { entered.resolve(); return pending.promise; };
      try {
        const reading = f.manager.read("owner", info.sessionId, controller.signal); await entered.promise;
        const rejected = assert.rejects(reading, /cancel old pending page/); controller.abort(new Error("cancel old pending page")); await rejected;
        assert.equal(f.releases, 0);
        if (ending === "close") await f.manager.close("owner", info.sessionId);
        else if (ending === "stop") await f.manager.stopBrowser();
        else { f.advance(600_000); await assert.rejects(f.manager.inspect("owner", info.sessionId), isFailure("browser_session_expired")); await new Promise(resolve => setImmediate(resolve)); }
        assert.equal(f.manager.isActive("owner", info.sessionId), false); assert.equal(f.releases, 1);
        f.page.capture = original;
        const next = await f.manager.start("owner", input); assert.notEqual(next.sessionId, info.sessionId);
        const secondEntered = deferred<void>(), secondPending = deferred<NativeCapture>();
        f.page.capture = async () => { secondEntered.resolve(); return secondPending.promise; };
        const inspecting = f.manager.inspect("owner", next.sessionId); await secondEntered.promise;
        pending.resolve(ready); await new Promise(resolve => setImmediate(resolve));
        assert.equal(f.manager.isActive("owner", next.sessionId), true);
        await assert.rejects(f.manager.read("owner", next.sessionId), isFailure("browser_unavailable"));
        secondPending.resolve(ready); await inspecting;
        f.page.capture = original;
        assert.ok((await f.manager.read("owner", next.sessionId)).text.includes(description));
        await assert.rejects(f.manager.read("owner", info.sessionId), isFailure("browser_session_expired"));
        assert.equal(f.releases, 1);
      } finally { pending.resolve(ready); await f.manager.stopBrowser(); }
    });
  }
}
test("native Liepin reads fresh stable visible text, keeps browser on page close, and activates only owned IDs", async () => {
  const f = fixture(); const session = await f.manager.start("owner", source);
  try {
    assert.equal(f.manager.owns(session.sessionId), true); assert.equal(f.manager.hasSession(), true);
    await assert.rejects(f.manager.read("other", session.sessionId), isFailure("browser_session_expired"));
    const result = await f.manager.read("owner", session.sessionId); assert.ok(result.text.includes(description)); assert.equal(result.provenance.url, session.url); assert.ok(f.captures >= 5);
    const firstCount = f.captures; await f.manager.read("owner", session.sessionId); assert.ok(f.captures >= firstCount + 5);
    assert.deepEqual(await f.manager.focus("owner", session.sessionId), { activationRequested: true });
    assert.equal((await f.manager.inspect("owner", session.sessionId)).pageState, "original_job");
    await f.manager.close("other", session.sessionId); assert.equal(f.releases, 0);
    await f.manager.close("owner", session.sessionId); assert.equal(f.releases, 1); assert.equal(f.browserStops, 0); assert.equal(f.manager.hasSession(), false);
  } finally { await f.manager.stopBrowser(); }
});
test("native BOSS uses its own platform identity, extractor and source provenance without borrowing Liepin sessions", async () => {
  const f = fixture("BOSS直聘"); const session = await f.manager.start("owner", bossSource);
  try {
    assert.equal(session.platform, "BOSS直聘"); assert.equal(session.url, bossSource);
    const result = await f.manager.read("owner", session.sessionId);
    assert.ok(result.text.includes(description)); assert.equal(result.provenance.platform, "BOSS直聘"); assert.equal(result.provenance.url, bossSource);
    assert.equal((await f.manager.inspect("owner", session.sessionId)).pageState, "original_job");
    const previous = f.captures; await f.manager.read("owner", session.sessionId); assert.ok(f.captures >= previous + 5);
    await f.manager.close("owner", session.sessionId); assert.equal(f.releases, 1); assert.equal(f.browserStops, 0);
  } finally { await f.manager.stopBrowser(); }
});

test("native BOSS mobile-only projection reaches both inspect and read through the explicit validated selector option", async () => {
  const f = fixture("BOSS直聘"); const requested: Array<string | undefined> = [];
  const capture = f.page.capture;
  f.page.capture = async (...args) => { requested.push(args[2]); return capture(...args); };
  f.setSnapshot({ state: "ready", identity: "validated-mobile-share", snapshot: {
    html: `<title>本地移动测试工程师</title><link rel="canonical" href="${bossSource}"><div class="share-position"><div class="rec-detail"><div class="detail-text show-switch">${description}</div></div><div class="content"><p class="detail-text address">地址不是岗位职责或任职要求。</p></div></div>`,
    url: bossSource, title: "本地移动测试工程师", pageLoad: { readyState: "complete", content: "visible_text", visibleFrames: 0 },
  } });
  const session = await f.manager.start("owner", bossSource);
  try {
    const inspected = await f.manager.inspect("owner", session.sessionId);
    assert.equal(inspected.snapshotState, "ready"); assert.equal(inspected.pageState, "original_job"); assert.equal(inspected.gate, undefined);
    const result = await f.manager.read("owner", session.sessionId);
    assert.equal(result.text, `本地移动测试工程师\n\n${description}`);
    assert.equal(result.provenance.platform, "BOSS直聘"); assert.equal(result.provenance.url, bossSource);
    assert.ok(requested.length >= 6); assert.ok(requested.every(url => url === bossSource));
    assert.equal(f.releases, 0); assert.equal(f.browserStops, 0);
    await f.manager.close("owner", session.sessionId); assert.equal(f.releases, 1); assert.equal(f.browserStops, 0);
  } finally { await f.manager.stopBrowser(); }
});

test("native managers reject the other platform before acquiring and retain independent close and stop ownership", async () => {
  const liepin = fixture(); const boss = fixture("BOSS直聘");
  try {
    await assert.rejects(liepin.manager.start("owner", bossSource), isFailure("invalid_link"));
    await assert.rejects(boss.manager.start("owner", source), isFailure("invalid_link"));
    assert.equal(liepin.manager.hasSession(), false); assert.equal(boss.manager.hasSession(), false);
    const l = await liepin.manager.start("owner", source); const b = await boss.manager.start("owner", bossSource);
    assert.equal(liepin.manager.owns(b.sessionId), false); assert.equal(boss.manager.owns(l.sessionId), false);
    await boss.manager.close("owner", l.sessionId); assert.equal(boss.releases, 0); assert.equal(liepin.releases, 0);
    await boss.manager.stopBrowser(); assert.equal(boss.browserStops, 1); assert.equal(liepin.browserStops, 0);
    assert.equal(liepin.manager.owns(l.sessionId), true); assert.ok((await liepin.manager.read("owner", l.sessionId)).text.includes(description));
  } finally { await liepin.manager.stopBrowser(); await boss.manager.stopBrowser(); }
});

test("native Liepin new validated DD structure reaches both inspect and read with the owned original source", async () => {
  const f = fixture(); const requested: Array<string | undefined> = []; const capture = f.page.capture;
  f.page.capture = async (...args) => { requested.push(args[2]); return capture(...args); };
  const tail = "末尾保留：负责跨地区系统交付、回归验收与运行复盘。";
  const text = `${description}${tail}`;
  f.setSnapshot({ state: "ready", identity: "validated-liepin-dd", snapshot: {
    html: `<title>本地猎聘工程师</title><link rel="canonical" href="${source}"><section class="job-intro-container"><dl class="paragraph"><dt>职位描述：</dt><dd class="description-body">${text}</dd></dl><dl class="paragraph ellipsis"><dt>工作地址</dt><dd>${"地址不能替代职责。".repeat(8)}</dd></dl></section>`,
    url: "https://www.liepin.com/job/1984701079.shtml", title: "本地猎聘工程师", pageLoad: { readyState: "complete", content: "visible_text", visibleFrames: 0 },
  } });
  const session = await f.manager.start("owner", source);
  try {
    const inspected = await f.manager.inspect("owner", session.sessionId);
    assert.equal(inspected.snapshotState, "ready"); assert.equal(inspected.pageState, "original_job"); assert.equal(inspected.gate, undefined);
    const result = await f.manager.read("owner", session.sessionId);
    assert.equal(result.text, `本地猎聘工程师\n\n${text}`); assert.doesNotMatch(result.text, /工作地址|地址不能/);
    assert.equal(result.provenance.platform, "猎聘"); assert.equal(result.provenance.url, source);
    assert.ok(requested.length >= 6); assert.ok(requested.every(url => url === source));
    assert.equal(f.releases, 0); assert.equal(f.browserStops, 0);
    await f.manager.close("owner", session.sessionId); assert.equal(f.releases, 1); assert.equal(f.browserStops, 0);
  } finally { await f.manager.stopBrowser(); }
});

test("native Liepin inspect and read do not turn address paragraphs or independent descriptions into one original job", async () => {
  for (const kind of ["address", "independent", "canonical_conflict"] as const) {
    const f = fixture(); const original = `<dl class="paragraph"><dt>职位描述</dt><dd>${description}</dd></dl>`;
    const other = "另一岗位负责市场活动、销售客户管理、报价与业务培训，要求独立分析渠道数据并完成年度经营目标。";
    const contents = kind === "address" ? original.replace("职位描述", "工作地址") : kind === "independent" ? original + `<dl class="paragraph"><dt>岗位职责</dt><dd>${other}</dd></dl>` : original;
    const canonical = kind === "canonical_conflict" ? `<link rel="canonical" href="${source.replace("1984701079", "1984701080")}">` : "";
    f.setSnapshot({ state: "ready", identity: kind, snapshot: { html: `<title>本地猎聘工程师</title>${canonical}<section class="job-intro-container">${contents}</section>`, url: source, title: "本地猎聘工程师" } });
    const session = await f.manager.start("owner", source);
    try {
      assert.equal((await f.manager.inspect("owner", session.sessionId)).pageState, "unknown");
      await assert.rejects(f.manager.read("owner", session.sessionId), isFailure(kind === "independent" ? "ambiguous_jobs" : kind === "canonical_conflict" ? "job_mismatch" : "unsupported_page"));
      assert.equal(f.manager.owns(session.sessionId), true); assert.equal(f.releases, 0); assert.equal(f.browserStops, 0);
    } finally { await f.manager.stopBrowser(); }
  }
});

test("native inspection and repeated reads bind capture scope to the owned original URL", async () => {
  const f = fixture("BOSS直聘"); const requested: Array<string | undefined> = [];
  const capture = f.page.capture;
  f.page.capture = async (...args) => { requested.push(args[2]); return capture(...args); };
  const session = await f.manager.start("owner", bossSource);
  try {
    await f.manager.inspect("owner", session.sessionId);
    await f.manager.read("owner", session.sessionId);
    assert.ok(requested.length >= 6);
    assert.ok(requested.every(url => url === bossSource));
  } finally { await f.manager.stopBrowser(); }
});

test("native BOSS reports known verification URLs and visible login evidence while preserving the owned page", async () => {
  const f = fixture("BOSS直聘"); const session = await f.manager.start("owner", bossSource);
  try {
    f.setSnapshot({ state: "ready", identity: "known-verification", snapshot: { html: "<html><body></body></html>", url: "https://m.zhipin.com/web/common/security-check.html", title: "" } });
    await assert.rejects(f.manager.read("owner", session.sessionId), isFailure("verification_required"));
    assert.equal((await f.manager.inspect("owner", session.sessionId)).gate, "verification_required");
    const title = "【BOSS直聘注册登录】boss直聘在线注册登录-BOSS直聘";
    const loginUrl = "https://www.zhipin.com/web/user/";
    f.setSnapshot({ state: "ready", identity: "visible-login", snapshot: { html: `<html><head><title>${title}</title></head><body>手机号 验证码 短信登录</body></html>`, url: loginUrl, title } });
    await assert.rejects(f.manager.read("owner", session.sessionId), isFailure("login_required"));
    assert.equal((await f.manager.inspect("owner", session.sessionId)).gate, "login_required");
    f.setSnapshot({ state: "ready", identity: "hidden-login-only", snapshot: { html: `<html><head><title>${title}</title></head><body><div hidden>手机号 验证码 短信登录</div></body></html>`, url: loginUrl, title } });
    assert.equal((await f.manager.inspect("owner", session.sessionId)).gate, undefined);
    await assert.rejects(f.manager.read("owner", session.sessionId), isFailure("unsupported_page"));
    assert.equal(f.releases, 0); assert.equal(f.manager.owns(session.sessionId), true);
  } finally { await f.manager.stopBrowser(); }
});

test("native BOSS rejects cross-platform and wrong-job content and clears stability after navigation", async () => {
  const f = fixture("BOSS直聘"); const session = await f.manager.start("owner", bossSource);
  try {
    f.setSnapshot({ state: "ready", identity: "foreign-platform", snapshot: { html, url: source, title: "本地测试工程师" } });
    await assert.rejects(f.manager.read("owner", session.sessionId), isFailure("unsupported_page"));
    assert.equal((await f.manager.inspect("owner", session.sessionId)).pageState, "unknown");
    f.setSnapshot({ state: "ready", identity: "wrong-job", snapshot: { html: bossHtml, url: "https://m.zhipin.com/mpa/html/weijd/weijd-job/differentJob", title: "本地测试工程师" } });
    await assert.rejects(f.manager.read("owner", session.sessionId), isFailure("job_mismatch"));
    assert.equal((await f.manager.inspect("owner", session.sessionId)).pageState, "different_job");
    f.setSnapshot({ state: "ready", identity: "original-again", snapshot: { html: bossHtml, url: bossSource, title: "本地测试工程师" } });
    const began = f.captures;
    f.onCapture((count) => {
      if (count === began + 4) f.setSnapshot({ state: "navigation_in_progress" });
      if (count === began + 5) f.setSnapshot({ state: "ready", identity: "after-navigation", snapshot: { html: bossHtml, url: bossSource, title: "本地测试工程师" } });
    });
    await f.manager.read("owner", session.sessionId); assert.ok(f.captures >= began + 9);
    f.setCurrent(false); await assert.rejects(f.manager.read("owner", session.sessionId), isFailure("unsupported_page"));
    f.setProxy("http://127.0.0.1:12345"); await assert.rejects(f.manager.read("owner", session.sessionId), isFailure("browser_unavailable"));
    assert.equal(f.releases, 0);
  } finally { await f.manager.stopBrowser(); }
});

test("native gate stays open and is reported before empty-body adoption", async () => {
  const f = fixture(); const session = await f.manager.start("owner", source);
  try {
    f.setSnapshot({ state: "ready", identity: "gate", snapshot: { html: "<body></body>", url: session.url, title: "", gate: "verification_required", pageLoad: { readyState: "complete", content: "empty", visibleFrames: 0 } } });
    await assert.rejects(f.manager.read("owner", session.sessionId), isFailure("verification_required")); assert.equal(f.releases, 0); assert.equal(f.manager.owns(session.sessionId), true);
    assert.equal((await f.manager.inspect("owner", session.sessionId)).gate, "verification_required");
  } finally { await f.manager.stopBrowser(); }
});

test("native 51JOB keeps the exact desktop source, rejects another job and preserves verification transport evidence without re-navigation", async () => {
  const f = fixture("51JOB"); const info = await f.manager.start("owner", job51Source);
  try {
    const text = await f.manager.read("owner", info.sessionId);
    assert.ok(text.text.includes(description)); assert.equal(text.provenance.platform, "51JOB"); assert.equal(text.provenance.url, job51Source);
    assert.equal((await f.manager.inspect("owner", info.sessionId)).pageState, "original_job");
    const inspectPage = f.page.inspect;
    const verificationNetwork = { requests: [{ id: 1, host: "device.captcha-open.aliyuncs.com", type: "xhr" as const }], events: [{ requestId: 1, phase: "request" as const, atMs: 0 }, { requestId: 1, phase: "response" as const, atMs: 10, status: 200 }], truncated: false };
    f.page.inspect = () => ({ ...inspectPage(), verificationNetwork: structuredClone(verificationNetwork) });
    f.setSnapshot({ state: "ready", identity: "verification", snapshot: { html: '<html><head><meta name="aliyun_waf"></head><body></body></html>', url: job51Source, title: "访问验证", gate: "verification_required" } });
    const gated = await f.manager.inspect("owner", info.sessionId);
    assert.equal(gated.gate, "verification_required"); assert.deepEqual(gated.verificationNetwork, verificationNetwork);
    await assert.rejects(f.manager.read("owner", info.sessionId), isFailure("verification_required"));
    const other = job51Source.replace("166509900", "166509901");
    f.setSnapshot({ state: "ready", identity: "other-job", snapshot: { html: job51Html.replaceAll(job51Source, other), url: other, title: "另一个岗位" } });
    assert.equal((await f.manager.inspect("owner", info.sessionId)).pageState, "different_job");
    await assert.rejects(f.manager.read("owner", info.sessionId), isFailure("job_mismatch"));
    assert.equal(f.releases, 0); assert.equal(f.navigations, 1); assert.equal(f.manager.isActive("owner", info.sessionId), true);
  } finally { await f.manager.stopBrowser(); }
});
test("native failed close retains ownership and blocks new start until same-ID retry confirms", async () => {
  const f = fixture(); const session = await f.manager.start("owner", source); f.setCloseFails(true);
  await assert.rejects(f.manager.close("owner", session.sessionId)); assert.equal(f.manager.owns(session.sessionId), true);
  await assert.rejects(f.manager.start("owner", source), isFailure("browser_unavailable"));
  f.setCloseFails(false); await f.manager.close("owner", session.sessionId); assert.equal(f.manager.owns(session.sessionId), false); await f.manager.stopBrowser();
});

test("native ended recovery preserves active and foreign leases, retains repeated failures and releases only its ended owner", async () => {
  for (const platform of ["猎聘", "BOSS直聘", "51JOB"] as const) {
    const f = fixture(platform); const session = await f.manager.start("owner", platformSources[platform]);
    try {
      f.setSnapshot({ state: "ready", identity: "gate", snapshot: { html: "", url: session.url, title: "", gate: "verification_required" } });
      await assert.rejects(f.manager.read("owner", session.sessionId), isFailure("verification_required"));
      await f.manager.retryEnded("owner"); assert.equal(f.releases, 0);
      assert.equal(f.manager.owns(session.sessionId), true);
      f.setCloseFails(true); await assert.rejects(f.manager.close("owner", session.sessionId));
      await f.manager.retryEnded("other"); assert.equal(f.releases, 1);
      await assert.rejects(f.manager.retryEnded("owner"), /fixture close failure/);
      assert.equal(f.manager.owns(session.sessionId), true); assert.equal(f.releases, 2);
      f.setCloseFails(false); await f.manager.retryEnded("owner");
      assert.equal(f.manager.owns(session.sessionId), false); assert.equal(f.manager.hasSession(), false);
      assert.equal(f.releases, 3); assert.equal(f.browserStops, 0);
      await f.manager.retryEnded("owner"); assert.equal(f.releases, 3);
    } finally { f.setCloseFails(false); await f.manager.closeAll(); }
  }
});
test("native wrong-job and changed network reject while preserving the current owned page", async () => {
  const f = fixture(); const session = await f.manager.start("owner", source);
  try {
    f.setSnapshot({ state: "ready", identity: "other", snapshot: { html, url: "https://www.liepin.com/job/1999999999.shtml", title: "" } });
    await assert.rejects(f.manager.read("owner", session.sessionId), isFailure("job_mismatch"));
    f.setProxy("http://127.0.0.1:12345"); await assert.rejects(f.manager.read("owner", session.sessionId), isFailure("browser_unavailable")); assert.equal(f.releases, 0);
  } finally { await f.manager.stopBrowser(); }
});
test("native navigation-pending cannot reuse a prior stability window", async () => {
  const f = fixture(); const session = await f.manager.start("owner", source);
  try {
    f.onCapture((count) => { if (count === 4) f.setSnapshot({ state: "navigation_in_progress" }); if (count === 5) f.setSnapshot({ state: "ready", identity: "new-loader", snapshot: { html, url: session.url, title: "" } }); });
    await f.manager.read("owner", session.sessionId); assert.ok(f.captures >= 9);
  } finally { await f.manager.stopBrowser(); }
});
test("native adoption rechecks current navigation and never returns a stale successful extraction", async () => {
  const f = fixture(); const session = await f.manager.start("owner", source);
  try { f.setCurrent(false); await assert.rejects(f.manager.read("owner", session.sessionId), isFailure("unsupported_page")); assert.equal(f.releases, 0); }
  finally { await f.manager.stopBrowser(); }
});
test("native cancellation releases only its late acquired page and keeps single-start reservation", async () => {
  const f = fixture(); const acquired = deferred<NativeLiepinPage>(); const controller = new AbortController();
  const manager = createNativeLiepinSessions({ browser: { acquire: () => acquired.promise, stop: async () => undefined }, getOperation: async () => ({ fetch, routeFor: () => ({ mode: "direct", source: "fixture" }) }) });
  const starting = manager.start("owner", source, controller.signal);
  await new Promise((resolve) => setImmediate(resolve)); controller.abort(new Error("fixture cancel")); await assert.rejects(starting);
  await manager.retryEnded("owner");
  assert.equal(manager.hasSession(), true); await assert.rejects(manager.start("owner", source), isFailure("browser_unavailable"));
  acquired.resolve(f.page); await manager.closeAll(); assert.ok(f.releases >= 1); assert.equal(manager.hasSession(), false); await manager.stopBrowser();
});
test("native TTL expiry and explicit stop retain existing API ownership semantics", async () => {
  const f = fixture(); const session = await f.manager.start("owner", source); f.advance(600_001);
  await assert.rejects(f.manager.inspect("owner", session.sessionId), isFailure("browser_session_expired"));
  await f.manager.stopBrowser(); assert.equal(f.manager.hasSession(), false); assert.equal(f.browserStops, 1);
});

test("native TTL callback releases its page then reads a fresh session in the same browser", async () => {
  const f = fixture(); let expire: (() => void) | undefined; let acquisitions = 0; let stops = 0;
  let clock = 1_700_000_000_000;
  const manager = createNativeLiepinSessions({
    browser: { acquire: async () => { acquisitions++; return f.page; }, stop: async () => { stops++; } },
    getOperation: async () => ({ fetch, routeFor: () => ({ mode: "direct", source: "fixture" }) }),
    now: () => clock, sleep: async ms => { clock += ms; },
    setTimer: ((callback: () => void, ms: number) => { assert.equal(ms, 600_000); expire = callback; return { unref() {} }; }) as unknown as typeof setTimeout,
    clearTimer: (() => undefined) as typeof clearTimeout,
  });
  try {
    const first = await manager.start("owner", source);
    assert.ok(expire); expire(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(manager.owns(first.sessionId), false); assert.equal(manager.hasSession(), false);
    assert.equal(f.releases, 1); assert.equal(stops, 0);
    const second = await manager.start("owner", source);
    assert.notEqual(second.sessionId, first.sessionId);
    assert.equal((await manager.read("owner", second.sessionId)).provenance.url, source);
    assert.equal(acquisitions, 2); assert.equal(stops, 0);
    await manager.close("owner", second.sessionId);
  } finally { await manager.stopBrowser(); }
});

test("native confirmed browser exit clears stale leases but disconnection alone preserves ownership", async () => {
  const f = fixture(); let confirmed = false; let closed = false; let clock = Date.now();
  const page: NativeLiepinPage = { ...f.page, get closed() { return closed; }, release: async () => { if (!confirmed && closed) throw new Error("disconnected fixture"); } };
  const manager = createNativeLiepinSessions({
    browser: { acquire: async () => page, stop: async () => undefined, recoverExited: async () => confirmed },
    getOperation: async () => ({ fetch, routeFor: () => ({ mode: "direct", source: "fixture" }) }),
    now: () => clock, sleep: async ms => { clock += ms; },
  });
  try {
    const first = await manager.start("owner", source); closed = true;
    await assert.rejects(manager.read("owner", first.sessionId), isFailure("browser_session_expired"));
    assert.equal(await manager.recoverExited(), false); assert.equal(manager.owns(first.sessionId), true);
    await assert.rejects(manager.close("owner", first.sessionId), /disconnected fixture/);
    await assert.rejects(manager.start("owner", source), isFailure("browser_unavailable"));
    confirmed = true; assert.equal(await manager.recoverExited(), true);
    assert.equal(manager.owns(first.sessionId), false); assert.equal(manager.hasSession(), false);
    closed = false;
    const second = await manager.start("owner", source);
    assert.equal((await manager.read("owner", second.sessionId)).provenance.url, source);
    await manager.close("owner", second.sessionId);
  } finally { await manager.stopBrowser(); }
});

test("native exit recovery retains a single reservation while proof is pending and refuses to supersede active work", async () => {
  const f = fixture(); const proof = deferred<boolean>(); let proofs = 0;
  const manager = createNativeLiepinSessions({
    browser: { acquire: async () => f.page, stop: async () => undefined, recoverExited: async () => { proofs++; return proof.promise; } },
    getOperation: async () => ({ fetch, routeFor: () => ({ mode: "direct", source: "fixture" }) }),
  });
  const recovery = manager.recoverExited(); assert.equal(manager.hasSession(), true);
  assert.equal(manager.recoverExited(), recovery); assert.equal(proofs, 1);
  await assert.rejects(manager.start("owner", source), isFailure("browser_unavailable"));
  proof.resolve(false); assert.equal(await recovery, false); assert.equal(manager.hasSession(), false);
  const acquired = deferred<void>(); f.page.focus = () => acquired.promise;
  const session = await manager.start("owner", source);
  const focus = manager.focus("owner", session.sessionId); await new Promise(resolve => setImmediate(resolve));
  assert.equal(await manager.recoverExited(), false); assert.equal(proofs, 1);
  acquired.resolve(); await focus; await manager.stopBrowser();
});

test("native BOSS expansion guidance is limited to the confirmed folded-description diagnostic", async () => {
  const f = fixture("BOSS直聘"); const session = await f.manager.start("owner", bossSource);
  try {
    for (const detail of ["boss_description_collapsed", "transform", "overflow_clip_or_scroll"] as const) {
      f.setSnapshot({ state: "failed", failure: "visibility_unsupported", diagnostic: { stage: "projection", reason: "snapshot_visibility_unsupported", detail } });
      const inspection = await f.manager.inspect("owner", session.sessionId);
      assert.equal(inspection.snapshotFailure?.detail, detail);
      await assert.rejects(f.manager.read("owner", session.sessionId), (error: unknown) => {
        assert.ok(error instanceof JdExtractionError); assert.equal(error.failure.code, "unsupported_page");
        assert.equal(error.message.includes("查看全部"), detail === "boss_description_collapsed"); return true;
      });
    }
    assert.equal(f.releases, 0);
  } finally { await f.manager.stopBrowser(); }
});
test("native failed configuration retains its failed page reservation until closeAll or explicit stop", async () => {
  const f = fixture(); f.setCloseFails(true);
  const manager = createNativeLiepinSessions({ browser: { acquire: async () => { throw new NativePageAcquisitionError(f.page); }, stop: async () => undefined }, getOperation: async () => ({ fetch, routeFor: () => ({ mode: "direct", source: "fixture" }) }) });
  await assert.rejects(manager.start("owner", source)); assert.equal(manager.hasSession(), true);
  await assert.rejects(manager.start("owner", source), isFailure("browser_unavailable"));
  f.setCloseFails(false); await manager.closeAll(); assert.equal(manager.hasSession(), false); await manager.stopBrowser();
});
test("native focus cancellation preserves the page and keeps busy until the activation settles", async () => {
  const f = fixture(); const activated = deferred<void>(); f.page.focus = () => activated.promise;
  const session = await f.manager.start("owner", source); const controller = new AbortController();
  const focusing = f.manager.focus("owner", session.sessionId, controller.signal); await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error("fixture cancelled activation")); await assert.rejects(focusing); assert.equal(f.releases, 0); assert.equal(f.manager.owns(session.sessionId), true);
  await assert.rejects(f.manager.focus("owner", session.sessionId), isFailure("browser_unavailable"));
  activated.resolve(); await new Promise((resolve) => setImmediate(resolve)); await f.manager.close("owner", session.sessionId);
});
test("native blank inspection uses safe empty state and visibility rejection has explicit guidance", async () => {
  const f = fixture(); const session = await f.manager.start("owner", source);
  try {
    f.setSnapshot({ state: "ready", identity: "blank", snapshot: { html: "<html><body></body></html>", url: "about:blank", title: "", pageLoad: { readyState: "complete", content: "empty", visibleFrames: 0 } } });
    assert.equal((await f.manager.inspect("owner", session.sessionId)).pageState, "blank");
    await assert.rejects(f.manager.read("owner", session.sessionId), isFailure("unsupported_page"));
    f.setSnapshot({ state: "failed", failure: "visibility_unsupported" });
    await assert.rejects(f.manager.read("owner", session.sessionId), (error: unknown) => isFailure("unsupported_page")(error) && (error as Error).message.includes("裁剪"));
  } finally { await f.manager.stopBrowser(); }
});
test("native inspect discards a gate if navigation changes before returning the result", async () => {
  const f = fixture(); const session = await f.manager.start("owner", source);
  try {
    f.setSnapshot({ state: "ready", identity: "old", snapshot: { html: "<body></body>", url: session.url, title: "", gate: "verification_required" } }); f.setCurrent(false);
    const result = await f.manager.inspect("owner", session.sessionId); assert.equal(result.snapshotState, "navigation_in_progress"); assert.equal(result.gate, undefined);
  } finally { await f.manager.stopBrowser(); }
});
test("native inspect returns only fixed capture diagnostics and does not retain an earlier failed capture", async () => {
  const f = fixture(); const session = await f.manager.start("owner", source);
  try {
    f.setSnapshot({ state: "failed", failure: "visibility_unsupported", diagnostic: { stage: "projection", reason: "snapshot_visibility_unsupported", detail: "overflow_clip_or_scroll", raw: "PRIVATE_DOM_OR_URL" } as NonNullable<NativeCapture["diagnostic"]> });
    const failed = await f.manager.inspect("owner", session.sessionId);
    assert.equal(failed.snapshotState, "failed"); assert.equal(failed.pageState, "unknown"); assert.equal(failed.gate, undefined);
    assert.deepEqual(failed.snapshotFailure, { stage: "projection", reason: "snapshot_visibility_unsupported", detail: "overflow_clip_or_scroll" });
    assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_DOM_OR_URL|raw/);
    await assert.rejects(f.manager.read("owner", session.sessionId), isFailure("unsupported_page")); assert.equal(f.releases, 0);
    f.setSnapshot({ state: "navigation_in_progress", diagnostic: { stage: "projection", reason: "document_body_missing" } });
    assert.deepEqual((await f.manager.inspect("owner", session.sessionId)).snapshotFailure, { stage: "projection", reason: "document_body_missing" });
    f.setSnapshot({ state: "ready", identity: "recovered", snapshot: { html, url: session.url, title: "本地测试工程师" } });
    const recovered = await f.manager.inspect("owner", session.sessionId);
    assert.equal(recovered.pageState, "original_job"); assert.equal(recovered.snapshotFailure, undefined);
  } finally { await f.manager.stopBrowser(); }
});

test("native capture protocol errors keep the read failure category while inspect reports fixed diagnostics", async () => {
  const f = fixture(); const session = await f.manager.start("owner", source);
  try {
    const priorFailure = new JdExtractionError({ code: "browser_unavailable", stage: "service", message: "浏览器操作超时，尚未确认操作结果。" });
    f.page.capture = async () => { throw new NativeCaptureError(priorFailure, { stage: "capture", reason: "protocol_unavailable" }); };
    await assert.rejects(f.manager.read("owner", session.sessionId), (error: unknown) => error instanceof JdExtractionError && error.failure.code === priorFailure.failure.code && error.failure.message === priorFailure.failure.message);
    const result = await f.manager.inspect("owner", session.sessionId);
    assert.equal(result.snapshotState, "failed"); assert.equal(result.pageState, "unknown");
    assert.deepEqual(result.snapshotFailure, { stage: "capture", reason: "protocol_unavailable" }); assert.equal(f.releases, 0);
    const unsafe = new NativeCaptureError(new Error("PRIVATE_REMOTE_MESSAGE"), { stage: "document_state", reason: "network_unavailable" });
    assert.doesNotMatch(JSON.stringify(unsafe.failure), /PRIVATE_REMOTE_MESSAGE/);
    f.page.verifyNetwork = async () => { throw unsafe; };
    const network = await f.manager.inspect("owner", session.sessionId);
    assert.deepEqual(network.snapshotFailure, { stage: "document_state", reason: "network_unavailable" });
    await assert.rejects(f.manager.read("owner", session.sessionId), isFailure("browser_unavailable"));
  } finally { await f.manager.stopBrowser(); }
});

test("native inspect does not swallow unknown exceptions or cancellation as a successful diagnostic", async () => {
  const f = fixture(); const session = await f.manager.start("owner", source);
  try {
    const unexpected = new Error("fixture unexpected error");
    f.page.capture = async () => { throw unexpected; };
    await assert.rejects(f.manager.inspect("owner", session.sessionId), (error: unknown) => error === unexpected);
    const controller = new AbortController(); const cancelled = new Error("fixture cancelled inspection");
    f.page.capture = async () => { controller.abort(cancelled); throw new NativeCaptureError(new Error("PRIVATE_REMOTE_MESSAGE"), { stage: "capture", reason: "protocol_unavailable" }); };
    await assert.rejects(f.manager.inspect("owner", session.sessionId, controller.signal), (error: unknown) => error === cancelled);
  } finally { await f.manager.stopBrowser(); }
});

test("native protocol rejects Runtime enable/evaluation and Console/Log, and never returns remote error details", async () => {
  class Socket extends EventTarget {
    readyState = 1; sent: string[] = [];
    send(text: string) { this.sent.push(text); }
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  const socket = new Socket(); const cdp = createNativeCdp(socket);
  for (const method of ["Runtime.enable", "Runtime.evaluate", "Runtime.callFunctionOn", "Runtime.runIfWaitingForDebugger", "Console.enable", "Log.enable"]) await assert.rejects(cdp.send(method), isFailure("browser_unavailable"));
  assert.equal(socket.sent.length, 0);
  const pending = cdp.send("Page.getFrameTree"); const { id } = JSON.parse(socket.sent[0]!);
  socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id, error: { code: -32000, message: "PRIVATE_REMOTE_VALUE" } }) }));
  await assert.rejects(pending, (error: unknown) => error instanceof Error && !error.message.includes("PRIVATE_REMOTE_VALUE")); cdp.close();
});
test("native root document protocol permits only fixed top-level reads on attached sessions", async () => {
  class Socket extends EventTarget {
    readyState = 1; sent: string[] = [];
    send(text: string) { this.sent.push(text); }
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
    receive(message: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) })); }
  }
  const socket = new Socket(); const cdp = createNativeCdp(socket);
  const fixed = { depth: 0, pierce: false };
  const reply = (result: unknown) => { const { id } = JSON.parse(socket.sent.at(-1)!); socket.receive({ id, result }); };
  const read = async (session = "owned-session") => {
    const pending = cdp.send("DOM.getDocument", fixed, session);
    assert.deepEqual(JSON.parse(socket.sent.at(-1)!).params, fixed);
    reply({ root: { nodeType: 9, backendNodeId: 1, compatibilityMode: "NoQuirksMode" } });
    assert.equal((await pending).root !== undefined, true);
  };
  try {
    for (const session of [undefined, "owned-session"]) await assert.rejects(cdp.send("DOM.getDocument", fixed, session), isFailure("browser_unavailable"));
    socket.receive({ method: "Target.attachedToTarget", params: { sessionId: "malformed-session", targetInfo: null } });
    await assert.rejects(cdp.send("DOM.getDocument", fixed, "malformed-session"), isFailure("browser_unavailable"));
    assert.equal(socket.sent.length, 0);
    const attach = cdp.send("Target.attachToTarget", { targetId: "owned-target", flatten: true });
    // Dispatching attach is insufficient until the browser confirms its session.
    await assert.rejects(cdp.send("DOM.getDocument", fixed, "owned-session"), isFailure("browser_unavailable"));
    reply({ sessionId: "owned-session" }); await attach;
    await read();
    for (const params of [{}, { depth: 0 }, { pierce: false }, { depth: 1, pierce: false }, { depth: -1, pierce: false }, { depth: 0, pierce: true }, { depth: "0", pierce: false }, { depth: 0, pierce: false, includeWhitespace: "all" }]) {
      const count = socket.sent.length;
      await assert.rejects(cdp.send("DOM.getDocument", params, "owned-session"), isFailure("browser_unavailable"));
      assert.equal(socket.sent.length, count);
    }
    for (const method of ["DOM.enable", "DOM.getNodeForLocation", "DOM.requestNode", "Runtime.enable", "Runtime.evaluate"]) await assert.rejects(cdp.send(method, fixed, "owned-session"), isFailure("browser_unavailable"));
    socket.receive({ method: "Target.detachedFromTarget", params: { sessionId: "owned-session" } });
    await assert.rejects(cdp.send("DOM.getDocument", fixed, "owned-session"), isFailure("browser_unavailable"));
    socket.receive({ method: "Target.attachedToTarget", params: { sessionId: "event-session", targetInfo: { targetId: "event-target" } } });
    await read("event-session");
    socket.receive({ method: "Target.targetDestroyed", params: { targetId: "event-target" } });
    await assert.rejects(cdp.send("DOM.getDocument", fixed, "event-session"), isFailure("browser_unavailable"));
    socket.receive({ method: "Target.attachedToTarget", params: { sessionId: "detached-by-command", targetInfo: { targetId: "other-target" } } });
    const detach = cdp.send("Target.detachFromTarget", { sessionId: "detached-by-command" }); reply({}); await detach;
    await assert.rejects(cdp.send("DOM.getDocument", fixed, "detached-by-command"), isFailure("browser_unavailable"));
  } finally { cdp.close(); }
});

test("native target close waits for actual disappearance and base survival independently of acceptance", async () => {
  for (const mode of ["delayed", "false_gone", "still_present", "base_missing"]) {
    let queries = 0; let closes = 0;
    const cdp = { connected: true, async send(method: string) {
      if (method === "Target.closeTarget") { closes++; return { success: mode !== "false_gone" }; }
      queries++; const gone = closes > 0 && (mode === "false_gone" || (mode === "delayed" && queries >= 3));
      return { targetInfos: [...(mode !== "base_missing" ? [{ targetId: "base", url: "about:blank" }] : []), ...(!gone ? [{ targetId: "job", url: "about:blank" }] : [])] };
    } } as unknown as NativeCdp;
    const result = await closeNativeTarget(cdp, "job", "base", 100);
    assert.equal(result.confirmed, mode === "delayed" || mode === "false_gone"); assert.ok(closes <= 1);
  }
});
