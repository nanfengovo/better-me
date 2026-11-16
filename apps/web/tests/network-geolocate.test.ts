import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import type os from "node:os";
import test from "node:test";
import {
  detectHostNetworkLocation,
  isDisallowedPublicIpv4,
  parseBilibiliIpGeo,
  parseIpinfoGeo,
  selectPhysicalIpv4Addresses,
} from "../server/network-geolocate";
import { createNetworkMiddleware, type NetworkRuntime } from "../server/network-proxy";
import {
  formatChineseStreetLabel,
  parseNominatimReverseResult,
  parseNominatimSearchResults,
  parsePhotonReverseResult,
  parsePhotonSearchResults,
  reverseGeocodeStreet,
  searchStreetLocations,
} from "../server/street-geocoder";
import {
  clearNearbyCompaniesCache,
  deriveEmployerSearchLabels,
  discoverNearbyCompanies,
  parseNearbyCompaniesFromNominatim,
} from "../server/nearby-companies";
import {
  fetchRawOsmElementsAndRoads,
  parseDuckDuckGoStreetResults,
} from "../server/nearby-web-discovery";

function v4(address: string, internal = false): os.NetworkInterfaceInfo {
  return {
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:11:22:33:44:55",
    internal,
    cidr: `${address}/24`,
  };
}

function v6(address: string, internal = false): os.NetworkInterfaceInfo {
  return {
    address,
    netmask: "ffff:ffff:ffff:ffff::",
    family: "IPv6",
    mac: "00:11:22:33:44:55",
    scopeid: 0,
    internal,
    cidr: `${address}/64`,
  };
}

test("selectPhysicalIpv4Addresses excludes TUN/virtual/link-local interfaces and prioritizes en*/default NIC", () => {
  const addresses = selectPhysicalIpv4Addresses(
    {
      lo0: [v4("127.0.0.1", true), v6("::1", true)],
      utun4: [v4("198.18.0.1", false)],
      utun5: [v4("10.8.0.2", false)],
      bridge0: [v4("169.254.12.34", false)],
      awdl0: [v6("fe80::1", false)],
      docker0: [v4("172.17.0.1", false)],
      eth1: [v4("10.20.30.40", false)],
      en0: [v6("fe80::2", false), v4("192.168.0.176", false)],
      en2: [v4("169.254.88.99", false), v4("192.168.1.50", false)],
    },
    "en2",
  );

  assert.deepEqual(addresses, ["192.168.1.50", "192.168.0.176", "10.20.30.40"]);
});

test("isDisallowedPublicIpv4 blocks Clash Fake-IP (198.18/15), RFC1918, loopback, and link-local addresses", () => {
  assert.equal(isDisallowedPublicIpv4("198.18.0.1"), true);
  assert.equal(isDisallowedPublicIpv4("198.19.42.100"), true);
  assert.equal(isDisallowedPublicIpv4("127.0.0.1"), true);
  assert.equal(isDisallowedPublicIpv4("10.0.0.8"), true);
  assert.equal(isDisallowedPublicIpv4("172.16.5.4"), true);
  assert.equal(isDisallowedPublicIpv4("192.168.0.176"), true);
  assert.equal(isDisallowedPublicIpv4("169.254.1.2"), true);
  assert.equal(isDisallowedPublicIpv4("100.64.0.1"), true);
  assert.equal(isDisallowedPublicIpv4("not-an-ip"), true);

  assert.equal(isDisallowedPublicIpv4("39.144.46.112"), false);
  assert.equal(isDisallowedPublicIpv4("223.5.5.5"), false);
  assert.equal(isDisallowedPublicIpv4("119.29.29.29"), false);
});

test("provider parsers accept valid city geolocation payloads and reject invalid or zero coordinates", () => {
  const bili = parseBilibiliIpGeo({
    code: 0,
    data: {
      addr: "39.144.46.112",
      country: "中国",
      province: "上海",
      city: "上海",
      latitude: "31.224349",
      longitude: "121.476753",
    },
  });
  assert.deepEqual(bili, {
    provider: "bilibili-ip",
    longitude: 121.476753,
    latitude: 31.224349,
    accuracyMeters: 5000,
    cityLabel: "上海",
    countryCode: "CN",
  });

  const ipinfo = parseIpinfoGeo({
    ip: "39.144.46.112",
    city: "Shanghai",
    region: "Shanghai",
    country: "CN",
    loc: "31.2222,121.4581",
  });
  assert.deepEqual(ipinfo, {
    provider: "ipinfo",
    longitude: 121.4581,
    latitude: 31.2222,
    accuracyMeters: 5000,
    cityLabel: "Shanghai",
    countryCode: "CN",
  });

  assert.equal(parseBilibiliIpGeo({ code: -1, data: { longitude: "121.4", latitude: "31.2" } }), null);
  assert.equal(parseBilibiliIpGeo({ code: 0, data: { longitude: "0", latitude: "0" } }), null);
  assert.equal(parseBilibiliIpGeo({ code: 0, data: { longitude: "210", latitude: "31.2" } }), null);
  assert.equal(parseIpinfoGeo({ loc: "0,0", city: "Null" }), null);
  assert.equal(parseIpinfoGeo({ loc: "invalid" }), null);
});

test("detectHostNetworkLocation binds to physical NIC, falls back across providers, and refuses unbound TUN spoof when physical NIC fails", async () => {
  const seenCalls: Array<{ url: string; localAddress?: string }> = [];
  const interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
    utun4: [v4("198.18.0.1")],
    en0: [v4("192.168.0.176")],
  };

  const success = await detectHostNetworkLocation({
    interfaces,
    now: () => 1763218000000,
    fetchJson: async (url, opts) => {
      seenCalls.push({ url, localAddress: opts.localAddress });
      if (url.includes("bilibili.com")) {
        throw new Error("primary offline");
      }
      return {
        city: "Shanghai",
        region: "Shanghai",
        country: "CN",
        loc: "31.2222,121.4581",
      };
    },
  });

  assert.deepEqual(success, {
    ok: true,
    source: "ip",
    provider: "ipinfo",
    longitude: 121.4581,
    latitude: 31.2222,
    accuracyMeters: 5000,
    cityLabel: "Shanghai",
    countryCode: "CN",
    timestamp: 1763218000000,
  });
  assert.equal(seenCalls.length, 2);
  assert.equal(seenCalls[0].localAddress, "192.168.0.176");
  assert.equal(seenCalls[1].localAddress, "192.168.0.176");

  const failureCalls: Array<string | undefined> = [];
  const failure = await detectHostNetworkLocation({
    interfaces,
    fetchJson: async (_url, opts) => {
      failureCalls.push(opts.localAddress);
      throw new Error("network down");
    },
  });
  assert.equal(failure.ok, false);
  assert.deepEqual(failureCalls, ["192.168.0.176", "192.168.0.176"]);
});

function requestJson(
  urlString: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: unknown }> {
  const url = new URL(urlString);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("createNetworkMiddleware serves GET /api/network/geolocate only to trusted loopback requests", async () => {
  const stubRuntime = {} as NetworkRuntime;
  const seenAuthorize: Array<boolean | undefined> = [];
  let nextResult: Awaited<ReturnType<typeof detectHostNetworkLocation>> = {
    ok: true,
    source: "ip",
    provider: "bilibili-ip",
    longitude: 121.476753,
    latitude: 31.224349,
    accuracyMeters: 5000,
    cityLabel: "上海",
    countryCode: "CN",
    timestamp: 1763218000000,
  };
  const middleware = createNetworkMiddleware(stubRuntime, {
    geolocate: async (opts) => {
      seenAuthorize.push(opts?.allowPrompt);
      return nextResult;
    },
    reverseGeocode: async (longitude, latitude) => ({
      cityLabel: "上海市 · 黄浦区",
      streetLabel: `黄浦区 · 延安东路 (${longitude.toFixed(2)},${latitude.toFixed(2)})`,
    }),
    searchLocations: async (query, cityHint) => [
      {
        id: "hit-1",
        label: `${cityHint ?? "上海"} · ${query}`,
        streetLabel: `静安区 · ${query}`,
        cityLabel: cityHint ?? "上海市",
        longitude: 121.454,
        latitude: 31.229,
      },
    ],
  });

  const server = createServer((req, res) => {
    void middleware(req, res, () => {
      res.statusCode = 404;
      res.end("not found");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const okRes = await requestJson(`${baseUrl}/api/network/geolocate?authorize=1`, {
      headers: { Origin: baseUrl },
    });
    assert.equal(okRes.status, 200);
    assert.deepEqual(okRes.body, nextResult);
    assert.deepEqual(seenAuthorize, [true]);

    const revOk = await requestJson(`${baseUrl}/api/network/reverse-geocode?lon=121.48&lat=31.23`, {
      headers: { Origin: baseUrl },
    });
    assert.equal(revOk.status, 200);
    assert.deepEqual(revOk.body, {
      ok: true,
      cityLabel: "上海市 · 黄浦区",
      streetLabel: "黄浦区 · 延安东路 (121.48,31.23)",
    });

    const revBad = await requestJson(`${baseUrl}/api/network/reverse-geocode?lon=999&lat=31.23`, {
      headers: { Origin: baseUrl },
    });
    assert.equal(revBad.status, 400);

    const searchOk = await requestJson(
      `${baseUrl}/api/network/search-location?q=${encodeURIComponent("南京西路")}&city=${encodeURIComponent("上海")}`,
      { headers: { Origin: baseUrl } },
    );
    assert.equal(searchOk.status, 200);
    assert.deepEqual(searchOk.body, {
      ok: true,
      candidates: [
        {
          id: "hit-1",
          label: "上海 · 南京西路",
          streetLabel: "静安区 · 南京西路",
          cityLabel: "上海",
          longitude: 121.454,
          latitude: 31.229,
        },
      ],
    });

    const searchEmpty = await requestJson(`${baseUrl}/api/network/search-location?q=%20%20`, {
      headers: { Origin: baseUrl },
    });
    assert.equal(searchEmpty.status, 400);

    const searchCrossOrigin = await requestJson(`${baseUrl}/api/network/search-location?q=test`, {
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(searchCrossOrigin.status, 403);

    nextResult = { ok: false, error: "当前本机直连网络无法获取城市级位置" };
    const failRes = await requestJson(`${baseUrl}/api/network/geolocate`, {
      headers: { Origin: baseUrl },
    });
    assert.equal(failRes.status, 503);
    assert.deepEqual(failRes.body, nextResult);

    const postRes = await requestJson(`${baseUrl}/api/network/geolocate`, {
      method: "POST",
      headers: { Origin: baseUrl, "Content-Type": "application/json" },
    });
    assert.equal(postRes.status, 405);

    const postRev = await requestJson(`${baseUrl}/api/network/reverse-geocode?lon=121.4&lat=31.2`, {
      method: "POST",
      headers: { Origin: baseUrl, "Content-Type": "application/json" },
    });
    assert.equal(postRev.status, 405);

    const crossOriginRes = await requestJson(`${baseUrl}/api/network/geolocate`, {
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(crossOriginRes.status, 403);

    const crossSiteRes = await requestJson(`${baseUrl}/api/network/geolocate`, {
      headers: { "Sec-Fetch-Site": "cross-site" },
    });
    assert.equal(crossSiteRes.status, 403);

    const evilHostRes = await requestJson(`${baseUrl}/api/network/geolocate`, {
      headers: { Host: "evil.example" },
    });
    assert.equal(evilHostRes.status, 403);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("detectHostNetworkLocation prefers macOS CoreLocation street fix and keeps IP fallback free of fabricated street labels", async () => {
  let ipFetchCalled = false;
  const macosFix = await detectHostNetworkLocation({
    interfaces: { en0: [v4("192.168.0.176")] },
    now: () => 1763218000123,
    macosLocate: async ({ allowPrompt }) => {
      assert.equal(allowPrompt, true);
      return {
        ok: true,
        status: "authorized",
        longitude: 121.4567,
        latitude: 31.2289,
        accuracyMeters: 28,
      };
    },
    reverseGeocode: async () => ({
      cityLabel: "上海市 · 静安区",
      streetLabel: "静安区 · 南京西路街道 · 南京西路 1266号",
    }),
    fetchJson: async () => {
      ipFetchCalled = true;
      return null;
    },
    allowPrompt: true,
  });

  assert.equal(ipFetchCalled, false);
  assert.deepEqual(macosFix, {
    ok: true,
    source: "macos",
    provider: "corelocation",
    longitude: 121.4567,
    latitude: 31.2289,
    accuracyMeters: 28,
    cityLabel: "上海市 · 静安区",
    streetLabel: "静安区 · 南京西路街道 · 南京西路 1266号",
    countryCode: "CN",
    coreLocationStatus: "authorized",
    timestamp: 1763218000123,
  });

  const deniedFallback = await detectHostNetworkLocation({
    interfaces: { en0: [v4("192.168.0.176")] },
    now: () => 1763218000456,
    macosLocate: async () => ({ ok: false, status: "denied" }),
    fetchJson: async (url) => {
      if (url.includes("bilibili")) {
        return {
          code: 0,
          data: { city: "上海", province: "上海", country: "中国", longitude: "121.47", latitude: "31.22" },
        };
      }
      return null;
    },
  });

  assert.deepEqual(deniedFallback, {
    ok: true,
    source: "ip",
    provider: "bilibili-ip",
    longitude: 121.47,
    latitude: 31.22,
    accuracyMeters: 5000,
    cityLabel: "上海",
    countryCode: "CN",
    coreLocationStatus: "denied",
    timestamp: 1763218000456,
  });
  assert.equal("streetLabel" in deniedFallback, false);
});

test("street-geocoder formats Chinese municipality streets cleanly and falls back between Nominatim and Photon", async () => {
  assert.deepEqual(
    formatChineseStreetLabel({
      state: "上海市",
      city: "黄浦区",
      subdistrict: "南京东路街道",
      road: "延安东路",
      houseNumber: "100号",
    }),
    {
      cityLabel: "上海市 · 黄浦区",
      streetLabel: "黄浦区 · 南京东路街道 · 延安东路 100号",
      district: "黄浦区",
    },
  );

  const nomRev = parseNominatimReverseResult({
    name: "恒隆广场",
    address: {
      state: "上海市",
      city: "静安区",
      suburb: "南京西路街道",
      road: "南京西路",
      house_number: "1266号",
    },
  });
  assert.deepEqual(nomRev, {
    cityLabel: "上海市 · 静安区",
    streetLabel: "静安区 · 南京西路街道 · 南京西路 1266号 · 恒隆广场",
    district: "静安区",
    subdistrict: "南京西路街道",
    road: "南京西路",
  });

  const photonRev = parsePhotonReverseResult({
    features: [
      {
        properties: {
          state: "上海市",
          district: "徐汇区",
          locality: "徐家汇街道",
          street: "漕溪北路",
          housenumber: "88号",
        },
      },
    ],
  });
  assert.deepEqual(photonRev, {
    cityLabel: "上海市 · 徐汇区",
    streetLabel: "徐汇区 · 徐家汇街道 · 漕溪北路 88号",
  });

  const nomSearch = parseNominatimSearchResults([
    {
      place_id: 42,
      lon: "121.454",
      lat: "31.229",
      display_name: "南京西路, 南京西路街道, 静安区, 上海市, 中国",
      address: { state: "上海市", city: "静安区", suburb: "南京西路街道", road: "南京西路" },
    },
  ]);
  assert.equal(nomSearch.length, 1);
  assert.equal(nomSearch[0]?.streetLabel, "静安区 · 南京西路街道 · 南京西路");

  const phoSearch = parsePhotonSearchResults({
    features: [
      {
        geometry: { coordinates: [121.48, 31.23] },
        properties: { osm_id: 9, state: "上海市", district: "黄浦区", name: "人民广场" },
      },
    ],
  });
  assert.equal(phoSearch.length, 1);
  assert.equal(phoSearch[0]?.streetLabel, "黄浦区 · 人民广场");

  // Nominatim empty/error falls back to Photon for reverse & search.
  const revFallback = await reverseGeocodeStreet(121.44, 31.19, {
    fetchImpl: async (url) => {
      if (url.includes("nominatim")) {
        return new Response("down", { status: 502 });
      }
      return new Response(
        JSON.stringify({
          features: [{ properties: { state: "上海市", district: "徐汇区", street: "漕溪北路" } }],
        }),
        { status: 200 },
      );
    },
  });
  assert.equal(revFallback?.streetLabel, "徐汇区 · 漕溪北路");

  const seenSearchUrls: string[] = [];
  const searchFallback = await searchStreetLocations("人民广场", {
    cityHint: "上海",
    fetchImpl: async (url) => {
      seenSearchUrls.push(url);
      if (url.includes("nominatim")) {
        return new Response("[]", { status: 200 });
      }
      return new Response(
        JSON.stringify({
          features: [
            {
              geometry: { coordinates: [121.4737, 31.2304] },
              properties: { osm_id: 7, state: "上海市", district: "黄浦区", name: "人民广场" },
            },
          ],
        }),
        { status: 200 },
      );
    },
  });
  assert.equal(seenSearchUrls.length, 3);
  assert.equal(searchFallback[0]?.streetLabel, "黄浦区 · 人民广场");
});

test("nearby-companies parses real employers, excludes residential/noise, avoids false private labels, and serves /api/network/nearby-companies", async () => {
  assert.deepEqual(deriveEmployerSearchLabels("英特尔亚太研发有限公司"), {
    shortName: "英特尔亚太研发",
    searchKeyword: "英特尔",
  });
  assert.deepEqual(deriveEmployerSearchLabels("东软集团（上海）有限公司"), {
    shortName: "东软集团",
    searchKeyword: "东软集团",
  });

  const parsed = parseNearbyCompaniesFromNominatim(
    [
      {
        osm_type: "way",
        osm_id: 1,
        lon: "121.4506",
        lat: "31.0238",
        category: "landuse",
        type: "commercial",
        name: "英特尔亚太研发有限公司",
        display_name: "英特尔亚太研发有限公司, 紫星路, 紫竹科学园区, 闵行区, 上海市",
        address: { city_district: "闵行区", road: "紫星路" },
      },
      {
        osm_type: "way",
        osm_id: 2,
        lon: "121.4463",
        lat: "31.0209",
        category: "landuse",
        type: "commercial",
        name: "微软",
        display_name: "微软, 紫竹科学园区, 闵行区, 上海市",
      },
      {
        osm_type: "way",
        osm_id: 3,
        lon: "121.4372",
        lat: "31.0385",
        category: "office",
        type: "company",
        name: "中国航发商用航空发动机有限责任公司",
        address: { district: "闵行区", road: "张家里路" },
      },
      {
        osm_type: "way",
        osm_id: 4,
        lon: "121.4430",
        lat: "31.0320",
        category: "landuse",
        type: "residential",
        name: "交大博士生公寓",
      },
      {
        osm_type: "node",
        osm_id: 5,
        lon: "121.4490",
        lat: "31.0240",
        category: "shop",
        type: "convenience",
        name: "全家便利店有限公司",
      },
      {
        osm_type: "way",
        osm_id: 6,
        lon: "121.4327",
        lat: "31.0348",
        category: "building",
        type: "commercial",
        name: "创想600上海交通大学国家大学科技园",
        address: { district: "闵行区", road: "剑川路" },
      },
    ],
    121.454,
    31.028,
    2500,
  );

  assert.equal(parsed.some((c) => c.name.includes("公寓")), false);
  assert.equal(parsed.some((c) => c.name.includes("便利店")), false);
  assert.equal(parsed[0]?.name, "英特尔亚太研发有限公司");
  assert.match(parsed[0]?.ownershipLabel ?? "", /外资|跨国/);
  const microsoft = parsed.find((c) => c.name === "微软");
  assert.ok(microsoft);
  assert.doesNotMatch(microsoft.ownershipLabel, /民营/);
  const aecc = parsed.find((c) => c.name.includes("中国航发"));
  assert.ok(aecc);
  assert.match(aecc.ownershipLabel, /央企/);
  assert.equal(parsed.at(-1)?.kind, "park");

  clearNearbyCompaniesCache();
  let fetchCount = 0;
  const first = await discoverNearbyCompanies(121.454, 31.028, {
    radiusMeters: 2500,
    fetchImpl: async (url) => {
      fetchCount += 1;
      if (url.includes("%E6%9C%89%E9%99%90%E5%85%AC%E5%8F%B8")) {
        return new Response(
          JSON.stringify([
            {
              osm_type: "way",
              osm_id: 1,
              lon: "121.4506",
              lat: "31.0238",
              category: "office",
              type: "company",
              name: "英特尔亚太研发有限公司",
            },
          ]),
          { status: 200 },
        );
      }
      return new Response("[]", { status: 200 });
    },
  });
  assert.equal(first.cached, false);
  assert.equal(first.companies.length, 1);
  const callsAfterFirst = fetchCount;
  const second = await discoverNearbyCompanies(121.454, 31.028, {
    radiusMeters: 2500,
    fetchImpl: async () => {
      fetchCount += 1;
      return new Response("[]", { status: 200 });
    },
  });
  assert.equal(second.cached, true);
  assert.equal(fetchCount, callsAfterFirst);

  // Empty responses (e.g. during transient upstream timeouts) must never poison the cache
  clearNearbyCompaniesCache();
  let emptyRetries = 0;
  const emptyFirst = await discoverNearbyCompanies(121.5, 31.2, {
    radiusMeters: 2500,
    fetchImpl: async () => {
      emptyRetries += 1;
      return new Response("[]", { status: 200 });
    },
  });
  assert.equal(emptyFirst.companies.length, 0);
  const callsDuringFirst = emptyRetries;
  const emptySecond = await discoverNearbyCompanies(121.5, 31.2, {
    radiusMeters: 2500,
    fetchImpl: async () => {
      emptyRetries += 1;
      return new Response("[]", { status: 200 });
    },
  });
  assert.equal(emptySecond.cached, false);
  assert.ok(emptyRetries > callsDuringFirst);

  const middleware = createNetworkMiddleware({} as NetworkRuntime, {
    nearbyCompanies: async (longitude, latitude, opts) => ({
      ok: true,
      center: { longitude, latitude, radiusMeters: opts?.radiusMeters ?? 2500 },
      companies: first.companies,
      cached: false,
      source: "osm-nominatim",
    }),
  });
  const server = createServer((req, res) => {
    void middleware(req, res, () => {
      res.statusCode = 404;
      res.end("not found");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  assert(addr && typeof addr !== "string");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    const badRes = await requestJson(`${baseUrl}/api/network/nearby-companies?lon=0&lat=0`, {
      headers: { Origin: baseUrl },
    });
    assert.equal(badRes.status, 400);

    const okRes = await requestJson(`${baseUrl}/api/network/nearby-companies?lon=121.454&lat=31.028&radius=1500`, {
      headers: { Origin: baseUrl },
    });
    assert.equal(okRes.status, 200);
    assert.equal((okRes.body as { ok: boolean }).ok, true);
    assert.equal((okRes.body as { center: { radiusMeters: number } }).center.radiusMeters, 1500);

    const postRes = await requestJson(`${baseUrl}/api/network/nearby-companies?lon=121.454&lat=31.028`, {
      method: "POST",
      headers: { Origin: baseUrl, "Content-Type": "application/json" },
    });
    assert.equal(postRes.status, 405);

    const evilRes = await requestJson(`${baseUrl}/api/network/nearby-companies?lon=121.454&lat=31.028`, {
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(evilRes.status, 403);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("nearby company discovery covers non-software industrial plants, raw OSM elements, street web employers, and road query params", async () => {
  const mixedIndustry = parseNearbyCompaniesFromNominatim(
    [
      {
        osm_type: "way",
        osm_id: 201,
        lon: "121.4562",
        lat: "31.0209",
        category: "landuse",
        type: "industrial",
        name: "东丽纤维",
        address: { city_district: "闵行区", road: "紫日路" },
      },
      {
        osm_type: "node",
        osm_id: 202,
        lon: "121.4570",
        lat: "31.0211",
        category: "man_made",
        type: "works",
        name: "精密化工制造厂",
        address: { city_district: "闵行区", road: "江川东路" },
      },
      {
        osm_type: "way",
        osm_id: 203,
        lon: "121.4572",
        lat: "31.0212",
        category: "building",
        type: "industrial",
        name: "园区1号楼",
      },
      {
        osm_type: "way",
        osm_id: 204,
        lon: "121.4574",
        lat: "31.0214",
        category: "landuse",
        type: "industrial",
        name: "闵吴垃圾码头",
      },
      {
        osm_type: "node",
        osm_id: 205,
        lon: "121.4575",
        lat: "31.0215",
        category: "amenity",
        type: "company",
        name: "龙域北街10号院",
      },
      {
        osm_type: "node",
        osm_id: 206,
        lon: "121.4576",
        lat: "31.0216",
        category: "office",
        type: "company",
        name: "西二旗消防中队",
      },
      {
        osm_type: "way",
        osm_id: 207,
        lon: "121.4577",
        lat: "31.0217",
        category: "building",
        type: "office",
        name: "建筑学院教学楼C02",
      },
      {
        osm_type: "way",
        osm_id: 208,
        lon: "121.4578",
        lat: "31.0218",
        category: "building",
        type: "office",
        name: "5座",
      },
    ],
    121.456,
    31.021,
    2500,
  );

  assert.equal(mixedIndustry.some((c) => c.name === "东丽纤维" && c.kind === "company"), true);
  assert.equal(mixedIndustry.some((c) => c.name === "精密化工制造厂" && c.kind === "company"), true);
  assert.equal(mixedIndustry.find((c) => c.name === "园区1号楼")?.kind, "park");
  assert.equal(mixedIndustry.some((c) => c.name.includes("垃圾码头")), false);
  assert.equal(mixedIndustry.some((c) => c.name.includes("10号院")), false);
  assert.equal(mixedIndustry.some((c) => c.name.includes("消防中队")), false);
  assert.equal(mixedIndustry.some((c) => c.name.includes("教学楼")), false);
  assert.equal(mixedIndustry.some((c) => c.name === "5座"), false);

  const rawOsm = await fetchRawOsmElementsAndRoads(
    121.4585,
    31.0205,
    900,
    async () =>
      new Response(
        JSON.stringify({
          elements: [
            { type: "node", id: 1, lon: 121.456, lat: 31.0205 },
            { type: "node", id: 2, lon: 121.461, lat: 31.0206 },
            { type: "way", id: 10, nodes: [1, 2], tags: { highway: "secondary", name: "江川东路" } },
            { type: "way", id: 11, nodes: [1, 2], tags: { building: "industrial", name: "ST Electronics" } },
          ],
        }),
        { status: 200 },
      ),
    3000,
    "江川东路",
  );
  assert.equal(rawOsm.roadPoints.length, 2);
  assert.equal(rawOsm.osmItems.some((item) => item.name === "ST Electronics"), true);

  const fakeDdgHtml = `
    <div class="result results_links results_links_deep web-result">
      <a class="result__a" href="#">示例半导体制造（上海）有限公司 - 工商信息</a>
      <a class="result__snippet" href="#">示例半导体制造（上海）有限公司，于2010年成立，位于上海市闵行区江川东路388号，一般项目：集成电路制造、封装测试。</a>
    </div>
    <div class="result results_links results_links_deep web-result">
      <a class="result__a" href="#">江川东路都有哪些公司 - 问答</a>
      <a class="result__snippet" href="#">位于江川东路100号的问答页面。</a>
    </div>
    <div class="result results_links results_links_deep web-result">
      <a class="result__a" href="#">另一条路商业公司 - 爱企查</a>
      <a class="result__snippet" href="#">位于上海市闵行区元江路5500号。</a>
    </div>
    <div class="result results_links results_links_deep web-result">
      <a class="result__a" href="#">【上海江川东路】企业单位名录_顺企网</a>
      <a class="result__snippet" href="#">包括示范化工有限公司位于江川东路765号。</a>
    </div>
  `;
  const webEmployers = parseDuckDuckGoStreetResults(
    fakeDdgHtml,
    { road: "江川东路", district: "闵行区", city: "上海市" },
    121.4585,
    31.0205,
    rawOsm.roadPoints,
  );
  assert.equal(webEmployers.length, 1);
  assert.equal(webEmployers[0]?.name, "示例半导体制造（上海）有限公司");
  assert.equal(webEmployers[0]?.streetAddress, "闵行区 · 江川东路388号");
  assert.match(webEmployers[0]?.industrySummary ?? "", /集成电路制造/);

  let forwardedHints: { road?: string; district?: string; city?: string } | undefined;
  const middleware = createNetworkMiddleware({} as NetworkRuntime, {
    nearbyCompanies: async (longitude, latitude, opts) => {
      forwardedHints = opts?.streetHints;
      return {
        ok: true,
        center: { longitude, latitude, radiusMeters: opts?.radiusMeters ?? 2500 },
        companies: [],
        cached: false,
        source: "osm-nominatim",
      };
    },
  });
  const server = createServer((req, res) => {
    void middleware(req, res, () => {
      res.statusCode = 404;
      res.end("not found");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  assert(addr && typeof addr !== "string");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    const res = await requestJson(
      `${baseUrl}/api/network/nearby-companies?lon=121.4585&lat=31.0205&radius=2500&road=${encodeURIComponent("江川东路")}&district=${encodeURIComponent("闵行区")}&city=${encodeURIComponent("上海市")}`,
      { headers: { Origin: baseUrl } },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(forwardedHints, { road: "江川东路", district: "闵行区", city: "上海市" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});
