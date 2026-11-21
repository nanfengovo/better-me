import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, afterEach, mock } from "node:test";
import { Window, type HTMLButtonElement } from "happy-dom";
import type { ComponentProps } from "react";
import { companyBoardFromOfficialJob } from "../../../packages/source-adapters/src/career-discovery.ts";
import type { OfficialJobDiscoveryResult } from "@better-me/source-adapters/browser-contracts";

const dom = new Window({ url: "http://discovery-fixture.invalid" });
const React = await import("react");
const globals = { window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node,
  HTMLElement: dom.HTMLElement, Element: dom.Element, React, IS_REACT_ACT_ENVIRONMENT: true };
const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const hooks = registerHooks({ load(url, context, nextLoad) {
  return url.endsWith(".css") ? { source: "export {};", format: "module", shortCircuit: true } : nextLoad(url, context);
} });
const { createRoot } = await import("react-dom/client");
const { AtlasResumeDiscovery } = await import("../src/components/atlas/AtlasResumeDiscovery.tsx");
let root: ReturnType<typeof createRoot> | undefined;
const sample: OfficialJobDiscoveryResult = {
  observedAt: "2026-11-20T02:13:11Z", status: "partial", queries: ["C# synthetic city"], warnings: ["Some pages could not be read."],
  candidates: [
    { url: "https://careers.example.org/job/backend", candidateId: "test-signed-id", company: "Sample employer", companyWebsite: "https://company.example.org/", title: "Backend developer",
      verification: "official-detail", verificationEvidence: "Structured employer posting", matchedSkills: ["C#", "Python"], availability: "open",
      travel: "mentioned", travelEvidence: "Up to 10% travel.", location: "Synthetic city", description: "Build services in C# with Python." },
    { url: "https://index.example.test/result", company: "Sample employer", title: "Unconfirmed role", verification: "unverified-lead",
      matchedSkills: [], travel: "unknown", availability: "unknown" },
  ],
};
const receipt = { ok: true, revision: 4, jobIds: ["job-synthetic"], snapshotIds: [],
  counts: { newJobs: 1, updatedJobs: 0, unchangedJobs: 0, newListings: 1, newObservations: 1, newSnapshots: 0 } };
const envelope = (value: unknown) => new Response(JSON.stringify({ ok: true, requestId: "test-discovery", value }));
function button(name: string) {
  const result = [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find(btn => btn.textContent?.trim() === name);
  assert.ok(result, `Missing button ${name}`); return result;
}
const click = (name: string) => React.act(async () => button(name).click());
async function render(extra: Partial<ComponentProps<typeof AtlasResumeDiscovery>> = {}) {
  if (!root) root = createRoot(dom.document.body.appendChild(dom.document.createElement("main")) as unknown as HTMLElement);
  await React.act(async () => root!.render(React.createElement(React.StrictMode, null, React.createElement(AtlasResumeDiscovery, { endpoint: "http://127.0.0.1:5178", token: "test-token",
    targetRole: "Backend developer", location: "Synthetic city", skills: ["C#", "Python", "Vue"], preferForeignEmployer: true,
    preferLowTravel: true, onManageSources() {}, ...extra }))));
}
afterEach(async () => { if (root) await React.act(async () => root!.unmount()); root = undefined; mock.restoreAll(); dom.document.body.replaceChildren(); });
after(() => { hooks.deregister(); void dom.happyDOM.abort(); for (const [key, value] of originals) {
  if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key);
} });

test("searches from editable resume terms without company names, groups one employer and collects only its verified job", async () => {
  const calls: { path: string; input: unknown; key: string | null }[] = [];
  let collected = 0;
  const managed: unknown[][] = [];
  mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    const input: unknown = JSON.parse(String(init.body));
    calls.push({ path: url.pathname, input, key: new Headers(init.headers).get("Idempotency-Key") });
    return envelope(url.pathname.endsWith("/import") ? receipt : sample);
  });
  await render({ onCollected: () => { collected++; }, onManageSources: (...args) => managed.push(args) });
  assert.equal(calls.length, 0);
  await click("查找正在招聘的公司");
  assert.deepEqual(calls[0], { path: "/api/v1/jobs/discover-official", key: null, input:
    { role: "Backend developer", skills: ["C#"], secondarySkills: ["Python", "Vue"], region: "Synthetic city",
      preferLowTravel: true, preferForeignEmployer: true } });
  assert.equal(dom.document.querySelectorAll(".ard-company").length, 1);
  assert.equal(dom.document.querySelector('.ard-company header a[title="招聘方在来源中披露的公司网站"]')?.getAttribute("href"), "https://company.example.org/");
  assert.equal(dom.document.querySelectorAll(".ard-company article").length, 2);
  assert.equal(dom.document.querySelectorAll(".ard-company article button").length, 1);
  assert.match(dom.document.body.textContent!, /命中主技能 · C#/);
  assert.match(dom.document.body.textContent!, /外企归属待核实/);
  assert.match(dom.document.body.textContent!, /Up to 10% travel/);
  await click("查看公司采集来源");
  assert.deepEqual(managed, [["Sample employer", "https://careers.example.org/job/backend"]]);
  assert.equal(calls.length, 1);
  await click("收录这个岗位");
  assert.deepEqual(calls[1]!.input, { candidateId: "test-signed-id" });
  assert.ok(calls[1]!.key);
  assert.equal(collected, 1);
  assert.ok(button("已收录").disabled);
});

test("canceled responses and a switch to another resume never resurrect old company results", async () => {
  let resolve!: (value: Response) => void;
  mock.method(globalThis, "fetch", () => new Promise<Response>(done => { resolve = done; }));
  await render();
  await click("查找正在招聘的公司");
  await click("取消搜索");
  await React.act(async () => resolve(envelope(sample)));
  assert.equal(dom.document.querySelector(".ard-company"), null);
  await click("查找正在招聘的公司");
  await render({ targetRole: "Designer", skills: ["Design"] });
  await React.act(async () => resolve(envelope(sample)));
  assert.equal(dom.document.querySelector(".ard-company"), null);
  assert.ok(!button("查找正在招聘的公司").disabled);
});

test("unavailable public search displays provider feedback and never invents opportunities", async () => {
  mock.method(globalThis, "fetch", () => Promise.resolve(envelope({ ...sample, status: "provider-unavailable",
    candidates: [], queries: [], warnings: ["Configure the provider."] })));
  await render();
  await click("查找正在招聘的公司");
  assert.match(dom.document.body.textContent!, /公开搜索暂不可用/);
  assert.match(dom.document.body.textContent!, /Configure the provider/);
  assert.equal(dom.document.querySelectorAll(".ard-company").length, 0);
});

test("the resume entry automatically follows new discovery rounds, retains earlier results, and continues on request", async () => {
  const sessionId = "33333333-3333-4333-8333-333333333333";
  const requests: Array<Record<string, unknown>> = [];
  mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    assert.equal(url.pathname, "/api/v1/jobs/discover-official");
    requests.push(JSON.parse(String(init.body)));
    const round = requests.length - 1;
    const job = { ...sample.candidates[0]!, company: "New employer " + round, url: "https://company.example.org/jobs/" + round, candidateId: "job-" + round };
    return envelope({ ...sample, candidates: [job], discovery: { sessionId, round, checkedPages: round * 5, pendingPages: round < 4 ? 5 : 0, canContinue: round < 4, newCompanies: 1 } });
  });
  await render({ autoSearchOnOpen: true });
  assert.equal(requests.length, 3);
  assert.equal(requests[0]!.continueDiscovery, undefined);
  assert.ok(requests.slice(1).every(request => request.continueDiscovery === sessionId));
  assert.equal(dom.document.querySelectorAll(".ard-company").length, 3);
  assert.match(dom.document.body.textContent!, /已完成 3 轮/);
  await click("继续发现更多官网");
  assert.equal(requests.length, 5);
  assert.equal(dom.document.querySelectorAll(".ard-company").length, 5);
});

test("pausing the agent keeps completed results and discards the canceled round", async () => {
  const sessionId = "44444444-4444-4444-8444-444444444444";
  let finish!: (response: Response) => void;
  let signal: AbortSignal | undefined;
  let count = 0;
  mock.method(globalThis, "fetch", (_url: URL, init: RequestInit) => {
    count++;
    if (count === 1) return Promise.resolve(envelope({ ...sample, discovery: { sessionId, round: 0, checkedPages: 1, pendingPages: 3, canContinue: true, newCompanies: 1 } }));
    signal = init.signal as AbortSignal;
    return new Promise<Response>(resolve => { finish = resolve; });
  });
  await render({ autoSearchOnOpen: true });
  assert.equal(count, 2);
  await click("暂停发现");
  assert.ok(signal?.aborted);
  await React.act(async () => finish(envelope({ ...sample, candidates: [{ ...sample.candidates[0]!, company: "Discarded" }],
    discovery: { sessionId, round: 1, checkedPages: 2, pendingPages: 2, canContinue: true, newCompanies: 1 } })));
  assert.ok(dom.document.body.textContent!.includes("Sample employer"));
  assert.ok(!dom.document.body.textContent!.includes("Discarded"));
  assert.ok(!button("继续发现更多官网").disabled);
});

test("ambiguous collection waits for an explicit retry and reuses its original import key", async () => {
  const attempts: string[] = [];
  mock.method(globalThis, "fetch", (url: URL, init: RequestInit) => {
    if (!url.pathname.endsWith("/import")) return Promise.resolve(envelope(sample));
    attempts.push(new Headers(init.headers).get("Idempotency-Key")!);
    if (attempts.length === 1) return Promise.reject(new TypeError("simulated loss of receipt"));
    return Promise.resolve(envelope(receipt));
  });
  await render();
  await click("查找正在招聘的公司");
  await click("收录这个岗位");
  assert.equal(attempts.length, 1);
  assert.ok(dom.document.querySelector('[role="alert"]'));
  await click("收录这个岗位");
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0], attempts[1]);
  assert.ok(button("已收录").disabled);
});

const boardUrl = "https://boards-api.greenhouse.io/v1/boards/fixturelabs/jobs?content=true";
const boardJob = { ...sample.candidates[0]!, company: "Fixture Labs", url: "https://job-boards.greenhouse.io/fixturelabs/jobs/12345" };
const { sourceProposal: boardProposal } = await companyBoardFromOfficialJob(boardJob);
assert.ok(boardProposal, "a verified posting from this tenant should yield an inert source proposal");
assert.equal(boardProposal.entryUrl, boardUrl);
const boardResult = { ...sample, candidates: [{ ...boardJob, sourceProposal: boardProposal }] };
const boardView = (sources: unknown[]) => ({
  protocol: "better-me/atlas-browse-v1", kind: "view", snapshot: "a".repeat(32),
  dataset: { view: "browse", schemaVersion: 1, revision: 7, sources, companies: [], jobs: [], locations: [], compensations: [],
    listings: [], observations: [], snapshots: [] },
});

test("an employer discovered via its ATS can be added to collection after review; retry preserves the reviewed source and snapshot", async () => {
  const writes: { value: unknown; key: string | null }[] = [];
  const paths: string[] = [];
  let updates = 0;
  mock.method(globalThis, "fetch", (url: URL, init: RequestInit) => {
    paths.push(url.pathname);
    if (url.pathname.endsWith("discover-official")) return Promise.resolve(envelope(boardResult));
    if (url.pathname.endsWith("/browse")) return Promise.resolve(envelope(boardView([])));
    assert.equal(url.pathname, "/api/v1/sources");
    writes.push({ value: JSON.parse(String(init.body)), key: new Headers(init.headers).get("Idempotency-Key") });
    if (writes.length === 1) return Promise.reject(new TypeError("lost reply"));
    return Promise.resolve(envelope({ ...receipt, revision: 8, jobIds: [], counts: { ...receipt.counts, newJobs: 0 } }));
  });
  await render({ onCollected: () => { updates++; } });
  await click("查找正在招聘的公司");
  const review = dom.document.querySelector("details.ard-source-review");
  assert.ok(review);
  assert.equal(review.open, false);
  await React.act(async () => { review.open = true; });
  assert.match(review.textContent!, /每次最多 3 页、100 条/);
  assert.ok([...review.querySelectorAll("a")].some(link => link.href === boardUrl));
  assert.deepEqual(paths, ["/api/v1/jobs/discover-official"]);
  await click("确认启用公司来源");
  await click("使用原请求重试");
  assert.ok(writes[0]!.key);
  assert.deepEqual(writes[0], writes[1]);
  assert.deepEqual(writes[0]!.value, { source: { ...boardProposal, enabled: true, status: "active" }, expectedRevision: 7 });
  assert.equal(paths.filter(p => p.endsWith("/browse")).length, 1);
  assert.equal(updates, 1);
  assert.ok(button("来源已启用").disabled);
});

test("an existing disabled company board with another ID is preserved", async () => {
  const paths: string[] = [];
  mock.method(globalThis, "fetch", (url: URL) => {
    paths.push(url.pathname);
    return Promise.resolve(envelope(url.pathname.endsWith("/browse") ?
      boardView([{ ...boardProposal, sourceId: "my-existing-board", status: "disabled" }]) : boardResult));
  });
  await render();
  await click("查找正在招聘的公司");
  await click("确认启用公司来源");
  assert.ok(button("已有配置待核对").disabled);
  assert.deepEqual(paths, ["/api/v1/jobs/discover-official", "/api/v1/atlas/browse"]);
});

test("a primary skill can start discovery even when the resume has no target title", async () => {
  const queries: { role: string; skills: string[] }[] = [];
  mock.method(globalThis, "fetch", (_url: URL, init: RequestInit) => {
    queries.push(JSON.parse(String(init.body)));
    return Promise.resolve(envelope(sample));
  });
  await render({ targetRole: "", skills: ["C#"] });
  assert.ok(!button("查找正在招聘的公司").disabled);
  await click("查找正在招聘的公司");
  assert.deepEqual(queries.map(query => [query.role, query.skills]), [["", ["C#"]]]);
  await render({ targetRole: "", skills: [] });
  assert.ok(button("查找正在招聘的公司").disabled);
});

test("the resume shortcut waits for connection then sends the displayed terms once under Strict Mode", async () => {
  const calls: { path: string; input: unknown }[] = [];
  mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    calls.push({ path: url.pathname, input: JSON.parse(String(init.body)) });
    return envelope(boardResult);
  });
  const shortcut = { autoSearchOnOpen: true, onManageSources: undefined };
  await render({ ...shortcut, token: "" });
  assert.equal(calls.length, 0);
  await render(shortcut);
  await render({ ...shortcut, skills: ["C#", "Python", "Vue"] });
  assert.deepEqual(calls, [{ path: "/api/v1/jobs/discover-official", input: {
    role: "Backend developer", skills: ["C#"], secondarySkills: ["Python", "Vue"], region: "Synthetic city",
    preferLowTravel: true, preferForeignEmployer: true,
  } }]);
  const criteria = dom.document.querySelector("form details");
  assert.ok(criteria);
  assert.equal(criteria.open, false);
  assert.match(criteria.querySelector("summary")!.textContent!, /调整搜索条件 · Backend developer · C# · Synthetic city/);
  assert.match(dom.document.querySelector(".ard-company")!.textContent!, /Fixture Labs/);
  assert.ok(button("收录这个岗位"));
  assert.ok(dom.document.querySelector(".ard-company details.ard-source-review"));
  assert.doesNotMatch(dom.document.body.textContent!, /查看公司采集来源/);
});

test("missing resume terms open the form and allow an explicit first search", async () => {
  const queries: { role: string; skills: string[] }[] = [];
  mock.method(globalThis, "fetch", async (_url: URL, init: RequestInit) => {
    queries.push(JSON.parse(String(init.body)));
    return envelope(sample);
  });
  await render({ autoSearchOnOpen: true, targetRole: "", skills: [] });
  assert.ok(dom.document.querySelector("form details")?.open);
  assert.match(dom.document.body.textContent!, /填写目标岗位或一项主技能/);
  assert.equal(queries.length, 0);
  assert.ok(button("查找正在招聘的公司").disabled);
  const role = dom.document.querySelector(".ard-inputs input")!;
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(role, "Developer");
    role.dispatchEvent(new dom.Event("input", { bubbles: true }));
  });
  assert.equal(queries.length, 0);
  await click("查找正在招聘的公司");
  assert.deepEqual(queries.map(({ role, skills }) => [role, skills]), [["Developer", []]]);
});

test("canceling or changing the shortcut session discards late responses and allows explicit retry", async () => {
  const pending: { signal: AbortSignal; finish: (reply: Response) => void }[] = [];
  mock.method(globalThis, "fetch", (_url: URL, init: RequestInit) => new Promise<Response>(finish => {
    pending.push({ signal: init.signal!, finish });
  }));
  await render({ autoSearchOnOpen: true });
  assert.equal(pending.length, 1);
  await render({ autoSearchOnOpen: true, token: "another-local-session" });
  assert.equal(pending.length, 2);
  assert.ok(pending[0]!.signal.aborted);
  await React.act(async () => pending[0]!.finish(envelope(boardResult)));
  assert.equal(dom.document.querySelector(".ard-company"), null);
  await click("取消搜索");
  assert.ok(pending[1]!.signal.aborted);
  await React.act(async () => pending[1]!.finish(envelope(boardResult)));
  assert.equal(dom.document.querySelector(".ard-company"), null);
  await click("重新搜索");
  assert.equal(pending.length, 3);
  await React.act(async () => pending[2]!.finish(envelope(sample)));
  assert.match(dom.document.querySelector(".ard-company")!.textContent!, /Sample employer/);
});

test("inline results count verified employers, disclose evidence in context and distinguish available company actions", async () => {
  const first = { ...sample.candidates[0]!, jobId: "sample-native-position-id" };
  const second = { ...first, company: "Another employer", sourceId: "existing-board", url: "https://another.example.org/jobs/position" };
  mock.method(globalThis, "fetch", async () => envelope({ ...sample, candidates: [first, second, sample.candidates[1]] }));
  await render({ autoSearchOnOpen: true, onManageSources: undefined });
  const results = dom.document.querySelector(".ard-results")!;
  assert.match(results.textContent!, /已核对 2 家公司、2 个官网岗位，另有 1 条线索待核实/);
  const coverage = results.querySelector("details")!;
  assert.equal(coverage.open, false);
  assert.equal(coverage.querySelector("summary")!.textContent, "搜索范围与关键词");
  assert.match(coverage.textContent!, /Some pages could not be read/);
  assert.match(coverage.textContent!, /C# synthetic city/);
  const [unsourced, registered] = results.querySelectorAll(".ard-company");
  assert.match(unsourced!.textContent!, /可单独收录岗位/);
  assert.match(registered!.textContent!, /公司来源已登记/);
  assert.doesNotMatch(registered!.textContent!, /暂未找到/);
  const job = unsourced!.querySelector("article")!;
  const detail = job.querySelector("details")!;
  assert.equal(detail.open, false);
  assert.match(detail.textContent!, /职位编号 · sample-native-position-id/);
  assert.match(detail.textContent!, /Structured employer posting/);
  const visibleParagraphs = [...job.children].filter(el => el.tagName === "P").map(el => el.textContent).join(" ");
  assert.doesNotMatch(visibleParagraphs, /sample-native-position-id|Structured employer posting/);
});

test("widening to China preserves the resume's other criteria and city results, with employer evidence and opt-in collection", async () => {
  const localJob = { ...sample.candidates[0]!, location: "上海", jobId: "local-1" };
  const freshCopy = { ...localJob, candidateId: "fresh-city-reference" };
  const group = { name: "Fixture Group", headquarters: "德国", evidenceUrl: "https://careers.example.org/about" };
  const furtherJob = { ...boardResult.candidates[0]!, company: "Fixture Labs", location: "深圳", employerGroup: group, candidateId: "another-reference", matchedSkills: [], relatedSkills: [".NET"] };
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push({ path: url.pathname, body });
    if (url.pathname.endsWith("/import")) return envelope(receipt);
    return envelope({ ...sample, candidates: body.region === "中国" ? [furtherJob, freshCopy, sample.candidates[1]] : [localJob] });
  });
  await render({ autoSearchOnOpen: true, onManageSources: undefined, location: "上海市" });
  assert.equal(requests.length, 1);
  await click("收录这个岗位");
  await click("扩大到全国找更多公司");
  assert.deepEqual(requests[2]!.body, { ...requests[0]!.body, region: "中国" });
  assert.match(dom.document.body.textContent!, /全国 · 含上海市结果/);
  assert.match(dom.document.body.textContent!, /已核对 2 家公司、2 个官网岗位，另有 1 条线索待核实/);
  assert.match(dom.document.querySelector(".ard-leads")!.textContent!, /Unconfirmed role/);
  assert.ok(button("已收录").disabled, "a refreshed evidence handle must not reset a collected posting");
  const [disclosed, other] = dom.document.querySelectorAll(".ard-company");
  assert.equal(disclosed!.getAttribute("aria-label"), "Fixture Labs");
  assert.equal(disclosed!.querySelector('a[href="https://careers.example.org/about"]')?.textContent, "Fixture Group · 集团总部 · 德国");
  assert.match(disclosed!.textContent!, /在华主体股权未核实/);
  assert.doesNotMatch(disclosed!.textContent!, /外企归属待核实/);
  assert.match(other!.textContent!, /外企归属待核实/);
  const jobs = disclosed!.querySelector("details.ard-company-jobs")!;
  assert.ok(!jobs.open);
  await React.act(async () => { jobs.open = true; });
  assert.equal(jobs.querySelector("article a")?.getAttribute("href"), furtherJob.url);
  assert.match(jobs.textContent!, /官网提到的相关技术 · .NET/);
  assert.doesNotMatch(jobs.textContent!, /命中(?:主技能|加分技能)/);
  assert.match(jobs.lastElementChild?.textContent ?? "", /将公司加入岗位采集/);
  await React.act(async () => dom.document.querySelector('.ard-ownership input')!.click());
  assert.equal(dom.document.querySelectorAll(".ard-company").length, 1);
  await click("只看上海市结果");
  assert.equal(dom.document.querySelectorAll(".ard-company").length, 1);
  assert.match(dom.document.querySelector(".ard-company")!.textContent!, /Sample employer/);
  await click("查看全国结果");
  assert.equal(requests.length, 3, "reviewing employers and switching existing results must never write or rediscover");
});

test("a failed or canceled national search keeps the original city shortlist available", async () => {
  let finish: ((reply: Response) => void) | undefined;
  const regions: string[] = [];
  mock.method(globalThis, "fetch", async (_url: URL, init: RequestInit) => {
    const input = JSON.parse(String(init.body)); regions.push(input.region);
    if (input.region === "中国") return new Promise<Response>(resolve => { finish = resolve; });
    return envelope(boardResult);
  });
  await render({ autoSearchOnOpen: true, location: "Shanghai" });
  await click("扩大到全国找更多公司");
  assert.ok(button("正在全国查找招聘公司…").disabled);
  assert.match(dom.document.querySelector(".ard-company")!.textContent!, /Fixture Labs/);
  await click("取消搜索");
  await React.act(async () => finish!(envelope(sample)));
  assert.ok(button("扩大到全国找更多公司"));
  await click("扩大到全国找更多公司");
  await React.act(async () => finish!(envelope({ ...sample, candidates: [], status: "provider-unavailable" })));
  assert.match(dom.document.body.textContent!, /全国搜索暂不可用，仍可查看原地区的结果/);
  assert.match(dom.document.querySelector(".ard-company")!.textContent!, /Fixture Labs/);
  assert.deepEqual(regions, ["Shanghai", "中国", "中国"]);
});

test("keeps C# and .NET as primary when both are disclosed under the resume's main stack", async () => {
  const requests: Record<string, unknown>[] = [];
  mock.method(globalThis, "fetch", async (_url: URL, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return envelope(sample);
  });
  await render({ autoSearchOnOpen: true, location: "上海市", skills: ["C#", "Vue", ".NET", "Python"] });
  await click("扩大到全国找更多公司");
  assert.deepEqual(requests.map(r => [r.skills, r.secondarySkills]), [
    [["C#", ".NET"], ["Vue", "Python"]], [["C#", ".NET"], ["Vue", "Python"]],
  ]);
});
