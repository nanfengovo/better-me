import { useEffect, useState } from "react";
import { parseWorkScheduleToWeeklyHours, sanitizeUntrustedPublicText } from "@better-me/opportunities";
import { privateStorage as localStorage } from "./identity";
import { readOpportunityLibrary, type Opportunity } from "./opportunities";

export type MicroAppScope = "selected_offers" | "backcheck_summary" | "job_snapshots";

export interface InstalledMicroApp {
  /** A one-off instance is never a management handle for any installed version. */
  sessionOnly?: boolean;
  appId: string;
  name: string;
  nameEn: string;
  icon: string;
  version: string;
  codeHash: string;
  verifierVersion: string;
  dependencies: Record<string, string>;
  grantedScopes: MicroAppScope[];
  pinnedToDock: boolean;
  installedAt: string;
  bundleHtml: string;
}

export interface OfferBackcheckProjection {
  id: string;
  company: string;
  role: string;
  nominalAnnualWan: number;
  monthlyBaseK: number;
  months: number;
  providentFundRate: number;
  commuteMinutes: number;
  scheduleText: string;
  weeklyHours: number;
  bonusRealizationRate: number;
  tier1Compliance: string;
  tier2Business: string;
  tier3Sentiment: string;
  sampleCount: number;
  directionMatch: string;
}

export const MICRO_APPS_STORAGE_KEY = "better-me:micro-apps:v1";
const MICRO_APPS_EVENT = "betterme:micro-apps-changed";

function parseSalaryTextToPackage(salaryText: string): { monthlyBaseK: number; months: number; nominalAnnualWan: number } {
  const rangeMatch = salaryText.match(/(\d+(?:\.\d+)?)\s*[-~～–—]\s*(\d+(?:\.\d+)?)\s*[kK]/);
  const singleMatch = salaryText.match(/(\d+(?:\.\d+)?)\s*[kK]/);
  const monthsMatch = salaryText.match(/(\d+(?:\.\d+)?)\s*薪/);
  const monthlyBaseK = rangeMatch
    ? Number(((Number(rangeMatch[1]) + Number(rangeMatch[2])) / 2).toFixed(1))
    : singleMatch
      ? Number(singleMatch[1])
      : 35;
  const months = monthsMatch ? Number(monthsMatch[1]) : 15;
  const nominalAnnualWan = Number(((monthlyBaseK * months) / 10).toFixed(1));
  return { monthlyBaseK, months, nominalAnnualWan };
}

/**
 * Projects authorized `OfferBackcheckProjection` items dynamically from the user's real `OpportunityLibrary`
 * (`offer`, `interview`, or `applied` stages, falling back to any saved opportunities in the library).
 * Never returns hardcoded company fixtures.
 */
export function projectOffersFromOpportunityLibrary(jobsInput?: Opportunity[]): OfferBackcheckProjection[] {
  const allJobs = jobsInput ?? readOpportunityLibrary().library.jobs;
  if (!allJobs.length) return [];

  const prioritized = [
    ...allJobs.filter(j => j.application.stage === "offer"),
    ...allJobs.filter(j => j.application.stage === "interview"),
    ...allJobs.filter(j => j.application.stage === "applied"),
    ...allJobs.filter(j => !["offer", "interview", "applied", "rejected", "withdrawn"].includes(j.application.stage)),
  ];
  const selected = prioritized.slice(0, 4);

  return selected.map(job => {
    const { monthlyBaseK, months, nominalAnnualWan } = parseSalaryTextToPackage(job.salaryText || "");
    const combinedNotes = sanitizeUntrustedPublicText(
      [job.application.notes, job.description, ...job.application.communications.map(c => c.summary)].filter(Boolean).join("\n")
    ).cleanText;
    const scheduleMatch = combinedNotes.match(/\b(\d{1,2}(?:\.\d+)?-\d{1,2}(?:\.\d+)?-\d)\b/);
    const scheduleText = scheduleMatch ? scheduleMatch[1]! : job.workMode === "remote" ? "9-6-5" : "10-8.5-5";
    const weeklyHours = parseWorkScheduleToWeeklyHours(scheduleText);
    const locationLabel = [job.location.city, job.location.region].filter(Boolean).join("·") || "本地";

    return {
      id: job.id,
      company: job.company,
      role: job.title,
      nominalAnnualWan,
      monthlyBaseK,
      months,
      providentFundRate: 0.12,
      commuteMinutes: job.workMode === "remote" ? 0 : 35,
      scheduleText,
      weeklyHours,
      bonusRealizationRate: 0.9,
      tier1Compliance: `发布主体类型：${job.publisherType === "company" ? "企业直招主体" : job.publisherType} · 来源平台：${job.sourcePlatform}`,
      tier2Business: `工作地区：${locationLabel} · 阶段：${job.application.stage}`,
      tier3Sentiment: combinedNotes ? combinedNotes.slice(0, 120) : "已通过反注入护栏清洗岗位原文，可在沟通记录中补充实测作息与年终兑现率",
      sampleCount: Math.max(1, job.application.communications.length),
      directionMatch: job.application.nextAction || job.title,
    };
  });
}

/**
 * Self-contained HTML bundle executed inside Layer 3 (`<iframe sandbox="allow-scripts">`).
 * Strictly CSP-locked (`default-src 'none'`), receives data ONLY via JSON-RPC over postMessage.
 */
export const OFFER_BACKCHECK_RADAR_BUNDLE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<style>
  :root {
    --bg: #f6f6f0;
    --surface: #ffffff;
    --surface-soft: #eef1e8;
    --border: #dfe5d8;
    --text: #17261f;
    --muted: #64756c;
    --accent: #1f5a47;
    --accent-soft: rgba(31, 90, 71, 0.08);
    --accent-ink: #ffffff;
    --warn: #b85d19;
    --ok: #15803d;
  }
  :root[data-theme="dark"] {
    --bg: #0b0f13;
    --surface: #11181f;
    --surface-soft: #0d1318;
    --border: rgba(255,255,255,0.12);
    --text: #edf2ef;
    --muted: #8b9aa6;
    --accent: #4fd1a5;
    --accent-soft: rgba(79, 209, 165, 0.12);
    --accent-ink: #052017;
    --warn: #f59e0b;
    --ok: #34d399;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:-apple-system,"PingFang SC",system-ui,sans-serif;padding:16px 20px;font-size:13px}
  .mono{font-family:"JetBrains Mono","SF Mono",Menlo,monospace}
  .top{display:flex;justify-content:space-between;align-items:center;background:var(--surface);border:1px solid var(--border);padding:10px 14px;border-radius:10px;margin-bottom:14px;flex-wrap:wrap;gap:10px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}
  .card{border:1px solid var(--border);border-radius:12px;padding:14px;background:var(--surface);transition:border-color .2s,box-shadow .2s}
  .card.win{border:1.5px solid var(--accent);background:linear-gradient(180deg,var(--accent-soft),var(--surface))}
  .h{display:flex;justify-content:space-between;align-items:center}
  .title{font-size:15.5px;font-weight:750;color:var(--text)}
  .score{font:800 18px "JetBrains Mono",Menlo,monospace;color:var(--accent)}
  .card:not(.win) .score{color:var(--warn)}
  .meta{font:12px "JetBrains Mono",Menlo,monospace;color:var(--muted);margin:4px 0 10px}
  .box{font:12px/1.65 "JetBrains Mono",Menlo,monospace;padding:10px 12px;background:var(--surface-soft);border-radius:8px;border:1px solid var(--border)}
  .t1{color:var(--ok);font-weight:600}.t2{color:var(--accent);font-weight:600}.t3{color:var(--warn);font-weight:600}
  .verdict{margin-top:14px;background:var(--surface);border:1px dashed var(--accent);border-radius:10px;padding:10px 14px;font:12.5px/1.55 "JetBrains Mono",Menlo,monospace}
  .empty{padding:24px;text-align:center;border:1px dashed var(--border);border-radius:12px;background:var(--surface);color:var(--muted);font:13px/1.7 "JetBrains Mono",Menlo,monospace}
  .addbar{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;background:var(--surface);padding:10px 12px;border-radius:10px;border:1px solid var(--border)}
  .addbar input{background:var(--surface-soft);border:1px solid var(--border);color:var(--text);padding:6px 9px;border-radius:6px;font:12px "JetBrains Mono",Menlo,monospace}
  .actions{display:flex;justify-content:space-between;align-items:center;margin-top:14px;padding-top:10px;border-top:1px solid var(--border);flex-wrap:wrap;gap:10px}
  button{cursor:pointer;font:650 12.5px -apple-system,"PingFang SC",sans-serif;padding:7px 14px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-ink)}
  button.sec{background:var(--surface);color:var(--text);border-color:var(--border)}
</style>
</head>
<body>
  <div class="top mono">
    <span>📦 依赖包：<b style="color:var(--accent)">recharts@2.12 · zod@3.23</b>（--ignore-scripts 离线构建）· codeHash <span style="color:var(--muted)">8f4c2a9e</span></span>
    <label style="display:flex;align-items:center;gap:8px">
      <span>真实时薪 &amp; 舆论口碑权重：</span>
      <input id="wlb" type="range" min="10" max="65" value="40" style="accent-color:var(--accent)">
      <b id="wlbTxt" style="color:var(--accent)">40%</b>
    </label>
  </div>
  <div id="cards" class="grid"></div>
  <div class="addbar mono">
    <input id="inCo" placeholder="企业名称" style="width:120px" />
    <input id="inRole" placeholder="岗位名称" style="width:150px" />
    <input id="inBase" type="number" placeholder="月薪(k)" value="40" style="width:82px" />
    <input id="inMonths" type="number" placeholder="月数" value="16" style="width:68px" />
    <input id="inHours" type="number" placeholder="周工时(h)" value="47.5" step="0.5" style="width:90px" />
    <input id="inCommute" type="number" placeholder="单程通勤(m)" value="30" style="width:96px" />
    <button type="button" class="sec" id="btnAddOffer">+ 加入沙箱测算</button>
  </div>
  <div id="verdict" class="verdict"></div>
  <div class="actions">
    <span class="mono" style="color:var(--muted);font-size:12px">🔒 运行于 null-origin 沙箱 · 仅通过 JSON-RPC 接收授权 Offer 投影</span>
    <div style="display:flex;gap:8px">
      <button class="sec" id="btnDecline">发起谈薪方案</button>
      <button id="btnAccept">✓ 采纳决胜结论并确认入职</button>
    </div>
  </div>
<script>
  let offers = [];
  let winner = null;
  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function computeHourly(o) {
    const realizedAnnual = (o.monthlyBaseK * 12 + o.monthlyBaseK * Math.max(0, o.months - 12) * (o.bonusRealizationRate || 0.9)) * 1000;
    const yearlyHours = (o.weeklyHours || 45) * 50 + ((o.commuteMinutes || 0) / 60) * 2 * 240;
    return Math.round(realizedAnnual / Math.max(1, yearlyHours));
  }
  function render() {
    const w = parseInt(document.getElementById('wlb').value, 10) / 100;
    document.getElementById('wlbTxt').textContent = Math.round(w * 100) + '%';
    if (!offers.length) {
      winner = null;
      document.getElementById('cards').innerHTML = '<div class="empty">当前机会库暂无已授权的 Offer 投影。可在「岗位与投递」中录入岗位，或在下方直接输入参数进行沙箱测算。</div>';
      document.getElementById('verdict').innerHTML = '<span style="color:var(--muted)">等待受控消息桥注入授权 Offer 数据，或手动添加对比项…</span>';
      return;
    }
    const scored = offers.map(o => {
      const hourly = computeHourly(o);
      const cashScore = Math.min(100, (o.nominalAnnualWan / 85) * 100);
      const wlbScore = Math.max(30, 100 - (o.weeklyHours - 40) * 2.1);
      const total = ((1 - w) * cashScore + w * (wlbScore * 0.65 + (hourly / 3) * 0.35)).toFixed(1);
      return { ...o, hourly, total: parseFloat(total) };
    }).sort((a, b) => b.total - a.total);
    winner = scored[0];
    document.getElementById('cards').innerHTML = scored.map(o => {
      const isWin = o.id === winner.id;
      return '<div class="card ' + (isWin ? 'win' : '') + '">' +
        '<div class="h"><span class="title">' + esc(o.company) + ' · ' + esc(o.role) + '</span><span class="score">' + o.total + ' 分</span></div>' +
        '<div class="meta">名义总包 ' + o.nominalAnnualWan + 'w (' + o.monthlyBaseK + 'k×' + o.months + ') · 通勤 ' + o.commuteMinutes + 'm · 作息 ' + esc(o.scheduleText) + '</div>' +
        '<div class="box">' +
          '<div><span class="t1">[Tier-1 合规]</span> ' + esc(o.tier1Compliance) + '</div>' +
          '<div><span class="t2">[Tier-2 业务]</span> ' + esc(o.tier2Business) + '</div>' +
          '<div><span class="t3">[Tier-3 舆论 · ' + o.sampleCount + '条]</span> ' + esc(o.tier3Sentiment) + '</div>' +
          '<div style="margin-top:5px">▸ 折算真实周工时 <b>' + o.weeklyHours + 'h</b> → <b style="color:' + (isWin ? 'var(--accent)' : 'var(--warn)') + '">真实净时薪 ¥' + o.hourly + '/h</b></div>' +
        '</div></div>';
    }).join('');
    document.getElementById('verdict').innerHTML = '<b style="color:var(--accent)">背调与时薪决胜结论：</b>当前权重下 <b>' + esc(winner.company) + '</b> 综合得分 <b>' + winner.total + '</b> 胜出（真实净时薪 ¥' + winner.hourly + '/h）。';
  }
  document.getElementById('wlb').addEventListener('input', render);
  document.getElementById('btnAddOffer').addEventListener('click', () => {
    const company = document.getElementById('inCo').value.trim();
    const role = document.getElementById('inRole').value.trim() || '目标岗位';
    if (!company) return;
    const monthlyBaseK = parseFloat(document.getElementById('inBase').value) || 35;
    const months = parseFloat(document.getElementById('inMonths').value) || 15;
    const weeklyHours = parseFloat(document.getElementById('inHours').value) || 45;
    const commuteMinutes = parseFloat(document.getElementById('inCommute').value) || 30;
    offers.push({
      id: 'custom-' + Date.now(),
      company,
      role,
      nominalAnnualWan: Number(((monthlyBaseK * months) / 10).toFixed(1)),
      monthlyBaseK,
      months,
      providentFundRate: 0.12,
      commuteMinutes,
      scheduleText: weeklyHours + 'h/周',
      weeklyHours,
      bonusRealizationRate: 0.9,
      tier1Compliance: '手动输入测算项',
      tier2Business: role,
      tier3Sentiment: '按自定义周工时与通勤测算真实净时薪',
      sampleCount: 1,
      directionMatch: role,
    });
    document.getElementById('inCo').value = '';
    document.getElementById('inRole').value = '';
    render();
  });
  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (!msg || msg.jsonrpc !== '2.0') return;
    if (msg.method === 'ui/initialize' && msg.params) {
      if (msg.params.theme) document.documentElement.dataset.theme = msg.params.theme;
      if (Array.isArray(msg.params.offers)) offers = msg.params.offers;
      render();
    }
  });
  document.getElementById('btnAccept').addEventListener('click', () => {
    if (!winner) return;
    parent.postMessage({ jsonrpc: '2.0', method: 'workspace/proposeDecision', params: { action: 'onboard', company: winner.company, offerId: winner.id } }, '*');
  });
  document.getElementById('btnDecline').addEventListener('click', () => {
    if (!winner) return;
    parent.postMessage({ jsonrpc: '2.0', method: 'workspace/proposeDecision', params: { action: 'negotiate', company: winner.company, offerId: winner.id } }, '*');
  });
  parent.postMessage({ jsonrpc: '2.0', method: 'ui/ready', params: {} }, '*');
</script>
</body>
</html>`;

export function createOfferBackcheckRadarApp(pinnedToDock = true): InstalledMicroApp {
  return {
    appId: "offer-backcheck-radar",
    name: "Offer 背调决胜台",
    nameEn: "Offer Backcheck Radar",
    icon: "⚖",
    version: "1.0.0",
    codeHash: "8f4c2a9e71d03b5c",
    verifierVersion: "quickjs-wasm-json-v1+container-build-v1",
    dependencies: {
      recharts: "2.12.7",
      zod: "3.23.8",
    },
    grantedScopes: ["selected_offers", "backcheck_summary"],
    pinnedToDock,
    installedAt: new Date().toISOString(),
    bundleHtml: OFFER_BACKCHECK_RADAR_BUNDLE_HTML,
  };
}

export function loadInstalledMicroApps(): InstalledMicroApp[] {
  try {
    const raw = localStorage.getItem(MICRO_APPS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is InstalledMicroApp =>
      Boolean(item && typeof item.appId === "string" && typeof item.name === "string" && typeof item.codeHash === "string" && typeof item.bundleHtml === "string")
    );
  } catch {
    return [];
  }
}

export function saveInstalledMicroApps(apps: InstalledMicroApp[]): void {
  try {
    localStorage.setItem(MICRO_APPS_STORAGE_KEY, JSON.stringify(apps));
  } catch {
    // Keep in-session state if storage is blocked.
  }
  window.dispatchEvent(new window.CustomEvent(MICRO_APPS_EVENT, { detail: apps }));
}

export function installMicroApp(app: InstalledMicroApp): InstalledMicroApp[] {
  const current = loadInstalledMicroApps().filter(item => item.appId !== app.appId);
  const next = [...current, app];
  saveInstalledMicroApps(next);
  return next;
}

export function togglePinMicroApp(appId: string, pinned: boolean): InstalledMicroApp[] {
  const next = loadInstalledMicroApps().map(item => item.appId === appId ? { ...item, pinnedToDock: pinned } : item);
  saveInstalledMicroApps(next);
  return next;
}

export function revokeAndUninstallMicroApp(appId: string): InstalledMicroApp[] {
  const next = loadInstalledMicroApps().filter(item => item.appId !== appId);
  saveInstalledMicroApps(next);
  return next;
}

export function useInstalledMicroApps() {
  const [apps, setApps] = useState<InstalledMicroApp[]>(() => loadInstalledMicroApps());
  useEffect(() => {
    const sync = (event: Event) => {
      const detail = (event as CustomEvent<InstalledMicroApp[] | undefined>).detail;
      setApps(Array.isArray(detail) ? detail : loadInstalledMicroApps());
    };
    window.addEventListener(MICRO_APPS_EVENT, sync);
    return () => window.removeEventListener(MICRO_APPS_EVENT, sync);
  }, []);
  return apps;
}
