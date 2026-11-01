import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { Window } from "happy-dom";
import { classifyHarvestFailure, HARVEST_PAGE_OBSERVATION, HarvestDiagnosticSchema, retainHarvestDiagnostic } from "../server/jd-harvest-diagnostics";

test("retained diagnostics allow only fixed labels and numbers, never page secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "betterme-safe-diagnostic-"));
  const input = { provider: "51job", cookies: "SECRET", observations: [{ page: 1, phase: "initial", failure: "timeout", html: "SECRET", url: "https://example.test/?token=SECRET", error: "SECRET" }] };
  const safe = HarvestDiagnosticSchema.parse(input);
  const id = await retainHarvestDiagnostic(safe, directory);
  assert.ok(id);
  const path = join(directory, `${id}.json`);
  const saved = await readFile(path, "utf8");
  assert.doesNotMatch(saved, /SECRET|cookies|https:|html|token/);
  assert.equal(JSON.parse(saved).observations[0].failure, "timeout");
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(await retainHarvestDiagnostic({ ...safe, observations: Array(101).fill(safe.observations[0]) }, directory), undefined);
  assert.equal((await readdir(directory)).length, 1);
});

test("owned-page probe returns only structural evidence even on an account page", async () => {
  const dom = new Window();
  try {
    dom.document.body.innerHTML = '<p>请先登录 SECRET</p><input value="SECRET"><a href="/job/1?token=SECRET">SECRET</a>';
    const observed = runInNewContext(HARVEST_PAGE_OBSERVATION, { document: dom.document, location: { pathname: "/login" } });
    assert.equal(observed.failure, "login");
    assert.equal(observed.candidateLinks, 1);
    assert.doesNotMatch(JSON.stringify(observed), /SECRET|token|\/login/);
    dom.document.body.innerHTML = '<p>请完成人机验证 SECRET</p>';
    assert.equal(runInNewContext(HARVEST_PAGE_OBSERVATION, { document: dom.document, location: { pathname: "/search" } }).failure, "verification");
  } finally { await dom.happyDOM.abort(); }
});

test("timeout, platform limits and HTTP errors stay distinct", () => {
  assert.equal(classifyHarvestFailure(new DOMException("request timed out", "TimeoutError")), "timeout");
  assert.equal(classifyHarvestFailure(new TypeError("fetch failed")), "network");
  assert.equal(classifyHarvestFailure(undefined, 429), "platform_limit");
  assert.equal(classifyHarvestFailure(undefined, 403), "platform_limit");
  assert.equal(classifyHarvestFailure(undefined, 503), "http");
});

test("hidden loading placeholders do not extend the owned-page readiness budget", async () => {
  const dom = new Window();
  try {
    dom.document.body.innerHTML = '<div class="loading" hidden></div><div class="skeleton" style="display:none"></div><div class="loading" style="visibility:hidden"></div><div class="job-list-loading"></div>';
    const observed = runInNewContext(HARVEST_PAGE_OBSERVATION, { document: dom.document, location: { pathname: "/search" }, getComputedStyle: dom.getComputedStyle.bind(dom) });
    assert.equal(observed.loadingIndicators, 1);
  } finally { await dom.happyDOM.abort(); }
});
