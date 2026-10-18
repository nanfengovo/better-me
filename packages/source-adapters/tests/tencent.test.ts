import assert from "node:assert/strict";
import test from "node:test";
import { SourceDefinitionSchema, ToolError, includesSearchText, type SourceDefinition } from "@better-me/opportunities";
import { createSourceRegistry } from "../src/registry.js";
import { tencentAdapter } from "../src/adapters/tencent.js";
import { TencentSourceOptionsSchema } from "../src/tencent-contracts.js";
import { SourceTransportError } from "../src/transport.js";
import type { SourceAdapterRequest, SourceAdapterContext } from "../src/contracts.js";
import { assessSourceScopeMatch, countSourceScopeMatches } from "../src/local-match.js";

const AT = "2026-10-18T00:00:00.000Z";
const context: SourceAdapterContext = {
  observedAt: AT, requestId: "synthetic-tencent", actorScope: "synthetic-user", signal: new AbortController().signal,
  budget: { requests: 10, bytes: 100_000, timeoutMs: 5000 }, consumeRequests: () => {}, consumeBytes: () => {}, throwIfCancelled: () => {},
};
const source = (options: SourceDefinition["options"] = {}): SourceDefinition => SourceDefinitionSchema.parse({
  sourceId: "synthetic-tencent", name: "Synthetic Tencent protocol fixture", adapterId: "tencent", adapterVersion: "1", capabilities: ["list-jobs"], runtime: ["local-service"], entityType: "job-posting", enabled: true, status: "active", remoteFilters: ["roles"],
  entryUrl: "https://careers.tencent.com/tencentcareer/api/post/Query", options: { companyName: "合成腾讯协议测试公司", pageSize: 2, ...options },
  endpointPolicy: { allowedHosts: ["careers.tencent.com"], allowedPathPrefixes: ["/tencentcareer/api/post/Query", "/tencentcareer/api/post/ByPostId"], requireHttps: true, allowRedirects: false, maxRedirects: 0 }, attribution: { label: "Synthetic public fixture", usage: "metadata", requiresAttribution: true },
  refreshPolicy: { mode: "manual", minIntervalSeconds: 60, maxRecords: 10, maxPages: 3, requestsPerMinute: 10 },
});
const post = (id = "123") => ({ PostId: id, RecruitPostId: 1, RecruitPostName: "Synthetic C# developer", Responsibility: "<p>Build .NET systems</p><script>secret()</script>", CountryName: "中国", LocationName: "深圳", LastUpdateTime: "2026年10月17日", DateCreated: "2024-01-01T00:00:00Z", IsValid: true, PostURL: `http://careers.tencent.com/jobdesc.html?postId=${id}` });
function request(posts: unknown[], count = posts.length, urls: string[] = []): SourceAdapterRequest {
  return { source: source(), scope: { roles: ["C#"], regions: ["上海"], companyNames: ["测试"] }, context,
    transport: { request: async ({ url }) => { urls.push(url); return { url, status: 200, headers: {}, text: JSON.stringify({ Code: 200, Data: { Posts: posts, Count: count } }) }; } } };
}

test("Tencent sends encoded real keywords upstream while regions/company remain local and unknown facts stay unknown", async () => {
  const urls: string[] = [];
  const result = await createSourceRegistry([tencentAdapter]).list(request([post()], 1, urls));
  const endpoint = new URL(urls[0]!);
  assert.equal(endpoint.origin + endpoint.pathname, "https://careers.tencent.com/tencentcareer/api/post/Query");
  assert.equal(endpoint.searchParams.get("keyword"), "C#"); assert.ok(urls[0]!.includes("C%23"));
  assert.equal(endpoint.searchParams.get("pageSize"), "2"); assert.equal(endpoint.searchParams.has("region"), false);
  assert.deepEqual(result.coverage.appliedFilters, ["roles"]); assert.deepEqual(result.coverage.ignoredFilters, ["regions", "companyNames"]);
  const job = result.records[0]!;
  assert.equal(job.companyName, "合成腾讯协议测试公司"); assert.equal(job.sourceRecordId, "123");
  assert.equal(job.url, "https://careers.tencent.com/jobdesc.html?postId=123");
  assert.equal(job.completeness, "excerpt"); assert.ok(job.description!.includes("Build .NET systems")); assert.ok(!job.description!.includes("secret()"));
  assert.deepEqual(job.locations, [{ raw: "中国 · 深圳", countryCode: "CN", city: "深圳" }]); assert.deepEqual(job.compensations, []);
  assert.equal(job.availability, "unknown"); assert.equal(job.availabilityBasis, undefined);
  assert.equal(job.sourceUpdatedRaw, "2026年10月17日"); assert.equal(job.sourceUpdatedAt, undefined);
  assert.equal(job.sourcePublishedAt, undefined); assert.equal(job.sourcePublishedRaw, undefined);
  assert.ok(job.evidence.some((entry) => entry.field === "source.DateCreated"));
});

test("overseas country/city text is preserved without inferring codes, coordinates or multi-city precision", async () => {
  const result = await tencentAdapter.list(request([{ ...post(), CountryName: "新加坡", LocationName: "Singapore / Remote", LastUpdateTime: "2026-10-17T12:00:00+08:00" }]));
  assert.deepEqual(result.records[0]!.locations, [{ raw: "新加坡 · Singapore / Remote" }]);
  assert.equal(result.records[0]!.sourceUpdatedAt, "2026-10-17T04:00:00.000Z");
  const missingCountry = await tencentAdapter.list(request([{ ...post(), CountryName: "", LocationName: "深圳" }]));
  assert.equal(missingCountry.records[0]!.locations[0]!.countryCode, undefined);
});

test("pagination carries fixed page size and rejects a cursor reused with changed keywords", async () => {
  const urls: string[] = [];
  const first = await tencentAdapter.list(request([post("1"), post("2")], 5, urls));
  assert.ok(first.nextCursor); assert.equal(first.coverage.complete, false); assert.equal(first.coverage.partial, false);
  const nextInput = request([post("3"), post("4")], 5, urls); nextInput.cursor = first.nextCursor; nextInput.source.refreshPolicy.maxRecords = 1;
  const next = await tencentAdapter.list(nextInput);
  assert.equal(new URL(urls[1]!).searchParams.get("pageIndex"), "2"); assert.equal(new URL(urls[1]!).searchParams.get("pageSize"), "2");
  assert.equal(next.records.length, 1); assert.equal(next.coverage.fetchedRecords, 2); assert.equal(next.coverage.partial, true); assert.equal(next.stopReason, "record-limit");
  const changed = request([]); changed.cursor = first.nextCursor; changed.scope.roles = [".NET"];
  await assert.rejects(tencentAdapter.list(changed), (error: unknown) => error instanceof ToolError && error.code === "invalid-input");
});

test("multiple role terms are separate OR searches, not an invented joined query or summed unique total", async () => {
  const urls: string[] = [];
  const input = request([post()], 1, urls); input.scope.roles = ["C#", ".NET", "C#"];
  const first = await tencentAdapter.list(input);
  assert.equal(first.coverage.totalAvailable, undefined); assert.ok(first.nextCursor); assert.equal(new URL(urls[0]!).searchParams.get("keyword"), "C#");
  input.cursor = first.nextCursor;
  const second = await tencentAdapter.list(input);
  assert.equal(new URL(urls[1]!).searchParams.get("keyword"), ".NET"); assert.equal(second.nextCursor, undefined); assert.equal(second.coverage.complete, true);
});

test("an empty official search is complete, but premature short pages and invalid rows are partial", async () => {
  const empty = await tencentAdapter.list(request([], 0)); assert.equal(empty.coverage.complete, true); assert.equal(empty.records.length, 0);
  const short = await tencentAdapter.list(request([post()], 50)); assert.equal(short.coverage.partial, true); assert.equal(short.coverage.complete, false); assert.equal(short.nextCursor, undefined);
  const invalid = await tencentAdapter.list(request([{ ...post(), PostURL: "https://untrusted.example/jobs/123" }], 1));
  assert.equal(invalid.records.length, 0); assert.equal(invalid.coverage.partial, true);
});

test("official delegated Workday links are retained but mismatched IDs and non-HTTPS delegate URLs are omitted", async () => {
  const delegated = "https://tencent.wd1.myworkdayjobs.com/Tencent_Careers/job/Synthetic/R123";
  const result = await tencentAdapter.list(request([{ ...post(), PostURL: delegated }, { ...post("2"), PostURL: "https://careers.tencent.com/jobdesc.html?postId=wrong" }], 2));
  assert.equal(result.records.length, 1); assert.equal(result.records[0]!.url, delegated); assert.equal(result.coverage.partial, true);
  const unsafe = await tencentAdapter.list(request([{ ...post(), PostURL: delegated.replace("https:", "http:") }])); assert.equal(unsafe.records.length, 0);
});

test("invalid options, endpoints, terms and response shapes fail before claiming an empty success", async () => {
  assert.equal(TencentSourceOptionsSchema.safeParse({ apiHost: "untrusted.example" }).success, false);
  const badHost = request([]); badHost.source.options = { apiHost: "untrusted.example" }; await assert.rejects(tencentAdapter.list(badHost));
  const badEntry = request([]); badEntry.source.entryUrl = "http://careers.tencent.com/tencentcareer/api/post/Query"; await assert.rejects(tencentAdapter.list(badEntry));
  const longTerm = request([]); longTerm.scope.roles = ["x".repeat(81)]; await assert.rejects(tencentAdapter.list(longTerm));
  const badCursor = request([]); badCursor.cursor = "../1"; await assert.rejects(tencentAdapter.list(badCursor));
  const badPayload = request([]); badPayload.transport = { request: async ({ url }) => ({ url, status: 200, headers: {}, text: '{"Code":400,"Data":{"Posts":[],"Count":0}}' }) }; await assert.rejects(tencentAdapter.list(badPayload));
  const abort = new AbortController(); abort.abort(); const cancelled = request([]); cancelled.context = { ...context, signal: abort.signal, throwIfCancelled: () => abort.signal.throwIfAborted() };
  await assert.rejects(tencentAdapter.list(cancelled), { name: "AbortError" });
});

function detailRequest(posts: ReturnType<typeof post>[], options: SourceDefinition["options"] = {}): { input: SourceAdapterRequest; urls: string[] } {
  const urls: string[] = [];
  const input = request(posts);
  input.scope = { roles: ["C#"], regions: [], companyNames: [] };
  input.source = source({ fetchDetails: true, maxDetailRequestsPerPage: 2, ...options });
  input.transport = { request: async ({ url }) => {
    urls.push(url);
    const parsed = new URL(url);
    const data = parsed.pathname.endsWith('/Query') ? { Posts: posts, Count: posts.length }
      : { PostId: parsed.searchParams.get('postId'), Responsibility: 'Assess security', Requirement: 'Build tools with .NET', Introduction: '<p>Synthetic team</p>' };
    return { url, status: 200, headers: {}, text: JSON.stringify({ Code: 200, Data: data }) };
  } };
  return { input, urls };
}

test("bounded official details recover a .NET keyword present only in Requirement with same-ID field evidence", async () => {
  const item = { ...post(), RecruitPostName: 'Synthetic security assessment role', Responsibility: 'Assess security' };
  assert.equal(includesSearchText(`${item.RecruitPostName} ${item.Responsibility}`, '.NET'), false);
  const { input, urls } = detailRequest([item]); input.scope = { roles: ['.NET'], regions: ['CN'], companyNames: [] };
  const result = await createSourceRegistry([tencentAdapter]).list(input);
  assert.equal(urls.length, 2);
  assert.equal(new URL(urls[1]!).pathname, '/tencentcareer/api/post/ByPostId');
  assert.equal(new URL(urls[1]!).searchParams.get('postId'), '123');
  const job = result.records[0]!;
  assert.equal(includesSearchText(job.description!, '.NET'), true);
  assert.equal(job.completeness, 'detail'); assert.equal(result.coverage.complete, true);
  assert.equal(job.availability, 'unknown'); assert.equal(job.sourcePublishedAt, undefined);
  assert.ok(job.description!.includes('岗位职责\nAssess security'));
  assert.ok(job.description!.includes('任职要求\nBuild tools with .NET'));
  for (const selector of ['Data.Responsibility', 'Data.Requirement', 'Data.Introduction']) {
    assert.ok(job.evidence.some((evidence) => evidence.selector === selector && evidence.sourceUrl === urls[1]));
  }
});

test("a mismatched detail identity never injects another posting's requirements", async () => {
  const { input } = detailRequest([{ ...post(), Responsibility: 'Original responsibility without technical token' }]);
  const delegate = input.transport;
  input.transport = { request: async (args) => args.url.includes('/ByPostId')
    ? { url: args.url, status: 200, headers: {}, text: JSON.stringify({ Code: 200, Data: { PostId: '999', Responsibility: 'Wrong job', Requirement: 'OTHER_SECRET_REQUIREMENTS' } }) }
    : delegate.request(args) };
  const result = await tencentAdapter.list(input);
  assert.equal(result.coverage.partial, true); assert.equal(result.coverage.complete, false);
  assert.equal(result.stopReason, 'source-error'); assert.equal(result.records[0]!.completeness, 'excerpt');
  assert.equal(result.records[0]!.description!.includes('OTHER_SECRET_REQUIREMENTS'), false);
  assert.equal(result.records[0]!.evidence.some((evidence) => evidence.selector === 'Data.Requirement'), false);
});

test("the configurable detail limit bounds requests and marks unread requirements as partial", async () => {
  const { input, urls } = detailRequest([post('1'), post('2'), post('3')], { pageSize: 3 });
  const result = await tencentAdapter.list(input);
  assert.equal(urls.length, 3); assert.equal(urls.filter((url) => url.includes('/ByPostId')).length, 2);
  assert.equal(result.records.length, 3); assert.equal(result.records.filter((job) => job.completeness === 'detail').length, 2);
  assert.equal(result.records[2]!.completeness, 'excerpt'); assert.equal(result.coverage.partial, true);
  assert.equal(result.coverage.complete, false); assert.equal(result.stopReason, 'record-limit');
  assert.ok(result.records[2]!.warnings.some((warning) => warning.includes('not proof of no keyword match')));
  assert.ok(result.warnings.some((warning) => warning.includes('2/3') && warning.includes('maximum 2')));
});

test("cancellation during a detail prevents returning a successful page or requesting later details", async () => {
  const { input, urls } = detailRequest([post('1'), post('2')]);
  const abort = new AbortController();
  input.context = { ...context, signal: abort.signal, throwIfCancelled: () => abort.signal.throwIfAborted() };
  const delegate = input.transport;
  input.transport = { request: async (args) => {
    const response = await delegate.request(args);
    if (args.url.includes('/ByPostId')) abort.abort();
    return response;
  } };
  await assert.rejects(tencentAdapter.list(input), { name: 'AbortError' });
  assert.equal(urls.length, 2);
});

test("detail budgets, rate limits, cancellation and authentication failures retain their original failure semantics", async () => {
  for (const failure of [new ToolError('budget-exceeded'), new SourceTransportError('rate-limited', 429, 30),
    new SourceTransportError('cancelled'), new SourceTransportError('http-error', 401), new SourceTransportError('http-error', 403)]) {
    const { input } = detailRequest([post()]); const delegate = input.transport;
    input.transport = { request: async (args) => { if (args.url.includes('/ByPostId')) throw failure; return delegate.request(args); } };
    await assert.rejects(tencentAdapter.list(input), (error) => error === failure);
  }
});

test("a detail timeout retains the downloaded page and successful same-ID details, stops later requests and suppresses pagination", async () => {
  const posts = ['1', '2', '3'].map((id) => ({ ...post(id), RecruitPostName: '服务端工程师', Responsibility: 'Develop services' }));
  const { input, urls } = detailRequest(posts, { pageSize: 3, maxDetailRequestsPerPage: 3 });
  const delegate = input.transport;
  input.transport = { request: async (args) => {
    if (args.url.includes('/Query')) return { ...await delegate.request(args), text: JSON.stringify({ Code: 200, Data: { Posts: posts, Count: 100 } }) };
    urls.push(args.url);
    const id = new URL(args.url).searchParams.get('postId');
    if (id === '2') throw new SourceTransportError('timeout');
    return { url: args.url, status: 200, headers: {}, text: JSON.stringify({ Code: 200, Data: { PostId: id, Responsibility: 'Develop services', Requirement: 'Use C# services' } }) };
  } };
  const result = await createSourceRegistry([tencentAdapter]).list(input);
  assert.equal(urls.length, 3, 'only the list, one successful detail and one timeout are requested');
  assert.deepEqual(urls.filter((url) => url.includes('/ByPostId')).map((url) => new URL(url).searchParams.get('postId')), ['1', '2']);
  assert.deepEqual(result.records.map((record) => record.sourceRecordId), ['1', '2', '3']);
  assert.equal(result.records[0]!.completeness, 'detail'); assert.ok(result.records[0]!.description!.includes('Use C# services'));
  assert.ok(result.records[0]!.evidence.some((evidence) => evidence.selector === 'Data.Requirement' && evidence.sourceUrl === urls[1]));
  assert.equal(result.records[1]!.completeness, 'excerpt'); assert.equal(result.records[2]!.completeness, 'excerpt');
  assert.equal(result.records[1]!.evidence.some((evidence) => evidence.selector === 'Data.Requirement'), false);
  assert.deepEqual(countSourceScopeMatches(result.records, input.scope), { matched: 1, unknown: 2, excluded: 0 });
  assert.equal(result.coverage.fetchedRecords, 3); assert.equal(result.coverage.totalAvailable, 100);
  assert.equal(result.coverage.partial, true); assert.equal(result.coverage.complete, false);
  assert.equal(result.stopReason, 'source-error'); assert.equal(result.nextCursor, undefined);
  assert.ok(result.warnings.some((warning) => warning.includes('timeout') && warning.includes('pagination stopped')));
  assert.ok(result.records[1]!.warnings.some((warning) => warning.includes('timed out') && warning.includes('remain unread')));
});

test("a first-detail timeout returns original excerpts without a positive keyword match or another detail call", async () => {
  const posts = ['1', '2'].map((id) => ({ ...post(id), RecruitPostName: '服务端工程师', Responsibility: 'Develop services' }));
  const { input, urls } = detailRequest(posts);
  const delegate = input.transport;
  input.transport = { request: async (args) => {
    if (!args.url.includes('/ByPostId')) return delegate.request(args);
    urls.push(args.url); throw new SourceTransportError('timeout');
  } };
  const result = await tencentAdapter.list(input);
  assert.equal(urls.length, 2); assert.equal(result.records.length, 2);
  assert.equal(result.records.every((record) => record.completeness === 'excerpt'), true);
  assert.deepEqual(countSourceScopeMatches(result.records, input.scope), { matched: 0, unknown: 2, excluded: 0 });
  assert.equal(result.coverage.partial, true); assert.equal(result.nextCursor, undefined); assert.equal(result.stopReason, 'source-error');
});

test("cancellation concurrent with a detail timeout still propagates rather than returning a retained page", async () => {
  const { input, urls } = detailRequest([post('1'), post('2')]);
  const abort = new AbortController();
  input.context = { ...input.context, signal: abort.signal, throwIfCancelled: () => abort.signal.throwIfAborted() };
  const delegate = input.transport;
  input.transport = { request: async (args) => {
    if (!args.url.includes('/ByPostId')) return delegate.request(args);
    urls.push(args.url); abort.abort(); throw new SourceTransportError('timeout');
  } };
  await assert.rejects(tencentAdapter.list(input), { name: 'AbortError' });
  assert.equal(urls.length, 2);
});

test("a list timeout still propagates because no source page has been received", async () => {
  const { input, urls } = detailRequest([post()]);
  const failure = new SourceTransportError('timeout');
  input.transport = { request: async (args) => { urls.push(args.url); throw failure; } };
  await assert.rejects(tencentAdapter.list(input), (error) => error === failure);
  assert.equal(urls.length, 1); assert.equal(new URL(urls[0]!).pathname.endsWith('/Query'), true);
});

test("detail configuration defaults to no requests and requires an explicit bounded detail endpoint policy", async () => {
  assert.equal(TencentSourceOptionsSchema.parse({}).fetchDetails, false);
  assert.equal(TencentSourceOptionsSchema.parse({}).maxDetailRequestsPerPage, 2);
  assert.equal(TencentSourceOptionsSchema.safeParse({ fetchDetails: true, maxDetailRequestsPerPage: 11 }).success, false);
  assert.equal(TencentSourceOptionsSchema.safeParse({ fetchDetails: true, maxDetailRequestsPerPage: 0 }).success, false);
  const { input, urls } = detailRequest([post()]);
  input.source.endpointPolicy.allowedPathPrefixes = ['/tencentcareer/api/post/Query'];
  await assert.rejects(tencentAdapter.list(input), (error) => error instanceof ToolError && error.code === 'invalid-input');
  assert.equal(urls.length, 0);
});

test("bounded detail slots skip disclosed wrong cities and prioritize unresolved requirements without reordering source records", async () => {
  const posts = [
    { ...post("1"), LocationName: "北京", RecruitPostName: "C# 后端工程师" },
    { ...post("2"), LocationName: "上海", RecruitPostName: "C# 后端工程师" },
    { ...post("3"), RecruitPostName: "C# 后端工程师" },
    { ...post("4"), RecruitPostName: "服务端开发工程师", Responsibility: "负责后端系统" },
    { ...post("5"), RecruitPostName: "C++后端工程师", Responsibility: "负责后端系统" },
  ];
  const { input, urls } = detailRequest(posts, { pageSize: 5, maxDetailRequestsPerPage: 2 });
  input.scope = { roles: ["C# 后端"], regions: ["深圳"], countryCodes: ["CN"], companyNames: [] };
  const delegate = input.transport;
  input.transport = { request: async (args) => {
    if (!args.url.includes('/ByPostId')) return delegate.request(args);
    urls.push(args.url); const id = new URL(args.url).searchParams.get('postId');
    return { url: args.url, status: 200, headers: {}, text: JSON.stringify({ Code: 200, Data: {
      PostId: id, Responsibility: '负责后端系统', Requirement: id === '4' ? '熟悉 C#，能够设计后端业务服务' : '仅使用 C++17，开发高性能后端',
    } }) };
  } };
  const result = await tencentAdapter.list(input);
  const detailUrls = urls.filter((url) => url.includes('/ByPostId'));
  assert.deepEqual(detailUrls.map((url) => new URL(url).searchParams.get('postId')), ['4', '5']);
  assert.equal(urls.length, 3, 'one list plus the existing two-detail limit');
  assert.deepEqual(result.records.map((job) => job.sourceRecordId), ['1', '2', '3', '4', '5']);
  assert.deepEqual(result.records.map((job) => assessSourceScopeMatch(job, input.scope).status), ['excluded', 'excluded', 'matched', 'matched', 'excluded']);
  assert.ok(result.records[3]!.evidence.some((evidence) => evidence.selector === 'Data.Requirement' && evidence.sourceUrl === detailUrls[0]));
  assert.equal(result.records[2]!.completeness, 'excerpt', 'a known exact excerpt does not consume scarce detail slots ahead of unknown requirements');
  assert.equal(result.coverage.partial, true);
});

test("eligible excerpts outside the unchanged detail cap remain counted as unknown, never accepted as keyword hits", async () => {
  const posts = ['1', '2', '3'].map((id) => ({ ...post(id), RecruitPostName: '服务端工程师', Responsibility: '开发业务服务' }));
  const { input, urls } = detailRequest(posts, { pageSize: 3, maxDetailRequestsPerPage: 2 });
  input.scope = { roles: ['C#'], regions: ['深圳'], companyNames: [] };
  const result = await tencentAdapter.list(input);
  assert.equal(urls.filter((url) => url.includes('/ByPostId')).length, 2);
  assert.deepEqual(countSourceScopeMatches(result.records, input.scope), { matched: 0, unknown: 1, excluded: 2 });
  assert.equal(result.records[2]!.completeness, 'excerpt');
  assert.ok(result.warnings.some((warning) => warning.includes('unknown for 1 eligible excerpts') && warning.includes('not counted as confirmed keyword matches')));
  assert.equal(result.coverage.partial, true); assert.equal(result.coverage.complete, false);
});
