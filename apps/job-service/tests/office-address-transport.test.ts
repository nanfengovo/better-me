import assert from "node:assert/strict";
import test from "node:test";
import { ToolError, type JobLocation, type ToolHandlerContext } from "@better-me/opportunities";
import { createControlledSourceTransport, SourceTransportError, type SourceTransport } from "@better-me/source-adapters";
import { createNominatimOfficeProvider, parseNominatimOfficeCandidates } from "../src/office-address-provider.js";

const location: JobLocation = { id: "synthetic-policy-location", kind: "office", raw: "Synthetic source", countryCode: "US", precision: "unknown", verification: "unverified", evidence: [] };
const input = { query: "10 Synthetic Road, Synthetic City", location };
const row = { place_rank: 30, osm_type: "way", osm_id: 1234, lat: "42.1", lon: "-71.1", display_name: "10 Synthetic Road, Synthetic City, USA",
  category: "building", address: { country_code: "us", road: "Synthetic Road", house_number: "10", postcode: "00123" } };
function context() {
  const accounting = { requests: 0, bytes: 0 };
  const value: ToolHandlerContext = { requestId: "synthetic-policy-request", actorScope: "synthetic-policy", signal: new AbortController().signal, budget: { requests: 1, bytes: 100_000, timeoutMs: 1000 },
    consumeRequests(count = 1) { accounting.requests += count; if (accounting.requests > 1) throw new ToolError("budget-exceeded"); },
    consumeBytes(count) { accounting.bytes += count; if (accounting.bytes > 100_000) throw new ToolError("budget-exceeded"); },
    throwIfCancelled() {} };
  return { value, accounting };
}

test("fixed office provider policy passes the real controlled URL/DNS/budget transport with an offline pinned sender", async () => {
  let dnsCalls = 0, sends = 0;
  const payload = JSON.stringify([row]);
  const transport = createControlledSourceTransport({
    resolve: async hostname => { dnsCalls++; assert.equal(hostname, "nominatim.openstreetmap.org"); return [{ address: "8.8.8.8", family: 4 }]; },
    send: async request => {
      sends++;
      assert.equal(request.url.origin, "https://nominatim.openstreetmap.org"); assert.equal(request.url.pathname, "/search");
      assert.equal(request.url.searchParams.get("q"), input.query); assert.equal(request.url.searchParams.get("countrycodes"), "us");
      assert.equal(request.address.address, "8.8.8.8"); assert.match(request.headers["user-agent"]!, /BetterMe/);
      return { status: 200, headers: { "content-type": "application/json" }, body: (async function* () { yield new TextEncoder().encode(payload); })(), close() {} };
    },
  });
  const execution = context();
  const result = await createNominatimOfficeProvider(transport).search(input, execution.value);
  assert.equal(dnsCalls, 1); assert.equal(sends, 1); assert.equal(execution.accounting.requests, 1); assert.equal(execution.accounting.bytes, Buffer.byteLength(payload));
  assert.equal(result.length, 1); assert.equal(result[0]!.proposal.countryCode, "US"); assert.equal(result[0]!.verification, "unverified");
});

test("Nominatim place/house address points retain disclosed street evidence as manual unverified site candidates", () => {
  for (const classification of [{category: "place"}, {category: undefined, class: "place"}]) {
    const candidate = parseNominatimOfficeCandidates([{...row, ...classification, type: "house"}], "US")[0]!;
    assert.ok(candidate); assert.equal(candidate.proposal.streetAddress, "Synthetic Road 10"); assert.equal(candidate.proposal.coordinateMeaning, "site");
    assert.equal(candidate.proposal.basis, "manual-user-confirmation"); assert.equal(candidate.verification, "unverified"); assert.equal(candidate.estimated, true);
    assert.equal(candidate.evidenceUrl, "https://www.openstreetmap.org/way/1234");
  }
});

test("explicit structured address constraints retain the pinned transport policy and a single request budget", async () => {
  let sends = 0;
  const transport = createControlledSourceTransport({
    resolve: async hostname => { assert.equal(hostname, "nominatim.openstreetmap.org"); return [{ address: "8.8.8.8", family: 4 }]; },
    send: async request => {
      sends++; assert.equal(request.url.origin, "https://nominatim.openstreetmap.org"); assert.equal(request.url.pathname, "/search");
      assert.equal(request.url.searchParams.has("q"), false); assert.equal(request.url.searchParams.get("street"), "10 Synthetic Road");
      assert.equal(request.url.searchParams.get("city"), "Synthetic City"); assert.equal(request.url.searchParams.get("postalcode"), "00123");
      assert.equal(request.url.searchParams.get("countrycodes"), "us"); assert.equal(request.address.address, "8.8.8.8");
      return { status: 200, headers: { "content-type": "application/json" },
        body: (async function* () { yield new TextEncoder().encode(JSON.stringify([{ ...row, address: { ...row.address, city: "Synthetic City" } }])); })(), close() {} };
    },
  });
  const execution = context();
  const result = await createNominatimOfficeProvider(transport).search({ query: "10 Synthetic Road", location, locality: "Synthetic City", postalCode: "00123" }, execution.value);
  assert.equal(sends, 1); assert.equal(execution.accounting.requests, 1); assert.equal(result.length, 1); assert.equal(result[0]!.proposal.postalCode, "00123");
});

test("place/house support never admits areas, roads, postcodes, missing address evidence or foreign countries", () => {
  const house = {...row, category: "place", type: "house"};
  for (const change of [
    {place_rank: 16}, {place_rank: 26}, {type: "city"}, {type: "town"}, {type: "suburb"}, {type: "postcode"}, {type: "road"},
    {category: "boundary"}, {category: "highway"}, {address: {country_code: "us", road: "Synthetic Road"}},
    {address: {country_code: "us", house_number: "10"}}, {address: {country_code: "us", postcode: "00123"}},
    {address: {country_code: "xx", road: "Synthetic Road", house_number: "10"}},
    {address: {country_code: "ca", road: "Synthetic Road", house_number: "10"}}, {lat: "NaN"}, {lon: "181"},
  ]) assert.deepEqual(parseNominatimOfficeCandidates([{...house, ...change}], "US"), []);
});

test("controlled transport rejects a Fake-IP DNS answer before any pinned send, without a fallback or retry", async () => {
  let dnsCalls = 0, sends = 0, transportCode: string | undefined;
  const controlled = createControlledSourceTransport({
    resolve: async () => { dnsCalls++; return [{ address: "198.18.0.1", family: 4 }]; },
    send: async () => { sends++; throw new Error("No sender may run for rejected DNS."); },
  });
  const observed: SourceTransport = { async request(request) {
    try { return await controlled.request(request); }
    catch (error) { if (error instanceof SourceTransportError) transportCode = error.code; throw error; }
  } };
  const execution = context();
  await assert.rejects(createNominatimOfficeProvider(observed).search(input, execution.value), error => error instanceof ToolError && error.code === "source-changed");
  assert.equal(transportCode, "unsafe-endpoint"); assert.equal(dnsCalls, 1); assert.equal(sends, 0);
  assert.deepEqual(execution.accounting, { requests: 0, bytes: 0 });
});

test("fixed office policy rejects an offline redirect after the initial bounded send and never follows it", async () => {
  let dnsCalls = 0, sends = 0, transportStatus: number | undefined;
  const controlled = createControlledSourceTransport({
    resolve: async () => { dnsCalls++; return [{ address: "8.8.8.8", family: 4 }]; },
    send: async () => { sends++; return { status: 302, headers: { location: "https://untrusted.example.test/" }, body: (async function* () {})(), close() {} }; },
  });
  const observed: SourceTransport = { async request(request) {
    try { return await controlled.request(request); }
    catch (error) { if (error instanceof SourceTransportError) transportStatus = error.status; throw error; }
  } };
  const execution = context();
  await assert.rejects(createNominatimOfficeProvider(observed).search(input, execution.value), error => error instanceof ToolError && error.code === "source-changed");
  assert.equal(transportStatus, 302); assert.equal(dnsCalls, 1); assert.equal(sends, 1); assert.equal(execution.accounting.requests, 1);
});
