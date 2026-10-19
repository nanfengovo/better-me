import assert from "node:assert/strict";
import test from "node:test";
import countryCatalog from "../../../config/geography/countries.json" with { type: "json" };
import { resolveSourceCountryCode } from "../src/source-country.js";

test("explicit countries resolve across the shared ISO catalog in English, Chinese and code form", () => {
  for (const code of countryCatalog.countries) {
    assert.equal(resolveSourceCountryCode(code.toLowerCase()), code);
    for (const locale of ["en", "zh"]) {
      const label = new Intl.DisplayNames([locale], { type: "region" }).of(code)!;
      assert.equal(resolveSourceCountryCode(label), code, `${locale}: ${label}`);
    }
  }
  assert.equal(resolveSourceCountryCode("Czechia"), "CZ");
  assert.equal(resolveSourceCountryCode("  捷克  "), "CZ");
  assert.equal(resolveSourceCountryCode("UK"), "GB");
  assert.equal(resolveSourceCountryCode("Mainland China"), "CN");
});

test("regions, cities, brands, compound countries and invalid ISO codes are not country evidence", () => {
  for (const value of ["", "Ostrava", "Shanghai", "ABB", "Europe", "EU", "UN", "ZZ", "XX", "US or Canada", "China, Shanghai", "Czechia, Ostrava"]) {
    assert.equal(resolveSourceCountryCode(value), undefined, value);
  }
});
