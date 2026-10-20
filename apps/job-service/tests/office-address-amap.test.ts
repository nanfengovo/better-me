import assert from "node:assert/strict";
import test from "node:test";
import type { JobLocation, ToolHandlerContext } from "@better-me/opportunities";
import type { SourceTransport, SourceTransportRequest, SourceTransportResponse } from "@better-me/source-adapters";
import {
  gcj02ToWgs84, parseAmapOfficeCandidates, createAmapOfficeProvider, resolveAmapApiKey,
} from "../src/office-address-provider.js";
import { parseJobServiceArgs } from "../src/cli.js";

const context = (): ToolHandlerContext => ({
  actorScope: "test",
  now: () => Date.now(),
  throwIfCancelled: () => {},
});

const officeLocation: JobLocation = {
  id: "loc-test-1",
  kind: "office",
  countryCode: "CN",
  raw: "上海市浦东新区张江高科",
  evidence: [{ quote: "上海张江", sourceId: "test-src", url: "https://example.com/job/1" }],
  displayLabel: "上海",
};

test("gcj02ToWgs84 accurately converts GCJ-02 coordinates to WGS-84 in China and leaves foreign points unchanged", () => {
  // Foreign coordinates remain unchanged
  const london = gcj02ToWgs84(-0.1276, 51.5074);
  assert.equal(london.longitude, -0.1276);
  assert.equal(london.latitude, 51.5074);

  // Shanghai coordinates: GCJ-02 (121.603306, 31.200155) -> WGS-84 (~121.5991072, ~31.2023708)
  const shanghai = gcj02ToWgs84(121.603306, 31.200155);
  assert.ok(Math.abs(shanghai.longitude - 121.5991072) < 0.00001);
  assert.ok(Math.abs(shanghai.latitude - 31.2023708) < 0.00001);

  // Beijing coordinates: GCJ-02 (116.397477, 39.908692) -> WGS-84 (~116.3912359, ~39.9072908)
  const beijing = gcj02ToWgs84(116.397477, 39.908692);
  assert.ok(Math.abs(beijing.longitude - 116.3912359) < 0.00001);
  assert.ok(Math.abs(beijing.latitude - 39.9072908) < 0.00001);
});

test("parseAmapOfficeCandidates accepts building/door level points and rejects coarse road/city levels", () => {
  const amapSuccess = {
    status: "1",
    info: "OK",
    infocode: "10000",
    count: "2",
    geocodes: [
      {
        formatted_address: "上海市浦东新区张江高科技园区博云路2号",
        country: "中国",
        province: "上海市",
        city: "上海市",
        district: "浦东新区",
        street: "博云路",
        number: "2号",
        location: "121.603306,31.200155",
        level: "门牌号",
      },
      {
        formatted_address: "上海市浦东新区张江路",
        country: "中国",
        province: "上海市",
        city: "上海市",
        district: "浦东新区",
        street: "张江路",
        location: "121.61,31.21",
        level: "道路",
      },
    ],
  };

  const candidates = parseAmapOfficeCandidates(amapSuccess, "CN");
  // Only the 门牌号 point should be accepted; 道路 should be excluded
  assert.equal(candidates.length, 1);
  const item = candidates[0]!;
  assert.equal(item.providerId, "amap");
  assert.equal(item.proposal.countryCode, "CN");
  assert.equal(item.proposal.streetAddress, "博云路 2号");
  assert.equal(item.proposal.coordinateMeaning, "site");
  assert.equal(item.proposal.coordinates.coordinateSystem, "WGS84");
  assert.ok(Math.abs(item.proposal.coordinates.longitude - 121.5991072) < 0.00001);
  assert.match(item.attribution, /高德开放平台/);

  // Building level should have coordinateMeaning "building"
  const buildingAmap = {
    status: "1",
    info: "OK",
    geocodes: [{
      formatted_address: "上海市浦东新区科技大厦",
      country: "中国",
      province: "上海市",
      city: "上海市",
      district: "浦东新区",
      street: "科苑路",
      number: "88号",
      location: "121.603306,31.200155",
      level: "楼宇",
    }],
  };
  const buildingCandidates = parseAmapOfficeCandidates(buildingAmap, "CN");
  assert.equal(buildingCandidates[0]!.proposal.coordinateMeaning, "building");
});

test("parseAmapOfficeCandidates enforces locality constraints and translates error infocodes", () => {
  const amapSuccess = {
    status: "1",
    info: "OK",
    geocodes: [{
      formatted_address: "北京市海淀区中关村南大街1号",
      country: "中国",
      province: "北京市",
      city: "北京市",
      district: "海淀区",
      street: "中关村南大街",
      number: "1号",
      location: "116.32,39.95",
      level: "门牌号",
    }],
  };

  // Searching with locality "上海" should filter out Beijing
  const filtered = parseAmapOfficeCandidates(amapSuccess, "CN", { locality: "上海" });
  assert.equal(filtered.length, 0);

  // Searching with locality "北京" should retain it
  const retained = parseAmapOfficeCandidates(amapSuccess, "CN", { locality: "北京" });
  assert.equal(retained.length, 1);

  // Infocode 10001 throws needs-auth
  assert.throws(() => parseAmapOfficeCandidates({ status: "0", info: "INVALID_USER_KEY", infocode: "10001" }), (err: any) => err.code === "needs-auth");
  // Infocode 10003 throws rate-limited
  assert.throws(() => parseAmapOfficeCandidates({ status: "0", info: "DAILY_QUERY_OVER_LIMIT", infocode: "10003" }), (err: any) => err.code === "rate-limited");
});

test("createAmapOfficeProvider requires key and executes bounded query with caching", async () => {
  const syntheticTransport: SourceTransport = {
    request: async (req: SourceTransportRequest): Promise<SourceTransportResponse> => {
      assert.match(req.url, /restapi\.amap\.com\/v3\/geocode\/geo/);
      assert.match(req.url, /key=synthetic-test-key/);
      return {
        status: 200,
        url: req.url,
        text: JSON.stringify({
          status: "1",
          info: "OK",
          count: "1",
          geocodes: [{
            formatted_address: "上海市浦东新区张江高科技园区博云路2号",
            country: "中国",
            city: "上海市",
            district: "浦东新区",
            street: "博云路",
            number: "2号",
            location: "121.603306,31.200155",
            level: "门牌号",
          }],
        }),
        headers: { "content-type": "application/json" },
      };
    },
  };

  // Missing key throws needs-auth
  const unconfiguredProvider = createAmapOfficeProvider(syntheticTransport, { key: "" });
  await assert.rejects(
    () => unconfiguredProvider.search({ query: "博云路2号", location: officeLocation }, context()),
    (err: any) => err.code === "needs-auth",
  );

  // Configured provider returns candidates
  const provider = createAmapOfficeProvider(syntheticTransport, { key: "synthetic-test-key" });
  const results = await provider.search({ query: "博云路2号", location: officeLocation, locality: "上海" }, context());
  assert.equal(results.length, 1);
  assert.equal(results[0]!.providerId, "amap");
  assert.equal(results[0]!.proposal.streetAddress, "博云路 2号");

  // Subsequent search within cache window uses cache
  const cached = await provider.search({ query: "博云路2号", location: officeLocation, locality: "上海" }, context());
  assert.equal(cached.length, 1);
  assert.deepEqual(cached[0], results[0]);
});

test("CLI argument parsing accepts --office-geocoder amap and --amap-key", () => {
  const result = parseJobServiceArgs([
    "--data-dir", "/tmp/better-me-test",
    "--origin", "http://localhost:5173",
    "--office-geocoder", "amap",
    "--amap-key", "test-key-12345",
  ]);
  assert.equal(result.help, false);
  if (!result.help) {
    assert.deepEqual(result.config.officeGeocoder, { provider: "amap", key: "test-key-12345" });
  }

  // Reject --amap-key without amap provider
  assert.throws(() => parseJobServiceArgs([
    "--data-dir", "/tmp/better-me-test",
    "--origin", "http://localhost:5173",
    "--office-geocoder", "nominatim",
    "--amap-key", "test-key-12345",
  ]), /--amap-key option requires --office-geocoder amap/);
});
