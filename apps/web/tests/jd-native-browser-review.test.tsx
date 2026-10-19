import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createNativeLiepinBrowser, NativeCaptureError, type NativeBrowserOptions } from "../server/jd-native-liepin-browser.ts";
import type { NativeEdge } from "../server/jd-native-edge.ts";
import type { CdpObject, NativeCdp, NativeCdpEvent } from "../server/jd-native-cdp.ts";
import { NATIVE_SNAPSHOT_STYLES, NATIVE_ROOT_SCROLL_STYLES, NATIVE_LIEPIN_PARAGRAPH_STYLES } from "../server/jd-cdp-dom-snapshot.ts";
import { inspectJdBrowserSession, type JdBrowserSession } from "../src/lib/jd-import.ts";
import { JdExtractionError } from "../src/lib/jd-errors.ts";

const source = "https://www.liepin.com/job/1984701079.shtml";
const bossSource = "https://www.zhipin.com/job_detail/synthetic-native-review.html";
const job51Source = "https://jobs.51job.com/shanghai/166509900.html";
const verificationHost = "93bc86fc5f88a01515ccdf7ea6192e9f-verify.captcha-pro-open.aliyuncs.com";
const signal = () => new AbortController().signal;
type Frame = { id: string; loaderId: string; url: string; urlFragment?: string };
const documentUrl = (frame: Frame) => `${frame.url}${frame.urlFragment ?? ""}`;

/** Minimal protocol-shaped body, kept independent from the browser's state machine. */
function snapshot(frame: Frame) {
  const strings: string[] = [];
  const str = (value: string) => { const known = strings.indexOf(value); if (known >= 0) return known; strings.push(value); return strings.length - 1; };
  const defaults: Record<string, string> = {
    display: "block", visibility: "visible", opacity: "1", "content-visibility": "visible", "overflow-x": "visible", "overflow-y": "visible",
    "text-overflow": "clip", "-webkit-line-clamp": "none", clip: "auto", "clip-path": "none", transform: "none", filter: "none",
    "mask-image": "none", "-webkit-mask-image": "none", color: "rgb(0, 0, 0)",
  };
  const text = "岗位职责：维护企业软件系统，分析生产问题，编写维护文档并完成回归。任职要求：熟悉网络、数据库及异步编程。";
  const style = NATIVE_SNAPSHOT_STYLES.map((name) => str(defaults[name]));
  return {
    strings,
    documents: [{
      frameId: str(frame.id), documentURL: str(documentUrl(frame)), title: str("本地协议测试工程师"),
      nodes: {
        nodeType: [9, 1, 1, 1, 1, 3], parentIndex: [-1, 0, 1, 1, 3, 4],
        nodeName: ["#document", "HTML", "HEAD", "BODY", "DIV", "#text"].map(str),
        nodeValue: [-1, -1, -1, -1, -1, str(text)], backendNodeId: [1, 2, 3, 4, 5, 6],
        attributes: [[], [], [], [], [str("class"), str("job-intro-content")], []],
      },
      layout: {
        nodeIndex: [1, 3, 4, 5], styles: [style, style, style, []], bounds: [[0, 0, 1000, 1000], [0, 0, 1000, 1000], [0, 0, 900, 200], [0, 0, 900, 100]],
        text: [-1, -1, -1, str(text)], textColorOpacities: [1, 1, 1, 1],
      },
      textBoxes: { layoutIndex: [3], bounds: [[0, 0, 900, 100]], start: [0], length: [text.length] },
    }],
  };
}

function documentRoot(url = source) {
  return { nodeType: 9, backendNodeId: 1, documentURL: url, compatibilityMode: "NoQuirksMode" };
}

/** Text below the root viewport is reachable only through the reviewed root-scroll proof. */
function rootScrollSnapshot(raw: ReturnType<typeof snapshot>) {
  const strings = [...raw.strings];
  const str = (value: string) => { const known = strings.indexOf(value); if (known >= 0) return known; strings.push(value); return strings.length - 1; };
  const original = raw.documents[0]!;
  const styles = original.layout.styles.map(style => style.length ? [...style, ...["1", "ltr", "horizontal-tb", "static", "none"].map(str)] : []);
  styles[0]![NATIVE_SNAPSHOT_STYLES.indexOf("overflow-y")] = str("auto");
  return { strings, documents: [{
    ...original, contentWidth: 1000, contentHeight: 1000, scrollOffsetX: 0, scrollOffsetY: 200,
    layout: { ...original.layout, styles,
      bounds: [[0, 0, 1000, 1000], [0, 0, 1000, 1000], [0, 800, 900, 200], [0, 800, 900, 100]],
      offsetRects: [[0, 0, 1000, 1000], [0, 0, 1000, 1000], [], []],
      clientRects: [[0, 0, 1000, 600], [0, 0, 1000, 1000], [], []],
      scrollRects: [[0, 200, 1000, 1000], [0, 0, 1000, 1000], [], []],
    },
    textBoxes: { ...original.textBoxes, bounds: [[0, 800, 900, 100]] },
  }] };
}

function visibleOfficeSnapshot(raw: ReturnType<typeof snapshot>, clipped = false) {
  const scoped = rootScrollSnapshot(raw), doc = scoped.documents[0]!;
  const str = (value: string) => { const at = scoped.strings.indexOf(value); return at >= 0 ? at : scoped.strings.push(value) - 1; };
  const baseStyle = [...doc.layout.styles[1]!, str("normal")];
  const nodes = { nodeType: [] as number[], parentIndex: [] as number[], nodeName: [] as number[], nodeValue: [] as number[], backendNodeId: [] as number[], attributes: [] as number[][] };
  const layout = { nodeIndex: [] as number[], styles: [] as number[][], bounds: [] as number[][], text: [] as number[], textColorOpacities: [] as number[], offsetRects: [] as number[][], clientRects: [] as number[][], scrollRects: [] as number[][] };
  const textBoxes = { layoutIndex: [] as number[], bounds: [] as number[][], start: [] as number[], length: [] as number[] };
  const add = (name: string, parent: number, text?: string, className?: string) => {
    const index = nodes.nodeType.length, type = name === "#document" ? 9 : name === "#text" ? 3 : 1;
    nodes.nodeType.push(type); nodes.parentIndex.push(parent); nodes.nodeName.push(str(name)); nodes.nodeValue.push(type === 3 ? str(text ?? "") : -1); nodes.backendNodeId.push(index + 1); nodes.attributes.push(className ? [str("class"), str(className)] : []);
    if (name !== "#document" && name !== "HEAD") {
      const row = layout.nodeIndex.length;
      layout.nodeIndex.push(index); layout.styles.push(type === 3 ? [] : [...baseStyle]); layout.bounds.push([0, 0, 900, 100]); layout.text.push(type === 3 ? str(text ?? "") : -1); layout.textColorOpacities.push(1); layout.offsetRects.push([]); layout.clientRects.push([]); layout.scrollRects.push([]);
      if (text) { textBoxes.layoutIndex.push(row); textBoxes.bounds.push([0, 0, 900, 100]); textBoxes.start.push(0); textBoxes.length.push(text.length); }
    }
    return index;
  };
  const root = add("#document", -1), html = add("HTML", root); add("HEAD", html); const body = add("BODY", html);
  const section = add("SECTION", body, undefined, "job-intro-container");
  const duties = add("DL", section, undefined, "paragraph"), dutiesDt = add("DT", duties); add("#text", dutiesDt, "职位描述"); const dutiesDd = add("DD", duties); add("#text", dutiesDd, "SYNTHETIC_NATIVE_OFFICE_JD：维护企业软件系统，分析生产问题，编写维护文档并完成回归。任职要求：熟悉网络、数据库及异步编程。");
  const address = add("DL", section, undefined, "paragraph"), addressDt = add("DT", address); add("#text", addressDt, "工作地址："); const addressDd = add("DD", address); add("#text", addressDd, "上海市浦东新区合成办公路100号 A座");
  if (clipped) layout.styles[layout.nodeIndex.indexOf(addressDd)]![NATIVE_SNAPSHOT_STYLES.indexOf("text-overflow")] = str("ellipsis");
  for (const node of [html, body]) {
    const row = layout.nodeIndex.indexOf(node); layout.bounds[row] = [0, 0, 1000, 1000]; layout.offsetRects[row] = [0, 0, 1000, 1000]; layout.clientRects[row] = [0, 0, 1000, 1000]; layout.scrollRects[row] = [0, 0, 1000, 1000];
  }
  return { strings: scoped.strings, documents: [{ ...doc, scrollOffsetY: 0, nodes, layout, textBoxes }] };
}

/** This transport never creates a process or sends a network request. */
function fixture(browserOptions: Pick<NativeBrowserOptions, "networkMode" | "verifyManagedProxy" | "platform" | "profileDirectory"> = {}) {
  let frame: Frame = { id: "main", loaderId: "initial", url: "about:blank" };
  let connected = true; let captures = 0; let stops = 0; let nextTarget = 0;
  let onCapture: (() => void) | undefined;
  let rawCapture: ((value: ReturnType<typeof snapshot>) => unknown) | undefined;
  let onCommand: ((method: string, params: CdpObject, sessionId?: string) => unknown) | undefined;
  const listeners = new Set<(event: NativeCdpEvent) => void>();
  const targets = new Map<string, { targetId: string; type: string; url: string }>([["base", { targetId: "base", type: "page", url: "about:blank" }]]);
  const calls: Array<{ method: string; params: CdpObject; sessionId?: string }> = [];
  const launchProfiles: string[] = [];
  const emit = (method: string, params: CdpObject, sessionId = "session-job-1") => {
    for (const listener of listeners) listener({ method, params, sessionId });
  };
  const cdp: NativeCdp = {
    get connected() { return connected; },
    async send<T = CdpObject>(method: string, params: CdpObject = {}, sessionId?: string): Promise<T> {
      calls.push({ method, params, sessionId });
      const override = onCommand?.(method, params, sessionId);
      if (override !== undefined) return override as T;
      let result: unknown = {};
      if (method === "Target.getTargets") result = { targetInfos: [...targets.values()] };
      if (method === "Target.createTarget") {
        const targetId = `job-${++nextTarget}`;
        targets.set(targetId, { targetId, type: "page", url: "about:blank" }); result = { targetId };
        queueMicrotask(() => { for (const listener of listeners) listener({ method: "Target.attachedToTarget", params: { sessionId: `session-${targetId}`, targetInfo: { targetId, type: "page", url: "about:blank" }, waitingForDebugger: true } }); });
      }
      if (method === "Target.closeTarget") { targets.delete(String(params.targetId)); result = { success: true }; }
      if (method === "Target.attachToTarget") result = { sessionId: `session-${params.targetId}` };
      if (method === "Page.getFrameTree") result = { frameTree: { frame: { ...frame } } };
      if (method === "DOM.getDocument") result = { root: documentRoot(documentUrl(frame)) };
      if (method === "DOMSnapshot.captureSnapshot") { captures++; const raw = snapshot(frame); result = rawCapture ? rawCapture(raw) : raw; onCapture?.(); }
      return result as T;
    },
    on(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close() { connected = false; },
  };
  const edge: NativeEdge = { cdp, get alive() { return connected; }, async stop() { stops++; connected = false; } };
  const browser = createNativeLiepinBrowser({ profileDirectory: "C:/owned-synthetic-native-review-profile", inspectProfileOccupancy: async () => "clear", launch: async (profile) => { launchProfiles.push(profile); return edge; }, ...browserOptions });
  function request(id: string, loader: string, url = source) {
    emit("Network.requestWillBeSent", { requestId: id, loaderId: loader, frameId: "main", type: "Document", request: { url } });
  }
  function response(id: string, loader: string, url = source, status = 200) {
    emit("Network.responseReceived", { requestId: id, loaderId: loader, frameId: "main", type: "Document", response: { status, url } });
  }
  function commit(id: string, loader: string, url = source, options: { status?: number; loaded?: boolean } = {}) {
    request(id, loader, url); response(id, loader, url, options.status);
    frame = { id: "main", loaderId: loader, url };
    targets.get("job-1")!.url = url;
    emit("Page.frameNavigated", { frame: { ...frame } });
    if (options.loaded !== false) emit("Page.lifecycleEvent", { frameId: "main", loaderId: loader, name: "load" });
  }
  return { browser, calls, launchProfiles, emit, request, response, commit,
    setCaptureHook: (hook: typeof onCapture) => { onCapture = hook; },
    setRawCapture: (hook: typeof rawCapture) => { rawCapture = hook; },
    setCommandHook: (hook: typeof onCommand) => { onCommand = hook; },
    setFrame: (value: Frame) => { frame = { ...value }; },
    get captures() { return captures; }, get stops() { return stops; } };
}

test("native factory binds same-URL capture to the latest committed main request and rejects late responses", async () => {
  const f = fixture(); const page = await f.browser.acquire(undefined, signal());
  try {
    f.commit("first", "loader-1");
    const first = await page.capture(signal()); assert.equal(first.state, "ready"); assert.ok(first.identity); assert.ok(first.snapshot?.html.includes("维护企业软件系统"));
    const captures = f.captures;
    f.request("second", "loader-2");
    assert.equal((await page.capture(signal())).state, "navigation_in_progress"); assert.equal(f.captures, captures);
    assert.equal(await page.current(first.identity, signal()), false);
    f.response("first", "loader-1");
    assert.equal((await page.capture(signal())).state, "navigation_in_progress");
    f.emit("Network.loadingFailed", { requestId: "second", errorText: "net::ERR_CONNECTION_RESET" });
    assert.equal((await page.capture(signal())).state, "failed");
    f.response("first", "loader-1");
    assert.equal((await page.capture(signal())).state, "failed"); assert.equal(page.inspect().mainDocument.state, "failed");
    f.commit("third", "loader-3");
    const third = await page.capture(signal()); assert.equal(third.state, "ready"); assert.notEqual(third.identity, first.identity);
  } finally { await f.browser.stop(); }
});

test("native committed documents accept observed same-path query and fragment history changes without replacing their HTTP proof", async () => {
  for (const responseFirst of [true, false]) {
    const f = fixture({ platform: "51JOB" }); const page = await f.browser.acquire(undefined, signal());
    try {
      const initial = `${job51Source}?initial=PRIVATE_NETWORK_QUERY`;
      f.request("main", "loader", initial);
      if (responseFirst) f.response("main", "loader", initial);
      f.setFrame({ id: "main", loaderId: "loader", url: initial });
      f.emit("Page.frameNavigated", { frame: { id: "main", loaderId: "loader", url: initial } });
      if (!responseFirst) f.response("main", "loader", initial);
      const first = await page.capture(signal()); assert.equal(first.state, "ready"); assert.ok(first.identity);
      let previous = first.identity;
      for (const next of [job51Source, `${job51Source}?tracking=changed#description`, `${job51Source}#`]) {
        const fragment = next.indexOf("#");
        f.setFrame({ id: "main", loaderId: "loader", url: fragment < 0 ? next : next.slice(0, fragment), ...(fragment < 0 ? {} : { urlFragment: next.slice(fragment) }) });
        f.emit("Page.navigatedWithinDocument", { frameId: "main", url: next, navigationType: "historyApi" });
        assert.equal(await page.current(previous, signal()), false, "the history event invalidates the previous generation");
        const changed = await page.capture(signal());
        assert.equal(changed.state, "ready"); assert.equal(changed.snapshot?.url, next); assert.ok(changed.identity);
        assert.equal(await page.current(changed.identity, signal()), true);
        assert.equal(page.inspect().mainDocumentRequests, 1); assert.deepEqual(page.inspect().mainDocument, { state: "response", status: 200 });
        previous = changed.identity;
      }
      f.response("main", "loader", `${job51Source}?late=DIFFERENT_RESPONSE`);
      const poisoned = await page.capture(signal());
      assert.equal(poisoned.state, "failed"); assert.deepEqual(poisoned.diagnostic, { stage: "document_state", reason: "frame_url_mismatch" });
    } finally { await f.browser.stop(); }
  }
});

test("native Frame urlFragment is assembled consistently for initial commit and exact DOM document identity", async () => {
  const f = fixture({ platform: "51JOB" }); const page = await f.browser.acquire(undefined, signal());
  try {
    f.request("main", "loader", job51Source); f.response("main", "loader", job51Source);
    const frame = { id: "main", loaderId: "loader", url: job51Source, urlFragment: "#description" };
    f.setFrame(frame); f.emit("Page.frameNavigated", { frame });
    const captured = await page.capture(signal());
    assert.equal(captured.state, "ready"); assert.equal(captured.snapshot?.url, `${job51Source}#description`); assert.ok(captured.identity);
    assert.equal(await page.current(captured.identity, signal()), true);
    f.setRawCapture(raw => { raw.documents[0]!.documentURL = raw.strings.push(job51Source) - 1; return raw; });
    const mismatch = await page.capture(signal());
    assert.equal(mismatch.state, "failed"); assert.deepEqual(mismatch.diagnostic, { stage: "projection", reason: "document_url" });
  } finally { await f.browser.stop(); }
});

test("native history does not authorize a different path or origin, or an unobserved query or fragment", async () => {
  for (const scenario of [
    { url: job51Source.replace("166509900", "166509901"), observed: true },
    { url: job51Source.replace("/shanghai/", "/beijing/"), observed: true },
    { url: job51Source.replace("jobs.51job.com", "msearch.51job.com"), observed: true },
    { url: job51Source.replace("https:", "http:"), observed: true },
    { url: `${job51Source}?unobserved=PRIVATE`, observed: false },
    { url: `${job51Source}#unobserved`, observed: false },
  ]) {
    const f = fixture({ platform: "51JOB" }); const page = await f.browser.acquire(undefined, signal());
    try {
      f.commit("main", "loader", job51Source); const first = await page.capture(signal()); assert.ok(first.identity);
      const hash = scenario.url.indexOf("#");
      f.setFrame({ id: "main", loaderId: "loader", url: hash < 0 ? scenario.url : scenario.url.slice(0, hash), ...(hash < 0 ? {} : { urlFragment: scenario.url.slice(hash) }) });
      if (scenario.observed) f.emit("Page.navigatedWithinDocument", { frameId: "main", url: scenario.url });
      const captured = await page.capture(signal());
      assert.equal(captured.state, "failed"); assert.deepEqual(captured.diagnostic, { stage: "document_state", reason: "frame_url_mismatch" });
      assert.equal(await page.current(first.identity, signal()), false); assert.equal(captured.snapshot, undefined);
    } finally { await f.browser.stop(); }
  }
});

test("native same-document events cannot commit missing, pending, failed or differently loaded HTTP documents", async () => {
  for (const state of ["missing", "pending", "failed", "wrong_loader", "new_pending"] as const) {
    const f = fixture({ platform: "51JOB" }); const page = await f.browser.acquire(undefined, signal());
    try {
      if (state !== "missing" && state !== "pending") f.commit("main", "loader", job51Source);
      if (state === "pending") { f.request("main", "loader", job51Source); f.response("main", "loader", job51Source); }
      if (state === "failed") f.emit("Network.loadingFailed", { requestId: "main" });
      if (state === "new_pending") { f.request("new", "new-loader", job51Source); f.response("main", "loader", job51Source); }
      f.setFrame({ id: "main", loaderId: state === "wrong_loader" ? "other-loader" : "loader", url: `${job51Source}?history=changed` });
      f.emit("Page.navigatedWithinDocument", { frameId: "main", url: `${job51Source}?history=changed` });
      const captured = await page.capture(signal());
      assert.equal(captured.state, state === "pending" || state === "new_pending" ? "navigation_in_progress" : "failed");
      assert.equal(captured.snapshot, undefined); assert.equal(captured.identity, undefined); assert.equal(f.captures, 0);
    } finally { await f.browser.stop(); }
  }
});

test("native observed same-path history during capture invalidates that sample and requires a fresh stable snapshot", async () => {
  const f = fixture({ platform: "51JOB" }); const page = await f.browser.acquire(undefined, signal());
  try {
    f.commit("main", "loader", job51Source); let changed = false;
    f.setCaptureHook(() => {
      if (changed) return; changed = true;
      const next = `${job51Source}?history=changed`;
      f.setFrame({ id: "main", loaderId: "loader", url: next }); f.emit("Page.navigatedWithinDocument", { frameId: "main", url: next });
    });
    const stale = await page.capture(signal());
    assert.equal(stale.state, "navigation_in_progress"); assert.equal(stale.snapshot, undefined); assert.equal(stale.identity, undefined);
    const fresh = await page.capture(signal()); assert.equal(fresh.state, "ready"); assert.equal(fresh.snapshot?.url, `${job51Source}?history=changed`);
  } finally { await f.browser.stop(); }
});

test("native platforms keep three independent default profiles and preserve an explicit profile", async () => {
  for (const scenario of [
    { options: { profileDirectory: undefined }, directory: "liepin-native" },
    { options: { platform: "猎聘" as const, profileDirectory: undefined }, directory: "liepin-native" },
    { options: { platform: "BOSS直聘" as const, profileDirectory: undefined }, directory: "boss-native" },
    { options: { platform: "51JOB" as const, profileDirectory: undefined }, directory: "51job-native" },
    { options: { platform: "BOSS直聘" as const, profileDirectory: "C:/synthetic-explicit-boss-profile" }, explicit: "C:/synthetic-explicit-boss-profile" },
  ]) {
    const f = fixture(scenario.options);
    try {
      await f.browser.acquire(undefined, signal());
      assert.equal(f.launchProfiles.length, 1);
      const profile = f.launchProfiles[0]!;
      if (scenario.explicit) assert.equal(profile, path.resolve(scenario.explicit));
      else assert.ok(profile.replaceAll("\\", "/").endsWith(`/data/recruitment-browser/${scenario.directory}/profile`));
    } finally { await f.browser.stop(); }
    assert.equal(f.stops, 1);
  }
});

test("native strict resource policy isolates each platform and its observed CDN resources", async () => {
  for (const platform of ["猎聘", "BOSS直聘", "51JOB"] as const) {
    const f = fixture({ platform });
    try {
      await f.browser.acquire(undefined, signal());
      const resources = [
        { id: "liepin-page", url: source, platform: "猎聘" },
        { id: "liepin-cdn", url: "https://concat.lietou-static.com/review.js", platform: "猎聘" },
        { id: "boss-page", url: bossSource, platform: "BOSS直聘" },
        { id: "boss-cdn", url: "https://static.geetest.com/review.js", platform: "BOSS直聘" },
        { id: "51job-page", url: job51Source, platform: "51JOB" },
        { id: "51job-verification", url: `https://${verificationHost}/review.js`, platform: "51JOB" },
      ];
      for (const item of resources) f.emit("Fetch.requestPaused", { requestId: item.id, resourceType: "Script", request: { url: item.url } });
      await new Promise((resolve) => setImmediate(resolve));
      for (const item of resources) {
        const decisions = f.calls.filter((call) => ["Fetch.continueRequest", "Fetch.failRequest"].includes(call.method) && call.params.requestId === item.id);
        assert.equal(decisions.length, 1);
        assert.equal(decisions[0]!.method, item.platform === platform ? "Fetch.continueRequest" : "Fetch.failRequest");
      }
    } finally { await f.browser.stop(); }
  }
});

test("native capture accepts its selected platform and rejects the other platform before DOMSnapshot", async () => {
  for (const scenario of [
    { platform: "猎聘" as const, own: source, other: bossSource },
    { platform: "BOSS直聘" as const, own: bossSource, other: source },
    { platform: "51JOB" as const, own: job51Source, other: source },
    { platform: "51JOB" as const, own: "https://msearch.51job.com/jobs/all/166761768.html", other: source },
  ]) {
    const f = fixture({ platform: scenario.platform }); const page = await f.browser.acquire(undefined, signal());
    try {
      f.commit("own", "own-loader", scenario.own);
      const own = await page.capture(signal()); assert.equal(own.state, "ready"); assert.ok(own.identity);
      assert.equal(own.snapshot?.url, scenario.own); assert.equal(await page.current(own.identity, signal()), true);
      const captures = f.captures;
      f.commit("other", "other-loader", scenario.other);
      const rejected = await page.capture(signal());
      assert.equal(rejected.state, "failed"); assert.deepEqual(rejected.diagnostic, { stage: "document_state", reason: "source_rejected" });
      assert.equal(rejected.snapshot, undefined); assert.equal(rejected.identity, undefined); assert.equal(f.captures, captures);
      assert.equal(page.closed, false);
      f.commit("recovered", "recovered-loader", scenario.own); assert.equal((await page.capture(signal())).state, "ready");
    } finally { await f.browser.stop(); }
  }
});

test("native capture opts into raw search link and timestamp attributes only for its explicit fourth argument", async () => {
  const searchUrl = "https://www.liepin.com/zhaopin/?key=TypeScript";
  const href = '../job/123.shtml?keyword=C%23&title="<Engineer>"';
  const datetime = "2026-10-18T12:00:00+08:00";
  const f = fixture(); const page = await f.browser.acquire(undefined, signal());
  try {
    f.commit("search", "search-loader", searchUrl);
    f.setRawCapture(raw => {
      const doc = raw.documents[0]!;
      const str = (value: string) => { const known = raw.strings.indexOf(value); return known >= 0 ? known : raw.strings.push(value) - 1; };
      doc.nodes.nodeName[4] = str("A");
      doc.nodes.attributes[4] = [str("class"), str("job-title"), str("href"), str(href), str("onclick"), str("PRIVATE_EVENT")];
      doc.nodes.nodeType.push(1, 3); doc.nodes.parentIndex.push(3, 6); doc.nodes.nodeName.push(str("TIME"), str("#text"));
      doc.nodes.nodeValue.push(-1, str("今天发布")); doc.nodes.backendNodeId.push(7, 8);
      doc.nodes.attributes.push([str("datetime"), str(datetime), str("style"), str("PRIVATE_STYLE")], []);
      const textLayout = doc.layout.nodeIndex.length + 1;
      doc.layout.nodeIndex.push(6, 7); doc.layout.styles.push([...doc.layout.styles[0]!], []);
      doc.layout.bounds.push([0, 300, 900, 20], [0, 300, 900, 20]); doc.layout.text.push(-1, str("今天发布")); doc.layout.textColorOpacities.push(1, 1);
      doc.textBoxes.layoutIndex.push(textLayout); doc.textBoxes.bounds.push([0, 300, 900, 20]); doc.textBoxes.start.push(0); doc.textBoxes.length.push(4);
      return raw;
    });
    const captureCallsStart = f.calls.length;
    const ordinary = await page.capture(signal(), 1000, searchUrl);
    assert.equal(ordinary.state, "ready"); assert.doesNotMatch(ordinary.snapshot!.html, /href=|datetime=/);
    const searched = await page.capture(signal(), 1000, searchUrl, { purpose: "search" });
    assert.equal(searched.state, "ready"); assert.equal(searched.identity, ordinary.identity);
    assert.ok(searched.snapshot!.html.includes('href="../job/123.shtml?keyword=C%23&amp;title=&quot;&lt;Engineer&gt;&quot;"'));
    assert.ok(searched.snapshot!.html.includes(`datetime="${datetime}"`));
    assert.doesNotMatch(searched.snapshot!.html, /PRIVATE_|onclick=|style=/);
    assert.deepEqual(searched.snapshot!.pageLoad, ordinary.snapshot!.pageLoad);
    const after = await page.capture(signal(), 1000, searchUrl);
    assert.equal(after.snapshot!.html, ordinary.snapshot!.html);
    const captures = f.calls.filter(call => call.method === "DOMSnapshot.captureSnapshot");
    for (const [index, capture] of captures.entries()) {
      assert.deepEqual(capture.params, { computedStyles: [...(index === 1 ? NATIVE_ROOT_SCROLL_STYLES : NATIVE_SNAPSHOT_STYLES)], includeDOMRects: true, includeTextColorOpacities: true });
    }
    assert.equal(f.calls.slice(captureCallsStart).some(call => call.method.startsWith("Runtime.")), false);
    assert.equal(f.calls.slice(captureCallsStart).filter(call => call.method === "DOM.getDocument").length, 2);
  } finally { await f.browser.stop(); }
});

test("native 51JOB WAF projection reports a gate without leaking metadata or enabling Liepin scope or Runtime", async () => {
  const f = fixture({ platform: "51JOB", networkMode: "managed-proxy", verifyManagedProxy: async () => true });
  const page = await f.browser.acquire("http://127.0.0.1:17891", signal());
  try {
    f.commit("original", "loader-original", job51Source);
    f.setRawCapture(raw => {
      const nodes = raw.documents[0]!.nodes;
      const str = (value: string) => raw.strings.push(value) - 1;
      nodes.nodeType.push(1); nodes.parentIndex.push(2); nodes.nodeName.push(str("META")); nodes.nodeValue.push(-1);
      nodes.backendNodeId.push(7); nodes.attributes.push([str("name"), str("aliyun_waf_SECRET_SUFFIX"), str("content"), str("PRIVATE_CHALLENGE_VALUE")]);
      return raw;
    });
    const capture = await page.capture(signal(), undefined, job51Source);
    assert.equal(capture.state, "ready"); assert.equal(capture.snapshot?.gate, "verification_required");
    assert.doesNotMatch(JSON.stringify(capture), /PRIVATE_CHALLENGE_VALUE|SECRET_SUFFIX|维护企业软件系统/);
    assert.equal(page.closed, false);
    assert.ok(f.calls.some(call => call.method === "DOMSnapshot.captureSnapshot"));
    assert.equal(f.calls.some(call => call.method === "DOM.getDocument" || call.method.startsWith("Runtime.")), false);
    assert.deepEqual(f.calls.find(call => call.method === "DOMSnapshot.captureSnapshot")!.params.computedStyles, [...NATIVE_SNAPSHOT_STYLES]);
    const searchCapture = await page.capture(signal(), undefined, job51Source, { purpose: "search" });
    assert.equal(searchCapture.snapshot?.gate, capture.snapshot?.gate);
    assert.equal(searchCapture.snapshot?.html, capture.snapshot?.html);
  } finally { await f.browser.stop(); }
});

test("native 51JOB passive network evidence binds page-session request identity and discards secrets, foreign hosts and late events", async () => {
  const f = fixture({ platform: "51JOB", networkMode: "managed-proxy", verifyManagedProxy: async () => true });
  const page = await f.browser.acquire("http://127.0.0.1:17891", signal());
  try {
    const endpoint = `https://${verificationHost}/PRIVATE_PATH?token=PRIVATE_TOKEN`;
    const request = (id: string, url = endpoint, session = "session-job-1") => f.emit("Network.requestWillBeSent", {
      requestId: id, type: "XHR", request: { url, headers: { Cookie: "PRIVATE_COOKIE" }, postData: "PRIVATE_BODY" },
    }, session);
    request("foreign-session", endpoint, "session-base");
    request("foreign-host", "https://other.captcha-pro-open.aliyuncs.com/PRIVATE_PATH");
    request("a"); request("b");
    f.emit("Network.responseReceived", { requestId: "b", type: "XHR", response: { status: 200, headers: { "set-cookie": "PRIVATE_RESPONSE_COOKIE" } } });
    f.emit("Network.loadingFinished", { requestId: "b" });
    f.emit("Network.loadingFailed", { requestId: "a", errorText: "PRIVATE_NETWORK_ERROR", canceled: false });
    const observed = page.inspect().verificationNetwork;
    assert.ok(observed);
    assert.deepEqual(observed.requests, [{ id: 1, host: verificationHost, type: "xhr" }, { id: 2, host: verificationHost, type: "xhr" }]);
    assert.deepEqual(observed.events.map(event => [event.requestId, event.phase, event.status]), [
      [1, "request", undefined], [2, "request", undefined], [2, "response", 200], [2, "finished", undefined], [1, "failed", undefined],
    ]);
    assert.doesNotMatch(JSON.stringify(observed), /PRIVATE|foreign-session|foreign-host|"a"|"b"/);
    observed.requests[0]!.host = "mutated.example";
    assert.equal(page.inspect().verificationNetwork!.requests[0]!.host, verificationHost);
    await page.release();
    request("late"); f.emit("Network.loadingFinished", { requestId: "late" });
    assert.deepEqual(page.inspect().verificationNetwork, { requests: [], events: [], truncated: false });
    assert.equal(f.calls.some(call => call.method.startsWith("Runtime.") || /getResponseBody|postData|RequestPostData/.test(call.method)), false);
  } finally { await f.browser.stop(); }
});

test("native 51JOB passive observation retains safe redirect hops and saturates without blocking the page", async () => {
  const f = fixture({ platform: "51JOB", networkMode: "managed-proxy", verifyManagedProxy: async () => true });
  const page = await f.browser.acquire("http://127.0.0.1:17891", signal());
  try {
    const url = `https://${verificationHost}/PRIVATE_REDIRECT?token=PRIVATE`;
    f.emit("Network.requestWillBeSent", { requestId: "redirect", type: "Script", request: { url } });
    f.emit("Network.requestWillBeSent", { requestId: "redirect", type: "Script", redirectResponse: { status: 302 }, request: { url: "https://upload.captcha-pro-open.aliyuncs.com/PRIVATE_DESTINATION" } });
    f.emit("Network.responseReceived", { requestId: "redirect", response: { status: 200 } });
    f.emit("Network.loadingFinished", { requestId: "redirect" });
    for (let i = 0; i < 80; i++) {
      f.emit("Network.requestWillBeSent", { requestId: `flood-${i}`, type: "Fetch", request: { url } });
      f.emit("Network.loadingFailed", { requestId: `flood-${i}`, errorText: "PRIVATE_FAILURE" });
    }
    const observed = page.inspect().verificationNetwork;
    assert.ok(observed); assert.equal(observed.truncated, true); assert.equal(observed.requests.length, 32);
    assert.deepEqual(observed.events.slice(0, 6).map(event => [event.requestId, event.phase, event.status]), [
      [1, "request", undefined], [1, "response", 302], [1, "finished", undefined], [2, "request", undefined], [2, "response", 200], [2, "finished", undefined],
    ]);
    assert.ok(observed.events.length <= 128); assert.equal(page.closed, false);
    assert.doesNotMatch(JSON.stringify(observed), /PRIVATE|redirect|flood/);
  } finally { await f.browser.stop(); }
  const other = fixture({ platform: "BOSS直聘" }); const otherPage = await other.browser.acquire(undefined, signal());
  try {
    other.emit("Network.requestWillBeSent", { requestId: "no-51job-observer", type: "XHR", request: { url: `https://${verificationHost}/` } });
    assert.equal(otherPage.inspect().verificationNetwork, undefined);
  } finally { await other.browser.stop(); }
});

test("native BOSS official verification destinations return a committed 200 gate without DOMSnapshot", async () => {
  const f = fixture({ platform: "BOSS直聘" }); const page = await f.browser.acquire(undefined, signal());
  try {
    let serial = 0;
    for (const host of ["m.zhipin.com", "www.zhipin.com"]) for (const pathname of ["/web/passport/zp/security.html", "/web/common/security-check.html"]) {
      const url = `https://${host}${pathname}`; const id = `verification-${++serial}`;
      f.commit(id, `${id}-loader`, url);
      const result = await page.capture(signal());
      assert.equal(result.state, "ready"); assert.ok(result.identity); assert.equal(result.snapshot?.gate, "verification_required");
      assert.equal(result.snapshot?.url, url); assert.equal(result.diagnostic, undefined); assert.equal(f.captures, 0);
      assert.equal(await page.current(result.identity, signal()), true); assert.equal(page.closed, false);
    }
    assert.equal(f.calls.some((call) => call.method === "DOMSnapshot.captureSnapshot" || call.method === "Page.navigate" || call.method === "Runtime.evaluate"), false);
  } finally { await f.browser.stop(); }
});

test("native BOSS known verification URLs still require a current committed successful document", async () => {
  const url = "https://www.zhipin.com/web/passport/zp/security.html";
  for (const scenario of ["pending", "non_200", "wrong_loader"] as const) {
    const f = fixture({ platform: "BOSS直聘" }); const page = await f.browser.acquire(undefined, signal());
    try {
      f.commit("gate", "gate-loader", url, { status: scenario === "non_200" ? 403 : 200 });
      if (scenario === "pending") f.request("next", "next-loader", url);
      if (scenario === "wrong_loader") f.setFrame({ id: "main", loaderId: "different-loader", url });
      const result = await page.capture(signal());
      assert.equal(result.state, scenario === "pending" ? "navigation_in_progress" : "failed");
      assert.deepEqual(result.diagnostic, { stage: "document_state", reason: scenario === "pending" ? "main_pending" : scenario === "non_200" ? "response_not_200" : "frame_loader_mismatch" });
      assert.equal(result.snapshot, undefined); assert.equal(result.identity, undefined); assert.equal(f.captures, 0); assert.equal(page.closed, false);
    } finally { await f.browser.stop(); }
  }
});

test("native known gate recheck rejects a newer main request or commit without capturing DOM", async () => {
  const url = "https://www.zhipin.com/web/passport/zp/security.html";
  for (const change of ["request", "commit"] as const) {
    const f = fixture({ platform: "BOSS直聘" }); const page = await f.browser.acquire(undefined, signal());
    try {
      f.commit("gate", "gate-loader", url); let frameCalls = 0;
      f.setCommandHook(method => {
        if (method === "Page.getFrameTree" && ++frameCalls === 2) {
          if (change === "request") f.request("replacement", "replacement-loader", bossSource);
          else f.commit("replacement", "replacement-loader", bossSource);
        }
      });
      const result = await page.capture(signal());
      assert.equal(frameCalls, 2); assert.equal(result.state, "navigation_in_progress");
      assert.deepEqual(result.diagnostic, { stage: "post_projection", reason: "navigation_changed" });
      assert.equal(result.snapshot, undefined); assert.equal(result.identity, undefined); assert.equal(f.captures, 0);
      assert.equal(page.inspect().mainDocumentRequests, 2); assert.equal(page.closed, false);
      f.setCommandHook(undefined); f.commit("recovered-gate", "recovered-loader", url);
      const recovered = await page.capture(signal());
      assert.equal(recovered.state, "ready"); assert.equal(recovered.snapshot?.gate, "verification_required");
      assert.equal(recovered.diagnostic, undefined); assert.equal(f.captures, 0);
    } finally { await f.browser.stop(); }
  }
});

test("native known gate recheck retains typed network failure if managed proxy verification changes", async () => {
  let accepted = true; let checks = 0;
  const f = fixture({ platform: "BOSS直聘", networkMode: "managed-proxy", verifyManagedProxy: async url => {
    checks++; return accepted && url === "http://127.0.0.1:17891";
  } });
  const page = await f.browser.acquire("http://127.0.0.1:17891", signal());
  try {
    f.commit("gate", "gate-loader", "https://www.zhipin.com/web/passport/zp/security.html");
    let frameCalls = 0; const priorChecks = checks;
    f.setCommandHook(method => { if (method === "Page.getFrameTree" && ++frameCalls === 1) accepted = false; });
    await assert.rejects(page.capture(signal()), error => {
      assert.ok(error instanceof NativeCaptureError); assert.ok(error instanceof JdExtractionError);
      assert.deepEqual(error.diagnostic, { stage: "post_projection", reason: "network_unavailable" });
      assert.equal(error.failure.code, "browser_unavailable"); assert.equal(error.cause, undefined);
      return true;
    });
    assert.ok(checks > priorChecks); assert.equal(frameCalls, 1); assert.equal(f.captures, 0);
    assert.equal(page.closed, false); assert.equal(f.browser.hasUnclosed?.(), true);
    assert.equal(f.calls.some(call => call.method === "DOMSnapshot.captureSnapshot"), false);
  } finally { await f.browser.stop(); }
});

test("native BOSS does not infer verification gates from lookalike hosts or paths", async () => {
  for (const scenario of [
    { url: "https://www.zhipin.com/web/passport/zp/security.html/extra", allowed: true },
    { url: "https://www.zhipin.com/web/passport/zp/not-security.html", allowed: true },
    { url: "https://security.zhipin.com/web/passport/zp/security.html", allowed: true },
    { url: "https://img.bosszhipin.com/web/passport/zp/security.html", allowed: true },
    { url: "https://www.zhipin.com.outside.invalid/web/passport/zp/security.html", allowed: false },
    { url: "https://www.zhipin.com@outside.invalid/web/passport/zp/security.html", allowed: false },
  ]) {
    const f = fixture({ platform: "BOSS直聘" }); const page = await f.browser.acquire(undefined, signal());
    try {
      f.commit("lookalike", "lookalike-loader", scenario.url);
      const result = await page.capture(signal());
      assert.equal(result.snapshot?.gate, undefined);
      if (scenario.allowed) { assert.equal(result.state, "ready"); assert.equal(f.captures, 1); }
      else { assert.equal(result.state, "failed"); assert.deepEqual(result.diagnostic, { stage: "document_state", reason: "source_rejected" }); assert.equal(f.captures, 0); }
    } finally { await f.browser.stop(); }
  }
});

test("native main document request count is independent from commits, generations and child activity", async () => {
  const f = fixture({ platform: "BOSS直聘" }); const page = await f.browser.acquire(undefined, signal());
  try {
    assert.equal(page.inspect().mainDocumentRequests, 0);
    f.commit("first", "loader-1", bossSource); assert.equal(page.inspect().mainDocumentRequests, 1);
    const first = await page.capture(signal()); assert.ok(first.identity);
    f.emit("Page.frameNavigated", { frame: { id: "main", loaderId: "loader-1", url: bossSource } });
    assert.equal(page.inspect().mainDocumentRequests, 1); assert.equal(await page.current(first.identity, signal()), false, "commit invalidates identity without creating a network request");
    f.emit("Page.navigatedWithinDocument", { frameId: "main", url: bossSource });
    f.emit("Page.lifecycleEvent", { frameId: "main", loaderId: "loader-1", name: "load" });
    f.emit("Network.requestWillBeSent", { requestId: "child", loaderId: "child-loader", frameId: "child", type: "Document", request: { url: bossSource } });
    f.emit("Page.frameNavigated", { frame: { id: "child", parentId: "main", loaderId: "child-loader", url: bossSource } });
    f.emit("Network.requestWillBeSent", { requestId: "script", loaderId: "loader-1", frameId: "main", type: "Script", request: { url: "https://www.zhipin.com/review.js" } });
    f.emit("Network.requestWillBeSent", { requestId: "base", loaderId: "base-loader", frameId: "main", type: "Document", request: { url: bossSource } }, "session-base");
    f.response("first", "loader-1", bossSource);
    assert.equal(page.inspect().mainDocumentRequests, 1);
    f.request("failed", "loader-2", bossSource); assert.equal(page.inspect().mainDocumentRequests, 2);
    f.emit("Network.loadingFailed", { requestId: "failed", errorText: "net::ERR_CONNECTION_RESET" });
    assert.equal(page.inspect().mainDocumentRequests, 2);
    f.commit("retry", "loader-3", bossSource); assert.equal(page.inspect().mainDocumentRequests, 3);
    await page.capture(signal()); await page.focus(signal()); assert.equal(page.inspect().mainDocumentRequests, 3);
  } finally { await f.browser.stop(); }
});

test("native main document request diagnostic count is capped at 1000", async () => {
  const f = fixture(); const page = await f.browser.acquire(undefined, signal());
  try {
    for (let i = 0; i < 1005; i++) f.request(`request-${i}`, `loader-${i}`);
    assert.equal(page.inspect().mainDocumentRequests, 1000);
  } finally { await f.browser.stop(); }
});

test("stopping the BOSS native factory leaves the independently owned Liepin page usable", async () => {
  const boss = fixture({ platform: "BOSS直聘", profileDirectory: undefined });
  const liepin = fixture({ platform: "猎聘", profileDirectory: undefined });
  try {
    const bossPage = await boss.browser.acquire(undefined, signal()); const liepinPage = await liepin.browser.acquire(undefined, signal());
    boss.commit("boss", "boss-loader", bossSource); liepin.commit("liepin", "liepin-loader");
    assert.notEqual(boss.launchProfiles[0], liepin.launchProfiles[0]);
    await boss.browser.stop();
    assert.equal(bossPage.closed, true); assert.equal(boss.stops, 1); assert.equal(liepin.stops, 0); assert.equal(liepinPage.closed, false);
    assert.equal((await liepinPage.capture(signal())).state, "ready");
  } finally { await Promise.all([boss.browser.stop(), liepin.browser.stop()]); }
  assert.equal(liepin.stops, 1);
});

test("native factory child document events cannot replace main document identity or poison its response", async () => {
  const f = fixture(); const page = await f.browser.acquire(undefined, signal());
  try {
    f.commit("main-request", "main-loader"); const before = await page.capture(signal()); assert.ok(before.identity);
    f.emit("Network.requestWillBeSent", { requestId: "child-request", loaderId: "child-loader", frameId: "child", type: "Document", request: { url: "https://www.liepin.com/child" } });
    f.emit("Network.responseReceived", { requestId: "child-request", loaderId: "child-loader", frameId: "child", type: "Document", response: { status: 503, url: "https://www.liepin.com/child" } });
    f.emit("Page.frameNavigated", { frame: { id: "child", parentId: "main", loaderId: "child-loader", url: "https://www.liepin.com/child" } });
    f.emit("Network.loadingFailed", { requestId: "child-request", errorText: "net::ERR_CONNECTION_RESET" });
    const after = await page.capture(signal()); assert.equal(after.state, "ready"); assert.equal(after.identity, before.identity);
    assert.deepEqual(page.inspect().mainDocument, { state: "response", status: 200 });
  } finally { await f.browser.stop(); }
});

test("native base ignores child navigation but reserves failed ownership after main navigation", async () => {
  const f = fixture(); const page = await f.browser.acquire(undefined, signal());
  try {
    f.emit("Page.frameNavigated", { frame: { id: "base-child", parentId: "base-main", url: "https://www.liepin.com/child" } }, "session-base");
    await page.release();
    const next = await f.browser.acquire(undefined, signal()); await next.release();
    f.emit("Page.frameNavigated", { frame: { id: "base-main", url: "https://www.liepin.com/other" } }, "session-base");
    await assert.rejects(f.browser.acquire(undefined, signal())); assert.equal(f.browser.hasUnclosed?.(), true);
  } finally { await f.browser.stop(); }
});

test("native inspection reports script errors uncollected and omits stale status after main load failure", async () => {
  const f = fixture(); const page = await f.browser.acquire(undefined, signal());
  try {
    f.commit("main-request", "main-loader");
    f.emit("Network.loadingFailed", { requestId: "main-request", errorText: "net::ERR_CONNECTION_RESET" });
    assert.deepEqual(page.inspect().mainDocument, { state: "failed" });
    assert.equal(page.inspect().scriptErrors, 0); assert.equal(page.inspect().scriptErrorsCollected, false);
  } finally { await f.browser.stop(); }
});

test("native factory refuses an otherwise valid snapshot if a new main request starts during capture", async () => {
  const f = fixture(); const page = await f.browser.acquire(undefined, signal());
  try {
    f.commit("first", "loader-1");
    f.setCaptureHook(() => { f.setCaptureHook(undefined); f.request("second", "loader-2"); });
    const result = await page.capture(signal()); assert.equal(result.state, "navigation_in_progress"); assert.equal(result.snapshot, undefined);
    f.commit("second", "loader-2"); assert.equal((await page.capture(signal())).state, "ready");
  } finally { await f.browser.stop(); }
});

test("native blocked resources retain a valid inspection contract for the existing client", async () => {
  const f = fixture(); const page = await f.browser.acquire(undefined, signal()); const originalFetch = globalThis.fetch;
  try {
    f.commit("main", "loader");
    for (const [resourceType, url] of [["Media", "https://denied.example/video"], ["Other", "https://denied.example/ping"], ["Script", "http://127.0.0.1/private"], ["Script", "https://denied.example/code"]]) {
      f.emit("Fetch.requestPaused", { requestId: `blocked-${resourceType}-${url}`, resourceType, request: { url } });
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.calls.filter((call) => call.method === "Fetch.failRequest").length, 4, "all disallowed resources are blocked, regardless of diagnostic support");
    globalThis.fetch = async () => new Response(JSON.stringify({ ...page.inspect(), snapshotState: "ready", pageState: "original_job", pageLoad: { readyState: "complete", content: "visible_text", visibleFrames: 0 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    const session: JdBrowserSession = { sessionId: "native-review-session-123456", platform: "猎聘", url: source, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const inspected = await inspectJdBrowserSession(session, signal());
    assert.deepEqual(inspected.resources.map((item) => ({ host: item.host, type: item.type })), [{ host: "denied.example", type: "script" }]);
  } finally { globalThis.fetch = originalFetch; await f.browser.stop(); }
});

test("managed proxy mode requires explicit verified proxy before acquiring and rechecks before capture and adoption", async () => {
  const denied = fixture({ networkMode: "managed-proxy" });
  await assert.rejects(denied.browser.acquire("http://127.0.0.1:17891", signal()));
  assert.equal(denied.calls.length, 0); await denied.browser.stop();
  let accepted = true; let checks = 0;
  const f = fixture({ networkMode: "managed-proxy", verifyManagedProxy: async (url) => { checks++; return accepted && url === "http://127.0.0.1:17891"; } });
  try {
    const page = await f.browser.acquire("http://127.0.0.1:17891", signal()); f.commit("main", "loader");
    assert.equal(f.calls.some((call) => call.method === "Target.setAutoAttach" || call.method.startsWith("Runtime.")), false);
    await page.verifyNetwork?.(signal()); const snapshot = await page.capture(signal()); assert.ok(snapshot.identity); assert.equal(await page.current(snapshot.identity, signal()), true);
    assert.ok(checks >= 3); accepted = false;
    await assert.rejects(page.current(snapshot.identity, signal())); await assert.rejects(page.capture(signal()));
    assert.equal(f.browser.hasUnclosed?.(), true);
  } finally { await f.browser.stop(); }
});

test("native diagnostics separate pre-capture document failures without receiving any DOM snapshot", async () => {
  const cases = [
    { reason: "main_not_committed", prepare: (f: ReturnType<typeof fixture>) => f.setFrame({ id: "main", loaderId: "unobserved", url: source }) },
    { reason: "main_pending", prepare: (f: ReturnType<typeof fixture>) => { f.commit("old", "old-loader"); f.request("next", "next-loader"); } },
    { reason: "main_failed", prepare: (f: ReturnType<typeof fixture>) => { f.commit("main", "loader"); f.emit("Network.loadingFailed", { requestId: "main", errorText: "PRIVATE_REMOTE_FAILURE" }); } },
    { reason: "response_not_200", prepare: (f: ReturnType<typeof fixture>) => f.commit("main", "loader", source, { status: 403 }) },
    { reason: "frame_loader_mismatch", prepare: (f: ReturnType<typeof fixture>) => { f.commit("main", "loader"); f.setFrame({ id: "main", loaderId: "other-loader", url: source }); } },
    { reason: "frame_url_mismatch", prepare: (f: ReturnType<typeof fixture>) => { f.commit("main", "loader"); f.setFrame({ id: "main", loaderId: "loader", url: `${source}?private=DO_NOT_COPY` }); } },
    { reason: "source_rejected", prepare: (f: ReturnType<typeof fixture>) => f.commit("main", "loader", "https://outside.invalid/private-auth?token=DO_NOT_COPY") },
  ];
  for (const scenario of cases) {
    const f = fixture(); const page = await f.browser.acquire(undefined, signal());
    try {
      scenario.prepare(f);
      const result = await page.capture(signal());
      assert.equal(result.state, scenario.reason === "main_pending" ? "navigation_in_progress" : "failed");
      assert.deepEqual(result.diagnostic, { stage: "document_state", reason: scenario.reason });
      assert.equal(result.snapshot, undefined); assert.equal(result.identity, undefined); assert.equal(f.captures, 0);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE|DO_NOT_COPY|https?:|token|auth/);
      assert.equal(page.closed, false, "diagnostic failure must preserve the owned job page");
      f.commit("recovered", "recovered-loader");
      const recovered = await page.capture(signal()); assert.equal(recovered.state, "ready"); assert.equal(recovered.diagnostic, undefined);
    } finally { await f.browser.stop(); }
  }
});

test("native fixed capture diagnostics distinguish transport stages and never copy protocol exception text", async () => {
  for (const scenario of ["pre_frame", "snapshot", "after_frame"] as const) {
    const f = fixture(); const page = await f.browser.acquire(undefined, signal());
    try {
      f.commit("main", "loader"); let frameCalls = 0;
      f.setCommandHook(method => {
        if (method === "Page.getFrameTree") frameCalls++;
        if ((scenario === "pre_frame" && method === "Page.getFrameTree") || (scenario === "snapshot" && method === "DOMSnapshot.captureSnapshot")
          || (scenario === "after_frame" && method === "Page.getFrameTree" && frameCalls === 2)) {
          throw new Error("PRIVATE_PROTOCOL_URL=https://outside.invalid/?token=DO_NOT_COPY");
        }
      });
      await assert.rejects(page.capture(signal()), error => {
        assert.ok(error instanceof NativeCaptureError); assert.ok(error instanceof JdExtractionError);
        assert.deepEqual(error.diagnostic, { stage: scenario === "pre_frame" ? "document_state" : "capture", reason: "protocol_unavailable" });
        assert.equal(error.failure.code, "browser_unavailable"); assert.equal(error.cause, undefined);
        assert.doesNotMatch(JSON.stringify(error), /PRIVATE_PROTOCOL|DO_NOT_COPY|outside\.invalid/);
        return true;
      });
      assert.equal(page.closed, false);
      f.setCommandHook(undefined);
      const recovered = await page.capture(signal()); assert.equal(recovered.state, "ready"); assert.equal(recovered.diagnostic, undefined);
    } finally { await f.browser.stop(); }
  }
});

test("native network failure is a fixed document diagnostic and does not masquerade as a projection error", async () => {
  const f = fixture(); const page = await f.browser.acquire(undefined, signal());
  try {
    f.commit("main", "loader");
    f.emit("Target.attachedToTarget", { targetInfo: null });
    await assert.rejects(page.capture(signal()), error => {
      assert.ok(error instanceof NativeCaptureError);
      assert.deepEqual(error.diagnostic, { stage: "document_state", reason: "network_unavailable" });
      return true;
    });
    assert.equal(f.captures, 0); assert.equal(page.closed, false);
  } finally { await f.browser.stop(); }
});

test("native projection diagnostics retain precise fixed shape, layout and size failure reasons", async () => {
  for (const reason of ["snapshot_shape", "snapshot_visibility_unsupported", "snapshot_limit_exceeded"] as const) {
    const f = fixture(); const page = await f.browser.acquire(undefined, signal());
    try {
      f.commit("main", "loader");
      f.setRawCapture(raw => {
        if (reason === "snapshot_shape") return { documents: null, strings: ["PRIVATE_SNAPSHOT_FIELD"] };
        if (reason === "snapshot_limit_exceeded") return { ...raw, strings: ["PRIVATE_SNAPSHOT_FIELD".repeat(500_000)] };
        const doc = raw.documents[0]!; const value = raw.strings.length; raw.strings.push("hidden");
        doc.layout.styles[2]![NATIVE_SNAPSHOT_STYLES.indexOf("overflow-y")] = value;
        return raw;
      });
      const result = await page.capture(signal());
      assert.equal(result.state, reason === "snapshot_limit_exceeded" ? "oversized" : "failed");
      assert.ok(result.diagnostic); assert.equal(result.diagnostic.stage, "projection"); assert.equal(result.diagnostic.reason, reason);
      if (reason === "snapshot_visibility_unsupported") assert.equal(result.diagnostic.detail, "overflow_clip_or_scroll");
      assert.equal(result.snapshot, undefined); assert.equal(result.identity, undefined);
      assert.equal(result.failure, reason === "snapshot_visibility_unsupported" ? "visibility_unsupported" : "snapshot_invalid");
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SNAPSHOT|https?:|token/);
      f.setRawCapture(undefined);
      const recovered = await page.capture(signal()); assert.equal(recovered.state, "ready"); assert.equal(recovered.diagnostic, undefined);
    } finally { await f.browser.stop(); }
  }
});

test("native unexpected projection exceptions have their own fixed reason without copying exception data", async () => {
  const f = fixture(); const page = await f.browser.acquire(undefined, signal());
  try {
    f.commit("main", "loader");
    f.setRawCapture(() => ({ strings: [], get documents() { throw new Error("PRIVATE_PROJECTION_DETAIL=https://outside.invalid/?token=DO_NOT_COPY"); } }));
    const result = await page.capture(signal());
    assert.equal(result.state, "failed"); assert.equal(result.failure, "snapshot_invalid");
    assert.deepEqual(result.diagnostic, { stage: "projection", reason: "projection_internal_error" });
    assert.equal(result.snapshot, undefined); assert.equal(result.identity, undefined);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROJECTION|DO_NOT_COPY|outside\.invalid/);
  } finally { await f.browser.stop(); }
});

test("native missing body remains navigation in progress before DOMContentLoaded and diagnostic failure after it", async () => {
  const f = fixture(); const page = await f.browser.acquire(undefined, signal());
  try {
    f.commit("main", "loader", source, { loaded: false });
    f.setRawCapture(raw => { raw.strings[raw.documents[0]!.nodes.nodeName[3]!] = "SECTION"; return raw; });
    const parsing = await page.capture(signal());
    assert.equal(parsing.state, "navigation_in_progress");
    assert.deepEqual(parsing.diagnostic, { stage: "projection", reason: "document_body_missing" });
    assert.equal(parsing.snapshot, undefined);
    f.emit("Page.lifecycleEvent", { frameId: "main", loaderId: "loader", name: "DOMContentLoaded" });
    const complete = await page.capture(signal());
    assert.equal(complete.state, "failed");
    assert.deepEqual(complete.diagnostic, { stage: "projection", reason: "document_body_missing" });
    f.setRawCapture(undefined);
    const recovered = await page.capture(signal()); assert.equal(recovered.state, "ready"); assert.equal(recovered.diagnostic, undefined);
    assert.equal(recovered.snapshot?.pageLoad?.readyState, "interactive");
  } finally { await f.browser.stop(); }
});

test("native post-projection frame failure is distinct and prevents otherwise valid text adoption", async () => {
  const f = fixture(); const page = await f.browser.acquire(undefined, signal());
  try {
    f.commit("main", "loader"); let frameCalls = 0;
    f.setCommandHook(method => { if (method === "Page.getFrameTree" && ++frameCalls === 3) throw new Error("PRIVATE_POST_PROTOCOL_DETAIL"); });
    const result = await page.capture(signal());
    assert.equal(result.state, "failed"); assert.equal(result.failure, "snapshot_invalid");
    assert.deepEqual(result.diagnostic, { stage: "post_projection", reason: "protocol_unavailable" });
    assert.equal(result.snapshot, undefined); assert.equal(result.identity, undefined); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_POST/);
    f.setCommandHook(undefined); assert.equal((await page.capture(signal())).diagnostic, undefined);
  } finally { await f.browser.stop(); }
});

test("native generation changes are classified at capture or post-projection and never return an old identity", async () => {
  for (const stage of ["capture", "post_projection"] as const) {
    const f = fixture(); const page = await f.browser.acquire(undefined, signal());
    try {
      f.commit("first", "loader-1"); let frameCalls = 0;
      f.setCommandHook(method => {
        if (method === "Page.getFrameTree" && ++frameCalls === (stage === "capture" ? 2 : 3)) f.commit("replacement", "loader-2");
      });
      const result = await page.capture(signal());
      assert.equal(result.state, "navigation_in_progress"); assert.deepEqual(result.diagnostic, { stage, reason: "navigation_changed" });
      assert.equal(result.snapshot, undefined); assert.equal(result.identity, undefined);
      f.setCommandHook(undefined);
      const recovered = await page.capture(signal()); assert.equal(recovered.state, "ready"); assert.equal(recovered.diagnostic, undefined);
    } finally { await f.browser.stop(); }
  }
});

test("native failed recheck after projection reports network stage while retaining the prior page", async () => {
  const f = fixture(); const page = await f.browser.acquire(undefined, signal());
  try {
    f.commit("main", "loader"); let frameCalls = 0;
    f.setCommandHook(method => {
      if (method === "Page.getFrameTree" && ++frameCalls === 3) f.emit("Target.attachedToTarget", { targetInfo: null });
    });
    const result = await page.capture(signal());
    assert.equal(result.state, "failed"); assert.deepEqual(result.diagnostic, { stage: "post_projection", reason: "network_unavailable" });
    assert.equal(result.snapshot, undefined); assert.equal(result.identity, undefined); assert.equal(page.closed, false);
  } finally { await f.browser.stop(); }
});

/** Pure protocol fixture with complete JD text and an unrelated clipped banner. */
function nativeShareSnapshot(raw: ReturnType<typeof snapshot>) {
  const strings = [...raw.strings];
  const str = (text: string) => { const known = strings.indexOf(text); if (known >= 0) return known; strings.push(text); return strings.length - 1; };
  const original = raw.documents[0]!;
  const baseStyle = [...original.layout.styles[0]!];
  const bannerStyle = [...baseStyle]; bannerStyle[NATIVE_SNAPSHOT_STYLES.indexOf("overflow-y")] = str("hidden");
  const description = "SYNTHETIC_SCOPE_JD 岗位职责：维护企业软件系统，分析生产问题，编写维护文档并完成回归。任职要求：熟悉网络、数据库及异步编程。";
  const banner = "SYNTHETIC_UNADOPTED_BANNER";
  const box: [number, number, number, number] = [0, 0, 900, 200];
  return {
    strings,
    documents: [{
      ...original,
      nodes: {
        nodeType: [9, 1, 1, 1, 1, 1, 1, 3, 1, 3],
        parentIndex: [-1, 0, 1, 1, 3, 4, 5, 6, 4, 8],
        nodeName: ["#document", "HTML", "HEAD", "BODY", "DIV", "DIV", "DIV", "#text", "DIV", "#text"].map(str),
        nodeValue: [-1, -1, -1, -1, -1, -1, -1, str(description), -1, str(banner)],
        backendNodeId: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        attributes: [[], [], [], [], [str("class"), str("share-position")], [str("class"), str("rec-detail")], [str("class"), str("detail-text show-switch")], [], [str("class"), str("banner")], []],
      },
      layout: {
        nodeIndex: [1, 3, 4, 5, 6, 7, 8, 9],
        styles: [baseStyle, baseStyle, baseStyle, baseStyle, baseStyle, [], bannerStyle, []],
        bounds: [box, box, box, box, box, box, box, box],
        text: [-1, -1, -1, -1, -1, str(description), -1, str(banner)],
        textColorOpacities: [1, 1, 1, 1, 1, 1, 1, 1],
      },
      textBoxes: { layoutIndex: [5, 7], bounds: [box, box], start: [0, 0], length: [description.length, banner.length] },
    }],
  };
}

test("native BOSS factory scopes only an original mobile share capture with explicit matching source", async () => {
  const mobile = "https://m.zhipin.com/mpa/html/weijd/weijd-job/syntheticNativeScope?fromSource=2";
  const f = fixture({ platform: "BOSS直聘" }); const page = await f.browser.acquire(undefined, signal());
  try {
    f.commit("main", "loader", mobile); f.setRawCapture(nativeShareSnapshot);
    for (const original of [undefined, mobile.replace("syntheticNativeScope", "wrongJob")]) {
      const result = await page.capture(signal(), 1000, original);
      assert.equal(result.state, "failed"); assert.equal(result.failure, "visibility_unsupported");
      assert.deepEqual(result.diagnostic, { stage: "projection", reason: "snapshot_visibility_unsupported", detail: "overflow_clip_or_scroll" });
      assert.equal(result.snapshot, undefined); assert.equal(result.identity, undefined);
    }
    const result = await page.capture(signal(), 1000, mobile);
    assert.equal(result.state, "ready"); assert.ok(result.identity); assert.ok(result.snapshot?.html.includes("SYNTHETIC_SCOPE_JD"));
    assert.doesNotMatch(result.snapshot!.html, /SYNTHETIC_UNADOPTED_BANNER|class="banner"/);
    assert.equal(result.snapshot?.url, mobile); assert.equal(await page.current(result.identity, signal()), true);
    assert.equal(f.captures, 3); assert.equal(page.inspect().mainDocumentRequests, 1);
    assert.equal(f.calls.some(call => ["Page.navigate", "Runtime.enable", "Runtime.evaluate", "Runtime.callFunctionOn"].includes(call.method)), false);
  } finally { await f.browser.stop(); }
});

test("native BOSS desktop URLs keep full-page validation even with share-shaped DOM and matching source", async () => {
  const f = fixture({ platform: "BOSS直聘" }); const page = await f.browser.acquire(undefined, signal());
  try {
    f.commit("main", "loader", bossSource); f.setRawCapture(nativeShareSnapshot);
    const result = await page.capture(signal(), 1000, bossSource);
    assert.equal(result.state, "failed"); assert.deepEqual(result.diagnostic, { stage: "projection", reason: "snapshot_visibility_unsupported", detail: "overflow_clip_or_scroll" });
    assert.equal(result.snapshot, undefined); assert.equal(result.identity, undefined); assert.equal(page.closed, false);
  } finally { await f.browser.stop(); }
});

test("native BOSS search purpose never adopts the detail-share scope even for a matching mobile share URL", async () => {
  const mobile = "https://m.zhipin.com/mpa/html/weijd/weijd-job/syntheticNativeSearchScope?fromSource=2";
  const f = fixture({ platform: "BOSS直聘" }); const page = await f.browser.acquire(undefined, signal());
  try {
    f.commit("main", "loader", mobile); f.setRawCapture(nativeShareSnapshot);
    const detail = await page.capture(signal(), 1000, mobile);
    assert.equal(detail.state, "ready"); assert.ok(detail.snapshot?.html.includes("SYNTHETIC_SCOPE_JD"));
    const search = await page.capture(signal(), 1000, mobile, { purpose: "search" });
    assert.equal(search.state, "ready"); assert.ok(search.identity);
    assert.match(search.snapshot!.html, /SYNTHETIC_SCOPE_JD/);
    assert.match(search.snapshot!.html, /<div class="banner"><\/div>/);
    assert.doesNotMatch(search.snapshot!.html, /SYNTHETIC_UNADOPTED_BANNER/);
    assert.equal(search.expansionPlan, undefined);
    const detailAgain = await page.capture(signal(), 1000, mobile);
    assert.equal(detailAgain.state, "ready"); assert.equal(detailAgain.snapshot?.html, detail.snapshot?.html);
    assert.equal(f.calls.some(call => ["Runtime.enable", "Runtime.evaluate", "Runtime.callFunctionOn"].includes(call.method)), false);
    assert.equal(f.calls.filter(call => call.method === "DOM.getDocument").length, 2);
  } finally { await f.browser.stop(); }
});

test("native BOSS search page preserves visible job links with fresh root identity and without detail scope or page-script execution", async () => {
  const searchUrl = "https://www.zhipin.com/web/geek/job?query=C%23&city=101020100";
  const f = fixture({ platform: "BOSS直聘" }); const page = await f.browser.acquire(undefined, signal());
  try {
    f.commit("main", "loader", searchUrl);
    f.setRawCapture(raw => {
      const doc = raw.documents[0]!;
      const str = (value: string) => { const known = raw.strings.indexOf(value); return known >= 0 ? known : raw.strings.push(value) - 1; };
      doc.nodes.nodeName[4] = str("A");
      doc.nodes.attributes[4] = [str("class"), str("job-name"), str("href"), str(bossSource), str("onclick"), str("PRIVATE_EVENT")];
      return raw;
    });
    const captured = await page.capture(signal(), 1000, searchUrl, { purpose: "search" });
    assert.equal(captured.state, "ready"); assert.equal(captured.snapshot?.url, searchUrl); assert.ok(captured.identity);
    assert.ok(captured.snapshot?.html.includes(`href="${bossSource}"`));
    assert.doesNotMatch(captured.snapshot!.html, /PRIVATE_EVENT|onclick=/);
    assert.equal(f.calls.some(call => ["Runtime.enable", "Runtime.evaluate", "Runtime.callFunctionOn"].includes(call.method)), false);
    assert.equal(f.calls.filter(call => call.method === "DOM.getDocument").length, 2);
    assert.deepEqual(f.calls.find(call => call.method === "DOMSnapshot.captureSnapshot")!.params.computedStyles, [...NATIVE_ROOT_SCROLL_STYLES]);
  } finally { await f.browser.stop(); }
});

test("native Liepin factory never enables BOSS share scope from source input or share-shaped DOM", async () => {
  const f = fixture(); const page = await f.browser.acquire(undefined, signal());
  try {
    f.commit("main", "loader", source); f.setRawCapture(nativeShareSnapshot);
    for (const original of [source, "https://m.zhipin.com/mpa/html/weijd/weijd-job/syntheticNativeScope"]) {
      const result = await page.capture(signal(), 1000, original);
      assert.equal(result.state, "failed"); assert.deepEqual(result.diagnostic, { stage: "projection", reason: "snapshot_visibility_unsupported", detail: "overflow_clip_or_scroll" });
      assert.equal(result.snapshot, undefined); assert.equal(result.identity, undefined);
    }
    assert.equal(f.captures, 2); assert.equal(page.closed, false); assert.equal(page.inspect().mainDocumentRequests, 1);
  } finally { await f.browser.stop(); }
});

test("native original Liepin capture brackets the extended snapshot with fresh same-document root evidence", async () => {
  const mobile = source.replace("www.liepin.com", "m.liepin.com") + "?share=1";
  const f = fixture(); const page = await f.browser.acquire(undefined, signal());
  try {
    f.commit("original", "loader", mobile); f.setRawCapture(rootScrollSnapshot);
    const start = f.calls.length;
    const result = await page.capture(signal(), 1000, source);
    assert.equal(result.state, "ready"); assert.ok(result.identity);
    assert.ok(result.snapshot?.html.includes("熟悉网络、数据库及异步编程"));
    assert.equal(result.snapshot?.url, mobile); assert.equal(await page.current(result.identity, signal()), true);
    const captureCalls = f.calls.slice(start).filter(call => ["DOM.getDocument", "DOMSnapshot.captureSnapshot"].includes(call.method));
    assert.deepEqual(captureCalls.map(call => call.method), ["DOM.getDocument", "DOMSnapshot.captureSnapshot", "DOM.getDocument"]);
    for (const call of captureCalls) assert.equal(call.sessionId, "session-job-1");
    for (const call of captureCalls.filter(call => call.method === "DOM.getDocument")) assert.deepEqual(call.params, { depth: 0, pierce: false });
    assert.deepEqual(captureCalls[1]!.params, { computedStyles: [...NATIVE_LIEPIN_PARAGRAPH_STYLES], includeDOMRects: true, includeTextColorOpacities: true });
    assert.equal(f.calls.some(call => ["Page.navigate", "Runtime.enable", "Runtime.evaluate", "Runtime.callFunctionOn"].includes(call.method)), false);
    assert.equal(page.inspect().mainDocumentRequests, 1); assert.equal(page.closed, false);
  } finally { await f.browser.stop(); }
});

test("native owned same-job capture returns only validated office sidecars and keeps address CSS optional for its JD", async () => {
  for (const clipped of [false, true]) {
    const f = fixture(), page = await f.browser.acquire(undefined, signal());
    try {
      f.commit("original", "loader"); f.setRawCapture(raw => visibleOfficeSnapshot(raw, clipped));
      const result = await page.capture(signal(), 1000, source);
      assert.equal(result.state, "ready"); assert.ok(result.identity); assert.ok(result.snapshot?.html.includes("SYNTHETIC_NATIVE_OFFICE_JD"));
      assert.doesNotMatch(result.snapshot!.html, /合成办公路100号|工作地址/);
      assert.deepEqual(result.snapshot?.visibleOfficeDisclosures, clipped ? undefined : [{ selector: "liepin-work-address", label: "工作地址", text: "上海市浦东新区合成办公路100号 A座" }]);
      assert.equal(result.snapshot?.url, source); assert.equal(await page.current(result.identity!, signal()), true);
      assert.equal(f.calls.filter(call => call.method === "DOM.getDocument").length, 2);
      assert.equal(f.calls.some(call => ["Page.navigate", "Runtime.enable", "Runtime.evaluate", "Runtime.callFunctionOn"].includes(call.method)), false);
      assert.equal(page.inspect().mainDocumentRequests, 1);
    } finally { await f.browser.stop(); }
  }
});

test("native original Liepin capture scopes validated description geometry while preserving the owned document evidence", async () => {
  const f = fixture(); const page = await f.browser.acquire(undefined, signal());
  try {
    f.commit("original", "loader");
    f.setRawCapture(raw => {
      const scoped = rootScrollSnapshot(raw);
      const doc = scoped.documents[0]!; const nodes = doc.nodes; const layout = doc.layout;
      const str = (text: string) => { const at = scoped.strings.indexOf(text); if (at >= 0) return at; scoped.strings.push(text); return scoped.strings.length - 1; };
      const marker = "UNRELATED_CLIPPED_BANNER_NOT_A_DESCRIPTION";
      const banner = nodes.nodeType.length, text = banner + 1;
      nodes.nodeType.push(1, 3); nodes.parentIndex.push(3, banner);
      nodes.nodeName.push(str("DIV"), str("#text")); nodes.nodeValue.push(-1, str(marker));
      nodes.backendNodeId.push(banner + 1, text + 1); nodes.attributes.push([str("class"), str("unrelated-banner")], []);
      const styles = [...layout.styles[1]!]; styles[NATIVE_SNAPSHOT_STYLES.indexOf("overflow-y")] = str("hidden");
      const textLayout = layout.nodeIndex.length + 1;
      layout.nodeIndex.push(banner, text); layout.styles.push(styles, []);
      layout.bounds.push([0, 0, 100, 20], [0, 0, 100, 20]); layout.text.push(-1, str(marker)); layout.textColorOpacities.push(1, 1);
      layout.offsetRects.push([], []); layout.clientRects.push([], []); layout.scrollRects.push([], []);
      doc.textBoxes.layoutIndex.push(textLayout); doc.textBoxes.bounds.push([0, 0, 100, 20]); doc.textBoxes.start.push(0); doc.textBoxes.length.push(marker.length);
      return scoped;
    });
    const result = await page.capture(signal(), 1000, source);
    assert.equal(result.state, "ready"); assert.ok(result.identity);
    assert.ok(result.snapshot?.html.includes("熟悉网络、数据库及异步编程"));
    assert.doesNotMatch(result.snapshot!.html, /UNRELATED_CLIPPED|unrelated-banner/);
    assert.equal(result.snapshot?.url, source); assert.equal(await page.current(result.identity!, signal()), true);
    assert.equal(f.calls.filter(call => call.method === "DOM.getDocument").length, 2);
    assert.equal(f.calls.some(call => call.method === "Page.navigate"), false);
    assert.equal(page.inspect().mainDocumentRequests, 1); assert.equal(page.closed, false);
  } finally { await f.browser.stop(); }
});

test("native Liepin capture refuses missing, nonstandard or wrong-document root evidence", async () => {
  const root = documentRoot();
  const cases = [undefined, null, [], {}, { ...root, compatibilityMode: undefined }, { ...root, compatibilityMode: "QuirksMode" },
    { ...root, compatibilityMode: "LimitedQuirksMode" }, { ...root, nodeType: 1 }, { ...root, backendNodeId: 0 },
    { ...root, backendNodeId: "1" }, { ...root, documentURL: `${source}?other-document=1` }, { ...root, frameId: "other-frame" }];
  for (const evidence of cases) {
    const f = fixture(); const page = await f.browser.acquire(undefined, signal());
    try {
      f.commit("original", "loader"); f.setRawCapture(rootScrollSnapshot);
      f.setCommandHook(method => method === "DOM.getDocument" ? { root: evidence } : undefined);
      const result = await page.capture(signal(), 1000, source);
      assert.equal(result.state, "failed"); assert.equal(result.failure, "visibility_unsupported");
      assert.deepEqual(result.diagnostic, { stage: "capture", reason: "snapshot_visibility_unsupported", detail: "overflow_clip_or_scroll" });
      assert.equal(result.snapshot, undefined); assert.equal(result.identity, undefined); assert.equal(page.closed, false);
    } finally { await f.browser.stop(); }
  }
});

test("native Liepin root identity must stay stable before and after capture and match snapshot backend ID", async () => {
  for (const field of ["backendNodeId", "nodeType", "documentURL", "compatibilityMode", "frameId"] as const) {
    const f = fixture(); const page = await f.browser.acquire(undefined, signal());
    try {
      f.commit("original", "loader"); f.setRawCapture(rootScrollSnapshot); let reads = 0;
      f.setCommandHook(method => {
        if (method === "DOM.getDocument") return { root: { ...documentRoot(), ...(++reads === 2 ? { [field]: field === "backendNodeId" ? 99 : field === "nodeType" ? 1 : "changed" } : {}) } };
      });
      const result = await page.capture(signal(), 1000, source);
      assert.equal(result.state, "navigation_in_progress"); assert.deepEqual(result.diagnostic, { stage: "capture", reason: "navigation_changed" });
      assert.equal(result.snapshot, undefined); assert.equal(result.identity, undefined); assert.equal(page.closed, false);
    } finally { await f.browser.stop(); }
  }
  const f = fixture(); const page = await f.browser.acquire(undefined, signal());
  try {
    f.commit("original", "loader"); f.setRawCapture(rootScrollSnapshot);
    f.setCommandHook(method => method === "DOM.getDocument" ? { root: { ...documentRoot(), backendNodeId: 99 } } : undefined);
    const result = await page.capture(signal(), 1000, source);
    assert.equal(result.state, "failed"); assert.deepEqual(result.diagnostic, { stage: "projection", reason: "snapshot_visibility_unsupported", detail: "overflow_clip_or_scroll" });
    assert.equal(result.snapshot, undefined); assert.equal(result.identity, undefined);
  } finally { await f.browser.stop(); }
});

test("native Liepin root evidence cannot adopt an older frame if main navigation changes between samples", async () => {
  const f = fixture(); const page = await f.browser.acquire(undefined, signal());
  try {
    f.commit("original", "loader"); f.setRawCapture(rootScrollSnapshot); let reads = 0;
    f.setCommandHook(method => { if (method === "DOM.getDocument" && ++reads === 2) f.commit("replacement", "loader-2"); });
    const result = await page.capture(signal(), 1000, source);
    assert.equal(result.state, "navigation_in_progress"); assert.deepEqual(result.diagnostic, { stage: "capture", reason: "navigation_changed" });
    assert.equal(result.snapshot, undefined); assert.equal(result.identity, undefined); assert.equal(page.closed, false);
  } finally { await f.browser.stop(); }
});

test("native root protocol failure preserves its fixed capture category and owned job page", async () => {
  for (const at of [1, 2]) {
    const f = fixture(); const page = await f.browser.acquire(undefined, signal());
    try {
      f.commit("original", "loader"); f.setRawCapture(rootScrollSnapshot); let reads = 0;
      f.setCommandHook(method => { if (method === "DOM.getDocument" && ++reads === at) throw new Error("PRIVATE_ROOT_DOCUMENT_URL=https://outside.invalid/?token=DO_NOT_COPY"); });
      await assert.rejects(page.capture(signal(), 1000, source), error => {
        assert.ok(error instanceof NativeCaptureError); assert.deepEqual(error.diagnostic, { stage: "capture", reason: "protocol_unavailable" });
        assert.doesNotMatch(JSON.stringify(error), /PRIVATE_ROOT|DO_NOT_COPY|outside\.invalid/); return true;
      });
      assert.equal(page.closed, false);
    } finally { await f.browser.stop(); }
  }
});

test("native root compatibility never expands capture capabilities for wrong source, login, intermediate or BOSS pages", async () => {
  for (const scenario of [
    { platform: "猎聘" as const, url: source, original: undefined },
    { platform: "猎聘" as const, url: source, original: source.replace("1984701079", "1984701080") },
    { platform: "猎聘" as const, url: source, original: source.replace("https:", "http:") },
    { platform: "猎聘" as const, url: "https://www.liepin.com/login", original: source },
    { platform: "猎聘" as const, url: "https://www.liepin.com/redirect", original: source },
    { platform: "猎聘" as const, url: "https://wow.liepin.com/t1012695/4410f519.html", original: source },
    { platform: "BOSS直聘" as const, url: bossSource, original: bossSource },
  ]) {
    const f = fixture({ platform: scenario.platform }); const page = await f.browser.acquire(undefined, signal());
    try {
      f.commit("main", "loader", scenario.url);
      await page.capture(signal(), 1000, scenario.original);
      assert.equal(f.calls.some(call => call.method === "DOM.getDocument"), false);
      for (const call of f.calls.filter(call => call.method === "DOMSnapshot.captureSnapshot")) assert.deepEqual(call.params.computedStyles, [...NATIVE_SNAPSHOT_STYLES]);
    } finally { await f.browser.stop(); }
  }
});
