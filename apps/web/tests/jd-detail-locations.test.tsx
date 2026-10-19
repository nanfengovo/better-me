import assert from "node:assert/strict";
import test from "node:test";
import { extractPublicJobHtml, fetchPublicJd } from "../server/jd-extractor.ts";
import { extractJdLink, readJdBrowserSession } from "../src/lib/jd-import.ts";
import { PlatformDetailLocationsSchema } from "@better-me/source-adapters/browser-contracts";
import { JdExtractionError } from "../src/lib/jd-errors.ts";

const description = "岗位职责：研发设备通信服务并交付自动化回归测试用例，维护可追踪技术文档。任职要求：熟悉 C#、SQL Server、异步编程、单元测试，并能阅读英文技术文档。";
const address = { "@type": "Place", address: { "@type": "PostalAddress", addressCountry: "CN", addressRegion: "上海", addressLocality: "上海", streetAddress: "合成办公路100号", postalCode: "200001" } };
const at = "2026-10-19T09:00:00.000Z";
const fixtures = [
  { platform: "BOSS直聘", provider: "boss", url: "https://www.zhipin.com/job_detail/synthetic.html", className: "job-sec-text" },
  { platform: "猎聘", provider: "liepin", url: "https://www.liepin.com/job/123456.shtml", className: "job-intro-content" },
  { platform: "51JOB", provider: "51job", url: "https://jobs.51job.com/shanghai/123456.html", className: "job_msg" },
  { platform: "LinkedIn", provider: "linkedin", url: "https://www.linkedin.com/jobs/view/synthetic-123456", className: "show-more-less-html__markup" },
] as const;
const posting = (url?: string) => ({ "@type": "JobPosting", title: "合成研发岗位", description, ...(url ? { url } : {}), jobLocation: address });
const script = (value: unknown) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
const html = (value: unknown, className: string, canonical?: string) => `<title>合成研发岗位</title><h1>合成研发岗位</h1>${canonical ? `<link rel="canonical" href="${canonical}">` : ""}${script(value)}<div class="${className}">${description}</div>`;

for (const f of fixtures) test(`${f.platform} accepted same-job structured addresses remain separate from JD text with exact capture binding`, async () => {
  const page = html(posting(f.url), f.className);
  const extracted = extractPublicJobHtml(page, f.platform, f.url, { requireVisibleDescription: true, capturedAt: at });
  assert.match(extracted.text, /C#/); assert.doesNotMatch(extracted.text, /合成办公路/);
  assert.equal(extracted.detailLocations?.provider, f.provider); assert.equal(extracted.detailLocations?.url, f.url); assert.equal(extracted.detailLocations?.capturedAt, at);
  assert.equal(extracted.detailLocations?.locations[0].streetAddress, "合成办公路100号"); assert.equal(extracted.detailLocations?.locations[0].evidence.quote, JSON.stringify(address));
  const fetched = await fetchPublicJd(f.url, (async () => new Response(page, { headers: { "content-type": "text/html" } })) as typeof fetch);
  assert.equal(fetched.detailLocations?.capturedAt, fetched.provenance.observedAt); assert.equal(fetched.detailLocations?.url, fetched.provenance.url); assert.ok(PlatformDetailLocationsSchema.safeParse(fetched.detailLocations).success);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify(fetched), { headers: { "content-type": "application/json" } });
    assert.deepEqual((await extractJdLink(f.url, new AbortController().signal)).detailLocations, fetched.detailLocations);
  } finally { globalThis.fetch = originalFetch; }
});

test("a matching selected job never inherits a recommendation's address; other-job identity still fails the existing reader", () => {
  const f = fixtures[1], target = { ...posting(f.url), jobLocation: undefined }, other = { ...posting("https://www.liepin.com/job/999999.shtml"), title: "推荐其他岗位" };
  const extracted = extractPublicJobHtml(html([other, target], f.className), f.platform, f.url);
  assert.equal(extracted.detailLocations, undefined); assert.match(extracted.text, /合成研发岗位/);
  assert.throws(() => extractPublicJobHtml(html(other, f.className), f.platform, f.url), error => error instanceof JdExtractionError && error.failure.code === "job_mismatch");
});

test("source-less metadata and title-only identity do not establish a location; paired canonical and title can bind a URL-less posting", () => {
  const f = fixtures[0], page = html(posting(), f.className);
  assert.equal(extractPublicJobHtml(page, f.platform).detailLocations, undefined);
  assert.equal(extractPublicJobHtml(page, f.platform, f.url).detailLocations, undefined);
  assert.equal(extractPublicJobHtml(html(posting(), f.className, f.url), f.platform, f.url).detailLocations?.locations[0].city, "上海");
  assert.equal(extractPublicJobHtml(html(posting(f.url), f.className).replace(description, "metadata summary too short"), f.platform, f.url).detailLocations, undefined);
});

test("duplicate postings cannot arbitrarily choose conflicting offices or remote status and malformed addresses preserve usable JD", () => {
  const f = fixtures[1], original = posting(f.url);
  const otherAddress = { address: { ...address.address, streetAddress: "另一条合成路200号" } };
  for (const duplicate of [{ ...original, jobLocation: otherAddress }, { ...original, jobLocation: { address: { addressLocality: 123 } } }, { ...original, jobLocationType: "TELECOMMUTE" }]) {
    const actual = extractPublicJobHtml(html([original, duplicate], f.className), f.platform, f.url);
    assert.equal(actual.detailLocations, undefined); assert.match(actual.text, /C#/);
  }
  assert.equal(extractPublicJobHtml(html([original, original], f.className), f.platform, f.url).detailLocations?.locations.length, 1);
  const multi = extractPublicJobHtml(html({ ...original, jobLocation: [address, otherAddress] }, f.className), f.platform, f.url);
  assert.equal(multi.detailLocations?.locations.length, 2); assert.equal(multi.detailLocations?.locations[1].evidence.selector, "jobLocation[1]");
  const remote = extractPublicJobHtml(html({ ...original, jobLocation: undefined, jobLocationType: "TELECOMMUTE" }, f.className), f.platform, f.url);
  assert.equal(remote.detailLocations?.workMode, "remote"); assert.deepEqual(remote.detailLocations?.locations, []); assert.equal(remote.detailLocations?.workModeEvidence?.quote, '"TELECOMMUTE"');
  for (const jobLocation of [{ address: { streetAddress: "x".repeat(1001) } }, { address: { addressLocality: "\n上海" } }, { address: { postalCode: 200001 } }]) assert.equal(extractPublicJobHtml(html({ ...original, jobLocation }, f.className), f.platform, f.url).detailLocations, undefined);
});

test("client transports preserve exact details but reject malformed fields and URL/platform/time binding mismatches; legacy payloads still work", async () => {
  const f = fixtures[1], parsed = extractPublicJobHtml(html(posting(f.url), f.className), f.platform, f.url, { capturedAt: at });
  const payload = { ...parsed, provenance: { kind: "link", platform: f.platform, url: f.url, observedAt: at } };
  const originalFetch = globalThis.fetch;
  const request = async (value: unknown) => { globalThis.fetch = async () => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } }); return extractJdLink(f.url, new AbortController().signal); };
  try {
    assert.deepEqual((await request(payload)).detailLocations, parsed.detailLocations);
    const legacy = { ...payload, detailLocations: undefined }; assert.equal((await request(legacy)).detailLocations, undefined);
    await request(payload);
    const sessionResult = await readJdBrowserSession({ sessionId: "12345678-1234-4123-8123-123456789012", platform: f.platform, url: f.url, expiresAt: "2026-10-19T10:00:00Z" }, new AbortController().signal);
    assert.deepEqual(sessionResult.detailLocations, parsed.detailLocations);
    for (const patch of [{ detailLocations: null }, { detailLocations: { ...parsed.detailLocations, url: "https://www.liepin.com/job/654321.shtml" } }, { detailLocations: { ...parsed.detailLocations, capturedAt: "2026-10-19T09:00:01.000Z" } }, { detailLocations: { ...parsed.detailLocations, provider: "boss" } }, { detailLocations: { ...parsed.detailLocations, locations: [{ ...parsed.detailLocations!.locations[0], streetAddress: "篡改街道" }] } }, { provenance: { ...payload.provenance, platform: "LinkedIn" } }, { provenance: { ...payload.provenance, platform: undefined } }, { provenance: { ...payload.provenance, kind: "screenshot" } }]) await assert.rejects(request({ ...payload, ...patch }), error => error instanceof JdExtractionError && error.failure.code === "service_unavailable");
  } finally { globalThis.fetch = originalFetch; }
});

const visibleOffice = { selector: "liepin-work-address", label: "工作地址", text: "上海市浦东新区合成办公路100号" } as const;
const nativeOptions = { requireVisibleDescription: true, allowValidatedLiepinDescription: true, visibleOfficeDisclosures: [visibleOffice], capturedAt: at };
function nativeHtml(metadata?: unknown) {
  return `<title>合成研发岗位</title><h1>合成研发岗位</h1><link rel="canonical" href="${fixtures[1].url}">${metadata ? script(metadata) : ""}<section class="job-intro-container"><dl class="paragraph"><dt>职位描述</dt><dd>${description}</dd></dl></section>`;
}

test("native same-job visible office sidecar binds V2 and keeps address outside accepted JD and administrative facts", () => {
  for (const metadata of [undefined, { ...posting(fixtures[1].url), jobLocation: undefined }]) {
    const result = extractPublicJobHtml(nativeHtml(metadata), "猎聘", fixtures[1].url, nativeOptions);
    assert.match(result.text, /C#/); assert.doesNotMatch(result.text, /合成办公路|工作地址/);
    const capture = result.detailLocations!;
    assert.ok(PlatformDetailLocationsSchema.safeParse(capture).success);
    assert.equal(capture.version, 2); assert.equal(capture.url, fixtures[1].url); assert.equal(capture.capturedAt, at);
    assert.equal(capture.locations[0].streetAddress, visibleOffice.text);
    assert.equal(capture.locations[0].countryCode, undefined); assert.equal(capture.locations[0].city, undefined);
    assert.equal(capture.locations[0].evidence.quote, JSON.stringify(visibleOffice));
  }
});

test("visible office sidecars require the native flag, one adopted duties owner and a meaningful current title", () => {
  for (const options of [{}, { ...nativeOptions, requireVisibleDescription: false }, { ...nativeOptions, allowValidatedLiepinDescription: false }, { ...nativeOptions, visibleOfficeDisclosures: [] }]) {
    try { assert.equal(extractPublicJobHtml(nativeHtml(), "猎聘", fixtures[1].url, options).detailLocations, undefined); }
    catch (error) { assert.ok(error instanceof JdExtractionError && error.failure.code === "unsupported_page"); }
  }
  for (const page of [nativeHtml().replace(/合成研发岗位/g, "职位详情"), nativeHtml().replace("职位描述", "工作地址"), nativeHtml().replace("job-intro-container", "job-intro-content"), nativeHtml().replace("</section>", `</section><section class="job-intro-container"><dl class="paragraph"><dt>工作地址</dt><dd>其他所有者</dd></dl></section>`), nativeHtml().replace("</section>", `<dl class="paragraph"><dt>岗位职责</dt><dd>${description}</dd></dl></section>`)]) {
    try { assert.equal(extractPublicJobHtml(page, "猎聘", fixtures[1].url, nativeOptions).detailLocations, undefined); }
    catch (error) { assert.ok(error instanceof JdExtractionError && error.failure.code === "unsupported_page"); }
  }
  const foreign = nativeHtml().replaceAll(fixtures[1].url, "https://www.liepin.com/job/999999.shtml");
  assert.throws(() => extractPublicJobHtml(foreign, "猎聘", fixtures[1].url, nativeOptions), error => error instanceof JdExtractionError && error.failure.code === "job_mismatch");
  const unsupported = nativeHtml().replaceAll(fixtures[1].url, "https://www.liepin.com/job/unknown.shtml");
  assert.throws(() => extractPublicJobHtml(unsupported, "猎聘", "https://www.liepin.com/job/unknown.shtml", nativeOptions), error => error instanceof JdExtractionError && error.failure.code === "unsupported_page");
});

test("visible office cannot override conflicting, malformed or remote metadata, and identical structured street keeps V1", () => {
  const target = posting(fixtures[1].url);
  for (const metadata of [target, { ...target, jobLocation: { address: { addressLocality: 42 } } }, { ...target, jobLocation: { address: { addressLocality: "上海" } } }]) {
    const result = extractPublicJobHtml(nativeHtml(metadata), "猎聘", fixtures[1].url, nativeOptions);
    assert.equal(result.detailLocations, undefined); assert.match(result.text, /C#/);
  }
  const remote = extractPublicJobHtml(nativeHtml({ ...target, jobLocation: undefined, jobLocationType: "TELECOMMUTE" }), "猎聘", fixtures[1].url, nativeOptions);
  assert.equal(remote.detailLocations?.workMode, "remote"); assert.deepEqual(remote.detailLocations?.locations, []);
  const consistent = extractPublicJobHtml(nativeHtml({ ...target, jobLocation: { address: { streetAddress: visibleOffice.text } } }), "猎聘", fixtures[1].url, nativeOptions);
  assert.equal(consistent.detailLocations?.version, 1); assert.equal(consistent.detailLocations?.locations[0].streetAddress, visibleOffice.text);
  const rejectedMetadata = nativeHtml({ ...target, description: "metadata summary is too short", jobLocation: undefined });
  assert.equal(extractPublicJobHtml(rejectedMetadata, "猎聘", fixtures[1].url, nativeOptions).detailLocations, undefined);
});

test("client accepts native V2 evidence with exact binding and rejects changed quote, provider, timestamp and address", async () => {
  const parsed = extractPublicJobHtml(nativeHtml(), "猎聘", fixtures[1].url, nativeOptions);
  const payload = { ...parsed, provenance: { kind: "link", platform: "猎聘", url: fixtures[1].url, observedAt: at } };
  const originalFetch = globalThis.fetch;
  const request = async (value: unknown) => { globalThis.fetch = async () => new Response(JSON.stringify(value)); return extractJdLink(fixtures[1].url, new AbortController().signal); };
  try {
    assert.deepEqual((await request(payload)).detailLocations, parsed.detailLocations);
    const location = parsed.detailLocations!.locations[0];
    for (const patch of [{ provider: "linkedin" }, { capturedAt: "2026-10-19T09:00:01.000Z" }, { locations: [{ ...location, streetAddress: "另一条合成路1号" }] }, { locations: [{ ...location, evidence: { ...location.evidence, quote: JSON.stringify({ ...visibleOffice, text: "篡改路1号" }) } }] }]) {
      await assert.rejects(request({ ...payload, detailLocations: { ...parsed.detailLocations, ...patch } }), error => error instanceof JdExtractionError && error.failure.code === "service_unavailable");
    }
  } finally { globalThis.fetch = originalFetch; }
});
