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

const officeUrl = "https://www.liepin.com/job/123456789.shtml";
const officePosition = { url: officeUrl, navigation: 2 };
const officeDisclosure = { selector: "liepin-work-address", label: "工作地址", text: "上海市浦东新区合成路100号 A座" };
const officeSnapshot = { html: "<html><body>岗位正文</body></html>", url: officeUrl, title: "合成岗位", visibleOfficeDisclosures: [officeDisclosure] };

test("visible office disclosures are separately validated and copied without becoming JD HTML", () => {
  const result = validateBrowserSnapshot(officeSnapshot, officePosition, officePosition);
  assert.equal(result.state, "ready"); assert.deepEqual(result.snapshot?.visibleOfficeDisclosures, [officeDisclosure]);
  assert.notEqual(result.snapshot?.visibleOfficeDisclosures, officeSnapshot.visibleOfficeDisclosures);
  assert.notEqual(result.snapshot?.visibleOfficeDisclosures?.[0], officeDisclosure);
  assert.equal(result.snapshot?.html, officeSnapshot.html);
  assert.equal(validateBrowserSnapshot({ ...officeSnapshot, visibleOfficeDisclosures: undefined }, officePosition, officePosition).state, "ready");
});

test("visible office sidecars reject forged shape, unnormalized text, unsupported selectors and excess budget", () => {
  for (const invalid of [null, {}, [null], [{ ...officeDisclosure, selector: "boss-work-address" }],
    [{ ...officeDisclosure, label: "公司地址" }], [{ ...officeDisclosure, text: "" }], [{ ...officeDisclosure, text: "x".repeat(1001) }],
    [{ ...officeDisclosure, text: " 地址 " }], [{ ...officeDisclosure, text: "地址\n尾部" }], [{ ...officeDisclosure, text: "地址  尾部" }],
    [{ ...officeDisclosure, text: "地址\u0000尾部" }], [{ ...officeDisclosure, text: "地址\ud800尾部" }],
    [{ ...officeDisclosure, url: "https://example.invalid" }], Array.from({ length: 21 }, () => officeDisclosure),
  ]) assert.deepEqual(validateBrowserSnapshot({ ...officeSnapshot, visibleOfficeDisclosures: invalid }, officePosition, officePosition), { state: "failed" });
});

test("visible office sidecars stay bound to a Liepin single job, a current observation and absence of gates", () => {
  for (const url of ["https://www.liepin.com/zhaopin/?key=C%23", "https://www.zhipin.com/job_detail/synthetic.html", "https://www.linkedin.com/jobs/view/123456789/", "https://www.liepin.com.invalid/job/123456789.shtml"]) {
    const samePosition = { url, navigation: 2 };
    assert.deepEqual(validateBrowserSnapshot({ ...officeSnapshot, url }, samePosition, samePosition), { state: "failed" });
  }
  for (const gate of ["login_required", "verification_required"]) assert.deepEqual(validateBrowserSnapshot({ ...officeSnapshot, gate }, officePosition, officePosition), { state: "failed" });
  assert.deepEqual(validateBrowserSnapshot(officeSnapshot, officePosition, { ...officePosition, navigation: 3 }), { state: "navigation_in_progress" });
  assert.deepEqual(validateBrowserSnapshot(officeSnapshot, officePosition, { ...officePosition, url: officeUrl.replace("123456789", "987654321") }), { state: "navigation_in_progress" });
});
