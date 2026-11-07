import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after, afterEach, mock } from "node:test";
import { Window, type HTMLButtonElement, type HTMLInputElement, type HTMLSelectElement } from "happy-dom";
import type { ComponentProps } from "react";
import { SourceDefinitionSchema, type SourceDefinition } from "@better-me/opportunities";
import type { CompanyCareerDiscoveryResult } from "@better-me/source-adapters/browser-contracts";

const dom = new Window({ url: "http://company-discovery-fixture.invalid" });
const React = await import("react"); const { act, createElement: h } = React;
const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import("react-dom/client");
const { CompanyCareersPanel } = await import("../src/components/atlas/CompanyCareersPanel.tsx");
let root: ReturnType<typeof createRoot> | undefined;
const at = "2026-10-19T12:00:00.000Z";
const source: SourceDefinition = { ...SourceDefinitionSchema.parse(JSON.parse(readFileSync(new URL("../../../config/sources/examples.json", import.meta.url), "utf8"))[0]), enabled: true, status: "active" };
const policy: SourceDefinition = { ...source, sourceId: "synthetic-company-policy", name: "Synthetic reviewed policy", capabilities: ["discover-sources"] };
const companyName = "Synthetic Company";
const baseResult = (name = companyName): CompanyCareerDiscoveryResult => ({ status: "requires-company-website", companyName: name, observedAt: at,
  matchedSources: [], candidates: [], proposals: [], visitedUrls: [], partial: false, warnings: [] });
const search = { providerId: "duckduckgo-html" as const, label: "DuckDuckGo HTML", query: `${companyName} official careers 招聘`, resultCount: 2 };
const response = (value: unknown) => new Response(JSON.stringify({ ok: true, requestId: "synthetic-company-panel", value }));
const configured = (label = "DuckDuckGo HTML") => ({ schemaVersion: 1, webSearch: { configured: true, providerId: "duckduckgo-html", label } });
type Props = ComponentProps<typeof CompanyCareersPanel>;
type Call = { path: string; body?: any; init: RequestInit };
function fixture(overrides: Partial<Props> = {}): Props { return { endpoint: "http://127.0.0.1:5178", token: "synthetic-company-token", sources: [], onProposal() {}, onSelectSource() {}, ...overrides }; }
function installFetch(handler?: (call: Call) => Response | Promise<Response> | undefined) {
  const calls: Call[] = [];
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init: RequestInit = {}) => {
    const call: Call = { path: new URL(String(url)).pathname.split("/").at(-1)!, body: init.body ? JSON.parse(String(init.body)) : undefined, init };
    calls.push(call); const custom = await handler?.(call); if (custom) return custom;
    if (call.path === "discovery-capabilities") return response({ schemaVersion: 1, webSearch: { configured: false } });
    if (call.path === "discover-careers") return response(baseResult(call.body.request.companyName));
    throw new Error(`Unexpected route ${call.path}`);
  }); return calls;
}
async function render(props = fixture()) {
  if (!root) { dom.document.body.innerHTML = "<main></main>"; root = createRoot(dom.document.querySelector("main")! as unknown as Element); }
  await act(async () => root!.render(h(CompanyCareersPanel, props)));
}
function button(text: string) { const found = [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find(entry => entry.textContent?.trim() === text); assert.ok(found, `Missing button: ${text}`); return found; }
async function click(text: string) { await act(async () => button(text).click()); }
function field(label: string) { const found = dom.document.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`); assert.ok(found, `Missing field: ${label}`); return found; }
async function change(label: string, value: string) {
  const entry = field(label); const prototype = entry.tagName === "SELECT" ? dom.HTMLSelectElement.prototype : dom.HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(entry, value); entry.dispatchEvent(new dom.Event(entry.tagName === "SELECT" ? "change" : "input", { bubbles: true })); });
}
async function toggle(open = true) { await act(async () => { const details = dom.document.querySelector("details")!; details.open = open; details.dispatchEvent(new dom.Event("toggle")); }); }
const text = () => dom.document.body.textContent!;
const result = () => dom.document.querySelector('[aria-label="企业官网发现结果"]');
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; mock.restoreAll(); mock.timers.reset(); dom.document.body.replaceChildren(); });
after(() => { dom.happyDOM.abort(); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });

test("opening the parent panel is inert; expanding company discovery reads configuration without searching", async () => {
  const calls = installFetch(); await render(); assert.equal(calls.length, 0);
  await toggle(); assert.deepEqual(calls.map(call => call.path), ["discovery-capabilities"]);
  assert.match(text(), /网页搜索未配置/); await toggle(false); await toggle();
  assert.equal(calls.length, 1); assert.equal(calls[0]!.init.method, "GET");
  assert.ok(calls.every(call => !call.body), "metadata must not trigger discovery, registration or collection");
});

test("an unconfigured provider and no source policy still allow name-only existing-source lookup", async () => {
  const calls = installFetch(); await render(); await toggle(); await change("发现企业名称", ` ${companyName} `);
  assert.equal(button("查找企业招聘来源").disabled, false); await click("查找企业招聘来源");
  assert.deepEqual(calls[1]!.body, { request: { companyName, maxPages: 3, limit: 10 } });
  assert.match(result()!.textContent!, /需要补充企业官网或配置网页搜索提供方/);
  assert.match(result()!.textContent!, /官网实际读取 0 页/); assert.equal(calls.length, 2);
});

test("configured metadata is not a network success and searches remain explicit", async () => {
  const calls = installFetch(call => call.path === "discovery-capabilities" ? response(configured()) : undefined);
  await render(); await toggle(); assert.match(text(), /网页搜索已配置：DuckDuckGo HTML（实验 HTML 搜索）/);
  assert.match(text(), /仅表示本机配置，尚未验证本次网络搜索/); assert.equal(calls.length, 1);
  await change("发现企业名称", companyName); await click("查找企业招聘来源");
  assert.equal(calls.length, 2); assert.equal("sourceId" in calls[1]!.body, false);
});

test("website reads require a usable registered policy and never synthesize endpoint permissions", async () => {
  const unusable: SourceDefinition[] = [{ ...policy, enabled: false }, { ...policy, sourceId: "synthetic-disabled", status: "needs-review" },
    { ...policy, sourceId: "synthetic-server", runtime: ["server"] }, { ...policy, sourceId: "synthetic-secret", secretRef: "synthetic-secret" }, source];
  const calls = installFetch(); const props = fixture({ sources: unusable }); await render(props); await toggle();
  await change("发现企业名称", companyName); await change("企业官网地址", "https://company.example/careers");
  assert.equal(button("查找企业招聘来源").disabled, true);
  await act(async () => dom.document.querySelector("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true })));
  assert.equal(calls.length, 1); assert.equal(field("官网发现端点策略").querySelectorAll("option").length, 1);
  await render({ ...props, sources: [policy] }); assert.equal(button("查找企业招聘来源").disabled, false);
  await click("查找企业招聘来源");
  assert.deepEqual(calls[1]!.body, { sourceId: policy.sourceId, request: { companyName, companyWebsite: "https://company.example/careers", maxPages: 3, limit: 10 } });
});

test("configuration failures stay unknown, permit existing matches and support explicit reload", async () => {
  let reads = 0;
  const calls = installFetch(call => call.path === "discovery-capabilities" ? ++reads === 1
    ? new Response(JSON.stringify({ ok: false, requestId: "synthetic", error: { code: "needs-auth", message: "private provider token" } }), { status: 401 }) : response(configured()) : undefined);
  await render(); await toggle(); assert.match(text(), /读取失败；当前配置状态未知/); assert.doesNotMatch(text(), /网页搜索未配置|private provider token/);
  await change("发现企业名称", companyName); assert.equal(button("查找企业招聘来源").disabled, false); await click("查找企业招聘来源");
  assert.ok(result()); await click("重新读取搜索配置"); assert.equal(result(), null); assert.match(text(), /网页搜索已配置/);
  assert.deepEqual(calls.map(call => call.path), ["discovery-capabilities", "discover-careers", "discovery-capabilities"]);
});

test("finite empty search is distinct from zero market jobs and separates search from website counts", async () => {
  const calls = installFetch(call => call.path === "discover-careers" ? response({ ...baseResult(), status: "no-candidates", search: { ...search, resultCount: 0 }, partial: true }) : undefined);
  await render(); await toggle(); await change("发现企业名称", companyName); await click("查找企业招聘来源");
  assert.match(result()!.textContent!, /本次有限范围内未找到招聘入口/); assert.match(result()!.textContent!, /本次搜索线索 0 条/);
  assert.match(result()!.textContent!, /官网实际读取 0 页 · 覆盖不完整/); assert.match(result()!.textContent!, /线索数量不代表岗位数量/);
  assert.doesNotMatch(result()!.textContent!, /没有岗位|0 个岗位|全部市场/); assert.equal(calls.length, 2);
});

test("search candidates retain original links and plain-text evidence; proposals only open disabled review", async () => {
  const quote = '<img src="x" onerror="unsafe()"><script>unsafe()</script>';
  const proposalSource: SourceDefinition = { ...source, name: "Synthetic reviewed proposal", enabled: false, status: "needs-review" };
  const discovered: CompanyCareerDiscoveryResult = { ...baseResult(), status: "needs-review", search, candidates: [{
    candidate: { candidateId: "synthetic-candidate", provider: "seed-links", homeUrl: "https://company.example/careers", discoveredAt: at, status: "needs-review", entryHints: [], evidenceUrls: ["https://search.example/result"], warnings: [] },
    entryKind: "html", matchedBy: "search-result", companyAssociation: "unverified", evidence: [{ kind: "search-result", sourceUrl: "https://search.example/result", targetUrl: "https://company.example/careers", quote }],
  }], proposals: [{ schemaVersion: 1, candidateId: "synthetic-candidate", source: proposalSource, reviewRequired: ["Review the company affiliation."] }], warnings: ["<script>warning()</script>"] };
  const calls = installFetch(call => call.path === "discover-careers" ? response(discovered) : undefined); const proposals: string[] = [];
  await render(fixture({ onProposal: value => proposals.push(value) })); await toggle(); await change("发现企业名称", companyName); await click("查找企业招聘来源");
  assert.match(result()!.textContent!, /本次搜索线索 2 条/); assert.match(result()!.textContent!, /官网实际读取 0 页/);
  assert.ok(result()!.textContent!.includes(quote)); assert.equal(result()!.querySelectorAll("img,script").length, 0);
  assert.equal(result()!.querySelector("a")!.getAttribute("href"), "https://company.example/careers"); assert.match(result()!.textContent!, /企业归属待核实/);
  await click("检查 Synthetic reviewed proposal 禁用配置"); assert.equal(proposals.length, 1);
  assert.equal(JSON.parse(proposals[0]!).enabled, false); assert.equal(JSON.parse(proposals[0]!).status, "needs-review"); assert.equal(calls.length, 2);
});

test("using an existing source only selects it for later explicit job retrieval", async () => {
  const matched: CompanyCareerDiscoveryResult = { ...baseResult(), status: "matched-existing", matchedSources: [{ sourceId: source.sourceId, name: source.name, matchedBy: "company-name", enabled: true, status: "active", entryUrl: "https://company.example/careers" }] };
  const calls = installFetch(call => call.path === "discover-careers" ? response(matched) : undefined); const selected: string[][] = [];
  await render(fixture({ sources: [source], onSelectSource: (id, name) => selected.push([id, name]) })); await toggle(); await change("发现企业名称", companyName); await click("查找企业招聘来源");
  await click("使用此企业来源"); assert.deepEqual(selected, [[source.sourceId, companyName]]); assert.equal(calls.length, 2);
});

test("editing the company cancels an in-flight discovery and ignores its late response", async () => {
  let resolve!: (value: Response) => void; const pending = new Promise<Response>(done => { resolve = done; });
  const calls = installFetch(call => call.path === "discover-careers" && call.body.request.companyName === companyName ? pending : undefined);
  await render(); await toggle(); await change("发现企业名称", companyName); await click("查找企业招聘来源");
  await change("发现企业名称", "Different Company"); assert.equal(calls[1]!.init.signal?.aborted, true);
  await act(async () => resolve(response(baseResult()))); assert.equal(result(), null);
  await click("查找企业招聘来源"); assert.match(result()!.textContent!, /Different Company/); assert.doesNotMatch(result()!.textContent!, /Synthetic Company/);
});

test("cancellation ends the loading state immediately and never becomes an empty success", async () => {
  let resolve!: (value: Response) => void; const pending = new Promise<Response>(done => { resolve = done; });
  const calls = installFetch(call => call.path === "discover-careers" ? pending : undefined);
  await render(); await toggle(); await change("发现企业名称", companyName); await click("查找企业招聘来源"); await click("取消官网发现");
  assert.equal(calls[1]!.init.signal?.aborted, true); assert.equal(button("查找企业招聘来源").disabled, false); assert.match(text(), /发现已取消/);
  await act(async () => resolve(response({ ...baseResult(), status: "no-candidates" }))); assert.equal(result(), null); assert.doesNotMatch(text(), /本次有限范围内未找到招聘入口/);
});

test("provider metadata reload invalidates a pending discovery before the provider can change", async () => {
  let resolve!: (value: Response) => void; const pending = new Promise<Response>(done => { resolve = done; }); let reads = 0;
  const calls = installFetch(call => call.path === "discover-careers" ? pending : call.path === "discovery-capabilities" ? response(configured(++reads === 1 ? "First provider" : "New provider")) : undefined);
  await render(); await toggle(); await change("发现企业名称", companyName); await click("查找企业招聘来源"); await click("重新读取搜索配置");
  assert.equal(calls[1]!.init.signal?.aborted, true); assert.match(text(), /New provider/);
  await act(async () => resolve(response({ ...baseResult(), status: "no-candidates", search }))); assert.equal(result(), null);
});

test("changing the local identity cancels pending metadata and never imports the old configuration", async () => {
  let resolve!: (value: Response) => void; const pending = new Promise<Response>(done => { resolve = done; });
  const calls = installFetch(call => call.path === "discovery-capabilities" ? pending : undefined); const props = fixture();
  await render(props); await toggle(); await render({ ...props, endpoint: "http://localhost:5288", token: "synthetic-next-token" });
  assert.equal(calls[0]!.init.signal?.aborted, true); assert.equal(dom.document.querySelector("details")!.open, false);
  await act(async () => resolve(response(configured("Old provider")))); assert.doesNotMatch(text(), /Old provider|网页搜索已配置/); assert.equal(calls.length, 1);
});

test("changing credentials resets fields and ignores discovery results from the previous identity", async () => {
  let resolve!: (value: Response) => void; const pending = new Promise<Response>(done => { resolve = done; });
  const calls = installFetch(call => call.path === "discover-careers" ? pending : undefined); const props = fixture();
  await render(props); await toggle(); await change("发现企业名称", companyName); await click("查找企业招聘来源"); await render({ ...props, token: "synthetic-new-token" });
  assert.equal(calls[1]!.init.signal?.aborted, true); assert.equal(field("发现企业名称").value, "");
  await act(async () => resolve(response(baseResult()))); assert.equal(result(), null);
});

test("closing metadata reads permits a new read without accepting the old provider later", async () => {
  let resolve!: (value: Response) => void; const pending = new Promise<Response>(done => { resolve = done; }); let reads = 0;
  const calls = installFetch(call => call.path === "discovery-capabilities" && ++reads === 1 ? pending : undefined);
  await render(); await toggle(); await toggle(false); assert.equal(calls[0]!.init.signal?.aborted, true);
  await toggle(); assert.match(text(), /网页搜索未配置/); await act(async () => resolve(response(configured("Old provider"))));
  assert.match(text(), /网页搜索未配置/); assert.doesNotMatch(text(), /Old provider/); assert.equal(calls.length, 2);
});

test("disabling the selected website policy cancels old results and prevents more website reads", async () => {
  let resolve!: (value: Response) => void; const pending = new Promise<Response>(done => { resolve = done; });
  const calls = installFetch(call => call.path === "discover-careers" ? pending : undefined); const props = fixture({ sources: [policy] });
  await render(props); await toggle(); await change("发现企业名称", companyName); await change("企业官网地址", "https://company.example/careers"); await click("查找企业招聘来源");
  await render({ ...props, sources: [{ ...policy, enabled: false }] }); assert.equal(calls[1]!.init.signal?.aborted, true); assert.equal(button("查找企业招聘来源").disabled, true);
  await act(async () => resolve(response(baseResult()))); assert.equal(result(), null);
});

test("a timed-out discovery reports a failure rather than zero candidates or registration success", async () => {
  let resolve!: (value: Response) => void; const pending = new Promise<Response>(done => { resolve = done; });
  const calls = installFetch(call => call.path === "discover-careers" ? pending : undefined);
  await render(); await toggle(); await change("发现企业名称", companyName); mock.timers.enable({ apis: ["setTimeout"] }); await click("查找企业招聘来源");
  await act(async () => mock.timers.tick(60000)); assert.equal(calls[1]!.init.signal?.aborted, true);
  await act(async () => resolve(response({ ...baseResult(), status: "no-candidates" }))); assert.equal(result(), null); assert.match(text(), /发现已取消或超时/);
});
