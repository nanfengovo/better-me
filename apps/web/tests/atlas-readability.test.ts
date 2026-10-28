import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { Window } from "happy-dom";

const stylesDirectory = resolve(import.meta.dirname, "../src/components/atlas");

function stylesheet(name: string): string {
  const path = resolve(stylesDirectory, name);
  return readFileSync(path, "utf8").replace(/@import\s+["'](.+?)["'];/g, (_match, imported: string) =>
    stylesheet(resolve(dirname(path), imported)));
}

const fixture = `
  <main class="atlas-workspace atlas-experience" data-pane-layout="wide">
    <ol class="atlas-activity-rail"><li><div class="atlas-activity-content">
      <div class="atlas-activity-label">采集<span class="atlas-activity-state">需关注</span></div>
      <div class="atlas-activity-value"><strong>1539</strong><span>岗</span></div><p>部分来源未完成</p>
    </div></li></ol>
    <aside class="atlas-results is-live-source-results">
      <section class="atlas-harvest-progress" data-state="attention">
        <div class="atlas-harvest-progress-heading"><span class="atlas-harvest-progress-indicator"></span><div class="atlas-harvest-progress-copy"><strong>部分来源需要处理</strong></div><dl class="atlas-harvest-progress-summary"><div><dt>发现</dt><dd>1539</dd></div><div><dt>已保存</dt><dd>85</dd></div></dl></div>
        <ul class="atlas-harvest-issues"><li class="atlas-harvest-issue"><span class="atlas-harvest-issue-source">猎聘</span><div class="atlas-harvest-issue-copy"><p class="atlas-harvest-issue-reason">页面没有切换成功</p></div></li></ul>
        <p class="atlas-harvest-issue-advice">已保存的岗位不受影响，可稍后继续。</p>
        <div class="atlas-harvest-footer"><details class="atlas-harvest-progress-details"><summary>原因与处理详情<small>来源回执</small></summary><ul class="atlas-harvest-issue-details"><li><strong>猎聘 · 页面未切换</strong><p>页面没有确认切换成功</p><details><summary>原始诊断</summary><ul><li>page changed: false</li></ul></details></li></ul><p class="atlas-harvest-progress-message">已保留本轮结果</p></details><div class="atlas-harvest-actions"><button>继续采集</button></div></div>
      </section>
      <details class="atlas-background-enrichment"><summary class="atlas-background-enrichment-heading"><strong>后台补全</strong><span class="atlas-background-enrichment-activity">自动处理中</span></summary><dl><div><dt>待处理</dt><dd>3</dd></div></dl><p class="atlas-background-enrichment-note">无来源真实坐标，不生成办公点。</p></details>
      <div class="atlas-job-list"><button class="atlas-job-card"><span class="atlas-company-line">真实公司</span><strong>高级软件工程师</strong><span class="atlas-job-meta">上海市</span><span class="atlas-job-salary">20–30万</span><div class="atlas-job-card-tags"><span class="atlas-badge-platform">猎聘</span><span class="atlas-job-classification">民营</span></div></button></div>
      <section class="atlas-live-harvest-results"><article class="atlas-live-harvest-card"><div class="atlas-live-harvest-card-top"><span>真实公司</span><span class="atlas-badge-platform">猎聘</span></div><h4>高级软件工程师</h4><div class="atlas-live-harvest-card-meta"><span>上海市</span></div><a>打开招聘原文</a><details class="atlas-live-card-details" open><summary>岗位摘要与采集证据</summary><p class="atlas-live-harvest-card-text">负责产品研发与交付</p><small>来源卡片摘要，不是完整 JD</small></details></article></section>
    </aside>
  </main>`;

function setup(width: number, layout = "wide", readability = true) {
  const dom = new Window({ width, height: 900 });
  const style = dom.document.createElement("style");
  style.textContent = ["atlas.css", "atlas-harvest-progress.css", "background-enrichment.css", "harvest-recovery.css", "atlas-experience.css"]
    .map(stylesheet).join("\n");
  if (!readability) style.textContent = style.textContent.replace(stylesheet("atlas-readability.css"), "");
  dom.document.head.append(style);
  dom.document.body.innerHTML = fixture;
  dom.document.querySelector("main")!.setAttribute("data-pane-layout", layout);
  return {
    dom,
    css: (selector: string) => dom.getComputedStyle(dom.document.querySelector(selector)!),
  };
}

for (const [width, layout] of [[1440, "wide"], [390, "narrow"]] as const) {
  test(`collection evidence and job text stay readable at ${width}px after the complete stylesheet cascade`, async () => {
    const { dom, css } = setup(width, layout);
    try {
      const expected: Record<string, number> = {
        ".atlas-harvest-progress-copy > strong": 16,
        ".atlas-harvest-progress-summary dt": 12,
        ".atlas-harvest-progress-summary dd": 22,
        ".atlas-harvest-issue-source": 12,
        ".atlas-harvest-issue-reason": 14,
        ".atlas-harvest-issue-advice": 14,
        ".atlas-harvest-issue-details p": 14,
        ".atlas-harvest-issue-details summary": 14,
        ".atlas-harvest-issue-details ul": 12,
        ".atlas-harvest-progress-details > summary": 14,
        ".atlas-harvest-progress-details small": 12,
        ".atlas-harvest-progress-message": 14,
        ".atlas-background-enrichment-activity": 14,
        ".atlas-background-enrichment-note": 12,
        ".atlas-company-line": 14,
        ".atlas-job-card > strong": 16,
        ".atlas-job-meta": 14,
        ".atlas-badge-platform": 12,
        ".atlas-job-classification": 12,
        ".atlas-live-harvest-card-top > span:first-child": 14,
        ".atlas-live-harvest-card h4": 16,
        ".atlas-live-harvest-card-meta": 14,
        ".atlas-live-harvest-card-text": 14,
        ".atlas-live-card-details > summary": 14,
        ".atlas-live-card-details > small": 12,
        ".atlas-activity-label": 13,
        ".atlas-activity-state": 12,
        ".atlas-activity-value strong": 22,
        ".atlas-activity-value > span": 12,
        ".atlas-activity-content p": 12,
      };
      for (const [selector, minimum] of Object.entries(expected)) {
        assert.ok(Number.parseFloat(css(selector).fontSize) >= minimum,
          `${selector}: expected at least ${minimum}px, received ${css(selector).fontSize}`);
      }
      for (const selector of [".atlas-harvest-issue-reason", ".atlas-harvest-issue-advice", ".atlas-harvest-progress-message"]) {
        assert.notEqual(css(selector).display, "none", `${selector} must not conceal source evidence`);
        assert.notEqual(css(selector).overflow, "hidden", `${selector} must remain readable in full`);
      }
    } finally { await dom.happyDOM.close(); }
  });
}

test("readability overrides are Atlas scoped, preserve scroll access and introduce no motion", async () => {
  const { dom, css } = setup(1440);
  try {
    assert.equal(css(".atlas-results").overflowY, "auto");
    assert.ok(Number.parseFloat(css(".atlas-harvest-actions button").minHeight) >= 44);
    assert.ok(Number.parseFloat(css(".atlas-harvest-progress-details > summary").minHeight) >= 44);
    assert.ok(Number.parseFloat(css(".atlas-live-harvest-card > a").minHeight) >= 44);
    assert.ok(Number.parseFloat(css(".atlas-live-card-details > summary").minHeight) >= 44);
    assert.equal(css(".atlas-live-harvest-results").overflowY, "visible");
    assert.equal(css(".atlas-live-card-details .atlas-live-harvest-card-text").overflow, "visible");
    const source = stylesheet("atlas-readability.css");
    assert.doesNotMatch(source, /(?:animation|transition)\s*:|@keyframes/);
    assert.match(source, /:focus-visible/);
    assert.doesNotMatch(source, /display\s*:\s*none/);
    for (const selector of source.matchAll(/(?:^|})\s*([^@{}]+)\{/g)) {
      const rule = selector[1].replace(/\/\*[\s\S]*?\*\//g, "").trim();
      if (!rule) continue;
      assert.ok(rule.split(",").every(part => part.trim().startsWith(".atlas-workspace.atlas-experience")),
        `unscoped readability rule: ${rule}`);
    }
  } finally { await dom.happyDOM.close(); }
});

test("indexed results keep their existing scroll ownership and page geometry", async () => {
  const before = setup(1440, "wide", false);
  const after = setup(1440);
  try {
    for (const fixture of [before, after]) fixture.dom.document.querySelector("aside")!.classList.remove("is-live-source-results");
    for (const selector of [".atlas-results", ".atlas-job-list"]) {
      for (const property of ["overflow", "overflow-y", "height", "min-height", "max-height", "flex"]) {
        assert.equal(after.css(selector).getPropertyValue(property), before.css(selector).getPropertyValue(property),
          `${selector} ${property} must not change for ordinary indexed results`);
      }
    }
  } finally { await before.dom.happyDOM.close(); await after.dom.happyDOM.close(); }
});

test("collection header and closed footer share rows without reducing text or native disclosure semantics", async () => {
  const { dom, css } = setup(1440);
  try {
    assert.notEqual(css(".atlas-harvest-progress-summary").flexBasis, "100%", "confirmed counts must not force an extra full-width row");
    assert.equal(css(".atlas-harvest-progress-summary").marginTop, "0px");
    assert.equal(css(".atlas-harvest-footer").display, "grid");
    assert.match(css(".atlas-harvest-footer").gridTemplateColumns, /1fr.*auto/);
    assert.equal(css(".atlas-harvest-footer > .atlas-harvest-actions").marginTop, "0px");
    assert.equal(css(".atlas-harvest-footer > .atlas-harvest-progress-details").marginTop, "0px");
    assert.notEqual(css(".atlas-harvest-progress-details").display, "contents", "native details must continue owning its collapsed contents");
    const details = dom.document.querySelector(".atlas-harvest-progress-details")!;
    details.setAttribute("open", "");
    assert.equal(css(".atlas-harvest-footer > .atlas-harvest-progress-details").gridColumn, "1 / -1", "expanded evidence uses the full card width");
    assert.equal(css(".atlas-harvest-progress-copy > strong").fontSize, "16px");
    assert.equal(css(".atlas-harvest-progress-summary dd").fontSize, "22px");
    assert.equal(css(".atlas-harvest-issue-reason").fontSize, "14px");
  } finally { await dom.happyDOM.close(); }
});
