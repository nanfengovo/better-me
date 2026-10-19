import assert from "node:assert/strict";
import test from "node:test";
import { OfficeAddressCandidatesInputSchema, ToolError, type JobLocation, type ToolHandlerContext } from "@better-me/opportunities";
import type { SourceTransport } from "@better-me/source-adapters";
import { createNominatimOfficeProvider, parseNominatimOfficeCandidates } from "../src/office-address-provider.js";

const location: JobLocation = { id: "synthetic-precision-location", kind: "office", raw: "PRIVATE_SOURCE_LOCATION", countryCode: "US",
  city: "PRIVATE_SOURCE_CITY", postalCode: "PRIVATE_SOURCE_POSTAL", precision: "unknown", verification: "unverified", evidence: [] };
const address = { country_code: "us", road: "Synthetic Road", house_number: "10", city: "Synthetic City", postcode: "00123" };
const row = (value: Record<string, string> = address) => ({ place_rank: 30, osm_type: "way", osm_id: 1234, lat: "42.1", lon: "-71.1",
  display_name: "10 Synthetic Road, Synthetic City, USA", category: "building", address: value });
const target = { jobId: "synthetic-job", locationId: location.id, expectedRevision: 1 };
const error = (code: string) => (value: unknown) => value instanceof ToolError && value.code === code;
function context(controller = new AbortController()): ToolHandlerContext {
  return { requestId: "synthetic-precision-request", actorScope: "synthetic-owner", signal: controller.signal,
    budget: { requests: 1, bytes: 100_000, timeoutMs: 1000 }, consumeRequests() {}, consumeBytes() {},
    throwIfCancelled() { if (controller.signal.aborted) throw new ToolError("cancelled"); } };
}
function transport() {
  const calls: Parameters<SourceTransport["request"]>[0][] = [];
  const value: SourceTransport = { async request(input) { calls.push(input); return { url: input.url, status: 200, headers: { "content-type": "application/json" }, text: JSON.stringify([row()]) }; } };
  return { calls, value };
}

test("explicit lookup constraints require a query and strictly accept bounded plain text only", () => {
  assert.deepEqual(OfficeAddressCandidatesInputSchema.parse(target), target);
  const valid = { ...target, query: "10 Synthetic Road", locality: " Synthetic City ", postalCode: " 00123 " };
  assert.deepEqual(OfficeAddressCandidatesInputSchema.parse(valid), { ...valid, locality: "Synthetic City", postalCode: "00123" });
  for (const bad of [
    { ...target, locality: "Synthetic City" }, { ...target, postalCode: "00123" }, { ...target, locality: "Synthetic City", query: " " },
    { ...valid, locality: "" }, { ...valid, locality: " " }, { ...valid, locality: "x".repeat(201) }, { ...valid, locality: "\nSynthetic City" },
    { ...valid, locality: "Synthetic\u0000City" }, { ...valid, locality: "\ud800" }, { ...valid, locality: 123 },
    { ...valid, postalCode: "" }, { ...valid, postalCode: "x".repeat(101) }, { ...valid, postalCode: "00123\r" }, { ...valid, postalCode: 123 },
    { ...valid, query: "\n10 Synthetic Road" },
    { ...valid, countryCode: "CA" }, { ...valid, endpoint: "https://untrusted.example.test/" },
  ]) assert.equal(OfficeAddressCandidatesInputSchema.safeParse(bad).success, false, JSON.stringify(bad));
});

test("locality is matched only against disclosed settlement fields; state or county names cannot prove a city", () => {
  for (const field of ["city", "town", "village", "municipality"]) {
    const { city: _city, ...withoutCity } = address;
    const candidates = parseNominatimOfficeCandidates([row({ ...withoutCity, [field]: "Synthetic City" })], "US", { locality: " synthetic city " });
    assert.equal(candidates.length, 1, field);
    assert.equal(candidates[0]!.verification, "unverified"); assert.equal(candidates[0]!.estimated, true);
    assert.equal(candidates[0]!.proposal.basis, "manual-user-confirmation");
  }
  for (const field of ["state", "county", "state_district", "city_district", "district", "suburb", "neighbourhood"]) {
    assert.deepEqual(parseNominatimOfficeCandidates([row({ ...address, city: "Another City", [field]: "Synthetic City" })], "US", { locality: "Synthetic City" }), [], field);
  }
  const { city: _city, ...withoutCity } = address;
  assert.deepEqual(parseNominatimOfficeCandidates([row(withoutCity)], "US", { locality: "Synthetic City" }), []);
  for (const locality of ["Synthetic", "Synthetic City North", "合成市", "Synthetic-City"]) {
    assert.deepEqual(parseNominatimOfficeCandidates([row()], "US", { locality }), []);
  }
});

test("the same-state wrong-city landmark failure is rejected instead of becoming a precise office match", () => {
  // Synthetic reproductions of the mismatch shape, not the real public response or a real employer address.
  for (const city of ["Greenport", "Watervliet", "Pelham"]) {
    const candidate = row({ ...address, road: "Fifth Avenue", house_number: "350", city, state: "New York", "ISO3166-2-lvl4": "US-NY" });
    assert.equal(parseNominatimOfficeCandidates([candidate], "US").length, 1, "Legacy unconstrained parser stays compatible.");
    assert.deepEqual(parseNominatimOfficeCandidates([candidate], "US", { locality: "New York" }), []);
  }
});

test("postal comparison keeps leading zeroes and accepts only spacing, hyphen and case differences", () => {
  assert.equal(parseNominatimOfficeCandidates([row()], "US", { postalCode: "00-1 23" }).length, 1);
  assert.equal(parseNominatimOfficeCandidates([row({ ...address, postcode: "Ab-0 12" })], "US", { postalCode: "aB012" }).length, 1);
  for (const postalCode of ["123", "000123", "00123-0000", "0012", "OO123", "001.23"]) {
    assert.deepEqual(parseNominatimOfficeCandidates([row()], "US", { postalCode }), [], postalCode);
  }
  const { postcode: _postcode, ...withoutPostcode } = address;
  assert.deepEqual(parseNominatimOfficeCandidates([row(withoutPostcode)], "US", { postalCode: "00123" }), []);
  assert.deepEqual(parseNominatimOfficeCandidates([row()], "US", { locality: "Another City", postalCode: "00123" }), []);
  assert.deepEqual(parseNominatimOfficeCandidates([row()], "US", { locality: "Synthetic City", postalCode: "123" }), []);
});

test("constrained Nominatim requests use encoded structured parameters without mixing q or source city/postcode", async () => {
  for (const constraints of [{ locality: "Synthetic City" }, { postalCode: "00123" }, { locality: "Synthetic City", postalCode: "00123" }]) {
    const fake = transport(), provider = createNominatimOfficeProvider(fake.value, { now: () => 0 });
    const query = "10 Synthetic Road &city=Wrong&url=https://untrusted.example.test/";
    const candidates = await provider.search({ query, location, ...constraints }, context());
    const url = new URL(fake.calls[0]!.url);
    assert.equal(candidates.length, 1); assert.equal(url.origin, "https://nominatim.openstreetmap.org"); assert.equal(url.pathname, "/search");
    assert.equal(url.searchParams.has("q"), false); assert.equal(url.searchParams.get("street"), query);
    assert.equal(url.searchParams.get("city"), "locality" in constraints ? constraints.locality : null);
    assert.equal(url.searchParams.get("postalcode"), "postalCode" in constraints ? constraints.postalCode : null);
    assert.equal(url.searchParams.get("countrycodes"), "us"); assert.equal(url.searchParams.get("limit"), "5");
    assert.doesNotMatch(url.toString(), /PRIVATE_/);
  }
});

test("unconstrained legacy queries retain q and never infer source locality or postcode", async () => {
  const fake = transport(), provider = createNominatimOfficeProvider(fake.value, { now: () => 0 });
  assert.equal((await provider.search({ query: "10 Synthetic Road", location }, context())).length, 1);
  const url = new URL(fake.calls[0]!.url);
  assert.equal(url.searchParams.get("q"), "10 Synthetic Road");
  for (const field of ["street", "city", "postalcode"]) assert.equal(url.searchParams.has(field), false);
  assert.doesNotMatch(url.toString(), /PRIVATE_/);
});

test("same query with different explicit constraints never shares cached candidates or empty results", async () => {
  let now = 0; const fake = transport(), provider = createNominatimOfficeProvider(fake.value, { now: () => now });
  const input = { query: "10 Synthetic Road", location };
  const lookups = [{}, { locality: "Synthetic City" }, { locality: "Another City" }, { postalCode: "00123" }, { postalCode: "123" }, { locality: "Synthetic City", postalCode: "00123" }];
  for (const [index, constraints] of lookups.entries()) {
    now = index * 2000;
    const result = await provider.search({ ...input, ...constraints }, context());
    assert.equal(result.length, index === 2 || index === 4 ? 0 : 1);
    assert.equal(fake.calls.length, index + 1);
  }
  for (const [index, constraints] of lookups.entries()) {
    const result = await provider.search({ ...input, ...constraints }, context());
    assert.equal(result.length, index === 2 || index === 4 ? 0 : 1); assert.equal(fake.calls.length, lookups.length);
  }
});

test("invalid direct-provider constraints fail before transport, including control characters trimmed at the edges", async () => {
  const fake = transport(), provider = createNominatimOfficeProvider(fake.value, { now: () => 0 });
  for (const constraints of [
    { locality: "" }, { locality: "x".repeat(201) }, { locality: "\nSynthetic City" }, { locality: 123 },
    { postalCode: "" }, { postalCode: "x".repeat(101) }, { postalCode: "00123\r" }, { postalCode: 123 },
  ]) await assert.rejects(provider.search({ query: "10 Synthetic Road", location, ...constraints } as never, context()), error("invalid-input"));
  assert.equal(fake.calls.length, 0);
  assert.throws(() => parseNominatimOfficeCandidates([row()], "US", { locality: "" }), error("invalid-input"));
  assert.throws(() => parseNominatimOfficeCandidates([row()], "US", { postalCode: "00123", state: "New York" } as never), error("invalid-input"));
});

test("constrained lookup still obeys one-request throttling and cancellation; aborted replies are not cached", async () => {
  let now = 0, calls = 0; const abort = new AbortController();
  const provider = createNominatimOfficeProvider({ async request(input) { calls++; if (calls === 1) abort.abort(); return { url: input.url, status: 200, headers: {}, text: JSON.stringify([row()]) }; } }, { now: () => now });
  const input = { query: "10 Synthetic Road", location, locality: "Synthetic City", postalCode: "00123" };
  await assert.rejects(provider.search(input, context(abort)), error("cancelled"));
  await assert.rejects(provider.search({ ...input, postalCode: "123" }, context()), error("rate-limited")); assert.equal(calls, 1);
  now = 2000; assert.equal((await provider.search(input, context())).length, 1); assert.equal(calls, 2);
  const cachedAbort = new AbortController(); cachedAbort.abort();
  await assert.rejects(provider.search(input, context(cachedAbort)), error("cancelled")); assert.equal(calls, 2);
});
