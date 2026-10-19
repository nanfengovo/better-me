import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PlatformDetailLocationsSchema, PlatformVisibleOfficeDisclosureSchema, parsePlatformJobLocations, parsePlatformVisibleOfficeDisclosure, parsePlatformVisibleOfficeLocations, rebindPlatformDetailLocations } from "../src/platform-detail-locations.js";

const address = { "@type": "Place", address: { "@type": "PostalAddress", streetAddress: "100 Synthetic Road", addressLocality: "Test City", addressRegion: "Test Region", postalCode: "00101", addressCountry: "us" } };
const at = "2026-10-19T09:00:00Z";
function capture() { return { version: 1, provider: "liepin", url: "https://www.liepin.com/job/12345.shtml", capturedAt: at, ...parsePlatformJobLocations({ jobLocation: address }) }; }

test("the Vite server contract loads through its standalone subpath in native Node without a TS loader", () => {
  const runtimeEnvironment = { ...process.env }; delete runtimeEnvironment.NODE_OPTIONS;
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", `
    import { PlatformDetailLocationsSchema, PlatformVisibleOfficeDisclosureSchema, parsePlatformJobLocations, parsePlatformVisibleOfficeLocations } from '@better-me/source-adapters/platform-detail-locations';
    import { reviewedCardIdentity, PlatformSearchProviderSchema } from '@better-me/source-adapters/platform-job-identity';
    import { PlatformSearchProviderSchema as searchProvider } from '@better-me/source-adapters/platform-search';
    const locations = parsePlatformJobLocations({ jobLocation: { address: { addressCountry: 'CN', addressLocality: 'Shanghai' } } });
    console.log(JSON.stringify({ sameSchema: PlatformSearchProviderSchema === searchProvider, id: reviewedCardIdentity('https://www.liepin.com/job/12345.shtml', 'liepin')?.id,
      valid: PlatformDetailLocationsSchema.safeParse({ version: 1, provider: 'liepin', url: 'https://www.liepin.com/job/12345.shtml', capturedAt: '2026-10-19T09:00:00Z', ...locations }).success,
      visible: PlatformDetailLocationsSchema.safeParse({ version: 2, provider: 'liepin', url: 'https://www.liepin.com/job/12345.shtml', capturedAt: '2026-10-19T09:00:00Z', ...parsePlatformVisibleOfficeLocations([PlatformVisibleOfficeDisclosureSchema.parse({selector:'liepin-work-address',label:'工作地址',text:'合成路100号'})]) }).success }));
  `], { cwd: fileURLToPath(new URL("../", import.meta.url)), env: runtimeEnvironment, encoding: "utf8" });
  assert.deepEqual(JSON.parse(output), { sameSchema: true, id: "12345", valid: true, visible: true });
});

const visibleAddress = { selector: "liepin-work-address", label: "工作地址", text: "上海市浦东新区合成路100号 2号楼" };
function visibleCapture() { return { version: 2, provider: "liepin", url: "https://www.liepin.com/job/12345.shtml", capturedAt: at, ...parsePlatformVisibleOfficeLocations([visibleAddress]) }; }

test("version 2 visible address evidence preserves the complete labelled text without guessing administrative fields", () => {
  const parsed = PlatformDetailLocationsSchema.parse(visibleCapture());
  assert.deepEqual(parsed.locations, [{ raw: visibleAddress.text, streetAddress: visibleAddress.text,
    evidence: { kind: "visible-labelled-address", selector: "liepin-work-address[0]", quote: JSON.stringify(visibleAddress) } }]);
  assert.equal(parsed.workMode, "unknown");
  assert.equal(parsed.workModeEvidence, undefined);
  const reordered = { text: visibleAddress.text, label: "工作地址", selector: "liepin-work-address" };
  assert.equal(parsePlatformVisibleOfficeDisclosure(reordered)?.evidence.quote, JSON.stringify(visibleAddress));
  assert.equal(rebindPlatformDetailLocations(parsed, "https://m.liepin.com/job/12345.shtml?from=share", at)?.version, 2);
});

test("visible region, city, park and unnumbered building names remain raw disclosures without street precision", () => {
  for (const raw of ["上海", "上海 浦东新区", "张江高科技园区", "合成大厦", "上海市合成路", "合成路口附近", "合成园区", "10号楼", "中国 上海"]) {
    const parsed = parsePlatformVisibleOfficeDisclosure({ ...visibleAddress, text: raw });
    assert.ok(parsed, raw); assert.equal(parsed.streetAddress, undefined, raw);
    assert.equal(parsed.raw, raw); assert.equal(parsed.countryCode, undefined); assert.equal(parsed.region, undefined); assert.equal(parsed.city, undefined);
  }
  for (const raw of ["合成路100号", "合成街18号", "合成大道300号", "合成路100弄8号", "合成大厦A座1601室", "合成科技园10号楼", "合成写字楼2栋"]) {
    assert.equal(parsePlatformVisibleOfficeDisclosure({ ...visibleAddress, text: raw })?.streetAddress, raw, raw);
  }
});

test("explicit remote, home, no-attendance and reference-only headquarters disclosures never become office captures", () => {
  for (const raw of ["完全远程，无需到岗，上海合成路100号为总部", "无需到岗，上海合成路100号", "无须到场，合成路100号", "远程办公，合成路100号", "居家办公，合成路100号", "在家工作，合成路100号", "仅供参考的总部地址：上海合成路100号", "注册地址：上海合成路100号", "非本岗位办公地址：上海合成路100号", "不作为工作地点：上海合成路100号"]) {
    const disclosure = { ...visibleAddress, text: raw };
    assert.equal(PlatformVisibleOfficeDisclosureSchema.safeParse(disclosure).success, true);
    assert.equal(parsePlatformVisibleOfficeDisclosure(disclosure), undefined, raw);
    assert.equal(parsePlatformVisibleOfficeLocations([disclosure]), undefined, raw);
    const ordinary = parsePlatformVisibleOfficeDisclosure(visibleAddress)!;
    assert.equal(PlatformDetailLocationsSchema.safeParse({ ...visibleCapture(), locations: [{ ...ordinary, raw, streetAddress: raw,
      evidence: { ...ordinary.evidence, quote: JSON.stringify(disclosure) } }] }).success, false, raw);
  }
  for (const raw of ["总部工作，上海合成路100号", "上海合成路100号 总部办公室", "上海远程科技大厦A座1601室"]) {
    assert.equal(parsePlatformVisibleOfficeDisclosure({ ...visibleAddress, text: raw })?.streetAddress, raw, raw);
  }
});

test("visible wire evidence cannot change raw, street, inferred administration, label, selector or quote independently", () => {
  const original = PlatformDetailLocationsSchema.parse(visibleCapture()), location = original.locations[0];
  for (const patch of [{ raw: "其他路100号" }, { streetAddress: "其他路100号" }, { streetAddress: undefined }, { countryCode: "CN" }, { region: "上海" }, { city: "上海" }, { postalCode: "200000" }, { coordinates: { latitude: 30, longitude: 120 } },
    { evidence: { ...location.evidence, kind: undefined } }, { evidence: { ...location.evidence, kind: "json-ld" } },
    { evidence: { ...location.evidence, selector: "liepin-work-address" } }, { evidence: { ...location.evidence, selector: "liepin-work-address[1]" } },
    { evidence: { ...location.evidence, quote: JSON.stringify({ ...visibleAddress, label: "公司地址" }) } },
    { evidence: { ...location.evidence, quote: JSON.stringify({ ...visibleAddress, selector: "other" }) } },
    { evidence: { ...location.evidence, quote: JSON.stringify({ ...visibleAddress, text: "其他路100号" }) } },
    { evidence: { ...location.evidence, quote: JSON.stringify(visibleAddress, undefined, 2) } },
    { evidence: { ...location.evidence, quote: "{}" } }, { evidence: { ...location.evidence, quote: "invalid" } }]) {
    assert.equal(PlatformDetailLocationsSchema.safeParse({ ...original, locations: [{ ...location, ...patch }] }).success, false, JSON.stringify(patch));
  }
  const changedLabel = { ...visibleAddress, label: "工作地点" };
  assert.equal(PlatformDetailLocationsSchema.safeParse({ ...original, locations: [{ ...location, evidence: { ...location.evidence, quote: JSON.stringify(changedLabel) } }] }).success, true);
});

test("visible evidence is restricted to a Liepin V2 capture and never mixed with JSON-LD locations", () => {
  assert.equal(PlatformDetailLocationsSchema.safeParse({ ...visibleCapture(), version: 1 }).success, false);
  assert.equal(PlatformDetailLocationsSchema.safeParse({ ...visibleCapture(), provider: "boss", url: "https://www.zhipin.com/job_detail/12345.html" }).success, false);
  const jsonLd = PlatformDetailLocationsSchema.parse(capture());
  assert.equal(PlatformDetailLocationsSchema.safeParse({ ...jsonLd, version: 2 }).success, true);
  assert.equal(PlatformDetailLocationsSchema.safeParse({ ...visibleCapture(), locations: [...jsonLd.locations, ...PlatformDetailLocationsSchema.parse(visibleCapture()).locations] }).success, false);
  for (const mode of ["onsite", "hybrid", "remote"]) assert.equal(PlatformDetailLocationsSchema.safeParse({ ...visibleCapture(), workMode: mode }).success, false);
});

test("visible disclosures require normalized bounded plain text, fixed labels, strict shape and contiguous bounded indices", () => {
  for (const disclosure of [{ ...visibleAddress, label: "地址" }, { ...visibleAddress, selector: "jobLocation" }, { ...visibleAddress, text: "" }, { ...visibleAddress, text: " 合成路100号" },
    { ...visibleAddress, text: "合成路  100号" }, { ...visibleAddress, text: "合成路\n100号" }, { ...visibleAddress, text: "合成路\u00a0100号" },
    { ...visibleAddress, text: "合成\u0000路100号" }, { ...visibleAddress, text: "合成路\ud800100号" }, { ...visibleAddress, text: "x".repeat(1001) }, { ...visibleAddress, city: "上海" },
    { ...visibleAddress, text: { text: "合成路100号" } }]) {
    assert.equal(PlatformVisibleOfficeDisclosureSchema.safeParse(disclosure).success, false, JSON.stringify(disclosure));
    assert.equal(parsePlatformVisibleOfficeDisclosure(disclosure), undefined);
    assert.equal(parsePlatformVisibleOfficeLocations([visibleAddress, disclosure]), undefined);
  }
  assert.equal(parsePlatformVisibleOfficeLocations([]), undefined);
  assert.equal(parsePlatformVisibleOfficeLocations(Array.from({ length: 21 }, () => visibleAddress)), undefined);
  for (const index of [-1, 20, 0.5, Number.NaN]) assert.equal(parsePlatformVisibleOfficeDisclosure(visibleAddress, index), undefined);
  const twenty = parsePlatformVisibleOfficeLocations(Array.from({ length: 20 }, () => visibleAddress));
  assert.equal(twenty?.locations[19].evidence.selector, "liepin-work-address[19]");
  assert.equal(PlatformDetailLocationsSchema.safeParse({ ...visibleCapture(), ...twenty }).success, true);
  const depthBomb: Record<string, unknown> = { ...visibleAddress }; depthBomb.extra = { nested: { nested: { nested: depthBomb } } };
  assert.equal(parsePlatformVisibleOfficeDisclosure(depthBomb), undefined);
});

test("platform detail location disclosure reproduces only explicit address fields and preserves leading-zero postcodes", () => {
  const actual = PlatformDetailLocationsSchema.parse(capture());
  assert.deepEqual(actual.locations[0], { raw: "100 Synthetic Road, Test City, Test Region, 00101, us", countryCode: "US", region: "Test Region", city: "Test City", streetAddress: "100 Synthetic Road", postalCode: "00101", evidence: { selector: "jobLocation[0]", quote: JSON.stringify(address) } });
  assert.equal(actual.workMode, "unknown");
  assert.equal(parsePlatformJobLocations({ jobLocation: { name: "Brand headquarters", geo: { latitude: 30, longitude: 120 } } }), undefined);
  const named = parsePlatformJobLocations({ jobLocation: { address: { addressCountry: "China", addressLocality: "Shanghai" } } });
  assert.equal(named?.locations[0].countryCode, undefined); assert.equal(named?.locations[0].raw, "Shanghai, China");
});

test("multiple locations keep each original JSON quote and a contiguous source selector", () => {
  const second = { "@type": "PostalAddress", addressCountry: { "@type": "Country", identifier: "CN", name: "China" }, addressLocality: "Shanghai", streetAddress: "200 Synthetic Road" };
  const parsed = parsePlatformJobLocations({ jobLocation: [address, second], baseSalary: { currency: "USD", value: 10000 } });
  assert.equal(parsed?.locations.length, 2); assert.equal(parsed?.locations[1].countryCode, "CN"); assert.equal(parsed?.locations[1].evidence.selector, "jobLocation[1]");
  assert.equal(parsed?.locations[1].evidence.quote, JSON.stringify(second));
  assert.ok(PlatformDetailLocationsSchema.safeParse({ ...capture(), ...parsed }).success);
});

test("remote work requires and preserves original jobLocationType evidence without constructing an office", () => {
  for (const jobLocationType of ["TELECOMMUTE", ["TELECOMMUTE"]]) {
    const parsed = parsePlatformJobLocations({ jobLocationType });
    assert.deepEqual(parsed, { locations: [], workMode: "remote", workModeEvidence: { selector: "jobLocationType", quote: JSON.stringify(jobLocationType) } });
    assert.ok(PlatformDetailLocationsSchema.safeParse({ ...capture(), ...parsed }).success);
  }
  assert.equal(PlatformDetailLocationsSchema.safeParse({ ...capture(), workMode: "remote" }).success, false);
  assert.equal(PlatformDetailLocationsSchema.safeParse({ ...capture(), workMode: "onsite" }).success, false);
  assert.equal(PlatformDetailLocationsSchema.safeParse({ ...capture(), workMode: "unknown", workModeEvidence: { selector: "jobLocationType", quote: '"TELECOMMUTE"' } }).success, false);
  assert.equal(parsePlatformJobLocations({ jobLocation: address, jobLocationType: ["TELECOMMUTE", 1] }), undefined);
  assert.equal(parsePlatformJobLocations({ jobLocation: address, jobLocationType: { name: "TELECOMMUTE" } }), undefined);
});

test("transport cannot change any extracted field, append coordinates, change evidence index or replace the quote", () => {
  const original = PlatformDetailLocationsSchema.parse(capture());
  for (const patch of [{ raw: "Different office" }, { countryCode: "CN" }, { city: "Another City" }, { region: "Another Region" }, { streetAddress: "Different Road" }, { postalCode: "99999" }, { coordinates: { latitude: 30, longitude: 120 } }, { evidence: { ...original.locations[0].evidence, selector: "jobLocation[1]" } }, { evidence: { ...original.locations[0].evidence, quote: "{}" } }, { evidence: { ...original.locations[0].evidence, quote: "invalid" } }]) {
    assert.equal(PlatformDetailLocationsSchema.safeParse({ ...original, locations: [{ ...original.locations[0], ...patch }] }).success, false, JSON.stringify(patch));
  }
});

test("malformed, oversized or control-character fields omit all locations instead of silently accepting a partial address", () => {
  for (const bad of [null, "free form address", { address: "guess this" }, { address: { addressLocality: 123 } }, { address: { addressCountry: { name: [] } } }, { address: { streetAddress: "x".repeat(1001) } }, { address: { addressLocality: "\nShanghai" } }, { address: { postalCode: "001\u0000101" } }, { address: { streetAddress: "\ud800" } }]) {
    assert.equal(parsePlatformJobLocations({ jobLocation: bad }), undefined);
    assert.equal(parsePlatformJobLocations({ jobLocation: [address, bad] }), undefined);
  }
  assert.equal(parsePlatformJobLocations({ jobLocation: Array.from({ length: 21 }, () => address) }), undefined);
  assert.equal(parsePlatformJobLocations({ jobLocation: { ...address, extra: "x".repeat(20_001) } }), undefined);
});

test("capture URL is an official single job with no ambiguous path, and rebinding only preserves the same platform job", () => {
  for (const url of ["https://www.liepin.com/zhaopin/", "https://www.liepin.com.invalid/job/12345.shtml", "https://user@www.liepin.com/job/12345.shtml", "http://www.liepin.com/job/12345.shtml", "https://www.liepin.com/job/12345.shtml#office", "https://www.liepin.com/x/../job/12345.shtml", "https://www.liepin.com/x/%2e%2e/job/12345.shtml"]) assert.equal(PlatformDetailLocationsSchema.safeParse({ ...capture(), url }).success, false, url);
  const parsed = PlatformDetailLocationsSchema.parse(capture());
  assert.equal(rebindPlatformDetailLocations(parsed, "https://m.liepin.com/job/12345.shtml?from=share", at)?.url, "https://m.liepin.com/job/12345.shtml?from=share");
  assert.equal(rebindPlatformDetailLocations(parsed, "https://www.liepin.com/job/98765.shtml", at), undefined);
  assert.equal(rebindPlatformDetailLocations(parsed, "https://www.zhipin.com/job_detail/12345.html", at), undefined);
  assert.equal(PlatformDetailLocationsSchema.safeParse({ ...parsed, capturedAt: "yesterday" }).success, false);
});
