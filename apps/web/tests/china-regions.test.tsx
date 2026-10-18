import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { queryJobs } from "@better-me/opportunities";
import catalog from "../../../config/geography/china-administrative/catalog.json";
import manifest from "../../../config/geography/china-administrative/source-manifest.json";
import textAliases from "../../../config/geography/china-administrative/text-aliases.json";
import { assessSourceScopeMatch } from "../../../packages/source-adapters/src/local-match.ts";
import { SourceJobRecordSchema } from "../../../packages/source-adapters/src/contracts.ts";
import {
  buildChinaRegionFilter, findChinaProvinceByMapId, getChinaCities, getChinaDistricts, getChinaProvinces,
  getChinaRegionChildren, matchDisclosedChinaCities, resolveChinaRegionSelection,
} from "../src/components/atlas/china-regions.ts";
import { createAtlasDemo } from "../src/components/atlas/demo.ts";

test("pinned administrative data retains exact upstream bytes, license, historical date and finite coverage", () => {
  for (const file of manifest.files) {
    const bytes = readFileSync(new URL(`../../../config/geography/china-administrative/${file.file}`, import.meta.url));
    assert.equal(bytes.byteLength, file.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
    assert.ok(file.source.includes(manifest.revision));
  }
  assert.equal(manifest.license, "WTFPL-2.0"); assert.equal(manifest.dataAsOf, "2023-06-30");
  assert.equal(manifest.upstreamMaintenance, "discontinued"); assert.deepEqual(manifest.coverage.excluded, ["HK", "MO", "TW"]);
  assert.equal(catalog.length, 31); assert.equal(catalog.flatMap((node) => node.children).length, 342);
  const leaves = catalog.flatMap((node) => node.children.flatMap((city) => city.children));
  assert.equal(leaves.length, 3056); assert.equal(leaves.filter((node) => node.code.length === 9).length, 82);
  const all = catalog.flatMap((node) => [node, ...node.children.flatMap((city) => [city, ...city.children])]);
  assert.equal(new Set(all.map((node) => node.code)).size, all.length);
  assert.ok(all.every((node) => !Object.hasOwn(node, "coordinates") && !Object.hasOwn(node, "jobs")));
});

test("province city and district options work in an empty index and invalidate stale or cross-parent children", () => {
  assert.equal(getChinaProvinces().filter((node) => node.catalogAvailable).length, 31);
  assert.ok(getChinaCities("44").some((node) => node.code === "4403" && node.label === "深圳市"));
  assert.ok(getChinaDistricts("44", "4403").some((node) => node.code === "440305" && node.name === "南山区"));
  assert.deepEqual(getChinaDistricts("33", "4403"), []); assert.deepEqual(getChinaRegionChildren("unknown"), []);
  assert.deepEqual(getChinaRegionChildren("44"), getChinaCities("44")); assert.deepEqual(getChinaRegionChildren("4403"), getChinaDistricts("44", "4403"));
  assert.deepEqual(resolveChinaRegionSelection({ provinceCode: "unknown", cityCode: "4403", districtCode: "440305" }).selection, {});
  assert.deepEqual(resolveChinaRegionSelection({ provinceCode: "33", cityCode: "4403", districtCode: "440305" }).selection, { provinceCode: "33" });
  assert.deepEqual(resolveChinaRegionSelection({ provinceCode: "44", cityCode: "4403", districtCode: "330102" }).selection, { provinceCode: "44", cityCode: "4403" });
  const selected = resolveChinaRegionSelection({ provinceCode: "44", cityCode: "4403", districtCode: "440305" });
  assert.equal(selected.selectedDistrict?.name, "南山区");
});

test("municipality grouping keeps real source codes and township entries are visibly distinguished from districts", () => {
  assert.deepEqual(getChinaCities("11").map((node) => [node.code, node.name, node.label, node.isGrouping]), [["1101", "市辖区", "北京市", true]]);
  assert.equal(getChinaDistricts("11", "1101").find((node) => node.code === "110108")?.name, "海淀区");
  assert.deepEqual(getChinaCities("50").map((node) => node.label), ["重庆市 · 市辖区", "重庆市 · 县"]);
  const dongguan = getChinaDistricts("44", "4419");
  assert.ok(dongguan.length > 0); assert.ok(dongguan.every((node) => node.level === "township" && node.code.length === 9 && node.label.includes("镇街／功能区")));
  const beijing = buildChinaRegionFilter({ provinceCode: "11", cityCode: "1101", districtCode: "110108" });
  assert.deepEqual(beijing.workRegionGroups[1], ["北京市", "北京", "Beijing"]); assert.deepEqual(beijing.workRegionGroups[2], ["海淀区"]);
});

test("map province identifiers are exact known crosswalks and missing HK MO TW subordinate catalogs stay explicit", () => {
  for (const [code, id] of Object.entries(manifest.provinceMapIds)) assert.equal(findChinaProvinceByMapId(id)?.code, code);
  assert.equal(findChinaProvinceByMapId("CN-GD")?.label, "广东省"); assert.equal(findChinaProvinceByMapId("made-up"), undefined);
  assert.deepEqual(buildChinaRegionFilter({}), { workCountryCodes: [], workRegionGroups: [], sourceRegions: [] });
  for (const code of ["HK", "MO", "TW"] as const) {
    const selected = getChinaProvinces().find((node) => node.code === code)!;
    assert.equal(selected.catalogAvailable, false); assert.ok(selected.label.includes("暂无下级目录"));
    assert.equal(findChinaProvinceByMapId(`CN-${code}`)?.code, code);
    assert.deepEqual(getChinaCities(code), []); assert.deepEqual(getChinaDistricts(code, "invented"), []);
    const filter = buildChinaRegionFilter({ provinceCode: code, cityCode: "invented", districtCode: "invented" });
    assert.deepEqual(filter.workCountryCodes, [code]); assert.deepEqual(filter.workRegionGroups, []); assert.deepEqual(filter.sourceRegions, [code]);
  }
});

test("province groups expand to disclosed cities without generating coordinates and acquisition interests stay bounded", () => {
  const before = JSON.stringify(catalog);
  const guangdong = buildChinaRegionFilter({ provinceCode: "44" });
  assert.deepEqual(guangdong.workCountryCodes, ["CN"]);
  for (const value of ["广东省", "CN-GD", "深圳市", "深圳", "广州市", "广州"]) assert.ok(guangdong.workRegionGroups[0]!.includes(value), value);
  const hainan = buildChinaRegionFilter({ provinceCode: "46" });
  assert.ok(hainan.sourceRegions.includes("万宁")); assert.ok(hainan.sourceRegions.includes("琼海"));
  assert.ok(!hainan.workRegionGroups[0]!.includes("海南"), "海南 is ambiguous with 青海海南藏族自治州");
  const chaoyang = buildChinaRegionFilter({ provinceCode: "21", cityCode: "2113" });
  assert.deepEqual(chaoyang.workRegionGroups[1], ["朝阳市"], "朝阳 alone also names districts in other cities");
  for (const province of getChinaProvinces()) {
    const filter = buildChinaRegionFilter({ provinceCode: province.code });
    assert.ok(filter.sourceRegions.length <= 100); assert.ok(filter.workRegionGroups.every((group) => group.length <= 500));
  }
  assert.equal(JSON.stringify(catalog), before);
  guangdong.workRegionGroups[0]!.push("mutated external result");
  assert.ok(!buildChinaRegionFilter({ provinceCode: "44" }).workRegionGroups[0]!.includes("mutated external result"));
});

test("city text reference mapping preserves the disclosed location, requires CN, and never promotes a district alone into a city", () => {
  const location = { countryCode: "CN", raw: "广东省深圳市南山区科技园", city: "深圳", regionId: undefined };
  const before = JSON.stringify(location);
  const matches = matchDisclosedChinaCities(location);
  assert.equal(matches.length, 1); assert.equal(matches[0]!.province.mapId, "CN-GD"); assert.equal(matches[0]!.city.code, "4403");
  assert.equal(matches[0]!.matchedField, "city"); assert.equal(matches[0]!.method, "disclosed-text-catalog-reference");
  assert.equal(JSON.stringify(location), before);
  assert.deepEqual(matchDisclosedChinaCities({ raw: location.raw }), []);
  assert.deepEqual(matchDisclosedChinaCities({ ...location, countryCode: "US" }), []);
  assert.deepEqual(matchDisclosedChinaCities({ countryCode: "CN", raw: "南山区" }), []);
});

test("actual shared query matches province-only city disclosures while selected district needs city and district on one location", async () => {
  const data = createAtlasDemo();
  const provinceFilter = buildChinaRegionFilter({ provinceCode: "44" });
  const provinceResult = await queryJobs(data, { workCountryCodes: provinceFilter.workCountryCodes, workRegionGroups: provinceFilter.workRegionGroups });
  assert.deepEqual(provinceResult.items.map((item) => item.job.id).sort(), ["demo-2", "demo-8"]);
  const rows = [
    { countryCode: "CN", raw: "深圳市南山区科技园", city: undefined },
    { countryCode: "CN", raw: "深圳", city: "深圳" },
    { countryCode: "CN", raw: "黑龙江省鹤岗市南山区", city: "鹤岗市" },
    { countryCode: "CN", raw: "深圳市福田区", city: "深圳" },
    { countryCode: "US", raw: "深圳市南山区", city: "深圳" },
    { countryCode: "CN", raw: "深圳", city: "深圳" },
    { countryCode: "CN", raw: "南山区", city: undefined },
  ];
  rows.forEach((row, i) => Object.assign(data.locations[i]!, row, { regionId: undefined }));
  const extra = { ...data.locations[2]!, id: "crossed-other-city" }; data.locations.push(extra); data.jobs[5]!.locationIds.push(extra.id);
  const before = JSON.stringify(data);
  const filter = buildChinaRegionFilter({ provinceCode: "44", cityCode: "4403", districtCode: "440305" });
  const result = await queryJobs(data, { workCountryCodes: filter.workCountryCodes, workRegionGroups: filter.workRegionGroups });
  assert.deepEqual(result.items.map((item) => item.job.id), ["demo-0"]);
  assert.equal(JSON.stringify(data), before);
});

test("Chongqing municipality district and county groups require their own disclosed names on the same office", async () => {
  const data = createAtlasDemo();
  data.locations.forEach((location) => { delete location.coordinates; });
  const rows = [
    { countryCode: "CN", raw: "重庆市渝北区", city: "重庆", regionId: "CN-CQ" },
    { countryCode: "CN", raw: "重庆市云阳县", city: "重庆", regionId: "CN-CQ" },
    { countryCode: "CN", raw: "重庆", city: "重庆", regionId: undefined },
    { countryCode: "CN", raw: "浙江省宁波市江北区", city: "宁波", regionId: "CN-ZJ" },
    { countryCode: "US", raw: "重庆市云阳县", city: "重庆", regionId: "CN-CQ" },
    { countryCode: "CN", raw: "重庆", city: "重庆", regionId: undefined },
  ];
  rows.forEach((row, index) => Object.assign(data.locations[index]!, row));
  const crossed = { ...data.locations[3]!, id: "chongqing-crossed-district" };
  data.locations.push(crossed); data.jobs[5]!.locationIds.push(crossed.id);
  const before = JSON.stringify(data);
  const query = async (cityCode?: string, districtCode?: string) => {
    const filter = buildChinaRegionFilter({ provinceCode: "50", cityCode, districtCode });
    return queryJobs(data, { workCountryCodes: filter.workCountryCodes, workRegionGroups: filter.workRegionGroups });
  };
  const province = await query();
  assert.deepEqual(province.items.map((item) => item.job.id).sort(), ["demo-0", "demo-1", "demo-2", "demo-5"]);
  for (const [code, expected, label] of [["5001", "demo-0", "重庆市 · 市辖区"], ["5002", "demo-1", "重庆市 · 县"]] as const) {
    const result = await query(code);
    assert.deepEqual(result.items.map((item) => item.job.id), [expected]);
    assert.equal(result.mappedJobs, 0); assert.equal(result.unlocatedJobs, 1);
    const filter = buildChinaRegionFilter({ provinceCode: "50", cityCode: code });
    assert.equal(filter.selectedCity!.label, label);
    assert.ok(!filter.workRegionGroups[1]!.includes("重庆"));
    assert.ok(filter.sourceRegions.length <= 100);
  }
  const county = await query("5002", "500235");
  assert.deepEqual(county.items.map((item) => item.job.id), ["demo-1"]);
  assert.deepEqual(matchDisclosedChinaCities({ countryCode: "CN", raw: "重庆" }), [], "a city-only disclosure cannot establish one statistical subdivision group");
  assert.ok(!matchDisclosedChinaCities(data.locations[3]!).some((match) => match.province.code === "50"), "a same-name district in Ningbo never establishes Chongqing");
  assert.deepEqual(matchDisclosedChinaCities(data.locations[1]!).map((match) => match.city.code), ["5002"]);
  assert.equal(JSON.stringify(data), before);
});

test("versioned finite English aliases stay bound to the pinned catalog and omit ambiguous bare city spellings from province expansion", () => {
  assert.equal(textAliases.schemaVersion, 1); assert.equal(textAliases.catalogDatasetId, manifest.datasetId);
  assert.match(textAliases.revision, /^\d{4}-\d{2}-\d{2}\.\d+$/);
  assert.equal(textAliases.provinces.length, 31);
  for (const entry of textAliases.provinces) {
    assert.ok(catalog.some(node => node.code === entry.code && node.name === entry.name));
    const filter = buildChinaRegionFilter({ provinceCode: entry.code });
    for (const alias of entry.aliases) {
      assert.ok(filter.workRegionGroups[0]!.includes(alias)); assert.ok(filter.sourceRegions.includes(alias));
    }
  }
  for (const entry of textAliases.cities) {
    assert.ok(catalog.some(province => province.code === entry.provinceCode && province.children.some(city => city.code === entry.code && city.name === entry.name)));
    const filter = buildChinaRegionFilter({ provinceCode: entry.provinceCode, cityCode: entry.code });
    for (const alias of [...entry.aliases, ...entry.parentRequiredAliases]) {
      assert.ok(filter.workRegionGroups[1]!.includes(alias)); assert.ok(filter.sourceRegions.includes(alias));
    }
    for (const alias of entry.parentRequiredAliases) assert.equal(filter.workRegionGroups[0]!.includes(alias), false);
  }
  const jilin = buildChinaRegionFilter({ provinceCode: "22", cityCode: "2202" });
  assert.equal(jilin.workRegionGroups[1]!.includes("Jilin"), false);
  assert.ok(jilin.workRegionGroups[1]!.includes("Jilin City"));
  assert.equal(buildChinaRegionFilter({ provinceCode: "61", cityCode: "6101" }).workRegionGroups[1]!.includes("Xian"), false);
  assert.equal(buildChinaRegionFilter({ provinceCode: "46" }).workRegionGroups[0]!.includes("Hainan"), false);
  assert.doesNotMatch(JSON.stringify(textAliases), /"(?:coordinates|latitude|longitude|jobs)"/);
});

test("English Suzhou acquisition and actual index queries agree while Jiangsu and Anhui need province evidence on the same location", async () => {
  const suzhou = buildChinaRegionFilter({ provinceCode: "32", cityCode: "3205" });
  const source = SourceJobRecordSchema.parse({
    entityType: "job-posting", sourceRecordId: "synthetic-suzhou", title: "Synthetic .NET Engineer", companyName: "Synthetic Employer",
    locations: [{ raw: "Suzhou, Jiangsu, China", city: "Suzhou", region: "Jiangsu", countryCode: "CN" }],
    compensations: [], workMode: "unknown", employmentType: "unknown", remoteEligibleRegions: [], availability: "unknown", completeness: "excerpt", evidence: [], warnings: [],
  });
  assert.equal(assessSourceScopeMatch(source, { roles: [".NET"], regions: suzhou.sourceRegions, companyNames: [], countryCodes: suzhou.workCountryCodes }).status, "matched");
  const data = createAtlasDemo();
  data.locations.forEach(location => { delete location.coordinates; Object.assign(location, { countryCode: "US", raw: "Unrelated", city: undefined, region: undefined, regionId: undefined }); });
  const rows = [
    { countryCode: "CN", raw: source.locations[0]!.raw, city: "Suzhou", region: "Jiangsu" },
    { countryCode: "CN", raw: "SUZHOU, ANHUI", city: "SUZHOU", region: "ANHUI" },
    { countryCode: "CN", raw: "Suzhou", city: "Suzhou" },
    { countryCode: "CN", raw: "Suzhou", city: "Suzhou", regionId: "CN-JS" },
    { countryCode: "CN", raw: "苏州市", city: "苏州" },
    { countryCode: "CN", raw: "Jiangsu" },
    { countryCode: "US", raw: "Suzhou, Jiangsu", city: "Suzhou", region: "Jiangsu" },
  ];
  rows.forEach((row, index) => Object.assign(data.locations[index]!, row));
  const otherOffice = { ...data.locations[1]!, id: "synthetic-other-office" }; data.locations.push(otherOffice); data.jobs[5]!.locationIds.push(otherOffice.id);
  const before = JSON.stringify(data);
  const query = async (provinceCode: string, cityCode?: string) => {
    const filter = buildChinaRegionFilter({ provinceCode, cityCode });
    return queryJobs(data, { workCountryCodes: filter.workCountryCodes, workRegionGroups: filter.workRegionGroups });
  };
  const result = await query("32", "3205");
  assert.deepEqual(result.items.map(item => item.job.id).sort(), ["demo-0", "demo-3", "demo-4"]);
  assert.equal(result.mappedJobs, 0); assert.equal(result.unlocatedJobs, 3);
  assert.deepEqual((await query("34", "3413")).items.map(item => item.job.id).sort(), ["demo-1", "demo-5"]);
  const province = await query("32");
  assert.deepEqual(province.items.map(item => item.job.id).sort(), ["demo-0", "demo-3", "demo-4", "demo-5"]);
  assert.equal(JSON.stringify(data), before);
});

test("finite English city reference matches require CN and disambiguate shared spellings without changing disclosures", () => {
  const cases = [
    [{ countryCode: "CN", city: "Suzhou", region: "Jiangsu", raw: "Suzhou, Jiangsu, China" }, ["3205"]],
    [{ countryCode: "CN", city: "SUZHOU", region: "ANHUI", raw: "SUZHOU, ANHUI" }, ["3413"]],
    [{ countryCode: "CN", city: "Suzhou", raw: "Suzhou" }, []],
    [{ countryCode: "CN", city: "Suzhou", raw: "Suzhou", regionId: "CN-JS" }, ["3205"]],
    [{ countryCode: "CN", city: "Changchun", region: "Jilin", raw: "Changchun, Jilin, China" }, []],
    [{ countryCode: "CN", city: "Jilin City", region: "Jilin", raw: "Jilin City, Jilin" }, ["2202"]],
    [{ countryCode: "CN", city: "Hangzhou", region: "Zhejiang", raw: "Hangzhou, Zhejiang" }, ["3301"]],
    [{ countryCode: "CN", city: "Changzhou", region: "Jiangsu", raw: "Changzhou, Jiangsu" }, []],
    [{ countryCode: "CN", city: "Nanjing County", region: "Fujian", raw: "Nanjing County, Fujian" }, []],
    [{ countryCode: "CN", city: "Xi'an", region: "Shaanxi", raw: "Xi'an, Shaanxi" }, ["6101"]],
    [{ countryCode: "CN", city: "Xianyang", region: "Shaanxi", raw: "Xianyang, Shaanxi" }, []],
    [{ countryCode: "CN", city: "Shanghai", raw: "Shanghai, China" }, ["3101"]],
    [{ countryCode: "US", city: "Suzhou", region: "Jiangsu", raw: "Suzhou, Jiangsu" }, []],
  ] as const;
  for (const [location, expected] of cases) {
    const before = JSON.stringify(location);
    assert.deepEqual(matchDisclosedChinaCities(location).map(match => match.city.code), expected, before);
    assert.equal(JSON.stringify(location), before);
  }
});

test("shared index query distinguishes Jilin province from its city and requires English parent province evidence for ambiguous city names", async () => {
  const data = createAtlasDemo();
  data.locations.forEach(location => { delete location.coordinates; Object.assign(location, { countryCode: "US", raw: "Unrelated", city: undefined, region: undefined, regionId: undefined }); });
  const rows = [
    { raw: "Changchun, Jilin, China", city: "Changchun", region: "Jilin" },
    { raw: "Jilin City, Jilin, China", city: "Jilin City", region: "Jilin" },
    { raw: "Hangzhou, Zhejiang", city: "Hangzhou", region: "Zhejiang" },
    { raw: "Changzhou, Jiangsu", city: "Changzhou", region: "Jiangsu" },
    { raw: "Nanjing County, Fujian", city: "Nanjing County", region: "Fujian" },
    { raw: "Nanjing, Jiangsu", city: "Nanjing", region: "Jiangsu" },
    { raw: "Xi'an, Shaanxi", city: "Xi'an", region: "Shaanxi" },
    { raw: "Xianyang, Shaanxi", city: "Xianyang", region: "Shaanxi" },
  ];
  rows.forEach((row, index) => Object.assign(data.locations[index]!, row, { countryCode: "CN" }));
  for (const [provinceCode, cityCode, expected] of [["22", undefined, ["demo-0", "demo-1"]], ["22", "2202", ["demo-1"]], ["33", "3301", ["demo-2"]], ["32", "3201", ["demo-5"]], ["61", "6101", ["demo-6"]]] as const) {
    const filter = buildChinaRegionFilter({ provinceCode, cityCode });
    const result = await queryJobs(data, { workCountryCodes: filter.workCountryCodes, workRegionGroups: filter.workRegionGroups });
    assert.deepEqual(result.items.map(item => item.job.id).sort(), expected);
  }
});
