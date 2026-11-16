import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import {
  buildAccuracyCircleRing,
  buildUserLocationGeoJson,
  createUserLocationMarker,
  describeGeolocationError,
  EMPTY_USER_LOCATION_GEOJSON,
  formatAccuracyLabel,
  formatDistanceLabel,
  formatFixPrecisionLabel,
  haversineDistanceMeters,
  isValidLngLat,
  normalizeGeolocationPosition,
  requestBrowserGeolocation,
  requestNetworkFallbackGeolocation,
  requestReverseGeocode,
  requestSearchLocation,
  requestNearbyCompanies,
  buildNearbyCompaniesGeoJson,
} from "../src/components/atlas/prototypes/user-location.ts";
import {
  enrichNearbyCompaniesWithIndex,
  findNearbyIndexedOfficeBuckets,
} from "../src/components/atlas/nearby-company-radar.ts";

test("isValidLngLat and normalizeGeolocationPosition validate coordinates and clamp optional fields", () => {
  assert.equal(isValidLngLat(121.4737, 31.2304), true);
  assert.equal(isValidLngLat(181, 31), false);
  assert.equal(isValidLngLat(121, Number.NaN), false);

  assert.equal(normalizeGeolocationPosition({ coords: { longitude: 999, latitude: 31 } }), null);

  const fix = normalizeGeolocationPosition({
    coords: { longitude: 121.4737, latitude: 31.2304, accuracy: 27.6, heading: 92, speed: 1.4 },
    timestamp: 1_700_000_000_000,
  });
  assert.ok(fix);
  assert.equal(fix.longitude, 121.4737);
  assert.equal(fix.latitude, 31.2304);
  assert.equal(fix.accuracyMeters, 27.6);
  assert.equal(fix.heading, 92);
  assert.equal(fix.speedMps, 1.4);
  assert.equal(fix.timestamp, 1_700_000_000_000);

  const partial = normalizeGeolocationPosition({
    coords: { longitude: 116.4074, latitude: 39.9042, accuracy: null, heading: -1, speed: null },
  });
  assert.ok(partial);
  assert.equal(partial.accuracyMeters, 50);
  assert.equal(partial.heading, null);
  assert.equal(partial.speedMps, null);
});

test("buildAccuracyCircleRing and buildUserLocationGeoJson produce closed geodesic meter rings", () => {
  assert.deepEqual(buildUserLocationGeoJson(null), EMPTY_USER_LOCATION_GEOJSON);

  const ring = buildAccuracyCircleRing(121.4737, 31.2304, 200, 32);
  assert.equal(ring.length, 33);
  assert.deepEqual(ring[0], ring.at(-1));

  // Verify the EW/NS extents approximate 200m radius at Shanghai latitude (~31.23 deg).
  const minLat = Math.min(...ring.map((p) => p[1]));
  const maxLat = Math.max(...ring.map((p) => p[1]));
  const northDist = haversineDistanceMeters(
    { longitude: 121.4737, latitude: 31.2304 },
    { longitude: 121.4737, latitude: maxLat },
  );
  const southDist = haversineDistanceMeters(
    { longitude: 121.4737, latitude: 31.2304 },
    { longitude: 121.4737, latitude: minLat },
  );
  assert.ok(northDist !== null && northDist > 195 && northDist < 205);
  assert.ok(southDist !== null && southDist > 195 && southDist < 205);

  const geoJson = buildUserLocationGeoJson({
    longitude: 121.4737,
    latitude: 31.2304,
    accuracyMeters: 42.3,
    heading: 180,
    speedMps: null,
    timestamp: 100,
  });
  assert.equal(geoJson.features.length, 2);
  assert.equal(geoJson.features[0]?.geometry.type, "Polygon");
  assert.equal(geoJson.features[0]?.properties?.kind, "accuracy");
  assert.equal(geoJson.features[0]?.properties?.accuracyMeters, 42);
  assert.equal(geoJson.features[1]?.geometry.type, "Point");
  assert.equal(geoJson.features[1]?.properties?.kind, "point");
  assert.equal(geoJson.features[1]?.properties?.label, "我的位置 · ±42m");
});

test("formatting helpers, error messages, and DOM marker reflect precision and distance accurately", async () => {
  assert.equal(formatAccuracyLabel(28.4), "±28m");
  assert.equal(formatAccuracyLabel(1480), "±1.5km");
  assert.equal(formatDistanceLabel(640), "640m");
  assert.equal(formatDistanceLabel(2640), "2.6km");
  assert.equal(formatDistanceLabel(12_400), "12km");

  assert.equal(describeGeolocationError({ code: 1 }).code, "denied");
  assert.equal(describeGeolocationError({ code: 2 }).code, "unavailable");
  assert.equal(describeGeolocationError({ code: 3 }).code, "timeout");

  const dom = new Window({ url: "http://user-location.invalid" });
  try {
    const marker = createUserLocationMarker(
      dom.document as unknown as Document,
      {
        longitude: 121.4737,
        latitude: 31.2304,
        accuracyMeters: 25,
        heading: 45,
        speedMps: null,
        timestamp: 100,
      },
      true,
      2640,
    );
    assert.equal(marker.classList.contains("atlas-user-location-marker"), true);
    assert.equal(marker.classList.contains("light"), true);
    assert.ok(marker.querySelector(".atlas-user-location-dot"));
    assert.ok(marker.querySelector(".atlas-user-location-halo"));
    const cone = marker.querySelector<HTMLElement>(".atlas-user-location-heading");
    assert.ok(cone);
    assert.match(cone.style.transform, /rotate\(45deg\)/);
    assert.equal(marker.querySelector(".atlas-user-location-tag")?.textContent, "我的位置 · ±25m · 距选中 2.6km");
  } finally {
    await dom.happyDOM.close();
  }
});

test("requestBrowserGeolocation falls back to standard accuracy on timeout/unavailable, aborts on denied, and ignores cancelled callbacks", async () => {
  const calls: Array<{ opts: PositionOptions | undefined; ok: PositionCallback; err: PositionErrorCallback | null | undefined }> = [];
  const fakeGeo = {
    getCurrentPosition(ok: PositionCallback, err?: PositionErrorCallback | null, opts?: PositionOptions) {
      calls.push({ opts, ok, err });
    },
  };

  // 1. Timeout on high accuracy retries once with enableHighAccuracy: false and succeeds.
  const results: Array<{ kind: "ok"; lng: number } | { kind: "err"; code: number | undefined }> = [];
  requestBrowserGeolocation(
    fakeGeo,
    (fix) => results.push({ kind: "ok", lng: fix.longitude }),
    (err) => results.push({ kind: "err", code: err.code }),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.opts?.enableHighAccuracy, true);
  calls[0]?.err?.({ code: 3, message: "Timeout" } as GeolocationPositionError);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.opts?.enableHighAccuracy, false);
  assert.ok((calls[1]?.opts?.maximumAge ?? 0) >= 300_000);
  calls[1]?.ok({ coords: { longitude: 121.48, latitude: 31.23, accuracy: 85 } as GeolocationCoordinates, timestamp: 1234 } as GeolocationPosition);
  assert.deepEqual(results, [{ kind: "ok", lng: 121.48 }]);

  // 2. Permission denial stops immediately without fallback retry.
  calls.length = 0;
  results.length = 0;
  requestBrowserGeolocation(
    fakeGeo,
    (fix) => results.push({ kind: "ok", lng: fix.longitude }),
    (err) => results.push({ kind: "err", code: err.code }),
  );
  assert.equal(calls.length, 1);
  calls[0]?.err?.({ code: 1, message: "Denied" } as GeolocationPositionError);
  assert.equal(calls.length, 1);
  assert.deepEqual(results, [{ kind: "err", code: 1 }]);

  // 3. Cancellation drops late async callbacks cleanly.
  calls.length = 0;
  results.length = 0;
  const abort = requestBrowserGeolocation(
    fakeGeo,
    (fix) => results.push({ kind: "ok", lng: fix.longitude }),
    (err) => results.push({ kind: "err", code: err.code }),
  );
  abort();
  calls[0]?.err?.({ code: 3, message: "Late timeout" } as GeolocationPositionError);
  assert.equal(calls.length, 1);
  assert.deepEqual(results, []);
});

test("manual pin fixes omit accuracy rings and render honest 手动标点 labels", async () => {
  const manualFix = {
    longitude: 121.49,
    latitude: 31.24,
    accuracyMeters: 0,
    heading: null,
    speedMps: null,
    timestamp: 100,
    source: "manual" as const,
  };
  assert.equal(formatFixPrecisionLabel(manualFix), "手动标点");
  const geoJson = buildUserLocationGeoJson(manualFix);
  assert.equal(geoJson.features.length, 1);
  assert.equal(geoJson.features[0]?.geometry.type, "Point");
  assert.equal(geoJson.features[0]?.properties?.label, "我的位置 · 手动标点");

  const dom = new Window({ url: "http://user-location.invalid" });
  try {
    const marker = createUserLocationMarker(dom.document as unknown as Document, manualFix, false, 1500);
    assert.equal(marker.querySelector(".atlas-user-location-tag")?.textContent, "我的位置 · 手动标点 · 距选中 1.5km");
    assert.match(marker.getAttribute("aria-label") ?? "", /手动标点/);
  } finally {
    await dom.happyDOM.close();
  }
});

test("IP fallback fixes format city-level labels with accuracy ring and validate /api/network/geolocate responses", async () => {
  const ipFix = {
    longitude: 121.476753,
    latitude: 31.224349,
    accuracyMeters: 5000,
    heading: null,
    speedMps: null,
    timestamp: 200,
    source: "ip" as const,
    placeLabel: "上海",
  };
  assert.equal(formatFixPrecisionLabel(ipFix), "网络定位 · 上海 · ±5.0km");
  const geoJson = buildUserLocationGeoJson(ipFix);
  assert.equal(geoJson.features.length, 2);
  assert.equal(geoJson.features[0]?.geometry.type, "Polygon");
  assert.equal(geoJson.features[1]?.geometry.type, "Point");

  const dom = new Window({ url: "http://user-location.invalid" });
  try {
    const marker = createUserLocationMarker(dom.document as unknown as Document, ipFix, false);
    assert.equal(marker.classList.contains("is-approximate"), true);
    assert.equal(marker.querySelector(".atlas-user-location-tag")?.textContent, "我的位置 · 网络定位 · 上海 · ±5.0km");
    assert.match(marker.getAttribute("aria-label") ?? "", /网络定位 上海 ±5\.0km/);
  } finally {
    await dom.happyDOM.close();
  }

  const okFix = await requestNetworkFallbackGeolocation(async (url) => {
    assert.equal(url, "/api/network/geolocate");
    return {
      ok: true,
      json: async () => ({
        ok: true,
        source: "ip",
        longitude: 121.476753,
        latitude: 31.224349,
        accuracyMeters: 5000,
        cityLabel: "上海",
        timestamp: 1763218000000,
      }),
    };
  });
  assert.deepEqual(okFix, {
    longitude: 121.476753,
    latitude: 31.224349,
    accuracyMeters: 5000,
    heading: null,
    speedMps: null,
    timestamp: 1763218000000,
    source: "ip",
    placeLabel: "上海",
  });

  // Reject non-geolocate JSON payloads (e.g., GeoJSON empty feature collections or invalid coordinates)
  assert.equal(
    await requestNetworkFallbackGeolocation(async () => ({
      ok: true,
      json: async () => ({ type: "FeatureCollection", features: [] }),
    })),
    null,
  );
  assert.equal(
    await requestNetworkFallbackGeolocation(async () => ({
      ok: true,
      json: async () => ({ ok: true, longitude: 0, latitude: 0 }),
    })),
    null,
  );
  assert.equal(
    await requestNetworkFallbackGeolocation(async () => ({
      ok: false,
      json: async () => ({ ok: false, error: "offline" }),
    })),
    null,
  );
});

test("macos, search, and reverse-geocoded manual fixes display street labels while IP fixes never adopt streetLabel", async () => {
  const macosFix = {
    longitude: 121.454,
    latitude: 31.229,
    accuracyMeters: 28,
    heading: null,
    speedMps: null,
    timestamp: 300,
    source: "macos" as const,
    placeLabel: "上海市 · 静安区",
    streetLabel: "静安区 · 南京西路街道 · 南京西路 1266号",
    coreLocationStatus: "authorized",
  };
  assert.equal(formatFixPrecisionLabel(macosFix), "静安区 · 南京西路街道 · 南京西路 1266号 · ±28m");

  const searchFix = {
    longitude: 121.454,
    latitude: 31.229,
    accuracyMeters: 80,
    heading: null,
    speedMps: null,
    timestamp: 301,
    source: "search" as const,
    placeLabel: "上海市 · 静安区",
    streetLabel: "静安区 · 南京西路",
  };
  assert.equal(formatFixPrecisionLabel(searchFix), "静安区 · 南京西路 · 街道定位");

  const streetManualFix = {
    longitude: 121.48,
    latitude: 31.23,
    accuracyMeters: 0,
    heading: null,
    speedMps: null,
    timestamp: 302,
    source: "manual" as const,
    streetLabel: "黄浦区 · 延安东路",
  };
  assert.equal(formatFixPrecisionLabel(streetManualFix), "黄浦区 · 延安东路 · 手动标点");

  const dom = new Window({ url: "http://user-location.invalid" });
  try {
    const macMarker = createUserLocationMarker(dom.document as unknown as Document, macosFix, false);
    assert.equal(macMarker.classList.contains("is-approximate"), false);
    assert.match(macMarker.getAttribute("aria-label") ?? "", /系统精准定位 静安区 · 南京西路街道 · 南京西路 1266号/);

    const searchMarker = createUserLocationMarker(dom.document as unknown as Document, searchFix, false);
    assert.equal(searchMarker.classList.contains("is-approximate"), false);
    assert.match(searchMarker.getAttribute("aria-label") ?? "", /街道定位 静安区 · 南京西路 · 街道定位/);
  } finally {
    await dom.happyDOM.close();
  }

  const macosResponse = await requestNetworkFallbackGeolocation({
    authorize: true,
    fetchImpl: async (url) => {
      assert.equal(url, "/api/network/geolocate?authorize=1");
      return {
        ok: true,
        json: async () => ({
          ok: true,
          source: "macos",
          longitude: 121.454,
          latitude: 31.229,
          accuracyMeters: 28,
          cityLabel: "上海市 · 静安区",
          streetLabel: "静安区 · 南京西路 1266号",
          coreLocationStatus: "authorized",
          timestamp: 400,
        }),
      };
    },
  });
  assert.deepEqual(macosResponse, {
    longitude: 121.454,
    latitude: 31.229,
    accuracyMeters: 28,
    heading: null,
    speedMps: null,
    timestamp: 400,
    source: "macos",
    placeLabel: "上海市 · 静安区",
    streetLabel: "静安区 · 南京西路 1266号",
    coreLocationStatus: "authorized",
  });

  // Never propagate a stray streetLabel onto city-level IP responses.
  const sanitizedIpResponse = await requestNetworkFallbackGeolocation({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        source: "ip",
        longitude: 121.47,
        latitude: 31.22,
        accuracyMeters: 5000,
        cityLabel: "上海",
        streetLabel: "should-be-dropped",
        coreLocationStatus: "denied",
        timestamp: 401,
      }),
    }),
  });
  assert.deepEqual(sanitizedIpResponse, {
    longitude: 121.47,
    latitude: 31.22,
    accuracyMeters: 5000,
    heading: null,
    speedMps: null,
    timestamp: 401,
    source: "ip",
    placeLabel: "上海",
    coreLocationStatus: "denied",
  });

  const rev = await requestReverseGeocode(121.48, 31.23, async (url) => {
    assert.equal(url, "/api/network/reverse-geocode?lon=121.48&lat=31.23");
    return {
      ok: true,
      json: async () => ({ ok: true, cityLabel: "上海市 · 黄浦区", streetLabel: "黄浦区 · 延安东路" }),
    };
  });
  assert.deepEqual(rev, { cityLabel: "上海市 · 黄浦区", streetLabel: "黄浦区 · 延安东路" });

  const hits = await requestSearchLocation("南京西路", "上海", async (url) => {
    assert.equal(url, "/api/network/search-location?q=%E5%8D%97%E4%BA%AC%E8%A5%BF%E8%B7%AF&city=%E4%B8%8A%E6%B5%B7");
    return {
      ok: true,
      json: async () => ({
        ok: true,
        candidates: [
          {
            id: "hit-1",
            label: "静安区 · 南京西路",
            streetLabel: "静安区 · 南京西路",
            cityLabel: "上海市",
            longitude: 121.454,
            latitude: 31.229,
          },
          {
            id: "invalid",
            streetLabel: "bad",
            longitude: 0,
            latitude: 0,
          },
        ],
      }),
    };
  });
  assert.deepEqual(hits, [
    {
      id: "hit-1",
      label: "静安区 · 南京西路",
      streetLabel: "静安区 · 南京西路",
      cityLabel: "上海市",
      longitude: 121.454,
      latitude: 31.229,
    },
  ]);
});

test("nearby company helpers fetch real employers, match local indexed jobs by brand alias, and rank nearby buckets", async () => {
  const companies = await requestNearbyCompanies(121.454, 31.028, 2500, async (url) => {
    assert.equal(url, "/api/network/nearby-companies?lon=121.454&lat=31.028&radius=2500");
    return {
      ok: true,
      json: async () => ({
        ok: true,
        companies: [
          {
            id: "way-1",
            name: "英特尔亚太研发有限公司",
            shortName: "英特尔亚太研发",
            searchKeyword: "英特尔",
            kind: "company",
            longitude: 121.4506,
            latitude: 31.0238,
            distanceMeters: 563,
            streetAddress: "闵行区 · 紫星路",
            ownershipLabel: "外资 / 跨国分支（待核实）",
            ownershipColor: "#76BD8A",
          },
          {
            id: "way-2",
            name: "微软",
            shortName: "微软",
            searchKeyword: "微软",
            kind: "company",
            longitude: 121.4463,
            latitude: 31.0209,
            distanceMeters: 1078,
            ownershipLabel: "企业实体（控股待核）",
            ownershipColor: "#38BDF8",
          },
        ],
      }),
    };
  });
  assert.equal(companies.length, 2);

  const dataset = {
    schemaVersion: 1,
    revision: 1,
    generatedAt: "2026-11-16T00:00:00Z",
    companies: [
      { id: "c-intel", names: ["Intel 英特尔中国"], sourceIds: [] },
      { id: "c-msft", names: ["Microsoft 微软"], sourceIds: [] },
    ],
    jobs: [
      { id: "j1", companyId: "c-intel", status: "open", listingIds: [] },
      { id: "j2", companyId: "c-intel", status: "open", listingIds: [] },
      { id: "j3", companyId: "c-intel", status: "closed", listingIds: [] },
      { id: "j4", companyId: "c-msft", status: "closed", listingIds: [] },
    ],
    listings: [],
    observations: [],
    snapshots: [],
    locations: [],
    compensations: [],
    sources: [],
  } as any;

  const enriched = enrichNearbyCompaniesWithIndex(companies, dataset);
  assert.equal(enriched[0]?.indexedJobCount, 2);
  assert.equal(enriched[1]?.indexedJobCount, undefined);

  const geoJson = buildNearbyCompaniesGeoJson(enriched, "way-2");
  assert.equal(geoJson.features.length, 2);
  assert.equal(geoJson.features[0]?.properties.mapLabel, "英特尔亚太研发 · 2岗 · 563m");
  assert.equal(geoJson.features[1]?.properties.selected, true);

  const buckets = [
    {
      id: "city-ref",
      label: "上海",
      latitude: 31.028,
      longitude: 121.454,
      jobCount: 5,
      jobIds: ["j1"],
      locationIds: ["l1"],
      positionBasis: "city-reference",
      precision: "city",
      displayGrade: "city",
      categories: [],
    },
    {
      id: "near-office",
      label: "紫竹广场路1号",
      latitude: 31.024,
      longitude: 121.449,
      jobCount: 3,
      jobIds: ["j2"],
      locationIds: ["l2"],
      displayGrade: "address",
      categories: [],
    },
  ] as any;
  const nearBuckets = findNearbyIndexedOfficeBuckets(buckets, { longitude: 121.454, latitude: 31.028, source: "macos" }, 5000);
  assert.equal(nearBuckets.length, 1);
  assert.equal(nearBuckets[0]?.bucket.id, "near-office");
  assert.equal(findNearbyIndexedOfficeBuckets(buckets, { longitude: 121.454, latitude: 31.028, source: "ip" }, 5000).length, 0);

  // Unfiltered nearby indexed office locations surface even when narrow role keyword filters hide them
  const unfilteredDataset = {
    schemaVersion: 1,
    revision: 1,
    generatedAt: "2026-11-16T00:00:00Z",
    companies: [{ id: "c-mfg", names: ["精密制造股份有限公司"], sourceIds: [] }],
    jobs: [{ id: "j-mfg", companyId: "c-mfg", status: "open", locationIds: ["l-mfg"], listingIds: [] }],
    locations: [
      {
        id: "l-mfg",
        raw: "闵行区江川东路388号",
        kind: "office",
        precision: "address",
        streetAddress: "江川东路388号",
        coordinates: { longitude: 121.4585, latitude: 31.0205 },
        evidence: [],
        verification: "unverified",
      },
    ],
    listings: [],
    observations: [],
    snapshots: [],
    compensations: [],
    sources: [],
  } as any;
  const recoveredBuckets = findNearbyIndexedOfficeBuckets(
    [],
    { longitude: 121.459, latitude: 31.021, source: "macos" },
    5000,
    unfilteredDataset,
  );
  assert.equal(recoveredBuckets.length, 1);
  assert.equal(recoveredBuckets[0]?.outsideCurrentFilter, true);
  assert.equal(recoveredBuckets[0]?.companyKeyword, "精密制造股份有限公司");

  // Also supplements nearbyCompanies directly from local indexed locations when online API returns empty
  const offlineFallbackCompanies = enrichNearbyCompaniesWithIndex(
    [],
    unfilteredDataset,
    { longitude: 121.459, latitude: 31.021, source: "macos" },
    2500,
  );
  assert.equal(offlineFallbackCompanies.length, 1);
  assert.equal(offlineFallbackCompanies[0]?.name, "精密制造股份有限公司");
  assert.equal(offlineFallbackCompanies[0]?.indexedJobCount, 1);

  await requestNearbyCompanies(
    121.4585,
    31.0205,
    2500,
    async (url) => {
      assert.match(url, /road=%E6%B1%9F%E5%B7%9D%E4%B8%9C%E8%B7%AF/);
      assert.match(url, /district=%E9%97%B5%E8%A1%8C%E5%8C%BA/);
      return { ok: true, json: async () => ({ ok: true, companies: [] }) };
    },
    undefined,
    5000,
    { road: "江川东路", district: "闵行区" },
  );
});
