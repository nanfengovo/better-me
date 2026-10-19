import assert from "node:assert/strict";
import test from "node:test";
import { PlatformDetailLocationsSchema, parsePlatformJobLocations, rebindPlatformDetailLocations } from "../src/platform-detail-locations.js";

const address = { "@type": "Place", address: { "@type": "PostalAddress", streetAddress: "100 Synthetic Road", addressLocality: "Test City", addressRegion: "Test Region", postalCode: "00101", addressCountry: "us" } };
const at = "2026-10-19T09:00:00Z";
function capture() { return { version: 1, provider: "liepin", url: "https://www.liepin.com/job/12345.shtml", capturedAt: at, ...parsePlatformJobLocations({ jobLocation: address }) }; }

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
