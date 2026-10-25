import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILTIN_PLATFORM_SEARCH_CATALOG, BUILTIN_PLATFORM_SEARCH_REGIONS, PLATFORM_SEARCH_PROVIDERS,
  PlatformSearchCatalogSchema, PlatformSearchError, PlatformSearchRegionsSchema,
  buildPlatformSearchRequest, listPlatformSearchRegions, resolvePlatformSearchRegion,
  type PlatformSearchInput, type PlatformSearchProvider, type PlatformSearchRegion,
} from "../src/platform-search.js";

const providers = ["51job", "boss", "liepin", "linkedin"] as const;
const input = (provider: PlatformSearchProvider, keyword = "C#", regionId = "cn-shanghai"): PlatformSearchInput => ({ provider, keyword, regionId });
const hasCode = (code: string) => (error: unknown) => error instanceof PlatformSearchError && error.code === code;

test("four platform searches use fixed official endpoints and platform-specific Shanghai mapping", () => {
  const expected = {
    "51job": { origin: "https://we.51job.com", path: "/pc/search", params: { keyword: "C#", searchType: "2", jobArea: "020000" } },
    boss: { origin: "https://www.zhipin.com", path: "/web/geek/job", params: { query: "C#", city: "101020100" } },
    liepin: { origin: "https://www.liepin.com", path: "/zhaopin/", params: { key: "C#", city: "020", dq: "020" } },
    linkedin: { origin: "https://www.linkedin.com", path: "/jobs/search", params: { keywords: "C#", location: "Shanghai, China" } },
  };
  for (const provider of providers) {
    const request = buildPlatformSearchRequest(input(provider));
    const url = new URL(request.url);
    assert.equal(url.origin, expected[provider].origin);
    assert.equal(url.pathname, expected[provider].path);
    assert.deepEqual(Object.fromEntries(url.searchParams), expected[provider].params);
    assert.equal(url.hash, "");
    assert.equal(request.regionMode, "explicit");
    assert.equal(request.region?.id, "cn-shanghai");
  }
});

test("literal technical keywords and Unicode survive query encoding without becoming query parameters", () => {
  for (const keyword of ["C#", "C++", ".NET", "前端/全栈 🧭", "C# & city=010&redirect=https://example.test/#detail", "100% remote + hybrid", "a=b?c#d"]) {
    for (const provider of providers) {
      const request = buildPlatformSearchRequest(input(provider, keyword));
      const url = new URL(request.url);
      const keywordParam = { "51job": "keyword", boss: "query", liepin: "key", linkedin: "keywords" }[provider];
      assert.equal(url.searchParams.get(keywordParam), keyword);
      assert.equal(request.keyword, keyword);
      assert.equal(url.searchParams.has("redirect"), false);
      assert.equal(url.hash, "");
      assert.equal(url.username, "");
    }
  }
});

test("nationwide uses each platform's distinct value, including current Liepin 410", () => {
  const values = { "51job": "000000", boss: "100010000", liepin: "410", linkedin: "China" };
  for (const provider of providers) {
    const request = buildPlatformSearchRequest(input(provider, "工程师", "cn"));
    assert.equal(request.region?.providerValue, values[provider]);
  }
});

test("native domestic platform search does not silently drop a foreign region", () => {
  for (const provider of ["51job", "boss", "liepin"] as const) {
    assert.throws(() => buildPlatformSearchRequest(input(provider, "engineer", "us")), hasCode("unsupported-region"));
    assert.equal(listPlatformSearchRegions(provider).some((region) => region.id === "us"), false);
  }
  const request = buildPlatformSearchRequest(input("linkedin", "engineer", "us"));
  assert.equal(new URL(request.url).searchParams.get("location"), "United States");
  assert.equal(request.region?.countryCode, "US");
});

test("unmapped region, raw platform code and ambiguous partial place text never become implicit all-regions", () => {
  for (const regionId of ["cn-unknown", "cn-wuxi"]) {
    assert.throws(() => buildPlatformSearchRequest(input("boss", "C#", regionId)), hasCode("unknown-region"));
  }
  assert.throws(() => buildPlatformSearchRequest(input("51job", "C#", "020000")), hasCode("invalid-input"));
  assert.throws(() => buildPlatformSearchRequest(input("liepin", "C#", "上海")), hasCode("invalid-input"));
  assert.equal(resolvePlatformSearchRegion("Shang"), undefined);
  assert.equal(resolvePlatformSearchRegion("上海附近"), undefined);
  assert.equal(resolvePlatformSearchRegion("020000"), undefined);
});

test("explicit aliases normalize width, whitespace and case while keeping Hong Kong separate", () => {
  assert.equal(resolvePlatformSearchRegion(" 上海市 ")?.id, "cn-shanghai");
  assert.equal(resolvePlatformSearchRegion(" ＳＨＡＮＧＨＡＩ ")?.id, "cn-shanghai");
  assert.equal(resolvePlatformSearchRegion("united   states")?.id, "us");
  assert.equal(resolvePlatformSearchRegion("CN")?.countryCode, "CN");
  assert.equal(resolvePlatformSearchRegion("HK")?.countryCode, "HK");
  assert.equal(resolvePlatformSearchRegion("Xi’an")?.id, "cn-xian");
  assert.equal(resolvePlatformSearchRegion(""), undefined);
  assert.equal(resolvePlatformSearchRegion("北京\n上海"), undefined);
});

test("no explicit region is honestly described as platform default rather than worldwide", () => {
  const request = buildPlatformSearchRequest({ provider: "linkedin", keyword: "C#" });
  assert.equal(request.region, undefined);
  assert.equal(request.regionMode, "platform-default");
  assert.equal(new URL(request.url).searchParams.has("location"), false);
  assert.ok(request.warnings.some((warning) => warning.includes("上次选择") && warning.includes("不代表全球")));
});

test("search planning keeps follow-up single-detail reads separate from collection and availability", () => {
  for (const provider of providers) {
    const request = buildPlatformSearchRequest(input(provider));
    assert.equal(request.kind, "external-platform-search");
    assert.equal(request.dataStatus, "not-collected");
    assert.deepEqual(request.nextAction, { kind: "select-single-job-detail", platform: request.platform });
    assert.equal("jobs" in request, false);
    assert.equal("availability" in request, false);
    assert.ok(request.warnings.some((warning) => warning.includes("尚未采集") && warning.includes("人工验证")));
  }
});

test("catalogue evidence and limitations do not turn parameter construction into verified search results", () => {
  assert.equal(PlatformSearchCatalogSchema.safeParse(BUILTIN_PLATFORM_SEARCH_CATALOG).success, true);
  assert.equal(buildPlatformSearchRequest(input("51job")).region?.basis, "official-city-catalog");
  assert.equal(buildPlatformSearchRequest(input("liepin")).region?.basis, "official-response-title");
  assert.equal(buildPlatformSearchRequest(input("boss")).region?.basis, "parameter-only");
  assert.ok(buildPlatformSearchRequest(input("boss")).warnings.some((warning) => warning.includes("尚需") && warning.includes("地区代码")));
  assert.equal(buildPlatformSearchRequest(input("linkedin")).region?.basis, "official-form");
  assert.ok(buildPlatformSearchRequest(input("linkedin")).warnings.some((warning) => warning.includes("地区文本")));
});

test("custom region mapping is schema checked and remains explicitly unverified", () => {
  const regions: PlatformSearchRegion[] = [{
    id: "us-synthetic-city", name: "Synthetic City", countryCode: "US", aliases: ["Synthetic"],
    platforms: { linkedin: "Synthetic City, United States" },
  }];
  const before = structuredClone(regions);
  const request = buildPlatformSearchRequest(input("linkedin", "C++", regions[0]!.id), regions);
  assert.equal(new URL(request.url).searchParams.get("location"), "Synthetic City, United States");
  assert.equal(request.region?.basis, "configured-unverified");
  assert.ok(request.warnings.some((warning) => warning.includes("仅校验了格式")));
  assert.deepEqual(regions, before);
  assert.equal(resolvePlatformSearchRegion("Synthetic", regions)?.id, regions[0]!.id);
  assert.throws(() => buildPlatformSearchRequest(input("51job", "C++", regions[0]!.id), regions), hasCode("unsupported-region"));
});

test("cross-platform or malformed region codes are rejected, not copied into another platform", () => {
  const region = resolvePlatformSearchRegion("上海")!;
  for (const platforms of [
    { "51job": "101020100" }, { boss: "020000" }, { liepin: "101020100" },
    { boss: "101020100&query=evil" }, { "51job": "020000/" }, { liepin: "https://example.test" },
    { unknown: "020000" }, { boss: 101020100 }, {},
  ]) {
    const regions = [{ ...region, platforms }] as PlatformSearchRegion[];
    assert.equal(PlatformSearchRegionsSchema.safeParse(regions).success, false);
    assert.throws(() => buildPlatformSearchRequest(input("boss"), regions), hasCode("invalid-regions"));
  }
});

test("configured valid-looking code is not presented as an officially verified binding", () => {
  const region = resolvePlatformSearchRegion("上海")!;
  region.platforms["51job"] = "990099";
  const request = buildPlatformSearchRequest(input("51job"), [region]);
  assert.equal(request.region?.basis, "configured-unverified");
  assert.ok(request.warnings.some((warning) => warning.includes("自定义映射")));
});

test("configuration rejects conflicting aliases, IDs, duplicate native codes and false domestic country binding", () => {
  const shanghai = resolvePlatformSearchRegion("上海")!;
  const beijing = resolvePlatformSearchRegion("北京")!;
  const conflicts = [
    [shanghai, { ...beijing, aliases: [...beijing.aliases, " ＳＨＡＮＧＨＡＩ "] }],
    [shanghai, structuredClone(shanghai)],
    [shanghai, { ...beijing, platforms: { "51job": "020000" } }],
    [{ ...shanghai, countryCode: "US" }],
    [{ ...shanghai, url: "https://example.test" }],
  ];
  for (const regions of conflicts) assert.equal(PlatformSearchRegionsSchema.safeParse(regions).success, false);
});

test("caller cannot supply an arbitrary endpoint, URL, host, port, extra query params or unknown provider", () => {
  for (const extra of [
    { url: "https://example.test" }, { endpoint: "http://127.0.0.1:5178" },
    { host: "example.test" }, { port: 8080 }, { params: { city: "101010100" } },
    { provider: "https://example.test" }, { provider: "BOSS直聘" },
  ]) {
    assert.throws(() => buildPlatformSearchRequest({ ...input("boss"), ...extra } as PlatformSearchInput), hasCode("invalid-input"));
  }
  // Even URL-like keyword text is inert text under a fixed platform origin.
  const url = new URL(buildPlatformSearchRequest(input("boss", "https://example.test/?city=101010100#x")).url);
  assert.equal(url.origin, "https://www.zhipin.com");
  assert.equal(url.searchParams.get("city"), "101020100");
});

test("blank keywords browse a region while overlong, control and invalid Unicode inputs fail", () => {
  for (const keyword of ["", "   "]) {
    const request = buildPlatformSearchRequest(input("boss", keyword));
    assert.equal(request.keyword, "");
    assert.equal(new URL(request.url).searchParams.get("query"), "");
  }
  for (const keyword of ["x".repeat(301), "C#\u0000", "C#\u007f", "C#\ud800", "two\nlines"]) {
    assert.throws(() => buildPlatformSearchRequest(input("boss", keyword)), hasCode("invalid-input"));
  }
  assert.equal(buildPlatformSearchRequest(input("boss", "  C#  ")).keyword, "C#");
  assert.throws(() => buildPlatformSearchRequest({ ...input("boss"), regionId: "" }), hasCode("invalid-input"));
  const bossWithDistrict = buildPlatformSearchRequest({ provider: "boss", keyword: "c#", regionId: "cn-shanghai", districtCode: "310115" });
  assert.equal(new URL(bossWithDistrict.url).searchParams.get("multiBusinessDistrict"), "310115");
  assert.equal(new URL(bossWithDistrict.url).searchParams.get("city"), "101020100");
});

test("catalogue and request values cannot be changed through public helpers or returned references", () => {
  const regions = listPlatformSearchRegions("51job");
  regions[0]!.platforms["51job"] = "999999";
  regions[0]!.aliases.push("mutated-alias");
  assert.equal(resolvePlatformSearchRegion("mutated-alias"), undefined);
  assert.equal(resolvePlatformSearchRegion("cn")?.platforms["51job"], "000000");
  assert.ok(Object.isFrozen(BUILTIN_PLATFORM_SEARCH_REGIONS));
  assert.ok(Object.isFrozen(BUILTIN_PLATFORM_SEARCH_REGIONS[0]!.platforms));
  const request = buildPlatformSearchRequest(input("boss"));
  assert.ok(Object.isFrozen(request));
  assert.ok(Object.isFrozen(request.region));
  assert.ok(Object.isFrozen(request.warnings));
  assert.equal(PLATFORM_SEARCH_PROVIDERS.find((provider) => provider.id === "linkedin")?.regionFilter, "location-text");
});
