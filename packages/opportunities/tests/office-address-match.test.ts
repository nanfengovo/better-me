import assert from "node:assert/strict";
import test from "node:test";
import { evaluateOfficeAddressCandidate, type JobLocation, type OfficeAddressCandidate } from "../src/office-address.js";

function source(overrides: Partial<JobLocation> = {}): JobLocation {
  return { id: "synthetic-office", raw: "Synthetic source location", kind: "office", countryCode: "CN", region: "Shanghai",
    city: "Shanghai", district: "Pudong", streetAddress: "12 Zhongshan Road", postalCode: "00200", precision: "street",
    verification: "unverified", evidence: [], ...overrides };
}

function candidate(overrides: Partial<OfficeAddressCandidate["proposal"]> = {}): OfficeAddressCandidate {
  return { id: "synthetic-candidate", providerId: "synthetic-provider", attribution: "Synthetic attribution",
    evidenceUrl: "https://maps.example.invalid/place", estimated: true, verification: "unverified",
    proposal: { basis: "manual-user-confirmation", countryCode: "CN", formattedAddress: "12 Zhongshan Road, Shanghai",
      streetAddress: "12 Zhongshan Road", postalCode: "00200",
      coordinates: { latitude: 31.2, longitude: 121.5, coordinateSystem: "WGS84" }, coordinateMeaning: "building",
      evidenceUrl: "https://maps.example.invalid/place", ...overrides } };
}

test("structured country, street and postal fields match after Unicode, whitespace and case normalization", () => {
  const result = evaluateOfficeAddressCandidate(source({ countryCode: "CN", streetAddress: "  １２\tZhongshan   ROAD ", postalCode: "００２００" }), candidate());
  assert.deepEqual(result.fields.map(field => field.status), ["match", "unknown", "unknown", "unknown", "match", "match"]);
  assert.equal(result.matches, 3); assert.equal(result.conflicts, 0); assert.equal(result.unknowns, 3);
});

test("country and street differences remain visible conflicts without fuzzy or punctuation stripping", () => {
  const result = evaluateOfficeAddressCandidate(source({ streetAddress: "12 Zhongshan Road, Suite 4" }), candidate({ countryCode: "US", streetAddress: "12 Zhongshan Road Suite 4" }));
  assert.equal(result.fields.find(field => field.field === "countryCode")?.status, "conflict");
  assert.equal(result.fields.find(field => field.field === "streetAddress")?.status, "conflict");
});

test("postal comparison preserves leading zeroes and punctuation", () => {
  const leadingZero = evaluateOfficeAddressCandidate(source({ postalCode: "01234" }), candidate({ postalCode: "1234" }));
  const punctuation = evaluateOfficeAddressCandidate(source({ postalCode: "12-34" }), candidate({ postalCode: "1234" }));
  assert.equal(leadingZero.fields.find(field => field.field === "postalCode")?.status, "conflict");
  assert.equal(punctuation.fields.find(field => field.field === "postalCode")?.status, "conflict");
});

test("missing candidate locality fields and formatted address text never imply a match", () => {
  const location = source({ city: "Shanghai", region: "Pudong", district: "Lujiazui", streetAddress: undefined, postalCode: undefined });
  const result = evaluateOfficeAddressCandidate(location, candidate({ formattedAddress: "Shanghai, Pudong, Lujiazui, 12 Zhongshan Road" }));
  assert.equal(result.matches, 1); assert.equal(result.conflicts, 0);
  for (const field of ["region", "city", "district", "streetAddress", "postalCode"] as const) {
    assert.equal(result.fields.find(value => value.field === field)?.status, "unknown", field);
  }
});

test("all unavailable structured comparisons remain unknown and never mutate either input", () => {
  const location = source({ countryCode: undefined, region: undefined, city: undefined, district: undefined, streetAddress: undefined, postalCode: undefined });
  const item = candidate(); const beforeLocation = structuredClone(location), beforeCandidate = structuredClone(item);
  const result = evaluateOfficeAddressCandidate(location, item);
  assert.equal(result.matches, 0); assert.equal(result.conflicts, 0); assert.equal(result.unknowns, 6);
  assert.deepEqual(location, beforeLocation); assert.deepEqual(item, beforeCandidate);
});

test("any structured mismatch makes the summary conflict, while coordinates do not affect field results", () => {
  const item = candidate();
  const before = evaluateOfficeAddressCandidate(source(), item);
  const shifted = { ...item, proposal: { ...item.proposal, coordinates: { latitude: -33.8, longitude: 151.2, coordinateSystem: "WGS84" as const } } };
  const after = evaluateOfficeAddressCandidate(source(), shifted);
  assert.deepEqual(after, before);
  assert.equal(evaluateOfficeAddressCandidate(source({ city: "Different city" }), item).matches, before.matches);
  assert.equal(evaluateOfficeAddressCandidate(source({ postalCode: "99999" }), item).conflicts, 1);
});
