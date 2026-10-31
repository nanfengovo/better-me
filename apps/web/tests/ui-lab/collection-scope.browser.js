// playwright-cli run-code --filename ... ; intentionally not a production entry point.
async page => {
  if (!/^http:\/\/127\.0\.0\.1:5196\/tests\/ui-lab\//.test(page.url())) throw new Error("Requires the independently owned, synthetic-only port 5196 lab");
  const check = (value, message) => { if (!value) throw new Error(message); };
  await page.setViewportSize({ width: 1440, height: 1100 });
  const browserErrors = [];
  page.on("pageerror", error => browserErrors.push(error.message));
  let captures = 0;
  const requests = [];
  const pageUrl = "https://www.liepin.com/zhaopin/?key=C%23";
  const cards = [
    { url: "https://careers.example.test/jobs/ui-lab-0", title: "合成 C# 双休岗位", locationText: "上海市浦东新区", conditions: "双休；每天8小时；混合办公" },
    { url: "https://careers.example.test/jobs/ui-lab-2", title: "合成 C# 地址待补岗位", locationText: "Shanghai, China", conditions: "工作制度待核实" },
    { url: "https://www.liepin.com/job/9000000003.shtml", title: "合成美国岗位", locationText: "美国 俄亥俄州 哥伦布", conditions: "全远程，仅限美国" },
    { url: "https://www.liepin.com/job/9000000004.shtml", title: "合成未知地点岗位", conditions: "不保证双休" },
  ].map(({ conditions, ...card }) => ({ ...card, platform: "猎聘", company: "纯合成验收企业",
    cardText: `${card.title} 纯合成验收企业 ${card.locationText ?? ""}；${conditions}`,
    evidence: { pageUrl, cardSelector: ".synthetic-card", fields: [
      { field: "url", selector: "a", text: card.url }, { field: "title", selector: ".title", text: card.title },
      { field: "company", selector: ".company", text: "纯合成验收企业" },
      ...(card.locationText ? [{ field: "locationText", selector: ".location", text: card.locationText }] : []),
    ] } }));
  await page.route("**/api/jd/search-session", async route => {
    const request = route.request().postDataJSON();
    check(request.action === "live-batch-search-stream", "Only synthetic stream requests are allowed");
    captures++; requests.push(request.input);
    const coverage = { pagesVisited: 1, pageLimit: 5, scrollSteps: 0, scrollLimit: 0, cardLimit: 500, stopReason: "exhausted", partial: false };
    const results = [{ provider: "liepin", platform: "猎聘", pageUrl, status: "ready", cards, rawCardCount: 4, warnings: [], coverage },
      ...[["51job", "51JOB"], ["boss", "BOSS直聘"], ["linkedin", "LinkedIn"]].map(([provider, platform]) => ({
        provider, platform, pageUrl: { "51job": "https://we.51job.com/pc/search?keyword=C%23", boss: "https://www.zhipin.com/web/geek/job?query=C%23", linkedin: "https://www.linkedin.com/jobs/search?keywords=C%23" }[provider], status: "login_required", cards: [], rawCardCount: 0,
        warnings: ["合成阻断回执；没有打开真实招聘平台"], coverage: { ...coverage, stopReason: "gate", partial: true },
      }))];
    const events = [...results.map(result => ({ type: "provider-result", result })),
      { type: "complete", capturedAt: "2026-10-31T00:00:00.000Z", providers: results.map(result => result.provider) }];
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") });
  });
  // Synthetic source URLs deliberately cannot be imported as Liepin jobs. The
  // real queue must expose the failure; existing index associations still work.
  // This context and origin were created solely for this acceptance run.
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
  await page.getByRole("button", { name: "采集新岗位", exact: true }).waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector(".atlas-map-footer")?.textContent.includes("5000"));
  await page.getByRole("button", { name: "国内", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索地图岗位", exact: true }).fill("C#");
  await page.getByRole("button", { name: "采集新岗位", exact: true }).click();
  await page.getByRole("button", { name: "确认开始采集", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".atlas-live-harvest-card").length === 2);
  await page.waitForFunction(() => document.querySelector('[aria-label="本轮与地图关联口径"]')?.textContent.includes("当前索引匹配 2 岗"));
  const scope = await page.getByLabel("本轮与地图关联口径", { exact: true }).innerText();
  check(scope.includes("地图覆盖 1 岗"), "Map must contain only the one located live-result job");
  const statistics = await page.locator(".atlas-map-footer .atlas-stat-grid strong").allTextContents();
  check(statistics.join(",") === "2,2,1,1", "Expected two jobs, two companies, one coordinate and one unlocated job: " + statistics);
  const receipt = await page.getByLabel("地区过滤回执", { exact: true }).innerText();
  check(receipt.includes("捕获 4 张") && receipt.includes("地区匹配 2 张") && receipt.includes("范围外 1 张") && receipt.includes("地点待核实 1 张"), "Scoped counts must partition the captured cards");
  check(!(await page.locator(".atlas-live-harvest-list").innerText()).includes("合成美国岗位"), "Overseas cards leaked into domestic list");
  await page.locator(".atlas-live-harvest-card .atlas-working-conditions summary").first().click();
  check((await page.locator(".atlas-live-harvest-card .atlas-working-conditions").first().innerText()).includes("不是完整JD"), "Excerpt claims must not masquerade as verified job guarantees");
  await page.locator(".atlas-map-footer").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "output/playwright/collection-scope-desktop.png", fullPage: false });
  await page.getByRole("button", { name: "查看关联岗位／补全地址", exact: true }).nth(1).click();
  await page.getByLabel("地图岗位详情", { exact: true }).waitFor({ state: "visible" });
  check(await page.getByRole("heading", { name: "工作地点", exact: true }).isVisible(), "Associated card must open the existing address review pane");
  check(await page.locator(".atlas-job-detail .atlas-working-conditions").count() === 1, "Source claims belong in the detail pane");
  await page.getByRole("heading", { name: "工作地点", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "output/playwright/collection-scope-address-detail.png", fullPage: false });
  await page.getByRole("button", { name: "关闭岗位详情", exact: true }).click();
  await page.getByRole("button", { name: "查看索引", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".atlas-live-harvest-results") && Number(document.querySelector(".atlas-map-footer strong")?.textContent) > 2);
  const historical = await page.locator(".atlas-map-footer .atlas-stat-grid strong").first().innerText();
  check(await page.locator(".atlas-job-card details, .atlas-job-card a, .atlas-job-card button").count() === 0, "Index cards must not nest interactive work-condition disclosures");
  await page.getByRole("button", { name: "查看实时结果", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="本轮与地图关联口径"]')?.textContent.includes("当前索引匹配 2 岗"));
  await page.setViewportSize({ width: 390, height: 844 });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Mobile document overflows horizontally");
  await page.getByLabel("地区过滤回执", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "output/playwright/collection-scope-mobile.png", fullPage: false });
  await page.setViewportSize({ width: 1440, height: 1100 });
  const captured = captures;
  await page.getByRole("button", { name: "全球", exact: true }).click();
  await page.getByRole("combobox", { name: "工作国家或地区", exact: true }).selectOption("US");
  await page.waitForFunction(() => !document.querySelector(".atlas-live-harvest-results"));
  check(captures === captured, "Changing market/country must not start collection");
  check(requests.every(request => request.regionId === "中国"), "Domestic nationwide intent must be sent explicitly");
  check(browserErrors.length === 0, "Browser runtime errors: " + browserErrors.join("; "));
  return { passed: true, captured: 4, domestic: 2, outside: 1, unknown: 1, statistics, historicalIndexMatches: historical,
    collectionRequests: captures, privateData: "not accessed", browserErrors, scope, screenshots: ["collection-scope-desktop.png", "collection-scope-address-detail.png", "collection-scope-mobile.png"] };
}
