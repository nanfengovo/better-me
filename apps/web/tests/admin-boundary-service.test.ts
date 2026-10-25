import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveAdminBoundaryHighlight,
  ADMIN_BOUNDARY_COLORS,
  calculateGeoJsonBounds,
} from "../src/components/atlas/admin-boundary-service";

test("admin-boundary-service assigns distinct colors by hierarchy level", () => {
  // Province must be Cyan
  assert.equal(ADMIN_BOUNDARY_COLORS.province.dark.stroke, "#00f0ff");
  assert.equal(ADMIN_BOUNDARY_COLORS.province.light.stroke, "#0284c7");

  // City must be Electric Violet
  assert.equal(ADMIN_BOUNDARY_COLORS.city.dark.stroke, "#a855f7");
  assert.equal(ADMIN_BOUNDARY_COLORS.city.light.stroke, "#7c3aed");

  // District must be Neon Amber / Gold
  assert.equal(ADMIN_BOUNDARY_COLORS.district.dark.stroke, "#f59e0b");
  assert.equal(ADMIN_BOUNDARY_COLORS.district.light.stroke, "#d97706");

  // All three levels have distinct strokes
  const darkStrokes = [
    ADMIN_BOUNDARY_COLORS.province.dark.stroke,
    ADMIN_BOUNDARY_COLORS.city.dark.stroke,
    ADMIN_BOUNDARY_COLORS.district.dark.stroke,
  ];
  assert.equal(new Set(darkStrokes).size, 3);
});

test("resolves province-level boundary for Shanghai (31) with Cyan stroke and bounds", async () => {
  const result = await resolveAdminBoundaryHighlight({ provinceCode: "31" }, "dark");
  assert.ok(result);
  assert.equal(result.level, "province");
  assert.equal(result.name, "上海市");
  assert.equal(result.color, "#00f0ff");
  assert.ok(result.bounds);
  assert.ok(result.bounds[0] < result.bounds[2]);
  assert.ok(result.bounds[1] < result.bounds[3]);
  assert.equal(result.boundsMaxZoom, 8);
});

test("resolves city-level boundary for direct municipality (3101) with municipality stroke", async () => {
  const result = await resolveAdminBoundaryHighlight({ provinceCode: "31", cityCode: "3101" }, "dark");
  assert.ok(result);
  assert.equal(result.level, "province");
  assert.equal(result.name, "上海市全域");
  assert.equal(result.color, "#00f0ff");
  assert.ok(result.bounds);
  assert.equal(result.boundsMaxZoom, 11);
});

test("resolves district-level boundary for Pudong (310115) with Amber stroke and exact bounds", async () => {
  const result = await resolveAdminBoundaryHighlight(
    { provinceCode: "31", cityCode: "3101", districtCode: "310115" },
    "dark"
  );
  assert.ok(result);
  assert.equal(result.level, "district");
  assert.equal(result.name, "浦东新区");
  assert.equal(result.color, "#f59e0b");
  assert.ok(result.bounds);
  // Pudong bounds should encompass Tesla factory in Lingang [121.7712, 30.8728]
  const [west, south, east, north] = result.bounds;
  assert.ok(west <= 121.7712 && east >= 121.7712);
  assert.ok(south <= 30.8728 && north >= 30.8728);
  assert.equal(result.boundsMaxZoom, 13.5);
});

test("resolves city-level boundary for Guangdong Shenzhen (4403)", async () => {
  const result = await resolveAdminBoundaryHighlight({ provinceCode: "44", cityCode: "4403" }, "dark");
  assert.ok(result);
  assert.equal(result.level, "city");
  assert.equal(result.name, "深圳市");
  assert.equal(result.color, "#a855f7");
  assert.ok(result.bounds);
});

test("empty selection returns null", async () => {
  const result = await resolveAdminBoundaryHighlight({});
  assert.equal(result, null);
});
