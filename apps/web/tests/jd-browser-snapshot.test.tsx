import assert from "node:assert/strict";
import test from "node:test";
import { SearchProjectionDiagnosticsSchema, validateBrowserSnapshot } from "../server/jd-browser-snapshot";

const url = "https://www.liepin.com/zhaopin/?key=C%23";
const position = { url, navigation: 1 };
const diagnostic = { schemaVersion: 1 as const, platform: "猎聘" as const, rawRoots: 3,
  hiddenRoots: 1, excludedRoots: 1, incompleteRoots: 0, otherRemovedRoots: 0, projectedRoots: 1, projectedRootsWithText: 1 };
const snapshot = { html: "<html><body></body></html>", url, title: "synthetic", searchDiagnostics: diagnostic };

test("snapshot validation preserves only fixed bounded search counts and remains compatible with older snapshots", () => {
  const result = validateBrowserSnapshot({ ...snapshot, extra: "UNTRUSTED_ATTRIBUTE" }, position, position);
  assert.equal(result.state, "ready");
  assert.deepEqual(result.snapshot?.searchDiagnostics, diagnostic);
  assert.notEqual(result.snapshot?.searchDiagnostics, diagnostic);
  assert.equal("extra" in result.snapshot!, false);
  assert.equal(validateBrowserSnapshot({ html: snapshot.html, title: snapshot.title, url }, position, position).state, "ready");
});

test("diagnostics reject extra strings, URLs, unsupported versions and noninteger or out-of-budget counts", () => {
  for (const invalid of [
    { ...diagnostic, text: "PRIVATE_TITLE" }, { ...diagnostic, url: "https://example.invalid" },
    { ...diagnostic, schemaVersion: 2 }, { ...diagnostic, rawRoots: 25_001 },
    { ...diagnostic, hiddenRoots: -1 }, { ...diagnostic, hiddenRoots: .5 },
    { ...diagnostic, hiddenRoots: Infinity }, { ...diagnostic, hiddenRoots: NaN },
    { ...diagnostic, hiddenRoots: "1" }, { ...diagnostic, platform: "unknown" },
    { ...diagnostic, rawRoots: 4 }, { ...diagnostic, projectedRootsWithText: 2 },
  ]) {
    assert.equal(SearchProjectionDiagnosticsSchema.safeParse(invalid).success, false);
    assert.deepEqual(validateBrowserSnapshot({ ...snapshot, searchDiagnostics: invalid }, position, position), { state: "failed" });
  }
});

test("diagnostics cannot cross platform, page identity or existing visibility metadata validation", () => {
  assert.deepEqual(validateBrowserSnapshot({ ...snapshot, searchDiagnostics: { ...diagnostic, platform: "LinkedIn" } }, position, position), { state: "failed" });
  assert.deepEqual(validateBrowserSnapshot(snapshot, position, { ...position, navigation: 2 }), { state: "navigation_in_progress" });
  assert.deepEqual(validateBrowserSnapshot({ ...snapshot, pageLoad: { readyState: "complete", content: "empty", visibleFrames: 1001 } }, position, position), { state: "failed" });
  const other = "https://www.liepin.com/zhaopin/?key=other";
  assert.deepEqual(validateBrowserSnapshot({ ...snapshot, url: other }, position, position), { state: "failed" });
});
