import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { GeocodingRequestSchema } from "@better-me/opportunities";
import { createLocalGazetteerProvider } from "../../../packages/source-adapters/src/geocoding.ts";
import { buildAtlasCityCandidateQuery } from "../src/components/atlas/city-candidate-query.ts";

test("structured city and country take priority without mutating source location facts", () => {
  const location = Object.freeze({ raw: "Original source wording", kind: "office" as const, city: "Cambridge", countryCode: "GB" });
  const original = JSON.stringify(location);
  assert.deepEqual(buildAtlasCityCandidateQuery(location), { kind: "office", raw: "Cambridge", countryCodes: ["GB"], limit: 8 });
  assert.equal(JSON.stringify(location), original);
  assert.deepEqual(buildAtlasCityCandidateQuery({ ...location, raw: "London, United Kingdom", countryCode: "US" }),
    { kind: "office", raw: "Cambridge", countryCodes: ["US"], limit: 8 });
});

test("exact country names, existing aliases and ISO codes prepare bounded city queries across countries", () => {
  for (const [raw, city, country] of [
    ["London, United Kingdom", "London", "GB"], ["London, UK", "London", "GB"],
    ["Paris, France", "Paris", "FR"], ["Berlin, DE", "Berlin", "DE"],
    ["Tricht, Gelderland, Netherlands", "Tricht", "NL"], ["London, Ontario, Canada", "London", "CA"],
    ["New York, NY, USA", "New York", "US"], ["上海，中国", "上海", "CN"],
    [" London ,  united   kingdom ", "London", "GB"],
  ]) {
    assert.deepEqual(buildAtlasCityCandidateQuery({ kind: "office", raw: raw! }, 5),
      { kind: "office", raw: city, countryCodes: [country], limit: 5 }, raw);
  }
});

test("country scope conflicts and partial or regional names do not create new geographic facts", () => {
  for (const raw of ["London, United Kingdo", "Tricht, Gelderland", "London, Europe", "London, United Kingdom office",
    "12 Example Road, London, England, United Kingdom", "London,,United Kingdom"]) {
    assert.deepEqual(buildAtlasCityCandidateQuery({ kind: "office", raw }), { kind: "office", raw, countryCodes: [], limit: 8 }, raw);
  }
  const conflict = { kind: "office" as const, raw: "London, United Kingdom", countryCode: "CA" };
  assert.deepEqual(buildAtlasCityCandidateQuery(conflict), { kind: "office", raw: conflict.raw, countryCodes: ["CA"], limit: 8 });
  assert.deepEqual(buildAtlasCityCandidateQuery({ kind: "office", raw: "Tricht, Gelderland", countryCode: "NL" }),
    { kind: "office", raw: "Tricht, Gelderland", countryCodes: ["NL"], limit: 8 }, "an existing country does not turn a province suffix into a city query");
});

test("remote and composite locations retain their raw text and cannot acquire office candidates", () => {
  for (const raw of ["London, United Kingdom; United Kingdom (Remote)", "London; Paris", "London；Paris", "London\nParis",
    "London / Paris, United Kingdom", "Remote, United Kingdom", "London (remote), United Kingdom", "Work from home, United States", "远程，英国"]) {
    assert.deepEqual(buildAtlasCityCandidateQuery({ kind: "office", raw, city: "London" }),
      { kind: "unknown", raw, countryCodes: [], limit: 8 }, raw);
  }
  for (const kind of ["remote-region", "unknown"] as const) {
    assert.deepEqual(buildAtlasCityCandidateQuery({ kind, raw: "London, United Kingdom", city: "London", countryCode: "GB" }),
      { kind, raw: "London, United Kingdom", countryCodes: ["GB"], limit: 8 });
  }
});

test("prepared London query reaches the checked-in offline city with evidence while the original compound name has no match", async () => {
  const manifestPath = fileURLToPath(new URL("../../../config/geography/gazetteer/manifest.json", import.meta.url));
  const provider = createLocalGazetteerProvider({ manifestPath });
  const signal = new AbortController().signal;
  const context = { signal, throwIfCancelled: () => signal.throwIfAborted() };
  const location = { kind: "office" as const, raw: "London, United Kingdom" };
  const original = await provider.search({ ...location, countryCodes: ["GB"] }, context);
  assert.equal(original.status, "unresolved");
  const request = GeocodingRequestSchema.parse(buildAtlasCityCandidateQuery(location));
  const result = await provider.search(request, context);
  assert.equal(result.totalCandidates, 1);
  assert.equal(result.candidates[0]!.place.id, "geonames.2643743");
  assert.equal(result.candidates[0]!.place.countryCode, "GB");
  assert.equal(result.candidates[0]!.verification, "unverified");
  assert.equal(result.candidates[0]!.estimated, true);
  assert.ok(result.candidates[0]!.evidence.shardSha256);
  assert.equal(location.raw, "London, United Kingdom");
  const remote = await provider.search(buildAtlasCityCandidateQuery({ ...location, raw: "London, United Kingdom; Remote" }), context);
  assert.equal(remote.status, "not-applicable"); assert.deepEqual(remote.candidates, []);
});
