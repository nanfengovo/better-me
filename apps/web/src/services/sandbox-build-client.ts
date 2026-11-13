import { z } from "zod";
import { agentOrigin, captureIdentityLease, ownedFetch } from "../lib/identity";
import { readRuntimeConnection } from "../lib/runtime-connection";
import { installMicroApp, type InstalledMicroApp, type MicroAppScope } from "../lib/micro-app-registry";

export interface SandboxBuildInput {
  appId: string;
  name: string;
  nameEn?: string;
  icon?: string;
  version?: string;
  description?: string;
  grantedScopes: MicroAppScope[];
  sourceCode: string;
  customCss?: string;
  htmlBody?: string;
  dependencies?: string[];
  syntheticMockData?: unknown;
}

export interface SandboxVerificationCheck {
  id: string;
  name: string;
  passed: boolean;
  detail: string;
}

export interface SandboxVerificationResult {
  profile?: string;
  passed: boolean;
  timestamp: string;
  checks: SandboxVerificationCheck[];
}

export interface BuiltMicroAppArtifact extends InstalledMicroApp {
  description: string;
  compiledAt: string;
  verification: SandboxVerificationResult;
}

export interface MicroAppTemplate {
  name: string;
  nameEn: string;
  icon: string;
  version: string;
  description: string;
  grantedScopes: MicroAppScope[];
  htmlBody: string;
  customCss: string;
  sourceCode: string;
}

/**
 * Built-in templates selected manually. The Host checks the entire template against its release pins.
 */
export const PRESET_MICRO_APP_TEMPLATES: Record<string, MicroAppTemplate> = {
  "offer-backcheck-radar": {
    name: "Offer 背调与时薪决胜台",
    nameEn: "Offer Backcheck & Hourly Salary Radar",
    icon: "⚖",
    version: "1.0.0",
    description: "多维度真实作息时薪折算、企业 Tier 1/2/3 舆情交叉合规背调与最终入职决胜台。",
    grantedScopes: ["selected_offers", "backcheck_summary"],
    htmlBody: `
  <div class="top mono">
    <span>📦 依赖包：<b style="color:var(--accent)">recharts@2.12 · zod@3.23</b>（--ignore-scripts 离线构建）· codeHash <span id="chash" style="color:var(--muted)">bbf68f61</span></span>
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
`,
    customCss: `
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
    `,
    sourceCode: `
(() => {
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
    const wEl = document.getElementById('wlb');
    const w = wEl ? parseInt(wEl.value, 10) / 100 : 0.4;
    const wTxt = document.getElementById('wlbTxt');
    if (wTxt) wTxt.textContent = Math.round(w * 100) + '%';
    const cardsEl = document.getElementById('cards');
    const verdictEl = document.getElementById('verdict');
    if (!cardsEl || !verdictEl) return;
    if (!offers.length) {
      cardsEl.innerHTML = '<div class="empty">当前机会库暂无已授权的 Offer 投影。可在「岗位与投递」中录入岗位，或在下方直接输入参数进行沙箱测算。</div>';
      verdictEl.innerHTML = '<span style="color:var(--muted)">等待受控消息桥注入授权 Offer 数据，或手动添加对比项…</span>';
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
    cardsEl.innerHTML = scored.map(o => {
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
    verdictEl.innerHTML = '<b style="color:var(--accent)">背调与时薪决胜结论：</b>当前权重下 <b>' + esc(winner.company) + '</b> 综合得分 <b>' + winner.total + '</b> 胜出（真实净时薪 ¥' + winner.hourly + '/h）。';
  }

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (!msg || msg.jsonrpc !== '2.0') return;
    if (msg.method === 'ui/initialize' && msg.params) {
      if (msg.params.theme) document.documentElement.dataset.theme = msg.params.theme;
      if (Array.isArray(msg.params.offers)) offers = msg.params.offers;
      render();
    }
  });

  const start = () => {
    const wlb = document.getElementById('wlb');
    if (wlb) wlb.addEventListener('input', render);
    const addBtn = document.getElementById('btnAddOffer');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        const coEl = document.getElementById('inCo');
        const roleEl = document.getElementById('inRole');
        const baseEl = document.getElementById('inBase');
        const monthsEl = document.getElementById('inMonths');
        const hoursEl = document.getElementById('inHours');
        const commuteEl = document.getElementById('inCommute');
        if (!coEl || !coEl.value.trim()) return;
        const monthlyBaseK = parseFloat(baseEl?.value || '40') || 40;
        const months = parseFloat(monthsEl?.value || '16') || 16;
        const weeklyHours = parseFloat(hoursEl?.value || '47.5') || 47.5;
        const commuteMinutes = parseFloat(commuteEl?.value || '30') || 30;
        offers.push({
          id: 'custom-' + Date.now(),
          company: coEl.value.trim(),
          role: roleEl?.value.trim() || '目标岗位',
          nominalAnnualWan: Number(((monthlyBaseK * months) / 10).toFixed(1)),
          monthlyBaseK,
          months,
          providentFundRate: 0.12,
          commuteMinutes,
          scheduleText: weeklyHours + 'h/周',
          weeklyHours,
          bonusRealizationRate: 0.9,
          tier1Compliance: '手动录入测算项',
          tier2Business: roleEl?.value.trim() || '目标岗位',
          tier3Sentiment: '已启用沙箱本地时薪精算引擎',
          sampleCount: 1,
          directionMatch: '高精度适配',
        });
        coEl.value = '';
        if (roleEl) roleEl.value = '';
        render();
      });
    }
    const btnAccept = document.getElementById('btnAccept');
    if (btnAccept) {
      btnAccept.addEventListener('click', () => {
        if (!winner) return;
        parent.postMessage({ jsonrpc: '2.0', method: 'workspace/proposeDecision', params: { action: 'onboard', company: winner.company, offerId: winner.id } }, '*');
      });
    }
    const btnDecline = document.getElementById('btnDecline');
    if (btnDecline) {
      btnDecline.addEventListener('click', () => {
        if (!winner) return;
        parent.postMessage({ jsonrpc: '2.0', method: 'workspace/proposeDecision', params: { action: 'negotiate', company: winner.company, offerId: winner.id } }, '*');
      });
    }
    render();
    parent.postMessage({ jsonrpc: '2.0', method: 'ui/ready', params: {} }, '*');
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
`,
  },

  "star-prompter": {
    name: "STAR 实时面试提词与追问防线",
    nameEn: "STAR Realtime Prompter & Defense Tree",
    icon: "🎙",
    version: "1.1.0",
    description: "结构化拆解情境(S)、任务(T)、行动(A)、成果(R)，实时预警深水区技术追问陷阱。",
    grantedScopes: ["selected_offers"],
    htmlBody: `
  <div class="tabs">
    <button class="star-tab-btn active" data-tab="S">S · 情境 (Situation)</button>
    <button class="star-tab-btn" data-tab="T">T · 任务 (Task)</button>
    <button class="star-tab-btn" data-tab="A">A · 行动 (Action)</button>
    <button class="star-tab-btn" data-tab="R">R · 成果 (Result)</button>
  </div>
  <div id="star-content"></div>
`,
    customCss: `
      .tabs{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap}
      .star-tab-btn{cursor:pointer;padding:8px 16px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text);font:700 13px "JetBrains Mono",monospace;transition:all .2s}
      .star-tab-btn.active{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
      .star-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px}
      .star-badge{font:750 14px "JetBrains Mono",monospace;color:var(--accent);margin-bottom:8px}
      .star-text{font-size:13.5px;line-height:1.7;margin-bottom:14px;color:var(--text)}
      .defense-zone{background:var(--surface-soft);border:1px dashed var(--accent);border-radius:10px;padding:12px;font-size:12px}
      .defense-q{color:var(--warn);font-weight:600;margin:6px 0 4px}
      .defense-a{color:var(--muted);line-height:1.6}
    `,
    sourceCode: `
(() => {
  let activeTab = 'S';
  const tabs = {
    S: { title: 'Situation 情境', content: '高并发仓储自动化中枢 (RCS) 在多机抢道时偶发死锁，调度吞吐骤降 32%。' },
    T: { title: 'Task 任务', content: '负责核心调度引擎重构，需在 0 停机与纳秒级锁粒度约束下消解死锁瓶颈。' },
    A: { title: 'Action 行动', content: '采用无锁分段通道设计，拆解为拓扑前向依赖图与环路动态探测，引入 SIMD 批量权重。' },
    R: { title: 'Result 成果', content: '死锁率降至 0，单节点吞吐提升 4.2x，99.9 分位调度延迟压降至 1.8ms。' }
  };
  function render() {
    const container = document.getElementById('star-content');
    if (!container) return;
    const cur = tabs[activeTab];
    container.innerHTML = '<div class="star-card">' +
      '<div class="star-badge">' + cur.title + '</div>' +
      '<div class="star-text">' + cur.content + '</div>' +
      '<div class="defense-zone">' +
        '<b>🛡 考官高频追问防线：</b>' +
        '<div class="defense-q">「如果网络分区导致分段拓扑图出现脑裂，如何保证状态机一致性？」</div>' +
        '<div class="defense-a">✦ 预置防御话术：采用 Raft 租约预锁定 + 本地时间单调序列号防回溯，FB-02 详载容灾断言。</div>' +
      '</div>' +
    '</div>';
    document.querySelectorAll('.star-tab-btn').forEach(btn => {
      if (btn.getAttribute('data-tab') === activeTab) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }
  window.addEventListener('message', (ev) => {
    if (ev.data && ev.data.method === 'ui/initialize' && ev.data.params?.theme) {
      document.documentElement.dataset.theme = ev.data.params.theme;
    }
  });
  const start = () => {
    document.querySelectorAll('.star-tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.target;
        activeTab = (target && target.getAttribute('data-tab')) || 'S';
        render();
      });
    });
    render();
    parent.postMessage({ jsonrpc: '2.0', method: 'ui/ready', params: {} }, '*');
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
`,
  },

  "tax-fund-calculator": {
    name: "多维度五险一金与税后精算器",
    nameEn: "Tax & Provident Fund Precision Calculator",
    icon: "🧮",
    version: "1.0.2",
    description: "依据一线城市最新公积金基数上限、年终奖单独计税与综合计税最优解，折算真实月到手。",
    grantedScopes: ["selected_offers"],
    htmlBody: `
  <div class="calc-box mono">
    <div style="font-weight:750;font-size:14px;margin-bottom:12px;border-bottom:1px solid var(--border);padding-bottom:6px">🧮 薪酬税后净到手测算器 (扣除五险一金与个税)</div>
    <div class="input-group">
      <div class="input-field">
        <label>月薪 (Base / 元)</label>
        <input id="inBaseSalary" type="number" value="42000" step="1000" />
      </div>
      <div class="input-field">
        <label>预估年终奖 (元)</label>
        <input id="inBonus" type="number" value="160000" step="5000" />
      </div>
    </div>
    <div id="calc-result"></div>
  </div>
`,
    customCss: `
      .calc-box{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;max-width:560px}
      .input-group{display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap}
      .input-field{flex:1;min-width:180px}
      .input-field label{display:block;font-size:11px;color:var(--muted);margin-bottom:4px}
      .input-field input{width:100%;box-sizing:border-box;background:var(--surface-soft);border:1px solid var(--border);color:var(--text);padding:8px 10px;border-radius:8px;font:700 13px "JetBrains Mono",monospace}
      .calc-row{display:flex;justify-content:space-between;align-items:center;padding:7px 0;font:12.5px "JetBrains Mono",monospace;color:var(--text)}
      .calc-row.divider{border-top:1px dashed var(--border);margin-top:6px;padding-top:10px}
      .highlight{color:var(--accent);font-size:15.5px;font-weight:800}
    `,
    sourceCode: `
(() => {
  let baseSalary = 42000;
  let bonus = 160000;
  function calculate() {
    const fundBase = Math.min(baseSalary, 36549);
    const pension = fundBase * 0.08;
    const medical = fundBase * 0.02;
    const fund = fundBase * 0.07;
    const personalSocial = pension + medical + fund;
    const taxableMonthly = Math.max(0, baseSalary - personalSocial - 5000);
    let tax = 0;
    if (taxableMonthly > 35000) tax = taxableMonthly * 0.3 - 2520;
    else if (taxableMonthly > 25000) tax = taxableMonthly * 0.25 - 1005;
    else if (taxableMonthly > 12000) tax = taxableMonthly * 0.2 - 1410;
    else tax = taxableMonthly * 0.1 - 210;
    const netMonthly = Math.round(baseSalary - personalSocial - Math.max(0, tax));
    const netYearly = Math.round(netMonthly * 12 + bonus * 0.85);
    const resEl = document.getElementById('calc-result');
    if (resEl) {
      resEl.innerHTML = '<div class="calc-row"><span>月度税前薪酬：</span><b>¥' + baseSalary.toLocaleString() + '</b></div>' +
        '<div class="calc-row"><span>个人五险一金扣除 (17%)：</span><b style="color:var(--warn)">-¥' + Math.round(personalSocial).toLocaleString() + '</b></div>' +
        '<div class="calc-row"><span>预估个人所得税：</span><b style="color:var(--warn)">-¥' + Math.round(tax).toLocaleString() + '</b></div>' +
        '<div class="calc-row divider"><span>真实月度税后到手现金：</span><b class="highlight">¥' + netMonthly.toLocaleString() + '</b></div>' +
        '<div class="calc-row"><span>年终奖 (单计约 15% 税率)：</span><b>¥' + Math.round(bonus * 0.85).toLocaleString() + '</b></div>' +
        '<div class="calc-row divider"><span style="font-weight:700">全年实际税后纯现金流入：</span><b class="highlight" style="font-size:18px">¥' + netYearly.toLocaleString() + '</b></div>';
    }
  }
  window.addEventListener('message', (ev) => {
    if (ev.data && ev.data.method === 'ui/initialize' && ev.data.params?.theme) {
      document.documentElement.dataset.theme = ev.data.params.theme;
    }
  });
  const start = () => {
    const inB = document.getElementById('inBaseSalary');
    const inBon = document.getElementById('inBonus');
    if (inB) inB.addEventListener('input', (e) => { baseSalary = parseFloat(e.target.value) || 0; calculate(); });
    if (inBon) inBon.addEventListener('input', (e) => { bonus = parseFloat(e.target.value) || 0; calculate(); });
    calculate();
    parent.postMessage({ jsonrpc: '2.0', method: 'ui/ready', params: {} }, '*');
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
`,
  },

  "equity-options-calculator": {
    name: "期权估值与行权测算器",
    nameEn: "Equity Options & Vesting Calculator",
    icon: "📈",
    version: "1.0.0",
    description: "4年归属周期 (1年Cliff 25%)、行权成本与潜在行权收益税前/税后深度测算。",
    grantedScopes: ["selected_offers"],
    htmlBody: `
  <div class="calc-box mono">
    <div class="h-title">📈 员工期权估值与归属测算模型 (ESOP Vesting Model)</div>
    <div class="input-grid">
      <div class="input-field">
        <label>授予总期权股数 (Shares)</label>
        <input id="inTotalShares" type="number" value="20000" step="1000" />
      </div>
      <div class="input-field">
        <label>行权价格 (Strike Price / ¥)</label>
        <input id="inStrike" type="number" value="2.5" step="0.5" />
      </div>
      <div class="input-field">
        <label>当前预估公允价值 (FMV / ¥)</label>
        <input id="inFmv" type="number" value="12.0" step="0.5" />
      </div>
      <div class="input-field">
        <label>已工作月数 (0~48月)</label>
        <input id="inMonthsWorked" type="number" value="18" min="0" max="48" />
      </div>
    </div>
    <div id="option-results" class="results-box"></div>
  </div>
`,
    customCss: `
      .calc-box{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;max-width:620px}
      .h-title{font-size:14px;font-weight:750;color:var(--text);margin-bottom:14px;border-bottom:1px solid var(--border);padding-bottom:8px}
      .input-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:16px}
      .input-field label{display:block;font-size:11px;color:var(--muted);margin-bottom:4px}
      .input-field input{width:100%;box-sizing:border-box;background:var(--surface-soft);border:1px solid var(--border);color:var(--text);padding:7px 10px;border-radius:8px;font:700 13px "JetBrains Mono",monospace}
      .results-box{background:var(--surface-soft);border:1px solid var(--border);border-radius:10px;padding:14px}
      .calc-row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;font:12.5px "JetBrains Mono",monospace;color:var(--text)}
      .calc-row.divider{border-top:1px dashed var(--border);margin-top:6px;padding-top:10px}
      .highlight{color:var(--accent);font-size:16px;font-weight:800}
    `,
    sourceCode: `
(() => {
  let totalShares = 20000;
  let strike = 2.5;
  let fmv = 12.0;
  let monthsWorked = 18;

  function calculate() {
    let vestedShares = 0;
    if (monthsWorked >= 12) {
      vestedShares = Math.round(totalShares * (monthsWorked / 48));
    }
    const exerciseCost = Math.round(vestedShares * strike);
    const grossValue = Math.round(vestedShares * fmv);
    const netGain = Math.max(0, grossValue - exerciseCost);
    const fullNetGain = Math.max(0, Math.round(totalShares * (fmv - strike)));

    const res = document.getElementById('option-results');
    if (res) {
      res.innerHTML = '<div class="calc-row"><span>已归属股数 (Vested)：</span><b>' + vestedShares.toLocaleString() + ' / ' + totalShares.toLocaleString() + ' 股 (' + Math.round((vestedShares/totalShares)*100) + '%)</b></div>' +
        '<div class="calc-row"><span>已归属行权总成本：</span><b style="color:var(--warn)">¥' + exerciseCost.toLocaleString() + '</b></div>' +
        '<div class="calc-row"><span>已归属总公允账面价值：</span><b>¥' + grossValue.toLocaleString() + '</b></div>' +
        '<div class="calc-row divider"><span>当前已归属净收益 (税前浮盈)：</span><b class="highlight">¥' + netGain.toLocaleString() + '</b></div>' +
        '<div class="calc-row divider"><span style="font-weight:700">4年全量归属后潜在浮盈：</span><b class="highlight" style="font-size:18px">¥' + fullNetGain.toLocaleString() + '</b></div>';
    }
  }

  window.addEventListener('message', (ev) => {
    if (ev.data && ev.data.method === 'ui/initialize' && ev.data.params?.theme) {
      document.documentElement.dataset.theme = ev.data.params.theme;
    }
  });

  const start = () => {
    const inTotal = document.getElementById('inTotalShares');
    const inStr = document.getElementById('inStrike');
    const inF = document.getElementById('inFmv');
    const inM = document.getElementById('inMonthsWorked');
    if (inTotal) inTotal.addEventListener('input', (e) => { totalShares = parseFloat(e.target.value) || 0; calculate(); });
    if (inStr) inStr.addEventListener('input', (e) => { strike = parseFloat(e.target.value) || 0; calculate(); });
    if (inF) inF.addEventListener('input', (e) => { fmv = parseFloat(e.target.value) || 0; calculate(); });
    if (inM) inM.addEventListener('input', (e) => { monthsWorked = parseInt(e.target.value, 10) || 0; calculate(); });
    calculate();
    parent.postMessage({ jsonrpc: '2.0', method: 'ui/ready', params: {} }, '*');
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
`,
  },
};

/** Only the owner's running Host can issue a verification result for a reviewed preset. */
const presetAudit = z.object({ profile:z.literal("reviewed-builtin-v2"), passed:z.boolean(), timestamp:z.string().min(1), checks:z.array(z.object({
  id:z.string().min(1), name:z.string().min(1), passed:z.boolean(), detail:z.string(),
})).length(2) });
export function presetCanRun(artifact: Pick<BuiltMicroAppArtifact,"verification">): boolean {
  const audit=presetAudit.safeParse(artifact.verification);
  return audit.success && audit.data.passed && audit.data.checks.every(check=>check.passed)
    && ["template-integrity","compile"].every(id=>audit.data.checks.some(check=>check.id===id));
}
export function openReviewedPreset(artifact:BuiltMicroAppArtifact,pinToDock:boolean,open:(app:InstalledMicroApp)=>void) {
  if(!presetCanRun(artifact))throw new Error("这份宿主回执不能用于运行或安装。");
  if(!pinToDock) { open({...artifact,sessionOnly:true,pinnedToDock:false}); return; }
  const installed={...artifact,sessionOnly:false,pinnedToDock:true,installedAt:new Date().toISOString()};
  installMicroApp(installed);
  open(installed);
}
const presetReply = z.object({ ok:z.literal(true), app:z.object({
  appId:z.string(), name:z.string(), nameEn:z.string(), icon:z.string(), version:z.string(), description:z.string(),
  codeHash:z.string().regex(/^[a-f0-9]{64}$/i), compiledAt:z.string().min(1),
  grantedScopes:z.array(z.enum(["selected_offers","backcheck_summary","job_snapshots"])), bundleHtml:z.string().min(1),
  verifierVersion:z.literal("reviewed-builtin-v2"), dependencies:z.record(z.string()), verification:presetAudit,
}), verification:presetAudit.optional() });

export async function buildSandboxedMicroApp(input: SandboxBuildInput): Promise<BuiltMicroAppArtifact> {
  const lease = captureIdentityLease();
  if (!lease.ownerId) throw new Error("请先登录本机账号。");
  lease.assert();
  const res = await ownedFetch(`${agentOrigin()}/api/v1/agent/sandbox/build`, {
    method:"POST", headers:{"Content-Type":"application/json",Authorization:`Bearer ${readRuntimeConnection()?.agentToken ?? "better-me-agent-token"}`},
    signal:AbortSignal.timeout(30_000),body:JSON.stringify(input),
  }).catch(()=>{lease.assert();throw new Error("未能连接本机宿主；未验证、运行或安装预设。");});
  if(!res.ok) throw new Error(`本机宿主拒绝预设构建（HTTP ${res.status}）；没有本地替代结果。`);
  const parsed=presetReply.safeParse(await res.json().catch(()=>undefined)); lease.assert();
  if(!parsed.success) throw new Error("宿主预设回执无效，无法确认构建。");
  const { app, verification }=parsed.data;
  if(app.appId!==input.appId || app.version!==(input.version??"1.0.0") ||
    app.grantedScopes.length!==input.grantedScopes.length || new Set(app.grantedScopes).size!==app.grantedScopes.length ||
    app.grantedScopes.some(s=>!input.grantedScopes.includes(s)) ||
    !presetCanRun(app) || (verification && !presetCanRun({verification}))) {
    throw new Error("宿主回执与请求不符或有检查未通过；禁止运行或固定到 Dock。");
  }
  return {...app,pinnedToDock:false,installedAt:app.compiledAt};
}
