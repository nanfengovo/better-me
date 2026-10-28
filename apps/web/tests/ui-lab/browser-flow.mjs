/** Reproducible, real-input flow. Use only with this isolated lab and an owned Playwright page. */
export async function runStreamingFlow(page, label) {
  if (!/^http:\/\/127\.0\.0\.1:(5186|5190)\/tests\/ui-lab\//.test(page.url())) {
    throw new Error("This flow must never run on the user's production page.");
  }
  const selectAll = await page.evaluate(() => navigator.platform.includes("Mac") ? "Meta+A" : "Control+A");
  const initial = await page.evaluate(() => window.__atlasUiLab.state());
  await page.getByRole("button", { name: "开始合成增量", exact: true }).click();
  // Idle polling backs off in the real application. Do not mistake an interval
  // before its first observation for a concurrent-update measurement.
  await page.waitForFunction(initialJobs => {
    const banner = document.querySelector(".atlas-data-banner")?.textContent ?? "";
    const count = Number(banner.match(/(\d+) 个来源岗位/)?.[1]);
    return count > initialJobs && document.querySelector('[data-lane="enrichment"]')?.getAttribute("data-state") === "working";
  }, initial.jobs, { timeout: 35000 });
  const observedStart = await page.locator(".atlas-data-banner").innerText();
  const during = [];
  await page.evaluate(value => window.__atlasUiLab.metrics.start(value), label);
  for (const term of ["C#", "Python", "TypeScript"]) {
    const input = page.getByRole("textbox", { name: "搜索地图岗位", exact: true });
    await input.click();
    await input.press(selectAll);
    await input.pressSequentially(term, { delay: 100 });
    // Give the existing async query and observer a bounded settling window.
    await page.waitForTimeout(400);
    await page.locator('.atlas-job-list[aria-busy="false"]').waitFor();
    await page.getByRole("button", { name: "筛选", exact: true }).click();
    await page.getByRole("button", { name: "筛选", exact: true }).click();
    await page.getByRole("button", { name: "平面视角 2D", exact: true }).click();
    await page.getByRole("button", { name: "空间视角 3D", exact: true }).click();
    during.push(await page.locator(".atlas-data-banner").innerText());
  }
  await page.locator(".atlas-job-card").first().click();
  await page.locator(".atlas-job-detail").waitFor();
  await page.keyboard.press("Escape");
  await page.locator(".atlas-job-detail").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "清除岗位关键词", exact: true }).click();
  await page.waitForTimeout(1000);
  const box = await page.locator(".maplibregl-canvas").boundingBox();
  if (!box) throw new Error("The real map canvas must be visible.");
  await page.mouse.move(box.x + box.width * .45, box.y + box.height * .6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .55, box.y + box.height * .56, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(900);
  await page.getByRole("button", { name: "停止合成增量", exact: true }).click();
  await page.waitForTimeout(1000);
  const report = await page.evaluate(() => window.__atlasUiLab.metrics.stop());
  const state = await page.evaluate(() => window.__atlasUiLab.state());
  const measuredEnd = await page.locator(".atlas-data-banner").innerText();
  await page.waitForFunction(expected => {
    const text = document.querySelector(".atlas-data-banner")?.textContent ?? "";
    return text.includes(`${expected.jobs} 个来源岗位`) && text.includes(`索引版本 ${expected.revision}`);
  }, state, { timeout: 20000 });
  const banner = await page.locator(".atlas-data-banner").innerText();
  if (!report.validForegroundWindow) throw new Error("Discard hidden-tab measurements.");
  if (report.dom.mapCanvases !== 1 || report.dom.horizontalOverflow) throw new Error("UI layout invariant failed.");
  if (!banner.includes(`${state.jobs} 个来源岗位`) || !banner.includes(`索引版本 ${state.revision}`)) {
    throw new Error("The real UI has not caught up to the synthetic revision; do not call this a streaming pass.");
  }
  return { report, initial, state, observedStart, during, measuredEnd, banner };
}

/** Tight red-capable probe for state-only UI rerendering, independent of query computation. */
export async function runControlProbe(page) {
  await page.evaluate(() => window.__atlasUiLab.metrics.start("UI-only controls, no query changes"));
  for (let i = 0; i < 3; i++) {
    await page.getByRole("button", { name: "筛选", exact: true }).click();
    await page.getByRole("button", { name: "筛选", exact: true }).click();
    await page.getByRole("button", { name: "平面视角 2D", exact: true }).click();
    await page.getByRole("button", { name: "空间视角 3D", exact: true }).click();
  }
  await page.waitForTimeout(500);
  const report = await page.evaluate(() => window.__atlasUiLab.metrics.stop());
  return { report, meetsLocalInteractionBudget: report.validForegroundWindow &&
    report.eventTiming.maximumObservedDurationMs !== null && report.eventTiming.maximumObservedDurationMs <= 200 };
}
