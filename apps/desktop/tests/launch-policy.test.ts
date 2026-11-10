import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { externalUrl, validateSmokeProfile } from "../src/main/launch-policy.js";

test("desktop smoke can claim only an empty private temp profile", () => {
  const profile = realpathSync(mkdtempSync(path.join(tmpdir(), "betterme-desktop-smoke-")));
  assert.equal(validateSmokeProfile(profile), profile);
  writeFileSync(path.join(profile, "existing-account-marker"), "untouched");
  assert.throws(() => validateSmokeProfile(profile), /new, empty and private/);
  assert.throws(() => validateSmokeProfile(realpathSync(tmpdir())));
});
test("external links cannot invoke local programs, file handlers or credential-bearing URLs", () => {
  assert.equal(externalUrl("https://github.com/nanfengovo/better-me"), "https://github.com/nanfengovo/better-me");
  for (const url of ["file:///private/account", "javascript:alert(1)", "data:text/html,test", "ms-settings:privacy", "https://name:password@example.com", {}, null]) assert.equal(externalUrl(url), undefined);
});
