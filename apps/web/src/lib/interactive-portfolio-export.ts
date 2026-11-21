import { projectResume, type FactBase, type Locale, type ResumeView } from "@better-me/core";
import { buildSkillEvidenceGraph } from "./skill-evidence-graph";

export interface InteractivePortfolioExportOptions {
  factBase: FactBase;
  view: ResumeView;
  locale?: Locale;
  /** Redact direct phone/email by default for safer public sharing. */
  includeContact?: boolean;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeJsonForScript(payload: unknown): string {
  return JSON.stringify(payload).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

/**
 * Export a 100% self-contained, zero-CDN, zero-tracker single-file HTML portfolio
 * combining Foliofarer's dual-mode (Interactive Explorer | Classic CV) and
 * nareshkhatri.dev's tactile skill keycaps — backed exclusively by verified FactBase data.
 */
export function exportInteractivePortfolioHtml({
  factBase,
  view,
  locale: explicitLocale,
  includeContact = false,
}: InteractivePortfolioExportOptions): string {
  const locale = explicitLocale ?? view.locale ?? "zh";
  const isEn = locale === "en";
  const projected = projectResume(factBase, { ...view, locale });
  const graph = buildSkillEvidenceGraph(factBase, { ...view, locale }, locale);

  const visibleTimeline = graph.timeline
    .filter((exp) => exp.includedInResume)
    .map((exp) => ({
      ...exp,
      claims: exp.claims
        .filter((c) => c.includedInResume)
        .map((c) => ({
          claimId: c.claimId,
          text: c.text,
          verifiedMetric: c.metric?.confirmed
            ? `${c.metric.value}${c.metric.unit}${c.metric.baseline ? ` (${c.metric.baseline})` : ""}`
            : undefined,
        })),
    }));

  const visibleSkills = graph.skills
    .map((s) => ({
      id: s.id,
      name: s.name,
      experienceIds: s.experiences.filter((e) => e.includedInResume).map((e) => e.experienceId),
      claimCount: s.experiences
        .filter((e) => e.includedInResume)
        .reduce((sum, e) => sum + e.claims.filter((c) => c.includedInResume).length, 0),
      verifiedMetricCount: s.experiences
        .filter((e) => e.includedInResume)
        .reduce((sum, e) => sum + e.claims.filter((c) => c.includedInResume && c.metric?.confirmed).length, 0),
    }))
    .filter((s) => s.experienceIds.length > 0);

  const contactBits = [
    projected.profile.location,
    projected.profile.education,
    ...(includeContact ? [projected.profile.email, projected.profile.phone] : []),
  ].filter(Boolean) as string[];

  const payload = {
    locale,
    name: projected.profile.displayName || (isEn ? "Career Portfolio" : "个人职业档案"),
    headline: projected.profile.headline || "",
    targetRoles: projected.profile.targetRoles,
    traits: projected.profile.traits,
    contacts: contactBits,
    links: projected.profile.links,
    skills: visibleSkills,
    experiences: visibleTimeline,
  };

  const title = `${payload.name} · ${isEn ? "Interactive Career Portfolio" : "交互式职业档案"}`;

  return `<!doctype html>
<html lang="${isEn ? "en" : "zh-CN"}" data-theme="light" data-motion="full">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root {
    --bg: #f6f6f4; --surface: #ffffff; --surface-soft: #f0f1ee; --border: rgba(15,23,42,0.11);
    --text: #181a1f; --text-2: #4b5563; --muted: #6b7280; --accent: #1b5e4b; --accent-soft: rgba(27,94,75,0.11);
    --font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Segoe UI", sans-serif;
    --font-serif: Georgia, "Songti SC", "Noto Serif SC", serif;
    --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }
  html[data-theme="dark"] {
    --bg: #141517; --surface: #1d1f23; --surface-soft: #262930; --border: rgba(255,255,255,0.12);
    --text: #f3f4f6; --text-2: #cbd5e1; --muted: #94a3b8; --accent: #4ade80; --accent-soft: rgba(74,222,128,0.14);
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--font-sans); line-height: 1.6; }
  .nav { position: sticky; top: 0; z-index: 20; border-bottom: 1px solid var(--border); background: color-mix(in srgb, var(--bg) 86%, transparent); backdrop-filter: blur(18px); }
  .nav-inner { max-width: 1080px; margin: 0 auto; padding: 12px 20px; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
  .brand { font-family: var(--font-serif); font-weight: 700; font-size: 16px; }
  .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .seg { display: inline-flex; padding: 3px; border-radius: 9px; background: var(--surface-soft); border: 1px solid var(--border); gap: 2px; }
  .seg button, .btn { border: 0; border-radius: 7px; padding: 6px 11px; font-size: 12px; font-weight: 600; cursor: pointer; background: transparent; color: var(--text-2); transition: all 120ms ease; }
  .seg button[aria-pressed="true"] { background: var(--surface); color: var(--text); box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .btn { border: 1px solid var(--border); background: var(--surface); color: var(--text); }
  .btn.primary { background: var(--accent); color: #fff; border-color: transparent; }
  html[data-theme="dark"] .btn.primary { color: #052e16; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 28px 20px 64px; }
  .hero { margin-bottom: 24px; padding-bottom: 20px; border-bottom: 1px solid var(--border); }
  .hero h1 { margin: 0 0 8px; font-family: var(--font-serif); font-size: clamp(28px, 4vw, 38px); letter-spacing: -0.025em; }
  .hero p { margin: 0 0 10px; max-width: 68ch; color: var(--text-2); font-size: 14.5px; }
  .meta-row { display: flex; flex-wrap: wrap; gap: 8px 16px; font-size: 12.5px; color: var(--muted); }
  .meta-row a { color: var(--accent); text-decoration: none; }
  .grid { display: grid; grid-template-columns: minmax(0, 0.95fr) minmax(0, 1.05fr); gap: 20px; align-items: start; }
  .panel { border-radius: 16px; background: var(--surface); border: 1px solid var(--border); padding: 18px; }
  .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 14px; font-size: 12px; color: var(--muted); }
  .odometer { font-family: var(--font-mono); padding: 2px 8px; border-radius: 6px; background: var(--surface-soft); color: var(--text); border: 1px solid var(--border); }
  .search { width: 100%; height: 34px; padding: 0 11px; margin-bottom: 12px; border-radius: 9px; border: 1px solid var(--border); background: var(--surface-soft); color: var(--text); font-size: 12.5px; }
  .deck { display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 10px; }
  .keycap { display: flex; flex-direction: column; justify-content: space-between; gap: 8px; min-height: 70px; padding: 10px 11px; border-radius: 12px; border: 1px solid var(--border); background: var(--surface); color: var(--text); text-align: left; cursor: pointer; box-shadow: 0 4px 0 rgba(15,23,42,0.12); transition: transform 90ms ease, box-shadow 90ms ease; }
  .keycap:hover { transform: translateY(1px); box-shadow: 0 3px 0 rgba(15,23,42,0.12); }
  .keycap[aria-pressed="true"] { transform: translateY(3px); box-shadow: 0 1px 0 var(--accent); border-color: var(--accent); background: var(--accent-soft); }
  .keycap strong { font-size: 12.5px; line-height: 1.25; }
  .keycap small { font-family: var(--font-mono); font-size: 10px; color: var(--muted); }
  .exp-card { border-radius: 12px; border: 1px solid var(--border); background: var(--bg); padding: 14px 16px; margin-bottom: 12px; }
  .exp-card:last-child { margin-bottom: 0; }
  .exp-top { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
  .exp-top strong { font-size: 14px; }
  .exp-top span { font-family: var(--font-mono); font-size: 11px; color: var(--muted); }
  .claims { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--text-2); }
  .metric-pill { display: inline-block; margin-left: 6px; padding: 1px 7px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-size: 11px; font-weight: 600; font-family: var(--font-mono); }
  .cv-paper { max-width: 780px; margin: 0 auto; padding: 36px 42px; border-radius: 14px; background: var(--surface); border: 1px solid var(--border); }
  .cv-section { margin-top: 22px; }
  .cv-section h2 { margin: 0 0 10px; padding-bottom: 5px; border-bottom: 1px solid var(--border); font-family: var(--font-serif); font-size: 15px; color: var(--accent); }
  .footer { max-width: 1080px; margin: 0 auto; padding: 16px 20px 40px; font-size: 11.5px; color: var(--muted); display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
  html[data-motion="reduced"] * { transition: none !important; }
  @media (max-width: 820px) { .grid { grid-template-columns: 1fr; } .cv-paper { padding: 24px 20px; } }
  @media print { .nav, .footer, #explorer-view { display: none !important; } #classic-view { display: block !important; } .cv-paper { border: 0; padding: 0; box-shadow: none; } body { background: #fff; color: #111; } }
</style>
</head>
<body>
  <nav class="nav">
    <div class="nav-inner">
      <span class="brand">${escapeHtml(payload.name)}</span>
      <div class="controls">
        <div class="seg" role="group" aria-label="${isEn ? "View mode" : "视图模式"}">
          <button id="btn-explorer" type="button" aria-pressed="true">${isEn ? "Skill Atlas" : "探索图谱"}</button>
          <button id="btn-classic" type="button" aria-pressed="false">${isEn ? "Classic CV" : "经典简历"}</button>
        </div>
        <button id="btn-motion" class="btn" type="button">${isEn ? "Reduce motion" : "减少动效"}</button>
        <button id="btn-theme" class="btn" type="button">${isEn ? "Dark" : "深色"}</button>
        <button id="btn-print" class="btn primary" type="button">${isEn ? "Print / PDF" : "打印 / PDF"}</button>
      </div>
    </div>
  </nav>

  <main class="wrap">
    <section id="explorer-view">
      <header class="hero">
        <h1>${escapeHtml(payload.name)}</h1>
        ${payload.headline ? `<p>${escapeHtml(payload.headline)}</p>` : ""}
        <div class="meta-row">
          ${payload.contacts.map((c) => `<span>${escapeHtml(c)}</span>`).join("")}
          ${payload.links.map((l) => `<a href="${escapeHtml(l.url)}" target="_blank" rel="noreferrer">${escapeHtml(l.label)}</a>`).join("")}
        </div>
      </header>
      <div class="grid">
        <div class="panel">
          <div class="panel-head">
            <span>${isEn ? "Press a skill keycap to trace real project evidence" : "点击技能键帽，追溯真实经历与已核实证据"}</span>
            <span id="odometer" class="odometer">0000</span>
          </div>
          <input id="skill-search" class="search" type="search" placeholder="${isEn ? "Filter skills or keywords..." : "筛选技能或关键词…"}" />
          <div id="skill-deck" class="deck"></div>
        </div>
        <div class="panel">
          <div class="panel-head">
            <strong id="report-title">${isEn ? "All Verified Experiences" : "全部已核实经历"}</strong>
            <button id="btn-reset-skill" class="btn" type="button" style="display:none">${isEn ? "Show all" : "查看全部"}</button>
          </div>
          <div id="evidence-list"></div>
        </div>
      </div>
    </section>

    <section id="classic-view" style="display:none">
      <article class="cv-paper">
        <h1 style="margin:0 0 6px;font-family:var(--font-serif);font-size:28px">${escapeHtml(payload.name)}</h1>
        ${payload.headline ? `<p style="margin:0 0 10px;color:var(--text-2);font-size:13.5px">${escapeHtml(payload.headline)}</p>` : ""}
        <div class="meta-row">${payload.contacts.map((c) => `<span>${escapeHtml(c)}</span>`).join("")}</div>
        ${payload.skills.length ? `<div class="cv-section"><h2>${isEn ? "Skills" : "专业技能"}</h2><p style="margin:0;font-size:13px;color:var(--text-2)">${payload.skills.map((s) => escapeHtml(s.name)).join(" · ")}</p></div>` : ""}
        <div class="cv-section">
          <h2>${isEn ? "Experience & Projects" : "经历与项目"}</h2>
          ${payload.experiences
            .map(
              (exp) => `<div style="margin-bottom:14px">
                <div class="exp-top"><strong>${escapeHtml(exp.org)} · ${escapeHtml(exp.title)}</strong><span>${escapeHtml(exp.period)}</span></div>
                ${exp.claims.length ? `<ul class="claims">${exp.claims.map((c) => `<li>${escapeHtml(c.text)}${c.verifiedMetric ? `<span class="metric-pill">${escapeHtml(c.verifiedMetric)}</span>` : ""}</li>`).join("")}</ul>` : ""}
              </div>`,
            )
            .join("")}
        </div>
      </article>
    </section>
  </main>

  <footer class="footer">
    <span>${isEn ? "Generated locally by BetterMe · Zero trackers · Unverified metrics withheld" : "由 BetterMe 本地生成 · 零追踪脚本 · 未核实指标已自动过滤"}</span>
    <span>${escapeHtml(new Date().toISOString().slice(0, 10))}</span>
  </footer>

  <script>
    const DATA = ${safeJsonForScript(payload)};
    const isEn = DATA.locale === "en";
    let selectedSkill = null;
    let presses = 0;

    const elDeck = document.getElementById("skill-deck");
    const elList = document.getElementById("evidence-list");
    const elTitle = document.getElementById("report-title");
    const elReset = document.getElementById("btn-reset-skill");
    const elOdo = document.getElementById("odometer");
    const elSearch = document.getElementById("skill-search");

    function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

    function renderDeck() {
      const q = (elSearch.value || "").trim().toLowerCase();
      const items = DATA.skills.filter(s => !q || s.name.toLowerCase().includes(q));
      elDeck.innerHTML = items.map(s => {
        const active = selectedSkill && selectedSkill.id === s.id;
        return '<button type="button" class="keycap" data-skill="' + esc(s.id) + '" aria-pressed="' + (active ? "true" : "false") + '">' +
          '<strong>' + esc(s.name) + '</strong>' +
          '<small>' + s.experienceIds.length + (isEn ? 'r · ' : '段 · ') + s.claimCount + (isEn ? 'c' : '条') + '</small>' +
        '</button>';
      }).join("");
      elDeck.querySelectorAll("button.keycap").forEach(btn => {
        btn.addEventListener("click", () => {
          const id = btn.getAttribute("data-skill");
          selectedSkill = (selectedSkill && selectedSkill.id === id) ? null : DATA.skills.find(x => x.id === id) || null;
          presses += 1;
          elOdo.textContent = String(presses).padStart(4, "0");
          renderDeck();
          renderEvidence();
        });
      });
    }

    function renderEvidence() {
      const q = (elSearch.value || "").trim().toLowerCase();
      const allowed = selectedSkill ? new Set(selectedSkill.experienceIds) : null;
      const exps = DATA.experiences.filter(e => {
        if (allowed && !allowed.has(e.experienceId)) return false;
        if (!q) return true;
        return (e.org + " " + e.title + " " + e.claims.map(c => c.text).join(" ")).toLowerCase().includes(q);
      });
      elTitle.textContent = selectedSkill
        ? selectedSkill.name + (isEn ? " · Linked Evidence" : " · 关联真实证据")
        : (isEn ? "All Verified Experiences" : "全部已核实经历");
      elReset.style.display = selectedSkill ? "inline-block" : "none";
      elList.innerHTML = exps.map(e =>
        '<div class="exp-card"><div class="exp-top"><strong>' + esc(e.org) + ' · ' + esc(e.title) + '</strong><span>' + esc(e.period) + '</span></div>' +
        (e.claims.length ? '<ul class="claims">' + e.claims.map(c => '<li>' + esc(c.text) + (c.verifiedMetric ? '<span class="metric-pill">' + esc(c.verifiedMetric) + '</span>' : '') + '</li>').join("") + '</ul>' : '') +
        '</div>'
      ).join("") || '<p style="font-size:13px;color:var(--muted)">' + (isEn ? "No matching records." : "暂无匹配记录。") + '</p>';
    }

    elSearch.addEventListener("input", () => { renderDeck(); renderEvidence(); });
    elReset.addEventListener("click", () => { selectedSkill = null; renderDeck(); renderEvidence(); });

    const btnExp = document.getElementById("btn-explorer");
    const btnCls = document.getElementById("btn-classic");
    const secExp = document.getElementById("explorer-view");
    const secCls = document.getElementById("classic-view");
    btnExp.addEventListener("click", () => { btnExp.setAttribute("aria-pressed","true"); btnCls.setAttribute("aria-pressed","false"); secExp.style.display=""; secCls.style.display="none"; });
    btnCls.addEventListener("click", () => { btnCls.setAttribute("aria-pressed","true"); btnExp.setAttribute("aria-pressed","false"); secCls.style.display=""; secExp.style.display="none"; });

    document.getElementById("btn-theme").addEventListener("click", (e) => {
      const dark = document.documentElement.getAttribute("data-theme") === "dark";
      document.documentElement.setAttribute("data-theme", dark ? "light" : "dark");
      e.currentTarget.textContent = dark ? (isEn ? "Dark" : "深色") : (isEn ? "Light" : "浅色");
    });
    document.getElementById("btn-motion").addEventListener("click", (e) => {
      const reduced = document.documentElement.getAttribute("data-motion") === "reduced";
      document.documentElement.setAttribute("data-motion", reduced ? "full" : "reduced");
      e.currentTarget.setAttribute("aria-pressed", reduced ? "false" : "true");
    });
    document.getElementById("btn-print").addEventListener("click", () => {
      btnCls.click();
      window.print();
    });

    renderDeck();
    renderEvidence();
  </script>
</body>
</html>`;
}
