import assert from "node:assert/strict";
import test from "node:test";
import { ToolError, type JobLocation, type ToolHandlerContext } from "@better-me/opportunities";
import { SourceTransportError, type SourceTransport } from "@better-me/source-adapters";
import { parseJobServiceArgs } from "../src/cli.js";
import { validateJobServiceConfig } from "../src/lifecycle.js";
import { createNominatimOfficeProvider, parseNominatimOfficeCandidates } from "../src/office-address-provider.js";

const location: JobLocation = { id: "synthetic-review-location", raw: "PRIVATE_SOURCE_LABEL_NEVER_SEND", streetAddress: "PRIVATE_SOURCE_STREET_NEVER_SEND", countryCode: "US", city: "PRIVATE_CITY_NEVER_SEND",
  coordinates: { latitude: 1, longitude: 2, coordinateSystem: "WGS84" }, kind: "office", precision: "address", evidence: [], verification: "unverified" };
const row = (changes: Record<string, unknown> = {}) => ({ place_rank: 30, osm_type: "way", osm_id: 1234, lat: "42.1", lon: "-71.1", display_name: "Synthetic Road 10, Synthetic City, USA",
  category: "building", address: { country_code: "us", road: "Synthetic Road", house_number: "10", postcode: "00123" }, ...changes });
const error = (expected: string) => (value: unknown) => value instanceof ToolError && value.code === expected;
function context(controller = new AbortController()): ToolHandlerContext {
  return { requestId: "synthetic-review-request", actorScope: "PRIVATE_OWNER_NEVER_SEND", budget: { requests: 3, bytes: 100_000, timeoutMs: 1000 }, signal: controller.signal,
    consumeRequests() {}, consumeBytes() {}, throwIfCancelled() { if (controller.signal.aborted) throw new ToolError("cancelled"); } };
}
function transport(response: unknown = [row()]) {
  const calls: Parameters<SourceTransport["request"]>[0][] = [];
  const value: SourceTransport = { async request(input) { calls.push(input); return { url: input.url, status: 200, headers: { "content-type": "application/json" }, text: JSON.stringify(response) }; } };
  return { calls, value };
}

test("review: city, road, postcode and boundaries cannot become office address candidates", () => {
  for (const value of [row({ place_rank: 16 }), row({ place_rank: 26 }), row({ category: "place" }), row({ category: "highway" }), row({ category: "boundary" }),
    row({ address: { country_code: "us", road: "Synthetic Road" } }), row({ address: { country_code: "us", house_number: "10" } }),
    row({ address: { country_code: "us", postcode: "00123" } }), row({ lat: "NaN" }), row({ lon: "181" }), row({ osm_type: "user" })]) {
    assert.deepEqual(parseNominatimOfficeCandidates([value], "US"), []);
  }
  const good = parseNominatimOfficeCandidates([row()], "US")[0]!;
  assert.equal(good.proposal.postalCode, "00123"); assert.equal(good.proposal.coordinateMeaning, "building");
  assert.equal(good.estimated, true); assert.equal(good.verification, "unverified"); assert.equal(good.evidenceUrl, "https://www.openstreetmap.org/way/1234");
});

test("review: a country filter never accepts another or unknown country and no-country queries retain disclosed country", () => {
  assert.deepEqual(parseNominatimOfficeCandidates([row()], "CN"), []);
  for (const country of ["xx", "eu", "", "USA"]) assert.deepEqual(parseNominatimOfficeCandidates([row({ address: { country_code: country, road: "Synthetic Road", house_number: "10" } })]), []);
  assert.equal(parseNominatimOfficeCandidates([row()])[0]!.proposal.countryCode, "US");
});

test("review: explicit input remains encoded on the fixed HTTPS endpoint and never transmits the source location or owner", async () => {
  const fake = transport(), provider = createNominatimOfficeProvider(fake.value, { now: () => 0 });
  const query = "10 Synthetic Road &url=https://untrusted.example.test/?secret=synthetic";
  await provider.search({ query, location }, context());
  const request = fake.calls[0]!, url = new URL(request.url);
  assert.equal(url.origin, "https://nominatim.openstreetmap.org"); assert.equal(url.pathname, "/search");
  assert.equal(url.searchParams.get("q"), query); assert.equal(url.searchParams.get("countrycodes"), "us"); assert.equal(url.searchParams.get("limit"), "5");
  assert.doesNotMatch(request.url, /PRIVATE_/); assert.deepEqual(request.headers, { accept: "application/json" });
  assert.deepEqual(request.source.endpointPolicy.allowedHosts, ["nominatim.openstreetmap.org"]); assert.equal(request.source.endpointPolicy.allowRedirects, false);
});

test("review: empty/control query, remote regions and cancellation fail before provider transport", async () => {
  const fake = transport(), provider = createNominatimOfficeProvider(fake.value, { now: () => 0 });
  for (const query of ["", " ", "10 Road\u0000secret", "x".repeat(2001)]) await assert.rejects(provider.search({ query, location }, context()), error("invalid-input"));
  await assert.rejects(provider.search({ query: "10 Road", location: { ...location, kind: "remote-region" } }, context()), error("invalid-input"));
  const abort = new AbortController(); abort.abort(); await assert.rejects(provider.search({ query: "10 Road", location }, context(abort)), error("cancelled"));
  assert.equal(fake.calls.length, 0);
});

test("review: cache is isolated by country, defensively cloned and expires without auto-refresh", async () => {
  let now = 0; const fake = transport(), provider = createNominatimOfficeProvider(fake.value, { now: () => now });
  const first = await provider.search({ query: "10 Road", location }, context()); first[0]!.proposal.streetAddress = "MUTATED_CALLER_VALUE";
  const second = await provider.search({ query: "10 Road", location }, context()); assert.notEqual(second[0]!.proposal.streetAddress, "MUTATED_CALLER_VALUE"); assert.equal(fake.calls.length, 1);
  now = 2000; assert.deepEqual(await provider.search({ query: "10 Road", location: { ...location, countryCode: "CN" } }, context()), []); assert.equal(fake.calls.length, 2);
  now = 900_000; await provider.search({ query: "10 Road", location }, context()); assert.equal(fake.calls.length, 3);
  const abort = new AbortController(); abort.abort(); await assert.rejects(provider.search({ query: "10 Road", location }, context(abort)), error("cancelled"));
});

test("review: office geocoding is disabled by default and explicit opt-in cannot install arbitrary endpoints", () => {
  const base = { dataDirectory: process.cwd(), allowedOrigins: ["http://localhost:5173"] };
  assert.equal(validateJobServiceConfig(base).officeGeocoder, undefined);
  const parsed = parseJobServiceArgs(["--data-dir", process.cwd(), "--origin", "http://localhost:5173"]);
  assert.ok(!parsed.help); assert.equal(parsed.config.officeGeocoder, undefined);
  assert.throws(() => validateJobServiceConfig({ ...base, officeGeocoder: { provider: "nominatim", endpoint: "https://untrusted.example.test" } as never }));
  assert.throws(() => parseJobServiceArgs(["--data-dir", process.cwd(), "--origin", "http://localhost:5173", "--office-geocoder", "untrusted"]));
  const photon = parseJobServiceArgs(["--data-dir", process.cwd(), "--origin", "http://localhost:5173", "--office-geocoder", "photon"]);
  assert.ok(!photon.help); if (!photon.help) assert.deepEqual(photon.config.officeGeocoder, { provider: "photon" });
  const amap = parseJobServiceArgs(["--data-dir", process.cwd(), "--origin", "http://localhost:5173", "--office-geocoder", "amap"]);
  assert.ok(!amap.help); if (!amap.help) assert.deepEqual(amap.config.officeGeocoder, { provider: "amap" });
});

test("review: controlled-transport auth failures preserve needs-auth semantics", async () => {
  for (const status of [401, 403]) {
    const provider = createNominatimOfficeProvider({ async request() { throw new SourceTransportError("http-error", status); } }, { now: () => 0 });
    await assert.rejects(provider.search({ query: "10 Road", location }, context()), error("needs-auth"));
  }
});

test("review: a slow request cannot open an immediate second external lookup after completion", async () => {
  let now = 0, calls = 0;
  const provider = createNominatimOfficeProvider({ async request(input) { calls++; now = 2000; return { url: input.url, status: 200, headers: {}, text: "[]" }; } }, { now: () => now });
  await provider.search({ query: "10 Road", location }, context());
  await assert.rejects(provider.search({ query: "20 Road", location }, context()), error("rate-limited"));
  assert.equal(calls, 1);
});

test("review: provider Retry-After is honored across a fresh explicit query", async () => {
  let now = 0, calls = 0;
  const provider = createNominatimOfficeProvider({ async request() { calls++; throw new SourceTransportError("rate-limited", 429, 60); } }, { now: () => now });
  await assert.rejects(provider.search({ query: "10 Road", location }, context()), error("rate-limited"));
  now = 1200; await assert.rejects(provider.search({ query: "20 Road", location }, context()), error("rate-limited"));
  assert.equal(calls, 1);
});

test("review: fixed transport and tool budget failures remain explicit and are never cached as empty success", async () => {
  for (const failure of [new ToolError("budget-exceeded"), new SourceTransportError("response-too-large"), new SourceTransportError("timeout"), new SourceTransportError("cancelled")]) {
    let now = 0, calls = 0;
    const provider = createNominatimOfficeProvider({ async request(input) { calls++; if (calls === 1) throw failure; return { url: input.url, status: 200, headers: {}, text: "[]" }; } }, { now: () => now });
    await assert.rejects(provider.search({ query: "10 Road", location }, context()), error(failure.code === "response-too-large" ? "budget-exceeded" : failure.code));
    now = 2000; assert.deepEqual(await provider.search({ query: "10 Road", location }, context()), []); assert.equal(calls, 2);
  }
});

test("review: malformed, oversized, wrong-MIME or redirected results cannot inject usable address candidates", async () => {
  for (const changes of [{ text: "broken JSON" }, { text: JSON.stringify(Array.from({ length: 6 }, () => row())) }, { text: "x".repeat(512 * 1024 + 1) },
    { headers: { "content-type": "text/html" } }, { url: "https://untrusted.example.test/private" }]) {
    const provider = createNominatimOfficeProvider({ async request(input) { return { url: input.url, status: 200, headers: {}, text: JSON.stringify([row()]), ...changes }; } }, { now: () => 0 });
    await assert.rejects(provider.search({ query: "10 Road", location }, context()), error("text" in changes && changes.text.length > 512 * 1024 ? "budget-exceeded" : "source-changed"));
  }
});
