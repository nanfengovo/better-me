import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test, { after, afterEach, mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Window } from "happy-dom";
import { SourceDefinitionSchema, type AtlasDataset } from "@better-me/opportunities";
import { createAtlasDemo } from "../src/components/atlas/demo.ts";

const dom = new Window({ url: "http://atlas-source-fixture.invalid" });
const React = await import("react");
const { createElement: h, act } = React;
const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const hooks = registerHooks({ load(url, context, nextLoad) { return url.endsWith(".css") ? { source: "export {};", format: "module", shortCircuit: true } : nextLoad(url, context); } });
const { createRoot } = await import("react-dom/client");
const { AtlasSourcesPanel } = await import("../src/components/atlas/AtlasSourcesPanel.tsx");
const { sourceCatalog } = await import("../src/components/atlas/source-catalog.ts");
let root: ReturnType<typeof createRoot> | undefined;
const at = "2026-10-18T12:00:00.000Z";
const source = { ...SourceDefinitionSchema.parse(JSON.parse(readFileSync(new URL("../../../config/sources/examples.json", import.meta.url), "utf8"))[0]), enabled: true, status: "active" as const };
const discoverySource = { ...source, sourceId: "synthetic-discovery", name: "Synthetic discovery policy", adapterId: "mapped-json", capabilities: ["list-jobs", "discover-sources"] as const, entryUrl: undefined, options: undefined };
const adapters = [{ adapterId: source.adapterId, version: "1", capabilities: ["list-jobs"], remoteFilters: [], entityTypes: ["job-posting"] }, { adapterId: "mapped-json", version: "1", capabilities: ["list-jobs"], remoteFilters: [], entityTypes: ["discovery-lead", "job-posting"] }];
const response = (value: unknown) => new Response(JSON.stringify({ ok: true, requestId: "synthetic-panel-request", value }));
const receipt = { ok: true, revision: 2, jobIds: [], snapshotIds: [], counts: { newJobs: 0, updatedJobs: 0, unchangedJobs: 0, newListings: 0, newObservations: 0, newSnapshots: 0 } };
const snapshot = createAtlasDemo();
async function waitFor(condition: () => boolean, description: string) {
  const deadline = performance.now() + 5000;
  while (!condition()) { assert.ok(performance.now() < deadline, `Timed out: ${description}: ${dom.document.body.textContent?.slice(-1500)}`); await act(async () => { await delay(10); }); }
}
async function render(token = "synthetic-panel-token", onSnapshot = (_data: AtlasDataset) => {}, endpoint = "http://127.0.0.1:5178") {
  dom.document.body.innerHTML = "<main></main>"; root = createRoot(dom.document.querySelector("main")! as unknown as Element);
  await act(async () => root!.render(h(AtlasSourcesPanel, { endpoint, token, onSnapshot, onClose: () => {} })));
  await waitFor(() => dom.document.querySelector("section")?.getAttribute("aria-busy") === "false", "initial source read");
}
function button(text: string) { const element = [...dom.document.querySelectorAll("button")].find((node) => node.textContent?.trim() === text); assert.ok(element, `Missing button: ${text}`); return element; }
function field(label: string) { const element = [...dom.document.querySelectorAll("label")].find((node) => node.childNodes[0]?.textContent === label)?.querySelector("input,textarea,select"); assert.ok(element, `Missing field: ${label}`); return element; }
async function change(label: string, value: string) {
  const element = field(label); await act(async () => {
    const prototype = element.tagName === "TEXTAREA" ? dom.HTMLTextAreaElement.prototype : element.tagName === "SELECT" ? dom.HTMLSelectElement.prototype : dom.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new dom.Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    element.dispatchEvent(new dom.Event("change", { bubbles: true }));
  });
}
async function click(text: string) { await act(async () => button(text).click()); await waitFor(() => dom.document.querySelector("section")?.getAttribute("aria-busy") === "false", text); }
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; mock.restoreAll(); });
after(() => { hooks.deregister(); dom.happyDOM.abort(); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });

test("missing token leaves real tools inactive and does not request localhost", async () => {
  const fetcher = mock.method(globalThis, "fetch", async () => { throw new Error("must not fetch"); });
  await render(""); assert.match(dom.document.body.textContent!, /请先连接岗位后端/); assert.equal(fetcher.mock.callCount(), 0);
  assert.equal(button("更新地图快照").disabled, true);
});

test("catalog addition is explicit, preserves unknown-write identity and never fetches jobs or overwrites an existing source", async () => {
  const preset = sourceCatalog[0]; assert.ok(preset, "a verified real catalog preset must be present");
  const installed = [source]; const writes: Array<{ body: any; key: string | null }> = [];
  const paths: string[] = []; let updates = 0;
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname; paths.push(path);
    if (path === "/api/v1/sources" && !init?.body) return response({ sources: installed, adapters });
    if (path === "/api/v1/dataset/export") return response({ ...snapshot, sources: [...snapshot.sources, ...installed] });
    assert.equal(path, "/api/v1/sources");
    const body = JSON.parse(String(init!.body)); writes.push({ body, key: new Headers(init!.headers).get("Idempotency-Key") });
    if (writes.length === 1) throw new TypeError("Synthetic response lost after registration");
    installed.push(body.source); return response(receipt);
  });
  await render("synthetic-panel-token", () => { updates++; });
  assert.equal(writes.length, 0, "opening source tools must not add or activate sources");
  const card = [...dom.document.querySelectorAll(".atlas-catalog-list article")].find((node) => node.textContent?.includes(preset.source.attribution.label))!;
  assert.ok(card);
  await act(async () => card.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await click("添加并启用所选 1 个来源");
  assert.equal(writes.length, 1); assert.equal(updates, 0);
  await click("添加并启用所选 1 个来源");
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1], writes[0], "ambiguous retries keep the exact body, revision and key");
  assert.equal(writes[0]!.body.source.enabled, true); assert.equal(writes[0]!.body.source.status, "active");
  assert.equal(writes[0]!.body.source.sourceId, preset.source.sourceId);
  assert.equal(installed[0], source); assert.equal(updates, 1);
  assert.ok(paths.every((path) => ["/api/v1/sources", "/api/v1/dataset/export"].includes(path)));
  assert.ok(!dom.document.querySelector(".atlas-catalog-list")!.textContent!.includes(preset.source.attribution.label), "registered preset no longer offered for overwrite");
});

test("company website discovery displays incomplete coverage without treating an entry as a job or registering it", async () => {
  const paths: string[] = []; let updates = 0;
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname; paths.push(path);
    if (path === "/api/v1/sources") return response({ sources: [discoverySource], adapters });
    assert.equal(path, "/api/v1/companies/discover-careers");
    assert.deepEqual(JSON.parse(String(init!.body)), {
      request: { companyName: "Synthetic New Employer", limit: 10, maxPages: 3 } });
    return response({ status: "requires-company-website", companyName: "Synthetic New Employer", observedAt: at,
      matchedSources: [], candidates: [], proposals: [], visitedUrls: [], partial: false, warnings: ["Synthetic missing search provider."] });
  });
  await render("synthetic-panel-token", () => { updates++; });
  await change("企业名称", "Synthetic New Employer");
  await click("查找企业招聘来源");
  await waitFor(() => Boolean(dom.document.querySelector('[aria-label="企业官网发现结果"]')), "company discovery result");
  assert.match(dom.document.querySelector('[aria-label="企业官网发现结果"]')!.textContent!, /需要补充企业官网或配置网页搜索提供方/);
  assert.match(dom.document.querySelector('[aria-label="企业官网发现结果"]')!.textContent!, /尚未执行岗位搜索或注册新来源/);
  assert.deepEqual(paths, ["/api/v1/sources", "/api/v1/companies/discover-careers"]);
  assert.equal(updates, 0);
});

test("discovery-only policy cannot trigger job preview or sync despite its compatibility list-jobs flag", async () => {
  const fetcher = mock.method(globalThis, "fetch", async () => response({ sources: [discoverySource], adapters }));
  await render();
  assert.equal(button("预览一页 · 不写入").disabled, true); assert.equal(button("手动刷新并更新地图").disabled, true);
  assert.match(dom.document.body.textContent!, /未提供可列举岗位的端点或字段映射/);
  assert.equal(fetcher.mock.callCount(), 1);
});

test("scope preview and finite sync use real routes and update the map only with the public snapshot", async () => {
  const requests: Array<{ path: string; body?: any; init?: RequestInit }> = []; let received: AtlasDataset | undefined;
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname; const body = init?.body ? JSON.parse(String(init.body)) : undefined; requests.push({ path, body, init });
    if (path.endsWith("/preview")) return response({ page: { records: [], observedAt: at, coverage: { complete: true, partial: false, fetchedRecords: 0, appliedFilters: [], ignoredFilters: ["roles", "regions", "companyNames"] }, warnings: [] }, localMatchedRecords: 0, localFilters: body.scope });
    if (path.endsWith("/sync")) return response({ run: { runId: "synthetic-run", sourceId: source.sourceId, actorScope: "local-owner", generation: 1, scope: {}, status: "partial", startedAt: at, summary: { records: 4, pages: 2, leads: 1, partial: true } }, localFilters: body.scope, warnings: ["Synthetic page limit reached"] });
    if (path.endsWith("/dataset/export")) return response(snapshot);
    return response({ sources: [source], adapters });
  });
  await render("synthetic", (data) => { received = data; });
  await change("岗位关键词 · 逗号分隔", "TypeScript, 自动化"); await change("地区 · 逗号分隔", "上海"); await change("公司 · 逗号分隔", "Synthetic");
  await change("记录上限", "15"); await change("刷新页数上限", "2");
  await click("预览一页 · 不写入");
  const preview = requests.find((entry) => entry.path.endsWith("/preview"))!;
  assert.deepEqual(preview.body, { scope: { roles: ["TypeScript", "自动化"], regions: ["上海"], companyNames: ["Synthetic"] }, maxRecords: 15 });
  assert.equal(received, undefined);
  await click("手动刷新并更新地图");
  const sync = requests.find((entry) => entry.path.endsWith("/sync"))!;
  assert.deepEqual(sync.body, { ...preview.body, maxPages: 2 }); assert.ok(new Headers(sync.init?.headers).get("Idempotency-Key"));
  assert.equal(received?.jobs.length, 22); assert.match(dom.document.body.textContent!, /刷新回执: partial/); assert.match(dom.document.body.textContent!, /Synthetic page limit reached/);
});

test("JSON array requires per-source review and ambiguous registration retries reuse the exact body and key", async () => {
  const writes: Array<{ body: any; key: string | null }> = []; let snapshots = 0;
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/dataset/export")) { snapshots++; return response(snapshot); }
    if (init?.method === "POST") { writes.push({ body: JSON.parse(String(init.body)), key: new Headers(init.headers).get("Idempotency-Key") }); if (writes.length === 1) throw new TypeError("synthetic response lost after submit"); return response(receipt); }
    return response({ sources: [source], adapters });
  });
  await render(); await change("完整来源 JSON", JSON.stringify([{ ...source, enabled: false, status: "needs-review" }, { ...source, sourceId: "synthetic-second", enabled: false, status: "needs-review" }]));
  await click("检查 JSON"); assert.equal(writes.length, 0); assert.equal(button("保存所选来源").disabled, true);
  await change("本次保存项", "1");
  const checkbox = dom.document.querySelector('.atlas-sources-check input[type="checkbox"]')!;
  await act(async () => checkbox.click()); await click("保存所选来源");
  assert.equal(writes.length, 1); assert.equal(writes[0]!.body.source.sourceId, "synthetic-second"); assert.equal(writes[0]!.body.source.enabled, false); assert.equal(snapshots, 1);
  await click("保存所选来源"); assert.equal(writes.length, 2); assert.deepEqual(writes[1], writes[0]); assert.equal(snapshots, 2);
});

test("GitHub candidates show original provenance and unknown license; inspection and proposal never auto-register", async () => {
  const candidate = { candidateId: "synthetic-candidate", provider: "github-repositories", homeUrl: "https://github.com/example/jobs", discoveredAt: at, status: "needs-review", repository: { fullName: "example/jobs", description: "Synthetic source metadata" }, entryHints: [], evidenceUrls: ["https://github.com/example/jobs"], warnings: ["License must be reviewed"] };
  const sample = { url: "https://raw.githubusercontent.com/example/jobs/main/jobs.json", format: "json", sampledRecords: 3, truncated: false, fields: [{ path: "title", types: ["string"], present: 3 }], coverage: { identity: true, title: true, url: true, description: false, locations: false, salary: false, recordTime: false }, warnings: [] };
  const paths: string[] = [];
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname; paths.push(`${init?.method ?? "GET"} ${path}`);
    if (path.endsWith("/discover")) return response({ candidates: [candidate], observedAt: at, totalAvailable: 1, partial: false, warnings: [] });
    if (path.endsWith("/inspect")) return response({ candidateId: candidate.candidateId, inspectedAt: at, samples: [sample], discoveredEntries: [], partial: false, warnings: [] });
    if (path.endsWith("/propose")) return response({ schemaVersion: 1, candidateId: candidate.candidateId, source: { ...source, sourceId: "synthetic-proposal", enabled: false, status: "needs-review" }, reviewRequired: ["Review ownership and usage"] });
    return response({ sources: [discoverySource], adapters });
  });
  await render(); await change("查询关键词", "automation Shanghai"); await click("搜索来源候选");
  assert.ok(dom.document.querySelector('a[href="https://github.com/example/jobs"]')); assert.match(dom.document.body.textContent!, /未知 · 待核实/);
  await click("有限检查 · 最多 3 文件 / 每份 30 条"); await click("生成禁用提案 · 不注册");
  const json = JSON.parse((field("完整来源 JSON") as any).value); assert.equal(json.enabled, false); assert.equal(json.status, "needs-review");
  assert.equal(paths.filter((path) => path === "POST /api/v1/sources").length, 0); assert.match(dom.document.body.textContent!, /当前没有注册，也没有启用/);
});

test("unmount cancels an in-flight tool and prevents late snapshot delivery", async () => {
  let pendingSignal: AbortSignal | undefined; let callbackCount = 0;
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith("/dataset/export")) {
      pendingSignal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => pendingSignal!.addEventListener("abort", () => reject(pendingSignal!.reason), { once: true }));
    }
    return response({ sources: [source], adapters });
  });
  await render("synthetic", () => { callbackCount++; });
  await act(async () => button("更新地图快照").click()); assert.ok(pendingSignal); assert.equal(pendingSignal.aborted, false);
  await act(async () => root!.unmount()); root = undefined;
  assert.equal(pendingSignal.aborted, true); assert.equal(callbackCount, 0);
});


test("default gateway enables source tools with an empty browser token and only reads the local catalog", async () => {
  const requests: Array<{ url: string; auth: string | null }> = [];
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => { requests.push({ url: String(url), auth: new Headers(init?.headers).get("Authorization") }); return response({ sources: [source], adapters }); });
  await render("", () => {}, "/api/atlas");
  assert.equal(button("更新地图快照").disabled, false); assert.equal(button("预览一页 · 不写入").disabled, false);
  assert.equal(requests.length, 1); assert.equal(requests[0]!.url, `${dom.location.origin}/api/atlas/api/v1/sources`); assert.equal(requests[0]!.auth, null);
});
