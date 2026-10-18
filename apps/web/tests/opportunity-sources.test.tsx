import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createOpportunity } from "../src/lib/opportunities.ts";
import { createOpportunitySourceMiddleware, fetchOpportunitySource } from "../server/opportunity-sources.ts";

const AT = "2026-10-17T06:00:00.000Z";
const PUBLISHED = "2026-10-01T08:00:00.000Z";
const UPDATED = "2026-10-16T09:00:00.000Z";
const options = { now: () => new Date(AT) };
const greenhouse = {
  id: 42, title: "Backend Engineer", company_name: "Example Corp",
  absolute_url: "https://careers.example.com/jobs/42",
  content: "&lt;p&gt;Build C# &amp;amp; SQL systems.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Write tests&lt;/li&gt;&lt;/ul&gt;<script>discard</script>",
  location: { name: "Remote, United States / London" }, departments: [{ name: "Engineering" }],
  first_published: PUBLISHED, updated_at: UPDATED,
};
const lever = {
  id: "job-43", text: "Senior Developer", hostedUrl: "https://jobs.lever.co/example/job-43",
  applyUrl: "https://jobs.lever.co/example/job-43/apply", createdAt: Date.parse(PUBLISHED),
  descriptionPlain: "Opening, kept once.", openingPlain: "Opening, kept once.",
  lists: [{ text: "Requirements", content: "<ul><li>C# experience</li><li>Write &amp; explain tests</li></ul>" }],
  additionalPlain: "Closing statement.", categories: { location: "Fallback location", allLocations: ["New York", "London"] },
  workplaceType: "remote",
};
const tencent = {
  PostId: "2059160518509379584", RecruitPostId: 120228,
  RecruitPostName: "示例-后台开发", CountryName: "中国", LocationName: "北京",
  BGName: "IEG", CategoryName: "技术", RequireWorkYearsName: "三年以上工作经验",
  Responsibility: "<p>参与服务端研发。</p><script>discard</script>\n优化系统。",
  LastUpdateTime: "2026年10月15日",
  PostURL: "http://careers.tencent.com/jobdesc.html?postId=2059160518509379584",
  IsValid: true,
};

function json(value: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
}

test("机会主源仅使用固定官方 HTTPS API，不向用户给定 URL 发请求", async () => {
  let calls = 0;
  const request: typeof fetch = async (url, init) => {
    calls += 1;
    assert.equal(String(url), "https://boards-api.greenhouse.io/v1/boards/example-board/jobs?content=true");
    assert.equal(init?.redirect, "manual");
    assert.ok(init?.signal);
    const headers = new Headers(init?.headers);
    assert.equal(headers.has("Cookie"), false);
    assert.equal(headers.has("Authorization"), false);
    return json({ jobs: [greenhouse] });
  };
  const result = await fetchOpportunitySource({ provider: "greenhouse", company: " Example-Board ", url: "https://127.0.0.1/private" }, request, options);
  assert.equal(result.company, "example-board");
  assert.equal(result.provider, "greenhouse");
  assert.equal(result.observedAt, AT);
  assert.equal(calls, 1);
  for (const value of [null, [], { provider: "indeed", company: "example" }, { provider: "lever", company: "https://api.lever.co" }, { provider: "lever", company: "../example" }, { provider: "lever", company: "example?url=evil" }, { provider: "lever", company: "-example" }, { provider: "lever", company: "example_" }, { provider: "lever", company: "a".repeat(65) }]) {
    await assert.rejects(() => fetchOpportunitySource(value, request, options));
  }
  assert.equal(calls, 1);
});

test("Greenhouse 采集保持原文、发布/更新/观察时间独立且不推断市场和远程资格", async () => {
  const result = await fetchOpportunitySource({ provider: "greenhouse", company: "example" }, async () => json({ jobs: [greenhouse] }), options);
  const job = result.jobs[0]!;
  assert.equal(job.company, "Example Corp");
  assert.equal(job.sourceJobId, "42");
  assert.equal(job.sourceUrl, greenhouse.absolute_url);
  assert.equal(job.applicationUrl, greenhouse.absolute_url);
  assert.equal(job.discoveryUrl, result.sourceUrl);
  assert.equal(job.status, "open");
  assert.equal(job.sourcePublishedAt, PUBLISHED);
  assert.equal(job.sourceUpdatedAt, UPDATED);
  assert.equal(job.collectedAt, AT);
  assert.equal(job.lastVerifiedAt, AT);
  assert.equal(job.lastVerificationMethod, "source-read");
  assert.deepEqual(job.location, { country: "", region: "", city: "" });
  assert.equal(job.market, "unknown");
  assert.equal(job.workMode, "unknown");
  assert.deepEqual(job.remoteEligibleRegions, []);
  assert.match(job.description!, /工作地点（原文）：Remote, United States \/ London/);
  assert.match(job.description!, /Build C# & SQL systems/);
  assert.match(job.description!, /Write tests/);
  assert.doesNotMatch(job.description!, /<\/?(?:p|ul|li|script)>|discard/);
  assert.equal(createOpportunity(job, AT).application.stage, "saved");
});

test("缺失或不合法的来源发布日期不会用更新时间和采集时间补齐", async () => {
  for (const first_published of [undefined, "not a date", "2026-02-30T08:00:00Z", "2026-10-01", "tomorrow"]) {
    const result = await fetchOpportunitySource({ provider: "greenhouse", company: "example" }, async () => json({ jobs: [{ ...greenhouse, first_published }] }), options);
    assert.equal(result.jobs[0]!.sourcePublishedAt, undefined);
    assert.equal(result.jobs[0]!.sourceUpdatedAt, UPDATED);
  }
});

test("Lever 保留原申请链接、毫秒创建时间、多地点和完整正文但不把 remote 当工作授权", async () => {
  const result = await fetchOpportunitySource({ provider: "lever", company: "example" }, async (url) => {
    assert.equal(String(url), "https://api.lever.co/v0/postings/example?mode=json");
    return json([lever]);
  }, options);
  const job = result.jobs[0]!;
  assert.equal(job.company, "example");
  assert.equal(job.sourceUrl, lever.hostedUrl);
  assert.equal(job.applicationUrl, lever.applyUrl);
  assert.equal(job.discoveryUrl, result.sourceUrl);
  assert.equal(job.sourcePublishedAt, PUBLISHED);
  assert.equal(job.sourceUpdatedAt, undefined);
  assert.equal(job.lastVerifiedAt, AT);
  assert.equal(job.lastVerificationMethod, "source-read");
  assert.equal(job.workMode, "remote");
  assert.equal(job.market, "unknown");
  assert.deepEqual(job.remoteEligibleRegions, []);
  assert.equal(job.description!.match(/Opening, kept once/g)?.length, 1);
  assert.match(job.description!, /New York, London/);
  assert.match(job.description!, /Requirements\n• C# experience/);
  assert.match(job.description!, /Write & explain tests/);
  assert.match(job.description!, /Closing statement/);
  assert.doesNotMatch(job.description!, /<[^>]+>|Fallback location/);
  assert.equal(createOpportunity(job, AT).application.submittedAt, undefined);
});

test("采集最多返回 300 条且截断明确，不把无岗位或格式不对当作同一种结果", async () => {
  const result = await fetchOpportunitySource({ provider: "lever", company: "example" }, async () => json(Array.from({ length: 301 }, (_, index) => ({ ...lever, id: index, hostedUrl: `https://jobs.lever.co/example/${index}` }))), options);
  assert.equal(result.jobs.length, 300);
  assert.equal(result.truncated, true);
  const empty = await fetchOpportunitySource({ provider: "greenhouse", company: "example" }, async () => json({ jobs: [] }), options);
  assert.deepEqual(empty.jobs, []);
  assert.equal(empty.truncated, false);
  for (const [provider, payload] of [["greenhouse", {}], ["greenhouse", []], ["lever", {}], ["lever", null]] as const) {
    await assert.rejects(() => fetchOpportunitySource({ provider, company: "example" }, async () => json(payload), options), /格式/);
  }
});

test("腾讯官网按用户关键词仅请求固定官方第一页，并显式标记仍有更多结果", async () => {
  let calls = 0;
  const result = await fetchOpportunitySource({ provider: "tencent", company: "tencent", keyword: " 后台 & C++ ", url: "https://127.0.0.1/private" }, async (value, init) => {
    calls += 1;
    const url = new URL(String(value));
    assert.equal(url.origin, "https://careers.tencent.com");
    assert.equal(url.pathname, "/tencentcareer/api/post/Query");
    assert.equal(url.searchParams.get("keyword"), "后台 & C++");
    assert.equal(url.searchParams.get("pageIndex"), "1");
    assert.equal(url.searchParams.get("pageSize"), "100");
    assert.equal(url.searchParams.get("language"), "zh-cn");
    assert.equal(init?.redirect, "manual");
    assert.ok(init?.signal);
    assert.equal(new Headers(init?.headers).has("Cookie"), false);
    return json({ Code: 200, Data: { Count: 112, Posts: [tencent] } });
  }, options);
  assert.equal(calls, 1);
  assert.equal(result.provider, "tencent");
  assert.equal(result.jobs.length, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.jobs[0]!.discoveryUrl, result.sourceUrl);
  for (const invalid of [{ company: "other" }, { company: "https://careers.tencent.com" }, { keyword: "a".repeat(81) }, { keyword: "hello\nworld" }, { keyword: 42 }]) {
    await assert.rejects(() => fetchOpportunitySource({ provider: "tencent", company: "tencent", ...invalid }, async () => { calls += 1; return json({}); }, options));
  }
  assert.equal(calls, 1);
});

test("腾讯保留独立岗位号、官方HTTPS链接、明确地点与职责摘录，更新日期不冒充发布或精确时间", async () => {
  const result = await fetchOpportunitySource({ provider: "tencent", company: "tencent" }, async () => json({ Code: 200, Data: { Count: 1, Posts: [tencent] } }), options);
  const job = result.jobs[0]!;
  assert.equal(result.truncated, false);
  assert.equal(job.company, "腾讯");
  assert.equal(job.sourcePlatform, "腾讯招聘官网");
  assert.equal(job.sourceJobId, tencent.PostId);
  assert.equal(job.sourceUrl, "https://careers.tencent.com/jobdesc.html?postId=2059160518509379584");
  assert.equal(job.applicationUrl, job.sourceUrl);
  assert.deepEqual(job.location, { country: "中国", region: "", city: "北京" });
  assert.equal(job.market, "domestic");
  assert.equal(job.workMode, "unknown");
  assert.equal(job.employmentType, "unknown");
  assert.deepEqual(job.remoteEligibleRegions, []);
  assert.equal(job.sourcePublishedAt, undefined);
  assert.equal(job.sourcePublishedText, undefined);
  assert.equal(job.sourceUpdatedAt, undefined);
  assert.equal(job.firstDiscoveredAt, AT);
  assert.equal(job.collectedAt, AT);
  assert.equal(job.lastVerifiedAt, AT);
  assert.equal(job.lastVerificationMethod, "source-read");
  assert.equal(job.status, "open");
  assert.match(job.description!, /搜索结果摘录/);
  assert.match(job.description!, /完整任职要求/);
  assert.match(job.description!, /来源最后更新日期（原文）：2026年10月15日/);
  assert.match(job.description!, /不是原始发布日期/);
  assert.match(job.description!, /招聘编号（非唯一岗位编号）：120228/);
  assert.match(job.description!, /参与服务端研发/);
  assert.doesNotMatch(job.description!, /<[^>]+>|discard/);
  assert.equal(createOpportunity(job, AT).application.stage, "saved");
});

test("腾讯多地点和其他国家保持原文待分类，同招聘编号的独立PostId不会合并", async () => {
  const posts = [
    { ...tencent, CountryName: "美国", LocationName: "洛杉矶/纽约", IsValid: false },
    { ...tencent, PostId: "2059160518509379585", PostURL: undefined, CountryName: "中国香港", LocationName: "香港", LastUpdateTime: undefined, IsValid: undefined },
  ];
  const { jobs } = await fetchOpportunitySource({ provider: "tencent", company: "tencent" }, async () => json({ Code: 200, Data: { Count: 2, Posts: posts } }), options);
  assert.equal(jobs.length, 2);
  assert.notEqual(jobs[0]!.sourceJobId, jobs[1]!.sourceJobId);
  assert.notEqual(jobs[0]!.sourceUrl, jobs[1]!.sourceUrl);
  assert.deepEqual(jobs[0]!.location, { country: "美国", region: "", city: "" });
  assert.match(jobs[0]!.description!, /洛杉矶\/纽约/);
  assert.equal(jobs[0]!.market, "unknown");
  assert.equal(jobs[0]!.status, "closed");
  assert.deepEqual(jobs[1]!.location, { country: "中国香港", region: "", city: "香港" });
  assert.equal(jobs[1]!.market, "unknown");
  assert.equal(jobs[1]!.status, "unknown");
  assert.doesNotMatch(jobs[1]!.description!, /来源最后更新日期/);
});

test("腾讯搜索提供的官方 Workday 租户原链接保留，仅请求腾讯搜索接口一次", async () => {
  const original = "https://tencent.wd1.myworkdayjobs.com/Tencent_Careers/job/China-Shenzhen/_R108057-2";
  let calls = 0;
  const result = await fetchOpportunitySource({ provider: "tencent", company: "tencent" }, async (url) => {
    calls += 1;
    assert.equal(new URL(String(url)).hostname, "careers.tencent.com");
    return json({ Code: 200, Data: { Count: 1, Posts: [{ ...tencent, PostURL: original }] } });
  }, options);
  assert.equal(calls, 1);
  assert.equal(result.jobs[0]!.sourceUrl, original);
  assert.equal(result.jobs[0]!.applicationUrl, original);
  assert.equal(result.jobs[0]!.sourceJobId, tencent.PostId);
});

test("腾讯成功空结果与格式错误区别处理，并限制100条和拒绝非官方岗位链接", async () => {
  const empty = await fetchOpportunitySource({ provider: "tencent", company: "tencent" }, async () => json({ Code: 200, Data: { Count: 0, Posts: [] } }), options);
  assert.deepEqual(empty.jobs, []);
  assert.equal(empty.truncated, false);
  const capped = await fetchOpportunitySource({ provider: "tencent", company: "tencent" }, async () => json({ Code: 200, Data: { Count: 101, Posts: Array.from({ length: 101 }, (_, index) => ({ ...tencent, PostId: String(index + 1), PostURL: undefined })) } }), options);
  assert.equal(capped.jobs.length, 100);
  assert.equal(capped.truncated, true);
  for (const payload of [null, [], { Code: 500, Data: { Count: 0, Posts: [] } }, { Code: 200, Data: { Posts: [] } }, { Code: 200, Data: { Count: "1", Posts: [tencent] } }, { Code: 200, Data: { Count: 0, Posts: [tencent] } }]) {
    await assert.rejects(() => fetchOpportunitySource({ provider: "tencent", company: "tencent" }, async () => json(payload), options));
  }
  for (const patch of [{ PostId: 2059160518509379584 }, { PostId: "../private" }, { PostURL: "https://evil.example/jobdesc.html?postId=2059160518509379584" }, { PostURL: "https://careers.tencent.com/jobdesc.html?postId=1" }, { PostURL: "https://careers.tencent.com:8080/jobdesc.html?postId=2059160518509379584" }, { PostURL: "https://careers.tencent.com@evil.example/jobdesc.html?postId=2059160518509379584" }, { PostURL: "https://other.wd1.myworkdayjobs.com/Tencent_Careers/job/1" }, { PostURL: "https://tencent.wd1.myworkdayjobs.com/Other_Careers/job/1" }]) {
    await assert.rejects(() => fetchOpportunitySource({ provider: "tencent", company: "tencent" }, async () => json({ Code: 200, Data: { Count: 1, Posts: [{ ...tencent, ...patch }] } }), options), /岗位编号|岗位链接/);
  }
});

test("重定向、失败状态、非 JSON、过大响应、缺职位和危险链接明确失败", async () => {
  for (const response of [new Response(null, { status: 302, headers: { location: "https://127.0.0.1/private" } }), new Response("not found", { status: 404 }), new Response("<html>login</html>", { headers: { "Content-Type": "text/html" } }), json({ jobs: [] }, { "Content-Length": String(8 * 1024 * 1024 + 1) }), new Response("not JSON", { headers: { "Content-Type": "application/json" } }), new Response(new Uint8Array(8 * 1024 * 1024 + 1), { headers: { "Content-Type": "application/json" } })]) {
    let calls = 0;
    await assert.rejects(() => fetchOpportunitySource({ provider: "greenhouse", company: "example" }, async () => { calls += 1; return response; }, options));
    assert.equal(calls, 1);
  }
  for (const absolute_url of ["javascript:alert(1)", "https://user:secret@example.com/", "http://jobs.example.com/", "https://127.0.0.1/private", "https://jobs.internal/private", "https://jobs.example.com:8080/job"]) {
    await assert.rejects(() => fetchOpportunitySource({ provider: "greenhouse", company: "example" }, async () => json({ jobs: [{ ...greenhouse, absolute_url }] }), options), /链接/);
  }
  await assert.rejects(() => fetchOpportunitySource({ provider: "greenhouse", company: "example" }, async () => json({ jobs: [{ ...greenhouse, title: "" }] }), options), /职位信息/);
});

test("超时涵盖等待响应和读取正文流，并取消未完成正文", async () => {
  await assert.rejects(() => fetchOpportunitySource({ provider: "greenhouse", company: "example" }, async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }), { ...options, timeoutMs: 5 }), /超时/);
  let cancelled = false;
  await assert.rejects(() => fetchOpportunitySource({ provider: "greenhouse", company: "example" }, async () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { headers: { "Content-Type": "application/json" } }), { ...options, timeoutMs: 5 }), /超时/);
  assert.equal(cancelled, true);
});

test("机会来源端点限制同源、方法、JSON、请求大小，其他路由交给 next", async () => {
  let calls = 0;
  const middleware = createOpportunitySourceMiddleware(async () => { calls += 1; return json({ jobs: [greenhouse] }); });
  const server = createServer((request, response) => { void middleware(request, response, () => { response.writeHead(404); response.end(); }); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { Origin: origin, "Content-Type": "application/json" };
  const body = JSON.stringify({ provider: "greenhouse", company: "example" });
  try {
    const ok = await fetch(`${origin}/api/opportunities/source`, { method: "POST", headers, body });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json() as { jobs: unknown[] }).jobs.length, 1);
    const cases: Array<[string, RequestInit, number]> = [
      ["/other", {}, 404],
      ["/api/opportunities/source", {}, 405],
      ["/api/opportunities/source", { method: "POST", headers: { ...headers, Origin: "https://evil.example" }, body }, 403],
      ["/api/opportunities/source", { method: "POST", headers: { "Content-Type": "application/json" }, body }, 403],
      ["/api/opportunities/source", { method: "POST", headers: { ...headers, Origin: origin.replace("http:", "https:") }, body }, 403],
      ["/api/opportunities/source", { method: "POST", headers: { ...headers, "Sec-Fetch-Site": "same-site" }, body }, 403],
      ["/api/opportunities/source", { method: "POST", headers: { ...headers, "Content-Type": "text/plain" }, body }, 415],
      ["/api/opportunities/source", { method: "POST", headers, body: "x".repeat(32_001) }, 413],
      ["/api/opportunities/source", { method: "POST", headers, body: "null" }, 422],
      ["/api/opportunities/source", { method: "POST", headers, body: "{" }, 422],
    ];
    for (const [route, init, status] of cases) {
      const response = await fetch(`${origin}${route}`, init);
      assert.equal(response.status, status);
      await response.arrayBuffer();
    }
    assert.equal(calls, 1);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
