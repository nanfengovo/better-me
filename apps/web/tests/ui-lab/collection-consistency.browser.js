// Run only with playwright-cli run-code --filename on the dedicated fixture.
async page => {
  if (page.url() !== "http://127.0.0.1:5197/tests/ui-lab/collection-consistency.html") throw new Error("Requires the isolated temporary-SQLite fixture on port 5197");
  const check = (value, message) => { if (!value) throw new Error(message); };
  await page.setViewportSize({ width: 1440, height: 1100 });
  const errors = [], requests = [], imported = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", async response => {
    if (response.url().endsWith("/api/v1/jobs/reviewed-cards/import")) {
      const body = await response.json(); imported.push({ status: response.status(), ok: body.ok, counts: body.value?.counts });
    }
  });
  const platforms = { liepin: "猎聘", "51job": "51JOB", boss: "BOSS直聘", linkedin: "LinkedIn" };
  const pages = { liepin: "https://www.liepin.com/zhaopin/?key=C%23&city=020&dq=020", "51job": "https://we.51job.com/pc/search?keyword=C%23", boss: "https://www.zhipin.com/web/geek/job?query=C%23", linkedin: "https://www.linkedin.com/jobs/search?keywords=C%23&location=Shanghai" };
  const makeCard = (provider, url, title, locationText) => ({ platform: platforms[provider], url, title, company: "上海纯合成验收公司",
    ...(locationText ? { locationText } : {}), cardText: `${title} 上海纯合成验收公司 ${locationText ?? ""}`,
    evidence: { pageUrl: pages[provider], cardSelector: ".fixture-card", fields: [
      { field: "url", selector: "a", text: url }, { field: "title", selector: ".title", text: title },
      { field: "company", selector: ".company", text: "上海纯合成验收公司" },
      ...(locationText ? [{ field: "locationText", selector: ".location", text: locationText }] : []),
    ] } });
  await page.route("**/api/jd/search-session", async route => {
    const request = route.request().postDataJSON();
    check(request.action === "live-batch-search-stream", "Only synthetic SSE is permitted");
    requests.push(request.input);
    const cards = {
      linkedin: [makeCard("linkedin", requests.length === 1
        ? "https://cn.linkedin.com/jobs/view/csharp-fixture-4483096821?trackingId=first"
        : "https://www.linkedin.com/jobs/view/different-slug-4483096821?trackingId=second", "C# LinkedIn 合成岗位", "Shanghai, China")],
      liepin: [makeCard("liepin", "https://www.liepin.com/job/9000000001.shtml", ".NET 合成工程师【上海-静安区】"),
        makeCard("liepin", "https://www.liepin.com/job/9000000002.shtml", "C# 合成深圳岗位", "深圳市南山区"),
        makeCard("liepin", "https://www.liepin.com/job/9000000003.shtml", "C# 合成未披露地点岗位")],
    };
    const results = (request.input.providers ?? Object.keys(platforms)).map(provider => ({
      provider, platform: platforms[provider], pageUrl: pages[provider], cards: cards[provider] ?? [],
      status: cards[provider]?.length ? "ready" : "empty", rawCardCount: cards[provider]?.length ?? 0, warnings: [],
      coverage: { pagesVisited: 1, pageLimit: 5, scrollSteps: 0, scrollLimit: 0, cardLimit: 500, stopReason: "exhausted", partial: false },
    }));
    const events = [...results.map(result => ({ type: "provider-result", result })),
      { type: "complete", capturedAt: "2026-10-31T00:00:00.000Z", providers: results.map(result => result.provider) }];
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") });
  });
  // These stores belong solely to the fresh dedicated QA browser origin.
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
  await page.getByRole("button", { name: "采集新岗位", exact: true }).waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector(".atlas-map-footer")?.textContent.includes("22"));
  await page.getByRole("button", { name: "国内", exact: true }).click();
  await page.getByRole("combobox", { name: "工作省份", exact: true }).selectOption("31");
  await page.getByRole("textbox", { name: "搜索地图岗位", exact: true }).fill("C#");
  await page.waitForFunction(() => document.querySelector(".atlas-map-footer .atlas-stat-grid strong")?.textContent === "2");
  const baseline = await page.evaluate(async () => {
    const { token } = await (await fetch("/__collection-consistency/session", { method: "POST" })).json();
    return (await (await fetch("/api/v1/dataset/export", { headers: { authorization: `Bearer ${token}` } })).json()).value;
  });
  await page.getByRole("button", { name: "采集新岗位", exact: true }).click();
  await page.getByRole("button", { name: "确认开始采集", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".atlas-live-card-index:not(:disabled)").length === 2, undefined, { timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector('button[aria-busy="true"].atlas-source-search'));
  await page.waitForFunction(() => document.querySelector('[aria-label="本轮与地图关联口径"]')?.textContent.includes("当前索引匹配 2 岗"));
  const scope = await page.getByLabel("本轮与地图关联口径", { exact: true }).innerText();
  const receipt = await page.getByLabel("地区过滤回执", { exact: true }).innerText();
  const statistics = await page.locator(".atlas-map-footer .atlas-stat-grid strong").allTextContents();
  check(scope.includes("本轮地区匹配 2 张") && scope.includes("当前索引匹配 2 岗") && scope.includes("地图覆盖 0 岗"), "Unique live/index/map mismatch: " + scope);
  // Same employer text on different platforms is not proof of company identity.
  check(statistics.join(",") === "2,2,0,2", "Expected 2 jobs, 2 source companies, 0 coordinates, 2 unlocated: " + statistics);
  check(receipt.includes("地区匹配 2 张") && receipt.includes("范围外 1 张") && receipt.includes("地点待核实 1 张"), "Location evidence partition mismatch: " + receipt);
  check(await page.locator(".atlas-live-harvest-card").count() === 2, "Tracking variants counted as distinct jobs");
  const audit = await page.evaluate(async baseline => {
    const { token } = await (await fetch("/__collection-consistency/session", { method: "POST" })).json();
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const snapshot = (await (await fetch("/api/v1/dataset/export", { headers })).json()).value;
    const result = (await (await fetch("/api/v1/jobs/search", { method: "POST", headers, body: JSON.stringify({
      search: { text: "C#", mode: "fuzzy" }, market: "domestic", workCountryCodes: ["CN"], workRegionGroups: [["上海", "上海市", "Shanghai"]],
    }) })).json()).value;
    const liepin = snapshot.listings.find(listing => listing.canonicalUrl?.includes("9000000001"));
    const job = snapshot.jobs.find(job => job.listingIds.includes(liepin?.id));
    const location = snapshot.locations.find(location => job?.locationIds.includes(location.id));
    const linkedin = snapshot.listings.find(listing => listing.sourceId === "reviewed-platform-linkedin");
    const englishJob = snapshot.jobs.find(job => job.listingIds.includes(linkedin?.id));
    const englishLocation = snapshot.locations.find(location => englishJob?.locationIds.includes(location.id));
    return { baselineJobs: baseline.jobs.length, jobs: snapshot.jobs.length,
      oldJobsPreserved: baseline.jobs.every(job => snapshot.jobs.some(value => JSON.stringify(value) === JSON.stringify(job))),
      oldListingsPreserved: baseline.listings.every(listing => snapshot.listings.some(value => JSON.stringify(value) === JSON.stringify(listing))),
      apiTotal: result.totalJobs, location, englishLocation, importedTitles: snapshot.jobs.filter(job => !baseline.jobs.some(old => old.id === job.id)).map(job => job.title.value),
    };
  }, baseline);
  check(audit.jobs === audit.baselineJobs + 2 && audit.oldJobsPreserved && audit.oldListingsPreserved, "Existing synthetic index was overwritten or duplicate jobs imported");
  check(audit.location?.raw === "上海-静安区" && !audit.location.coordinates, "Title evidence must be indexed without guessed office coordinates");
  check(audit.englishLocation?.raw === "Shanghai, China" && audit.englishLocation.countryCode === "CN"
    && audit.englishLocation.city === "上海市" && !audit.englishLocation.coordinates
    && audit.englishLocation.evidence.some(evidence => evidence.quote === "Shanghai, China" && evidence.selector === ".location"),
    "English location must become queryable while preserving literal source evidence and no office point");
  check(imported.length > 0 && imported.every(receipt => receipt.status === 200 && receipt.ok), "Actual import route did not succeed");
  for (let index = 0; index < 2; index++) {
    await page.getByRole("button", { name: "查看关联岗位／补全地址", exact: true }).nth(index).click();
    await page.getByLabel("地图岗位详情", { exact: true }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "关闭岗位详情", exact: true }).click();
  }
  await page.locator(".atlas-map-footer").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "output/playwright/collection-consistency-desktop.png", fullPage: false });
  await page.getByRole("button", { name: "查看索引", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".atlas-live-harvest-results"));
  await page.waitForFunction(total => Number(document.querySelector(".atlas-map-footer .atlas-stat-grid strong")?.textContent) === total, audit.apiTotal);
  check(audit.apiTotal === 4, "Backend default C# aliases must include historical WPF and new .NET jobs");
  await page.getByRole("button", { name: "查看实时结果", exact: true }).click();
  await page.getByLabel("本轮与地图关联口径", { exact: true }).waitFor({ state: "visible" });
  await page.setViewportSize({ width: 390, height: 844 });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Mobile overflow");
  await page.getByLabel("地区过滤回执", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "output/playwright/collection-consistency-mobile.png", fullPage: false });
  check(requests.length >= 2 && requests.every(request => request.regionId.includes("上海")), "Synonym requests must retain Shanghai scope");
  check(errors.length === 0, "Browser runtime errors: " + errors.join("; "));
  return { passed: true, scope, receipt, statistics, audit, importRequests: imported.length, searchTerms: requests.map(request => request.keyword), errors };
}
